import { buildProductPayload } from "../wix/commerce.js";
import { readItemAvailability } from "../turn14/availability.js";
import { readItemContent } from "../turn14/content.js";
import { buildSupplierMatchIndex, buildWixDuplicateIndex, checkCatalogDuplicate } from "./catalogMatch.js";
import { planCommercePrice, normalizeBrand, normalizeIdentifier } from "./commercePolicy.js";
import { escapeHtml, plainText, productSeo, supplierProductName } from "./content.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const key = (value) => normalizeBrand(value);

export function verifiedProductWeight(item, site, shippingPolicy) {
  if (shippingPolicy?.verified !== true) return null;
  const from = shippingPolicy.sourceWeightUnit;
  const to = shippingPolicy.siteWeightUnits?.[site.key];
  if (!["LB", "KG"].includes(from) || !["LB", "KG"].includes(to)) return null;
  const boxes = item.shippingDimensions;
  if (!Array.isArray(boxes) || !boxes.length) return null;
  if (new Set(boxes.map((box) => box.boxNumber)).size !== boxes.length) return null;
  if (boxes.some((box) => !Number.isInteger(box.boxNumber) || box.boxNumber < 1 ||
    typeof box.weight !== "number" || !Number.isFinite(box.weight) || box.weight <= 0)) return null;
  const sourceWeight = boxes.reduce((total, box) => total + box.weight, 0);
  const weight = from === to ? sourceWeight : from === "LB" ? sourceWeight * 0.45359237 : sourceWeight / 0.45359237;
  // Catalog V1 stores three decimal places. Round upward so a conversion does
  // not understate a parcel's weight at a rate boundary.
  const rounded = Math.ceil(weight * 1000) / 1000;
  return Number.isFinite(rounded) && rounded > 0 && rounded <= 999999.999 ? rounded : null;
}

export function importEligibility(item, site) {
  if (!item.targets?.includes(site.key)) return "not-targeted";
  if (item.unitsPerSku !== 1) return "casepack-or-unknown-selling-unit";
  if (!item.sku || !item.mpn || !item.brand || item.brand.length > 50) return "missing-or-unsupported-identity";
  if (item.sourceEvidence?.pricingStatus !== "matched") return "unverified-pricing";
  if (!["valid", "has-map-not-true"].includes(item.sourceEvidence?.mapStatus)) return "unverified-map-floor";
  const r = item.restrictions ?? {};
  if (r.carb_acknowledgement_required === true || r.not_carb_approved === true) return "sale-restrictions-require-configuration";
  if (r.ltl_freight_required === true || r.air_freight_prohibited === true) return "shipping-restrictions-require-configuration";
  if (r.epa && !["N/A", "NONE", "NOT APPLICABLE"].includes(key(r.epa))) return "epa-label-requires-review";
  const price = planCommercePrice({ supplier: { ...item, id: item.itemId, purchaseCost: item.cost } });
  return price.action === "create" ? null : price.reason;
}

/** Keep manufacturer warnings complete. Long marketing copy can be omitted,
 * while the source application text and exact part identity remain intact. */
export function importDescription(item, content) {
  const all = content.descriptions.map((entry) => ({ type: plainText(entry.type), text: plainText(entry.description) }))
    .filter((entry) => entry.text);
  const warnings = all.filter((entry) => /prop\s*65|proposition\s*65|warning|california/iu.test(`${entry.type} ${entry.text}`));
  if (["Y", "YES", "TRUE"].includes(key(item.restrictions?.prop_65)) && !warnings.length) {
    return { ok: false, reason: "manufacturer-warning-text-missing" };
  }
  const pieces = [
    `<p>${escapeHtml(plainText(item.description))}</p>`,
    `<p><strong>Manufacturer:</strong> ${escapeHtml(item.brand)}<br><strong>Manufacturer part number:</strong> ${escapeHtml(item.mpn)}</p>`
  ];
  const seen = new Set([plainText(item.description)]);
  // Render supplied restrictions before optional general copy so none is cut.
  for (const entry of warnings) {
    if (seen.has(entry.text)) continue;
    pieces.push(`<p>${escapeHtml(entry.text)}</p>`);
    seen.add(entry.text);
  }
  if (pieces.join("\n").length > 8000) return { ok: false, reason: "warning-text-exceeds-product-limit" };
  for (const entry of all.sort((a, b) => b.text.length - a.text.length)) {
    if (seen.has(entry.text)) continue;
    const paragraph = `<p>${escapeHtml(entry.text)}</p>`;
    if (pieces.join("\n").length + paragraph.length + 1 <= 8000) {
      pieces.push(paragraph);
      seen.add(entry.text);
    }
  }
  return { ok: true, html: pieces.join("\n") };
}

