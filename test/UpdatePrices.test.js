import test from "node:test";
import assert from "node:assert/strict";
import { updateSitePrices } from "../src/sync/updatePrices.js";

const item = { itemId: "100", brand: "Chemical Guys", sku: "CHEM-HS16", mpn: "HS-16", unitsPerSku: 1, description: "Chemical Guys HydroSpeed 16oz", active: true, canPurchase: true, currency: "USD", map: 20, msrp: 25, cost: 10, sourceEvidence: { pricingStatus: "matched", mapStatus: "valid" } };
const product = { id: "p1", brand: "Chemical Guys", name: item.description, sku: item.sku, visible: true, priceData: { price: 15, discountedPrice: 15, currency: "USD" }, discount: { type: "NONE", value: 0 } };
const runtime = { sleep: async () => {} };
function clientFor(products = [product]) {
  const state = new Map(products.map((entry) => [entry.id, structuredClone(entry)]));
  const writes = [];
  return {
    state, writes,
    async getProduct(id) { return { product: structuredClone(state.get(id)) }; },
    async updateProduct(id, patch) {
      writes.push({ kind: "product", id, patch: structuredClone(patch) });
      const current = state.get(id);
      if (patch.priceData) current.priceData = { ...current.priceData, ...patch.priceData, discountedPrice: patch.priceData.price };
      if (patch.sku !== undefined) current.sku = patch.sku;
      return { product: structuredClone(current) };
    },
    async updateVariants(id, patches) {
      writes.push({ kind: "variant", id, patches });
      for (const patch of patches) for (const variantId of patch.variantIds) {
        const variant = state.get(id).variants.find((entry) => entry.id === variantId).variant;
        variant.priceData = { ...variant.priceData, price: patch.price, discountedPrice: patch.price };
      }
    }
  };
}
const run = (options = {}) => updateSitePrices({ site: { key: "eastcoastsupra" }, client: clientFor(), products: [product], items: [item], runtime, ...options });

test("dry run reports aggregate proposals without reads or writes or identifying data", async () => {
  const client = { async getProduct() { throw new Error("must not read"); } };
  const events = [];
  const result = await run({ client, onProgress: (counts) => events.push(counts) });
  assert.equal(result.proposedPriceRaises, 1);
  assert.equal(result.writeAttempts, 0);
  const serialized = JSON.stringify({ result, events });
  for (const privateValue of ["p1", "CHEM-HS16", "purchaseCost", "HydroSpeed"]) assert.equal(serialized.includes(privateValue), false);
});

test("fresh reads stop price, SKU, discount and identity races before mutation", async () => {
  for (const mutate of [
    (value) => { value.priceData.price = 17; },
    (value) => { value.sku = "CHANGED"; },
    (value) => { value.discount.value = 5; },
    (value) => { value.brand = "Other"; }
  ]) {
    const client = clientFor();
    mutate(client.state.get("p1"));
    const result = await run({ client, apply: true });
    assert.equal(result.conflicts, 1);
    assert.equal(result.writeAttempts, 0);
    assert.equal(client.writes.length, 0);
  }
});

test("one simple patch raises price and recovers only a verified missing SKU", async () => {
  const blank = { ...product, sku: "", description: "<p>Manufacturer Part Number: HS-16</p>" };
  const client = clientFor([blank]);
  const result = await run({ client, products: [blank], apply: true });
  assert.deepEqual(client.writes[0].patch, { priceData: { price: 20 }, sku: item.sku });
  assert.equal(result.applied, 1);
  assert.equal(result.pricesUpdated, 1);
  assert.equal(result.skusRecovered, 1);
  assert.equal(client.state.get("p1").sku.startsWith("T14-"), false);
});

test("manual discounts, discounted prices, hidden products, and invalid source MAP stay protected", async () => {
  for (const changed of [
    { ...product, discount: { type: "AMOUNT", value: 2 } },
    { ...product, priceData: { ...product.priceData, discountedPrice: 14 } },
    { ...product, visible: false }
  ]) {
    const client = clientFor([changed]);
    const result = await run({ client, products: [changed], apply: true });
    assert.equal(result.writeAttempts, 0);
    assert.equal(result.held, 1);
  }
  const result = await run({ apply: true, items: [{ ...item, map: null, sourceEvidence: { pricingStatus: "matched", mapStatus: "invalid" } }] });
  assert.equal(result.byReason["unverified-supplier-pricing"], 1);
});

test("an exact variant raises its own price without substituting the parent", async () => {
  const variant = { ...product, sku: "", manageVariants: true, variants: [{ id: "v1", choices: { Size: "16oz" }, variant: { sku: item.sku, priceData: { ...product.priceData } } }] };
  const client = clientFor([variant]);
  const result = await run({ client, products: [variant], apply: true });
  assert.deepEqual(client.writes, [{ kind: "variant", id: "p1", patches: [{ variantIds: ["v1"], price: 20 }] }]);
  assert.equal(result.variantsUpdated, 1);
});

test("write cap counts attempted failed writes and never retries a mutation", async () => {
  const second = { ...product, id: "p2" };
  let attempted = 0;
  const client = clientFor([product, second]);
  client.updateProduct = async () => { attempted += 1; throw Object.assign(new Error("private body"), { status: 500 }); };
  const result = await run({ client, products: [product, second], apply: true, maxUpdates: 1 });
  assert.equal(attempted, 1);
  assert.equal(result.writeAttempts, 1);
  assert.equal(result.unverifiedWrites, 1);
  assert.equal(result.capDeferred, 1);
});

test("read-back tolerates stale GETs with only bounded delays and no duplicate writes", async () => {
  const client = clientFor();
  let reads = 0;
  const delays = [];
  const original = client.getProduct;
  client.getProduct = async (id) => {
    reads += 1;
    if (reads === 2 || reads === 3) return { product: structuredClone(product) };
    return original(id);
  };
  const result = await run({ client, apply: true, runtime: { sleep: async (ms) => delays.push(ms) } });
  assert.equal(result.applied, 1);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(client.writes.length, 1);
});

test("authorization failure and three operation errors stop further site writes", async () => {
  for (const status of [401, 403, 500]) {
    let reads = 0;
    const products = Array.from({ length: 5 }, (_, at) => ({ ...product, id: `p${at}` }));
    const client = { async getProduct() { reads += 1; throw Object.assign(new Error("secret error body"), { status }); } };
    const result = await run({ client, products, apply: true });
    assert.equal(result.writeAttempts, 0);
    assert.equal(reads, status === 500 ? 3 : 1);
    assert.equal(status === 500 ? result.stoppedErrorLimit : result.stoppedAuthorization, 1);
  }
});

test("regular reductions are counted but not applied; safe SKU recovery preserves current higher price", async () => {
  const higher = { ...product, priceData: { ...product.priceData, price: 30, discountedPrice: 30 } };
  const client = clientFor([higher]);
  const result = await run({ client, products: [higher], apply: true });
  assert.equal(result.potentialReductions, 1);
  assert.equal(result.writeAttempts, 0);
  const blank = { ...higher, sku: "", description: "MPN: HS-16" };
  const recovery = clientFor([blank]);
  const recovered = await run({ client: recovery, products: [blank], apply: true });
  assert.deepEqual(recovery.writes[0].patch, { sku: item.sku });
  assert.equal(recovered.pricesUpdated, 0);
  assert.equal(recovered.skusRecovered, 1);
});
