# Commerce update status

Verified on November 3, 2026, after the catalog recovery pass. This is a dated snapshot, not a substitute for the latest workflow result.

## Live results

| Measure | East Coast Supra | East Coast BMW |
|---|---:|---:|
| Verified price updates across the canary and broad run | 43 | 39 |
| Newly filled product SEO title and description pairs | 561 | 531 |
| Visible products with complete active title and description | 597 | 576 |
| Existing complete SEO pairs preserved | 36 | 45 |
| Supplier candidates identified, including existing and held items | 3,409 | 22,136 |
| Candidates held at shipping weight verification | 1,293 | 12,349 |
| New products published | 0 | 0 |

Price changes include 13 exact variant updates across the two stores. No price write errors, unverified price writes, or cap deferrals were reported. Existing prices remain raise-only; the broad run preserved 20 matched prices above the reference and protected merchant discounts, hidden products, and unresolved identities.

The final read-only SEO audit found no missing titles/descriptions and no duplicate active standard tags across all 1,173 visible products. The 1,092 exact generated pairs equal the 1,090 bulk writes plus the two earlier canary writes. The bulk job's one verification error was a false positive caused by a factual merchandise name containing the other store's name; a targeted read confirmed the intended tags, and the checker was corrected without another product write.

## Supplier coverage and holds

All 451 supplier brands were reviewed across the broad scan and bounded recovery. Two feeds contained 1,006 records whose explicit brand ID disagreed with the queried feed. Those records were excluded; valid records from those feeds were retained. The recovery completed all 40 selected brands with no failed brand reads, no HTTP failures, and no additional price changes.

The workflow deliberately reports a partial result while these source inconsistencies remain. This status does not mean the verified storefront price writes failed. Other product holds include missing identifiers, package quantities, missing usable retail references, purchasing restrictions, and shipping or regulatory requirements.

The candidate counts above are combined across the broad scan and recovery; they include products already present and products that cannot currently be published. Passing the initial identity and pricing gates does not establish final image, inventory, or warning-text readiness.

## Configured recurring work

- CommerceCatalog.yml scans all supplier brands every six hours at minute 37 UTC on the default branch. It permits up to 1,500 price/SKU attempts per store and currently creates no products.
- The old Chemical Guys-only scheduled writer is retired.
- The separate Manufacturer Promotion Check is enabled daily on an America/New_York schedule. It reviews official manufacturer and authorized supplier announcements.
- Promotion execution remains review-only. Exact item eligibility, consumer terms, campaign timestamps, MAP permission where required, and a reliable expiry/reversion mechanism are necessary before activation.
- Credentials remain in the existing Actions secrets. Reports contain aggregate counts and fixed reasons only.

## Product publication prerequisite

Both stores use weight-based shipping. config/Shipping.json remains unverified. Confirm each Wix store's displayed shipping weight unit, and the unit and per-box meaning of Turn 14 dimensions[].weight, before enabling creation. No new products were published or staged by these runs.

## Evidence

- [Bounded price canary](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41589073769)
- [Broad supplier and price scan](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41589397724)
- [Supplier recovery with isolated inconsistent records](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41593022914)
- [Bulk product SEO run](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41587510465)

All 118 tests passed after the final implementation changes. Operational commands and report interpretation are in [OPERATIONS.md](OPERATIONS.md).
