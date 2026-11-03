#!/usr/bin/env node
import { loadDotEnv, requiredEnv, optionalEnv, integerEnv } from "./lib/env.js";
import { selectSites } from "./config/sites.js";
import { Turn14Client } from "./turn14/client.js";
import { fetchBrandCatalog } from "./turn14/catalog.js";
import { runPricingSync } from "./sync/run.js";

const HELP = `
Turn 14 MAP pricing sync for East Coast Supra and East Coast BMW

Usage:
  node src/cli.js [options]

Options:
  --brand <name>              Turn 14 brand name (default: Chemical Guys)
  --site <key>                eastcoastsupra | ecbmw | all (default: all)
  --apply                     Apply approved changes; default is dry-run
  --mode <mode>               raise-only | exact-map (default: raise-only)
  --allow-price-decrease      Permit exact-map mode to reduce prices
  --include-discounted        Permit products with active Wix discounts
  --include-hidden            Permit hidden Wix products
  --max-updates <n>           Maximum applied updates per site (default: 10)
  --reports-dir <path>        Report output directory (default: reports)
  --help                      Show this help

Safety defaults:
  * No write occurs unless --apply is present.
  * raise-only never lowers a Wix price.
  * Variant, discounted, hidden, ambiguous, and missing-SKU products are skipped.
`;

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseArguments(args) {
  const options = {
    brand: "Chemical Guys",
    site: "all",
    apply: false,
    mode: "raise-only",
    allowPriceDecrease: false,
    includeDiscounted: false,
    includeHidden: false,
    maxUpdates: 10,
    reportsDir: null,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--brand":
        options.brand = readValue(args, index, argument);
        index += 1;
        break;
      case "--site":
        options.site = readValue(args, index, argument);
        index += 1;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--mode":
        options.mode = readValue(args, index, argument);
        index += 1;
        break;
      case "--allow-price-decrease":
        options.allowPriceDecrease = true;
        break;
      case "--include-discounted":
        options.includeDiscounted = true;
        break;
      case "--include-hidden":
        options.includeHidden = true;
        break;
      case "--max-updates":
        options.maxUpdates = Number.parseInt(readValue(args, index, argument), 10);
        index += 1;
        break;
      case "--reports-dir":
        options.reportsDir = readValue(args, index, argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!["raise-only", "exact-map"].includes(options.mode)) {
    throw new Error("--mode must be 'raise-only' or 'exact-map'.");
  }
  if (!Number.isInteger(options.maxUpdates) || options.maxUpdates < 1 || options.maxUpdates > 100) {
    throw new Error("--max-updates must be an integer between 1 and 100.");
  }
  if (options.mode === "raise-only" && options.allowPriceDecrease) {
    throw new Error("--allow-price-decrease requires --mode exact-map.");
  }

  return options;
}

function printSummary(result) {
  console.log(`\nReport: ${result.reportPath}`);
  console.log(`Run mode: ${result.report.mode}`);
  for (const site of result.report.sites) {
    console.log(`\n${site.site.name} (${site.site.domain})`);
    console.log(`  Products scanned: ${site.productCount}`);
    console.log(`  Exact matches: ${site.summary.matched}`);
    console.log(`  Unmatched brand SKUs: ${site.summary.unmatched}`);
    console.log(`  Proposed MAP changes: ${site.summary.proposed}`);
    console.log(`  Applied changes: ${site.summary.applied}`);
  }
}

async function main() {
  await loadDotEnv();
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP.trim());
    return;
  }

  const httpRuntime = {
    timeoutMs: integerEnv("HTTP_TIMEOUT_MS", 30000, { min: 1000, max: 300000 }),
    retries: integerEnv("HTTP_RETRIES", 3, { min: 0, max: 10 }),
    retryBaseMs: integerEnv("HTTP_RETRY_BASE_MS", 750, { min: 100, max: 30000 })
  };
  const concurrency = integerEnv("TURN14_PAGE_CONCURRENCY", 4, { min: 1, max: 10 });
  const reportsDir = options.reportsDir ?? optionalEnv("REPORTS_DIR", "reports");

  const turn14 = new Turn14Client({
    clientId: requiredEnv("TURN14_CLIENT_ID"),
    clientSecret: requiredEnv("TURN14_CLIENT_SECRET"),
    baseUrl: optionalEnv("TURN14_BASE_URL", "https://api.turn14.com"),
    httpRuntime
  });

  const catalog = await fetchBrandCatalog(turn14, options.brand, concurrency);
  const result = await runPricingSync({
    sites: selectSites(options.site),
    turn14Catalog: catalog,
    wixApiKey: requiredEnv("WIX_API_KEY"),
    brand: options.brand,
    apply: options.apply,
    maxUpdates: options.maxUpdates,
    policy: {
      mode: options.mode,
      allowPriceDecrease: options.allowPriceDecrease,
      includeDiscounted: options.includeDiscounted,
      includeHidden: options.includeHidden
    },
    httpRuntime,
    reportsDir
  });

  printSummary(result);
}

main().catch((error) => {
  console.error("\nSync failed:", error instanceof Error ? error.message : error);
  if (error?.body) {
    console.error(JSON.stringify(error.body, null, 2));
  }
  process.exitCode = 1;
});
