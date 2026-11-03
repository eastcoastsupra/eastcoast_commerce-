# Commerce sync operations

This guide describes the current commands and safeguards for East Coast Supra and East Coast BMW. It documents configured behavior, not the outcome of any pending deployment or workflow run. Both stores use Wix Stores Catalog V1.

The commerce runner checks supplier references, updates eligible existing prices and exact SKU recoveries, reviews configured manufacturer offers, and prepares eligible new products. It does not create supplier orders or fulfill customer orders.

## Credentials and validation

Run commands from the repository root using Node.js 22, as configured in GitHub Actions. Validate before changing or deploying the integration:

```bash
npm run validate
```

The syntax check covers `.js` and `.mjs` files under `src`, `scripts`, and `test`. Validation also runs the automated tests.

The commerce process requires `TURN14_CLIENT_ID`, `TURN14_CLIENT_SECRET`, and `WIX_API_KEY` in its environment. Use GitHub Actions repository secrets, bound only to the step that needs them. These new `.mjs` runners do not automatically load a local `.env` file. Never paste secret values into commands, commit them, print the environment, enable shell tracing around credentials, or include them in logs or reports. The SEO runner requires only `WIX_API_KEY`.

Supplier records, dealer costs, product identifiers, prices, and store catalogs stay in memory during the commerce run. Publish only the intended storefront product fields and aggregate reports. Do not create a public export of supplier catalogs, private pricing, raw API responses, or store records.

## Preview and bounded writes

The commerce CLI processes both configured stores. Its caps default to zero, and writes require `--apply` with at least one positive cap. It does not accept the legacy CLI's `--site` or `--mode` arguments; existing regular prices are fixed to raise-only in this runner.

Preview the full catalog without store writes:

```bash
node scripts/SyncCommerce.mjs
```

Preview a narrower selection using exact supplier brand names:

```bash
node scripts/SyncCommerce.mjs --brands "CSF,Mishimoto,H&R"
```

Run a small price and SKU recovery canary, with product creation disabled:

```bash
node scripts/SyncCommerce.mjs --brands "CSF,Mishimoto,H&R" --apply --max-updates 10 --max-creates 0
```

Run a bounded price and SKU recovery pass across all supplier brands:

```bash
node scripts/SyncCommerce.mjs --apply --max-updates 10 --max-creates 0
```

After shipping units and all import prerequisites are verified, test a bounded import without existing-price writes:

```bash
node scripts/SyncCommerce.mjs --brands "CSF,Mishimoto,H&R" --apply --max-updates 0 --max-creates 2
```

This import command still holds products while shipping configuration is unverified. An import preview checks the catalog, identity, price, and shipping gates, but does not fetch every candidate's final media and inventory data. `plannedCreates` is therefore not proof that all publication requirements have passed.

### Caps apply separately to each store

| Setting | Per-store limit | Maximum across both stores |
| --- | --- | --- |
| `--max-updates 10` | 10 attempted product or variant patches | 20 attempts |
| `--max-creates 2` | 2 attempted product creations | 4 attempts |
| Current scheduled command: `--max-updates 1500 --max-creates 0` | 1,500 attempted price/SKU patches; no creations | 3,000 attempts; no creations |

A price increase and SKU recovery in one simple-product patch consume one update attempt. SKU-only recovery also consumes an update attempt. Failed or uncertain writes count against the limit. A product creation can additionally require collection, media, inventory, and publication requests, so the creation cap is not a cap on total API requests.

Caps reset on each invocation; they are not daily budgets. Later eligible work is deferred when the cap is reached. Re-run only after reviewing the aggregate outcome and resolving failures. Do not interpret a successful exit as proof that every supplier item was imported or every existing price changed.

## Existing-product price and identity rules

Updates require an exact, unambiguous supplier identity and a confirmed single selling unit. Supplier SKUs, brand-scoped manufacturer part numbers, and managed `T14-<itemId>` SKUs are checked for collisions. Missing SKUs can be recovered only from an explicit typed manufacturer identifier plus a verified brand. Similar titles alone never authorize a price update.

Existing manual discounts and hidden products are preserved. Managed variants need an exact variant SKU and target ID; the runner never substitutes the parent product for an unresolved variant. A single default variant with no actual choices is treated as a simple product.

Current supplier pricing must be verified. A positive verified MAP is the normal reference; manufacturer retail is available only when the source explicitly supports the absence of MAP. Missing or contradictory MAP evidence is a hold. Prices must use the expected currency, be positive, and satisfy the applicable MAP and known purchase-cost floors.

