/**
 * SENTINEL feed proxy
 *
 * One origin for every upstream the dashboard needs. It exists because most
 * OSINT feeds send no Access-Control-Allow-Origin header, so a static page
 * cannot read them at all. Previously index.html routed those through free
 * public CORS proxies; all three died and took eight feeds with them.
 *
 * Routes
 *   GET /p?url=<encoded>     allowlisted passthrough, CORS + edge cache
 *   GET /osky?lamin=..&..    OpenSky, OAuth2 token injected when configured
 *   GET /gfw/events?..       Global Fishing Watch events (dark vessels)
 *   GET /acled?..            ACLED armed-conflict events
 *   GET /health              which upstreams and secrets are live
 *   GET /spine/state         current metrics with their 7-day baselines
 *   GET /spine/since?t=..    what changed since a timestamp
 *   GET /spine/series?..     one metric's history, downsampled
 *   GET /spine/tick          run one sampling pass by hand (throttled)
 *   GET /osm/military?bbox=  mapped military installations (OpenStreetMap)
 *   GET /launches            upcoming and recent orbital launches
 *   GET /tle?group=          satellite elements from CelesTrak
 *   GET /cams?src=           public traffic cameras, normalised
 *
 * The /spine routes are served from a rolling history the scheduled handler
 * builds; see spine.js for why the dashboard needs one at all.
 */

import { tick as spineTick, state as spineState, since as spineSince, series as spineSeries } from './spine.js';
import { osmMilitary, launches as llLaunches, tle as celesTle, cameras as openCams,
         adsbArea, flight as flightLookup, adsbxUsage } from './sources.js';

const ALLOWED_HOSTS = new Set([
  // aircraft
  'api.adsb.lol',
  'opendata.adsb.fi',
  'api.airplanes.live',
  'adsbexchange-com1.p.rapidapi.com',   // paid feed; key injected server-side
  'opensky-network.org',
  // maritime
  'meri.digitraffic.fi',
  // events / hazards
  // api.gdeltproject.org was removed on 27 Aug 2026: the host refuses
  // connections outright (ECONNREFUSED), reproduced from Cloudflare and from
  // a residential IP. Both dashboard news layers depended on it and reported
  // "no events" while it was dead. Breaking news is now ingested from wire
  // RSS instead. Do not re-add it without measuring the host first.
  'api.rainviewer.com',            // precipitation radar index
  'www.gdacs.org',                 // global disaster alerts, EU JRC + UN OCHA
  'www.nhc.noaa.gov',              // tropical cyclones, Atlantic + E Pacific
  'api.weather.bom.gov.au',        // Australian warnings
  'www.rfs.nsw.gov.au',            // NSW Rural Fire Service incidents
  'data.emergency.vic.gov.au',     // VicEmergency incidents
  'publiccontent.gis.psba.qld.gov.au', // Queensland Fire Department warnings
  'earthquake.usgs.gov',
  'eonet.gsfc.nasa.gov',
  'firms.modaps.eosdis.nasa.gov',
  'services.swpc.noaa.gov',
  'api.weather.gov',
  'www.tsunami.gov',
  'volcano.si.edu',
  'tfr.faa.gov',
  'services3.arcgis.com',
  'data.unhcr.org',
  // open infrastructure and camera operators; served via /osm/military and /cams
  'overpass-api.de',
  'api.tfl.gov.uk',
  'cwwp2.dot.ca.gov',
  // space
  'celestrak.org',                 // canonical TLE source; served via /tle
  'll.thespacedevs.com',           // launch schedule; served via /launches
  'tle.ivanstanojevic.me',
  'api.wheretheiss.at',
  // news
  'feeds.bbci.co.uk',
  'rss.nytimes.com',
  'www.defensenews.com',
  'www.defense.gov',
  'www.aljazeera.com',
  'www.theguardian.com',
  'feeds.skynews.com',
  // news.google.com was removed on 27 Aug 2026. It answers 200 from a
  // residential IP and 503 from the Cloudflare edge — the same datacenter-range
  // block the ADS-B aggregators apply. Every dashboard request goes through
  // this Worker, so from the app's point of view Google News is simply dead.
  // Measure from `wrangler dev --remote`, not `wrangler dev`, before re-adding.
  'www.bing.com',                  // News RSS — search-capable, works from edge
  'feeds.npr.org',
  'www.france24.com',
  'www.abc.net.au',
  'www.channelnewsasia.com',
  'api.reliefweb.int',
  // reliefweb.int serves the same disaster list as RSS with no appname, which
  // the JSON API refuses without one. See fetchReliefWeb.
  'reliefweb.int',
]);

