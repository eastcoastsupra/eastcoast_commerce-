import assert from "node:assert/strict";
import test from "node:test";
import { fetchCommerceCatalog } from "../src/turn14/commerceCatalog.js";

const brand = (id, name) => ({ id, attributes: { name } });
const item = (id, description, extra = {}) => ({ id, attributes: {
  active: true, powersports_indicator: false, part_number: `sku-${id}`, mfr_part_number: `mpn-${id}`,
  part_description: description, category: "Cooling", units_per_sku: 1, ...extra
} });
const price = (id, extra = {}) => ({ id, attributes: {
  can_purchase: true, has_map: true, purchase_cost: 61.2345,
  pricelists: [{ name: "MAP", price: 100 }, { name: "Retail", price: 125 }], ...extra
} });
const page = (data, total = 1) => ({ data, meta: { total_pages: total } });

function fixture(routes) {
  let now = 0;
  const calls = [];
  return {
    calls,
    client: { get: async (path) => {
      calls.push({ path, now });
      assert.ok(Object.hasOwn(routes, path), `Unexpected route: ${path}`);
      if (routes[path] instanceof Error) throw routes[path];
      return structuredClone(routes[path]);
    } },
    runtime: { now: () => now, sleep: async (ms) => { now += ms; } }
  };
}

test("commerce catalog scans every brand/page and uses only explicit application text, detailing, or exact existing identifiers", async () => {
  const source = fixture({
    "/v1/brands": page([brand("1", "Parts"), brand("2", "Other")]),
    "/v1/items/brand/1?page=1": page([
      item("1", "  Supplier BMW M3 / Toyota Supra radiator  "), item("2", "B58 engine component"),
      item("3", "Supracharged universal part"), item("4", "BMW motorcycle", { powersports_indicator: true }),
      item("5", "BMW inactive", { active: false }), item("6", "Unrelated cleaner", { category: "Detailing & Care", units_per_sku: 4 }),
      item("7", "No vehicle text", { mfr_part_number: " KEEP-07 " }), item("8", "No vehicle text", { mfr_part_number: "KEEP07" })
    ], 2),
    "/v1/items/brand/1?page=2": page([item("9", "2020+ Toyota Supra oil cooler")], 2),
    "/v1/pricing/brand/1?page=1": page([price("1"), price("6")], 2),
    "/v1/pricing/brand/1?page=2": page([price("7"), price("9")], 2),
    "/v1/items/brand/2?page=1": page([item("10", "Ford Mustang component")])
  });
  const progress = [];
  const result = await fetchCommerceCatalog(source.client, { existingSkus: [" keep-07 "], runtime: source.runtime, onProgress: (event) => progress.push(event) });
  assert.deepEqual(result.items.map((entry) => entry.itemId), ["1", "6", "7", "9"]);
  assert.equal(result.items[0].description, "  Supplier BMW M3 / Toyota Supra radiator  ");
  assert.deepEqual(result.items[0].targets, ["eastcoastsupra", "ecbmw"]);
  assert.deepEqual(result.items[1].targets, ["eastcoastsupra", "ecbmw"]);
  assert.equal(result.items[1].unitsPerSku, 4);
  assert.deepEqual(result.items[2].targets, []);
  assert.equal(result.items[0].cost, 61.2345);
  assert.equal(result.summary.brandsCompleted, 2);
  assert.equal(result.summary.itemsScanned, 10);
  assert.equal(result.summary.pricingPages, 2);
  assert.equal(result.summary.existingSkuOnly, 1);
  assert.ok(!JSON.stringify({ summary: result.summary, progress }).includes("61.2345"));
  assert.ok(!JSON.stringify(progress).includes("purchase_cost"));
  assert.match(result.items[0].sourceEvidence.basis, /not full ACES fitment/u);
  for (let i = 1; i < source.calls.length; i += 1) assert.ok(source.calls[i].now - source.calls[i - 1].now >= 250);
});

