# Sentinel feed proxy

A single Cloudflare Worker that fronts every upstream the dashboard reads.

It exists because most OSINT feeds send no `Access-Control-Allow-Origin` header,
so a static page cannot read them at all. The dashboard previously routed those
through free public CORS proxies (allorigins / corsproxy.io / codetabs); all
three went down and took eight feeds with them.

## Deploy

```bash
cd worker && npx wrangler login && npx wrangler deploy
```

`wrangler deploy` prints the URL, e.g. `https://sentinel-feeds.<subdomain>.workers.dev`.
Paste that into the dashboard's **PROXY** field in the header — it is stored in
`localStorage` and used for every subsequent fetch.

## Routes

| Route | Purpose |
|---|---|
| `/p?url=<encoded>` | Allowlisted passthrough with CORS + edge cache |
| `/osky?lamin=..&lomin=..&lamax=..&lomax=..` | OpenSky, OAuth2 token injected when configured |
| `/ais/snapshot?bbox=minLon,minLat,maxLon,maxLat` | Global AIS positions from the aisstream socket |
| `/ais/vessels?mmsi=a,b,c` | Positions for specific MMSIs (the warship list) |
| `/gfw/events?days=3` | Global Fishing Watch encounters / loitering / AIS gaps |
| `/acled?days=7` | ACLED armed-conflict events |
| `/firms?days=1` | NASA FIRMS thermal hotspots, parsed from CSV to JSON |
| `/health` | Which upstreams and secrets are live |

`/p` serves the last good copy of a response when the upstream fails. GDELT
rate-limits by caller IP and answers 429 with an empty body; stale news reads
better than a blank panel.

`/p` only forwards to hosts on the allowlist in `src/index.js` — it is not an
open proxy. Add a host there before pointing a new feed at it.

## Optional API keys

Everything works without these; the feeds that need them report `NO KEY`
instead of failing. Add the ones you want:

```bash
# OpenSky — global non-military aircraft.
# Basic auth was removed in March 2026, so this is OAuth2 client credentials.
# Create a client at https://opensky-network.org/my-opensky/account
npx wrangler secret put OPENSKY_CLIENT_ID
npx wrangler secret put OPENSKY_CLIENT_SECRET

# aisstream.io — global live AIS. Free key at https://aisstream.io
# This is what replaces the removed VesselFinder scraping.
npx wrangler secret put AISSTREAM_KEY

# Global Fishing Watch — dark-vessel events (AIS gaps, encounters, loitering).
# Free token at https://globalfishingwatch.org/our-apis/tokens
npx wrangler secret put GFW_TOKEN

# ACLED — armed conflict events, fills the currently-empty conflict layer.
# Free account at https://acleddata.com/register
npx wrangler secret put ACLED_KEY
npx wrangler secret put ACLED_EMAIL

# NASA FIRMS — real thermal hotspots instead of the EONET fallback.
# Free key at https://firms.modaps.eosdis.nasa.gov/api/area/
npx wrangler secret put FIRMS_KEY
```

Check what landed:

```bash
curl https://sentinel-feeds.<subdomain>.workers.dev/health
```

## Notes on the AIS bridge

`AisHub` is a Durable Object holding one outbound WebSocket to aisstream.io and
an in-memory map of MMSI → last known position. An alarm re-fires every 20s to
keep the object resident and reconnect if the socket drops or goes quiet for two
minutes. Vessels unheard for 45 minutes are evicted.

aisstream pushes roughly 300 messages/second globally, which is why this lives
in a Durable Object rather than the browser — and why the API key must never
ship in the page.