// How long the edge may serve a cached copy, by upstream host or path hint.
const TTL = [
  // adsb.lol allows roughly one request per window from Cloudflare's shared
  // egress and 429s the rest, so an 8s TTL guaranteed a miss on almost every
  // call. A longer window plus the stale copy below keeps real aircraft on the
  // map: measured, /v2/mil serves 187 aircraft as STALE while the upstream is
  // still refusing.
  [/adsb|airplanes\.live|opensky/, 45],
  [/digitraffic/, 20],
  [/rss|feeds\.|xml|reliefweb|bing\.com/, 180],
  [/rainviewer/, 60],
  [/gdacs|bom\.gov\.au/, 300],
  [/rfs\.nsw|emergency\.vic|psba\.qld/, 120],
  [/firms|eonet|usgs|swpc|weather|tsunami|volcano/, 120],
];
function ttlFor(url) {
  for (const [re, secs] of TTL) if (re.test(url)) return secs;
  return 60;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  // Without this the diagnostic headers below are invisible to JS on a
  // cross-origin fetch, which makes the cache path impossible to debug.
  'Access-Control-Expose-Headers': 'X-Sentinel-Cache, X-Sentinel-Upstream-Status, X-Sentinel-Auth',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

/* ---------------------------------------------------------------- proxy -- */

// KV keys are limited to 512 bytes and these URLs carry long encoded queries.
function kvKey(url) {
  return 'feed:' + url.slice(0, 400);
}

// Runs after the response is sent. Retries a throttled upstream patiently and
// writes the result into both the live and stale caches, so the cost of waiting
// out a rate limit is paid once in the background rather than by every client.
async function warmCache(url, headers, cache, ttl, env) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    let res;
    try {
      res = await fetch(url, { headers, cf: { cacheEverything: false } });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const body = await res.arrayBuffer();
    const h = new Headers(CORS);
    h.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    h.set('X-Sentinel-Cache', 'WARMED');
    h.set('X-Sentinel-Upstream-Status', String(res.status));

    const live = new Headers(h);
    live.set('Cache-Control', `public, max-age=${ttl}`);
    await cache.put(new Request(url, { method: 'GET' }), new Response(body, { status: 200, headers: live }));

    const stale = new Headers(h);
    stale.set('Cache-Control', 'public, max-age=86400');
    await cache.put(new Request(url + '#stale'), new Response(body, { status: 200, headers: stale }));

    // Globally replicated so every colo benefits, not just this one.
    if (env && env.FEED_CACHE) {
      await env.FEED_CACHE.put(kvKey(url), new TextDecoder().decode(body), { expirationTtl: 86400 });
    }
    return;
  }
}

