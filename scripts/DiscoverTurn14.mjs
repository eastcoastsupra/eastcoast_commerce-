import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Turn14Client } from "../src/turn14/client.js";
import { optionalEnv, requiredEnv } from "../src/lib/env.js";

// This job only reads the routes already exercised by the production sync.
// Unknown fitment, inventory, media, and promotion routes are not guessed.
const BASE_URL = "https://api.turn14.com";
const BRAND_NAME = "Chemical Guys";
const SAMPLE_BRANDS = ["CSF", "Mishimoto", "H&R"];
const MAX_PAGES = 50;
const OUTPUT_DIRECTORY = resolve("reports/discovery");
const PUBLIC_ITEM_KEYS = new Set([
  "active", "name", "title", "product_name", "product_description", "description",
  "short_description", "long_description", "part_number", "mfr_part_number",
  "manufacturer_part_number", "manufacturer_partnumber", "sku", "mpn", "upc",
  "ean", "gtin", "barcode", "brand", "brand_id", "brand_name", "manufacturer",
  "category", "category_id", "category_name", "subcategory", "subcategory_id",
  "subcategory_name", "product_type", "weight", "dimensions", "length", "width",
  "height", "color", "size", "material", "country_of_origin", "universal",
  "universal_fitment", "is_universal", "fitments", "fitment", "applications",
  "vehicles", "vehicle_ids", "aces_vehicle_ids", "acesvehicleids", "year", "years",
  "make", "model", "submodel", "engine", "position", "features", "bullets",
  "images", "image", "image_url", "media", "files", "links", "url"
]);
const PRIVATE_KEY = /(?:secret|token|password|authorization|credential|api.?key|client.?id|purchase.?cost|dealer.?cost|wholesale|account|customer)/iu;
const RETAIL_LIST_NAMES = new Set(["map", "retail", "suggested retail", "msrp"]);
let stage = "initialization";

function publicUrl(value) {
  if (typeof value !== "string" || !/^(?:https?:\/\/|\/)/iu.test(value)) return null;
  try {
    const url = new URL(value, BASE_URL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const page = url.searchParams.get("page");
    url.search = "";
    url.hash = "";
    if (/^\d+$/u.test(page ?? "")) url.searchParams.set("page", page);
    return url.href;
  } catch {
    return null;
  }
}

// Only allowlisted catalog attributes are serialized. Nested sensitive fields
// are removed too; response schemas below retain key names without values.
function publicValue(value, depth = 0) {
  if (depth > 10) return "[depth limit]";
  if (Array.isArray(value)) return value.map((entry) => publicValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PRIVATE_KEY.test(key) && !/(?:cost|margin|rebate|discount|pricelist)/iu.test(key))
      .map(([key, entry]) => [key, publicValue(entry, depth + 1)]));
  }
  if (typeof value === "string" && /^(?:https?:\/\/|\/)/iu.test(value)) return publicUrl(value);
  return value;
}

function schema(values) {
  const paths = new Map();
  function visit(value, path, depth) {
    if (depth > 12) return;
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!paths.has(path)) paths.set(path, new Set());
    paths.get(path).add(type);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, `${path}[]`, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, path ? `${path}.${key}` : key, depth + 1);
    }
  }
  for (const value of values) visit(value, "", 0);
  return Object.fromEntries([...paths.entries()].filter(([path]) => path)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, types]) => [path, [...types].sort()]));
}

function providedLinks(value) {
  const links = new Map();
  function visit(entry, path, linkContext, depth) {
    if (depth > 12) return;
    if (typeof entry === "string" && linkContext) {
      const url = publicUrl(entry);
      if (url) links.set(`${path}\n${url}`, { path, url });
    } else if (Array.isArray(entry)) {
      for (const child of entry) visit(child, `${path}[]`, linkContext, depth + 1);
    } else if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (PRIVATE_KEY.test(key)) continue;
        visit(child, path ? `${path}.${key}` : key,
          linkContext || /(?:links?|href|url|documentation)$/iu.test(key), depth + 1);
      }
    }
  }
  visit(value, "", false, 0);
  return [...links.values()];
}

function publicItem(item) {
  return {
    id: String(item.id),
    type: typeof item.type === "string" ? item.type : undefined,
    attributes: Object.fromEntries(Object.entries(item.attributes ?? {})
      .filter(([key]) => PUBLIC_ITEM_KEYS.has(key.toLowerCase()))
      .map(([key, value]) => [key, publicValue(value)])),
    links: providedLinks(item)
  };
}

