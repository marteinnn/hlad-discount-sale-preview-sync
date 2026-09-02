# Hlað Discount Sale Preview Sync

This small public repository is a fallback runner for the Shopify discount sale-preview sync for `hlad-is.myshopify.com`.

The preferred staff workflow is now the Shopify Admin app **Hlað Sale Preview Sync**:

1. Open Shopify Admin.
2. Go to **Apps**.
3. Open **Hlað Sale Preview Sync**.
4. Press **Skanna og uppfæra afslætti**.

Admin app source:

https://github.com/marteinnn/hlad-sale-preview-sync-admin-app

The code contains no Shopify credentials. Required values live in GitHub Actions secrets:

- `SHOPIFY_STORE`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

The workflow can be run manually from GitHub Actions with **Run workflow**:

https://github.com/marteinnn/hlad-discount-sale-preview-sync/actions/workflows/discount-sale-preview-sync.yml

If GitHub fallback is needed, use the workflow's **Run workflow** button. If an external scheduler is used, call the workflow dispatch API:

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
