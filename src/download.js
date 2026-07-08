import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

/**
 * IMPORTANT — selectors below are best-effort placeholders.
 * Before the first real run, record the exact click-path with:
 *
 *   npx playwright codegen https://us.universaldist.com/home
 *   npx playwright codegen https://www.acdd.com/inventory
 *
 * and paste in the real selectors it generates. Codegen will give you
 * exact, working selectors in about 2 minutes — much more reliable
 * than guessing from the outside.
 */

async function ensureDownloadDir() {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
}

async function downloadUD(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(config.ud.loginUrl, { waitUntil: "networkidle" });

  // TODO: confirm these selectors with playwright codegen
  await page.getByRole('link').filter({ hasText: 'Account' }).click();
  await page.getByRole('link', { name: 'Login' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).fill('iain@detectivehawkgames.com');
  await page.getByRole('textbox', { name: 'password' }).click();
  await page.getByRole('textbox', { name: 'password' }).fill('Pineapples345!');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState("networkidle");
 

  // Profile menu (labeled "DETECTIVE HAWK...") → Export Inventory → CSV
  await page.click('text=/DETECTIVE HAWK/i');
  await page.click("text=Export Inventory");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('text=/CSV \\(\\.csv\\)/i'),
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

  // TODO: confirm selectors — ACDD may show a login form first, or may
  // already be reachable with a stored session depending on their auth setup
  if (await page.locator('input[type="email"], input[name="email"]').first().isVisible().catch(() => false)) {
    await page.fill('input[type="email"], input[name="email"]', config.acdd.username);
    await page.fill('input[type="password"], input[name="password"]', config.acdd.password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");
  }

  const garlandRow = page.locator('tr:has-text("Garland, TX")');
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    garlandRow.locator("text=Excel").click(),
  ]);

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
