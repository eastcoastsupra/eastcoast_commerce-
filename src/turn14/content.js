const API_ORIGIN = "https://api.turn14.com";
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;
const unknownContent = (reason) => ({ known: false, images: [], descriptions: [], description: "", fitmentPath: null, reason });
const unknownFitment = (reason) => ({ known: false, vehicleIds: [], lateModelsOnly: null, reason });

function explicitHttpsUrl(value) {
  if (typeof value !== "string" || value.trim() !== value || !/^https:\/\//iu.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function dimension(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function fitmentPathFor(itemId, providerLink) {
  const path = `/v1/items/fitment/${encodeURIComponent(itemId)}`;
  const url = explicitHttpsUrl(providerLink);
  if (!url || url.origin !== API_ORIGIN || url.pathname !== path || url.search || url.hash) return null;
  return path;
}

function imagesFrom(files) {
  const images = [];
  const seenUrls = new Set();
  for (const file of files) {
    if (!object(file) || !identifier(file.id) || typeof file.type !== "string" || typeof file.file_extension !== "string") continue;
    const type = file.type.trim().toLowerCase();
    const extension = file.file_extension.trim().replace(/^\./u, "").toLowerCase();
    if (!(type === "image" || /^image\/[a-z0-9.+-]+$/u.test(type)) || !IMAGE_EXTENSIONS.has(extension) || !Array.isArray(file.links)) continue;
    let largest = null;
    for (const link of file.links) {
      if (!object(link) || !explicitHttpsUrl(link.url)) continue;
      const width = dimension(link.width);
      const height = dimension(link.height);
      const area = width !== null && height !== null ? width * height : null;
      if (!Number.isSafeInteger(area) || area <= 0) continue;
      if (!largest || area > largest.area) largest = { url: link.url, width, height, area };
    }
    if (!largest || seenUrls.has(largest.url)) continue;
    seenUrls.add(largest.url);
    images.push({
      fileId: file.id, url: largest.url, width: largest.width, height: largest.height,
      type: file.type, fileExtension: file.file_extension,
      mediaContent: typeof file.media_content === "string" ? file.media_content : null,
      generic: typeof file.generic === "boolean" ? file.generic : null
    });
    if (images.length === 8) break;
  }
  return images;
}

/** Supplier text remains complete, inert string data. Escape it at any HTML
 * rendering boundary; no supplier markup or scripts are evaluated here.
 * Description type strings are preserved without assuming an enum hierarchy.
 */
export function normalizeItemContent(response, item) {
  if (!identifier(item?.itemId)) return unknownContent("item-id-missing-or-invalid");
  if (!object(response) || !Array.isArray(response.data)) return unknownContent("content-response-invalid");
  if (response.data.some((entry) => !object(entry) || !identifier(entry.id))) return unknownContent("content-record-id-missing-or-invalid");
  const matches = response.data.filter((entry) => entry.id === item.itemId);
  if (matches.length !== 1) return unknownContent(matches.length ? "content-item-ambiguous" : "content-item-missing");
  const record = matches[0];
  if ((record.files !== undefined && !Array.isArray(record.files)) || (record.descriptions !== undefined && !Array.isArray(record.descriptions))) return unknownContent("content-fields-invalid");
  const descriptions = (record.descriptions ?? [])
    .filter((entry) => object(entry) && typeof entry.type === "string" && typeof entry.description === "string")
    .map((entry) => ({ type: entry.type, description: entry.description }));
  // Rank by meaningful text length only, never by an undocumented type value.
  let description = "";
  let longest = 0;
  for (const entry of descriptions) {
    const text = entry.description.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
    if (/[\p{L}\p{N}]/u.test(text) && text.length > longest) {
      longest = text.length;
      description = entry.description;
    }
  }
  const images = imagesFrom(record.files ?? []);
  const providerLink = record.relationships?.vehicle_fitments?.links?.self;
  const fitmentPath = fitmentPathFor(item.itemId, providerLink);
  return {
    known: true, itemId: item.itemId, images, descriptions, description, fitmentPath,
    reason: images.length || descriptions.length ? "content-available" : "content-empty"
  };
}

export async function readItemContent(client, item) {
  if (!identifier(item?.itemId)) return unknownContent("item-id-missing-or-invalid");
  try {
    return normalizeItemContent(await client.get(`/v1/items/data/${encodeURIComponent(item.itemId)}`), item);
  } catch (error) {
    return unknownContent(error?.status === 401 || error?.status === 403 ? "content-unauthorized" : "content-request-failed");
  }
}

export function normalizeItemFitment(response, item) {
  if (!identifier(item?.itemId)) return unknownFitment("item-id-missing-or-invalid");
  const record = response?.data;
  if (!object(record) || record.id !== item.itemId) return unknownFitment("fitment-item-missing-or-invalid");
  const attributes = record.attributes;
  if (!object(attributes) || !Array.isArray(attributes.vehicle_ids) || attributes.vehicle_ids.some((id) => !identifier(id)) || typeof attributes.late_models_only !== "boolean") {
    return unknownFitment("fitment-fields-invalid");
  }
  // These are supplier vehicle IDs. No make/model/year inference is made.
  return { known: true, itemId: item.itemId, vehicleIds: [...new Set(attributes.vehicle_ids)], lateModelsOnly: attributes.late_models_only, reason: "supplier-vehicle-ids" };
}

export async function readItemFitment(client, item, { providerLink } = {}) {
  if (!identifier(item?.itemId)) return unknownFitment("item-id-missing-or-invalid");
  const path = providerLink === undefined
    ? `/v1/items/fitment/${encodeURIComponent(item.itemId)}`
    : fitmentPathFor(item.itemId, providerLink);
  if (!path) return unknownFitment("fitment-provider-link-invalid");
  try { return normalizeItemFitment(await client.get(path), item); }
  catch (error) { return unknownFitment(error?.status === 401 || error?.status === 403 ? "fitment-unauthorized" : "fitment-request-failed"); }
}