async function passthrough(request, env, ctx) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return err('missing url parameter');

  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return err('malformed url');
  }
  if (upstream.protocol !== 'https:') return err('https only');
  if (!ALLOWED_HOSTS.has(upstream.hostname)) {
    return err(`host not allowed: ${upstream.hostname}`, 403);
  }

  const cache = caches.default;
  const cacheKey = new Request(upstream.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const h = new Headers(hit.headers);
    Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
    h.set('X-Sentinel-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers: h });
  }

  const upstreamHeaders = {
    // Digitraffic rejects requests without these two.
    'Accept-Encoding': 'gzip',
    'Digitraffic-User': 'Sentinel/OSINT-dashboard',
    'User-Agent': 'Sentinel-OSINT/1.0 (+https://github.com/sentinel)',
    Accept: '*/*',
  };

  let res;
  try {
    res = await fetch(upstream.toString(), { headers: upstreamHeaders, cf: { cacheEverything: false } });
  } catch (e) {
    return err(`upstream fetch failed: ${e.message}`, 502);
  }

  // Throttled upstreams 429 a few times and then succeed. Waiting that out in
  // the request path costs tens of seconds, so retry after responding instead:
  // this caller gets stale data now, the next one gets a warm cache. This was
  // written for GDELT; it now matters for Google News, which the wire ingester
  // polls every 90 seconds from every open tab.
  if (res.status === 429 && /bing\.com|adsb/.test(upstream.hostname)) {
    ctx.waitUntil(warmCache(upstream.toString(), upstreamHeaders, cache, ttlFor(upstream.toString()), env));
  }

  // Serving the last good copy beats blanking the panel — stale news reads
  // fine. Check KV as well as the colo cache: caches.default is per-datacenter,
  // so a copy warmed in Frankfurt does nothing for a client served from Dublin.
  if (!res.ok) {
    const stale = await cache.match(new Request(upstream.toString() + '#stale'));
    if (stale) {
      const h = new Headers(stale.headers);
      Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
      h.set('X-Sentinel-Cache', 'STALE');
      h.set('X-Sentinel-Upstream-Status', String(res.status));
      return new Response(stale.body, { status: 200, headers: h });
    }
    if (env.FEED_CACHE) {
      const kv = await env.FEED_CACHE.get(kvKey(upstream.toString()));
      if (kv) {
        return new Response(kv, {
          status: 200,
          headers: {
            ...CORS,
            'Content-Type': 'application/json',
            'X-Sentinel-Cache': 'KV-STALE',
            'X-Sentinel-Upstream-Status': String(res.status),
          },
        });
      }
    }
  }

  const headers = new Headers(CORS);
  headers.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream');
  const ttl = ttlFor(upstream.toString());
  // Only cache successes. Caching a 429 for 5 minutes means the browser keeps
  // replaying the rate-limit error from its own disk cache long after the
  // background warm has fetched real data.
  headers.set('Cache-Control', res.ok ? `public, max-age=${ttl}` : 'no-store');
  headers.set('X-Sentinel-Cache', 'MISS');
  headers.set('X-Sentinel-Upstream-Status', String(res.status));

  const body = await res.arrayBuffer();
  const out = new Response(body, { status: res.status, headers });
  if (res.ok) {
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    // Long-lived copy used only when the upstream later fails.
    const staleHeaders = new Headers(headers);
    staleHeaders.set('Cache-Control', 'public, max-age=86400');
    ctx.waitUntil(
      cache.put(new Request(upstream.toString() + '#stale'), new Response(body, { status: 200, headers: staleHeaders }))
    );
    // KV is globally replicated, unlike the per-colo cache — worth the write
    // for the feeds that throttle or that every client needs.
    if (env.FEED_CACHE && /bing\.com|reliefweb|adsb/.test(upstream.hostname)) {
      ctx.waitUntil(
        env.FEED_CACHE.put(kvKey(upstream.toString()), new TextDecoder().decode(body), { expirationTtl: 86400 })
      );
    }
  }
  return out;
}

/* ----------------------------------------------------------------- firms -- */