function newSummary(products) {
  return {
    productsBefore: products.length, candidates: 0, existing: 0, held: 0,
    plannedCreates: 0, attemptedCreates: 0, createdHidden: 0, published: 0,
    verified: 0, capped: 0, collectionsCreated: 0, mediaAttached: 0,
    inventoryConfigured: 0, errors: 0, http401Errors: 0, http403Errors: 0,
    otherErrors: 0, stopped: false, holdReasons: {}
  };
}

function hold(summary, reason) {
  summary.held += 1;
  summary.holdReasons[reason] = (summary.holdReasons[reason] ?? 0) + 1;
}

export async function verifyNewProduct(client, id, expected, runtime = { sleep }) {
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await runtime.sleep(delay);
    const product = (await client.getProduct(id))?.product;
    if (product?.id === id && product.sku === expected.sku && product.visible === expected.visible &&
      product.priceData?.price === expected.price && product.media?.items?.length > 0) return product;
  }
  throw new Error("New product readback is not consistent");
}

/**
 * Imports independently verifiable simple supplier SKUs. Catalogs, IDs, prices,
 * content, and inventory stay in memory. Only aggregate summaries leave this
 * function. Each product remains hidden until media and stock are configured.
 */
export async function importSiteProducts({ site, client, supplierClient, products, items,
  apply = false, maxCreates = 0, onProgress = async () => {}, runtime = { sleep },
  shippingPolicy = { verified: false } } = {}) {
  if (!Number.isSafeInteger(maxCreates) || maxCreates < 0) throw new Error("Invalid creation cap");
  const summary = newSummary(products);
  const supplierIndex = buildSupplierMatchIndex(items);
  const knownProducts = [...products];
  let duplicates = buildWixDuplicateIndex(knownProducts, supplierIndex);
  let collections;

  async function collectionFor(name) {
    collections ??= await client.queryCollectionsAll();
    const matches = collections.filter((collection) => key(collection.name) === key(name));
    if (matches.length > 1 || (matches.length === 1 && matches[0].visible === false)) {
      throw new Error("Collection identity is ambiguous or hidden");
    }
    if (matches.length === 1) return matches[0].id;
    if (!name || name.length > 50) throw new Error("Category name requires review");
    const result = await client.createCollection({ name });
    if (!result?.collection?.id) throw new Error("Collection creation result missing ID");
    collections.push(result.collection);
    summary.collectionsCreated += 1;
    return result.collection.id;
  }

  for (const item of items) {
    if (!item.targets?.includes(site.key)) continue;
    summary.candidates += 1;
    const sourceAliases = [
      supplierIndex.bySku.get(normalizeIdentifier(item.sku)) ?? [],
      supplierIndex.byMpn.get(`${normalizeBrand(item.brand)}\0${normalizeIdentifier(item.mpn)}`) ?? []
    ];
    if (supplierIndex.conflicts.has(String(item.itemId)) || sourceAliases.some((entries) => {
      const ids = new Set(entries.map((entry) => entry.itemId));
      return ids.size !== 1 || !ids.has(String(item.itemId));
    })) { hold(summary, "ambiguous-supplier-identity"); continue; }
    const duplicate = checkCatalogDuplicate(item, duplicates);
    if (duplicate.status === "duplicate") { summary.existing += 1; continue; }
    if (duplicate.status !== "clear") { hold(summary, duplicate.reason); continue; }
    const reason = importEligibility(item, site);
    if (reason) { hold(summary, reason); continue; }
    const weight = verifiedProductWeight(item, site, shippingPolicy);
    if (weight === null) { hold(summary, "shipping-weight-or-units-not-verified"); continue; }
    if (knownProducts.length >= 49900) { hold(summary, "store-product-capacity"); continue; }
    summary.plannedCreates += 1;
    if (!apply) continue;
    if (summary.attemptedCreates >= maxCreates) { summary.capped += 1; continue; }

    let createdId = null;
    try {
      const content = await readItemContent(supplierClient, item);
      if (!content.known || !content.images.length) {
        hold(summary, content.known ? "supplier-images-missing" : content.reason);
        if (/unauthorized/u.test(content.reason ?? "")) { summary.stopped = true; break; }
        continue;
      }
      const description = importDescription(item, content);
      if (!description.ok) { hold(summary, description.reason); continue; }
      const availability = await readItemAvailability(supplierClient, item);
      if (!availability.known) {
        hold(summary, availability.reason);
        if (/unauthorized/u.test(availability.reason)) { summary.stopped = true; break; }
        continue;
      }
      const sku = `T14-${item.itemId}`;
      const freshMatches = [];
      for (const candidate of [...new Set([sku, item.sku, item.mpn])]) {
        freshMatches.push(...await client.findProductsBySku(candidate));
      }
      if (freshMatches.length) { hold(summary, "fresh-existing-sku"); continue; }
      const name = supplierProductName(item.description, item.mpn);
      const decision = planCommercePrice({ supplier: { ...item, id: item.itemId, purchaseCost: item.cost } });
      if (decision.action !== "create") { hold(summary, decision.reason); continue; }
      const payload = buildProductPayload({ name, sku, brand: item.brand, descriptionHtml: description.html,
        price: decision.price, currency: item.currency, weight, visible: false, seo: productSeo({ name }, site) });
      const collectionId = await collectionFor(item.category);

      summary.attemptedCreates += 1; // Includes a possible lost response.
      const created = await client.createProduct(payload);
      createdId = created?.product?.id;
      if (!createdId) throw new Error("Product creation did not return an ID");
      summary.createdHidden += 1;
      // Immediately reserve the identity in memory, even before media succeeds.
      knownProducts.push({ ...payload, ...created.product });
      duplicates = buildWixDuplicateIndex(knownProducts, supplierIndex);
      await client.addMedia(createdId, content.images.map((entry) => entry.url));
      summary.mediaAttached += 1;
      let current = created.product;
      if (!Array.isArray(current.variants) || current.variants.length !== 1) {
        for (const delay of [0, 1000, 2000, 4000]) {
          if (delay) await runtime.sleep(delay);
          current = (await client.getProduct(createdId))?.product;
          if (current?.variants?.length === 1) break;
        }
      }
      if (current?.variants?.length !== 1 || !current.variants[0].id) throw new Error("New product default variant missing");
      await client.updateInventory(createdId, { trackQuantity: true,
        variants: [{ variantId: current.variants[0].id, quantity: Math.min(availability.quantity, 2147483647) }] });
      summary.inventoryConfigured += 1;
      await client.addProductsToCollection(collectionId, [createdId]);
      await verifyNewProduct(client, createdId, { sku, price: decision.price, visible: false }, runtime);
      // The product can safely be displayed when it has a verified price,
      // identity, source media, category and explicit stock, including zero.
      await client.updateProduct(createdId, { visible: true });
      summary.published += 1;
      await verifyNewProduct(client, createdId, { sku, price: decision.price, visible: true }, runtime);
      summary.verified += 1;
    } catch (error) {
      summary.errors += 1;
      if (error?.status === 401) summary.http401Errors += 1;
      else if (error?.status === 403) summary.http403Errors += 1;
      else summary.otherErrors += 1;
      // No uncertain create is retried. Stop this batch so a fresh complete
      // catalog can reconcile any successful but unacknowledged request.
      if (!createdId || [401, 403].includes(error?.status) || summary.errors >= 3) {
        summary.stopped = true;
        await onProgress(summary);
        break;
      }
    }
    await onProgress(summary);
  }
  return summary;
}
