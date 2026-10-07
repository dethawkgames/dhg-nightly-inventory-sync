import { google } from "googleapis";
import { config } from "./config.js";
import { graphql } from "./push-to-shopify.js";

// ── Already-locked (Order Name, SKU) pairs ───────────────────────────────
//
// Reads the Order Needs tab from the Order Fulfillment Tracker (a
// different spreadsheet from the Product SKUs one). Presence of a row
// here — any Stage — means that unit is already locked into a supplier
// order (e.g. Monday's 9am Asmodee order), so the at-risk check should
// not re-flag it even if the item's policy just flipped to DENY.
export async function fetchLockedOrderSkus() {
  const creds = JSON.parse(config.googleServiceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.orderFulfillmentSpreadsheetId,
    range: `${config.orderNeedsTab}!A:B`, // Order Name, SKU
  });
  const rows = res.data.values || [];
  const locked = new Set();
  for (const row of rows.slice(1)) {
    const orderName = (row[0] || "").trim();
    const sku = (row[1] || "").trim();
    if (orderName && sku) locked.add(`${orderName}|${sku}`);
  }
  return locked;
}


// For every SKU that just became unsellable, check for open orders
// (unfulfilled or partial, excluding cancelled and refunded) that still
// owe a customer that item. Flagged separately in the digest since these
// are cases where a customer has already paid for something that may now
// be hard to supply — distinct from a plain policy-change notice.
export async function findAtRiskOrders(token, flippedToDeny, lockedOrderSkus = new Set()) {
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

      // Already locked into a supplier order (e.g. Monday's 9am Asmodee
      // order) — this unit is already being handled, don't re-flag it.
      if (lockedOrderSkus.has(`${order.name}|${sku}`)) continue;

      const matching = order.lineItems.edges
        .map((li) => li.node)
        .filter((li) => li.sku === sku && li.fulfillableQuantity > 0);

      if (matching.length > 0) {
        atRisk.push({
          orderName: order.name,
          customer: order.customer ? order.customer.displayName : "(no customer)",
          createdAt: order.createdAt,
          sku,
          title: change.title || matching[0].title,
          qty: matching.reduce((sum, li) => sum + li.fulfillableQuantity, 0),
        });
      }
    }
  }

  return atRisk;
}


// ── Orders waiting on items that just became sellable ────────────────────
//
// Counterpart to findAtRiskOrders(). For every SKU that just flipped
// DENY -> CONTINUE, find open orders that still owe a customer that item:
// not cancelled, not fully refunded, and with units that have not shipped
// (fulfillableQuantity > 0 also excludes units already fulfilled or
// refunded/removed at the line-item level, so partially-shipped and
// partially-refunded orders only report what is genuinely still owed).
//
// Same as findAtRiskOrders(): any (Order Name, SKU) pair already present in
// the Order Needs tracker (lockedOrderSkus) is skipped, since that unit is
// already locked into a supplier order and doesn't need flagging.
//
// `gql` is injectable only so the logic can be tested without Shopify.
export async function findOrdersForNewlyContinueSkus(token, flippedToContinue, lockedOrderSkus = new Set(), { gql = graphql } = {}) {
  const results = [];

  // One lookup per distinct SKU, even if a SKU appears twice in the change list.
  const bySku = new Map();
  for (const change of flippedToContinue) {
    const sku = (change.sku || "").trim();
    if (sku && !bySku.has(sku)) bySku.set(sku, change);
  }

  const query = `
    query($q: String!) {
      orders(first: 20, query: $q) {
        edges {
          node {
            id
            legacyResourceId
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

  for (const [sku, change] of bySku) {
    const searchQuery =
      `sku:${sku} AND -status:cancelled AND -financial_status:refunded ` +
      `AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)`;

    let data;
    try {
      data = await gql(token, query, { q: searchQuery });
    } catch (err) {
      console.warn(`  WARNING: order lookup failed for ${sku}: ${err.message}`);
      continue;
    }

    for (const edge of data.orders.edges) {
      const order = edge.node;

      // Already locked into a supplier order — already ordered, don't flag.
      if (lockedOrderSkus.has(`${order.name}|${sku}`)) continue;

      // Search is fuzzy; confirm the exact SKU and that units are still owed.
      const matching = order.lineItems.edges
        .map((li) => li.node)
        .filter((li) => li.sku === sku && li.fulfillableQuantity > 0);

      if (matching.length > 0) {
        results.push({
          orderName: order.name,
          orderId: order.legacyResourceId,
          customer: order.customer ? order.customer.displayName : "(no customer)",
          createdAt: order.createdAt,
          sku,
          title: change.title || matching[0].title,
          qty: matching.reduce((sum, li) => sum + li.fulfillableQuantity, 0),
        });
      }
    }

    await new Promise((r) => setTimeout(r, 100)); // light pacing; graphql() also retries on throttle
  }

  return results;
}