function publicPricing(item) {
  const attrs = item.attributes ?? {};
  return {
    id: String(item.id),
    canPurchase: typeof attrs.can_purchase === "boolean" ? attrs.can_purchase : null,
    hasMap: typeof attrs.has_map === "boolean" ? attrs.has_map : null,
    retailPriceLists: (Array.isArray(attrs.pricelists) ? attrs.pricelists : [])
      .filter((entry) => RETAIL_LIST_NAMES.has(String(entry?.name ?? "").trim().toLowerCase()))
      .map((entry) => ({
        name: entry.name,
        price: typeof entry.price === "number" || typeof entry.price === "string" ? entry.price : null,
        currency: typeof entry.currency === "string" ? entry.currency : undefined
      }))
  };
}

function paginationMeta(response) {
  const allowed = new Set(["page", "current_page", "total_pages", "per_page", "page_size", "total", "total_count", "count"]);
  return Object.fromEntries(Object.entries(response?.meta ?? {})
    .filter(([key, value]) => allowed.has(key) && (typeof value === "number" || /^\d+$/u.test(String(value)))));
}

async function sampleVehicleBrands(client, brands) {
  const samples = [];
  for (const name of SAMPLE_BRANDS) {
    const matches = brands.filter((brand) => String(brand.name).trim().toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) {
      samples.push({ requestedName: name, status: matches.length ? "ambiguous-exact-name" : "exact-name-not-present" });
      continue;
    }
    const brand = matches[0];
    const itemRoute = `/v1/items/brand/${encodeURIComponent(brand.id)}?page=1`;
    const pricingRoute = `/v1/pricing/brand/${encodeURIComponent(brand.id)}?page=1`;
    stage = `vehicle-brand-${samples.length + 1}-items`;
    const itemResponse = await client.get(itemRoute);
    stage = `vehicle-brand-${samples.length + 1}-pricing`;
    const pricingResponse = await client.get(pricingRoute);
    if (!Array.isArray(itemResponse?.data) || !Array.isArray(pricingResponse?.data)) {
      throw new Error("Invalid vehicle-brand first-page shape.");
    }
    samples.push({
      brand, status: "first-page-only", itemRoute, pricingRoute,
      itemCount: itemResponse.data.length, priceCount: pricingResponse.data.length,
      itemPagination: paginationMeta(itemResponse), pricingPagination: paginationMeta(pricingResponse),
      itemResponseSchema: schema([itemResponse]), pricingResponseSchema: schema([pricingResponse]),
      itemLinks: providedLinks(itemResponse), pricingLinks: providedLinks(pricingResponse),
      items: itemResponse.data.map(publicItem), retailPricing: pricingResponse.data.map(publicPricing)
    });
  }
  return samples;
}

async function allBrandPages(client, kind, brandId) {
  const pages = [];
  const path = `/v1/${kind}/brand/${encodeURIComponent(brandId)}`;
  stage = `${kind}-page-1`;
  const first = await client.get(`${path}?page=1`);
  const totalPages = Number(first?.meta?.total_pages ?? 1);
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES) {
    throw new Error("Invalid or excessive pagination count.");
  }
  pages.push(first);
  // Sequential reads keep this discovery job small and avoid request bursts.
  for (let page = 2; page <= totalPages; page += 1) {
    stage = `${kind}-page-${page}`;
    pages.push(await client.get(`${path}?page=${page}`));
  }
  if (pages.some((page) => !Array.isArray(page?.data))) throw new Error("Invalid catalog page shape.");
  return { path, totalPages, pages, entries: pages.flatMap((page) => page.data) };
}

