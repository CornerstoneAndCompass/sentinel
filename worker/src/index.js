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
 *   GET /ais/snapshot?bbox=  global AIS positions from the aisstream socket
 *   GET /ais/vessels?mmsi=   positions for specific MMSIs (warship list)
 *   GET /gfw/events?..       Global Fishing Watch events (dark vessels)
 *   GET /acled?..            ACLED armed-conflict events
 *   GET /health              which upstreams and secrets are live
 */

const ALLOWED_HOSTS = new Set([
  // aircraft
  'api.adsb.lol',
  'opendata.adsb.fi',
  'api.airplanes.live',
  'opensky-network.org',
  // maritime
  'meri.digitraffic.fi',
  // events / hazards
  'api.gdeltproject.org',
  'www.gdacs.org',                 // global disaster alerts, EU JRC + UN OCHA
  'www.nhc.noaa.gov',              // tropical cyclones, Atlantic + E Pacific
  'api.weather.bom.gov.au',        // Australian warnings
  'www.rfs.nsw.gov.au',            // NSW Rural Fire Service incidents
  'data.emergency.vic.gov.au',     // VicEmergency incidents
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
  // space
  'tle.ivanstanojevic.me',
  'api.wheretheiss.at',
  // news
  'feeds.bbci.co.uk',
  'rss.nytimes.com',
  'www.defensenews.com',
  'www.defense.gov',
  'news.google.com',
  'www.aljazeera.com',
  'www.theguardian.com',
  'feeds.skynews.com',
  'api.reliefweb.int',
]);

