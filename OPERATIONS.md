# Discount Sync Operations

## Current State

- The preferred workflow is now the Shopify Admin app **Hlað Sale Preview Sync**.
- Staff can open the app in Shopify Admin and press **Skanna og uppfæra afslætti**.
- Manual/API workflow dispatch in this repo still works and has been tested end to end.
- GitHub scheduled runs are intentionally disabled to avoid a second unattended sync path.
- This repo should be treated as fallback only.

Admin app source:

https://github.com/marteinnn/hlad-sale-preview-sync-admin-app

## GitHub Manual Fallback

Open this workflow and choose **Run workflow**:

https://github.com/marteinnn/hlad-discount-sale-preview-sync/actions/workflows/discount-sale-preview-sync.yml

After the run finishes, open the latest run and download the `discount-sale-preview-report` artifact if you need to inspect the sync result.

## External Scheduler Fallback

Use any HTTPS cron service that supports:

- POST requests
- custom headers
- JSON request body

Call:

```http
POST https://api.github.com/repos/marteinnn/hlad-discount-sale-preview-sync/actions/workflows/discount-sale-preview-sync.yml/dispatches
Authorization: Bearer <fine-grained GitHub token>
Accept: application/vnd.github+json
User-Agent: hlad-discount-sale-preview-scheduler
Content-Type: application/json

{"ref":"main"}
```

Recommended cadence if this fallback is intentionally used: every 30 minutes.
Expected success response: `204 No Content`.

The fine-grained GitHub token should be scoped only to `marteinnn/hlad-discount-sale-preview-sync` and should have Actions/workflows write permission.

Do not put the Shopify Admin API credentials in the storefront theme. A storefront page or Shopify theme template is not a safe place to trigger the sync directly.

## Expected Report

A healthy run should show:

- `mode`: `apply`
- `discountCount`: number of active automatic discounts Shopify returned
- `previewVariantCount`: variants with storefront sale previews
- `previewProductCount`: products with storefront sale previews
- `staleVariantCount`: stale variant previews cleared
- `staleProductCount`: stale product previews cleared
- `skipped`: empty, unless the discount uses a shape that cannot be safely previewed
