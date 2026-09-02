# Hlað Discount Sale Preview Sync

This small public repository runs the Shopify discount sale-preview sync for `hlad-is.myshopify.com`.

The code contains no Shopify credentials. Required values live in GitHub Actions secrets:

- `SHOPIFY_STORE`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

The workflow can be run manually from GitHub Actions with **Run workflow**:

https://github.com/marteinnn/hlad-discount-sale-preview-sync/actions/workflows/discount-sale-preview-sync.yml

The scheduled trigger is the intended unattended production path. If GitHub does not create `schedule` runs for this account/repo, use an external HTTPS cron service to call the workflow dispatch API:

```http
POST https://api.github.com/repos/marteinnn/hlad-discount-sale-preview-sync/actions/workflows/discount-sale-preview-sync.yml/dispatches
Authorization: Bearer <fine-grained GitHub token>
Accept: application/vnd.github+json
User-Agent: hlad-discount-sale-preview-scheduler
Content-Type: application/json

{"ref":"main"}
```

The fine-grained token only needs access to this repository with Actions/workflows write permission.
GitHub returns `204 No Content` when the workflow dispatch is accepted.

The sync writes sale-preview metafields used by the Shopify theme:

- `custom.sale_preview_active_until`
- `custom.sale_preview_price`
- `custom.sale_preview_compare_at_price`
- `custom.sale_preview_percentage`
- `custom.sale_preview_source`

Only discount shapes the script can safely represent on product cards are previewed. Unsupported cart-only or complex discount shapes are skipped and listed in the uploaded JSON report.