// How long the edge may serve a cached copy, by upstream host or path hint.
const TTL = [
  [/adsb|airplanes\.live|opensky/, 8],
  [/digitraffic/, 20],
  [/gdeltproject/, 300],
  [/rss|feeds\.|xml|reliefweb|news\.google/, 180],
  [/gdacs|bom\.gov\.au/, 300],
  [/rfs\.nsw|emergency\.vic/, 120],
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

  // GDELT throttles hard but not absolutely: the same query 429s a few times
  // then succeeds, and its own message asks for one request every 5 seconds.
  // Waiting that out in the request path costs 45s+, so retry after responding
  // instead — this caller gets stale data now, the next one gets a warm cache.
  if (res.status === 429 && /gdeltproject/.test(upstream.hostname)) {
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
    if (env.FEED_CACHE && /gdeltproject|reliefweb/.test(upstream.hostname)) {
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

  const days = Math.min(parseInt(new URL(request.url).searchParams.get('days') || '1', 10), 10);
  const res = await fetch(
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_KEY}/VIIRS_SNPP_NRT/world/${days}`,
    { headers: { 'User-Agent': 'Sentinel-OSINT/1.0' } }
  );
  if (!res.ok) return json({ configured: true, error: `firms ${res.status}`, hotspots: [] });

  const text = await res.text();
  const rows = text.trim().split('\n');
  const head = (rows.shift() || '').split(',');
  const iLat = head.indexOf('latitude');
  const iLon = head.indexOf('longitude');
  const iConf = head.indexOf('confidence');
  const iDate = head.indexOf('acq_date');
  if (iLat < 0 || iLon < 0) return json({ configured: true, error: 'unexpected csv', hotspots: [] });

  const hotspots = [];
  for (const row of rows) {
    const c = row.split(',');
    const lat = parseFloat(c[iLat]);
    const lon = parseFloat(c[iLon]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    hotspots.push({ lat, lon, confidence: iConf >= 0 ? c[iConf] : null, date: iDate >= 0 ? c[iDate] : null });
  }
  return json({ configured: true, count: hotspots.length, hotspots }, 200, {
    'Cache-Control': 'public, max-age=600',
  });
}

/* -------------------------------------------------------------- opensky -- */

let oskyToken = { value: null, expires: 0 };
let oskyBlockedUntil = 0;

async function openskyToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (oskyToken.value && Date.now() < oskyToken.expires) return oskyToken.value;

  const res = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.OPENSKY_CLIENT_ID,
        client_secret: env.OPENSKY_CLIENT_SECRET,
      }),
    }
  );
  if (!res.ok) return null;

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
  const verdictKey = new Request('https://sentinel.internal/osky-blocked');
  if (Date.now() < oskyBlockedUntil) {
    return json({ blocked: true, reason: 'upstream refuses this IP range (cached verdict)', cached: true });
  }
  const cachedVerdict = await caches.default.match(verdictKey);
  if (cachedVerdict) {
    oskyBlockedUntil = Date.now() + 300000;
    return json({ blocked: true, reason: 'upstream refuses this IP range (cached verdict)', cached: true });
  }

  const markBlocked = (reason, extra = {}) => {
    oskyBlockedUntil = Date.now() + 1800000;
    ctx.waitUntil(
      caches.default.put(
        verdictKey,
        new Response('blocked', { headers: { 'Cache-Control': 'public, max-age=1800' } })
      )
    );
    return json({ blocked: true, reason, ...extra });
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

async function gfwEvents(request, env) {
  if (!env.GFW_TOKEN) return json({ configured: false, entries: [] });

  const p = new URL(request.url).searchParams;
  const types = p.get('types') || 'ENCOUNTER,LOITERING,GAP';
  const days = Math.min(parseInt(p.get('days') || '3', 10), 30);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);

  const url = new URL('https://gateway.api.globalfishingwatch.org/v3/events');
  url.searchParams.set('datasets[0]', 'public-global-encounters-events:latest');
  url.searchParams.set('start-date', start.toISOString().slice(0, 10));
  url.searchParams.set('end-date', end.toISOString().slice(0, 10));
  url.searchParams.set('limit', p.get('limit') || '100');
  url.searchParams.set('offset', '0');
  for (const t of types.split(',')) url.searchParams.append('types[]', t.trim());

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.GFW_TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) return json({ configured: true, error: `gfw ${res.status}`, entries: [] }, 200);

  const data = await res.json();
  return json({ configured: true, ...data }, 200, { 'Cache-Control': 'public, max-age=900' });
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

/* ------------------------------------------------------- aisstream bridge -- */

export class AisHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.vessels = new Map(); // mmsi -> { lat, lon, sog, cog, name, type, ts }
    this.ws = null;
    this.connectedAt = 0;
    this.lastMessage = 0;
    this.messages = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (!this.env.AISSTREAM_KEY) {
      return json({ configured: false, vessels: [] });
    }
    await this.ensureConnected();

    if (url.pathname.endsWith('/vessels')) {
      const want = (url.searchParams.get('mmsi') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const out = [];
      for (const m of want) {
        const v = this.vessels.get(m);
        if (v) out.push({ mmsi: m, ...v });
      }
      return json({ configured: true, count: out.length, vessels: out });
    }

    // /snapshot — optional bbox filter as minLon,minLat,maxLon,maxLat
    const bbox = (url.searchParams.get('bbox') || '')
      .split(',')
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '6000', 10), 20000);

    const out = [];
    for (const [mmsi, v] of this.vessels) {
      if (bbox.length === 4) {
        if (v.lon < bbox[0] || v.lon > bbox[2] || v.lat < bbox[1] || v.lat > bbox[3]) continue;
      }
      out.push({ mmsi, ...v });
      if (out.length >= limit) break;
    }

    return json({
      configured: true,
      count: out.length,
      tracked: this.vessels.size,
      messages: this.messages,
      connectedFor: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
      vessels: out,
    });
  }

  async ensureConnected() {
    const stale = this.lastMessage && Date.now() - this.lastMessage > 120000;
    if (this.ws && !stale) return;
    if (this.ws && stale) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    if (this.ws) return;

    try {
      const res = await fetch('https://stream.aisstream.io/v0/stream', {
        headers: { Upgrade: 'websocket' },
      });
      const ws = res.webSocket;
      if (!ws) throw new Error('no websocket in response');
      ws.accept();
      this.ws = ws;
      this.connectedAt = Date.now();
      this.lastMessage = Date.now();

      ws.send(
        JSON.stringify({
          APIKey: this.env.AISSTREAM_KEY,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        })
      );

      ws.addEventListener('message', (ev) => this.onMessage(ev));
      ws.addEventListener('close', () => {
        this.ws = null;
      });
      ws.addEventListener('error', () => {
        this.ws = null;
      });

      // Keep the object resident so the socket survives between requests.
      await this.state.storage.setAlarm(Date.now() + 20000);
    } catch (e) {
      this.ws = null;
    }
  }

  onMessage(ev) {
    this.lastMessage = Date.now();
    this.messages++;
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      return;
    }

    const meta = msg.MetaData || {};
    const mmsi = String(meta.MMSI || meta.MMSI_String || '');
    if (!mmsi) return;

    const prev = this.vessels.get(mmsi) || {};

    if (msg.MessageType === 'PositionReport') {
      const r = msg.Message?.PositionReport;
      if (!r) return;
      this.vessels.set(mmsi, {
        ...prev,
        lat: r.Latitude,
        lon: r.Longitude,
        sog: r.Sog,
        cog: r.Cog,
        heading: r.TrueHeading,
        navStat: r.NavigationalStatus,
        name: (meta.ShipName || prev.name || '').trim(),
        ts: Date.now(),
      });
    } else if (msg.MessageType === 'ShipStaticData') {
      const s = msg.Message?.ShipStaticData;
      if (!s) return;
      this.vessels.set(mmsi, {
        ...prev,
        name: (s.Name || meta.ShipName || prev.name || '').trim(),
        type: s.Type ?? prev.type,
        callsign: s.CallSign,
        destination: s.Destination,
        ts: prev.ts || Date.now(),
      });
    }

    // Cap memory: drop anything not heard from in 45 minutes.
    if (this.vessels.size > 40000) this.evict();
  }

  evict() {
    const cutoff = Date.now() - 2700000;
    for (const [mmsi, v] of this.vessels) {
      if ((v.ts || 0) < cutoff) this.vessels.delete(mmsi);
    }
  }

  async alarm() {
    this.evict();
    await this.ensureConnected();
    await this.state.storage.setAlarm(Date.now() + 20000);
  }
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

      if (path.startsWith('/ais/')) {
        if (!env.AIS_HUB) return json({ configured: false, vessels: [] });
        const id = env.AIS_HUB.idFromName('global');
        return await env.AIS_HUB.get(id).fetch(request);
      }

      if (path === '/health') {
        return json({
          ok: true,
          time: new Date().toISOString(),
          allowedHosts: ALLOWED_HOSTS.size,
          configured: {
            opensky: Boolean(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET),
            aisstream: Boolean(env.AISSTREAM_KEY),
            gfw: Boolean(env.GFW_TOKEN),
            acled: Boolean(env.ACLED_EMAIL && env.ACLED_PASSWORD),
            firms: Boolean(env.FIRMS_KEY),
          },
        });
      }

      if (path === '/') {
        return json({
          service: 'sentinel-feed-proxy',
          routes: ['/p?url=', '/osky', '/ais/snapshot', '/ais/vessels', '/gfw/events', '/acled', '/firms', '/health'],
        });
      }

      return err('not found', 404);
    } catch (e) {
      return err(`worker error: ${e.message}`, 500);
    }
  },
};
