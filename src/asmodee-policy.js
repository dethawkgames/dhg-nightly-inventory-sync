import { google } from "googleapis";
import { config } from "./config.js";

// ── Garland SKU set ──────────────────────────────────────────────────────
//
// NOTE: this intentionally does NOT reuse update-policy.js's Alliance-style
// matching (master-tab "ACDD SKU" column -> Garland "GARLAND"==Yes column).
// Two reasons:
//   1. That match depends on Sheet1 (the master tab), which is confirmed
//      stale — at least 2 of 5 spot-checked recent Asmodee products aren't
//      in it at all (Sept 2026). This job intentionally has zero Sheet1
//      dependency so it isn't exposed to that gap.
//   2. The Garland tab's actual column header is "MIDDLETOWN", not
//      "GARLAND" — update-policy.js's `row["GARLAND"] === "Yes"` check
//      appears to always be false against the live sheet, which likely
//      means Alliance's Garland override isn't firing in production
//      right now either. Worth fixing separately; not replicated here.
//
// Instead: simple presence of a SKU's ItemID in the Garland tab qualifies
// it for CONTINUE, regardless of Status — this matches the standing
// instruction documented in the asmodee-inventory-policy skill (Step 6)
// and is a deliberately conservative, easy-to-audit rule. Revisit this
// once Alliance/Garland gets rebuilt, to keep both pipelines consistent.
export async function fetchGarlandSkus() {
  const creds = JSON.parse(config.googleServiceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${config.garlandTab}!A:A`,
  });
  const rows = res.data.values || [];
  const skus = new Set();
  for (const row of rows.slice(1)) {
    const sku = (row[0] || "").trim();
    if (sku) skus.add(sku);
  }
  return skus;
}

// ── Target policy computation ────────────────────────────────────────────
//
// Priority order per variant:
//   1. Active preorder (tag `preorder` + unexpired `release-date-*` tag)
//      -> forced CONTINUE, mirrors Step 3a of the weekly skill
//   2. SKU present in Garland -> forced CONTINUE (see note above)
//   3. SKU found on store.asmodee.com -> CONTINUE if available, else DENY
//   4. No B2C signal and not in Garland -> untouched (still governed only
//      by the weekly report-based asmodee-inventory-policy skill)
export function computeAsmodeeTargets(variants, b2cAvailability, garlandSkus) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const results = [];

  for (const v of variants) {
    const product = v.product;
    if (!product) continue;

    const sku = (v.sku || "").trim();
    const tags = product.tags || [];

    if (tags.includes("preorder")) {
      const releaseTag = tags.find((t) => t.startsWith("release-date-"));
      let stillPreorder = true;
      if (releaseTag) {
        const releaseDate = releaseTag.replace("release-date-", "");
        stillPreorder = releaseDate >= today; // ISO date strings compare correctly as strings
      }
      if (stillPreorder) {
        results.push({
          variantId: v.id, productId: product.id, sku, title: product.title,
          handle: product.handle, currentPolicy: v.inventoryPolicy,
          targetPolicy: "CONTINUE", reason: "preorder-override",
        });
        continue;
      }
    }

    if (garlandSkus.has(sku)) {
      results.push({
        variantId: v.id, productId: product.id, sku, title: product.title,
        handle: product.handle, currentPolicy: v.inventoryPolicy,
        targetPolicy: "CONTINUE", reason: "garland-override",
      });
      continue;
    }

    if (!b2cAvailability.has(sku)) {
      continue; // no signal at all — leave untouched
    }

    const targetPolicy = b2cAvailability.get(sku) ? "CONTINUE" : "DENY";
    results.push({
      variantId: v.id, productId: product.id, sku, title: product.title,
      handle: product.handle, currentPolicy: v.inventoryPolicy,
      targetPolicy, reason: "b2c-availability",
    });
  }

  return results;
}

// ── Apply changes to Shopify ─────────────────────────────────────────────
//
// Deliberately NOT reusing push-to-shopify.js's pushToShopify() here —
// that function does a findVariantBySku lookup per change, which is
// redundant work since computeAsmodeeTargets() already carries variantId
// and productId straight from the bulk query. Reuses updateVariantPolicy
// (and its underlying graphql() retry/throttle handling) directly instead.
export async function applyAsmodeeChanges(token, changes, { dryRun = true } = {}) {
  const { updateVariantPolicy } = await import("./push-to-shopify.js");
  const applied = [];
  const failed = [];

  for (const c of changes) {
    if (dryRun) {
      applied.push(c);
      continue;
    }
    try {
      await updateVariantPolicy(token, c.productId, c.variantId, c.targetPolicy);
      applied.push(c);
    } catch (err) {
      failed.push({ ...c, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 150)); // same pacing as push-to-shopify.js
  }

  return { applied, failed };
}
