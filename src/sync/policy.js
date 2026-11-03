import { roundCurrency } from "../lib/normalize.js";

function mapPriceFromItem(item) {
  const pricing = item?.pricing?.attributes;
  if (!pricing?.has_map || !Array.isArray(pricing.pricelists)) {
    return null;
  }

  const mapEntry = pricing.pricelists.find(
    (entry) => String(entry?.name ?? "").trim().toLowerCase() === "map"
  );
  const mapPrice = Number(mapEntry?.price);
  return Number.isFinite(mapPrice) && mapPrice > 0 ? roundCurrency(mapPrice) : null;
}

function currentWixPrice(product) {
  const price = Number(product?.priceData?.price ?? product?.price?.price);
  return Number.isFinite(price) ? roundCurrency(price) : null;
}

function hasActiveDiscount(product) {
  const type = String(product?.discount?.type ?? "NONE").toUpperCase();
  const value = Number(product?.discount?.value ?? 0);
  return type !== "NONE" && Number.isFinite(value) && value > 0;
}

function hasVariants(product) {
  return Boolean(product?.manageVariants) ||
    (Array.isArray(product?.variants) && product.variants.length > 0);
}

export function evaluatePriceChange(product, item, options) {
  const currentPrice = currentWixPrice(product);
  const mapPrice = mapPriceFromItem(item);

  if (!item?.attributes?.active) {
    return { action: "skip", reason: "turn14-item-inactive", currentPrice, mapPrice };
  }
  if (!item?.pricing?.attributes?.can_purchase) {
    return { action: "skip", reason: "turn14-item-not-purchasable", currentPrice, mapPrice };
  }
  if (mapPrice === null) {
    return { action: "skip", reason: "turn14-map-unavailable", currentPrice, mapPrice };
  }
  if (currentPrice === null) {
    return { action: "skip", reason: "wix-price-invalid", currentPrice, mapPrice };
  }
  if (hasVariants(product)) {
    return { action: "skip", reason: "wix-product-has-variants", currentPrice, mapPrice };
  }
  if (!options.includeDiscounted && hasActiveDiscount(product)) {
    return { action: "skip", reason: "wix-product-has-active-discount", currentPrice, mapPrice };
  }
  if (!options.includeHidden && product.visible === false) {
    return { action: "skip", reason: "wix-product-hidden", currentPrice, mapPrice };
  }
  if (currentPrice === mapPrice) {
    return { action: "none", reason: "already-at-map", currentPrice, mapPrice };
  }
  if (options.mode === "raise-only" && currentPrice > mapPrice) {
    return { action: "none", reason: "current-price-above-map", currentPrice, mapPrice };
  }
  if (currentPrice > mapPrice && !options.allowPriceDecrease) {
    return { action: "skip", reason: "price-decrease-not-authorized", currentPrice, mapPrice };
  }

  return {
    action: "update",
    reason: currentPrice < mapPrice ? "raise-to-map" : "lower-to-map",
    currentPrice,
    mapPrice,
    delta: roundCurrency(mapPrice - currentPrice)
  };
}
