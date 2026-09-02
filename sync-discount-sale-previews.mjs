#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE = process.env.SHOPIFY_STORE || 'hlad-is.myshopify.com';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const REPORT_DIR = path.resolve('reports', `discount-sale-previews-${new Date().toISOString().slice(0, 10)}`);
const METAFIELD_NAMESPACE = 'custom';
const METAFIELD_KEYS = {
  activeUntil: 'sale_preview_active_until',
  price: 'sale_preview_price',
  compareAtPrice: 'sale_preview_compare_at_price',
  percentage: 'sale_preview_percentage',
  source: 'sale_preview_source',
};
const METAFIELD_TYPES = {
  number: 'number_integer',
  text: 'single_line_text_field',
};
const BATCH_SIZE = 25;
const DISCOUNT_PAGE_SIZE = 10;
const DISCOUNT_TARGET_PAGE_SIZE = 50;
const COLLECTION_PRODUCT_PAGE_SIZE = 100;
const VARIANT_PAGE_SIZE = 100;
const DEFAULT_TTL_HOURS = 26;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_RETRY_ATTEMPTS = 3;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLEAR = args.includes('--clear');
const INCLUDE_ALL_ITEMS = args.includes('--include-all-items');
const TTL_INDEX = args.indexOf('--ttl-hours');
const TTL_HOURS = TTL_INDEX >= 0 ? Number(args[TTL_INDEX + 1]) : DEFAULT_TTL_HOURS;
const REQUEST_TIMEOUT_MS = Number(process.env.SHOPIFY_API_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS);
const REQUEST_RETRY_ATTEMPTS = Number(process.env.SHOPIFY_API_RETRY_ATTEMPTS || DEFAULT_REQUEST_RETRY_ATTEMPTS);

if (!ADMIN_TOKEN && (!CLIENT_ID || !CLIENT_SECRET)) {
  throw new Error('Missing Shopify credentials. Set SHOPIFY_ADMIN_ACCESS_TOKEN, or set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET for the client-credentials flow.');
}

if (!Number.isFinite(TTL_HOURS) || TTL_HOURS <= 0) {
  throw new Error('Pass a positive number after --ttl-hours.');
}

if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) {
  throw new Error('SHOPIFY_API_TIMEOUT_MS must be a positive number when set.');
}

if (!Number.isInteger(REQUEST_RETRY_ATTEMPTS) || REQUEST_RETRY_ATTEMPTS <= 0) {
  throw new Error('SHOPIFY_API_RETRY_ATTEMPTS must be a positive integer when set.');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function centsFromMoney(value) {
  if (value == null || value === '') return null;
  return Math.round(Number.parseFloat(String(value)) * 100);
}

function clampPrice(priceCents, discountCents) {
  return Math.max(0, priceCents - discountCents);
}

function percentageOff(compareAtCents, priceCents) {
  if (!compareAtCents || compareAtCents <= priceCents) return 0;
  return Math.round(((compareAtCents - priceCents) * 100) / compareAtCents);
}

let cachedAdminToken = ADMIN_TOKEN || null;

async function fetchWithTimeout(url, options, label) {
  let lastError;

  for (let attempt = 1; attempt <= REQUEST_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error?.name === 'AbortError'
        ? new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms.`)
        : error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt >= REQUEST_RETRY_ATTEMPTS) throw lastError;

    const retryDelayMs = Math.min(5000, 500 * 2 ** (attempt - 1));
    console.warn(`[sale-preview-sync] ${label} failed on attempt ${attempt}/${REQUEST_RETRY_ATTEMPTS}: ${lastError.message}. Retrying in ${retryDelayMs}ms.`);
    await sleep(retryDelayMs);
  }

  throw lastError;
}

async function getAdminToken() {
  if (cachedAdminToken) return cachedAdminToken;

  const response = await fetchWithTimeout(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  }, 'Shopify client-credentials token request');

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Could not get Shopify Admin API token: ${response.status} ${JSON.stringify(payload)}`);
  }

  cachedAdminToken = payload.access_token;
  return cachedAdminToken;
}