async function publicDocumentationProbe() {
  // No Authorization header, cookies, or client credentials are sent here.
  const url = `${BASE_URL}/v1/`;
  try {
    const response = await fetch(url, {
      method: "GET", redirect: "manual", headers: { accept: "application/json, text/html" },
      signal: AbortSignal.timeout(15000)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = (await response.text()).slice(0, 500000);
    let links = [];
    let responseSchema = null;
    try {
      const body = JSON.parse(text);
      links = providedLinks(body);
      responseSchema = schema([body]);
    } catch {
      links = [...text.matchAll(/href\s*=\s*["']([^"']+)["']/giu)]
        .map((match) => ({ path: "html.href", url: publicUrl(match[1]) }))
        .filter((link) => link.url);
    }
    const location = publicUrl(response.headers.get("location"));
    if (location) links.push({ path: "response.location", url: location });
    return { url, status: response.status, contentType, links, responseSchema };
  } catch {
    return { url, status: null, error: "Public documentation probe unavailable." };
  }
}

async function main() {
  const configuredBaseUrl = optionalEnv("TURN14_BASE_URL", BASE_URL).replace(/\/$/u, "");
  if (configuredBaseUrl !== BASE_URL) throw new Error("Discovery requires the verified production host.");
  const client = new Turn14Client({
    clientId: requiredEnv("TURN14_CLIENT_ID"),
    clientSecret: requiredEnv("TURN14_CLIENT_SECRET"),
    baseUrl: BASE_URL,
    httpRuntime: { timeoutMs: 30000, retries: 3, retryBaseMs: 1000 }
  });
  stage = "brands";
  const brandsResponse = await client.get("/v1/brands");
  if (!Array.isArray(brandsResponse?.data)) throw new Error("Invalid brands response shape.");
  const brands = brandsResponse.data.map((brand) => ({ id: String(brand.id), name: brand.attributes?.name ?? null }));
  const candidates = brands.filter((brand) => String(brand.name).trim().toLowerCase() === BRAND_NAME.toLowerCase());
  if (candidates.length !== 1) throw new Error("Chemical Guys brand is missing or ambiguous.");
  const brand = candidates[0];
  const items = await allBrandPages(client, "items", brand.id);
  const pricing = await allBrandPages(client, "pricing", brand.id);
  const pricesById = new Map(pricing.entries.map((item) => [String(item.id), item]));
  const vehicleBrandSamples = await sampleVehicleBrands(client, brands);
  stage = "public-documentation-probe";
  const documentation = await publicDocumentationProbe();
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    baseUrl: BASE_URL,
    sanitization: "Only public catalog attribute allowlist and MAP/Retail/Suggested Retail/MSRP values are included. Dealer cost, wholesale prices, tokens, credentials, raw errors, and response headers are not retained. URL query parameters except numeric page are removed.",
    brands: {
      count: brands.length,
      entries: brands,
      pagination: paginationMeta(brandsResponse),
      responseSchema: schema([brandsResponse]),
      links: providedLinks(brandsResponse)
    },
    catalog: {
      brand,
      counts: { items: items.entries.length, prices: pricing.entries.length, joined: items.entries.filter((item) => pricesById.has(String(item.id))).length },
      itemRoute: items.path,
      pricingRoute: pricing.path,
      itemPages: items.totalPages,
      pricingPages: pricing.totalPages,
      itemResponseSchema: schema(items.pages),
      pricingResponseSchema: schema(pricing.pages),
      itemLinks: items.pages.flatMap(providedLinks),
      pricingLinks: pricing.pages.flatMap(providedLinks),
      items: items.entries.map(publicItem),
      retailPricing: pricing.entries.map(publicPricing)
    },
    vehicleBrandSamples,
    documentation,
    unresolvedContracts: [
      "Exact fitment and vehicle endpoint contracts and pagination need official documentation or API-provided links.",
      "Exact detail/media/inventory endpoint contracts need official documentation or API-provided links.",
      "Manufacturer retail promotions and validity dates are unverified; dealer purchase-cost reductions do not authorize a retail sale.",
      "Numeric rate limits are unverified. This job reuses tokens and reads catalog pages sequentially."
    ]
  };
  stage = "write-report";
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(resolve(OUTPUT_DIRECTORY, "turn14-discovery.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: "complete", brands: brands.length, items: report.catalog.counts.items, prices: report.catalog.counts.prices, joined: report.catalog.counts.joined, itemPages: items.totalPages, pricingPages: pricing.totalPages, vehicleBrandSamples: vehicleBrandSamples.filter((sample) => sample.status === "first-page-only").length, report: "reports/discovery/turn14-discovery.json" }));
}

main().catch(async (error) => {
  const failure = { status: "failed", stage, httpStatus: Number.isInteger(error?.status) ? error.status : null };
  await mkdir(OUTPUT_DIRECTORY, { recursive: true }).catch(() => {});
  await writeFile(resolve(OUTPUT_DIRECTORY, "turn14-discovery-failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
});
