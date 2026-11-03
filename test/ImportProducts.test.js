import test from "node:test";
import assert from "node:assert/strict";
import { importSiteProducts } from "../src/sync/importProducts.js";

const item = {
  itemId: "100", brand: "Chemical Guys", sku: "CHEM-HS16", mpn: "HS-16", unitsPerSku: 1,
  description: "Chemical Guys HydroSpeed 16oz", category: "Detailing & Care",
  active: true, canPurchase: true, currency: "USD", map: 20, msrp: 25, cost: 10,
  targets: ["eastcoastsupra"], sourceEvidence: { pricingStatus: "matched", mapStatus: "valid" },
  shippingDimensions: [{ boxNumber: 1, weight: 2 }],
  restrictions: { warehouse_availability: [{ location_id: "01", can_place_order: true }] }
};
const site = { key: "eastcoastsupra", name: "East Coast Supra", domain: "eastcoastsupra.com" };
const shippingPolicy = { verified: true, sourceWeightUnit: "LB", siteWeightUnits: { eastcoastsupra: "KG" } };

function fixture(options = {}) {
  const events = [];
  const state = new Map();
  let contentReads = 0;
  const fail = (step) => {
    if (options.failAt === step) throw Object.assign(new Error("PRIVATE_REMOTE_BODY"), { status: 500 });
  };
  const client = {
    async queryCollectionsAll() { return [{ id: "c1", name: item.category }]; },
    async findProductsBySku(sku) { return [...state.values()].filter((value) => value.sku === sku).map((value) => structuredClone(value)); },
    async createProduct(payload) {
      const id = `p${state.size + 1}`;
      events.push({ step: "create", payload: structuredClone(payload) });
      assert.equal(payload.visible, false);
      const current = { ...structuredClone(payload), id, priceData: { ...payload.priceData, currency: "USD" },
        variants: [{ id: "00000000-0000-0000-0000-000000000000", choices: {}, variant: {} }], media: { items: [] } };
      state.set(id, current);
      fail("create"); // Simulates a committed create whose response was lost.
      return { product: structuredClone(current) };
    },
    async addMedia(id, urls) {
      events.push({ step: "media" }); fail("media");
      if (options.attachMedia !== false) state.get(id).media.items = urls.map((url) => ({ url }));
    },
    async updateInventory(id, update) {
      events.push({ step: "inventory", update }); fail("inventory");
      state.get(id).stock = { trackInventory: update.trackQuantity, quantity: update.variants[0].quantity };
    },
    async addProductsToCollection(collectionId, ids) {
      events.push({ step: "collection" }); fail("collection");
      for (const id of ids) state.get(id).collectionIds = [collectionId];
    },
    async updateProduct(id, patch) {
      events.push({ step: patch.visible ? "publish" : "patch", patch }); fail("publish");
      Object.assign(state.get(id), structuredClone(patch));
      return { product: structuredClone(state.get(id)) };
    },
    async getProduct(id) { return { product: structuredClone(state.get(id)) }; }
  };
  const supplierClient = {
    async get(path) {
      const id = path.split("/").at(-1);
      if (path.startsWith("/v1/items/data/")) {
        contentReads += 1;
        if (options.supplierUnauthorized) throw Object.assign(new Error("SECRET_SUPPLIER_ERROR"), { status: 401 });
        return { data: [{ id, descriptions: [{ type: "description", description: "Verified supplier product description." }],
          files: [{ id: "img", type: "Image", file_extension: "jpg", links: [{ url: "https://cdn.example.com/product.jpg", width: "800", height: "800" }] }] }] };
      }
      if (path.startsWith("/v1/inventory/")) return { data: [{ id, attributes: { inventory: { "01": 3 } } }] };
      throw new Error("Unexpected supplier route");
    }
  };
  return { client, supplierClient, events, state, get contentReads() { return contentReads; } };
}

const run = (f, overrides = {}) => importSiteProducts({ site, client: f.client, supplierClient: f.supplierClient,
  products: [], items: [item], apply: true, maxCreates: 1, shippingPolicy, runtime: { sleep: async () => {} }, ...overrides });

test("new imports create hidden, configure media/stock/category, then publish and verify", async () => {
  const f = fixture();
  const result = await run(f);
  assert.deepEqual(f.events.map((event) => event.step), ["create", "media", "inventory", "collection", "publish"]);
  assert.equal(f.events[0].payload.sku, "T14-100");
  assert.equal(f.events[2].update.trackQuantity, true);
  assert.equal(f.events[2].update.variants[0].quantity, 3);
  assert.equal(result.createdHidden, 1);
  assert.equal(result.published, 1);
  assert.equal(result.verified, 1);
  const serialized = JSON.stringify(result);
  for (const privateValue of ["p1", "CHEM-HS16", "purchaseCost", "HydroSpeed"]) assert.equal(serialized.includes(privateValue), false);
});

test("media, inventory, and collection failures leave newly created products hidden", async () => {
  for (const failAt of ["media", "inventory", "collection"]) {
    const f = fixture({ failAt });
    const result = await run(f);
    assert.equal(result.errors, 1);
    assert.equal(result.published, 0);
    assert.equal([...f.state.values()][0].visible, false);
    assert.equal(f.events.some((event) => event.step === "publish"), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_REMOTE_BODY"), false);
  }
});

test("a lost create response is never retried and a complete later crawl prevents duplication", async () => {
  const f = fixture({ failAt: "create" });
  const result = await run(f, { items: [item, { ...item, itemId: "101", sku: "CHEM-SECOND", mpn: "SECOND" }], maxCreates: 2 });
  assert.equal(result.attemptedCreates, 1);
  assert.equal(result.stopped, true);
  assert.equal(f.events.filter((event) => event.step === "create").length, 1);
  const second = await run(f, { products: [...f.state.values()] });
  assert.equal(second.existing, 1);
  assert.equal(second.attemptedCreates, 0);
  assert.equal(f.state.size, 1);
});

test("creation cap counts attempts and shipping/dry-run gates prevent all mutations", async () => {
  const f = fixture();
  const other = { ...item, itemId: "101", sku: "CHEM-SECOND", mpn: "SECOND", description: "Chemical Guys another cleaner" };
  const result = await run(f, { items: [item, other], maxCreates: 1 });
  assert.equal(result.attemptedCreates, 1);
  assert.equal(result.capped, 1);
  for (const options of [{ apply: false }, { shippingPolicy: { verified: false } }, { maxCreates: 0 }]) {
    const blocked = fixture();
    const summary = await run(blocked, options);
    assert.equal(summary.attemptedCreates, 0);
    assert.equal(blocked.events.length, 0);
    assert.equal(blocked.contentReads, 0);
  }
});

test("supplier authentication failure stops imports without exposing the remote body", async () => {
  const f = fixture({ supplierUnauthorized: true });
  const result = await run(f);
  assert.equal(result.stopped, true);
  assert.equal(result.attemptedCreates, 0);
  assert.equal(JSON.stringify(result).includes("SECRET_SUPPLIER_ERROR"), false);
});

test("a successful media request cannot publish until actual product media is readable", async () => {
  const f = fixture({ attachMedia: false });
  const result = await run(f);
  assert.equal(result.published, 0);
  assert.equal([...f.state.values()][0].visible, false);
});

test("ambiguous current supplier brand/MPN identities must not choose the first item to create", async () => {
  const f = fixture();
  const colliding = { ...item, itemId: "101", sku: "CHEM-OTHER-PACK" };
  const result = await run(f, { items: [item, colliding], maxCreates: 2 });
  assert.equal(result.attemptedCreates, 0);
  assert.equal(f.events.length, 0);
});