Regular existing prices can increase to the reference. Higher existing prices remain unchanged and are counted in `potentialReductions`. The CLI does not authorize arbitrary reductions or apply promotion prices. A recovered existing SKU uses the supplier SKU; it does not convert a merchant's existing product into a `T14-` managed product.

Immediately before a patch, the runner fetches the current product, resolves its identity again, and compares price, SKU, visibility, and discount state with the original snapshot. A changed state is held as a human-edit conflict. This narrows the race window; it is not a transaction or a server-side lock, so avoid concurrent manual edits to affected products during a write pass.

Writes are not automatically retried. Verification reads use bounded delays of 1, 2, 4, and 8 seconds after the initial read. HTTP 401/403 stops that site's price operations; three recorded errors also stop the site. Imports are skipped for a site whose pricing phase stopped for either reason.

## New-product gates and publication

New imports require verified relevance to the target store, an active purchasable supplier item, an unambiguous brand and manufacturer part number, a valid price, and `unitsPerSku === 1`. Vehicle relevance comes from supported supplier application evidence; undecoded vehicle IDs and shared engine names are not fitment proof. Explicitly universal detailing products may qualify for both stores.

Casepacks, unknown selling units, ambiguous aliases, and possible duplicates are held. Duplicate checks include hidden products and all variant SKUs. An exact matching name with unresolved identity can block a new creation without authorizing an update. New products use `T14-<itemId>` as the durable SKU and retain the manufacturer part number in the description.

Required supplier images, usable content, inventory availability, and complete required manufacturer warnings must be available before creation. Freight or regulatory restrictions requiring additional configuration are held. Supplier inventory is configured during import, including a confirmed quantity of zero; this is not ongoing inventory synchronization or order fulfillment.

The creation sequence is: create hidden, attach images, configure inventory, attach the collection, verify the hidden product's identity/price/media, then publish and verify again. A pre-publication failure leaves a successfully created product hidden. A failure after the publication request may leave it visible even if final verification failed; inspect that state before proceeding.

An uncertain creation is never blindly retried. The batch stops so the next complete catalog read can reconcile a product whose creation succeeded without an acknowledged response. Previously staged hidden products are protected by duplicate checks, but automatic resumption and republication of those products are not implemented. Review them deliberately instead of removing the duplicate guard.

### Shipping is currently a publication blocker

`config/Shipping.json` currently sets `verified` to `false`, with supplier and site weight units unset. Both stores use weight-based shipping. Do not enable imports by changing the flag without evidence.

Before enabling imports, confirm and record the supplier weight unit, each site's weight unit, and the supporting evidence. The implemented converter accepts only `LB` and `KG`, requires distinct positive box numbers and positive numeric weights for every supplied box, sums the box weights, converts units, and rounds upward to three decimal places. Unknown units, missing weights, invalid boxes, or an out-of-range result hold the product. Freight and other restricted shipping conditions remain separate holds.

## Manufacturer promotion review

`config/Promotions.json` has an empty `offers` list by default. `evaluateManufacturerPromotions` always reports `executionMode: "review-only"` and `applied: 0`. An omitted execution mode defaults to review-only; any other requested mode fails closed. Missing or invalid configuration does not authorize a sale. A missing or malformed JSON file also fails the runner before writes.

The checker evaluates documented offers supplied in configuration against current supplier evidence. It does not discover consumer offers from dealer costs, scrape manufacturer offers, schedule a storefront sale, or restore prices at expiry. A lower supplier purchase cost is never sufficient evidence of a consumer promotion. Keep the existing configuration guard fields enabled.

Each offer needs the following verified terms:

| Field | Required evidence or meaning |
| --- | --- |
| `id` | A unique, nonempty offer identifier. |
| `verified: true`, `consumerPromotion: true` | The terms were checked and explicitly authorize a consumer offer. |
| `termsUrl` | An HTTPS source for the actual manufacturer terms, including eligibility and any MAP exception. |
| `eligibleItemIds` | Exact current supplier item IDs, with no duplicates or ambiguous matches. A singular `itemId` is also accepted; if both forms are used, they must identify the same one item. |
| `startsAt`, `endsAt` | Valid timestamps with `Z` or an explicit UTC offset; end must be later than start. Start is inclusive and end is exclusive. |
| `currency`, `price` | Explicit supported currency and positive consumer offer price. The offer must also satisfy the known purchase-cost floor. |
| `mapExceptionVerified`, `mapFloor` | A documented exception and explicit positive applicable floor when offering below normal MAP. Without a verified exception, ordinary MAP still applies. |

