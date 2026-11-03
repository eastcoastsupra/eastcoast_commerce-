# East Coast Commerce - Turn 14 MAP Sync

A controlled integration for comparing and updating Wix Catalog V1 product prices from Turn 14 MAP data.

## Included sites

| Key | Store | Wix site ID |
|---|---|---|
| `eastcoastsupra` | eastcoastsupra.com | `c657a976-ab71-452c-b451-6ef24770c9f4` |
| `ecbmw` | ecbmw.com | `82e4ec70-32f8-4d6d-a6a6-e4b582cb5104` |

Both sites are configured as Wix Stores Catalog V1.

## Safety model

- Runs are dry-run unless `--apply` is supplied.
- Default mode is `raise-only`; prices above MAP are preserved.
- Lowering a price requires both `--mode exact-map` and `--allow-price-decrease`.
- Products are matched only by exact normalized Wix SKU against a Turn 14 part number, manufacturer part number, barcode, or alternate part number.
- Missing SKUs, ambiguous matches, variants, active discounts, hidden products, inactive items, non-purchasable items, and products without MAP are skipped by default.
- Each apply run is capped at 10 changes per site unless `--max-updates` is changed.
- Every run writes a complete JSON audit report under `reports/`.

## Requirements

- Node.js 20.11 or newer.
- Turn 14 API client ID and client secret.
- A Wix API key authorized to read and manage store products for both sites.

Copy the environment template and enter credentials locally:

```bash
cp .env.example .env
```

Never commit `.env` or credentials.

## Validate locally

```bash
npm run validate
```

## Chemical Guys dry run

```bash
npm run dry-run:chemical-guys
```

## Apply raises to MAP

```bash
npm run live:chemical-guys
```

The live workflow runs every six hours. It only raises exact-match Chemical Guys products that are below Turn 14 MAP, skips protected product states, caps updates per site, and uploads a JSON audit report.

Required GitHub Actions repository secrets:

- `TURN14_CLIENT_ID`
- `TURN14_CLIENT_SECRET`
- `WIX_API_KEY`
