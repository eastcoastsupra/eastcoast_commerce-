import { mkdir, writeFile } from "node:fs/promises";
import { buildTurn14IdentifierIndex, matchWixProduct } from "./match.js";
import { evaluatePriceChange } from "./policy.js";
import { WixCatalogV1Client } from "../wix/client.js";

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function compactProduct(product) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand ?? "",
    sku: product.sku ?? "",
    visible: product.visible,
    currentPrice: product?.priceData?.price ?? product?.price?.price ?? null,
    productPageUrl: product.productPageUrl ?? null
  };
}

function compactTurn14Item(item) {
  return {
    itemId: String(item.id),
    productName: item?.attributes?.product_name ?? "",
    partNumber: item?.attributes?.part_number ?? "",
    manufacturerPartNumber: item?.attributes?.mfr_part_number ?? "",
    brand: item?.attributes?.brand ?? "",
    purchaseCost: item?.pricing?.attributes?.purchase_cost ?? null,
    hasMap: item?.pricing?.attributes?.has_map ?? false,
    canPurchase: item?.pricing?.attributes?.can_purchase ?? false
  };
}

export async function runPricingSync({
  sites,
  turn14Catalog,
  wixApiKey,
  brand,
  apply,
  maxUpdates,
  policy,
  httpRuntime,
  reportsDir
}) {
  const index = buildTurn14IdentifierIndex(turn14Catalog.items);
  const siteReports = [];

  for (const site of sites) {
    const wix = new WixCatalogV1Client({
      apiKey: wixApiKey,
      siteId: site.siteId,
      httpRuntime
    });
    const products = await wix.listAllProducts();
    const decisions = [];
    let appliedCount = 0;

    for (const product of products) {
      const match = matchWixProduct(product, brand, index);
      if (match.status !== "matched") {
        if (match.reason !== "not-brand-product") {
          decisions.push({
            product: compactProduct(product),
            match
          });
        }
        continue;
      }

      const priceDecision = evaluatePriceChange(product, match.item, policy);
      const record = {
        product: compactProduct(product),
        match: {
          status: match.status,
          sku: match.sku,
          matchedField: match.matchedField,
          turn14: compactTurn14Item(match.item)
        },
        priceDecision,
        applied: false
      };

      if (apply && priceDecision.action === "update") {
        if (appliedCount >= maxUpdates) {
          record.priceDecision = {
            ...priceDecision,
            action: "skip",
            reason: "site-update-limit-reached"
          };
        } else {
          const response = await wix.updatePrice(product.id, priceDecision.mapPrice);
          record.applied = true;
          record.verifiedPrice =
            response?.product?.priceData?.price ?? response?.product?.price?.price ?? null;
          appliedCount += 1;
        }
      }

      decisions.push(record);
    }

    const summary = decisions.reduce(
      (accumulator, decision) => {
        const reason = decision.priceDecision?.reason ?? decision.match?.reason ?? "unknown";
        accumulator.byReason[reason] = (accumulator.byReason[reason] ?? 0) + 1;
        if (decision.priceDecision?.action === "update") accumulator.proposed += 1;
        if (decision.applied) accumulator.applied += 1;
        if (decision.match?.status === "matched") accumulator.matched += 1;
        if (decision.match?.status === "unmatched") accumulator.unmatched += 1;
        return accumulator;
      },
      { matched: 0, unmatched: 0, proposed: 0, applied: 0, byReason: {} }
    );

    siteReports.push({
      site,
      productCount: products.length,
      summary,
      decisions
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    requestedBrand: brand,
    policy,
    maxUpdatesPerSite: maxUpdates,
    turn14: {
      brand: turn14Catalog.brand,
      counts: turn14Catalog.counts
    },
    sites: siteReports
  };

  await mkdir(reportsDir, { recursive: true });
  const reportPath = `${reportsDir}/turn14-map-${timestampForFile()}.json`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}
