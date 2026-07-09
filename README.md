# DHG Nightly Inventory Sync

Replaces the "daily inventory download" and "update inventory policy" Cowork
tasks with one unattended GitHub Actions job. Only touches Universal
Distribution ("Alliance" tab) and Garland/ACDD. **Asmodee and In Stock are
intentionally excluded** — both stay on the existing weekly manual review
flow, unchanged.

## One-time setup

### 1. Confirm the master tab name
Open `update_inventory.py` and find the `WORKSHEET_NAME` value it used to
load the master product list from Google Sheets. Set it as a repo variable:

`Settings → Secrets and variables → Actions → Variables → MASTER_TAB_NAME`

### 2. Selectors are confirmed
Both UD (login + export) and ACDD (Garland row Excel link) selectors in
`src/download.js` were confirmed with `playwright codegen`. One caveat:
the Garland link is matched positionally (3rd "Excel" link on the page),
since ACDD's markup doesn't cleanly associate the link with row text. If
ACDD ever reorders their inventory table, this could grab the wrong
warehouse's file — worth a periodic spot-check.

### 3. Add repo secrets
`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|---|---|
| `UD_USERNAME` / `UD_PASSWORD` | Universal Distribution login |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The same service account JSON your other Sheets scripts use, as one line |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | From the "DHG Automation" custom app in the Shopify Dev Dashboard |
| `RESEND_API_KEY` | Same key your other notification emails use |

### 4. Confirm the Shopify app is installed on the store
The client credentials grant only works once "DHG Automation" is installed
on `detective-hawk-games.myshopify.com` with the scopes it already has
(`write_products` covers the inventory policy update). If it's not
installed yet: Dev Dashboard → DHG Automation → Install → select the store.

### 5. Test it
```bash
npm install
npx playwright install --with-deps chromium
npm run run-all
```

Or push to GitHub and trigger it manually from the Actions tab
("Run workflow" button — works because of `workflow_dispatch` in the
schedule file) before letting it run unattended overnight.

## What each script does
- `src/download.js` — Playwright, logs into UD + ACDD, downloads both files
- `src/sync-to-sheets.js` — writes both files into the `Alliance` / `Garland` tabs
- `src/update-policy.js` — ports **only** the Alliance + Garland logic from
  `update_inventory.py`; returns a diff of changed SKUs
- `src/push-to-shopify.js` — gets a fresh Admin API token via client
  credentials grant, pushes only the changed variants
- `src/notify.js` — emails a summary (changes + anything that needs manual review)
- `src/run-all.js` — runs all four in order, notifies on success or failure

## Seasonal note
The cron in `.github/workflows/nightly-inventory-sync.yml` is set for EDT
(UTC-4). When clocks fall back to EST in November, change `30 11 * * *` to
`30 12 * * *` to keep the 7:30am ET run time.
