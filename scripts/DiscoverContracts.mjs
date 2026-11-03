import { mkdir, writeFile } from "node:fs/promises";
import { Turn14Client } from "../src/turn14/client.js";
import { requiredEnv } from "../src/lib/env.js";

// Bounded, read-only schema probes on the supplier host. No order, quote,
// customer, or account endpoints are used. Unknown contracts never cause writes.
const client = new Turn14Client({
  clientId: requiredEnv("TURN14_CLIENT_ID"),
  clientSecret: requiredEnv("TURN14_CLIENT_SECRET"),
  baseUrl: "https://api.turn14.com",
  httpRuntime: { retries: 1, timeoutMs: 30000 }
});
const itemId = "21466"; // Mishimoto MMRAD-SUP-93TX from the actual supplier feed.
const paths = [
  `/v1/items/data/${itemId}`,
  `/v1/items/fitment/${itemId}`,
  `/v1/items/data/brand/45?page=1`,
  `/v1/items/fitment/brand/45?page=1`,
  "/v1/vehicles?page=1"
];
function schema(value, path = "", output = {}) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  output[path || "root"] = [...new Set([...(output[path || "root"] ?? []), type])];
  if (Array.isArray(value)) value.slice(0, 10).forEach((v) => schema(v, `${path}[]`, output));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) schema(v, path ? `${path}.${key}` : key, output);
  }
  return output;
}
const results = [];
for (const path of paths) {
  try {
    const data = await client.get(path);
    results.push({
      path, status: 200, schema: schema(data),
      returnedIds: Array.isArray(data?.data) ? data.data.slice(0, 3).map((entry) => String(entry.id)) : undefined,
      sampleCount: Array.isArray(data?.data) ? data.data.length : undefined,
      totalPages: data?.meta?.total_pages
    });
  } catch (error) {
    results.push({ path, status: Number.isInteger(error?.status) ? error.status : null });
    if ([401, 403].includes(error?.status)) break;
  }
}
await mkdir("reports/discovery", { recursive: true });
await writeFile("reports/discovery/Contracts.json", JSON.stringify({
  generatedAt: new Date().toISOString(), readOnly: true,
  disclosure: "Schema keys and types, item IDs and aggregate pagination metadata only. No product descriptions, media URLs, fitment values, vehicle attributes, credentials, costs, inventory quantities, customer data or raw errors.",
  results
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ schemaProbes: results.map(({ path, status }) => ({ path, status })) }));
