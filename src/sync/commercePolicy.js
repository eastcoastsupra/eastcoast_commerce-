/**
 * Pure commerce decisions over adapter-normalized, verified data. This module
 * does not understand supplier response schemas or perform network calls.
 *
 * Identity input: product {brand, sku?, sellableUnit, verifiedIdentifiers?}, where
 * verifiedIdentifiers contains {kind, value, verified:true}. Supplier records
 * have {id, brand, mpn?, partNumber?, gtin?, alternatePartNumbers?, sellableUnit}.
 * Supported kinds: mpn, partNumber, gtin, alternatePartNumber. sellableUnit is a
 * verified canonical package identity, e.g. "1x473ml", "12x473ml", or "each".
 * Names/titles are never identifiers. Brand aliases and unit equivalence must be
 * resolved by the adapter using evidence, not inferred here.
 */

export function normalizeBrand(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase()
    : "";
}

export function normalizeIdentifier(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[^a-zA-Z0-9]/gu, "").toUpperCase()
    : "";
}

function unitKey(value) {
  return normalizeBrand(value);
}

function identifiers(item) {
  return [
    { kind: "mpn", value: item.mpn },
    { kind: "partNumber", value: item.partNumber },
    { kind: "gtin", value: item.gtin },
    ...(Array.isArray(item.alternatePartNumbers) ? item.alternatePartNumbers : [])
      .map((value) => ({ kind: "alternatePartNumber", value }))
  ].map((entry) => ({ ...entry, normalized: normalizeIdentifier(entry.value) }))
    .filter((entry) => entry.normalized);
}

/**
 * Exact brand-scoped match. A lossy normalized collision always holds, even if
 * one candidate's punctuation happens to equal the product's raw identifier.
 * All verified identifiers must resolve to the same item; conflicts never pick
 * the first result. A missing SKU can be recovered only from a verified typed
 * identifier plus matching brand and selling unit.
 * Returns {status:"matched"|"hold"|"unmatched", reason, item?, itemId?}.
 */
export function resolveIdentity(product, catalog) {
  const brand = normalizeBrand(product?.brand);
  const unit = unitKey(product?.sellableUnit);
  if (!brand) return { status: "hold", reason: "missing-verified-brand" };
  if (!unit) return { status: "hold", reason: "missing-sellable-unit" };

  const evidence = [];
  const sku = normalizeIdentifier(product?.sku);
  if (sku) evidence.push({ kind: "sku", normalized: sku });
  for (const entry of product?.verifiedIdentifiers ?? []) {
    if (entry?.verified !== true || !["mpn", "partNumber", "gtin", "alternatePartNumber"].includes(entry.kind)) continue;
    const normalized = normalizeIdentifier(entry.value);
    if (normalized) evidence.push({ kind: entry.kind, normalized });
  }
  if (!evidence.length) return { status: "hold", reason: "missing-verified-identifier" };

  const scoped = (Array.isArray(catalog) ? catalog : [])
    .filter((item) => normalizeBrand(item?.brand) === brand);
  const matches = new Map();
  let unresolved = false;
  for (const entry of evidence) {
    const candidates = scoped.filter((item) => identifiers(item).some((identifier) =>
      (entry.kind === "sku" || identifier.kind === entry.kind) &&
      identifier.normalized === entry.normalized));
    const unique = new Map();
    for (const item of candidates) {
      if (item.id === undefined || item.id === null || String(item.id).trim() === "") {
        return { status: "hold", reason: "missing-supplier-item-id" };
      }
      const key = String(item.id);
      const earlier = unique.get(key);
      if (earlier && unitKey(earlier.sellableUnit) !== unitKey(item.sellableUnit)) {
        return { status: "hold", reason: "conflicting-supplier-records" };
      }
      unique.set(key, item);
    }
    if (unique.size > 1) return { status: "hold", reason: "ambiguous-normalized-identifier" };
    if (!unique.size) {
      // A merchant's custom SKU need not equal the supplier's identifiers. A
      // verified typed identifier can still establish the identity.
      if (entry.kind !== "sku") unresolved = true;
      continue;
    }
    const item = [...unique.values()][0];
    if (!unitKey(item.sellableUnit) || unitKey(item.sellableUnit) !== unit) {
      return { status: "hold", reason: "sellable-unit-mismatch" };
    }
    matches.set(String(item.id), item);
  }
  if (matches.size > 1) return { status: "hold", reason: "conflicting-verified-identifiers" };
  if (unresolved && matches.size) return { status: "hold", reason: "unresolved-verified-identifier" };
  if (!matches.size) return { status: "unmatched", reason: "no-exact-identifier" };
  const item = [...matches.values()][0];
  return { status: "matched", reason: sku ? "exact-identifier" : "verified-missing-sku-match", itemId: String(item.id), item };
}

