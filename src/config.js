// Central config. Everything secret comes from environment variables —
// set these as GitHub Actions repo secrets, never commit real values.

export const config = {
  // ── Google Sheets ──────────────────────────────────────────────
  sheetId: "1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI",

  // Tabs confirmed by Iain: "Alliance" (old name for Universal Dist) and "Garland"
  allianceTab: "Alliance",
  garlandTab: "Garland",

  // TODO (confirm before first run): the tab name for the master product
  // list that has the "Variant Inventory Policy" / "Variant SKU" / "Tags"
  // columns. update_inventory.py loaded this via WORKSHEET_NAME — copy
  // that exact value here.
  masterTab: process.env.MASTER_TAB_NAME || "Master",

  // Google service account credentials, as a single-line JSON string
  // stored in the GOOGLE_SERVICE_ACCOUNT_JSON secret.
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,

  // ── Universal Distribution ─────────────────────────────────────
  ud: {
    loginUrl: "https://us.universaldist.com/home",
    username: process.env.UD_USERNAME,
    password: process.env.UD_PASSWORD,
  },

  // ── ACDD ────────────────────────────────────────────────────────
  // No login required — inventory page is publicly reachable.
  acdd: {
    inventoryUrl: "https://www.acdd.com/inventory",
  },

  // ── Shopify ─────────────────────────────────────────────────────
  shopify: {
    shopDomain: "detective-hawk-games.myshopify.com",
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    apiVersion: "2026-01", // bump as Shopify deprecates old versions
  },

  // ── Notifications ────────────────────────────────────────────────
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    to: "iain@detectivehawkgames.com",
    from: "Detective Hawk Games <hello@detectivehawkgames.com>",
  },

  // Where downloaded files land during a run (ephemeral runner workspace)
  downloadDir: process.env.DOWNLOAD_DIR || "./tmp",
};
