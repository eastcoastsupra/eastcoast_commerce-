/** Text helpers only. Source descriptions are data, never executable HTML. */
export function plainText(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"').replace(/&#(?:39|x27);/giu, "'")
    .replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export function shortenWords(value, maximum) {
  const text = plainText(value);
  if (text.length <= maximum) return text;
  const prefix = text.slice(0, maximum - 1);
  const split = prefix.lastIndexOf(" ");
  return `${split > maximum * 0.6 ? prefix.slice(0, split) : prefix}…`;
}

/** Uses only the existing/verified product name and site identity. It does not
 * claim a fitment, availability, discount, delivery date, or performance gain. */
export function productSeo(product, site) {
  const name = plainText(product.name);
  const shop = plainText(site.name);
  if (!name || !shop) throw new Error("Product and store names are required for SEO");
  const suffix = ` | ${shop}`;
  const title = `${shortenWords(name, 90 - suffix.length)}${suffix}`;
  const ending = ` at ${shop}. View product details and specifications.`;
  const description = `Shop ${shortenWords(name, 160 - 5 - ending.length)}${ending}`;
  return { title, description };
}

/** Long source names remain intact in the description. Preserve the complete
 * manufacturer part number in the short catalog name to distinguish products. */
export function supplierProductName(description, manufacturerPartNumber) {
  const name = plainText(description);
  const mpn = plainText(manufacturerPartNumber);
  if (!name || !mpn) throw new Error("Supplier description and MPN are required");
  if (name.length <= 80) return name;
  if (mpn.length > 36) throw new Error("MPN is too long for a distinct product name");
  const suffix = ` | ${mpn}`;
  return `${shortenWords(name, 80 - suffix.length)}${suffix}`;
}
