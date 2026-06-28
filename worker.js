// Cross-border eBay — Cloudflare Worker (Browse API edition)
// Uses eBay's official Browse API item_summary/search endpoint.
// Requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET wrangler secrets.

const MARKETPLACE = {
  GB: "EBAY_GB", DE: "EBAY_DE", FR: "EBAY_FR", IT: "EBAY_IT", ES: "EBAY_ES",
  AT: "EBAY_AT", CH: "EBAY_CH", IE: "EBAY_IE", NL: "EBAY_NL", BE: "EBAY_BE",
  PL: "EBAY_PL", US: "EBAY_US", CA: "EBAY_CA", AU: "EBAY_AU", HK: "EBAY_HK",
  SG: "EBAY_SG", MY: "EBAY_MY", PH: "EBAY_PH",
};

const CURRENCY = {
  GB: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", AT: "EUR", CH: "CHF",
  IE: "EUR", NL: "EUR", BE: "EUR", PL: "PLN", US: "USD", CA: "CAD", AU: "AUD",
  HK: "HKD", SG: "SGD", MY: "MYR", PH: "PHP",
};

// Frontend sort value -> Browse API sort parameter
const SORT_MAP = {
  "16": "PRICE_PLUS_SHIPPING_LOWEST",
  "15": "PRICE_PLUS_SHIPPING_HIGHEST",
  "10": "NEWLY_LISTED",
  "1":  "ENDING_SOONEST",
  // "12" = Best match is the API default; omit the param
};

// Frontend conditionId -> Browse API condition enum
const COND_MAP = {
  "1000": "NEW",
  "1500": "NEW_OTHER",
  "2000": "MANUFACTURER_REFURBISHED",
  "2500": "SELLER_REFURBISHED",
  "3000": "USED",
};

const PER_COUNTRY = 12;
const FETCH_TIMEOUT_MS = 9000;
const BROWSE_API = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const TOKEN_URL  = "https://api.ebay.com/identity/v1/oauth2/token";

// Module-level token cache; survives across requests in the same Worker instance.
let tokenCache = { token: null, expiry: 0 };

async function getToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiry) return tokenCache.token;
  const creds = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  if (!res.ok) throw new Error(`OAuth token failed: HTTP ${res.status}`);
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    expiry: Date.now() + (data.expires_in - 60) * 1000, // 60 s safety margin
  };
  return tokenCache.token;
}

export default {
  async fetch(request, env) {
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const reqOrigin = request.headers.get("Origin") || "";
    const responseOrigin = allowedOrigins.includes(reqOrigin) ? reqOrigin : (allowedOrigins.length ? null : "*");

    if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }), responseOrigin);

    const url = new URL(request.url);
    if (url.pathname !== "/search") {
      return withCORS(new Response("Cross-border eBay worker. Use /search?q=...&countries=DE,GB,US", { status: 200 }), responseOrigin);
    }

    const p = url.searchParams;
    const q = (p.get("q") || "").trim();
    const countries = (p.get("countries") || "").split(",").map((c) => c.trim().toUpperCase()).filter((c) => MARKETPLACE[c]);
    if (!q || !countries.length) {
      return withCORS(Response.json({ items: [], errors: ["Missing q or countries"] }), responseOrigin);
    }

    let token;
    try {
      token = await getToken(env);
    } catch (e) {
      return withCORS(Response.json({ items: [], errors: [`Auth: ${e.message}`] }), responseOrigin);
    }

    const results = await Promise.allSettled(
      countries.map((cc) => fetchCountry(cc, q, p, token))
    );

    const items = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") items.push(...r.value);
      else errors.push(`${countries[i]}: ${r.reason}`);
    });

    return withCORS(Response.json({ count: items.length, items, errors }), responseOrigin);
  },
};

async function fetchCountry(cc, q, p, token) {
  const params = new URLSearchParams({ q, limit: String(PER_COUNTRY) });

  const sort = SORT_MAP[p.get("sort") || ""];
  if (sort) params.set("sort", sort);

  const filters = [];
  if (p.get("loc") === "1") filters.push(`itemLocationCountry:${cc}`);
  const condEnum = COND_MAP[p.get("cond") || ""];
  if (condEnum) filters.push(`conditions:{${condEnum}}`);
  const lo = p.get("min") || "", hi = p.get("max") || "";
  if (lo || hi) {
    filters.push(`price:[${lo}..${hi}]`);
    filters.push(`priceCurrency:${CURRENCY[cc]}`);
  }
  if (p.get("bin") === "1") filters.push("buyingOptions:{FIXED_PRICE}");
  if (p.get("fs") === "1") filters.push("deliveryOptions:{FREE_SHIPPING}");
  if (filters.length) params.set("filter", filters.join(","));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BROWSE_API}?${params}`, {
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE[cc],
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
    }
    const data = await res.json();
    return (data.itemSummaries || []).map((item) => mapItem(item, cc));
  } finally {
    clearTimeout(t);
  }
}

function mapItem(item, cc) {
  const priceVal = parseFloat(item.price?.value) || null;
  // Return just the numeric string; the frontend already shows the currency code separately.
  const priceStr = item.price?.value || null;
  const sc = item.shippingOptions?.[0]?.shippingCost;
  const shippingStr = sc
    ? (parseFloat(sc.value) === 0 ? "Free shipping" : `${sc.currency} ${sc.value}`)
    : null;
  const loc = [item.itemLocation?.city, item.itemLocation?.country].filter(Boolean).join(", ");
  return {
    cc,
    title: item.title,
    url: item.itemWebUrl,
    image: item.image?.imageUrl || null,
    price: priceStr,
    priceValue: priceVal,
    condition: item.condition || null,
    shipping: shippingStr,
    location: loc || null,
  };
}

function withCORS(res, origin) {
  const h = new Headers(res.headers);
  if (origin) h.set("Access-Control-Allow-Origin", origin);
  if (origin && origin !== "*") h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}
