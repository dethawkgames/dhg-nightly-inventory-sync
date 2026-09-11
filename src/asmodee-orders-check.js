import { graphql } from "./push-to-shopify.js";

// For every SKU that just became unsellable, check for open orders
// (unfulfilled or partial, excluding cancelled and refunded) that still
// owe a customer that item. Flagged separately in the digest since these
// are cases where a customer has already paid for something that may now
// be hard to supply — distinct from a plain policy-change notice.
export async function findAtRiskOrders(token, flippedToDeny) {
  const atRisk = [];

  for (const change of flippedToDeny) {
    const sku = change.sku;
    const searchQuery =
      `sku:${sku} AND -status:cancelled AND -financial_status:refunded ` +
      `AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)`;

    const query = `
      query($q: String!) {
        orders(first: 20, query: $q) {
          edges {
            node {
              name
              createdAt
              customer { displayName }
              lineItems(first: 50) {
                edges { node { sku title quantity fulfillableQuantity } }
              }
            }
          }
        }
      }
    `;

    let data;
    try {
      data = await graphql(token, query, { q: searchQuery });
    } catch (err) {
      console.warn(`  WARNING: order lookup failed for ${sku}: ${err.message}`);
      continue;
    }

    for (const edge of data.orders.edges) {
      const order = edge.node;
      const matching = order.lineItems.edges
        .map((li) => li.node)
        .filter((li) => li.sku === sku && li.fulfillableQuantity > 0);

      if (matching.length > 0) {
        atRisk.push({
          orderName: order.name,
          customer: order.customer ? order.customer.displayName : "(no customer)",
          createdAt: order.createdAt,
          sku,
          title: change.title,
          qty: matching.reduce((sum, li) => sum + li.fulfillableQuantity, 0),
        });
      }
    }
  }

  return atRisk;
}
