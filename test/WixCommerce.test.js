import test from "node:test";
import assert from "node:assert/strict";
import { WixCommerceClient, buildProductPayload, mergeSeoData } from "../src/wix/commerce.js";
import { SITES } from "../src/config/sites.js";
import { verifySeoReadback } from "../scripts/RefreshSeo.mjs";

function client() {
  return new WixCommerceClient({ apiKey: "test-key", siteId: "test-site", httpRuntime: { retries: 3, retryBaseMs: 0 } });
}

function mockResponses(t, responses) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected extra HTTP request");
    return new Response(JSON.stringify(response.body ?? response), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  return calls;
}

test("SEO title/description updates preserve custom metadata, canonical, robots, social and structured data", () => {
  const existing = {
    tags: [
      { type: "title", children: "Old title", meta: { source: "manual" }, custom: false },
      { type: "meta", props: { name: "description", content: "Old description", "data-owner": "store" }, disabled: false },
      { type: "link", props: { rel: "canonical", href: "https://example.test/existing-product" } },
      { type: "meta", props: { name: "robots", content: "index,follow" } },
      { type: "meta", props: { property: "og:image", content: "https://example.test/photo.jpg" } },
      { type: "script", props: { type: "application/ld+json" }, children: '{"@type":"Product"}' }
    ],
    settings: { preventAutoRedirect: false, keywords: [{ term: "verified product", isMain: true }] },
    otherMetadata: { keep: true }
  };
  const before = structuredClone(existing);
  const result = mergeSeoData(existing, { title: "Verified product | East Coast Supra", description: "Verified supplier description." });
  assert.deepEqual(existing, before);
  assert.equal(result.tags[0].children, "Verified product | East Coast Supra");
  assert.deepEqual(result.tags[0].meta, before.tags[0].meta);
  assert.equal(result.tags[1].props.content, "Verified supplier description.");
  assert.equal(result.tags[1].props["data-owner"], "store");
  assert.deepEqual(result.tags.slice(2), before.tags.slice(2));
  assert.deepEqual(result.settings, before.settings);
  assert.deepEqual(result.otherMetadata, before.otherMetadata);
  result.settings.keywords[0].term = "changed result";
  assert.equal(existing.settings.keywords[0].term, "verified product");
});

test("SEO merge adds missing tags without fabricating a canonical or enabling disabled tags", () => {
  const result = mergeSeoData({ tags: [{ type: "title", children: "Old", disabled: true, custom: true }] }, {
    title: "New", description: "Verified description"
  });
  assert.deepEqual(result.tags, [
    { type: "title", children: "New", disabled: true, custom: false },
    { type: "meta", props: { name: "description", content: "Verified description" } }
  ]);
});

test("create payload contains verified physical product fields without stock or shipping claims", () => {
  const product = buildProductPayload({
    name: "Verified part", sku: "PART-123", brand: "Verified manufacturer",
    descriptionHtml: "<p>Supplier text.</p>", price: 123.456, currency: "USD",
    seo: { title: "Verified part | East Coast BMW", description: "Supplier product information." }
  });
  assert.deepEqual(product, {
    name: "Verified part", productType: "physical", sku: "PART-123", brand: "Verified manufacturer",
    description: "<p>Supplier text.</p>", priceData: { price: 123.46 }, visible: false, manageVariants: false,
    seoData: { tags: [
      { type: "title", children: "Verified part | East Coast BMW" },
      { type: "meta", props: { name: "description", content: "Supplier product information." } }
    ] }
  });
  assert.equal("stock" in product, false);
  assert.equal("weight" in product, false);
  assert.equal("slug" in product, false);
  assert.equal("currency" in product.priceData, false);
});

