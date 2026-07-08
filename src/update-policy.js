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

  const changes = []; // { sku, oldPolicy, newPolicy }

  // ── Alliance / Universal Dist ────────────────────────────────────
  // 1. Reset all alliance-tagged products to "deny"
  // 2. Match Vendor Item No. → Variant SKU; RDL=Yes → "continue", RDL=No → "deny"
  const allianceByVendorItemNo = indexBy(alliance, "Vendor Item No.");

  for (const row of master) {
    const tags = (row["Tags"] || "").toLowerCase();
    if (!tags.includes("alliance")) continue;

    const sku = (row["Variant SKU"] || "").trim();
    const oldPolicy = row["Variant Inventory Policy"];

    const supplierRow = allianceByVendorItemNo.get(sku);
    const newPolicy = supplierRow && (supplierRow["RDL"] || "").trim().toLowerCase() === "yes"
      ? "continue"
      : "deny";

    if (newPolicy !== oldPolicy) {
      changes.push({ sku, oldPolicy, newPolicy, source: "alliance" });
      row["Variant Inventory Policy"] = newPolicy;
    }
  }

  // ── Garland ───────────────────────────────────────────────────────
  // Match ItemID → ACDD SKU; GARLAND=Yes → "continue"
  const garlandYesIds = new Set(
    garland
      .filter((r) => (r["GARLAND"] || "").trim().toLowerCase() === "yes")
      .map((r) => (r["ItemID"] || "").trim())
  );

  for (const row of master) {
    const acddSku = (row["ACDD SKU"] || "").trim();
    if (!garlandYesIds.has(acddSku)) continue;

    const oldPolicy = row["Variant Inventory Policy"];
    if (oldPolicy !== "continue") {
      changes.push({ sku: row["Variant SKU"], oldPolicy, newPolicy: "continue", source: "garland" });
      row["Variant Inventory Policy"] = "continue";
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
