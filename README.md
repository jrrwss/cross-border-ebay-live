# Multimarket

Search several countries' eBay at once and see the listings **merged into one
list**, filtered to items located in each country (the ones that ship locally to
your post box there).

**Live:**
- Frontend: https://jrrwss.github.io/cross-border-ebay-live/
- Worker: https://cross-border-ebay.stoppet.workers.dev

## How it works

Two pieces:

- `worker.js` — a Cloudflare Worker that calls eBay's Browse API for each
  country and returns merged JSON. Requires an eBay developer app (Client
  Credentials OAuth, no user login needed).
- `index.html` — the frontend. Talks to the Worker and renders results.

The Worker fans out to each country's eBay marketplace in parallel, returns up
to 12 listings per country tagged with the country code, and merges them.
"Best match" interleaves countries so one doesn't dominate; price sorts are
numerical (prices are in each site's local currency).

## Setup (for a fresh deploy)

### 1. eBay developer credentials

Create an app at developer.ebay.com → Application Keys → Production. You need:
- **App ID** → `EBAY_CLIENT_ID`
- **Cert ID** → `EBAY_CLIENT_SECRET`

Apply for the Marketplace Account Deletion exemption (personal use / no data
stored) when prompted — required before the keyset activates.

### 2. Deploy the Worker

```bash
npx wrangler login
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler deploy
```

### 3. Host the frontend

```bash
gh repo create cross-border-ebay-live --public --source . --push
gh api -X POST repos/:owner/cross-border-ebay-live/pages \
  -f "source[branch]=main" -f "source[path]=/"
```
