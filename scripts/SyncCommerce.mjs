import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SITES } from "../src/config/sites.js";
import { requiredEnv } from "../src/lib/env.js";
import { Turn14Client } from "../src/turn14/client.js";
import { WixCommerceClient } from "../src/wix/commerce.js";
import { fetchCommerceCatalog } from "../src/turn14/commerceCatalog.js";
import { extractLabelledIdentifiers } from "../src/sync/catalogMatch.js";
import { updateSitePrices } from "../src/sync/updatePrices.js";
import { importSiteProducts } from "../src/sync/importProducts.js";
import { evaluateManufacturerPromotions } from "../src/sync/promotionCheck.js";

const args = process.argv.slice(2);
const options = { apply: false, maxUpdates: 0, maxCreates: 0, brands: undefined };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--apply") options.apply = true;
  else if (arg === "--brands") options.brands = args[++i]?.split(",").map((x) => x.trim()).filter(Boolean);
  else if (arg === "--max-updates" || arg === "--max-creates") {
    const value = args[++i];
    if (!/^\d+$/u.test(value ?? "")) throw new Error("Invalid operation cap");
    const count = Number(value);
    if (!Number.isSafeInteger(count)) throw new Error("Invalid operation cap");
    options[arg === "--max-updates" ? "maxUpdates" : "maxCreates"] = count;
  } else throw new Error("Unknown option");
}
if (options.apply && options.maxUpdates === 0 && options.maxCreates === 0) throw new Error("Apply requires an explicit positive operation cap");

const report = {
  startedAt: new Date().toISOString(), mode: options.apply ? "apply" : "dry-run",
  status: "running", phase: "configuration", supplier: {}, sites: [],
  policy: {
    regularExistingPrices: "raise-only", newPrices: "verified MAP, otherwise manufacturer retail",
    casepacks: "held until selling unit is verified", publicReports: "aggregate counts only",
    manufacturerPromotions: "check current MAP/retail references; require documented consumer terms before a sale",
    catalogSelection: "explicit supplier application text or universal detailing; undecoded vehicle IDs are never inferred"
  }
};
async function checkpoint() {
  await mkdir("reports/commerce", { recursive: true });
  await writeFile("reports/commerce/Summary.json", `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const shipping = JSON.parse(await readFile(new URL("../config/Shipping.json", import.meta.url), "utf8"));
  const promotions = JSON.parse(await readFile(new URL("../config/Promotions.json", import.meta.url), "utf8"));
  const apiKey = requiredEnv("WIX_API_KEY");
  const contexts = [];
  const existingSkus = [];
  for (const site of Object.values(SITES)) {
    const client = new WixCommerceClient({ apiKey, siteId: site.siteId,
      httpRuntime: { timeoutMs: 30000, retries: 3, retryBaseMs: 1000 } });
    report.phase = "read-store-catalogs";
    const products = await client.queryAllProducts({ includeHiddenProducts: true, includeVariants: true });
    for (const product of products) {
      if (product.sku) existingSkus.push(product.sku);
      for (const variant of product.variants ?? []) if (variant.variant?.sku) existingSkus.push(variant.variant.sku);
      for (const identifier of extractLabelledIdentifiers(product.description)) existingSkus.push(identifier.value);
    }
    const summary = { site: site.key, productsBefore: products.length, visibleBefore: products.filter((p) => p.visible === true).length };
    report.sites.push(summary);
    contexts.push({ site, client, products, summary });
  }
  const supplierClient = new Turn14Client({ clientId: requiredEnv("TURN14_CLIENT_ID"),
    clientSecret: requiredEnv("TURN14_CLIENT_SECRET"), baseUrl: "https://api.turn14.com",
    httpRuntime: { timeoutMs: 30000, retries: 3, retryBaseMs: 1500 } });
  report.phase = "read-supplier-catalog";
  await checkpoint();
  const catalog = await fetchCommerceCatalog(supplierClient, {
    existingSkus, brandNames: options.brands, minRequestIntervalMs: 500,
    onProgress: async (event) => {
      // Brand names are not logged. No supplier amounts or store records leave
      // the runtime. The report includes completeness and failures explicitly.
      report.supplier.brandsProcessed = (report.supplier.brandsProcessed ?? 0) + 1;
      report.supplier.itemsScanned = (report.supplier.itemsScanned ?? 0) + event.scanned;
      report.supplier.itemsRetained = (report.supplier.itemsRetained ?? 0) + event.retained;
      if (event.status === "failed") report.supplier.brandsFailed = (report.supplier.brandsFailed ?? 0) + 1;
      if (report.supplier.brandsProcessed % 20 === 0) {
        await checkpoint();
        console.log(JSON.stringify({ phase: report.phase, counts: report.supplier }));
      }
    }
  });
  report.supplier = catalog.summary;
  report.promotions = evaluateManufacturerPromotions(catalog.items, promotions, { now: Date.now() });
  await checkpoint();

  for (const context of contexts) {
    report.phase = "update-prices";
    context.summary.pricing = await updateSitePrices({ ...context, items: catalog.items,
      apply: options.apply, maxUpdates: options.maxUpdates,
      onProgress: async (counts) => { context.summary.pricing = counts; await checkpoint(); } });
    await checkpoint();
    console.log(JSON.stringify({ site: context.site.key, phase: report.phase, counts: context.summary.pricing }));
  }
  for (const context of contexts) {
    report.phase = "import-products";
    if (context.summary.pricing?.stoppedAuthorization || context.summary.pricing?.stoppedErrorLimit) {
      context.summary.imports = { stopped: true, reason: "prior-site-operation-failed", published: 0, errors: 0 };
      await checkpoint();
      continue;
    }
    // Refresh after price/SKU updates and before duplicate-sensitive imports.
    context.products = await context.client.queryAllProducts({ includeHiddenProducts: true, includeVariants: true });
    context.summary.imports = await importSiteProducts({ ...context, supplierClient, items: catalog.items,
      apply: options.apply && options.maxCreates > 0, maxCreates: options.maxCreates,
      shippingPolicy: shipping,
      onProgress: async (counts) => { context.summary.imports = counts; await checkpoint(); } });
    await checkpoint();
    console.log(JSON.stringify({ site: context.site.key, phase: report.phase, counts: context.summary.imports }));
  }
  report.phase = "complete";
  report.completedAt = new Date().toISOString();
  report.status = catalog.summary.brandsFailed || catalog.summary.rejectedBrandMismatchItems > 0 || contexts.some((c) => c.summary.pricing?.errors || c.summary.imports?.errors || c.summary.imports?.stopped) ? "partial" : "complete";
  await checkpoint();
  console.log(JSON.stringify({ status: report.status, supplier: report.supplier, sites: report.sites }));
  if (report.status === "partial") process.exitCode = 1;
}

main().catch(async (error) => {
  report.status = "failed";
  report.failure = { phase: report.phase, httpStatus: Number.isInteger(error?.status) ? error.status : null };
  await checkpoint().catch(() => {});
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
});
