import { Turn14Client } from "../src/turn14/client.js";
import { requiredEnv } from "../src/lib/env.js";
import { normalizeItemContent } from "../src/turn14/content.js";

// Single read-only supplier probe. Only fixed counters leave this process.
// No source text, media URLs, identifiers, prices, raw responses or errors.
const client = new Turn14Client({
  clientId: requiredEnv("TURN14_CLIENT_ID"),
  clientSecret: requiredEnv("TURN14_CLIENT_SECRET"),
  baseUrl: "https://api.turn14.com",
  httpRuntime: { retries: 1, timeoutMs: 30000 }
});
const item = { itemId: "21466" };
const report = {
  readOnly: true, matchedRecords: 0, files: 0,
  stringIds: 0, numericIds: 0, otherIds: 0,
  exactImageType: 0, imageMimeType: 0, otherType: 0,
  supportedImageExtensions: 0, unsupportedExtensions: 0,
  filesWithLinkArray: 0, links: 0, httpsLinks: 0, httpLinks: 0,
  positiveIntegerDimensions: 0, missingDimensions: 0, otherDimensions: 0,
  acceptedImages: 0
};
const positive = (v) => (typeof v === "number" || (typeof v === "string" && /^\d+$/u.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
try {
  const response = await client.get(`/v1/items/data/${item.itemId}`);
  const records = Array.isArray(response?.data) ? response.data.filter(r => r?.id === item.itemId) : [];
  report.matchedRecords = records.length;
  for (const record of records) {
    for (const file of Array.isArray(record.files) ? record.files : []) {
      report.files += 1;
      if (typeof file?.id === "string") report.stringIds += 1;
      else if (typeof file?.id === "number") report.numericIds += 1;
      else report.otherIds += 1;
      const type = typeof file?.type === "string" ? file.type.trim().toLowerCase() : "";
      if (type === "image") report.exactImageType += 1;
      else if (/^image\/[a-z0-9.+-]+$/u.test(type)) report.imageMimeType += 1;
      else report.otherType += 1;
      const ext = typeof file?.file_extension === "string" ? file.file_extension.trim().replace(/^\./u, "").toLowerCase() : "";
      if (["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff"].includes(ext)) report.supportedImageExtensions += 1;
      else report.unsupportedExtensions += 1;
      if (Array.isArray(file?.links)) report.filesWithLinkArray += 1;
      for (const link of Array.isArray(file?.links) ? file.links : []) {
        report.links += 1;
        if (typeof link?.url === "string" && /^https:\/\//iu.test(link.url)) report.httpsLinks += 1;
        else if (typeof link?.url === "string" && /^http:\/\//iu.test(link.url)) report.httpLinks += 1;
        if (positive(link?.width) && positive(link?.height)) report.positiveIntegerDimensions += 1;
        else if (link?.width == null || link?.height == null) report.missingDimensions += 1;
        else report.otherDimensions += 1;
      }
    }
  }
  report.acceptedImages = normalizeItemContent(response, item).images.length;
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(JSON.stringify({ readOnly: true, failed: true, httpStatus: Number.isInteger(error?.status) ? error.status : null }));
  process.exitCode = 1;
}
