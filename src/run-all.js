import { downloadAll } from "./download.js";
import { syncToSheets } from "./sync-to-sheets.js";
import { updatePolicy } from "./update-policy.js";
import { pushToShopify } from "./push-to-shopify.js";
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

    await notifyRunResult({ udRowCount, garlandRowCount, changes, shopifyResult });
    console.log("Nightly sync complete.");
  } catch (error) {
    console.error("Nightly sync failed:", error);
    await notifyRunResult({ error }).catch(() => {});
    process.exit(1);
  }
}

main();