async function firms(request, env) {
  if (!env.FIRMS_KEY) return json({ configured: false, hotspots: [] });

  const p = new URL(request.url).searchParams;
  // The area API accepts 1-5 days only. The old clamp allowed 10, which the
  // upstream rejects outright. Non-numeric input has to be caught explicitly:
  // Math.min/max propagate NaN, which would be interpolated into the URL path.
  // day_range counts whole UTC days *including today*, so a range of 1 is
  // whatever has been observed since 00:00 UTC. Measured just after UTC
  // midnight that is a header and nothing else, worldwide — which is exactly
  // how "the key does not work" would look. 2 is the smallest range that
  // always contains a full day of overpasses.
  const dRaw = parseInt(p.get('days') || '2', 10);
  const days = Number.isFinite(dRaw) ? Math.min(Math.max(dRaw, 1), 5) : 2;

  // west,south,east,north — or "world". A global VIIRS day is hundreds of
  // thousands of rows and counts as many transactions against the key, so the
  // caller should ask for the area it is actually showing.
  const bbox = p.get('bbox');
  const area = bbox && /^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(bbox) ? bbox : 'world';

  // Both polar satellites: SNPP alone leaves roughly half the overpasses out.
  // Three polar satellites. Availability lists NOAA21 alongside SNPP and
  // NOAA20, and each adds its own overpasses.
  const sources = (p.get('sources') || 'VIIRS_SNPP_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT')
    .split(',').slice(0, 4);
  const cap = Math.min(parseInt(p.get('limit') || '4000', 10), 20000);

  const parseCsv = (text, sat) => {
    const rows = text.trim().split(/\r?\n/);
    const head = (rows.shift() || '').split(',').map((h) => h.trim());
    const at = (n) => head.indexOf(n);
    const iLat = at('latitude'), iLon = at('longitude');
    if (iLat < 0 || iLon < 0) return null;
    const iConf = at('confidence'), iDate = at('acq_date'), iTime = at('acq_time');
    const iFrp = at('frp'), iBright = at('bright_ti4') >= 0 ? at('bright_ti4') : at('brightness');
    const iSat = at('satellite'), iDn = at('daynight');
    const out = [];
    for (const row of rows) {
      const c = row.split(',');
      const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
      out.push({
        lat, lon,
        confidence: iConf >= 0 ? c[iConf] : null,
        date: iDate >= 0 ? c[iDate] : null,
        // HHMM in UTC, kept as given; the client formats it.
        time: iTime >= 0 ? c[iTime] : null,
        frp: iFrp >= 0 ? parseFloat(c[iFrp]) || null : null,
        bright: iBright >= 0 ? parseFloat(c[iBright]) || null : null,
        sat: iSat >= 0 ? c[iSat] : sat,
        daynight: iDn >= 0 ? c[iDn] : null,
      });
    }
    return out;
  };

  const results = await Promise.all(sources.map(async (src) => {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_KEY}/${src}/${area}/${days}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Sentinel-OSINT/1.0' } });
    if (!res.ok) return { src, error: `firms ${res.status}` };
    const text = await res.text();
    // An invalid key answers 200 with an HTML/text error rather than CSV.
    if (/Invalid MAP_KEY|<html/i.test(text.slice(0, 400))) return { src, error: 'firms bad key' };
    const rows = parseCsv(text, src);
    if (!rows) return { src, error: 'unexpected csv', sample: text.slice(0, 120) };
    return { src, rows };
  }));

  const failed = results.filter((r) => r.error);
  // Flattening then truncating drops whole satellites: SNPP alone can fill the
  // cap, so NOAA21 would never appear. Take an equal share from each instead,
  // and report the total so a truncated view is not mistaken for a quiet day.
  const live = results.filter((r) => r.rows && r.rows.length);
  const share = live.length ? Math.floor(cap / live.length) : 0;
  let hotspots = live.flatMap((r) => r.rows.slice(0, share));
  const total = live.reduce((n, r) => n + r.rows.length, 0);
  // Any headroom left by a small source goes back to the others.
  if (hotspots.length < cap) {
    for (const r of live) {
      if (hotspots.length >= cap) break;
      hotspots = hotspots.concat(r.rows.slice(share, share + (cap - hotspots.length)));
    }
  }
  const body = {
    configured: true,
    area, days,
    count: hotspots.length,
    total,
    truncated: total > hotspots.length,
    bySource: Object.fromEntries(results.map((r) => [r.src, r.rows ? r.rows.length : r.error])),
    hotspots,
  };
  if (failed.length === results.length) {
    body.error = failed[0].error;
    body.detail = failed[0].sample;
  } else if (failed.length) {
    body.partial = failed.map((f) => `${f.src}: ${f.error}`);
  }
  return json(body, 200, { 'Cache-Control': 'public, max-age=600' });
}

