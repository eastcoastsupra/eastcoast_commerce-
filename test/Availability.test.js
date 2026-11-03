import assert from "node:assert/strict";
import test from "node:test";
import { normalizeItemAvailability, readItemAvailability } from "../src/turn14/availability.js";

const item = (extra = {}) => ({
  itemId: "21466", unitsPerSku: 1,
  restrictions: { warehouse_availability: [
    { location_id: "01", can_place_order: true },
    { location_id: "02", can_place_order: false },
    { location_id: "03", can_place_order: true }
  ] }, ...extra
});
const response = (inventory = { "01": 2, "02": 100, "03": 3, "59": 50 }, extra = {}) => ({
  data: [{ id: "21466", attributes: {
    inventory, manufacturer: { stock: 10000, esd: "2026-11-03" },
    eta: { qty_on_order: { "01": 10000, "03": 20000 } }, ...extra
  } }]
});

test("availability counts only explicitly orderable warehouses and excludes manufacturer/incoming/unknown-location stock", () => {
  assert.deepEqual(normalizeItemAvailability(response(), item()), { known: true, quantity: 5, reason: "available" });
  assert.deepEqual(normalizeItemAvailability(response({ "01": 0, "02": 100, "03": 0 }), item()), { known: true, quantity: 0, reason: "out-of-stock" });
  const blocked = item({ restrictions: { warehouse_availability: [{ location_id: "01", can_place_order: false }] } });
  assert.deepEqual(normalizeItemAvailability(response(), blocked), { known: true, quantity: 0, reason: "no-orderable-warehouses" });
});

test("availability requires exactly one matching string item ID even in a future bulk array", () => {
  const bulk = response();
  bulk.data.unshift({ id: "other-item", attributes: { inventory: { "01": 999999 } } });
  assert.equal(normalizeItemAvailability(bulk, item()).quantity, 5);
  for (const invalid of [
    {}, { data: {} }, { data: [] }, { data: [{ id: "wrong-item" }] },
    { data: [{ id: 21466 }] }, { data: [{ attributes: {} }] },
    { data: [...response().data, ...response().data] }
  ]) {
    const result = normalizeItemAvailability(invalid, item());
    assert.equal(result.known, false);
    assert.equal(result.quantity, null);
  }
});

test("availability refuses malformed quantities, incomplete eligible warehouses, and arithmetic overflow", () => {
  for (const invalid of [
    null, [], {}, { "01": 2, "02": 100 },
    { "01": -1, "03": 3 }, { "01": 1.5, "03": 3 },
    { "01": "2", "03": 3 }, { "01": Infinity, "03": 3 },
    { "01": NaN, "03": 3 }, { "01": 2, "02": -1, "03": 3 },
    { "01": Number.MAX_SAFE_INTEGER, "03": 1 }
  ]) assert.equal(normalizeItemAvailability(response(invalid), item()).known, false);
});

test("availability refuses ambiguous eligibility, unknown IDs, and every selling unit other than numeric one", async () => {
  let calls = 0;
  const client = { get: async () => { calls += 1; return response(); } };
  for (const invalid of [
    item({ itemId: "" }), item({ itemId: 21466 }), item({ itemId: " 21466 " }),
    item({ unitsPerSku: 2 }), item({ unitsPerSku: "1" }), item({ unitsPerSku: null }),
    item({ restrictions: {} }), item({ restrictions: { warehouse_availability: [] } }),
    item({ restrictions: { warehouse_availability: [{ location_id: "01", can_place_order: "true" }] } }),
    item({ restrictions: { warehouse_availability: [{ location_id: 1, can_place_order: true }] } }),
    item({ restrictions: { warehouse_availability: [{ location_id: "01", can_place_order: true }, { location_id: "01", can_place_order: false }] } })
  ]) {
    assert.equal(normalizeItemAvailability(response(), invalid).known, false);
    assert.equal((await readItemAvailability(client, invalid)).known, false);
  }
  assert.equal(calls, 0);
});

test("availability reader uses the verified route and fails closed without serializing remote error contents", async () => {
  const paths = [];
  const result = await readItemAvailability({ get: async (path) => { paths.push(path); return response(); } }, item());
  assert.deepEqual(paths, ["/v1/inventory/21466"]);
  assert.equal(result.quantity, 5);
  const failed = await readItemAvailability({ get: async () => { throw Object.assign(new Error("PRIVATE_SECRET"), { status: 403, body: { credential: "PRIVATE_SECRET" } }); } }, item());
  assert.deepEqual(failed, { known: false, quantity: null, reason: "inventory-unauthorized" });
  assert.ok(!JSON.stringify(failed).includes("PRIVATE"));
});
