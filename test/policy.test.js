import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePriceChange } from "../src/sync/policy.js";

function turn14Item(mapPrice, overrides = {}) {
  return {
    attributes: { active: true, ...overrides.itemAttributes },
    pricing: {
      attributes: {
        has_map: true,
        can_purchase: true,
        pricelists: [{ name: "map", price: mapPrice }],
        ...overrides.pricingAttributes
      }
    }
  };
}

const safePolicy = {
  mode: "raise-only",
  allowPriceDecrease: false,
  includeDiscounted: false,
  includeHidden: false
};

test("raise-only proposes raising a product below MAP", () => {
  const result = evaluatePriceChange(
    { visible: true, manageVariants: false, priceData: { price: 10 }, discount: { type: "NONE", value: 0 } },
    turn14Item(12.36),
    safePolicy
  );
  assert.equal(result.action, "update");
  assert.equal(result.reason, "raise-to-map");
  assert.equal(result.mapPrice, 12.36);
});

test("raise-only preserves a price above MAP", () => {
  const result = evaluatePriceChange(
    { visible: true, manageVariants: false, priceData: { price: 15 }, discount: { type: "NONE", value: 0 } },
    turn14Item(12.36),
    safePolicy
  );
  assert.equal(result.action, "none");
  assert.equal(result.reason, "current-price-above-map");
});

test("exact-map requires explicit authorization before lowering price", () => {
  const result = evaluatePriceChange(
    { visible: true, manageVariants: false, priceData: { price: 15 }, discount: { type: "NONE", value: 0 } },
    turn14Item(12.36),
    { ...safePolicy, mode: "exact-map" }
  );
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "price-decrease-not-authorized");
});

test("skips discounted products by default", () => {
  const result = evaluatePriceChange(
    { visible: true, manageVariants: false, priceData: { price: 10 }, discount: { type: "PERCENT", value: 10 } },
    turn14Item(12.36),
    safePolicy
  );
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "wix-product-has-active-discount");
});

test("skips products with variants", () => {
  const result = evaluatePriceChange(
    { visible: true, manageVariants: true, variants: [{ id: "v1" }], priceData: { price: 10 } },
    turn14Item(12.36),
    safePolicy
  );
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "wix-product-has-variants");
});
