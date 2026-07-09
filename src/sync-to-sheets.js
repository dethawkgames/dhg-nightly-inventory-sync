import fs from "fs";
import Papa from "papaparse";
import XLSX from "xlsx";
import { google } from "googleapis";
import { config } from "./config.js";

function getAuth() {
  const creds = JSON.parse(config.googleServiceAccountJson);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });
  return data;
}

function parseXlsx(filePath, headerRowIndex = 0) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  // headerRowIndex mirrors pandas' `header=N` — Garland's real headers
  // start on the 3rd row (index 2), matching the original Python script.
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: "",
    range: headerRowIndex,
  });
}

// Convert an array of row objects into a 2D array (header row + data rows)
function toGrid(rows) {
  if (rows.length === 0) return [[]];
  const headers = Object.keys(rows[0]);
  const grid = [headers];
  for (const row of rows) {
    grid.push(headers.map((h) => (row[h] === undefined ? "" : String(row[h]))));
  }
  return grid;
}

async function writeTab(sheets, tabName, grid) {
  // Clear the existing tab, then write fresh data — this tab reflects
  // only the latest download each run, same as the old local-file model.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.sheetId,
    range: `${tabName}!A:ZZ`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: grid },
  });
}

export async function syncToSheets({ udPath, garlandPath }) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const udRows = parseCsv(udPath);
  const garlandRows = parseXlsx(garlandPath, 2); // header=2, matches update_inventory.py

  await writeTab(sheets, config.allianceTab, toGrid(udRows));
  await writeTab(sheets, config.garlandTab, toGrid(garlandRows));

  console.log(`Wrote ${udRows.length} rows to "${config.allianceTab}"`);
  console.log(`Wrote ${garlandRows.length} rows to "${config.garlandTab}"`);

  return { udRowCount: udRows.length, garlandRowCount: garlandRows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncToSheets({
    udPath: `${config.downloadDir}/Inventory_Export.csv`,
    garlandPath: `${config.downloadDir}/garland-inventory.xlsx`,
  })
    .then((r) => console.log("Sync complete:", r))
    .catch((err) => {
      console.error("Sync failed:", err);
      process.exit(1);
    });
}