/* -------------------------------------------------------------- opensky -- */

let oskyToken = { value: null, expires: 0 };
let oskyBlockedUntil = 0;
let oskyBlockedMode = null;   // 'auth' | 'anon' — which state was refused
let oskyAuthNote = null;      // why authentication failed, when it did

async function openskyToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (oskyToken.value && Date.now() < oskyToken.expires) return oskyToken.value;

  let res;
  try {
    res = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: env.OPENSKY_CLIENT_ID,
          client_secret: env.OPENSKY_CLIENT_SECRET,
        }),
        // Without a bound, a refused auth host stalls the whole request before
        // the data call even starts, and the failure then gets blamed on the
        // data endpoint.
        signal: AbortSignal.timeout(10000),
      }
    );
  } catch (e) {
    oskyAuthNote = 'token endpoint unreachable: ' + (e.message || 'timeout');
    return null;
  }
  if (!res.ok) {
    oskyAuthNote = 'token rejected: HTTP ' + res.status;
    return null;
  }
  oskyAuthNote = null;

  const data = await res.json();
  // Tokens last 30 minutes; refresh a minute early.
  oskyToken = {
    value: data.access_token,
    expires: Date.now() + (data.expires_in || 1800) * 1000 - 60000,
  };
  return oskyToken.value;
}

