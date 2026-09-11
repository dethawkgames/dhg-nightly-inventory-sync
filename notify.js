import fetch from "node-fetch";
import { config } from "./config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendEmail({ subject, html }) {
  const body = {
    from: config.resend.from,
    to: config.resend.to,
    subject,
    html,
  };

  await delay(550);

  let res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    await delay(1500);
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resend.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    console.error("Resend send failed:", res.status, await res.text());
  }
}

export async function notifyRunResult({ udRowCount, garlandRowCount, changes, shopifyResult, error }) {
  if (error) {
    await sendEmail({
      subject: "⚠️ Nightly inventory sync failed",
      html: `<p>The nightly UD + Garland inventory sync failed.</p><pre>${String(error.stack || error)}</pre>`,
    });
    return;
  }

  const failedRows = shopifyResult.failed;
  const subject = failedRows.length > 0
    ? `Nightly inventory sync: ${changes.length} changed, ${failedRows.length} need review`
    : `Nightly inventory sync: ${changes.length} changed, all pushed OK`;

  const rowsHtml = changes
    .map((c) => `<li>${c.sku} (${c.source}): ${c.oldPolicy || "—"} → ${c.newPolicy}</li>`)
    .join("");

  const failedHtml = failedRows.length > 0
    ? `<h3>Needs manual review</h3><ul>${failedRows
        .map((f) => `<li>${f.sku}: ${f.reason}</li>`)
        .join("")}</ul>`
    : "";

  await sendEmail({
    subject,
    html: `
      <p>UD rows synced: ${udRowCount} · Garland rows synced: ${garlandRowCount}</p>
      <h3>Policy changes (${changes.length})</h3>
      <ul>${rowsHtml || "<li>None</li>"}</ul>
      ${failedHtml}
      <p>Asmodee/In Stock unchanged — still on the weekly manual review flow.</p>
    `,
  });
}

// ── Asmodee nightly digest ────────────────────────────────────────────────
//
// Separate from notifyRunResult (Alliance/Garland) — different pipeline,
// different run schedule, sent only when there's something to report (a
// policy change or an at-risk order), never as a nightly heartbeat.
export async function notifyAsmodeeRunResult({ applied = [], failed = [], atRisk = [], dryRun = true, error }) {
  if (error) {
    await sendEmail({
      subject: "⚠️ Asmodee nightly sync failed",
      html: `<p>The Asmodee nightly inventory sync failed.</p><pre>${String(error.stack || error)}</pre>`,
    });
    return;
  }

  if (applied.length === 0 && failed.length === 0 && atRisk.length === 0) {
    console.log("Asmodee digest: nothing to report — skipping email.");
    return;
  }

  const prefix = dryRun ? "[DRY RUN] " : "";
  const toContinue = applied.filter((c) => c.targetPolicy === "CONTINUE");
  const toDeny = applied.filter((c) => c.targetPolicy === "DENY");

  const subject = `${prefix}Asmodee nightly sync: ${toContinue.length} to CONTINUE, ` +
    `${toDeny.length} to DENY${atRisk.length ? `, ${atRisk.length} at-risk order(s)` : ""}`;

  const atRiskHtml = atRisk.length > 0
    ? `
      <h3 style="color:#b00;">⚠ At-risk orders (item just went unsellable, order still open)</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Order</th><th>Customer</th><th>SKU</th><th>Product</th><th>Qty</th></tr>
        ${atRisk.map((r) => `<tr><td>${r.orderName}</td><td>${r.customer}</td><td>${r.sku}</td><td>${r.title}</td><td>${r.qty}</td></tr>`).join("")}
      </table>
    `
    : "";

  const denyHtml = toDeny.length > 0
    ? `<h3>Flipped to DENY</h3><ul>${toDeny.map((c) => `<li>${c.sku} — ${c.title}</li>`).join("")}</ul>`
    : "";

  const continueHtml = toContinue.length > 0
    ? `<h3>Flipped to CONTINUE</h3><ul>${toContinue.map((c) => `<li>${c.sku} — ${c.title} (${c.reason})</li>`).join("")}</ul>`
    : "";

  const failedHtmlAsmodee = failed.length > 0
    ? `<h3 style="color:#b00;">Failed updates</h3><ul>${failed.map((f) => `<li>${f.sku} — ${f.error}</li>`).join("")}</ul>`
    : "";

  await sendEmail({
    subject,
    html: `
      <h2>${prefix}Asmodee Nightly Inventory Sync</h2>
      ${atRiskHtml}
      ${denyHtml}
      ${continueHtml}
      ${failedHtmlAsmodee}
    `,
  });
}