test("commerce catalog holds missing/duplicate prices and requires a unique positive MAP with has_map true", async () => {
  const source = fixture({
    "/v1/brands": page([brand("1", "CSF")]),
    "/v1/items/brand/1?page=1": page(Array.from({ length: 6 }, (_, index) => item(String(index + 1), "BMW part"))),
    "/v1/pricing/brand/1?page=1": page([
      price("1", { has_map: false }),
      price("2", { pricelists: [{ name: "MAP", price: 100 }, { name: "map", price: 100 }] }),
      price("3", { pricelists: [{ name: "MAP", price: -1 }] }),
      price("4"), price("4"),
      price("6", { pricelists: [{ name: " MAP ", price: "109.99" }, { name: "Suggested Retail", price: 150 }, { name: "Retail", price: 170 }, { name: "Jobber", price: 80 }] })
    ])
  });
  const result = await fetchCommerceCatalog(source.client, { runtime: source.runtime, brandNames: [" csf "] });
  assert.deepEqual(result.items.map((entry) => entry.map), [null, null, null, null, null, 109.99]);
  assert.equal(result.items[3].sourceEvidence.pricingStatus, "ambiguous");
  assert.equal(result.items[3].cost, null);
  assert.equal(result.items[4].canPurchase, null);
  assert.equal(result.items[5].msrp, 150);
  assert.equal(result.items[5].sourceEvidence.msrpPriceList, "Suggested Retail");
  assert.equal(result.summary.missingPrices, 1);
  assert.equal(result.summary.ambiguousPrices, 1);
  assert.equal(result.summary.unavailableMap, 5);
});

test("commerce catalog preserves raw restrictions and selects an exact canary brand without fuzzy name matching", async () => {
  const source = fixture({
    "/v1/brands": page([brand("1", "H&R"), brand("2", "H R")]),
    "/v1/items/brand/1?page=1": page([item("1", "BMW springs", {
      not_carb_approved: false, prop_65: "Unknown", epa: "N/A", units_per_sku: 2,
      warehouse_availability: [{ location_id: "01", can_place_order: false }]
    })]),
    "/v1/pricing/brand/1?page=1": page([price("1")])
  });
  const result = await fetchCommerceCatalog(source.client, { runtime: source.runtime, brandNames: [" h&r "] });
  assert.equal(result.summary.brandsSelected, 1);
  assert.equal(result.items[0].brand, "H&R");
  assert.equal(result.items[0].unitsPerSku, 2);
  assert.equal(result.items[0].restrictions.epa, "N/A");
  assert.deepEqual(result.items[0].restrictions.warehouse_availability, [{ location_id: "01", can_place_order: false }]);
});

test("commerce catalog aborts globally for authorization errors without exposing response bodies", async () => {
  for (const status of [401, 403]) {
    const error = Object.assign(new Error("PRIVATE_SECRET"), { status, body: { purchase_cost: "PRIVATE_COST" } });
    const source = fixture({ "/v1/brands": page([brand("1", "First"), brand("2", "Second")]), "/v1/items/brand/1?page=1": error });
    await assert.rejects(fetchCommerceCatalog(source.client, { runtime: source.runtime }), (failure) => failure.status === status && failure.reasonCode === "http-error" && !String(failure).includes("PRIVATE") && failure.body === undefined && failure.cause === undefined);
    assert.equal(source.calls.length, 2);
  }
});

test("commerce catalog discards a failed brand, continues other brands, and refuses excessive pagination", async () => {
  const source = fixture({
    "/v1/brands": page([brand("1", "First"), brand("2", "Second")]),
    "/v1/items/brand/1?page=1": page([item("1", "BMW part")], 1001),
    "/v1/items/brand/2?page=1": page([item("2", "BMW part")]),
    "/v1/pricing/brand/2?page=1": page([price("2")])
  });
  const result = await fetchCommerceCatalog(source.client, { runtime: source.runtime });
  assert.equal(result.summary.brandsFailed, 1);
  assert.equal(result.summary.brandsCompleted, 1);
  assert.deepEqual(result.items.map((entry) => entry.itemId), ["2"]);
  await assert.rejects(fetchCommerceCatalog(source.client, { minRequestIntervalMs: 249 }), /at least 250/u);
});

