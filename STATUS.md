# Commerce update status

This is a dated snapshot, not a substitute for the latest workflow result.

## November 3, 2026 evening update: pounds confirmed and first imports verified

The merchant confirmed that Turn 14 box weights and both Wix store weight settings use pounds. The displayed supplier box sequence is length, width, height, then actual box weight. `config/Shipping.json` now records verified `LB` source and destination units, a per-box weight basis, the named `attributes.dimensions[].weight` field, and the merchant-confirmation date. This resolves the earlier shipping-unit prerequisite; do not ask for the same confirmation again.

The importer sums actual weights from distinct boxes once, without substituting length multiplied by width multiplied by height or converting pounds to kilograms. Missing, zero, invalid, duplicated, or otherwise unsupported box weights remain product-specific holds. No existing Wix shipping settings were changed.

The initial pounds canary completed without storefront changes because supplier images were rejected by an overly strict optional pixel-metadata check. A read-only aggregate probe confirmed that image URLs and supported image types were present, while the pixel dimensions were unusable. The adapter now retains exact supplied HTTPS image URLs when optional resolution metadata is unavailable, still requiring valid image type/extension and successful Wix media attachment before publication. It does not invent dimensions or rewrite URLs.

The corrected bounded import completed successfully at 7:16 p.m. America/New_York on November 3, 2026 (2026-11-04T00:16Z). All 125 regression tests passed.

| Latest bounded-import result | East Coast Supra | East Coast BMW |
|---|---:|---:|
| Newly created, published, and verified products | 2 | 2 |
| Products with media and inventory configured | 2 | 2 |
| Import errors | 0 | 0 |
| Changes to existing prices | 0 | 0 |
| Total catalog records after import, including hidden | 703 | 652 |

An independent Wix read confirmed all four new listings visible, each with a positive pound weight, attached images, tracked inventory, collection membership, and active SEO title and description. The canary scanned all 8,061 item records in its three selected supplier brands, not the entire Turn 14 catalog.

This was a four-product validation batch, not completion of the full catalog expansion. The broad scheduled command remains `--max-updates 1500 --max-creates 0`; recurring bulk product creation has not been enabled. Inventory is initialized during import, not continuously synchronized. No promotion was activated and no supplier order was placed.

### Latest evidence

- [Initial pounds canary with image-validation holds](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41744340887)
- [Read-only media validation counters](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41745091015)
- [Successful four-product pounds import](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41745398743)
- [Confirmed shipping configuration](config/Shipping.json)

## Earlier November 3 catalog recovery snapshot

The following figures describe the earlier price/SEO and supplier-discovery passes. Their shipping-unit holds are historical and superseded by the confirmation above.

| Measure | East Coast Supra | East Coast BMW |
|---|---:|---:|
| Verified price updates across the earlier canary and broad run | 43 | 39 |
| Newly filled product SEO title and description pairs | 561 | 531 |
| Visible products with complete active title and description in that audit | 597 | 576 |
| Existing complete SEO pairs preserved | 36 | 45 |
| Supplier candidates identified, including existing and held items | 3,409 | 22,136 |
| Candidates then held at shipping weight verification | 1,293 | 12,349 |
| New products published by those earlier runs | 0 | 0 |

Price changes include 13 exact variant updates across the two stores. No price write errors, unverified price writes, or cap deferrals were reported. Existing prices remain raise-only; the broad run preserved 20 matched prices above the reference and protected merchant discounts, hidden products, and unresolved identities.

The read-only SEO audit found no missing titles/descriptions and no duplicate active standard tags across the then-existing 1,173 visible products. The 1,092 exact generated pairs equal the 1,090 bulk writes plus the two earlier canary writes. The bulk job's one verification error was a false positive caused by a factual merchandise name containing the other store's name; a targeted read confirmed the intended tags, and the checker was corrected without another product write.

## Supplier coverage and holds

All 451 supplier brands were reviewed across the earlier broad scan and bounded recovery. Two feeds contained 1,006 records whose explicit brand ID disagreed with the queried feed. Those records were excluded; valid records from those feeds were retained. The recovery completed all 40 selected brands with no failed brand reads, no HTTP failures, and no additional price changes.

The broad workflow deliberately reports a partial result while these source inconsistencies remain. This status does not mean the verified storefront price writes failed. Other product holds include missing identifiers, package quantities, missing usable retail references, purchasing restrictions, and shipping or regulatory requirements.

The earlier candidate counts are combined across the broad scan and recovery; they include products already present and products that cannot currently be published. Passing initial identity, pricing, and unit checks does not establish final image, inventory, or warning-text readiness for every candidate.

## Configured recurring work

- CommerceCatalog.yml is configured to scan all supplier brands every six hours at minute 37 UTC on the default branch. It permits up to 1,500 price/SKU attempts per store and currently creates no products. A configured schedule is not proof of execution.
- The old Chemical Guys-only scheduled writer is retired.
- The separate Manufacturer Promotion Check is enabled daily on an America/New_York schedule. It reviews official manufacturer and authorized supplier announcements.
- Promotion execution remains review-only. Exact item eligibility, consumer terms, campaign timestamps, MAP permission where required, and a reliable expiry/reversion mechanism are necessary before activation.
- Credentials remain in the existing Actions secrets. Reports contain aggregate counts and fixed reasons only.

## Earlier evidence

- [Bounded price canary](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41589073769)
- [Broad supplier and price scan](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41589397724)
- [Supplier recovery with isolated inconsistent records](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41593022914)
- [Bulk product SEO run](https://github.com/eastcoastsupra/eastcoast_commerce-/actions/runs/41587510465)

The earlier implementation passed 118 tests. The current pounds and media implementation passed 125 tests. Operational commands and report interpretation are in [OPERATIONS.md](OPERATIONS.md); the latest merchant-confirmed shipping state is in this status record and config/Shipping.json.
