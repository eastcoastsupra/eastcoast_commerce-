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

function safeError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const result = new Error(status ? `Turn 14 catalog read failed (HTTP ${status}).` : "Turn 14 catalog read or response validation failed.");
  result.status = status;
  return result;
}

/**
 * Reads only known brand/item/pricing routes. `items` is private runtime data:
 * it includes dealer cost for policy evaluation and must not be logged or saved
 * wholesale. `summary` and progress events never include prices or dealer cost.
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
    notPurchasable: 0, supraTargets: 0, bmwTargets: 0, existingSkuOnly: 0
  };
  let lastRequestAt = null;
  async function read(path) {
    if (lastRequestAt !== null) await runtime.sleep(Math.max(0, minRequestIntervalMs - (runtime.now() - lastRequestAt)));
    lastRequestAt = runtime.now();
    summary.requests += 1;
    try { return await client.get(path); } catch (error) { throw safeError(error); }
  }
  async function pages(kind, brandId, consume) {
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page += 1) {
      const response = await read(`/v1/${kind}/brand/${encodeURIComponent(brandId)}?page=${page}`);
      const total = Number(response?.meta?.total_pages ?? 1);
      if (!Array.isArray(response?.data) || !Number.isInteger(total) || total < 1 || total > 1000 || (page > 1 && total !== totalPages)) {
        throw new Error("Invalid, changed, or excessive catalog pagination.");
      }
      totalPages = total;
      summary[kind === "items" ? "itemPages" : "pricingPages"] += 1;
      consume(response.data);
    }
  }

  const response = await read("/v1/brands");
  if (!Array.isArray(response?.data) || Number(response?.meta?.total_pages ?? 1) !== 1) throw new Error("Invalid or incomplete Turn 14 brand list.");
  const allBrands = response.data.map((brand) => ({ id: String(brand?.id ?? ""), name: string(brand?.attributes?.name) }));
  if (allBrands.some((brand) => !brand.id || !brand.name.trim()) || new Set(allBrands.map((brand) => brand.id)).size !== allBrands.length) {
    throw new Error("Missing or duplicate brand identity.");
  }
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
    const counters = { scanned: 0, retained: 0, pricesRead: 0, missingPrices: 0, ambiguousPrices: 0 };
    const retained = [];
    let failure = null;
    try {
      const seenIds = new Set();
      await pages("items", brand.id, (entries) => {
        for (const entry of entries) {
          counters.scanned += 1;
          summary.itemsScanned += 1;
          const id = String(entry?.id ?? "");
          if (!id || seenIds.has(id) || (entry?.attributes?.brand_id !== undefined && String(entry.attributes.brand_id) !== brand.id)) {
            throw new Error("Missing, duplicate, or inconsistent catalog identity.");
          }
          seenIds.add(id);
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
      await onProgress({ brandId: brand.id, brand: brand.name, status: "failed", httpStatus: failure.status, ...counters });
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
