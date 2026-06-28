# Cross-border eBay (live results)

Search several countries' eBay at once and see the listings **merged into one
list**, filtered to items located in each country (the ones that ship locally to
your post box there).

Two pieces:

- `worker.js` — a Cloudflare Worker that fetches eBay's search pages for each
  country server-side and returns the listings as JSON. This is the part a plain
  webpage can't do itself (the browser is blocked from fetching eBay directly).
- `index.html` — the frontend. Point it at your Worker URL and it renders the
  merged, sortable results.

## 1. Deploy the Worker

From this folder:

```bash
npx wrangler login        # opens a browser to authorise your Cloudflare account
npx wrangler deploy       # deploys worker.js
```

`deploy` prints a URL like `https://cross-border-ebay.your-name.workers.dev`.
Copy it.

Quick test in a browser:

```
https://cross-border-ebay.your-name.workers.dev/search?q=leica&countries=DE,GB
```

You should get JSON back with an `items` array.

## 2. Host the frontend

Open `index.html`, expand **Worker endpoint** at the bottom of the search box,
and paste your Worker URL. It's saved in your browser. That's enough to use it
locally.

To get a URL on any device, publish `index.html` (+ `.nojekyll`) to GitHub
Pages, exactly like the earlier launcher repo:

```bash
gh repo create cross-border-ebay-live --public --source . --push
```

Then enable Pages (Settings → Pages → Branch `main` / root). It'll be live at
`https://<you>.github.io/cross-border-ebay-live/`.

## How it works

- The frontend sends your search term, filters, and chosen countries to the
  Worker. **Located in country** maps to eBay's `LH_PrefLoc=1` per site.
- The Worker fans out to each country's eBay, grabs the top ~12 listings each,
  and returns them tagged with the country code.
- Results are shown in one list. "Best match" interleaves countries so one
  doesn't dominate the top; the price sorts order numerically (note prices are
  in each site's **local currency** — cross-currency sorting is only a rough
  guide).

## Honest caveats

- **It parses eBay's HTML.** eBay can change that markup anytime, which would
  break the selectors in `worker.js → parseItems()`. If results suddenly come
  back empty, that's the first place to look.
- **eBay may rate-limit or block** automated requests from datacenter IPs and
  occasionally serve a CAPTCHA. Keep usage personal and low-volume.
- Scraping is a grey area under eBay's terms. For a robust, fully-sanctioned
  setup, the alternative is eBay's official **Browse API** (`item_summary/
  search` with the `X-EBAY-C-MARKETPLACE-ID` header per country). It returns
  clean JSON, but production access requires an approved eBay developer
  application and a signed agreement. If you'd rather go that route, the Worker
  can be swapped to call the API instead of scraping — same frontend.
