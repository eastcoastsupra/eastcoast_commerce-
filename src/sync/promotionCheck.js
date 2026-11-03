import { planCommercePrice } from "./commercePolicy.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactId = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;
const offsetDate = (value) => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));

/**
 * Review configured, documented consumer offers only; never infer offers from
 * changing dealer costs. Config follows config/Promotions.json. An absent
 * executionMode defaults to review-only; any requested execution mode other
 * than review-only fails closed.
 *
 * Each offer uses the commercePolicy promotion contract: {id,verified:true,
 * consumerPromotion:true,termsUrl,eligibleItemIds,startsAt,endsAt,currency,price,
 * mapFloor?,mapExceptionVerified?}. A singular exact string itemId is also
 * accepted; if both forms appear they must identify the same single item.
 * Prices, IDs, terms URLs, dates and dealer costs never leave this function.
 * validItemCandidates counts active, nonconflicting item/offer pairs, not writes.
 * All temporal counts exclude invalid offers. Every offer is checked against
 * current supplier evidence, including its prospective promotional price.
 */
export function evaluateManufacturerPromotions(items, config, { now = Date.now() } = {}) {
  const result = {
    executionMode: "review-only", configurationValid: 0, configuredOffers: 0,
    activeOffers: 0, upcomingOffers: 0, expiredOffers: 0, invalidOffers: 0,
    validCandidateOffers: 0, validItemCandidates: 0, blockedItemCandidates: 0,
    checksDisabled: 0, applied: 0, reasonCounts: {}
  };
  const reason = (code) => { result.reasonCounts[code] = (result.reasonCounts[code] ?? 0) + 1; };
  if (!object(config)) { reason("configuration-missing-or-invalid"); return result; }
  result.configuredOffers = Array.isArray(config.offers) ? config.offers.length : 0;
  const guards = ["requireExactItemEligibility", "requireConsumerOfferTerms",
    "requireStartAndEndWithTimezone", "requireDocumentedMapExceptionForBelowMap"];
  if (config.version !== 1 || config.currency !== "USD" || config.existingRegularPriceMode !== "raise-only" ||
      guards.some((field) => config[field] !== true) || config.dealerCostDiscountIsConsumerPromotion !== false ||
      !Array.isArray(config.offers) || (config.executionMode !== undefined && config.executionMode !== "review-only") ||
      typeof config.manufacturerPromotionChecks !== "boolean") {
    result.invalidOffers = result.configuredOffers;
    reason("configuration-unsafe-or-invalid");
    return result;
  }
  if (!Array.isArray(items) || typeof now !== "number" || !Number.isFinite(now)) {
    reason("catalog-or-clock-invalid");
    return result;
  }
  result.configurationValid = 1;
  if (!config.manufacturerPromotionChecks) {
    result.checksDisabled = 1;
    reason("promotion-checks-disabled");
    return result;
  }
  if (!config.offers.length) { reason("no-configured-consumer-offers"); return result; }

  const itemIndex = new Map();
  for (const item of items) {
    if (!exactId(item?.itemId)) continue;
    if (!itemIndex.has(item.itemId)) itemIndex.set(item.itemId, []);
    itemIndex.get(item.itemId).push(item);
  }
  const offerIdCounts = new Map();
  for (const offer of config.offers) if (exactId(offer?.id)) offerIdCounts.set(offer.id, (offerIdCounts.get(offer.id) ?? 0) + 1);
  const valid = [];
  for (const offer of config.offers) {
    const invalid = (code) => { result.invalidOffers += 1; reason(code); };
    if (!object(offer) || !exactId(offer.id) || offerIdCounts.get(offer.id) !== 1) {
      invalid("offer-identity-missing-or-ambiguous"); continue;
    }
    let ids = offer.eligibleItemIds;
    if (offer.itemId !== undefined) {
      if (!exactId(offer.itemId) || (ids !== undefined && (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== offer.itemId))) {
        invalid("offer-exact-eligibility-invalid"); continue;
      }
      ids = [offer.itemId];
    }
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !exactId(id)) || new Set(ids).size !== ids.length) {
      invalid("offer-exact-eligibility-invalid"); continue;
    }
    if (!offsetDate(offer.startsAt) || !offsetDate(offer.endsAt) || Date.parse(offer.endsAt) <= Date.parse(offer.startsAt)) {
      invalid("invalid-promotion-window"); continue;
    }
    const start = Date.parse(offer.startsAt);
    const end = Date.parse(offer.endsAt);
    let blocked = false;
    for (const id of ids) {
      const matches = itemIndex.get(id) ?? [];
      let failure;
      if (matches.length !== 1) failure = "offer-item-missing-or-ambiguous";
      else {
        const item = matches[0];
        if (item.unitsPerSku !== 1) failure = "offer-selling-unit-unverified";
        else if (item.sourceEvidence?.pricingStatus !== "matched" ||
          !["valid", "has-map-not-true"].includes(item.sourceEvidence?.mapStatus) ||
          (item.sourceEvidence.mapStatus === "valid" && !(typeof item.map === "number" && Number.isFinite(item.map) && item.map > 0)) ||
          (item.sourceEvidence.mapStatus === "has-map-not-true" && item.map != null)) failure = "offer-supplier-pricing-unverified";
        else {
          // Evaluate at the start boundary even for future/past offers, so a
          // malformed price or unauthorized MAP exception is never overlooked.
          const plan = planCommercePrice({
            supplier: { id: item.itemId, brand: item.brand, active: item.active, canPurchase: item.canPurchase,
              currency: item.currency, map: item.map, msrp: item.msrp, purchaseCost: item.cost },
            promotion: { ...offer, eligibleItemIds: ids }, now: start, expectedCurrency: config.currency
          });
          if (plan.action !== "create" || plan.reason !== "authorized-consumer-promotion") failure = plan.reason;
        }
      }
      if (failure) {
        blocked = true;
        result.blockedItemCandidates += 1;
        reason(failure);
      }
    }
    if (blocked) { result.invalidOffers += 1; continue; }
    valid.push({ ids, state: now < start ? "upcoming" : now >= end ? "expired" : "active" });
  }

  const activeItems = new Map();
  for (const offer of valid.filter((entry) => entry.state === "active")) {
    for (const id of offer.ids) activeItems.set(id, (activeItems.get(id) ?? 0) + 1);
  }
  for (const offer of valid) {
    if (offer.state === "active" && offer.ids.some((id) => activeItems.get(id) > 1)) {
      result.invalidOffers += 1;
      result.blockedItemCandidates += offer.ids.length;
      reason("conflicting-active-consumer-offers");
      continue;
    }
    result[`${offer.state}Offers`] += 1;
    if (offer.state === "active") {
      result.validCandidateOffers += 1;
      result.validItemCandidates += offer.ids.length;
      reason("active-documented-consumer-offer-review-only");
    } else reason(offer.state === "upcoming" ? "documented-offer-upcoming" : "documented-offer-expired");
  }
  return result;
}
