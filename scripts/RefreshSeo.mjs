import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITES } from "../src/config/sites.js";
import { requiredEnv } from "../src/lib/env.js";
import { productSeo } from "../src/sync/content.js";
import { WixCommerceClient, mergeSeoData } from "../src/wix/commerce.js";

const OUTPUT_FILE = resolve("reports/seo/Summary.json");
const MAX_SITE_ERRORS = 3;
let stage = "configuration";
let aggregateReport;

export function parseOptions(args) {
  let apply = false;
  let maxUpdates = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--max-updates" || argument.startsWith("--max-updates=")) {
      const raw = argument === "--max-updates" ? args[++index] : argument.slice("--max-updates=".length);
      if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) throw new Error("Invalid update cap");
      maxUpdates = Number(raw);
      if (!Number.isSafeInteger(maxUpdates)) throw new Error("Unsafe update cap");
    } else throw new Error("Unknown argument");
  }
  if (apply && maxUpdates === null) throw new Error("Apply requires an explicit update cap");
  return { apply, maxUpdates };
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function identityReplacer(site) {
  const other = Object.values(SITES).find((entry) => entry.key !== site.key);
  if (!other) throw new Error("Unknown site identity");
  const name = new RegExp(`\\b${other.name.split(/\s+/u).map(escapedRegExp).join("\\s+")}\\b`, "giu");
  const domain = new RegExp(`(?<![a-z0-9-])${escapedRegExp(other.domain)}(?![a-z0-9.-])`, "giu");
  return (value) => typeof value === "string"
    ? value.replace(name, site.name).replace(domain, site.domain)
    : value;
}

function tagKind(tag) {
  const type = String(tag?.type ?? "").toLowerCase();
  if (type === "title") return "title";
  if (type === "meta" && String(tag.props?.name ?? "").toLowerCase() === "description") return "description";
  return null;
}

