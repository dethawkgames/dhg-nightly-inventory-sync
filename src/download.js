import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

/**
 * Both flows below are confirmed via playwright codegen:
 * - UD requires login, then Account → Export Inventory → CSV
 * - ACDD needs no login; the Garland, TX row is the 3rd "Excel" link
 *   on the page (positional — see caveat comment in downloadGarland)
 */

async function ensureDownloadDir() {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
}

async function downloadUD(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(config.ud.loginUrl, { waitUntil: "networkidle" });

  // Selectors confirmed via playwright codegen
  await page.getByRole('link').filter({ hasText: 'Account' }).click();
  await page.getByRole('link', { name: 'Login' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).fill(config.ud.username);
  await page.getByRole('textbox', { name: 'Email Address' }).press('Tab');
  await page.getByRole('textbox', { name: 'password' }).fill(config.ud.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState("networkidle");

  // Profile menu (labeled "DETECTIVE HAWK GAMES") → Export Inventory → CSV
  // Selectors confirmed via playwright codegen
  await page.getByRole('link').filter({ hasText: 'DETECTIVE HAWK GAMES' }).click();
  await page.getByRole('link', { name: 'Export Inventory' }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole('button', { name: 'CSV (.csv)' }).click(),
  ]);

  const destPath = path.join(config.downloadDir, "Inventory_Export.csv");
  await download.saveAs(destPath);
  await context.close();
  return destPath;
}

async function downloadGarland(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(config.acdd.inventoryUrl, { waitUntil: "networkidle" });

  // Confirmed via playwright codegen: the Garland, TX row's Excel link is
  // the 3rd "Excel" link on the page (nth(2), zero-indexed), and clicking
  // it fires both a popup and a download event.
  //
  // CAVEAT: this is positional, not matched by row text. If ACDD ever
  // reorders the inventory table, this will silently grab the wrong
  // warehouse's file. Worth spot-checking occasionally, or tightening
  // to a row-scoped locator if ACDD's markup allows it.
  const [popup, download] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Excel" }).nth(2).click(),
  ]);
  await popup.close();

  const destPath = path.join(config.downloadDir, "garland-inventory.xlsx");
  await download.saveAs(destPath);
  await context.close();
  return destPath;
}

export async function downloadAll() {
  await ensureDownloadDir();
  const browser = await chromium.launch({ headless: true });

  try {
    const udPath = await downloadUD(browser);
    const garlandPath = await downloadGarland(browser);
    return { udPath, garlandPath };
  } finally {
    await browser.close();
  }
}

// Allow running standalone: `node src/download.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  downloadAll()
    .then((paths) => console.log("Downloaded:", paths))
    .catch((err) => {
      console.error("Download failed:", err);
      process.exit(1);
    });
}
