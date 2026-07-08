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
