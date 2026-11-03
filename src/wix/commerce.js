import { requestJson } from "../lib/http.js";
import { WixCatalogV1Client } from "./client.js";

const WRITE_BASE = "https://www.wixapis.com/stores/v1";
const READ_BASE = "https://www.wixapis.com/stores-reader/v1";
const MAX_PRICE = 999999999.99;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function text(value, label, maximum, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (maximum !== undefined && result.length > maximum) {
    throw new RangeError(`${label} exceeds ${maximum} characters`);
  }
  return result;
}

function identifier(value, label = "ID") {
  return text(value, label);
}

function money(value, label = "price", { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > MAX_PRICE ||
    (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(`${label} must be a finite ${allowZero ? "non-negative" : "positive"} number at most ${MAX_PRICE}`);
  }
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (!allowZero && rounded === 0) throw new RangeError(`${label} rounds to zero`);
  return rounded;
}

function entries(value, label, maximum) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new RangeError(`${label} must contain between 1 and ${maximum} entries`);
  }
  return value;
}

function numericIdCursor(value) {
  // Live V1 responses serialize numericId as a decimal string despite the
  // number schema. Keep its exact representation and never coerce to Number.
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error("Wix numericId cursor is missing, unsafe, or not a canonical non-negative integer");
}

/**
 * Preserve unrelated tags, tag metadata, and SEO settings when replacing only
 * the requested title/description. Never mutate the catalog snapshot supplied.
 * https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/update-product
 */
export function mergeSeoData(existing, { title, description } = {}) {
  const result = structuredClone(existing === undefined || existing === null ? {} : object(existing, "seoData"));
  const replacements = {};
  if (title !== undefined) replacements.title = text(title, "SEO title");
  if (description !== undefined) replacements.description = text(description, "SEO description");
  if (!Object.keys(replacements).length) return result;
  if (result.tags !== undefined && !Array.isArray(result.tags)) {
    throw new TypeError("seoData.tags must be an array");
  }

  let foundTitle = false;
  let foundDescription = false;
  result.tags = (result.tags ?? []).map((tag) => {
    object(tag, "SEO tag");
    const type = String(tag.type ?? "").toLowerCase();
    if (type === "title" && replacements.title !== undefined) {
      foundTitle = true;
      // Wix rejects title tags routed through the custom/advanced-tags list.
      const replacement = { ...tag, children: replacements.title };
      if (replacement.custom === true) replacement.custom = false;
      return replacement;
    }
    if (type === "meta" && String(tag.props?.name ?? "").toLowerCase() === "description" &&
      replacements.description !== undefined) {
      foundDescription = true;
      return { ...tag, props: { ...tag.props, content: replacements.description } };
    }
    return tag;
  });
  if (replacements.title !== undefined && !foundTitle) {
    result.tags.push({ type: "title", children: replacements.title });
  }
  if (replacements.description !== undefined && !foundDescription) {
    result.tags.push({ type: "meta", props: { name: "description", content: replacements.description } });
  }
  return result;
}

/**
 * Build one simple physical product from already verified supplier fields.
 * Do not shorten identifiers, invent fitment/availability, or infer pricing.
 * The caller must intentionally shorten overlength source names/descriptions.
 * Currency is set by the store and is read-only in priceData.
 * https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/create-product
 */
export function buildProductPayload(normalized) {
  object(normalized, "normalized product");
  if (normalized.currency !== undefined && normalized.currency !== "USD") {
    throw new RangeError("Only verified USD supplier prices are supported");
  }
  const product = {
    name: text(normalized.name, "name", 80),
    productType: "physical",
    sku: text(normalized.sku, "sku", 40),
    priceData: { price: money(normalized.price) },
    visible: normalized.visible ?? false,
    manageVariants: false
  };
  if (typeof product.visible !== "boolean") throw new TypeError("visible must be a boolean");
  const brand = text(normalized.brand, "brand", 50, { optional: true });
  if (brand !== undefined) product.brand = brand;
  if (normalized.descriptionHtml !== undefined && normalized.descriptionHtml !== null) {
    if (typeof normalized.descriptionHtml !== "string") throw new TypeError("descriptionHtml must be a string");
    if (normalized.descriptionHtml.length > 8000) throw new RangeError("descriptionHtml exceeds 8000 characters");
    product.description = normalized.descriptionHtml;
  }
  if (normalized.weight !== undefined) {
    if (typeof normalized.weight !== "number" || !Number.isFinite(normalized.weight) ||
      normalized.weight < 0 || normalized.weight > MAX_PRICE) {
      throw new RangeError("weight must be a finite non-negative number at most 999999999.99 in the store's weight unit");
    }
    product.weight = normalized.weight;
  }
  if (normalized.seo !== undefined) {
    object(normalized.seo, "seo");
    product.seoData = mergeSeoData({}, normalized.seo);
  }
  return product;
}