test("create payload rejects unsafe prices and overlength identifiers instead of truncating them", () => {
  const base = { name: "Verified part", sku: "PART-123", price: 50, currency: "USD" };
  for (const price of [0, -1, 0.001, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
    assert.throws(() => buildProductPayload({ ...base, price }), /price/);
  }
  assert.throws(() => buildProductPayload({ ...base, sku: "x".repeat(41) }), /sku exceeds 40/);
  assert.throws(() => buildProductPayload({ ...base, name: "x".repeat(81) }), /name exceeds 80/);
  assert.throws(() => buildProductPayload({ ...base, brand: "x".repeat(51) }), /brand exceeds 50/);
  assert.throws(() => buildProductPayload({ ...base, descriptionHtml: "x".repeat(8001) }), /descriptionHtml exceeds 8000/);
  assert.throws(() => buildProductPayload({ ...base, currency: "EUR" }), /USD/);
  assert.throws(() => buildProductPayload({ ...base, visible: "true" }), /visible/);
  assert.throws(() => buildProductPayload({ ...base, weight: -1 }), /weight/);
});

test("catalog crawl uses numericId cursors across pages and ignores shrinking filtered totals", async (t) => {
  const page = Array.from({ length: 100 }, (_, index) => ({ id: String(index), numericId: 1000 + index }));
  const calls = mockResponses(t, [
    { products: page, totalResults: 102 },
    { products: [{ id: "hidden-existing", numericId: 1100, visible: false }], totalResults: 2 },
    { products: [{ id: "last-existing", numericId: 1101 }], totalResults: 1 },
    { products: [], totalResults: 0 }
  ]);
  const products = await client().queryAllProducts();
  assert.equal(products.length, 102);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].body.query.filter, undefined);
  assert.deepEqual(calls.slice(1).map((call) => JSON.parse(call.body.query.filter)), [
    { numericId: { $gt: "1099" } }, { numericId: { $gt: "1100" } }, { numericId: { $gt: "1101" } }
  ]);
  for (const call of calls) {
    assert.equal(call.url, "https://www.wixapis.com/stores-reader/v1/products/query");
    assert.equal(call.body.includeHiddenProducts, true);
    assert.equal(call.body.includeVariants, true);
    assert.equal(call.body.query.paging.limit, 100);
    assert.equal(call.body.query.paging.offset, undefined);
    assert.deepEqual(JSON.parse(call.body.query.sort), [{ numericId: "asc" }]);
    assert.equal(call.headers["wix-site-id"], "test-site");
  }
});

test("catalog cursors preserve decimal strings beyond Number precision and compare exact integer values", async (t) => {
  const calls = mockResponses(t, [
    { products: [{ id: "p1", numericId: "9007199254740993" }] },
    { products: [{ id: "p2", numericId: "9007199254740994" }] },
    { products: [] }
  ]);
  const products = await client().queryAllProducts();
  assert.deepEqual(products.map((product) => product.numericId), ["9007199254740993", "9007199254740994"]);
  assert.deepEqual(JSON.parse(calls[1].body.query.filter), { numericId: { $gt: "9007199254740993" } });
  assert.deepEqual(JSON.parse(calls[2].body.query.filter), { numericId: { $gt: "9007199254740994" } });
});

test("catalog cursor rejects noncanonical numeric strings before issuing another page request", async (t) => {
  const calls = mockResponses(t, [{ products: [{ id: "p1", numericId: "1e16" }] }]);
  await assert.rejects(client().queryAllProducts(), /canonical non-negative integer/);
  assert.equal(calls.length, 1);
});

test("catalog crawl stops on non-advancing numericId instead of looping or duplicating products", async (t) => {
  const calls = mockResponses(t, [
    { products: [{ id: "p1", numericId: 1000 }] },
    { products: [{ id: "p1", numericId: 1000 }] }
  ]);
  await assert.rejects(client().queryAllProducts(), /not strictly increasing/);
  assert.equal(calls.length, 2);
});

test("catalog crawl rejects an imprecise numericId rather than skipping uncertain ranges", async (t) => {
  mockResponses(t, [{ products: [{ id: "p1", numericId: Number.MAX_SAFE_INTEGER + 1 }] }]);
  await assert.rejects(client().queryAllProducts(), /unsafe/);
});

