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

const publicDocumentationUrls = [
  "https://turn14.com/api_settings.php",
  "https://www.turn14.com/options.php"
];
const publicBodyByteLimit = 256 * 1024;

function documentationUrl(value, baseUrl) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.replace(/&amp;/giu, "&"), baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!/(?:docs?|documentation|openapi|swagger|redoc|developer|api[-_]*(?:reference|usage|policy))/iu.test(url.pathname)) return null;
    if (/(?:login|signin|sign-in|credentials|account|api_settings|options\.php)/iu.test(url.pathname)) return null;
    // Public page references are useful; query/fragment values are unnecessary.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}

async function boundedPublicText(response) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = publicBodyByteLimit - bytes;
      if (chunk.value.byteLength > remaining) {
        text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
      bytes += chunk.value.byteLength;
    }
    text += decoder.decode();
    return { text, truncated };
  } finally { reader.releaseLock(); }
}

function plainPublicText(value) {
  return value.replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ").trim();
}

async function probePublicDocumentation(url) {
  // These are exactly two unauthenticated public GETs, never portal-session
  // reads. Do not add credentials, cookies, redirects, retries, or form values.
  try {
    const response = await fetch(url, {
      method: "GET", redirect: "manual", credentials: "omit",
      headers: { accept: "text/html, application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const contentType = (response.headers.get("content-type") ?? "").slice(0, 100);
    const location = documentationUrl(response.headers.get("location"), url);
    const links = location ? [{ source: "location", url: location }] : [];
    const { text, truncated } = await boundedPublicText(response);
    // Remove form, script and style bodies before extracting references or prose.
    // Script src references are inspected separately, without script contents.
    const withoutForms = text.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/giu, "")
      .replace(/<(?:input|textarea|select)\b[^>]*>(?:[\s\S]*?<\/(?:textarea|select)\s*>)?/giu, "");
    const scriptSources = [...withoutForms.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)];
    const prose = withoutForms.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/giu, "");
    const references = [
      ...[...prose.matchAll(/\b(href|src)\s*=\s*["']([^"']+)["']/giu)].map((match) => ({ source: match[1].toLowerCase(), value: match[2] })),
      ...scriptSources.map((match) => ({ source: "src", value: match[1] }))
    ];
    for (const reference of references) {
      const target = documentationUrl(reference.value, url);
      if (target && !links.some((link) => link.url === target)) links.push({ source: reference.source, url: target });
      if (links.length >= 30) break;
    }
    const headings = [...prose.matchAll(/<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)\s*>/giu)]
      .map((match) => plainPublicText(match[1])).join(" ");
    const documentationHeading = /\bAPI\b/iu.test(headings) && /\b(?:documentation|reference|specification|usage policy)\b/iu.test(headings);
    const accountContent = /<(?:form|input|textarea|select)\b|\b(?:sign\s?in|log\s?in|sign\s?out|log\s?out|welcome back|my account|account settings|API credentials)\b/iu.test(text);
    const recognizedPublicDocument = response.status === 200 && !truncated && documentationHeading && !accountContent;
    const paragraphs = [];
    if (recognizedPublicDocument) {
      for (const match of prose.matchAll(/<(p|li|tr|dd)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu)) {
        const paragraph = plainPublicText(match[2]);
        if (paragraph.length > 1500 || /(?:client.?secret|password|authorization|bearer|api.?key|access.?token|purchase.?cost|wholesale|dealer.?price|account.?number)/iu.test(paragraph)) continue;
        const weightUnit = /\b(?:weight|mass|dimension)\b/iu.test(paragraph) && /\b(?:pounds?|lbs?|kilograms?|kg|grams?|ounces?|oz|inches|centimeters?|cm)\b/iu.test(paragraph);
        const rateLimit = /\brate[\s-]*limits?\b|\b(?:requests?|calls?)\b.{0,100}\b(?:second|minute|hour|day)\b/iu.test(paragraph);
        if ((weightUnit || rateLimit) && !paragraphs.includes(paragraph)) paragraphs.push(paragraph);
        if (paragraphs.length === 10) break;
      }
    }
    return {
      url, status: response.status, contentType, redirectObserved: response.status >= 300 && response.status < 400,
      links, bodyTruncated: truncated, recognizedPublicDocument, paragraphs
    };
  } catch { return { url, status: null, links: [], recognizedPublicDocument: false, paragraphs: [] }; }
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
const publicDocumentation = [];
for (const url of publicDocumentationUrls) publicDocumentation.push(await probePublicDocumentation(url));
await mkdir("reports/discovery", { recursive: true });
await writeFile("reports/discovery/Contracts.json", JSON.stringify({
  generatedAt: new Date().toISOString(), readOnly: true,
  disclosure: "Supplier responses: schema keys and types, item IDs and aggregate pagination metadata only. Public unauthenticated portal probes: status, documentation-looking links, and unit/rate paragraphs only when an API documentation page is clearly identified without account content. No product descriptions, media URLs, fitment values, vehicle attributes, credentials, costs, inventory quantities, form values, customer data or raw errors.",
  results, publicDocumentation
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ schemaProbes: results.map(({ path, status }) => ({ path, status })) }));