/** Catalog V1 operations. All mutations disable transport retries: the caller
 * must reconcile an uncertain outcome before retrying, especially creation. */
export class WixCommerceClient extends WixCatalogV1Client {
  async request(url, method, body, { write = false } = {}) {
    return requestJson(url, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }, write ? { ...this.httpRuntime, retries: 0 } : this.httpRuntime);
  }

  async queryAllProducts({ includeHiddenProducts = true, includeVariants = true } = {}) {
    if (typeof includeHiddenProducts !== "boolean" || typeof includeVariants !== "boolean") {
      throw new TypeError("Product inclusion options must be booleans");
    }
    // Hidden products are silently excluded by default. Include them for dedup.
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/query-products
    // Offset paging can fail around 10,000 rows. This documented numericId
    // cursor keeps every request inside the first 100 rows of its own filter.
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/pagination
    const products = [];
    const seenIds = new Set();
    let cursor;
    while (true) {
      const query = { paging: { limit: 100 }, sort: JSON.stringify([{ numericId: "asc" }]) };
      if (cursor !== undefined) query.filter = JSON.stringify({ numericId: { $gt: cursor } });
      const result = await this.request(`${READ_BASE}/products/query`, "POST", { includeHiddenProducts, includeVariants, query });
      const page = result?.products;
      if (!Array.isArray(page)) {
        if (result && typeof result === "object" && Object.keys(result).length === 0) return products;
        throw new TypeError("Wix response is missing products");
      }
      if (page.length === 0) return products;
      for (const product of page) {
        const numericId = numericIdCursor(product.numericId);
        if (cursor !== undefined && BigInt(numericId) <= BigInt(cursor)) {
          throw new Error("Wix numericId cursor is not strictly increasing");
        }
        const id = identifier(product.id, "returned product ID");
        if (seenIds.has(id)) throw new Error("Wix catalog query returned a repeated product ID");
        seenIds.add(id);
        cursor = numericId;
        products.push(product);
      }
      // totalResults describes the current filtered window, not the accumulated
      // catalog. Comparing it with products.length would stop the crawl early.
    }
  }

  async getProduct(id) {
    identifier(id, "product ID");
    // Read immediately before merging existing SEO, preserving concurrent edits.
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/get-product
    return this.request(`${READ_BASE}/products/${encodeURIComponent(id)}?includeMerchantSpecificData=true`, "GET");
  }

  async findProductsBySku(sku) {
    text(sku, "sku", 40);
    if (sku.length > 40) throw new RangeError("sku exceeds 40 characters");
    // The official V1 Filter and Sort table supports top-level sku with $eq.
    // This does not search variant SKUs. includeVariants only expands results.
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/query-products
    const result = await this.request(`${READ_BASE}/products/query`, "POST", {
      query: { filter: JSON.stringify({ sku: { $eq: sku } }), paging: { limit: 100 } },
      includeHiddenProducts: true,
      includeVariants: true
    });
    if (!Array.isArray(result?.products)) throw new TypeError("Wix SKU lookup is missing products");
    const products = result.products;
    let total = result.totalResults;
    if (typeof total === "string" && /^(?:0|[1-9][0-9]*)$/u.test(total)) total = Number(total);
    if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) {
      throw new Error("Wix SKU lookup returned an invalid total");
    }
    if (products.length >= 100 || (total !== undefined && total > products.length) ||
      result.hasMore === true || result.hasNext === true || result.metadata?.hasMore === true ||
      result.metadata?.hasNext === true || result.metadata?.cursors?.next) {
      throw new Error("Wix SKU lookup may be incomplete; reconcile the full catalog before creation");
    }
    return products;
  }

  async queryAll(url, field, options = {}) {
    const items = [];
    const limit = 100;
    let offset = 0;
    while (true) {
      const result = await this.request(url, "POST", { ...options, query: { paging: { limit, offset } } });
      if (!Array.isArray(result?.[field])) throw new TypeError(`Wix response is missing ${field}`);
      const page = result[field];
      items.push(...page);
      const total = result.totalResults;
      if (page.length === 0 ||
        (typeof total === "number" && Number.isFinite(total) && items.length >= total) ||
        (total === undefined && page.length < limit)) return items;
      offset += page.length;
    }
  }

  async createProduct(product) {
    object(product, "product");
    return this.request(`${WRITE_BASE}/products`, "POST", { product }, { write: true });
  }

  async updateProduct(id, patch) {
    identifier(id, "product ID");
    object(patch, "product patch");
    if (patch.id !== undefined && patch.id !== id) throw new Error("Product patch ID does not match target ID");
    return this.request(`${WRITE_BASE}/products/${encodeURIComponent(id)}`, "PATCH", {
      product: { ...patch, id }
    }, { write: true });
  }

  async updatePrice(id, price) {
    // Keep the inherited method compatible while disabling mutation retries.
    return this.updateProduct(id, { priceData: { price } });
  }

  async updateVariants(id, variants) {
    identifier(id, "product ID");
    if (!Array.isArray(variants) || variants.length === 0) throw new TypeError("variants must be a non-empty array");
    for (const variant of variants) {
      object(variant, "variant update");
      if (variant.choices !== undefined || !Array.isArray(variant.variantIds) || variant.variantIds.length === 0) {
        throw new TypeError("Variant updates must use exact variantIds, not choices");
      }
      variant.variantIds.forEach((variantId) => identifier(variantId, "variant ID"));
    }
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/update-product-variants
    return this.request(`${WRITE_BASE}/products/${encodeURIComponent(id)}/variants`, "PATCH", { variants }, { write: true });
  }

  async addMedia(id, urls) {
    identifier(id, "product ID");
    const media = entries(urls, "media URLs", 50).map((url) => {
      text(url, "media URL");
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol)) throw new TypeError("Media URLs must use HTTP or HTTPS");
      return { url };
    });
    // No altText field exists on this endpoint's input. Media is attached after create.
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/add-product-media
    return this.request(`${WRITE_BASE}/products/${encodeURIComponent(id)}/media`, "POST", { media }, { write: true });
  }

  async updateInventory(productId, { trackQuantity, variants } = {}) {
    identifier(productId, "product ID");
    if (typeof trackQuantity !== "boolean") throw new TypeError("trackQuantity must be explicitly true or false");
    if (!Array.isArray(variants) || variants.length === 0) throw new TypeError("Inventory variants must be a non-empty array");
    const inventoryVariants = variants.map((variant) => {
      object(variant, "inventory variant");
      const variantId = identifier(variant.variantId, "inventory variant ID");
      if (trackQuantity) {
        if (!Number.isSafeInteger(variant.quantity) || variant.quantity < 0 || variant.quantity > 2147483647) {
          throw new RangeError("Tracked inventory quantity must be a non-negative int32");
        }
        return { variantId, quantity: variant.quantity };
      }
      if (typeof variant.inStock !== "boolean") throw new TypeError("Untracked inventory must supply inStock");
      return { variantId, inStock: variant.inStock };
    });
    // Omission of trackQuantity resets tracking to false for the ENTIRE product.
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/inventory/update-inventory-variants
    return this.request(`https://www.wixapis.com/stores/v2/inventoryItems/product/${encodeURIComponent(productId)}`, "PATCH", {
      inventoryItem: { productId, trackQuantity, variants: inventoryVariants }
    }, { write: true });
  }

  async queryCollectionsAll() {
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/query-collections
    return this.queryAll(`${READ_BASE}/collections/query`, "collections", { includeDescription: true });
  }

  async createCollection(collection) {
    object(collection, "collection");
    text(collection.name, "collection name", 50);
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/create-collection
    return this.request(`${WRITE_BASE}/collections`, "POST", { collection }, { write: true });
  }

  async addProductsToCollection(id, ids) {
    identifier(id, "collection ID");
    const productIds = entries(ids, "product IDs", 1000).map((productId) => identifier(productId, "product ID"));
    // https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v1/catalog/add-products-to-collection
    return this.request(`${WRITE_BASE}/collections/${encodeURIComponent(id)}/productIds`, "POST", { productIds }, { write: true });
  }
}