async function opensky(request, env, ctx) {
  const p = new URL(request.url).searchParams;
  const box = ['lamin', 'lomin', 'lamax', 'lomax']
    .map((k) => `${k}=${encodeURIComponent(p.get(k) || '')}`)
    .join('&');

  const token = await openskyToken(env);
  const headers = { 'User-Agent': 'Sentinel-OSINT/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;

  // OpenSky refuses this IP range, and a refused request costs ~20s: Cloudflare
  // synthesizes the 522 itself after its own origin timeout, so an AbortSignal
  // on the subrequest does not shorten it. Remember the verdict and answer
  // instantly instead of burning 20s of the dashboard's refresh cycle on every
  // pass. Re-probe every 30 minutes in case the block lifts.
  // Module globals are per-isolate, so the verdict has to live somewhere shared
  // or every cold isolate pays the 8s probe again.
  /* The verdict is per credential state, not per worker. A refusal observed
     while anonymous says nothing about an authenticated request: OpenSky judges
     an unauthenticated caller on its IP range and an authenticated one on its
     token. Sharing one key meant that adding credentials changed nothing for up
     to thirty minutes, and looked exactly like the credentials not working. */
  const verdictKey = new Request(
    'https://sentinel.internal/osky-blocked/' + (token ? 'auth' : 'anon')
  );
  // The in-memory flag is likewise only meaningful for the mode that set it.
  if (oskyBlockedMode === (token ? 'auth' : 'anon') && Date.now() < oskyBlockedUntil) {
    return json({ blocked: true, authenticated: Boolean(token),
      reason: 'upstream refuses this IP range (cached verdict)', cached: true });
  }
  const cachedVerdict = await caches.default.match(verdictKey);
  if (cachedVerdict) {
    oskyBlockedUntil = Date.now() + 300000;
    oskyBlockedMode = token ? 'auth' : 'anon';
    return json({ blocked: true, reason: 'upstream refuses this IP range (cached verdict)', cached: true });
  }

  const markBlocked = (reason, extra = {}) => {
    oskyBlockedUntil = Date.now() + 1800000;
    oskyBlockedMode = token ? 'auth' : 'anon';
    ctx.waitUntil(
      caches.default.put(
        verdictKey,
        new Response('blocked', { headers: { 'Cache-Control': 'public, max-age=1800' } })
      )
    );
    return json({
      blocked: true, reason, authenticated: Boolean(token),
      ...(oskyAuthNote ? { auth: oskyAuthNote } : {}),
      ...extra,
    });
  };

  let res;
  try {
    res = await fetch(`https://opensky-network.org/api/states/all?${box}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return markBlocked('connection timed out from datacenter IP');
  }

  // OpenSky refuses Cloudflare egress IPs — 522/403/429 here is the upstream
  // rejecting the datacenter range, not a bad query. Say so explicitly so the
  // dashboard can label it instead of showing a generic OFFLINE.
  if (res.status === 522 || res.status === 403 || res.status === 429) {
    return markBlocked(`upstream returned ${res.status} to datacenter IP`, { authenticated: Boolean(token) });
  }
  if (!res.ok) return err(`opensky ${res.status}`, 502);

  const data = await res.json();
  return json(data, 200, {
    'Cache-Control': 'public, max-age=8',
    'X-Sentinel-Auth': token ? 'oauth2' : 'anonymous',
  });
}

/* ------------------------------------------------------------ keyed apis -- */

// Each event type lives in its own dataset. Asking for LOITERING while only
// registering the encounters dataset returns encounters — or a 422 — never
// loitering, so the two lists have to be derived from one another.
const GFW_DATASETS = {
  ENCOUNTER: 'public-global-encounters-events:latest',
  LOITERING: 'public-global-loitering-events:latest',
  GAP: 'public-global-gaps-events:latest',
  PORT_VISIT: 'public-global-port-visits-events:latest',
  FISHING: 'public-global-fishing-events:latest',
};

// One request per type. Sorted newest-first the feed is dominated by loitering
// — 250k events in a month against a few thousand encounters — so a single
// merged query would return 150 loitering events and never show a
// transshipment or an AIS gap, which are the two that actually matter.
async function gfwOneType(type, startDate, endDate, limit, token) {
  const u = new URL('https://gateway.api.globalfishingwatch.org/v3/events');
  u.searchParams.set('datasets[0]', GFW_DATASETS[type]);
  u.searchParams.set('types[0]', type);
  u.searchParams.set('start-date', startDate);
  u.searchParams.set('end-date', endDate);
  // Without this the API returns oldest-first: a 2026 query answers with 2014.
  u.searchParams.set('sort', '-start');
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('offset', '0');

  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return { type, error: `gfw ${res.status}`, detail, entries: [] };
  }
  const d = await res.json();
  return { type, total: d.total ?? 0, entries: d.entries || [] };
}

async function gfwEvents(request, env) {
  if (!env.GFW_TOKEN) return json({ configured: false, entries: [] });

  const p = new URL(request.url).searchParams;
  const types = (p.get('types') || 'ENCOUNTER,LOITERING,GAP')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => GFW_DATASETS[t]);
  if (!types.length) return json({ configured: true, error: 'no valid types', entries: [] });

  // GFW publishes roughly five days behind real time, so the obvious three-day
  // window is always empty. Fourteen days always contains data; entries carry
  // their own timestamps and the client shows them.
  const days = Math.min(Math.max(parseInt(p.get('days') || '14', 10), 7), 90);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const endDate = end.toISOString().slice(0, 10);
  const startDate = start.toISOString().slice(0, 10);
  const limit = Math.min(parseInt(p.get('limit') || '150', 10), 500);
  const per = Math.max(Math.ceil(limit / types.length), 10);

  const results = await Promise.all(
    types.map((t) => gfwOneType(t, startDate, endDate, per, env.GFW_TOKEN))
  );

  const failed = results.filter((r) => r.error);
  const entries = results
    .flatMap((r) => r.entries)
    // The API reports the type in lower case; the client keys its icons on the
    // upper-case name it asked for.
    .map((e) => ({ ...e, type: String(e.type || '').toUpperCase() }))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));

  const body = {
    configured: true,
    window: { start: startDate, end: endDate, days },
    counts: Object.fromEntries(results.map((r) => [r.type, r.entries.length])),
    totals: Object.fromEntries(results.map((r) => [r.type, r.total ?? 0])),
    entries,
  };
  // Only a total failure is an error. One dead dataset should not blank the
  // other two.
  if (failed.length === results.length) {
    body.error = failed[0].error;
    body.detail = failed[0].detail;
  } else if (failed.length) {
    body.partial = failed.map((f) => `${f.type}: ${f.error}`);
  }
  return json(body, 200, { 'Cache-Control': 'public, max-age=900' });
}

// ACLED retired the key+email query-parameter API on 15 September 2025 and
// moved to OAuth2. The password grant is their design, not a choice made here;
// the credentials live in Worker secrets set by the account holder and are never
// sent to the browser. Access tokens last 24h and refresh tokens 14 days, so the
// refresh path is used whenever possible to avoid replaying the password.
let acledToken = { access: null, refresh: null, expires: 0 };

async function acledAuth(env) {
  if (acledToken.access && Date.now() < acledToken.expires) return acledToken.access;

  const form = new URLSearchParams({ client_id: 'acled' });
  if (acledToken.refresh) {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', acledToken.refresh);
  } else {
    form.set('grant_type', 'password');
    form.set('username', env.ACLED_EMAIL);
    form.set('password', env.ACLED_PASSWORD);
    form.set('scope', 'authenticated');
  }

  let res = await fetch('https://acleddata.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  // An expired or rejected refresh token falls back to a full re-auth once.
  if (!res.ok && acledToken.refresh) {
    acledToken = { access: null, refresh: null, expires: 0 };
    return acledAuth(env);
  }
  if (!res.ok) throw new Error(`acled auth ${res.status}`);

  const d = await res.json();
  acledToken = {
    access: d.access_token,
    refresh: d.refresh_token || acledToken.refresh,
    expires: Date.now() + (d.expires_in || 86400) * 1000 - 120000,
  };
  return acledToken.access;
}

async function acled(request, env) {
  if (!env.ACLED_EMAIL || !env.ACLED_PASSWORD) return json({ configured: false, data: [] });

  const p = new URL(request.url).searchParams;
  const days = Math.min(parseInt(p.get('days') || '7', 10), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  let token;
  try {
    token = await acledAuth(env);
  } catch (e) {
    return json({ configured: true, error: e.message, data: [] });
  }

  const url = new URL('https://acleddata.com/api/acled/read');
  url.searchParams.set('event_date', since);
  url.searchParams.set('event_date_where', '>=');
  url.searchParams.set('limit', p.get('limit') || '300');
  if (p.get('iso3')) url.searchParams.set('iso3', p.get('iso3'));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return json({ configured: true, error: `acled ${res.status}`, data: [] }, 200);

  const data = await res.json();
  return json({ configured: true, ...data }, 200, { 'Cache-Control': 'public, max-age=1800' });
}

/* ---------------------------------------------------------------- router -- */

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return err('GET only', 405);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/p') return await passthrough(request, env, ctx);
      if (path === '/osky') return await opensky(request, env, ctx);
      if (path === '/gfw/events') return await gfwEvents(request, env);
      if (path === '/acled') return await acled(request, env);
      if (path === '/firms') return await firms(request, env);

      if (path === '/spine/state') {
        return json(await spineState(env), 200, { 'Cache-Control': 'public, max-age=60' });
      }
      if (path === '/spine/since') {
        const raw = url.searchParams.get('t');
        const t = raw ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : NaN;
        return json(await spineSince(env, t), 200, { 'Cache-Control': 'no-store' });
      }
      if (path === '/spine/series') {
        return json(
          await spineSeries(
            env,
            url.searchParams.get('metric') || 'milair',
            parseInt(url.searchParams.get('days') || '7', 10),
            parseInt(url.searchParams.get('points') || '60', 10),
          ),
          200,
          { 'Cache-Control': 'public, max-age=300' },
        );
      }
      // Manual pass, for a first run or for verifying a deploy without waiting
      // out the cron. spine.js throttles it, so it cannot be used to hammer
      // upstreams from outside.
      if (path === '/spine/tick') return json(await spineTick(env), 200, { 'Cache-Control': 'no-store' });

      // Supplementary sources. Each is reduced and cached in the worker, so
      // these stay small however large the upstream is.
      if (path === '/osm/military') {
        return json(await osmMilitary(request, env), 200, { 'Cache-Control': 'public, max-age=3600' });
      }
      if (path === '/launches') {
        return json(await llLaunches(env), 200, { 'Cache-Control': 'public, max-age=900' });
      }
      if (path === '/tle') {
        return json(await celesTle(request, env), 200, { 'Cache-Control': 'public, max-age=10800' });
      }
      if (path === '/flight') {
        return json(await flightLookup(request, env), 200, { 'Cache-Control': 'public, max-age=30' });
      }
      if (path === '/adsb/usage') {
        return json(await adsbxUsage(env), 200, { 'Cache-Control': 'no-store' });
      }
      if (path === '/adsb/area') {
        return json(await adsbArea(request, env), 200, { 'Cache-Control': 'public, max-age=30' });
      }
      if (path === '/cams') {
        return json(await openCams(request, env), 200, { 'Cache-Control': 'public, max-age=1800' });
      }

      /* Diagnostic: is OpenSky slow from here, or unreachable? An 8-second
         budget cannot tell those apart, and the difference decides whether the
         integration is fixable at all. Times each hop with a generous bound. */
      if (path === '/osky/probe') {
        const out = {};
        const time = async (label, fn) => {
          const t0 = Date.now();
          try { out[label] = { ...(await fn()), ms: Date.now() - t0 }; }
          catch (e) { out[label] = { error: e.message, ms: Date.now() - t0 }; }
        };
        await time('auth', async () => {
          const r = await fetch(
            'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
            { method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: env.OPENSKY_CLIENT_ID || 'x',
                client_secret: env.OPENSKY_CLIENT_SECRET || 'x',
              }),
              signal: AbortSignal.timeout(45000) });
          const j = await r.json().catch(() => ({}));
          return { status: r.status, gotToken: Boolean(j.access_token) };
        });
        await time('states', async () => {
          const r = await fetch(
            'https://opensky-network.org/api/states/all?lamin=51&lomin=-1&lamax=52&lomax=0',
            { signal: AbortSignal.timeout(45000) });
          return { status: r.status, bytes: (await r.text()).length };
        });
        return json(out);
      }

      if (path === '/health') {
        return json({
          ok: true,
          time: new Date().toISOString(),
          allowedHosts: ALLOWED_HOSTS.size,
          configured: {
            opensky: Boolean(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET),
            // Configured is not the same as working; say which.
            openskyAuth: oskyAuthNote || (oskyToken.value ? 'token ok' : 'not yet attempted'),
            gfw: Boolean(env.GFW_TOKEN),
            acled: Boolean(env.ACLED_EMAIL && env.ACLED_PASSWORD),
            firms: Boolean(env.FIRMS_KEY),
            adsbx: Boolean(env.ADSBX_KEY),
          },
        });
      }

      if (path === '/') {
        return json({
          service: 'sentinel-feed-proxy',
          routes: ['/p?url=', '/osky', '/gfw/events', '/acled', '/firms', '/health',
                   '/spine/state', '/spine/since?t=', '/spine/series?metric=', '/spine/tick',
                   '/osm/military?bbox=', '/launches', '/tle?group=', '/cams?src='],
        });
      }

      return err('not found', 404);
    } catch (e) {
      return err(`worker error: ${e.message}`, 500);
    }
  },

  // The whole point of the spine: this runs whether or not anyone has the page
  // open, so the history is continuous rather than a record of when somebody
  // happened to be watching.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      spineTick(env, { force: true }).catch((e) => console.error('spine tick failed:', e && e.message)),
    );
  },
};
