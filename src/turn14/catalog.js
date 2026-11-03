import { mapWithConcurrency } from "../lib/concurrency.js";
import { normalizeText } from "../lib/normalize.js";

function pageNumbers(totalPages) {
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}

async function fetchAllPages(client, pathBuilder, concurrency) {
  const first = await client.get(pathBuilder(1));
  const totalPages = Number(first?.meta?.total_pages ?? 1);
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error("Turn 14 response has an invalid meta.total_pages value.");
  }

  if (totalPages === 1) {
    return Array.isArray(first.data) ? first.data : [];
  }

  const remaining = await mapWithConcurrency(
    pageNumbers(totalPages).slice(1),
    concurrency,
    (page) => client.get(pathBuilder(page))
  );

  return [first, ...remaining].flatMap((response) =>
    Array.isArray(response?.data) ? response.data : []
  );
}

export async function findBrand(client, brandName) {
  const response = await client.get("/v1/brands");
  const requested = normalizeText(brandName);
  const matches = (response?.data ?? []).filter(
    (brand) => normalizeText(brand?.attributes?.name) === requested
  );

  if (matches.length === 0) {
    throw new Error(`Turn 14 brand not found: ${brandName}`);
  }
  if (matches.length > 1) {
    throw new Error(`Turn 14 returned multiple exact matches for brand: ${brandName}`);
  }

  return matches[0];
}

export async function fetchBrandCatalog(client, brandName, concurrency = 4) {
  const brand = await findBrand(client, brandName);
  const brandId = String(brand.id);

  const [items, prices] = await Promise.all([
    fetchAllPages(
      client,
      (page) => `/v1/items/brand/${encodeURIComponent(brandId)}?page=${page}`,
      concurrency
    ),
    fetchAllPages(
      client,
      (page) => `/v1/pricing/brand/${encodeURIComponent(brandId)}?page=${page}`,
      concurrency
    )
  ]);

  const pricingByItemId = new Map(prices.map((entry) => [String(entry.id), entry]));
  return {
    brand: {
      id: brandId,
      name: brand.attributes.name
    },
    items: items.map((item) => ({
      ...item,
      pricing: pricingByItemId.get(String(item.id)) ?? null
    })),
    counts: {
      items: items.length,
      prices: prices.length,
      joined: items.filter((item) => pricingByItemId.has(String(item.id))).length
    }
  };
}
