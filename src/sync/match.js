import { brandMatches, normalizeIdentifier } from "../lib/normalize.js";

const TURN14_IDENTIFIER_FIELDS = Object.freeze([
  "part_number",
  "mfr_part_number",
  "barcode",
  "alternate_part_number"
]);

export function buildTurn14IdentifierIndex(items) {
  const index = new Map();

  for (const item of items) {
    for (const field of TURN14_IDENTIFIER_FIELDS) {
      const normalized = normalizeIdentifier(item?.attributes?.[field]);
      if (!normalized) {
        continue;
      }
      const existing = index.get(normalized) ?? [];
      existing.push({ item, field });
      index.set(normalized, existing);
    }
  }

  return index;
}

export function matchWixProduct(product, requestedBrand, turn14Index) {
  if (!brandMatches(product, requestedBrand)) {
    return { status: "skipped", reason: "not-brand-product" };
  }

  const sku = normalizeIdentifier(product.sku);
  if (!sku) {
    return { status: "skipped", reason: "missing-wix-sku" };
  }

  const candidates = turn14Index.get(sku) ?? [];
  const uniqueItems = new Map(
    candidates.map((candidate) => [String(candidate.item.id), candidate])
  );

  if (uniqueItems.size === 0) {
    return { status: "unmatched", reason: "no-exact-turn14-identifier", sku };
  }
  if (uniqueItems.size > 1) {
    return {
      status: "skipped",
      reason: "ambiguous-turn14-identifier",
      sku,
      candidateItemIds: [...uniqueItems.keys()]
    };
  }

  const candidate = [...uniqueItems.values()][0];
  return {
    status: "matched",
    sku,
    item: candidate.item,
    matchedField: candidate.field
  };
}