The checker classifies valid offers as active, upcoming, or expired. Ambiguous items, unverified selling units or prices, invalid terms, and overlapping active offers for the same item are blocked. `validItemCandidates` counts eligible active item/offer pairs for review, not store changes. Before adding any future application mechanism, implement and verify activation, expiry/restoration, current-price conflict checks, and preservation of manual merchant discounts. Keep private dealer terms or credentials out of committed configuration and public reports.

## SEO commands

Preview the separate SEO refresh:

```bash
node scripts/RefreshSeo.mjs
```

Apply a bounded SEO canary:

```bash
node scripts/RefreshSeo.mjs --apply --max-updates 10
```

The SEO cap is global across both stores, processed in alternating order. The runner fills missing standard titles and meta descriptions and corrects the other store's identity in those two tag types. It preserves existing nonempty merchant text otherwise, disabled tags, canonical links, social tags, and other SEO data. It processes visible products and writes only SEO data. New import payloads include generated SEO as part of creation.

## Aggregate reports and failure handling

The commerce report is `reports/commerce/Summary.json`; SEO uses `reports/seo/Summary.json`. Reports contain site labels, timestamps, aggregate counts, fixed reason codes, and sanitized failure status. They do not contain product-level identifiers, dealer costs, or raw errors. The commerce workflow uploads its aggregate report even when a step fails, with 30-day retention.

Read the report fields together:

| Field | Interpretation |
| --- | --- |
| `supplier.brandsFailed` | Supplier coverage is incomplete; do not claim a complete supplier scan. |
| `supplier.rejectedBrandMismatchItems`, `supplier.brandsWithRejectedItems` | Source records whose explicit brand ID conflicts with their feed are excluded; valid records from those feeds can still be processed. These source holds keep the overall result partial. |
| `proposedPriceRaises`, `proposedSkuRecoveries` | Eligible proposals, including work that may later be applied, conflicted, or capped. Do not add these to applied counts. |
| `writeAttempts`, `applied` | Attempted patches versus patches whose intended price/SKU was verified. A reported write error may still be followed by successful readback. |
| `pricesUpdated`, `skusRecovered`, `variantsUpdated` | Overlapping classifications of verified updates, not independent totals to add together. |
| `potentialReductions` | Higher existing prices preserved by raise-only policy. |
| `held`, `conflicts`, `capDeferred`, `byReason` | Protected or deferred work requiring review; held counts can include variant-level decisions. |
| `unverifiedWrites`, `errors`, stop flags | Uncertainty or failures to resolve before broadening another run. A failed response alone does not prove no mutation occurred. |
| `plannedCreates`, `attemptedCreates`, `createdHidden`, `published`, `verified` | Successive import stages; final verification is distinct from a publication request. |
| `promotions` | Configuration validity and review counts; no promotion application. |

`status: "partial"` exits nonzero when supplier brands fail, inconsistent brand records are excluded, or site operations report errors/stops. An uncaught error produces `status: "failed"` with phase and numeric HTTP status when available. A cancelled or timed-out process may leave only a `running` checkpoint, and failures before the first checkpoint may leave no report. `status: "complete"` can still contain valid holds, unresolved identities, capped work, or no eligible changes.

Resolve authorization errors through the secret configuration without printing the values. After uncertain writes, begin with a fresh read/preview and reconcile current store state; never replay a raw write request to force a result. The report is aggregate and cannot serve as a per-product rollback file. Use Wix's current state and the merchant's own audit process for any deliberate correction.

## Workflow configuration and concurrency

`CommerceCatalog.yml` configures a UTC schedule of `37 */6 * * *`, manual dispatch, and a narrow push trigger for its workflow file on `commerce-expansion-20261103`. The scheduled command scans all brands and uses `--apply --max-updates 1500 --max-creates 0`. A configured schedule is not evidence that a run has completed; scheduled execution requires the workflow on the default branch. Review the Actions result and its report for each run.

The broad workflow uses `eastcoast-commerce-writes` with cancellation disabled. The legacy `turn14-map-live.yml` is now a manual informational job with no schedule or writes; the broader workflow replaces it. Do not run manual local writes concurrently with an Actions write pass.

The legacy `npm run live:chemical-guys` command uses a separate CLI and narrower matching/report behavior. Use the commerce commands above for this broader integration; do not assume the legacy script inherits the new safeguards or aggregate-only report contract.
