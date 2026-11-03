const unknown = (reason) => ({ known: false, quantity: null, reason });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;

function itemEligibility(item) {
  if (!identifier(item?.itemId)) return { error: unknown("item-id-missing-or-invalid") };
  // Inventory units have not been verified for multipacks. Never divide or
  // multiply supplier inventory to infer availability for another selling unit.
  if (item.unitsPerSku !== 1) return { error: unknown("selling-unit-not-single") };
  const warehouses = item.restrictions?.warehouse_availability;
  if (!Array.isArray(warehouses) || warehouses.length === 0) return { error: unknown("warehouse-eligibility-missing") };
  const seen = new Set();
  const orderable = [];
  for (const warehouse of warehouses) {
    if (!object(warehouse) || !identifier(warehouse.location_id) || typeof warehouse.can_place_order !== "boolean") {
      return { error: unknown("warehouse-eligibility-invalid") };
    }
    if (seen.has(warehouse.location_id)) return { error: unknown("warehouse-id-duplicate") };
    seen.add(warehouse.location_id);
    if (warehouse.can_place_order === true) orderable.push(warehouse.location_id);
  }
  return { itemId: item.itemId, orderable };
}

/**
 * Supports the observed single-item response and a future bulk data array.
 * Requires exactly one record whose string id equals the requested item ID.
 * Only observed on-hand inventory in explicitly orderable Turn 14 warehouses
 * counts. Manufacturer stock, incoming quantities and ETAs are never counted.
 */
export function normalizeItemAvailability(response, item) {
  const eligibility = itemEligibility(item);
  if (eligibility.error) return eligibility.error;
  if (!object(response) || !Array.isArray(response.data)) return unknown("inventory-response-invalid");
  if (response.data.some((entry) => !object(entry) || !identifier(entry.id))) return unknown("inventory-record-id-missing-or-invalid");
  const matches = response.data.filter((entry) => entry.id === eligibility.itemId);
  if (matches.length === 0) return unknown("inventory-item-missing");
  if (matches.length !== 1) return unknown("inventory-item-ambiguous");
  const inventory = matches[0].attributes?.inventory;
  if (!object(inventory) || Object.keys(inventory).length === 0) return unknown("inventory-warehouse-schema-invalid");
  for (const [warehouseId, quantity] of Object.entries(inventory)) {
    if (!identifier(warehouseId)) return unknown("inventory-warehouse-id-invalid");
    if (!Number.isSafeInteger(quantity) || quantity < 0) return unknown("inventory-quantity-invalid");
  }
  let quantity = 0;
  for (const warehouseId of eligibility.orderable) {
    if (!Object.hasOwn(inventory, warehouseId)) return unknown("orderable-warehouse-inventory-missing");
    quantity += inventory[warehouseId];
    if (!Number.isSafeInteger(quantity)) return unknown("inventory-total-overflow");
  }
  return {
    known: true,
    quantity,
    reason: eligibility.orderable.length === 0 ? "no-orderable-warehouses" : quantity > 0 ? "available" : "out-of-stock"
  };
}

export async function readItemAvailability(client, item) {
  const eligibility = itemEligibility(item);
  if (eligibility.error) return eligibility.error;
  try {
    const response = await client.get(`/v1/inventory/${encodeURIComponent(eligibility.itemId)}`);
    return normalizeItemAvailability(response, item);
  } catch (error) {
    // Do not attach or log supplier error bodies, credentials, or account data.
    return unknown(error?.status === 401 || error?.status === 403 ? "inventory-unauthorized" : "inventory-request-failed");
  }
}
