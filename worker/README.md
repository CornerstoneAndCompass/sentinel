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
| `/gfw/events?days=3` | Global Fishing Watch encounters / loitering / AIS gaps |
| `/acled?days=7` | ACLED armed-conflict events |
| `/firms?days=1` | NASA FIRMS thermal hotspots, parsed from CSV to JSON |
| `/health` | Which upstreams and secrets are live |

`/p` serves the last good copy of a response when the upstream fails, and warms
the cache in the background when GDELT throttles. GDELT asks for one request
every 5 seconds and 429s until you comply — waiting that out in the request path
costs 45s, so the retry happens after the response is sent. The first caller
after a cold start gets a 429, callers a few seconds later get real data.

`/p` only forwards to hosts on the allowlist in `src/index.js` — it is not an
open proxy. Add a host there before pointing a new feed at it.

## What the Worker cannot reach

Cloudflare Workers share egress IPs across all customers, and the volunteer-run
ADS-B aggregators block datacenter ranges to prevent abuse. Measured from the
deployed Worker vs. a residential IP:

| Upstream | Residential | Cloudflare edge |
|---|---|---|
| `api.adsb.lol` | 200 | 429 |
| `opendata.adsb.fi` | 200 | 403 |
| `opensky-network.org` | 200 | 522 |
| `meri.digitraffic.fi` | 200 | 200 |
| news / RSS hosts | 200 | 200 |

This is why aircraft tracking is fetched **browser-direct from airplanes.live**,
which is the one aggregator that serves `Access-Control-Allow-Origin: *`. Do not
move those feeds behind the proxy — it will make them worse, not better.

OpenSky is wired but reports `blocked` from Cloudflare. To use it you need a
proxy on a residential or ordinary VPS IP; the same `src/index.js` runs on
Node with minor changes, or point `PROXY_BASE` at any host you control.

## Optional API keys

Everything works without these; the feeds that need them report `NO KEY`
instead of failing. Add the ones you want:

```bash
# OpenSky — global non-military aircraft.
# Basic auth was removed in March 2026, so this is OAuth2 client credentials.
# Create a client at https://opensky-network.org/my-opensky/account
npx wrangler secret put OPENSKY_CLIENT_ID
npx wrangler secret put OPENSKY_CLIENT_SECRET

# Global Fishing Watch — dark-vessel events (AIS gaps, encounters, loitering).
# Free token at https://globalfishingwatch.org/our-apis/tokens
npx wrangler secret put GFW_TOKEN

# ACLED — armed conflict events, fills the "recorded incidents" section of
# every country brief. Free account at https://acleddata.com/register
#
# ACLED retired the old key+email API on 15 September 2025. It is now OAuth2,
# and their only grant type is the password grant — so this is your account
# password, not an API key. Set it yourself with the command below; it is typed
# straight into wrangler, stored as a Cloudflare secret, and never reaches the
# browser. The Worker uses the 14-day refresh token where it can so the password
# is replayed rarely. If you would rather not store it, leave these unset — the
# brief says "no ACLED key configured" and everything else works.
npx wrangler secret put ACLED_EMAIL
npx wrangler secret put ACLED_PASSWORD

# NASA FIRMS — real thermal hotspots instead of the EONET fallback.
# Free key at https://firms.modaps.eosdis.nasa.gov/api/area/
npx wrangler secret put FIRMS_KEY
```

Check what landed:

```bash
curl https://sentinel-feeds.<subdomain>.workers.dev/health
```

## Removed: aisstream

A Durable Object here used to hold a WebSocket to aisstream.io for global
vessel positions and the warship list. It was removed after the service
accepted a valid key and a well-formed subscription and then sent nothing at
all — no data, no error, no close — reproduced from Cloudflare and from a
residential connection. Their documentation describes the service as beta with
no uptime guarantee.

Maritime coverage is therefore Digitraffic only: Finnish and Baltic waters.
Warship hulls outside that area will not resolve. If you want global AIS later,
it needs a source with an availability guarantee.
