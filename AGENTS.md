# East Coast Commerce Codex Instructions

This repository contains the controlled Turn 14 MAP pricing integration for East Coast Supra and East Coast BMW.

## Safety rules

- Never commit API keys, client secrets, bearer tokens, or `.env` files.
- Keep dry-run as the default behavior.
- Production updates must use `--apply --mode raise-only` unless the owner explicitly authorizes price reductions.
- Do not remove the product matching safeguards for missing SKUs, ambiguous matches, variants, discounts, hidden products, inactive items, unavailable MAP, or non-purchasable items.
- Keep applied updates capped with `--max-updates`.
- Do not add Turn 14 order creation or fulfillment calls without a separate approved change.

## Validation

Run before every change:

```bash
npm run validate
```

## Sites

- East Coast Supra: `c657a976-ab71-452c-b451-6ef24770c9f4`
- East Coast BMW: `82e4ec70-32f8-4d6d-a6a6-e4b582cb5104`

Both currently use Wix Stores Catalog V1.
