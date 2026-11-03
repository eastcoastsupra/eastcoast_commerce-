import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateManufacturerPromotions } from "../src/sync/promotionCheck.js";

const config = JSON.parse(await readFile(new URL("../config/Promotions.json", import.meta.url), "utf8"));
const item = { itemId: "private-item-id", brand: "Manufacturer", unitsPerSku: 1, active: true, canPurchase: true,
  currency: "USD", map: 20, msrp: 25, cost: 10, sourceEvidence: { pricingStatus: "matched", mapStatus: "valid" } };
const offer = { id: "private-promotion-id", verified: true, consumerPromotion: true,
  termsUrl: "https://manufacturer.example/private-offer", eligibleItemIds: [item.itemId],
  startsAt: "2026-11-01T00:00:00-04:00", endsAt: "2026-11-10T00:00:00-05:00",
  currency: "USD", price: 18, mapFloor: 18, mapExceptionVerified: true };
const now = Date.parse("2026-11-03T12:00:00Z");
const evaluate = (offers = [offer], options = {}) => evaluateManufacturerPromotions([item], { ...config, offers }, { now, ...options });

test("actual empty promotion configuration stays review-only and never invents a retail offer from dealer cost", () => {
  const result = evaluateManufacturerPromotions([{ ...item, cost: 1 }], config, { now });
  assert.equal(result.executionMode, "review-only");
  assert.equal(result.configurationValid, 1);
  assert.equal(result.configuredOffers, 0);
  assert.equal(result.validItemCandidates, 0);
  assert.equal(result.applied, 0);
});

test("documented active offers report only aggregate candidates, never identifiers or money", () => {
  const result = evaluate();
  assert.equal(result.activeOffers, 1);
  assert.equal(result.validCandidateOffers, 1);
  assert.equal(result.validItemCandidates, 1);
  assert.equal(result.applied, 0);
  const serialized = JSON.stringify(result);
  for (const privateValue of [item.itemId, offer.id, offer.termsUrl, "purchaseCost", "mapFloor", '"price"']) assert.equal(serialized.includes(privateValue), false);
});

test("offer time classification uses explicit offsets and an exclusive expiry boundary", () => {
  assert.equal(evaluate([offer], { now: Date.parse(offer.startsAt) - 1 }).upcomingOffers, 1);
  assert.equal(evaluate([offer], { now: Date.parse(offer.startsAt) }).activeOffers, 1);
  assert.equal(evaluate([offer], { now: Date.parse(offer.endsAt) }).expiredOffers, 1);
  assert.equal(evaluate([{ ...offer, startsAt: "2026-11-01T00:00:00" }]).invalidOffers, 1);
  assert.equal(evaluate([{ ...offer, startsAt: "2026-02-30T00:00:00Z" }]).invalidOffers, 1);
});

test("missing terms, dealer offers, wrong currencies, unknown items, and unapproved MAP exceptions fail closed", () => {
  for (const replacement of [
    { termsUrl: "" }, { consumerPromotion: false }, { currency: "EUR" },
    { eligibleItemIds: ["unknown"] }, { mapExceptionVerified: false }, { price: 9, mapFloor: 9 }
  ]) {
    const result = evaluate([{ ...offer, ...replacement }]);
    assert.equal(result.invalidOffers, 1);
    assert.equal(result.validItemCandidates, 0);
    assert.equal(result.applied, 0);
  }
});

test("missing/unsafe configuration cannot activate automatic promotions", () => {
  for (const invalid of [undefined, {}, { ...config, executionMode: "apply", offers: [offer] },
    { ...config, requireConsumerOfferTerms: false, offers: [offer] },
    { ...config, dealerCostDiscountIsConsumerPromotion: true, offers: [offer] }]) {
    const result = evaluateManufacturerPromotions([item], invalid, { now });
    assert.equal(result.configurationValid, 0);
    assert.equal(result.executionMode, "review-only");
    assert.equal(result.applied, 0);
  }
});

test("duplicate offer IDs, duplicate catalog IDs, and simultaneous competing offers are rejected", () => {
  assert.equal(evaluate([offer, offer]).invalidOffers, 2);
  const conflict = evaluate([offer, { ...offer, id: "different-offer" }]);
  assert.equal(conflict.invalidOffers, 2);
  assert.equal(conflict.validItemCandidates, 0);
  const catalog = evaluateManufacturerPromotions([item, item], { ...config, offers: [offer] }, { now });
  assert.equal(catalog.invalidOffers, 1);
});

test("singular exact item eligibility is supported without accepting broad or contradictory eligibility", () => {
  const single = { ...offer, itemId: item.itemId, eligibleItemIds: undefined };
  assert.equal(evaluate([single]).validItemCandidates, 1);
  assert.equal(evaluate([{ ...single, eligibleItemIds: ["another"] }]).invalidOffers, 1);
  assert.equal(evaluate([{ ...single, itemId: 123 }]).invalidOffers, 1);
});
