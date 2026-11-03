# East Coast Commerce

Turn 14 catalog, pricing, product SEO, and manufacturer promotion checks for East Coast Supra and East Coast BMW on Wix Catalog V1.

| Store | Key | Wix site ID |
|---|---|---|
| eastcoastsupra.com | `eastcoastsupra` | `c657a976-ab71-452c-b451-6ef24770c9f4` |
| ecbmw.com | `ecbmw` | `82e4ec70-32f8-4d6d-a6a6-e4b582cb5104` |

## Operations

Read [OPERATIONS.md](OPERATIONS.md) for commands, caps, report interpretation, and remaining import prerequisites.

- **Catalog and pricing:** `.github/workflows/CommerceCatalog.yml` scans every supplier brand, updates verified existing products and exact variants, and evaluates import eligibility. The schedule is every six hours at minute 37 UTC after this workflow is on the default branch. The configured job allows up to 1,500 price/SKU attempts per store; new-product creation is disabled until shipping units are verified.
- **SEO:** `.github/workflows/CommerceSeo.yml` fills missing product titles and meta descriptions and corrects copied store identity. Existing custom metadata and structured data are preserved.
- **Promotions:** `config/Promotions.json` and `src/sync/promotionCheck.js` validate documented customer offers in review-only mode. Dealer-cost changes do not activate retail sales. Verified eligible items, dates, terms, and a reliable sale-expiry mechanism are required before activation.
- **Legacy Chemical Guys workflow:** superseded by the broader catalog job. Its old schedule and write operation are disabled.
- **Manual preview:** the former MAP dry-run workflow now runs the new catalog preview for both stores and exports only aggregate counts.

## Matching and pricing

Existing regular-price changes are raise-only. Prices already above the current verified MAP or manufacturer retail reference are preserved. Active merchant discounts, hidden products, ambiguous identities, uncertain variants, and unverified package quantities are held for review.

New-product eligibility requires explicit supplier Supra/BMW application text or universal detailing relevance. Undecoded vehicle IDs and shared engines do not establish fitment. Publication also requires a verified selling unit, price, source media, inventory, shipping weight and units, and any relevant sale restrictions.

## Credentials and reports

Use these repository Actions secrets:

- `TURN14_CLIENT_ID`
- `TURN14_CLIENT_SECRET`
- `WIX_API_KEY`

Never commit credentials or `.env` files. Production catalog responses remain in runner memory. Workflow logs and artifacts contain aggregate counts and fixed hold reasons, not raw catalog records, product identifiers, prices, purchase costs, or credentials.

## Local validation and preview

Node.js 20.11 or newer is required. Workflows use Node.js 22.

```bash
npm run validate
node scripts/SyncCommerce.mjs
node scripts/RefreshSeo.mjs
```

Preview commands are read-only. Apply commands require explicit positive caps, as documented in OPERATIONS.md. Read the generated summaries before changing caps or enabling imports.
