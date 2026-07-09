import { google } from "googleapis";
import { config } from "./config.js";

// NOTE: This intentionally ports only process_alliance() and
// process_garland() from the original update_inventory.py.
// process_asmodee() and process_instock() are NOT included here —
// both Asmodee files stay on the existing weekly/manual review flow.

function getAuth() {
  const creds = JSON.parse(config.googleServiceAccountJson);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function readTab(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${tabName}!A:ZZ`,
  });
  const [header, ...rows] = res.data.values || [[]];
  return rows.map((row) => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = row[i] ?? ""));
    return obj;
  });
}

function indexBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = (row[key] || "").toString().trim();
    if (k) map.set(k, row);
  }
  return map;
}

export async function updatePolicy() {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const master = await readTab(sheets, config.masterTab);
  const alliance = await readTab(sheets, config.allianceTab);
  const garland = await readTab(sheets, config.garlandTab);

  // Snapshot BEFORE any mutation — mirrors `original_policy = master[...].copy()`
  // in update_inventory.py. All rules below apply to the same in-memory rows;
  // the diff is computed ONCE at the very end, not after each individual rule.
  // This matters: without it, a row that gets flipped deny→continue across two
  // rules produces two separate "changes" (and two separate Shopify API calls)
  // instead of one — which is what happened on the first real run.
  const originalPolicy = new Map(master.map((row) => [row, row["Variant Inventory Policy"]]));

  // ── Alliance / Universal Dist — Step 1: blanket-set alliance-tagged to "deny"
  for (const row of master) {
    const tags = (row["Tags"] || "").toLowerCase();
    if (tags.includes("alliance")) {
      row["Variant Inventory Policy"] = "deny";
    }
  }

  // ── Alliance / Universal Dist — Step 2: RDL correction across ALL rows
  // (no tag filter — matches original Python exactly)
  const allianceByVendorItemNo = indexBy(alliance, "Vendor Item No.");
  for (const row of master) {
    const sku = (row["Variant SKU"] || "").trim();
    const supplierRow = allianceByVendorItemNo.get(sku);
    if (!supplierRow) continue; // no match → leave untouched, same as original

    const rdl = (supplierRow["RDL"] || "").trim();
    if (rdl === "Yes") row["Variant Inventory Policy"] = "continue";
    else if (rdl === "No") row["Variant Inventory Policy"] = "deny";
  }

  // ── Garland — runs after Alliance, can override its result for matched SKUs
  const garlandYesIds = new Set(
    garland
      .filter((r) => (r["GARLAND"] || "").trim().toLowerCase() === "yes")
      .map((r) => (r["ItemID"] || "").trim())
  );
  for (const row of master) {
    const acddSku = (row["ACDD SKU"] || "").trim();
    if (garlandYesIds.has(acddSku)) {
      row["Variant Inventory Policy"] = "continue";
    }
  }

  // ── Single before/after diff, one entry per row — this is what actually
  // gets pushed to Shopify, so each SKU is touched at most once per run.
  const changes = [];
  for (const row of master) {
    const before = originalPolicy.get(row);
    const after = row["Variant Inventory Policy"];
    if (after !== before) {
      changes.push({ sku: row["Variant SKU"], oldPolicy: before, newPolicy: after });
    }
  }

  // ── Write updated master back ────────────────────────────────────
  if (changes.length > 0) {
    const header = Object.keys(master[0]);
    const grid = [header, ...master.map((row) => header.map((h) => row[h] ?? ""))];
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${config.masterTab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: grid },
    });
  }

  console.log(`Policy changes: ${changes.length}`);
  return changes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  updatePolicy()
    .then((changes) => console.log(JSON.stringify(changes, null, 2)))
    .catch((err) => {
      console.error("Policy update failed:", err);
      process.exit(1);
    });
}
