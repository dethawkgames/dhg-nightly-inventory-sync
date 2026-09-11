// Pulls SKU -> availability from Asmodee's public consumer storefront
// (store.asmodee.com), which is a plain Shopify store with no login wall —
// unlike shop.asmodee.com (the B2B portal), which blocks headless access
// via Akamai bot detection (confirmed directly, Sept 2026). No credentials
// needed for this fetch.

const ASMODEE_STORE_DOMAIN = process.env.ASMODEE_STORE_DOMAIN || "store.asmodee.com";
const PAGE_LIMIT = 250;

export async function fetchB2CAvailability() {
  const skuAvailability = new Map();
  let page = 1;

  while (true) {
    const url = `https://${ASMODEE_STORE_DOMAIN}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.warn(`  WARNING: page ${page} fetch failed (${res.status}); stopping pagination`);
      break;
    }
    const data = await res.json();
    const products = data.products || [];
    if (products.length === 0) break;

    for (const p of products) {
      for (const v of p.variants || []) {
        const sku = (v.sku || "").trim();
        if (sku) skuAvailability.set(sku, Boolean(v.available));
      }
    }

    page += 1;
    await new Promise((r) => setTimeout(r, 200));
  }

  return skuAvailability;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchB2CAvailability()
    .then((map) => console.log(`Fetched ${map.size} SKUs`))
    .catch((err) => {
      console.error("B2C fetch failed:", err);
      process.exit(1);
    });
}
