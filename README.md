# Hlað Discount Sale Preview Sync

This small public repository runs the Shopify discount sale-preview sync for `hlad-is.myshopify.com`.

The code contains no Shopify credentials. Required values live in GitHub Actions secrets:

- `SHOPIFY_STORE`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

The workflow can be run manually from GitHub Actions with **Run workflow**. The scheduled trigger is the unattended production path.

The sync writes sale-preview metafields used by the Shopify theme:

- `custom.sale_preview_active_until`
- `custom.sale_preview_price`
- `custom.sale_preview_compare_at_price`
- `custom.sale_preview_percentage`
- `custom.sale_preview_source`

Only discount shapes the script can safely represent on product cards are previewed. Unsupported cart-only or complex discount shapes are skipped and listed in the uploaded JSON report.
