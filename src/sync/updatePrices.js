import { buildSupplierMatchIndex, resolveCatalogProduct } from "./catalogMatch.js";
import { planCommercePrice } from "./commercePolicy.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cents = (value) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;

function selected(product, variantId) {
  if (variantId === null) return { data: product.priceData, sku: product.sku, visible: product.visible };
  const variants = (product.variants ?? []).filter((variant) => String(variant.id) === variantId);
  if (variants.length !== 1) return null;
  const variant = variants[0].variant;
  return variant ? { data: variant.priceData, sku: variant.sku, visible: variant.visible } : null;
}

function isDiscounted(data) {
  return typeof data?.price === "number" && typeof data.discountedPrice === "number" && data.discountedPrice < data.price;
}

function snapshot(product, variantId) {
  const target = selected(product, variantId);
  if (!target) return null;
  return {
    price: target.data?.price ?? null,
    currency: target.data?.currency ?? product.priceData?.currency ?? null,
    sku: String(target.sku ?? ""),
    visible: product.visible !== false && target.visible !== false,
    discountType: String(product.discount?.type ?? "NONE"),
    discountValue: product.discount?.value ?? 0,
    globalDiscountedPrice: product.priceData?.discountedPrice ?? null,
    discountedPrice: target.data?.discountedPrice ?? null,
    manualDiscount: Number(product.discount?.value ?? 0) > 0 || isDiscounted(product.priceData) || isDiscounted(target.data)
  };
}

function plan(item, state, site, now) {
  if (item?.sourceEvidence?.pricingStatus !== "matched" ||
      !["valid", "has-map-not-true"].includes(item?.sourceEvidence?.mapStatus) ||
      (item.sourceEvidence.mapStatus === "valid" && !(typeof item.map === "number" && Number.isFinite(item.map) && item.map > 0)) ||
      (item.sourceEvidence.mapStatus === "has-map-not-true" && item.map != null)) {
    return { action: "hold", reason: "unverified-supplier-pricing" };
  }
  if (!state) return { action: "hold", reason: "missing-product-price-state" };
  return planCommercePrice({
    supplier: { id: item.itemId, brand: item.brand, active: item.active, canPurchase: item.canPurchase,
      currency: item.currency, map: item.map, msrp: item.msrp, purchaseCost: item.cost },
    existing: { price: state.price, currency: state.currency, visible: state.visible, manualDiscount: state.manualDiscount },
    allowPriceDecrease: false,
    expectedCurrency: site?.currency ?? "USD",
    now
  });
}

/**
 * Update matched existing products only. No promotions are inferred from dealer
 * cost. `products` must include loaded variants; `items` is private normalized
 * supplier data. `client` implements getProduct, updateProduct, updateVariants;
 * writes must have transport retries disabled (WixCommerceClient does this).
 *
 * Return/progress values contain aggregate counts and fixed reason codes only.
 * Product IDs, SKUs, prices, costs, remote bodies and errors are never emitted.
 * runtime.sleep is an optional deterministic-test seam, not a write retry hook.
 */
