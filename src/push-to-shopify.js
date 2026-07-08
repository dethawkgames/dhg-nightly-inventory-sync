import fetch from "node-fetch";
import { config } from "./config.js";

async function getAccessToken() {
  const url = `https://${config.shopify.shopDomain}/admin/oauth/access_token`;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.shopify.clientId,
    client_secret: config.shopify.clientSecret,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function graphql(token, query, variables) {
  const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function findVariantBySku(token, sku) {
  const query = `
    query FindVariant($query: String!) {
      productVariants(first: 1, query: $query) {
        edges { node { id product { id } } }
      }
    }
  `;
  const data = await graphql(token, query, { query: `sku:${sku}` });
  const edge = data.productVariants.edges[0];
  return edge ? edge.node : null;
}

async function updateVariantPolicy(token, productId, variantId, inventoryPolicy) {
  const mutation = `
    mutation UpdatePolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }
  `;
  const data = await graphql(token, mutation, {
    productId,
    variants: [{ id: variantId, inventoryPolicy: inventoryPolicy.toUpperCase() }],
  });
  const errors = data.productVariantsBulkUpdate.userErrors;
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
}

/**
 * @param {Array<{sku: string, oldPolicy: string, newPolicy: string, source: string}>} changes
 */
export async function pushToShopify(changes) {
  if (changes.length === 0) {
    console.log("No changes to push to Shopify.");
    return { succeeded: [], failed: [] };
  }

  const token = await getAccessToken();
  const succeeded = [];
  const failed = [];

  for (const change of changes) {
    try {
      const variant = await findVariantBySku(token, change.sku);
      if (!variant) {
        failed.push({ ...change, reason: "SKU not found in Shopify" });
        continue;
      }
      await updateVariantPolicy(token, variant.product.id, variant.id, change.newPolicy);
      succeeded.push(change);
    } catch (err) {
      failed.push({ ...change, reason: err.message });
    }
  }

  console.log(`Shopify push: ${succeeded.length} succeeded, ${failed.length} failed`);
  return { succeeded, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sample = JSON.parse(process.argv[2] || "[]");
  pushToShopify(sample)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error("Shopify push failed:", err);
      process.exit(1);
    });
}