test("fresh product read supports preserving current SEO immediately before a patch", async (t) => {
  const response = { product: { id: "p1", seoData: { tags: [{ type: "meta", props: { name: "robots", content: "noindex" } }] } } };
  const calls = mockResponses(t, [response]);
  assert.deepEqual(await client().getProduct("p1"), response);
  assert.equal(calls[0].url, "https://www.wixapis.com/stores-reader/v1/products/p1?includeMerchantSpecificData=true");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});

test("exact top-level SKU lookup includes hidden matches and variants without broadening the filter", async (t) => {
  const products = [{ id: "p1", sku: "EXACT-123", visible: true }, { id: "p2", sku: "EXACT-123", visible: false }];
  const calls = mockResponses(t, [{ products, totalResults: "2" }]);
  assert.deepEqual(await client().findProductsBySku("EXACT-123"), products);
  assert.equal(calls[0].url, "https://www.wixapis.com/stores-reader/v1/products/query");
  assert.deepEqual(calls[0].body, {
    query: { filter: JSON.stringify({ sku: { $eq: "EXACT-123" } }), paging: { limit: 100 } },
    includeHiddenProducts: true, includeVariants: true
  });
});

test("SKU lookup refuses missing arrays, saturated results, and incomplete metadata before creation", async (t) => {
  mockResponses(t, [
    {},
    { products: Array.from({ length: 100 }, (_, index) => ({ id: String(index) })), totalResults: 100 },
    { products: [{ id: "p1" }], totalResults: 2 },
    { products: [{ id: "p1" }], metadata: { hasMore: true } }
  ]);
  const commerce = client();
  await assert.rejects(commerce.findProductsBySku("EXACT-123"), /missing products/);
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(commerce.findProductsBySku("EXACT-123"), /may be incomplete/);
  }
});

test("SEO verification tolerates stale reads with GET-only delays and preserves exact signatures", async () => {
  const expected = { tags: [
    { type: "title", children: "Exact title | East Coast Supra" },
    { type: "meta", props: { name: "description", content: "Exact description." } }
  ] };
  let reads = 0;
  let writes = 0;
  const delays = [];
  const wix = {
    async getProduct(id) {
      reads += 1;
      return { product: { id, seoData: reads < 3 ? { tags: [] } : expected } };
    },
    async updateProduct() { writes += 1; }
  };
  await verifySeoReadback(wix, "p1", expected, SITES.eastcoastsupra, { wait: async (milliseconds) => delays.push(milliseconds) });
  assert.equal(reads, 3);
  assert.equal(writes, 0);
  assert.deepEqual(delays, [1000, 2000]);
});