export async function updateSitePrices({ site, client, products, items, apply = false,
  maxUpdates = 10, onProgress = async () => {}, now = Date.now(), runtime = { sleep: pause } } = {}) {
  if (!Array.isArray(products) || !Array.isArray(items)) throw new TypeError("Products and supplier items must be arrays.");
  if (!Number.isSafeInteger(maxUpdates) || maxUpdates < 0) throw new RangeError("maxUpdates must be a non-negative safe integer.");
  if (typeof apply !== "boolean" || typeof runtime.sleep !== "function") throw new TypeError("Invalid price update options.");
  const result = {
    productsScanned: 0, hiddenProducts: 0, matchedTargets: 0, proposedPriceRaises: 0,
    proposedSkuRecoveries: 0, potentialReductions: 0, unchanged: 0, held: 0, conflicts: 0,
    writeAttempts: 0, applied: 0, pricesUpdated: 0, skusRecovered: 0, variantsUpdated: 0,
    unverifiedWrites: 0, errors: 0, capDeferred: 0, stoppedAuthorization: 0, stoppedErrorLimit: 0,
    byReason: {}
  };
  const index = buildSupplierMatchIndex(items);
  const itemById = new Map(items.map((item) => [String(item.itemId), item]));
  const handled = new Set();
  let stopped = false;
  const progress = () => onProgress({ ...result, byReason: { ...result.byReason } });
  function hold(reason) {
    result.held += 1;
    result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
  }
  function recordError(error) {
    result.errors += 1;
    const status = Number(error?.status);
    if (status === 401 || status === 403) {
      result.stoppedAuthorization = 1;
      stopped = true;
    }
    if (result.errors >= 3) {
      result.stoppedErrorLimit = 1;
      stopped = true;
    }
  }
  async function read(productId) {
    const response = await client.getProduct(productId);
    if (!response?.product || String(response.product.id) !== productId) throw new Error("Invalid product verification response.");
    return response.product;
  }
  async function verify(target, expectedPrice, expectedSku) {
    for (const delay of [0, 1000, 2000, 4000, 8000]) {
      if (stopped) break;
      if (delay) await runtime.sleep(delay);
      try {
        const actual = snapshot(await read(target.productId), target.variantId);
        if (actual && cents(actual.price) === cents(expectedPrice) && actual.sku === expectedSku) return true;
      } catch (error) { recordError(error); }
    }
    return false;
  }

  for (const product of products) {
    if (stopped) break;
    result.productsScanned += 1;
    if (product.visible === false) {
      result.hiddenProducts += 1;
      hold("hidden-product");
      continue;
    }
    const matches = resolveCatalogProduct(product, index);
    if (!matches.targets.length && !matches.holds.length) hold(matches.reason ?? "unresolved-identity");
    for (const held of matches.holds) hold(held.reason);
    for (const target of matches.targets) {
      if (stopped) break;
      const key = `${target.productId}\0${target.variantId ?? "parent"}`;
      if (handled.has(key)) { hold("duplicate-target-in-snapshot"); continue; }
      handled.add(key);
      result.matchedTargets += 1;
      const item = itemById.get(target.supplierItemId);
      const before = snapshot(product, target.variantId);
      const decision = plan(item, before, site, now);
      if (decision.action === "hold") { hold(decision.reason); continue; }
      if (decision.reason === "price-decrease-not-authorized") result.potentialReductions += 1;
      const priceChange = decision.action === "update";
      const recoverSku = target.variantId === null && target.needsSku;
      if (recoverSku && (typeof item.sku !== "string" || !item.sku.trim() || item.sku.length > 40)) {
        hold("invalid-supplier-sku-for-recovery");
        continue;
      }
      if (priceChange) result.proposedPriceRaises += 1;
      if (recoverSku) result.proposedSkuRecoveries += 1;
      if (!priceChange && !recoverSku) { result.unchanged += 1; continue; }
      if (!apply) continue;
      if (result.writeAttempts >= maxUpdates) { result.capDeferred += 1; continue; }

      let fresh;
      try { fresh = await read(target.productId); }
      catch (error) { recordError(error); await progress(); continue; }
      const rematched = resolveCatalogProduct(fresh, index).targets.some((candidate) =>
        candidate.productId === target.productId && candidate.variantId === target.variantId &&
        candidate.supplierItemId === target.supplierItemId);
      const current = snapshot(fresh, target.variantId);
      if (!rematched || JSON.stringify(current) !== JSON.stringify(before)) {
        result.conflicts += 1;
        hold("human-edit-conflict");
        continue;
      }
      const refreshedDecision = plan(item, current, site, now);
      if (refreshedDecision.action === "hold") { hold(refreshedDecision.reason); continue; }

      result.writeAttempts += 1;
      let writeFailed = false;
      try {
        if (target.variantId !== null) {
          await client.updateVariants(target.productId, [{ variantIds: [target.variantId], price: refreshedDecision.price }]);
        } else {
          const patch = {};
          if (priceChange) patch.priceData = { price: refreshedDecision.price };
          if (recoverSku) patch.sku = item.sku;
          await client.updateProduct(target.productId, patch);
        }
      } catch (error) {
        writeFailed = true;
        recordError(error);
      }
      const expectedPrice = priceChange ? refreshedDecision.price : current.price;
      const expectedSku = recoverSku ? item.sku : current.sku;
      const verified = !stopped && await verify(target, expectedPrice, expectedSku);
      if (verified) {
        result.applied += 1;
        if (priceChange) result.pricesUpdated += 1;
        if (recoverSku) result.skusRecovered += 1;
        if (target.variantId !== null) result.variantsUpdated += 1;
      } else {
        result.unverifiedWrites += 1;
        if (!writeFailed && !stopped) recordError(null);
      }
      await progress();
    }
    if (result.productsScanned % 100 === 0) await progress();
  }
  await progress();
  return result;
}
