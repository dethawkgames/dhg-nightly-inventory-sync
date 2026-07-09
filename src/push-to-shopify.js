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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graphql(token, query, variables, attempt = 1) {
  const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  // Shopify uses a leaky-bucket cost budget. A 429, or a GraphQL-level
  // THROTTLED error even on a 200 response, both mean "back off and retry" —
  // this loop was previously missing entirely, so every throttle event was
  // treated as a hard failure.
  if (res.status === 429) {
    if (attempt > 5) throw new Error("Shopify rate limit: exhausted retries");
    const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await delay(retryAfter * 1000);
    return graphql(token, query, variables, attempt + 1);
  }

  const json = await res.json();

  const throttled = json.errors?.some(
    (e) => e.extensions?.code === "THROTTLED" || /throttled/i.test(e.message || "")
  );
  if (throttled) {
    if (attempt > 5) throw new Error("Shopify GraphQL throttled: exhausted retries");
    await delay(1000 * attempt);
    return graphql(token, query, variables, attempt + 1);
  }

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

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    try {
      const variant = await findVariantBySku(token, change.sku);
      if (!variant) {
        failed.push({ ...change, reason: "SKU not found in Shopify" });
      } else {
        await updateVariantPolicy(token, variant.product.id, variant.id, change.newPolicy);
        succeeded.push(change);
      }
    } catch (err) {
      failed.push({ ...change, reason: err.message });
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  ...${i + 1}/${changes.length} processed (${succeeded.length} ok, ${failed.length} failed)`);
    }

    // Small pacing delay to stay under Shopify's cost-based rate limit
    // rather than relying entirely on reactive retries.
    await delay(150);
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