test("SEO verification fails a permanent mismatch after the bounded read window", async () => {
  let reads = 0;
  const delays = [];
  await assert.rejects(verifySeoReadback({ async getProduct(id) {
    reads += 1;
    return { product: { id, seoData: { tags: [] } } };
  } }, "p1", { tags: [{ type: "title", children: "Expected title" }] }, SITES.eastcoastsupra, {
    wait: async (milliseconds) => delays.push(milliseconds)
  }), /did not match/);
  assert.equal(reads, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test("SEO verification stops immediately on authorization failure", async () => {
  let reads = 0;
  const delays = [];
  await assert.rejects(verifySeoReadback({ async getProduct() {
    reads += 1;
    throw Object.assign(new Error("Permission denied"), { status: 403 });
  } }, "p1", {}, SITES.eastcoastsupra, { wait: async (milliseconds) => delays.push(milliseconds) }), { status: 403 });
  assert.equal(reads, 1);
  assert.deepEqual(delays, []);
});

test("ambiguous create failure is not retried automatically even when transport retries are configured", async (t) => {
  const calls = mockResponses(t, [{ status: 503, body: { message: "outcome uncertain" } }]);
  await assert.rejects(client().createProduct({ name: "Part" }), /HTTP 503/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});

test("the inherited updatePrice interface also disables automatic write retries", async (t) => {
  const calls = mockResponses(t, [{ status: 503, body: { message: "outcome uncertain" } }]);
  await assert.rejects(client().updatePrice("p1", 50), /HTTP 503/);
  assert.equal(calls.length, 1);
});

test("product patch targets the requested ID and changes only explicitly provided fields", async (t) => {
  const calls = mockResponses(t, [{ product: { id: "product-1" } }]);
  const commerce = client();
  await commerce.updateProduct("product-1", { priceData: { price: 50 } });
  assert.equal(calls[0].url, "https://www.wixapis.com/stores/v1/products/product-1");
  assert.equal(calls[0].method, "PATCH");
  assert.deepEqual(calls[0].body, { product: { id: "product-1", priceData: { price: 50 } } });
  await assert.rejects(commerce.updateProduct("product-1", { id: "another-product" }), /does not match/);
  assert.equal(calls.length, 1);
});

test("inventory requires explicit tracking mode and an exact variant before any request", async (t) => {
  const calls = mockResponses(t, [{}, {}]);
  const commerce = client();
  await assert.rejects(commerce.updateInventory("product-1", { variants: [{ variantId: "v1", quantity: 3 }] }), /trackQuantity/);
  await assert.rejects(commerce.updateInventory("product-1", { trackQuantity: true, variants: [{ variantId: "v1", inStock: true }] }), /quantity/);
  assert.equal(calls.length, 0);
  await commerce.updateInventory("product-1", { trackQuantity: true, variants: [{ variantId: "v1", quantity: 3, inStock: true }] });
  await commerce.updateInventory("product-1", { trackQuantity: false, variants: [{ variantId: "v1", inStock: false }] });
  assert.equal(calls[0].url, "https://www.wixapis.com/stores/v2/inventoryItems/product/product-1");
  assert.deepEqual(calls[0].body, { inventoryItem: {
    productId: "product-1", trackQuantity: true, variants: [{ variantId: "v1", quantity: 3 }]
  } });
  assert.deepEqual(calls[1].body, { inventoryItem: {
    productId: "product-1", trackQuantity: false, variants: [{ variantId: "v1", inStock: false }]
  } });
});

test("variant updates require exact IDs and media uses the separate supported URL contract", async (t) => {
  const calls = mockResponses(t, [{ variants: [] }, {}]);
  const commerce = client();
  await assert.rejects(commerce.updateVariants("product-1", [{ choices: { Size: "Large" }, price: 50 }]), /exact variantIds/);
  await commerce.updateVariants("product-1", [{ variantIds: ["v1"], price: 50 }]);
  await commerce.addMedia("product-1", ["https://supplier.test/photo.jpg"]);
  assert.deepEqual(calls[0].body, { variants: [{ variantIds: ["v1"], price: 50 }] });
  assert.equal(calls[1].url, "https://www.wixapis.com/stores/v1/products/product-1/media");
  assert.deepEqual(calls[1].body, { media: [{ url: "https://supplier.test/photo.jpg" }] });
  await assert.rejects(commerce.addMedia("product-1", ["file:///sensitive"]), /HTTP/);
  await assert.rejects(commerce.addMedia("product-1", Array(51).fill("https://supplier.test/photo.jpg")), /50/);
});

test("collection reads and membership writes use Catalog V1 contracts and capped batches", async (t) => {
  const calls = mockResponses(t, [
    { collections: [{ id: "c1", name: "Existing category" }], totalResults: 1 },
    { collection: { id: "c2" } }, {}
  ]);
  const commerce = client();
  assert.equal((await commerce.queryCollectionsAll())[0].id, "c1");
  await commerce.createCollection({ name: "Verified category", description: "Supplier category" });
  await commerce.addProductsToCollection("c2", ["product-1"]);
  assert.equal(calls[0].url, "https://www.wixapis.com/stores-reader/v1/collections/query");
  assert.deepEqual(calls[1].body, { collection: { name: "Verified category", description: "Supplier category" } });
  assert.equal(calls[2].url, "https://www.wixapis.com/stores/v1/collections/c2/productIds");
  assert.deepEqual(calls[2].body, { productIds: ["product-1"] });
  await assert.rejects(commerce.addProductsToCollection("c2", Array(1001).fill("p")), /1000/);
});
