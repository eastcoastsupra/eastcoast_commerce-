import test from "node:test";
import assert from "node:assert/strict";
import { resolveIdentity, hasManagedVariants, checkRelevance, planCommercePrice } from "../src/sync/commercePolicy.js";

const supplier = { id: "123", brand: "Chemical Guys", mpn: "ABC-16", partNumber: "CG-ABC-16", sellableUnit: "1x473ml", active: true, canPurchase: true, currency: "USD", map: 20, msrp: 25, purchaseCost: 10 };
const product = { brand: "chemical guys", sku: "abc16", sellableUnit: "1x473ml" };
const existing = { price: 15, currency: "USD", visible: true };
const promotion = { id: "summer", verified: true, consumerPromotion: true, termsUrl: "https://manufacturer.example/promotions/summer", eligibleItemIds: ["123"], startsAt: "2026-06-01T00:00:00-04:00", endsAt: "2026-07-01T00:00:00-04:00", currency: "USD", price: 18, mapFloor: 18, mapExceptionVerified: true };
const now = Date.parse("2026-06-15T12:00:00Z");

test("identity scopes identifiers to manufacturer and selling unit", () => {
  const other = { ...supplier, id: "456", brand: "Other", purchaseCost: 1 };
  assert.equal(resolveIdentity(product, [other, supplier]).itemId, "123");
  assert.equal(resolveIdentity({ ...product, sellableUnit: "12x473ml" }, [supplier]).reason, "sellable-unit-mismatch");
  assert.equal(resolveIdentity({ ...product, sellableUnit: "" }, [supplier]).reason, "missing-sellable-unit");
});

test("normalized identifier collisions hold even with a raw punctuation match", () => {
  assert.equal(resolveIdentity({ ...product, sku: "ABC-16" }, [supplier, { ...supplier, id: "456", mpn: "ABC16" }]).reason, "ambiguous-normalized-identifier");
});

test("missing SKU needs a verified typed identifier, never a product name", () => {
  const blank = { ...product, sku: "", name: "Chemical Guys ABC-16" };
  assert.equal(resolveIdentity(blank, [supplier]).reason, "missing-verified-identifier");
  assert.equal(resolveIdentity({ ...blank, verifiedIdentifiers: [{ kind: "mpn", value: "ABC-16", verified: false }] }, [supplier]).status, "hold");
  assert.equal(resolveIdentity({ ...blank, verifiedIdentifiers: [{ kind: "mpn", value: "ABC-16", verified: true }] }, [supplier]).reason, "verified-missing-sku-match");
});

test("conflicting evidence cannot choose the first matching product", () => {
  const second = { ...supplier, id: "456", mpn: "OTHER", partNumber: "OTHER", gtin: "1234567890123" };
  assert.equal(resolveIdentity({ ...product, verifiedIdentifiers: [{ kind: "gtin", value: second.gtin, verified: true }] }, [supplier, second]).reason, "conflicting-verified-identifiers");
  assert.equal(resolveIdentity({ ...product, verifiedIdentifiers: [{ kind: "gtin", value: "9999999999999", verified: true }] }, [supplier]).reason, "unresolved-verified-identifier");
});

test("default zero-id variant does not prevent simple-product pricing", () => {
  const simple = { ...existing, manageVariants: false, productOptions: [], variants: [{ id: "00000000-0000-0000-0000-000000000000", choices: {}, variant: { sku: "" } }] };
  assert.equal(hasManagedVariants(simple), false);
  assert.equal(planCommercePrice({ supplier, existing: simple }).action, "update");
  assert.equal(hasManagedVariants({ ...simple, manageVariants: true }), true);
  assert.equal(hasManagedVariants({ ...simple, productOptions: [{ name: "Size", choices: ["16oz"] }] }), true);
  assert.equal(hasManagedVariants({ variants: [{ choices: { Size: "16oz" } }] }), true);
  assert.equal(hasManagedVariants({ variants: [{ choices: {} }, { choices: {} }] }), true);
});

