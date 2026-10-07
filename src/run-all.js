import "dotenv/config";
import { downloadAll } from "./download.js";
import { syncToSheets } from "./sync-to-sheets.js";
import { updatePolicy } from "./update-policy.js";
import { pushToShopify, getAccessToken } from "./push-to-shopify.js";
import { findAtRiskOrders, fetchLockedOrderSkus, findOrdersForNewlyContinueSkus } from "./asmodee-orders-check.js";
import { notifyRunResult } from "./notify.js";

async function main() {
  try {
    console.log("Step 1/4: downloading UD + Garland files...");
    const { udPath, garlandPath } = await downloadAll();

    console.log("Step 2/4: syncing to Google Sheets...");
    const { udRowCount, garlandRowCount } = await syncToSheets({ udPath, garlandPath });

    console.log("Step 3/4: computing policy changes...");
    const changes = await updatePolicy();

    console.log("Step 4/4: pushing changed variants to Shopify...");
    const shopifyResult = await pushToShopify(changes);

    // At-risk orders: SKUs that just flipped CONTINUE -> DENY (and actually
    // landed in Shopify) while open orders still owe them to a customer.
    // A failure here must never block the digest email, so it's isolated.
    let atRisk = [];
    let atRiskError;
    const flippedToDeny = shopifyResult.succeeded.filter(
      (c) =>
        (c.newPolicy || "").toLowerCase() === "deny" &&
        (c.oldPolicy || "").toLowerCase() === "continue"
    );
    console.log(`Checking at-risk orders for ${flippedToDeny.length} newly-DENY SKUs...`);
    if (flippedToDeny.length > 0) {
      try {
        const token = await getAccessToken();
        const lockedOrderSkus = await fetchLockedOrderSkus();
        console.log(`  ${lockedOrderSkus.size} (order, SKU) pairs already locked into a supplier order`);
        atRisk = await findAtRiskOrders(token, flippedToDeny, lockedOrderSkus);
      } catch (err) {
        console.error("At-risk order check failed:", err);
        atRiskError = err;
      }
    }

    // Open orders waiting on SKUs that just flipped DENY -> CONTINUE (and
    // actually landed in Shopify). Isolated like the check above so a
    // failure here can never block the digest email.
    let awaitingOrders = [];
    let awaitingOrdersError;
    let awaitingOrdersWarning;
    const flippedToContinue = shopifyResult.succeeded.filter(
      (c) =>
        (c.newPolicy || "").toLowerCase() === "continue" &&
        (c.oldPolicy || "").toLowerCase() === "deny"
    );
    console.log(`Checking open orders for ${flippedToContinue.length} newly-CONTINUE SKUs...`);
    if (flippedToContinue.length > 0) {
      try {
        const token = await getAccessToken();
        // If Order Needs can't be read, still send the list (unfiltered) with a
        // warning, so it can be cross-checked by hand.
        let lockedOrderSkus = new Set();
        try {
          lockedOrderSkus = await fetchLockedOrderSkus();
        } catch (err) {
          console.error("Order Needs read failed; sending unfiltered open-order list:", err);
          awaitingOrdersWarning = `Order Needs could not be read (${err.message || err}), so the "already ordered" exclusion was NOT applied. Cross-check this list against Order Needs manually.`;
        }
        awaitingOrders = await findOrdersForNewlyContinueSkus(token, flippedToContinue, lockedOrderSkus);
        console.log(`  ${awaitingOrders.length} open order line(s) found`);
      } catch (err) {
        console.error("Open-order check for newly-CONTINUE SKUs failed:", err);
        awaitingOrdersError = err;
      }
    }

    await notifyRunResult({ udRowCount, garlandRowCount, changes, shopifyResult, atRisk, atRiskError, awaitingOrders, awaitingOrdersError, awaitingOrdersWarning });
    console.log("Nightly sync complete.");
  } catch (error) {
    console.error("Nightly sync failed:", error);
    await notifyRunResult({ error }).catch(() => {});
    process.exit(1);
  }
}

main();