function activeUntilEpoch(discount) {
  const endsAt = discount.endsAt ? Date.parse(discount.endsAt) : null;
  const ttl = Date.now() + TTL_HOURS * 60 * 60 * 1000;
  const activeUntilMs = Number.isFinite(endsAt) ? Math.min(endsAt, ttl) : ttl;
  return Math.floor(activeUntilMs / 1000);
}

function buildPreviewForVariant(variant, discount, value) {
  if (!variant.availableForSale) return null;

  const priceCents = centsFromMoney(variant.price);
  if (!priceCents || priceCents <= 0) return null;

  let previewPriceCents = null;
  if (value.__typename === 'DiscountPercentage') {
    previewPriceCents = clampPrice(priceCents, Math.round(priceCents * Number(value.percentage)));
  } else if (value.__typename === 'DiscountAmount' && value.appliesOnEachItem) {
    previewPriceCents = clampPrice(priceCents, centsFromMoney(value.amount.amount));
  } else {
    return null;
  }

  if (previewPriceCents == null || previewPriceCents >= priceCents) return null;

  return {
    ownerId: variant.id,
    variantTitle: variant.title,
    productId: variant.product.id,
    productHandle: variant.product.handle,
    productTitle: variant.product.title,
    priceCents: previewPriceCents,
    compareAtPriceCents: priceCents,
    percentage: percentageOff(priceCents, previewPriceCents),
    activeUntil: activeUntilEpoch(discount),
    source: `${discount.title} (${discount.nodeId})`,
  };
}

function mergePreview(previews, preview) {
  const existing = previews.get(preview.ownerId);
  if (!existing || preview.priceCents < existing.priceCents) {
    previews.set(preview.ownerId, preview);
  }
}

function buildProductPreviews(variantPreviews) {
  const productPreviews = new Map();

  for (const preview of variantPreviews) {
    const existing = productPreviews.get(preview.productId);
    if (!existing || preview.priceCents < existing.priceCents) {
      productPreviews.set(preview.productId, {
        ...preview,
        ownerId: preview.productId,
      });
    }
  }

  return [...productPreviews.values()];
}

async function graphql(query, variables = {}) {
  const token = await getAdminToken();
  const response = await fetchWithTimeout(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': token,
    },
    body: JSON.stringify({ query, variables }),
  }, 'Shopify Admin GraphQL request');

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(JSON.stringify(payload.errors ?? payload, null, 2));
  }
  return payload.data;
}