function nonempty(value) {
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

/** Wix's single default variant with empty choices is not a managed variant. */
export function hasManagedVariants(product = {}) {
  if (product.manageVariants === true || nonempty(product.productOptions) || nonempty(product.options)) return true;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  return variants.length > 1 || variants.some((variant) =>
    nonempty(variant?.choices) || nonempty(variant?.options));
}

/**
 * item.fitments: [{verified:true, make, model, ...evidence}]. No inferred engine
 * compatibility. Explicit universal items require
 * item.universal:{verified:true,category:"detailing"|"tools"}.
 */
export function checkRelevance(item, siteKey) {
  if (!["eastcoastsupra", "ecbmw"].includes(siteKey)) return { eligible: false, reason: "unknown-target-site" };
  const fitments = (Array.isArray(item?.fitments) ? item.fitments : []).filter((fitment) => {
    if (fitment?.verified !== true || !normalizeBrand(fitment.model)) return false;
    return siteKey === "eastcoastsupra"
      ? normalizeBrand(fitment.make) === "TOYOTA" && normalizeBrand(fitment.model) === "SUPRA"
      : normalizeBrand(fitment.make) === "BMW";
  });
  if (fitments.length) return { eligible: true, reason: "verified-vehicle-fitment", fitments };
  if (item?.universal?.verified === true && ["detailing", "tools"].includes(item.universal.category)) {
    return { eligible: true, reason: "verified-universal-category", fitments: [] };
  }
  return { eligible: false, reason: "no-verified-relevance" };
}

function money(value, allowZero = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round((value + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && (allowZero ? cents >= 0 : cents > 0) ? cents / 100 : null;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day) ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 ||
      (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function termsLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

/**
 * Price-only plan; "create" does NOT authorize publishing a product. The caller
 * must separately verify identity, relevance, assets, and description.
 *
 * supplier: {id,brand,active,canPurchase,currency,map?,msrp?,purchaseCost?}; all
 * prices are finite numbers in the same verified selling unit and currency.
 * Missing MAP is null/undefined, never an invalid/zero value silently ignored.
 * existing: null for new, or {price,currency,visible?,manualDiscount?,humanEdited?,
 * manageVariants?,productOptions?,variants?}. Human-edit conflicts stay held.
 *
 * promotion (optional): {id,verified:true,consumerPromotion:true,termsUrl,
 * eligibleItemIds:[exact supplier id],startsAt,endsAt,currency,price,
 * mapFloor?,mapExceptionVerified?}. Starts/ends require explicit ISO offsets;
 * now is injected epoch milliseconds. A lower promotional MAP requires a verified
 * exception AND explicit positive mapFloor. Wholesale cost savings are not offers.
 */
export function planCommercePrice({ supplier, existing = null, allowPriceDecrease = false,
  promotion = null, now, expectedCurrency = "USD" } = {}) {
  const hold = (reason, details = {}) => ({ action: "hold", reason, ...details });
  if (supplier?.active !== true) return hold("supplier-item-inactive");
  if (supplier?.canPurchase !== true) return hold("supplier-item-not-purchasable");
  const currency = normalizeBrand(expectedCurrency);
  if (!/^[A-Z]{3}$/u.test(currency) || normalizeBrand(supplier.currency) !== currency ||
      (existing !== null && normalizeBrand(existing.currency) !== currency)) return hold("currency-mismatch");
  if (existing?.visible === false) return hold("hidden-product");
  if (existing?.manualDiscount === true) return hold("manual-discount");
  if (existing?.humanEdited === true) return hold("human-edit-conflict");
  if (existing !== null && hasManagedVariants(existing)) return hold("managed-variants-require-mapping");

  const map = supplier.map == null ? null : money(supplier.map);
  const msrp = supplier.msrp == null ? null : money(supplier.msrp);
  const purchaseCost = supplier.purchaseCost == null ? null : money(supplier.purchaseCost, true);
  if (supplier.map != null && map === null) return hold("invalid-map-price");
  if (supplier.purchaseCost != null && purchaseCost === null) return hold("invalid-purchase-cost");
  const regularPrice = map ?? msrp;
  if (regularPrice === null) return hold("no-valid-retail-reference");
  const currentPrice = existing === null ? null : money(existing.price);
  if (existing !== null && currentPrice === null) return hold("invalid-existing-price");

  let price = regularPrice;
  let mapFloor = map;
  let activePromotion = false;
  let promotionId = null;
  if (promotion !== null) {
    if (promotion.verified !== true || promotion.consumerPromotion !== true ||
        !termsLink(promotion.termsUrl) || !String(promotion.id ?? "").trim()) return hold("unverified-consumer-promotion");
    if (supplier.id == null || !Array.isArray(promotion.eligibleItemIds) ||
        !promotion.eligibleItemIds.some((id) => String(id) === String(supplier.id))) return hold("promotion-item-not-eligible");
    if (normalizeBrand(promotion.currency) !== currency) return hold("promotion-currency-mismatch");
    const starts = timestamp(promotion.startsAt);
    const ends = timestamp(promotion.endsAt);
    if (starts === null || ends === null || ends <= starts || typeof now !== "number" || !Number.isFinite(now)) return hold("invalid-promotion-window");
    if (now >= starts && now < ends) {
      const offerPrice = money(promotion.price);
      const offeredMap = promotion.mapFloor == null ? null : money(promotion.mapFloor);
      if (offerPrice === null || offerPrice > regularPrice) return hold("invalid-promotion-price");
      if (promotion.mapFloor != null && offeredMap === null) return hold("invalid-promotion-map");
      if (promotion.mapExceptionVerified === true && offeredMap === null) return hold("missing-promotion-map-exception-floor");
      mapFloor = promotion.mapExceptionVerified === true
        ? offeredMap
        : Math.max(map ?? 0, offeredMap ?? 0) || null;
      price = offerPrice;
      activePromotion = true;
      promotionId = String(promotion.id);
    }
  }

  const details = { price, regularPrice, currentPrice, mapFloor, purchaseCost, currency, promotionId };
  if (mapFloor !== null && price < mapFloor) return hold("price-below-applicable-map", details);
  if (purchaseCost !== null && price < purchaseCost) return hold("price-below-purchase-cost", details);
  if (existing === null) return { action: "create", reason: activePromotion ? "authorized-consumer-promotion" : map !== null ? "new-product-map" : "new-product-msrp", ...details };
  if (price === currentPrice) return { action: "none", reason: "already-at-target", ...details };
  if (price < currentPrice && allowPriceDecrease !== true && !activePromotion) return { action: "none", reason: "price-decrease-not-authorized", ...details };
  return { action: "update", reason: activePromotion ? "authorized-consumer-promotion" : price > currentPrice ? "raise-to-reference" : "authorized-decrease-to-reference", ...details };
}
