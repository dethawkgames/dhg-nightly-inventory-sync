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

/**
 * page.goto with retries.
 *
 * "networkidle" was causing false timeouts: it requires 500ms with zero
 * in-flight network requests, which some sites (chat widgets, analytics
 * beacons, polling scripts) never actually reach. We wait for
 * "domcontentloaded" instead, which fires as soon as the DOM is ready —
 * the subsequent getByRole()/click() calls already auto-wait for their
 * target elements to be present and actionable, so we don't need the
 * page to go fully network-quiet first.
 *
 * We still retry a couple of times with backoff in case UD's site is
 * just slow to respond on a given night.
 */
async function gotoWithRetry(page, url, { retries = 2, timeout = 45000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt <= retries) {
        const backoffMs = 5000 * attempt;
        console.warn(
          `goto ${url} failed (attempt ${attempt}/${retries + 1}): ${err.message}. Retrying in ${backoffMs}ms...`
        );
        await page.waitForTimeout(backoffMs);
      }
    }
  }
  throw lastErr;
}

async function downloadUD(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await gotoWithRetry(page, config.ud.loginUrl);

  // Selectors confirmed via playwright codegen
  await page.getByRole('link').filter({ hasText: 'Account' }).click();
  await page.getByRole('link', { name: 'Login' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).fill(config.ud.username);
  await page.getByRole('textbox', { name: 'Email Address' }).press('Tab');
  await page.getByRole('textbox', { name: 'password' }).fill(config.ud.password);
  await page.getByRole('button', { name: 'Login' }).click();
  // Wait for the post-login profile link itself rather than for the network
  // to go fully idle — same flakiness reasoning as gotoWithRetry above.
  await page.getByRole('link').filter({ hasText: 'DETECTIVE HAWK GAMES' }).waitFor({ timeout: 45000 });

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

  await gotoWithRetry(page, config.acdd.inventoryUrl);

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
