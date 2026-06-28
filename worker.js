// Cross-border eBay — Cloudflare Worker
// Fetches eBay search results for multiple country sites server-side and
// returns a merged JSON list. No eBay API key required.
//
// NOTE: this parses eBay's public search HTML. eBay can change that markup at
// any time, in which case the selectors in parseItems() need updating. eBay may
// also rate-limit or block automated requests; keep volume low (personal use).

const DOMAINS = {
  GB: "co.uk", DE: "de", FR: "fr", IT: "it", ES: "es", AT: "at", CH: "ch",
  IE: "ie", NL: "nl", BE: "be", PL: "pl", US: "com", CA: "ca", AU: "com.au",
  HK: "com.hk", SG: "com.sg", MY: "com.my", PH: "ph",
};

const PER_COUNTRY = 12;        // listings kept per country
const FETCH_TIMEOUT_MS = 9000;

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
    const countries = (p.get("countries") || "").split(",").map((c) => c.trim().toUpperCase()).filter((c) => DOMAINS[c]);
    if (!q || !countries.length) {
      return withCORS(Response.json({ items: [], errors: ["Missing q or countries"] }), responseOrigin);
    }

    const results = await Promise.allSettled(
      countries.map((cc) => fetchCountry(cc, q, p))
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

function ebayUrl(cc, q, p) {
  const sp = new URLSearchParams({ _nkw: q });
  if (p.get("sort")) sp.set("_sop", p.get("sort"));
  if (p.get("cond")) sp.set("LH_ItemCondition", p.get("cond"));
  if (p.get("min")) sp.set("_udlo", p.get("min"));
  if (p.get("max")) sp.set("_udhi", p.get("max"));
  if (p.get("loc") === "1") sp.set("LH_PrefLoc", "1");
  if (p.get("bin") === "1") sp.set("LH_BIN", "1");
  if (p.get("fs") === "1") sp.set("LH_FS", "1");
  return `https://www.ebay.${DOMAINS[cc]}/sch/i.html?${sp.toString()}`;
}

async function fetchCountry(cc, q, p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ebayUrl(cc, q, p), {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    return parseItems(html, cc);
  } finally {
    clearTimeout(t);
  }
}

function parseItems(html, cc) {
  const out = [];
  const chunks = html.split('<li class="s-item');
  for (let i = 1; i < chunks.length && out.length < PER_COUNTRY; i++) {
    const c = chunks[i];
    const url = (c.match(/href="(https?:\/\/[^"]*\/itm\/[^"]+)"/) || [])[1];
    const title = field(c, "s-item__title");
    if (!url || !title || /^shop on ebay$/i.test(title)) continue;

    const priceStr = field(c, "s-item__price");
    const image =
      (c.match(/s-item__image-img[^>]*?src="([^"]+)"/) || [])[1] ||
      (c.match(/s-item__image-img[^>]*?data-src="([^"]+)"/) || [])[1] || null;

    out.push({
      cc,
      title,
      url,
      image,
      price: priceStr || null,
      priceValue: parsePrice(priceStr),
      condition: field(c, "SECONDARY_INFO") || null,
      shipping: field(c, "s-item__shipping") || null,
      location: clean((field(c, "s-item__location") || "").replace(/^from\s*/i, "")) || null,
    });
  }
  return out;
}

// Grab the text content right after class="<cls>"
function field(chunk, cls) {
  const re = new RegExp('"' + cls + '[^"]*"[^>]*>([\\s\\S]*?)</', "i");
  const m = chunk.match(re);
  return m ? clean(m[1]) : "";
}

function clean(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(str) {
  if (!str) return null;
  const t = (str.match(/\d[\d.,]*/) || [])[0];
  if (!t) return null;
  let x = t;
  if (x.includes(",") && x.includes(".")) {
    x = x.lastIndexOf(",") > x.lastIndexOf(".")
      ? x.replace(/\./g, "").replace(",", ".")
      : x.replace(/,/g, "");
  } else if (x.includes(",")) {
    x = /,\d{2}$/.test(x) ? x.replace(/\./g, "").replace(",", ".") : x.replace(/,/g, "");
  }
  const n = parseFloat(x);
  return isNaN(n) ? null : n;
}

function withCORS(res, origin) {
  const h = new Headers(res.headers);
  if (origin) h.set("Access-Control-Allow-Origin", origin);
  if (origin && origin !== "*") h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}
