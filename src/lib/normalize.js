export function normalizeIdentifier(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]/gu, "")
    .toUpperCase();
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/gu, " ")
    .trim()
    .toLowerCase();
}

export function brandMatches(product, requestedBrand) {
  const requested = normalizeText(requestedBrand);
  const productBrand = normalizeText(product.brand);
  const productName = normalizeText(product.name);

  return productBrand === requested || productName.includes(requested);
}

export function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