test("commerce catalog reports fixed failure codes without relaxing pagination or identity validation", async (t) => {
  const cases = [
    { code: "response-data-not-array", first: { data: { private: "PRIVATE_DATA" }, meta: { total_pages: 1 } } },
    { code: "pagination-zero-pages-empty", first: page([], 0) },
    { code: "pagination-zero-pages-nonempty", first: page([item("1", "BMW PRIVATE_DATA")], 0) },
    { code: "pagination-invalid-total", first: page([], "PRIVATE_TOTAL") },
    { code: "pagination-invalid-total", first: page([], -1) },
    { code: "pagination-invalid-total", first: page([], 1.5) },
    { code: "pagination-page-limit", first: page([], 1001) },
    { code: "pagination-changed-total", first: page([item("1", "BMW PRIVATE_DATA")], 2), second: page([], 3) },
    { code: "item-id-missing", first: page([item(null, "BMW PRIVATE_DATA")]) },
    { code: "item-id-duplicate", first: page([item("1", "BMW PRIVATE_DATA")], 2), second: page([item("1", "BMW PRIVATE_DATA")], 2) },
    { code: "item-brand-mismatch", first: page([item("1", "BMW PRIVATE_DATA", { brand_id: "PRIVATE_BRAND" })]) },
    { code: "unexpected-catalog-error", first: page([item("1", "BMW PRIVATE_DATA", { warehouse_availability: [null] })]) }
  ];
  for (const [index, entry] of cases.entries()) await t.test(`${entry.code} ${index}`, async () => {
    const source = fixture({
      "/v1/brands": page([brand("1", "First"), brand("2", "Second")]),
      "/v1/items/brand/1?page=1": entry.first,
      ...(entry.second ? { "/v1/items/brand/1?page=2": entry.second } : {}),
      "/v1/items/brand/2?page=1": page([item("2", "BMW valid part")]),
      "/v1/pricing/brand/2?page=1": page([price("2")])
    });
    const progress = [];
    const result = await fetchCommerceCatalog(source.client, { runtime: source.runtime, onProgress: (event) => progress.push(event) });
    assert.deepEqual(result.items.map((value) => value.itemId), ["2"]);
    assert.equal(result.summary.brandsFailed, 1);
    assert.equal(result.summary.brandsCompleted, 1);
    assert.deepEqual(result.summary.failureReasonCounts, { [entry.code]: 1 });
    assert.deepEqual(result.summary.failureHttpStatusCounts, {});
    assert.equal(progress[0].reasonCode, entry.code);
    assert.equal(progress[0].httpStatus, null);
    assert.ok(!JSON.stringify({ summary: result.summary, progress }).includes("PRIVATE"));
  });
});

test("commerce catalog aggregates HTTP statuses and sanitizes untrusted error codes, bodies, causes, and messages", async () => {
  const remoteError = (status) => Object.assign(new Error("PRIVATE_MESSAGE"), {
    status, reasonCode: "PRIVATE_CODE", code: "PRIVATE_CODE", body: "PRIVATE_BODY", cause: new Error("PRIVATE_CAUSE")
  });
  const source = fixture({
    "/v1/brands": page([brand("1", "First"), brand("2", "Second"), brand("3", "Third"), brand("4", "Fourth")]),
    "/v1/items/brand/1?page=1": remoteError(503),
    "/v1/items/brand/2?page=1": remoteError(503),
    "/v1/items/brand/3?page=1": remoteError(404),
    "/v1/items/brand/4?page=1": remoteError("PRIVATE_STATUS")
  });
  const progress = [];
  const result = await fetchCommerceCatalog(source.client, { runtime: source.runtime, onProgress: (event) => progress.push(event) });
  assert.equal(result.summary.brandsFailed, 4);
  assert.deepEqual(result.summary.failureReasonCounts, { "http-error": 3, "request-failed": 1 });
  assert.deepEqual(result.summary.failureHttpStatusCounts, { 404: 1, 503: 2 });
  assert.deepEqual(progress.map((event) => event.httpStatus), [503, 503, 404, null]);
  assert.ok(!JSON.stringify({ summary: result.summary, progress }).includes("PRIVATE"));
});

test("commerce catalog also rejects and diagnoses zero-page pricing without retaining a partial brand", async () => {
  const source = fixture({
    "/v1/brands": page([brand("1", "First")]),
    "/v1/items/brand/1?page=1": page([item("1", "BMW part")]),
    "/v1/pricing/brand/1?page=1": page([], 0)
  });
  const result = await fetchCommerceCatalog(source.client, { runtime: source.runtime });
  assert.deepEqual(result.items, []);
  assert.equal(result.summary.brandsCompleted, 0);
  assert.deepEqual(result.summary.failureReasonCounts, { "pagination-zero-pages-empty": 1 });
});

test("commerce catalog gives fixed global brand-list errors before requesting any catalog records", async () => {
  const cases = [
    ["brand-data-not-array", { data: { private: "PRIVATE_DATA" } }],
    ["brand-pagination-invalid", page([brand("1", "First")], 2)],
    ["brand-id-missing", page([brand(null, "PRIVATE_NAME")])],
    ["brand-name-missing", page([brand("PRIVATE_ID", " ")])],
    ["brand-id-duplicate", page([brand("PRIVATE_ID", "First"), brand("PRIVATE_ID", "Second")])]
  ];
  for (const [code, response] of cases) {
    const source = fixture({ "/v1/brands": response });
    await assert.rejects(fetchCommerceCatalog(source.client, { runtime: source.runtime }), (error) => {
      assert.equal(error.reasonCode, code);
      assert.equal(error.status, null);
      assert.ok(!String(error).includes("PRIVATE"));
      return true;
    });
    assert.equal(source.calls.length, 1);
  }
});
