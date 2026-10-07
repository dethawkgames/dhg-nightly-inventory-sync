import "dotenv/config";
import { getAccessToken } from "./push-to-shopify.js";
import { fetchB2CAvailability } from "./asmodee-b2c.js";
import { fetchAsmodeeCatalog } from "./asmodee-shopify-catalog.js";
import { fetchGarlandSkus, computeAsmodeeTargets, applyAsmodeeChanges } from "./asmodee-policy.js";
import { findAtRiskOrders, fetchLockedOrderSkus, findOrdersForNewlyContinueSkus } from "./asmodee-orders-check.js";
import { notifyAsmodeeRunResult } from "./notify.js";

const DRY_RUN = (process.env.DRY_RUN || "true").trim().toLowerCase() !== "false";

async function main() {
  try {
    console.log(`Starting Asmodee nightly sync (DRY_RUN=${DRY_RUN})`);

    console.log("Step 1: fetching B2C availability from store.asmodee.com");
    const b2c = await fetchB2CAvailability();
    console.log(`  ${b2c.size} SKUs fetched`);

    console.log("Step 2: fetching Garland SKU set (read-only)");
    const garlandSkus = await fetchGarlandSkus();
    console.log(`  ${garlandSkus.size} SKUs in Garland tab`);

    console.log("Step 3: authenticating to Shopify + pulling asmodee-tagged catalog");
    const token = await getAccessToken();
    const { productsById, variants } = await fetchAsmodeeCatalog(token);
    console.log(`  ${productsById.size} products / ${variants.length} variants`);

    console.log("Step 4: computing target policies");
    const targets = computeAsmodeeTargets(variants, b2c, garlandSkus);
    const changes = targets.filter((t) => t.targetPolicy !== t.currentPolicy);
    console.log(`  ${changes.length} variants need a policy change`);

    console.log(`Step 5: applying changes${DRY_RUN ? " (dry run — no live writes)" : ""}`);
    const { applied, failed } = await applyAsmodeeChanges(token, changes, { dryRun: DRY_RUN });

    const flippedToDeny = applied.filter((c) => c.targetPolicy === "DENY" && c.reason === "b2c-availability");
    console.log(`Step 6: checking at-risk orders for ${flippedToDeny.length} newly-DENY SKUs`);
    let atRisk = [];
    if (flippedToDeny.length > 0) {
      const lockedOrderSkus = await fetchLockedOrderSkus();
      console.log(`  ${lockedOrderSkus.size} (order, SKU) pairs already locked into a supplier order`);
      atRisk = await findAtRiskOrders(token, flippedToDeny, lockedOrderSkus);
    }

    // Open orders waiting on SKUs that just flipped DENY -> CONTINUE.
    // Isolated so a failure here can never block the digest email.
    const flippedToContinue = applied.filter(
      (c) => c.targetPolicy === "CONTINUE" && (c.currentPolicy || "").toUpperCase() === "DENY"
    );
    console.log(`Step 7: checking open orders for ${flippedToContinue.length} newly-CONTINUE SKUs`);
    let awaitingOrders = [];
    let awaitingOrdersError;
    let awaitingOrdersWarning;
    if (flippedToContinue.length > 0) {
      try {
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

    console.log("Step 8: sending digest (if there's anything to report)");
    await notifyAsmodeeRunResult({ applied, failed, atRisk, awaitingOrders, awaitingOrdersError, awaitingOrdersWarning, dryRun: DRY_RUN });

    console.log("Asmodee nightly sync complete.");
  } catch (error) {
    console.error("Asmodee nightly sync failed:", error);
    await notifyAsmodeeRunResult({ error, dryRun: DRY_RUN }).catch(() => {});
    process.exit(1);
  }
}

main();
