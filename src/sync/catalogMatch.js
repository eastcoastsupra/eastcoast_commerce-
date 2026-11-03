import { normalizeBrand, normalizeIdentifier, hasManagedVariants } from "./commercePolicy.js";

const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const SECTION_STOP = /\b(?:oem?|references?|installation|installing|required parts|other parts|related products)\b/iu;

function text(value) {
  return String(value ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr|h[1-6]|section)>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(?:nbsp|#160);/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&(?:quot|#34);/giu, '"')
    .replace(/&(?:apos|#39);/giu, "'");
}

function nameKey(value) {
  return normalizeBrand(text(value)).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function add(index, key, value) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

/** Only whole-line, explicit own-product labels; never free-text part numbers. */
export function extractLabelledIdentifiers(html) {
  const entries = [];
  for (const line of text(html).split(/\r?\n/u)) {
    if (SECTION_STOP.test(line)) break;
    const match = /^\s*(SKU|MPN|Manufacturer\s+Part\s+Number)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,79})\s*$/iu.exec(line);
    if (match) entries.push({ kind: match[1].toUpperCase() === "SKU" ? "sku" : "mpn", value: match[2] });
  }
  return entries;
}

/**
 * Supplier input: {itemId,brand,sku,mpn,unitsPerSku,description}. Only identity
 * metadata is retained: indexes/match results never contain supplier costs.
 */
export function buildSupplierMatchIndex(items) {
  const result = { bySku: new Map(), byManagedSku: new Map(), byMpn: new Map(), byId: new Map(), brands: new Set(), conflicts: new Set() };
  for (const item of items ?? []) {
    const entry = {
      itemId: String(item.itemId ?? ""), brand: normalizeBrand(item.brand),
      sku: String(item.sku ?? ""), mpn: String(item.mpn ?? ""),
      managedSku: `T14-${String(item.itemId ?? "")}`,
      unitsPerSku: item.unitsPerSku, description: text(item.description)
    };
    if (!entry.itemId || !entry.brand) continue;
    const previous = result.byId.get(entry.itemId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) result.conflicts.add(entry.itemId);
    result.byId.set(entry.itemId, entry);
    result.brands.add(entry.brand);
    add(result.bySku, normalizeIdentifier(entry.sku), entry);
    add(result.bySku, normalizeIdentifier(entry.managedSku), entry);
    add(result.byManagedSku, normalizeBrand(entry.managedSku), entry);
    add(result.byMpn, `${entry.brand}\0${normalizeIdentifier(entry.mpn)}`, entry);
  }
  return result;
}

function brandFor(product, index) {
  const explicit = normalizeBrand(product.brand);
  if (explicit) return { brand: explicit, source: "explicit-brand" };
  if (!index) return { brand: null };
  const name = normalizeBrand(text(product.name));
  const candidates = [...index.brands].filter((brand) =>
    name === brand || (name.startsWith(brand) && /[\s:–—-]/u.test(name.charAt(brand.length))));
  return candidates.length === 1 ? { brand: candidates[0], source: "exact-brand-prefix" }
    : { brand: null, ambiguous: candidates.length > 1 };
}

function select(entries, index, brand) {
  const unique = new Map((entries ?? []).map((entry) => [entry.itemId, entry]));
  if (unique.size > 1) return { status: "hold", reason: "ambiguous-normalized-identifier" };
  if (!unique.size) return { status: "unmatched", reason: "no-exact-identifier" };
  const item = [...unique.values()][0];
  if (index.conflicts.has(item.itemId)) return { status: "hold", reason: "conflicting-supplier-records" };
  if (brand && item.brand !== brand) return { status: "hold", reason: "brand-conflict" };
  if (item.unitsPerSku !== 1) return { status: "hold", reason: "casepack-or-unknown-selling-unit" };
  return { status: "matched", item };
}

function skuMatch(sku, brand, index) {
  const key = normalizeIdentifier(sku);
  if (!key) return { status: "hold", reason: "missing-sku" };
  const managed = index.byManagedSku.get(normalizeBrand(sku));
  if (managed) {
    if (!brand) return { status: "hold", reason: "managed-sku-requires-verified-brand" };
    return { ...select(index.bySku.get(key), index, brand), source: "managed-turn14-sku" };
  }
  if ((index.bySku.get(key) ?? []).some((entry) => normalizeIdentifier(entry.managedSku) === key)) {
    return { status: "hold", reason: "noncanonical-managed-sku" };
  }
  if (index.bySku.has(key)) return { ...select(index.bySku.get(key), index, brand), source: "supplier-sku" };
  if (!brand) return { status: "hold", reason: "mpn-requires-verified-brand" };
  return { ...select(index.byMpn.get(`${brand}\0${key}`), index, brand), source: "brand-mpn" };
}

function descriptionMatch(product, brand, index) {
  if (!brand) return { status: "hold", reason: "missing-sku-and-verified-brand" };
  const labels = extractLabelledIdentifiers(product.description);
  const mpns = [...new Set(labels.filter((entry) => entry.kind === "mpn").map((entry) => normalizeIdentifier(entry.value)))];
  if (!mpns.length) return { status: "hold", reason: "missing-sku-and-labelled-mpn" };
  const found = new Map();
  for (const mpn of mpns) {
    const match = select(index.byMpn.get(`${brand}\0${mpn}`), index, brand);
    if (match.status !== "matched") return { ...match, reason: `labelled-mpn-${match.reason}` };
    found.set(match.item.itemId, match.item);
  }
  if (found.size !== 1) return { status: "hold", reason: "conflicting-labelled-identities" };
  const item = [...found.values()][0];
  for (const label of labels.filter((entry) => entry.kind === "sku")) {
    const other = skuMatch(label.value, brand, index);
    if (other.status === "hold" || (other.status === "matched" && other.item.itemId !== item.itemId)) {
      return { status: "hold", reason: "conflicting-labelled-identities" };
    }
  }
  return { status: "matched", item, source: "labelled-manufacturer-part-number" };
}

/**
 * Returns {status,reason?,targets,holds}. targets contain supplierItemId,
 * productId, variantId (null for simple products), sku, managedSku, source,
 * needsSku, hidden. Existing SKUs are never changed by this pure planner.
 * A managed product never falls back to its parent SKU or description. Individual
 * exact variant matches can be returned while other variants remain held.
 */
export function resolveCatalogProduct(product, index) {
  const identity = brandFor(product, index);
  const productId = String(product.id ?? "");
  const targets = [];
  const holds = [];
  if (!productId) return { status: "hold", reason: "missing-product-id", targets, holds };
  if (identity.ambiguous) return { status: "hold", reason: "ambiguous-brand-prefix", targets, holds };
  const managed = hasManagedVariants(product);
  const entries = managed
    ? (Array.isArray(product.variants) ? product.variants : []).map((variant) => ({ variantId: String(variant.id ?? ""), sku: variant.variant?.sku }))
    : [{ variantId: null, sku: product.sku }];
  const variantCounts = new Map();
  for (const entry of entries) variantCounts.set(entry.variantId, (variantCounts.get(entry.variantId) ?? 0) + 1);
  if (!entries.length) return { status: "hold", reason: "managed-variants-not-loaded", targets, holds };
  for (const entry of entries) {
    if (managed && (!entry.variantId || entry.variantId === ZERO_ID || variantCounts.get(entry.variantId) !== 1)) {
      holds.push({ productId, variantId: entry.variantId, reason: "invalid-or-duplicate-variant-id" });
      continue;
    }
    const match = normalizeIdentifier(entry.sku)
      ? skuMatch(entry.sku, identity.brand, index)
      : managed ? { status: "hold", reason: "missing-variant-sku" } : descriptionMatch(product, identity.brand, index);
    if (match.status !== "matched") {
      holds.push({ productId, variantId: entry.variantId, reason: match.reason });
      continue;
    }
    if (/\b(?:combo|bundle)\b/iu.test(text(product.name)) && !/\b(?:combo|bundle)\b/iu.test(match.item.description)) {
      holds.push({ productId, variantId: entry.variantId, reason: "custom-bundle-mismatch" });
      continue;
    }
    targets.push({ supplierItemId: match.item.itemId, productId, variantId: entry.variantId,
      sku: match.item.sku, managedSku: match.item.managedSku, source: match.source, needsSku: !normalizeIdentifier(entry.sku), hidden: product.visible === false });
  }
  if (managed) {
    const itemCounts = new Map();
    for (const target of targets) itemCounts.set(target.supplierItemId, (itemCounts.get(target.supplierItemId) ?? 0) + 1);
    for (let at = targets.length - 1; at >= 0; at -= 1) {
      if (itemCounts.get(targets[at].supplierItemId) > 1) {
        const target = targets.splice(at, 1)[0];
        holds.push({ productId, variantId: target.variantId, reason: "duplicate-supplier-variant-mapping" });
      }
    }
  }
  return { status: targets.length ? "matched" : "hold", reason: targets.length ? "exact-identities" : holds[0]?.reason, targets, holds };
}

/** Pass every Wix product, including hidden products, and loaded variant SKUs. */
export function buildWixDuplicateIndex(products, supplierIndex) {
  const result = { bySku: new Map(), byMpn: new Map(), missingSkuNames: new Map() };
  for (const product of products ?? []) {
    const brand = brandFor(product, supplierIndex).brand;
    const ref = { productId: String(product.id ?? ""), variantId: null, brand, hidden: product.visible === false };
    const parentSku = normalizeIdentifier(product.sku);
    add(result.bySku, parentSku, ref);
    if (!parentSku) add(result.missingSkuNames, nameKey(product.name), ref);
    for (const variant of product.variants ?? []) {
      add(result.bySku, normalizeIdentifier(variant.variant?.sku), { ...ref, variantId: String(variant.id ?? "") });
    }
    for (const label of extractLabelledIdentifiers(product.description)) {
      if (label.kind === "sku") add(result.bySku, normalizeIdentifier(label.value), ref);
      else if (brand) add(result.byMpn, `${brand}\0${normalizeIdentifier(label.value)}`, ref);
    }
  }
  return result;
}

/** A same-name record can only HOLD a create, never authorize a product update. */
export function checkCatalogDuplicate(item, index) {
  const brand = normalizeBrand(item.brand);
  const sku = normalizeIdentifier(item.sku);
  const mpn = normalizeIdentifier(item.mpn);
  if (!String(item.itemId ?? "").trim() || !sku || !mpn || !brand) return { status: "hold", reason: "missing-new-product-identity", references: [] };
  const direct = [...(index.bySku.get(sku) ?? []), ...(index.bySku.get(normalizeIdentifier(`T14-${item.itemId ?? ""}`)) ?? [])];
  if (direct.length) return { status: "duplicate", reason: "existing-supplier-sku", references: direct };
  const typed = index.byMpn.get(`${brand}\0${mpn}`) ?? [];
  const matchingMpn = (index.bySku.get(mpn) ?? []).filter((ref) => ref.brand === brand);
  if (typed.length || matchingMpn.length) return { status: "duplicate", reason: "existing-brand-mpn", references: [...typed, ...matchingMpn] };
  const uncertainMpn = (index.bySku.get(mpn) ?? []).filter((ref) => !ref.brand);
  const names = index.missingSkuNames.get(nameKey(item.description)) ?? [];
  if (uncertainMpn.length || names.length) return { status: "hold", reason: "possible-existing-product", references: [...uncertainMpn, ...names] };
  return { status: "clear", reason: "no-existing-identity", references: [] };
}
