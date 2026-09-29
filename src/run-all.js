import "dotenv/config";
import { downloadAll } from "./download.js";
import { syncToSheets } from "./sync-to-sheets.js";
import { updatePolicy } from "./update-policy.js";
import { pushToShopify, getAccessToken } from "./push-to-shopify.js";
import { findAtRiskOrders, fetchLockedOrderSkus } from "./asmodee-orders-check.js";
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

    await notifyRunResult({ udRowCount, garlandRowCount, changes, shopifyResult, atRisk, atRiskError });
    console.log("Nightly sync complete.");
  } catch (error) {
    console.error("Nightly sync failed:", error);
    await notifyRunResult({ error }).catch(() => {});
    process.exit(1);
  }
}

main();