async function fetchActiveAutomaticDiscounts() {
  const discounts = [];
  let cursor = null;

  do {
    const data = await graphql(`
      query SalePreviewDiscounts($cursor: String) {
        discountNodes(first: ${DISCOUNT_PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticBasic {
                title
                status
                startsAt
                endsAt
                summary
                customerGets {
                  value {
                    __typename
                    ... on DiscountPercentage { percentage }
                    ... on DiscountAmount {
                      appliesOnEachItem
                      amount { amount currencyCode }
                    }
                  }
                  items {
                    __typename
                    ... on AllDiscountItems { allItems }
                    ... on DiscountProducts {
                      products(first: ${DISCOUNT_TARGET_PAGE_SIZE}) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                          id
                          handle
                          title
                          status
                        }
                      }
                      productVariants(first: ${DISCOUNT_TARGET_PAGE_SIZE}) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                          id
                          title
                          price
                          compareAtPrice
                          availableForSale
                          product { id handle title status }
                        }
                      }
                    }
                    ... on DiscountCollections {
                      collections(first: ${DISCOUNT_TARGET_PAGE_SIZE}) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                          id
                          handle
                          title
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { cursor });

    discounts.push(...data.discountNodes.nodes.map((node) => ({
      nodeId: node.id,
      ...node.discount,
    })));
    cursor = data.discountNodes.pageInfo.hasNextPage ? data.discountNodes.pageInfo.endCursor : null;
  } while (cursor);

  return discounts.filter((discount) => discount.__typename === 'DiscountAutomaticBasic' && discount.status === 'ACTIVE');
}

async function fetchCollectionVariants(collectionId) {
  const variants = [];
  let productCursor = null;

  do {
    const data = await graphql(`
      query SalePreviewCollectionProducts($collectionId: ID!, $productCursor: String) {
        collection(id: $collectionId) {
          id
          handle
          title
          products(first: ${COLLECTION_PRODUCT_PAGE_SIZE}, after: $productCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              handle
              title
              status
              variants(first: ${VARIANT_PAGE_SIZE}) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  title
                  price
                  compareAtPrice
                  availableForSale
                  product { id handle title }
                }
              }
            }
          }
        }
      }
    `, { collectionId, productCursor });

    for (const product of data.collection.products.nodes) {
      if (product.status !== 'ACTIVE') continue;
      if (product.variants.pageInfo.hasNextPage) {
        variants.push(...await fetchProductVariants(product.id));
      } else {
        variants.push(...product.variants.nodes);
      }
    }

    productCursor = data.collection.products.pageInfo.hasNextPage
      ? data.collection.products.pageInfo.endCursor
      : null;
  } while (productCursor);

  return variants;
}

async function fetchProductVariants(productId) {
  const variants = [];
  let cursor = null;

  do {
    const data = await graphql(`
      query SalePreviewProductVariants($productId: ID!, $cursor: String) {
        product(id: $productId) {
          id
          variants(first: ${VARIANT_PAGE_SIZE}, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              price
              compareAtPrice
              availableForSale
              product { id handle title }
            }
          }
        }
      }
    `, { productId, cursor });

    variants.push(...data.product.variants.nodes);
    cursor = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

async function fetchAllActiveVariants() {
  const variants = [];
  let cursor = null;

  do {
    const data = await graphql(`
      query SalePreviewAllProducts($cursor: String) {
        products(first: 100, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            handle
            title
            status
            variants(first: ${VARIANT_PAGE_SIZE}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                title
                price
                compareAtPrice
                availableForSale
                product { id handle title }
              }
            }
          }
        }
      }
    `, { cursor });

    for (const product of data.products.nodes) {
      if (product.variants.pageInfo.hasNextPage) {
        variants.push(...await fetchProductVariants(product.id));
      } else {
        variants.push(...product.variants.nodes);
      }
    }

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

async function buildPreviews(discounts) {
  const previews = new Map();
  const skipped = [];

  for (const discount of discounts) {
    const value = discount.customerGets?.value;
    const items = discount.customerGets?.items;
    if (!value || !items) {
      skipped.push({ title: discount.title, reason: 'missing-discount-shape' });
      continue;
    }

    if (!['DiscountPercentage', 'DiscountAmount'].includes(value.__typename)) {
      skipped.push({ title: discount.title, reason: `unsupported-value-${value.__typename}` });
      continue;
    }

    if (value.__typename === 'DiscountAmount' && !value.appliesOnEachItem) {
      skipped.push({ title: discount.title, reason: 'discount-amount-does-not-apply-on-each-item' });
      continue;
    }

    if (items.__typename === 'DiscountProducts') {
      const productVariants = [];

      if (items.products.pageInfo.hasNextPage || items.productVariants.pageInfo.hasNextPage) {
        skipped.push({ title: discount.title, reason: 'discount-products-target-list-truncated; split or extend script before applying' });
        continue;
      }

      for (const product of items.products.nodes) {
        if (product.status !== 'ACTIVE') continue;
        productVariants.push(...await fetchProductVariants(product.id));
      }

      productVariants.push(...items.productVariants.nodes);

      for (const variant of productVariants) {
        const preview = buildPreviewForVariant(variant, discount, value);
        if (preview) mergePreview(previews, preview);
      }
    } else if (items.__typename === 'DiscountCollections') {
      if (items.collections.pageInfo.hasNextPage) {
        skipped.push({ title: discount.title, reason: 'discount-collection-list-truncated; split or extend script before applying' });
        continue;
      }

      for (const collection of items.collections.nodes) {
        const collectionVariants = await fetchCollectionVariants(collection.id);
        for (const variant of collectionVariants) {
          const preview = buildPreviewForVariant(variant, discount, value);
          if (preview) mergePreview(previews, preview);
        }
      }
    } else if (items.__typename === 'AllDiscountItems') {
      if (!INCLUDE_ALL_ITEMS) {
        skipped.push({ title: discount.title, reason: 'all-items-discount-skipped; rerun with --include-all-items if this should appear as a storefront sale' });
        continue;
      }

      const variants = await fetchAllActiveVariants();
      for (const variant of variants) {
        const preview = buildPreviewForVariant(variant, discount, value);
        if (preview) mergePreview(previews, preview);
      }
    } else {
      skipped.push({ title: discount.title, reason: `unsupported-items-${items.__typename}` });
    }
  }

  return { previews: [...previews.values()], skipped };
}

function metafieldsForPreview(preview) {
  return [
    {
      ownerId: preview.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.activeUntil,
      type: METAFIELD_TYPES.number,
      value: String(preview.activeUntil),
    },
    {
      ownerId: preview.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.price,
      type: METAFIELD_TYPES.number,
      value: String(preview.priceCents),
    },
    {
      ownerId: preview.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.compareAtPrice,
      type: METAFIELD_TYPES.number,
      value: String(preview.compareAtPriceCents),
    },
    {
      ownerId: preview.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.percentage,
      type: METAFIELD_TYPES.number,
      value: String(preview.percentage),
    },
    {
      ownerId: preview.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.source,
      type: METAFIELD_TYPES.text,
      value: preview.source.slice(0, 255),
    },
  ];
}

function metafieldIdentifiersForOwner(owner) {
  return [
    {
      ownerId: owner.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.activeUntil,
    },
    {
      ownerId: owner.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.price,
    },
    {
      ownerId: owner.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.compareAtPrice,
    },
    {
      ownerId: owner.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.percentage,
    },
    {
      ownerId: owner.ownerId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEYS.source,
    },
  ];
}

async function writeMetafields(metafields) {
  const chunks = [];
  for (let index = 0; index < metafields.length; index += BATCH_SIZE) {
    chunks.push(metafields.slice(index, index + BATCH_SIZE));
  }

  for (const chunk of chunks) {
    const data = await graphql(`
      mutation SalePreviewMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id ownerType namespace key value }
          userErrors { field message code }
        }
      }
    `, { metafields: chunk });

    const errors = data.metafieldsSet.userErrors;
    if (errors?.length) {
      throw new Error(`metafieldsSet failed: ${JSON.stringify(errors, null, 2)}`);
    }
  }
}

async function deleteMetafields(metafields) {
  const chunks = [];
  for (let index = 0; index < metafields.length; index += BATCH_SIZE) {
    chunks.push(metafields.slice(index, index + BATCH_SIZE));
  }

  for (const chunk of chunks) {
    const data = await graphql(`
      mutation SalePreviewMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { ownerId namespace key }
          userErrors { field message }
        }
      }
    `, { metafields: chunk });

    const errors = data.metafieldsDelete.userErrors;
    if (errors?.length) {
      throw new Error(`metafieldsDelete failed: ${JSON.stringify(errors, null, 2)}`);
    }
  }
}

async function fetchExistingPreviewVariants() {
  const variants = [];
  let cursor = null;

  do {
    const data = await graphql(`
      query SalePreviewExistingVariants($cursor: String) {
        products(first: 100, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            handle
            title
            variants(first: ${VARIANT_PAGE_SIZE}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                title
                preview: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEYS.activeUntil}") { value }
                product { id handle title }
              }
            }
          }
        }
      }
    `, { cursor });

    for (const product of data.products.nodes) {
      const productVariants = product.variants.pageInfo.hasNextPage
        ? await fetchProductPreviewVariants(product.id)
        : product.variants.nodes;

      variants.push(...productVariants
        .filter((variant) => variant.preview?.value)
        .map((variant) => ({
          ownerId: variant.id,
          variantTitle: variant.title,
          productId: variant.product.id,
          productHandle: variant.product.handle,
          productTitle: variant.product.title,
        })));
    }

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

async function fetchProductPreviewVariants(productId) {
  const variants = [];
  let cursor = null;

  do {
    const data = await graphql(`
      query SalePreviewProductPreviewVariants($productId: ID!, $cursor: String) {
        product(id: $productId) {
          id
          variants(first: ${VARIANT_PAGE_SIZE}, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              preview: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEYS.activeUntil}") { value }
              product { id handle title }
            }
          }
        }
      }
    `, { productId, cursor });

    variants.push(...data.product.variants.nodes);
    cursor = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

async function fetchExistingPreviewProducts() {
  const products = [];
  let cursor = null;

  do {
    const data = await graphql(`
      query SalePreviewExistingProducts($cursor: String) {
        products(first: 100, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            handle
            title
            preview: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEYS.activeUntil}") { value }
          }
        }
      }
    `, { cursor });

    products.push(...data.products.nodes
      .filter((product) => product.preview?.value)
      .map((product) => ({
        ownerId: product.id,
        productId: product.id,
        productHandle: product.handle,
        productTitle: product.title,
      })));

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return products;
}

async function saveReport(report) {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${CLEAR ? 'clear' : APPLY ? 'apply' : 'dry-run'}-${timestamp()}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

async function main() {
  const discounts = CLEAR ? [] : await fetchActiveAutomaticDiscounts();
  const { previews, skipped } = CLEAR ? { previews: [], skipped: [] } : await buildPreviews(discounts);
  const productPreviews = buildProductPreviews(previews);
  const existing = await fetchExistingPreviewVariants();
  const existingProducts = await fetchExistingPreviewProducts();
  const nextVariantIds = new Set(previews.map((preview) => preview.ownerId));
  const nextProductIds = new Set(productPreviews.map((preview) => preview.ownerId));
  const stale = existing.filter((variant) => !nextVariantIds.has(variant.ownerId));
  const staleProducts = existingProducts.filter((product) => !nextProductIds.has(product.ownerId));

  const setInputs = previews.flatMap(metafieldsForPreview);
  const productSetInputs = productPreviews.flatMap(metafieldsForPreview);
  const clearInputs = stale.flatMap(metafieldIdentifiersForOwner);
  const productClearInputs = staleProducts.flatMap(metafieldIdentifiersForOwner);
  const report = {
    generatedAt: new Date().toISOString(),
    store: STORE,
    apiVersion: API_VERSION,
    authMode: ADMIN_TOKEN ? 'admin-access-token' : 'client-credentials',
    mode: CLEAR ? 'clear' : APPLY ? 'apply' : 'dry-run',
    includeAllItems: INCLUDE_ALL_ITEMS,
    ttlHours: TTL_HOURS,
    discountCount: discounts.length,
    previewVariantCount: previews.length,
    previewProductCount: productPreviews.length,
    staleVariantCount: stale.length,
    staleProductCount: staleProducts.length,
    metafieldsToSet: setInputs.length + productSetInputs.length,
    metafieldsToClear: clearInputs.length + productClearInputs.length,
    skipped,
    previews,
    productPreviews,
    stale,
    staleProducts,
  };

  const reportPath = await saveReport(report);
  console.log(JSON.stringify({
    mode: report.mode,
    reportPath,
    discountCount: report.discountCount,
    previewVariantCount: report.previewVariantCount,
    previewProductCount: report.previewProductCount,
    staleVariantCount: report.staleVariantCount,
    staleProductCount: report.staleProductCount,
    skipped: skipped.map((item) => `${item.title}: ${item.reason}`),
  }, null, 2));

  if (!APPLY && !CLEAR) {
    console.log('Dry run only. Re-run with --apply to write preview metafields.');
    return;
  }

  if (CLEAR) {
    const allClearInputs = [...clearInputs, ...productClearInputs];
    if (allClearInputs.length > 0) await deleteMetafields(allClearInputs);
    console.log(`Cleared ${stale.length} stale sale-preview variants and ${staleProducts.length} products.`);
    return;
  }

  const allSetInputs = [...setInputs, ...productSetInputs];
  const allClearInputs = [...clearInputs, ...productClearInputs];
  if (allSetInputs.length > 0) await writeMetafields(allSetInputs);
  if (allClearInputs.length > 0) await deleteMetafields(allClearInputs);
  console.log(`Applied sale previews for ${previews.length} variants and ${productPreviews.length} products, then cleared ${stale.length} stale variants and ${staleProducts.length} products.`);
}

await main();