test("relevance needs verified vehicle fitment or explicit universal category", () => {
  const supra = { fitments: [{ verified: true, make: "Toyota", model: "Supra", years: [2020] }] };
  assert.equal(checkRelevance(supra, "eastcoastsupra").eligible, true);
  assert.equal(checkRelevance(supra, "ecbmw").eligible, false);
  assert.equal(checkRelevance({ fitments: [{ verified: true, make: "BMW", model: "M4" }] }, "ecbmw").eligible, true);
  assert.equal(checkRelevance({ fitments: [{ make: "BMW", model: "M4" }], engine: "B58" }, "eastcoastsupra").eligible, false);
  assert.equal(checkRelevance({ universal: { verified: true, category: "detailing" } }, "ecbmw").eligible, true);
  assert.equal(checkRelevance({ universal: { verified: true, category: "wheels" } }, "ecbmw").eligible, false);
  assert.equal(checkRelevance(supra, "unknown").eligible, false);
});

test("new products use MAP then MSRP while existing prices default to raises only", () => {
  assert.equal(planCommercePrice({ supplier }).price, 20);
  assert.equal(planCommercePrice({ supplier: { ...supplier, map: null } }).price, 25);
  assert.equal(planCommercePrice({ supplier, existing }).price, 20);
  assert.equal(planCommercePrice({ supplier, existing: { ...existing, price: 30 } }).action, "none");
  assert.equal(planCommercePrice({ supplier, existing: { ...existing, price: 30 }, allowPriceDecrease: true }).action, "update");
  assert.equal(planCommercePrice({ supplier, existing: { ...existing, price: 20 } }).reason, "already-at-target");
});

test("bad prices, currencies, source status, and known loss-making targets hold", () => {
  for (const map of [0, -1, NaN, Infinity, "20", 0.001]) assert.equal(planCommercePrice({ supplier: { ...supplier, map } }).action, "hold");
  assert.equal(planCommercePrice({ supplier: { ...supplier, currency: "EUR" } }).reason, "currency-mismatch");
  assert.equal(planCommercePrice({ supplier, existing: { ...existing, currency: "CAD" } }).reason, "currency-mismatch");
  assert.equal(planCommercePrice({ supplier: { ...supplier, purchaseCost: 21 } }).reason, "price-below-purchase-cost");
  assert.equal(planCommercePrice({ supplier: { ...supplier, active: false } }).reason, "supplier-item-inactive");
  assert.equal(planCommercePrice({ supplier: { ...supplier, canPurchase: false } }).reason, "supplier-item-not-purchasable");
});

test("manual discounts, hidden products, and human edits survive repricing and promotions", () => {
  for (const [field, value, reason] of [["manualDiscount", true, "manual-discount"], ["visible", false, "hidden-product"], ["humanEdited", true, "human-edit-conflict"]]) {
    assert.equal(planCommercePrice({ supplier, existing: { ...existing, [field]: value }, promotion, now, allowPriceDecrease: true }).reason, reason);
  }
});

test("verified consumer promotion authorizes its own decrease during exact window", () => {
  const decision = planCommercePrice({ supplier, existing: { ...existing, price: 25 }, promotion, now });
  assert.equal(decision.action, "update");
  assert.equal(decision.price, 18);
  assert.equal(decision.reason, "authorized-consumer-promotion");
  assert.equal(planCommercePrice({ supplier, promotion, now: Date.parse(promotion.startsAt) }).price, 18);
  assert.equal(planCommercePrice({ supplier, promotion, now: Date.parse(promotion.endsAt) }).price, 20);
});

test("supplier cost discount is not an authorized customer promotion", () => {
  assert.equal(planCommercePrice({ supplier: { ...supplier, purchaseCost: 5 }, existing: { ...existing, price: 25 } }).action, "none");
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, consumerPromotion: false }, now }).reason, "unverified-consumer-promotion");
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, termsUrl: "" }, now }).reason, "unverified-consumer-promotion");
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, eligibleItemIds: ["456"] }, now }).reason, "promotion-item-not-eligible");
});

test("promotion cannot undercut ordinary MAP without a verified explicit exception", () => {
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, mapExceptionVerified: false }, now }).reason, "price-below-applicable-map");
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, mapFloor: null }, now }).reason, "missing-promotion-map-exception-floor");
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, price: 9, mapFloor: 9 }, now }).reason, "price-below-purchase-cost");
});

test("ambiguous dates, invalid calendar dates, and reversed promotion windows hold", () => {
  for (const startsAt of ["2026-06-01", "2026-06-01T00:00:00", "2026-02-30T00:00:00Z", "2026-06-01T25:00:00Z", "2026-06-01T00:00:00+19:00"]) {
    assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, startsAt }, now }).reason, "invalid-promotion-window");
  }
  assert.equal(planCommercePrice({ supplier, promotion: { ...promotion, endsAt: promotion.startsAt }, now }).reason, "invalid-promotion-window");
});
