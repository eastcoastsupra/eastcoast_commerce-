import assert from "node:assert/strict";
import test from "node:test";
import { normalizeItemContent, normalizeItemFitment, readItemContent, readItemFitment } from "../src/turn14/content.js";

const item = { itemId: "21466" };
const file = (id = "image-1", extra = {}) => ({
  id, type: "Image", file_extension: "JPG", media_content: "supplier-value", generic: false,
  links: [
    { url: `https://cdn.example.com/${id}-small.jpg`, width: "200", height: "200", size: "10000" },
    { url: `https://cdn.example.com/${id}-large.jpg`, width: "1200", height: "800", size: "99999" }
  ], ...extra
});
const content = (extra = {}) => ({ data: [{
  id: "21466", files: [file()], descriptions: [{ type: "unknown-vendor-type", description: "Complete supplier description." }],
  relationships: { vehicle_fitments: { links: { self: "https://api.turn14.com/v1/items/fitment/21466" } } }, ...extra
}] });
const fitment = () => ({ data: { id: "21466", attributes: { vehicle_ids: ["100", "101"], late_models_only: false } } });

test("content prefers known resolution but accepts explicit HTTPS image URLs with unknown optional pixel metadata", () => {
  const result = normalizeItemContent(content({ files: [
    file("one", { type: "iMaGe", file_extension: ".jPg" }),
    file("video", { type: "Video", file_extension: "MP4" }),
    file("pdf", { file_extension: "PDF" }),
    file("insecure", { links: [{ url: "http://cdn.example.com/image.jpg", width: "4000", height: "4000" }] }),
    file("invalid-size", { links: [{ url: "https://cdn.example.com/image.jpg", width: "unknown", height: "4000" }] })
  ] }), item);
  assert.equal(result.known, true);
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].url, "https://cdn.example.com/one-large.jpg");
  assert.equal(result.images[0].width, 1200);
  assert.equal(result.images[0].mediaContent, "supplier-value");
  assert.equal(result.images[1].url, "https://cdn.example.com/image.jpg");
  assert.equal(result.images[1].width, null);
  assert.equal(result.fitmentPath, "/v1/items/fitment/21466");
});

test("unknown image dimensions never invent pixels or relax URL and file-type checks", () => {
  const result = normalizeItemContent(content({ files: [
    file("unknown", { links: [{ url: "https://cdn.example.com/unknown.jpg" }] }),
    file("zero", { links: [{ url: "https://cdn.example.com/zero.jpg", width: "0", height: "0" }] }),
    file("unsafe", { links: [{ url: "javascript:alert(1)" }, { url: "file:///private" }, { url: "https://user:pass@cdn.example.com/x.jpg" }] }),
    file("pdf", { type: "Document", file_extension: "pdf", links: [{ url: "https://cdn.example.com/x.pdf" }] })
  ] }), item);
  assert.equal(result.images.length, 2);
  assert.ok(result.images.every(image => image.width === null && image.height === null));
});

test("known resolution wins over unknown metadata without generating or rewriting URLs", () => {
  const result = normalizeItemContent(content({ files: [file("one", { links: [
    { url: "https://cdn.example.com/unknown.jpg", width: "unknown", height: "unknown" },
    { url: "https://cdn.example.com/known.jpg", width: "800", height: "600" },
    { url: "https://cdn.example.com/other.jpg", width: "0", height: "0" }
  ] })] }), item);
  assert.equal(result.images[0].url, "https://cdn.example.com/known.jpg");
  assert.equal(result.images[0].width, 800);
});

test("content caps image files at eight and does not substitute generated URLs", () => {
  const result = normalizeItemContent(content({ files: Array.from({ length: 12 }, (_, i) => file(`image-${i}`)) }), item);
  assert.equal(result.images.length, 8);
  assert.ok(result.images.every((image) => image.url.endsWith("-large.jpg")));
  const duplicate = normalizeItemContent(content({ files: [file("one"), file("another", { links: file("one").links })] }), item);
  assert.equal(duplicate.images.length, 1);
});

test("content preserves all source description strings and unknown types without executing markup or assuming enum priority", () => {
  const descriptions = [
    { type: "UNRECOGNIZED", description: "Short description" },
    { type: "another arbitrary type", description: "  <p>A considerably longer complete supplier description.</p>  " },
    { type: "", description: "" }
  ];
  const result = normalizeItemContent(content({ descriptions }), item);
  assert.deepEqual(result.descriptions, descriptions);
  assert.equal(result.description, descriptions[1].description);
});

test("content refuses missing, mismatched, duplicate and invalid item IDs", () => {
  for (const response of [ {}, { data: {} }, { data: [] }, { data: [{ id: "different" }] }, { data: [{ id: 21466 }] }, { data: [...content().data, ...content().data] } ]) {
    const result = normalizeItemContent(response, item);
    assert.equal(result.known, false);
    assert.deepEqual(result.images, []);
  }
});

test("fitment provider links must use exactly the expected HTTPS API host and item path before following", async () => {
  const paths = [];
  const client = { get: async (path) => { paths.push(path); return fitment(); } };
  for (const providerLink of [
    "http://api.turn14.com/v1/items/fitment/21466", "https://evil.example/v1/items/fitment/21466",
    "https://api.turn14.com.evil.example/v1/items/fitment/21466", "https://api.turn14.com/v1/items/fitment/other",
    "https://api.turn14.com/v1/items/fitment/21466?token=secret", "https://user:secret@api.turn14.com/v1/items/fitment/21466",
    "/v1/items/fitment/21466", "https://api.turn14.com/v1/items/fitment/21466#anything"
  ]) {
    assert.equal((await readItemFitment(client, item, { providerLink })).known, false);
    const result = normalizeItemContent(content({ relationships: { vehicle_fitments: { links: { self: providerLink } } } }), item);
    assert.equal(result.fitmentPath, null);
  }
  assert.deepEqual(paths, []);
  assert.equal((await readItemFitment(client, item, { providerLink: "https://api.turn14.com/v1/items/fitment/21466" })).known, true);
  assert.deepEqual(paths, ["/v1/items/fitment/21466"]);
});

test("fitment retains only validated raw vehicle IDs without inferring make, model or year", async () => {
  assert.deepEqual(normalizeItemFitment(fitment(), item), { known: true, itemId: "21466", vehicleIds: ["100", "101"], lateModelsOnly: false, reason: "supplier-vehicle-ids" });
  for (const response of [
    { data: [] }, { data: { id: "wrong" } },
    { data: { id: "21466", attributes: { vehicle_ids: [100], late_models_only: false } } },
    { data: { id: "21466", attributes: { vehicle_ids: ["100"], late_models_only: "false" } } }
  ]) assert.equal(normalizeItemFitment(response, item).known, false);
  const calls = [];
  await readItemFitment({ get: async (path) => { calls.push(path); return fitment(); } }, item);
  assert.deepEqual(calls, ["/v1/items/fitment/21466"]);
});

test("content reader uses the verified item data route and does not disclose raw API errors", async () => {
  const paths = [];
  const result = await readItemContent({ get: async (path) => { paths.push(path); return content(); } }, item);
  assert.equal(result.known, true);
  assert.deepEqual(paths, ["/v1/items/data/21466"]);
  const error = Object.assign(new Error("PRIVATE_SECRET"), { status: 403, body: { private: "PRIVATE_SECRET" } });
  const failure = await readItemContent({ get: async () => { throw error; } }, item);
  assert.equal(failure.reason, "content-unauthorized");
  assert.ok(!JSON.stringify(failure).includes("PRIVATE"));
});
