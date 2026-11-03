import { roundCurrency } from "../lib/normalize.js";

const SITES = ["eastcoastsupra", "ecbmw"];
const RESTRICTION_KEYS = [
  "epa", "prop_65", "not_carb_approved", "carb_eo_number",
  "carb_acknowledgement_required", "air_freight_prohibited", "ltl_freight_required",
  "powersports_indicator", "regular_stock", "clearance_item"
];
const exact = (value) => typeof value === "string" ? value.trim().toUpperCase() : "";
const string = (value) => typeof value === "string" ? value : "";

function positivePrice(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function uniquePrice(lists, name) {
  const matches = lists.filter((entry) => exact(entry?.name) === exact(name));
  if (matches.length !== 1) return { value: null, reason: matches.length ? "ambiguous" : "missing" };
  const price = positivePrice(matches[0].price);
  const rounded = price === null ? null : roundCurrency(price);
  return { value: rounded > 0 ? rounded : null, reason: rounded > 0 ? "valid" : "invalid" };
}

function retailPrices(pricing) {
  const attributes = pricing?.attributes ?? {};
  const lists = Array.isArray(attributes.pricelists) ? attributes.pricelists : [];
  const map = attributes.has_map === true ? uniquePrice(lists, "MAP") : { value: null, reason: "has-map-not-true" };
  let msrp = null;
  let msrpPriceList = null;
  for (const name of ["MSRP", "Suggested Retail", "Retail"]) {
    if (!lists.some((entry) => exact(entry?.name) === exact(name))) continue;
    msrp = uniquePrice(lists, name).value;
    msrpPriceList = name;
    break;
  }
  return { map: map.value, mapStatus: map.reason, msrp, msrpPriceList, cost: positivePrice(attributes.purchase_cost) };
}

function selectItem(item, brand, existingSkus) {
  const attrs = item?.attributes ?? {};
  if (attrs.active !== true || attrs.powersports_indicator === true) return null;
  const description = string(attrs.part_description);
  const explicitSupra = /\bSupra\b/iu.test(description);
  const explicitBmw = /\bBMW\b/iu.test(description);
  const universalDetailing = exact(attrs.category) === "DETAILING & CARE";
  const matchedExistingIdentifiers = [attrs.part_number, attrs.mfr_part_number]
    .filter((identifier) => exact(identifier) && existingSkus.has(exact(identifier)))
    .map((identifier) => string(identifier).trim());
  if (!explicitSupra && !explicitBmw && !universalDetailing && !matchedExistingIdentifiers.length) return null;
  const restrictions = Object.fromEntries(RESTRICTION_KEYS
    .filter((key) => Object.hasOwn(attrs, key)).map((key) => [key, attrs[key]]));
  if (Array.isArray(attrs.warehouse_availability)) {
    restrictions.warehouse_availability = attrs.warehouse_availability.map((entry) => ({
      location_id: entry.location_id, can_place_order: entry.can_place_order
    }));
  }
  return {
    itemId: String(item.id), brandId: brand.id, brand: brand.name,
    mpn: string(attrs.mfr_part_number).trim(), sku: string(attrs.part_number).trim(),
    description, category: string(attrs.category), subcategory: string(attrs.subcategory),
    unitsPerSku: Number.isInteger(attrs.units_per_sku) && attrs.units_per_sku > 0 ? attrs.units_per_sku : null,
    barcode: string(attrs.barcode), active: true, canPurchase: null,
    shippingDimensions: Array.isArray(attrs.dimensions) ? attrs.dimensions.map((box) => ({
      boxNumber: box.box_number, weight: box.weight, length: box.length, width: box.width, height: box.height
    })) : [],
    map: null, msrp: null, cost: null, currency: "USD",
    thumbnail: string(attrs.thumbnail), restrictions,
    targets: universalDetailing ? [...SITES] : [explicitSupra ? SITES[0] : null, explicitBmw ? SITES[1] : null].filter(Boolean),
    sourceEvidence: {
      basis: "Explicit supplier application text, universal detailing category, or exact existing SKU; not full ACES fitment.",
      descriptionField: "attributes.part_description", explicitSupra, explicitBmw, universalDetailing,
      matchedExistingIdentifiers: [...new Set(matchedExistingIdentifiers)],
      pricingStatus: "missing", mapStatus: "missing-pricing", msrpPriceList: null
    }
  };
}

const FAILURE_MESSAGES = Object.freeze({
  "http-error": "Turn 14 catalog HTTP request failed",
  "request-failed": "Turn 14 catalog request failed without an HTTP status",
  "unexpected-catalog-error": "Turn 14 catalog response processing failed",
  "response-data-not-array": "Turn 14 catalog data is not an array",
  "pagination-zero-pages-empty": "Turn 14 catalog reported zero pages with empty data",
  "pagination-zero-pages-nonempty": "Turn 14 catalog reported zero pages with nonempty data",
  "pagination-invalid-total": "Turn 14 catalog page total is invalid",
  "pagination-page-limit": "Turn 14 catalog page total exceeds the safety limit",
  "pagination-changed-total": "Turn 14 catalog page total changed during the read",
  "item-id-missing": "Turn 14 catalog item ID is missing",
  "item-id-duplicate": "Turn 14 catalog item ID is duplicated",
  "brand-data-not-array": "Turn 14 brand data is not an array",
  "brand-pagination-invalid": "Turn 14 brand list pagination is invalid or incomplete",
  "brand-id-missing": "Turn 14 brand ID is missing",
  "brand-name-missing": "Turn 14 brand name is missing",
  "brand-id-duplicate": "Turn 14 brand ID is duplicated"
});

// Only locally constructed errors may carry a diagnostic code. Never preserve
// an upstream error's message, body, cause, URL, or arbitrary code in reports.
class CatalogReadError extends Error {
  constructor(reasonCode, status = null) {
    super(`${FAILURE_MESSAGES[reasonCode]}${status === null ? "" : ` (HTTP ${status})`}.`);
    this.reasonCode = reasonCode;
    this.status = status;
  }
}

function safeError(error, fallbackReason = "unexpected-catalog-error") {
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const reasonCode = error instanceof CatalogReadError ? error.reasonCode : status === null ? fallbackReason : "http-error";
  return new CatalogReadError(reasonCode, status);
}

/**
 * Reads only known brand/item/pricing routes. `items` is private runtime data:
 * it includes dealer cost for policy evaluation and must not be logged or saved
 * wholesale. `summary` and progress events never include prices or dealer cost.
 * Failure counts use fixed local reason codes and numeric HTTP statuses only.
 * Explicit brand mismatches are rejected without reassignment. Rejection counts
 * retain observed faults even if a later guard discards the rest of that brand.
 * Zero-page responses remain rejected until the supplier contract is verified.
 * Relevance is explicit supplier application text, not decoded ACES fitment.
 */
export async function fetchCommerceCatalog(client, {
  existingSkus = [], brandNames, minRequestIntervalMs = 250, onProgress = () => {},
  runtime = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
} = {}) {
  if (!Array.isArray(existingSkus) || (brandNames !== undefined && (!Array.isArray(brandNames) || brandNames.length === 0))) {
    throw new Error("existingSkus and optional nonempty brandNames must be arrays.");
  }
  if (!Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 250) throw new Error("Catalog request interval must be at least 250 milliseconds.");
  if (typeof runtime.now !== "function" || typeof runtime.sleep !== "function") throw new Error("Invalid catalog clock runtime.");
  const identifiers = new Set(existingSkus.map(exact).filter(Boolean));
  const summary = {
    brandsTotal: 0, brandsSelected: 0, brandsCompleted: 0, brandsFailed: 0,
    requests: 0, itemPages: 0, pricingPages: 0, itemsScanned: 0, itemsRetained: 0,
    pricesScanned: 0, missingPrices: 0, ambiguousPrices: 0, unavailableMap: 0,
    notPurchasable: 0, supraTargets: 0, bmwTargets: 0, existingSkuOnly: 0,
    rejectedBrandMismatchItems: 0, brandsWithRejectedItems: 0,
    failureReasonCounts: {}, failureHttpStatusCounts: {}
  };
  let lastRequestAt = null;
  async function read(path) {
    if (lastRequestAt !== null) await runtime.sleep(Math.max(0, minRequestIntervalMs - (runtime.now() - lastRequestAt)));
    lastRequestAt = runtime.now();
    summary.requests += 1;
    try { return await client.get(path); } catch (error) { throw safeError(error, "request-failed"); }
  }
  async function pages(kind, brandId, consume) {
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page += 1) {
      const response = await read(`/v1/${kind}/brand/${encodeURIComponent(brandId)}?page=${page}`);
      const total = Number(response?.meta?.total_pages ?? 1);
      if (!Array.isArray(response?.data)) throw new CatalogReadError("response-data-not-array");
      if (!Number.isInteger(total) || total < 0) throw new CatalogReadError("pagination-invalid-total");
      if (total === 0) throw new CatalogReadError(response.data.length === 0 ? "pagination-zero-pages-empty" : "pagination-zero-pages-nonempty");
      if (total > 1000) throw new CatalogReadError("pagination-page-limit");
      if (page > 1 && total !== totalPages) throw new CatalogReadError("pagination-changed-total");
      totalPages = total;
      summary[kind === "items" ? "itemPages" : "pricingPages"] += 1;
      consume(response.data);
    }
  }

  const response = await read("/v1/brands");
  if (!Array.isArray(response?.data)) throw new CatalogReadError("brand-data-not-array");
  if (Number(response?.meta?.total_pages ?? 1) !== 1) throw new CatalogReadError("brand-pagination-invalid");
  const allBrands = response.data.map((brand) => ({ id: String(brand?.id ?? ""), name: string(brand?.attributes?.name) }));
  if (allBrands.some((brand) => !brand.id)) throw new CatalogReadError("brand-id-missing");
  if (allBrands.some((brand) => !brand.name.trim())) throw new CatalogReadError("brand-name-missing");
  if (new Set(allBrands.map((brand) => brand.id)).size !== allBrands.length) throw new CatalogReadError("brand-id-duplicate");
  summary.brandsTotal = allBrands.length;
  let brands = allBrands;
  if (brandNames !== undefined) {
    const requested = new Set(brandNames.map(exact));
    if (requested.has("") || [...requested].some((name) => allBrands.filter((brand) => exact(brand.name) === name).length !== 1)) {
      throw new Error("Each requested brand must resolve to exactly one exact brand name.");
    }
    brands = allBrands.filter((brand) => requested.has(exact(brand.name)));
  }
  summary.brandsSelected = brands.length;
  const items = [];
  for (const brand of brands) {
    const counters = { scanned: 0, retained: 0, pricesRead: 0, missingPrices: 0, ambiguousPrices: 0, rejectedBrandMismatchItems: 0 };
    const retained = [];
    let failure = null;
    try {
      const seenIds = new Set();
      await pages("items", brand.id, (entries) => {
        for (const entry of entries) {
          counters.scanned += 1;
          summary.itemsScanned += 1;
          const id = String(entry?.id ?? "");
          if (!id) throw new CatalogReadError("item-id-missing");
          if (seenIds.has(id)) throw new CatalogReadError("item-id-duplicate");
          seenIds.add(id);
          if (entry?.attributes?.brand_id !== undefined && String(entry.attributes.brand_id) !== brand.id) {
            counters.rejectedBrandMismatchItems += 1;
            summary.rejectedBrandMismatchItems += 1;
            if (counters.rejectedBrandMismatchItems === 1) summary.brandsWithRejectedItems += 1;
            continue;
          }
          const selected = selectItem(entry, brand, identifiers);
          if (selected) retained.push(selected);
        }
      });
      counters.retained = retained.length;
      if (retained.length) {
        const retainedIds = new Set(retained.map((item) => item.itemId));
        const prices = new Map();
        const duplicates = new Set();
        await pages("pricing", brand.id, (entries) => {
          counters.pricesRead += entries.length;
          summary.pricesScanned += entries.length;
          for (const entry of entries) {
            const id = String(entry?.id ?? "");
            if (!retainedIds.has(id)) continue;
            if (prices.has(id)) duplicates.add(id);
            else prices.set(id, entry);
          }
        });
        for (const item of retained) {
          const pricing = prices.get(item.itemId);
          if (!pricing || duplicates.has(item.itemId)) {
            const ambiguous = duplicates.has(item.itemId);
            counters[ambiguous ? "ambiguousPrices" : "missingPrices"] += 1;
            item.sourceEvidence.pricingStatus = ambiguous ? "ambiguous" : "missing";
            item.sourceEvidence.mapStatus = ambiguous ? "ambiguous-pricing" : "missing-pricing";
            continue;
          }
          const values = retailPrices(pricing);
          item.canPurchase = typeof pricing.attributes?.can_purchase === "boolean" ? pricing.attributes.can_purchase : null;
          item.map = values.map; item.msrp = values.msrp; item.cost = values.cost;
          Object.assign(item.sourceEvidence, { pricingStatus: "matched", mapStatus: values.mapStatus, msrpPriceList: values.msrpPriceList });
        }
      }
    } catch (error) {
      failure = safeError(error);
      if (failure.status === 401 || failure.status === 403) throw failure;
    }
    if (failure) {
      summary.brandsFailed += 1;
      summary.failureReasonCounts[failure.reasonCode] = (summary.failureReasonCounts[failure.reasonCode] ?? 0) + 1;
      if (failure.status !== null) summary.failureHttpStatusCounts[failure.status] = (summary.failureHttpStatusCounts[failure.status] ?? 0) + 1;
      await onProgress({ brandId: brand.id, brand: brand.name, status: "failed", reasonCode: failure.reasonCode, httpStatus: failure.status, ...counters });
      continue;
    }
    items.push(...retained);
    summary.brandsCompleted += 1;
    summary.itemsRetained += retained.length;
    summary.missingPrices += counters.missingPrices;
    summary.ambiguousPrices += counters.ambiguousPrices;
    summary.unavailableMap += retained.filter((item) => item.map === null).length;
    summary.notPurchasable += retained.filter((item) => item.canPurchase !== true).length;
    summary.supraTargets += retained.filter((item) => item.targets.includes(SITES[0])).length;
    summary.bmwTargets += retained.filter((item) => item.targets.includes(SITES[1])).length;
    summary.existingSkuOnly += retained.filter((item) => item.targets.length === 0).length;
    await onProgress({ brandId: brand.id, brand: brand.name, status: "complete", ...counters });
  }
  return { items, summary };
}
