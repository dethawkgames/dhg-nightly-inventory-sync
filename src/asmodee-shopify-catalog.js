import { config } from "./config.js";
import { graphql } from "./push-to-shopify.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Bulk operations are the only sane way to pull ~3,000 products —
// paginating productVariants(first: 250) would be 12+ round trips just
// for Asmodee, and this repo will eventually want the same for the full
// catalog. See asmodee-inventory-policy SKILL.md for the pattern this
// mirrors (same query shape, same polling approach).
export async function fetchAsmodeeCatalog(token) {
  const startMutation = `
    mutation {
      bulkOperationRunQuery(
        query: "{ products(query: \\"tag:asmodee\\") { edges { node { id handle title tags variants { edges { node { id sku inventoryPolicy } } } } } } }"
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;
  const start = await graphql(token, startMutation);
  const startErrors = start.bulkOperationRunQuery.userErrors;
  if (startErrors.length > 0) {
    throw new Error(`bulkOperationRunQuery failed: ${JSON.stringify(startErrors)}`);
  }

  const pollQuery = `{ currentBulkOperation { id status objectCount url errorCode } }`;
  let resultUrl = null;
  for (let i = 0; i < 60; i++) {
    await delay(20000);
    const data = await graphql(token, pollQuery);
    const op = data.currentBulkOperation;
    console.log(`  bulk op status: ${op.status} (${op.objectCount ?? "?"} objects)`);
    if (op.status === "COMPLETED") {
      resultUrl = op.url;
      break;
    }
    if (op.status === "FAILED" || op.status === "CANCELED") {
      throw new Error(`Bulk operation ${op.status}: ${op.errorCode}`);
    }
  }
  if (!resultUrl) throw new Error("Bulk operation timed out after ~20 minutes");

  const res = await fetch(resultUrl);
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim());

  const productsById = new Map();
  const variants = [];
  for (const line of lines) {
    const obj = JSON.parse(line);
    if (!obj.__parentId) {
      productsById.set(obj.id, {
        id: obj.id,
        handle: obj.handle,
        title: obj.title,
        tags: obj.tags || [],
      });
    } else {
      variants.push(obj);
    }
  }

  for (const v of variants) {
    v.product = productsById.get(v.__parentId);
  }

  return { productsById, variants };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getAccessToken } = await import("./push-to-shopify.js");
  const token = await getAccessToken();
  const { productsById, variants } = await fetchAsmodeeCatalog(token);
  console.log(`${productsById.size} products / ${variants.length} variants`);
}