function tagText(tag) {
  return tagKind(tag) === "title" ? tag.children : tag.props?.content;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function correctIdentity(seoData, site) {
  const corrected = structuredClone(seoData ?? {});
  if (!corrected || typeof corrected !== "object" || Array.isArray(corrected)) throw new Error("Invalid SEO data");
  if (corrected.tags !== undefined && !Array.isArray(corrected.tags)) throw new Error("Invalid SEO tags");
  const replace = identityReplacer(site);
  let correctedTags = 0;
  for (const tag of corrected.tags ?? []) {
    if (!tag || typeof tag !== "object" || Array.isArray(tag)) throw new Error("Invalid SEO tag");
    if (tag.disabled === true) continue;
    // Identity corrections are limited to the two requested standard tags.
    // Canonical, hreflang, social, structured data, and all other tags survive
    // byte-for-byte, even if they contain a different store's identity.
    const kind = tagKind(tag);
    if (kind === null) continue;
    let changed = false;
    if (kind === "title" && typeof tag.children === "string") {
      const next = replace(tag.children);
      changed ||= next !== tag.children;
      tag.children = next;
    }
    if (kind === "description" && typeof tag.props?.content === "string") {
      const next = replace(tag.props.content);
      changed ||= next !== tag.props.content;
      tag.props.content = next;
    }
    if (changed) correctedTags += 1;
  }
  return { seoData: corrected, correctedTags };
}

/** No product identity or SEO text returned by this function is serialized by
 * the runner. Plans and the complete catalog remain in memory only. */
export function planSeoChange(product, site) {
  const original = product.seoData ?? {};
  const { seoData: corrected, correctedTags } = correctIdentity(original, site);
  const tags = corrected.tags ?? [];
  const state = (kind) => {
    const matching = tags.filter((tag) => tagKind(tag) === kind);
    return {
      nonempty: matching.some((tag) => nonempty(tagText(tag))),
      disabled: matching.some((tag) => tag.disabled === true)
    };
  };
  const title = state("title");
  const description = state("description");
  // An explicitly disabled tag is an existing merchant choice. Do not enable
  // it or add another tag that defeats the disablement.
  const fillTitle = !title.nonempty && !title.disabled;
  const fillDescription = !description.nonempty && !description.disabled;
  const replacements = {};
  if (fillTitle || fillDescription) {
    const generated = productSeo(product, site);
    if (fillTitle) replacements.title = generated.title;
    if (fillDescription) replacements.description = generated.description;
  }
  const seoData = mergeSeoData(corrected, replacements);
  return {
    changed: JSON.stringify(original) !== JSON.stringify(seoData),
    seoData, fillTitle, fillDescription,
    correctIdentity: correctedTags > 0,
    existingTitle: title.nonempty,
    existingDescription: description.nonempty
  };
}

function titleDescriptionSignature(seoData) {
  return JSON.stringify((Array.isArray(seoData?.tags) ? seoData.tags : [])
    .filter((tag) => tagKind(tag) !== null)
    .map((tag) => [tagKind(tag), tagText(tag) ?? null, tag.disabled === true])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function counts() {
  return {
    allProducts: 0, visibleProducts: 0, hiddenOrUnconfirmedProducts: 0,
    processedProducts: 0, unchangedProducts: 0, visibilityChangedProducts: 0,
    existingNonemptyTitles: 0, existingNonemptyDescriptions: 0,
    plannedUpdates: 0, plannedTitleFills: 0, plannedDescriptionFills: 0, plannedIdentityCorrections: 0,
    attemptedUpdates: 0, appliedUpdates: 0, verifiedUpdates: 0,
    appliedTitleFills: 0, appliedDescriptionFills: 0, appliedIdentityCorrections: 0,
    readErrors: 0, writeErrors: 0, verificationErrors: 0,
    errors: 0, http401Errors: 0, http403Errors: 0, otherErrors: 0,
    unprocessedVisibleProducts: 0
  };
}

function totals(report) {
  const result = counts();
  for (const site of report.sites) {
    for (const key of Object.keys(result)) result[key] += site.counts[key];
  }
  return result;
}

function recordError(context, error, category) {
  const count = context.summary.counts;
  count.errors += 1;
  count[category] += 1;
  if (error?.status === 401) count.http401Errors += 1;
  else if (error?.status === 403) count.http403Errors += 1;
  else count.otherErrors += 1;
  if (error?.status === 401 || error?.status === 403) context.stopped = "authorization";
  else if (count.errors >= MAX_SITE_ERRORS) context.stopped = "error-limit";
}

async function saveReport(report) {
  report.totals = totals(report);
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function processNext(context, options) {
  const snapshot = context.products[context.offset++];
  const count = context.summary.counts;
  count.processedProducts += 1;
  count.unprocessedVisibleProducts = context.products.length - context.offset;
  let current;
  let plan;
  stage = "read-current-product";
  try {
    // A fresh merchant-specific read immediately precedes every patch. It is
    // never copied to logs/artifacts and the write contains only seoData.
    current = (await context.client.getProduct(snapshot.id))?.product;
    if (!current || current.id !== snapshot.id) throw new Error("Unexpected product response");
    if (current.visible !== true) {
      count.visibilityChangedProducts += 1;
      return;
    }
    plan = planSeoChange(current, context.site);
    if (plan.existingTitle) count.existingNonemptyTitles += 1;
    if (plan.existingDescription) count.existingNonemptyDescriptions += 1;
  } catch (error) {
    recordError(context, error, "readErrors");
    return;
  }
  if (!plan.changed) {
    count.unchangedProducts += 1;
    return;
  }
  count.plannedUpdates += 1;
  if (plan.fillTitle) count.plannedTitleFills += 1;
  if (plan.fillDescription) count.plannedDescriptionFills += 1;
  if (plan.correctIdentity) count.plannedIdentityCorrections += 1;
  if (!options.apply) return;

  stage = "write-seo";
  count.attemptedUpdates += 1; // The global cap includes failed/uncertain writes.
  try {
    await context.client.updateProduct(current.id, { seoData: plan.seoData });
    count.appliedUpdates += 1;
    if (plan.fillTitle) count.appliedTitleFills += 1;
    if (plan.fillDescription) count.appliedDescriptionFills += 1;
    if (plan.correctIdentity) count.appliedIdentityCorrections += 1;
  } catch (error) {
    recordError(context, error, "writeErrors");
    return; // No automatic retries, including ambiguous transport failures.
  }

  stage = "verify-seo";
  try {
    const readback = (await context.client.getProduct(current.id))?.product;
    if (!readback || readback.id !== current.id ||
      titleDescriptionSignature(readback.seoData) !== titleDescriptionSignature(plan.seoData) ||
      correctIdentity(readback.seoData, context.site).correctedTags !== 0) {
      throw new Error("SEO readback did not match the intended tags");
    }
    count.verifiedUpdates += 1;
  } catch (error) {
    recordError(context, error, "verificationErrors");
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const apiKey = requiredEnv("WIX_API_KEY");
  const report = {
    generatedAt: new Date().toISOString(), mode: options.apply ? "apply" : "dry-run",
    maxUpdates: options.maxUpdates, status: "running", sites: [], totals: counts()
  };
  aggregateReport = report;
  const contexts = [];
  for (const site of Object.values(SITES)) {
    const summary = { site: site.key, status: "running", counts: counts() };
    report.sites.push(summary);
    const context = {
      site, summary, products: [], offset: 0, stopped: null,
      client: new WixCommerceClient({ apiKey, siteId: site.siteId,
        httpRuntime: { timeoutMs: 30000, retries: 3, retryBaseMs: 1000 } })
    };
    contexts.push(context);
    stage = "query-catalog";
    try {
      const all = await context.client.queryAllProducts({ includeHiddenProducts: true, includeVariants: true });
      context.products = all.filter((product) => product.visible === true);
      summary.counts.allProducts = all.length;
      summary.counts.visibleProducts = context.products.length;
      summary.counts.hiddenOrUnconfirmedProducts = all.length - context.products.length;
      summary.counts.unprocessedVisibleProducts = context.products.length;
    } catch (error) {
      recordError(context, error, "readErrors");
      context.stopped ??= "catalog-read-failed";
    }
  }

  // One product per site per pass keeps a two-update canary spread across both
  // sites when both need edits. Network operations remain strictly sequential.
  let lastCheckpoint = 0;
  while (contexts.some((context) => !context.stopped && context.offset < context.products.length)) {
    if (options.apply && totals(report).attemptedUpdates >= options.maxUpdates) break;
    for (const context of contexts) {
      if (context.stopped || context.offset >= context.products.length) continue;
      if (options.apply && totals(report).attemptedUpdates >= options.maxUpdates) break;
      await processNext(context, options);
      const total = totals(report);
      if (total.processedProducts - lastCheckpoint >= 50) {
        lastCheckpoint = total.processedProducts;
        await saveReport(report);
        console.log(JSON.stringify({ status: "progress", counts: total }));
      }
    }
  }
  const total = totals(report);
  for (const context of contexts) {
    context.summary.status = context.stopped ? "stopped" :
      context.offset < context.products.length ? "capped" : context.summary.counts.errors ? "partial" : "complete";
    if (context.stopped) context.summary.stopReason = context.stopped;
  }
  report.status = total.errors ? "partial" : report.sites.some((site) => site.status === "capped") ? "capped" : "complete";
  report.completedAt = new Date().toISOString();
  stage = "write-summary";
  await saveReport(report);
  for (const site of report.sites) console.log(JSON.stringify(site));
  console.log(JSON.stringify({ status: report.status, counts: report.totals }));
  if (report.totals.errors) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const failure = { status: "failed", stage, httpStatus: Number.isInteger(error?.status) ? error.status : null };
    const report = aggregateReport ?? { generatedAt: new Date().toISOString(), sites: [], totals: counts() };
    report.status = "failed";
    report.failure = failure;
    await saveReport(report).catch(() => {});
    console.error(JSON.stringify({ ...failure, counts: report.totals }));
    process.exitCode = 1;
  });
}
