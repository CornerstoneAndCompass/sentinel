/**
 * SENTINEL supplementary sources.
 *
 * Four feeds that all share one shape: the upstream is either far too large to
 * hand a browser, spread across a dozen requests, or in a format the dashboard
 * cannot use directly. Each one is fetched here, reduced to the smallest useful
 * record, and cached in KV — so the client gets one small request instead of
 * megabytes or a fan-out.
 *
 *   /osm/military?bbox=  installations from OpenStreetMap, replacing a
 *                        four-row hand-typed table
 *   /launches            upcoming and recent orbital launches
 *   /tle?group=          satellite elements from CelesTrak, the canonical
 *                        source, parsed into the shape satellite.js wants
 *   /cams?src=           public traffic cameras, normalised across operators
 *
 * None of these need an API key, which is deliberate: the board should be
 * useful to someone who has configured nothing.
 *
 * On provenance — these were identified independently and are queried against
 * each operator's own public API. Nothing here is derived from another
 * project's code or from datasets whose redistribution terms we have not read.
 */

const UA = 'Sentinel-OSINT/1.0 (+https://github.com/sentinel)';

// Every cache key carries this. Change the shape of anything a route returns
// and bump it: without a version, a deploy that fixes a parsing bug keeps
// serving the broken records until the TTL runs out, which is exactly how a
// fix looks like it did not work.
const V = 'v3';

async function cached(env, key, ttl, build) {
  try {
    const hit = await env.FEED_CACHE.get(key);
    if (hit) return { data: JSON.parse(hit), cache: 'hit' };
  } catch (e) { /* fall through and rebuild */ }
  const data = await build();
  try {
    await env.FEED_CACHE.put(key, JSON.stringify(data), { expirationTtl: ttl });
  } catch (e) { /* cache write is best-effort */ }
  return { data, cache: 'miss' };
}

function get(url, headers) {
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(headers || {}) },
    signal: AbortSignal.timeout(25000),
  });
}

/* ------------------------------------------------------- OSM installations --
   The dashboard shipped four hardcoded military bases. OpenStreetMap has tens
   of thousands, mapped and named, and Overpass will answer a bounded query for
   them in a couple of hundred milliseconds.

   Two constraints shape this. Overpass publishes a usage policy and throttles
   hard, so the bbox is rounded to whole degrees before it becomes a cache key —
   panning the map a little reuses the same cached answer rather than issuing a
   new query — and results are held for a day, which is far fresher than the
   table this replaces. The query is also area-capped, because "the whole world"
   is both useless on screen and abusive to ask for.
*/
const OSM_MIL_TAGS = [
  ['military', 'airfield'], ['military', 'base'], ['military', 'naval_base'],
  ['military', 'barracks'], ['military', 'training_area'],
];

// Overpass returns in its own order, so truncating at the cap would drop
// airfields in favour of whatever happened to be enumerated first. Rank by what
// an intelligence picture cares about, then cut.
const KIND_RANK = { airfield: 0, naval_base: 1, base: 2, barracks: 3, training_area: 4 };

export async function osmMilitary(request, env) {
  const p = new URL(request.url).searchParams;
  const raw = (p.get('bbox') || '').split(',').map(Number);
  if (raw.length !== 4 || raw.some((n) => !isFinite(n))) {
    return { error: 'bbox required as south,west,north,east' };
  }
  let [s, w, n, e] = raw;
  s = Math.max(-85, Math.min(85, s)); n = Math.max(-85, Math.min(85, n));
  if (n < s) [s, n] = [n, s];
  if (e < w) [w, e] = [e, w];
  // A query bigger than this returns more than can be drawn and is unfair to
  // a free endpoint; the client is expected to zoom in.
  if ((n - s) > 12 || (e - w) > 12) return { error: 'area too large — zoom in', maxDegrees: 12 };

  const r = (v, dir) => (dir < 0 ? Math.floor(v) : Math.ceil(v));
  const bs = r(s, -1), bw = r(w, -1), bn = r(n, 1), be = r(e, 1);
  const key = `osm:mil:${V}:${bs},${bw},${bn},${be}`;

  const { data, cache } = await cached(env, key, 86400, async () => {
    const box = `(${bs},${bw},${bn},${be})`;
    const parts = OSM_MIL_TAGS.map(([k, v]) => `nwr["${k}"="${v}"]${box};`);
    const q = `[out:json][timeout:50];(${parts.join('')});out center tags 400;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
      // Overpass is asked for 50s internally, so the client budget must exceed
      // it or a query that would have succeeded is cut off at our end.
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    const j = await res.json();
    const out = [];
    for (const el of j.elements || []) {
      const lat = el.lat ?? (el.center && el.center.lat);
      const lon = el.lon ?? (el.center && el.center.lon);
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      const t = el.tags || {};
      out.push({
        id: el.type[0] + el.id,
        name: t.name || t['name:en'] || null,
        kind: t.military || 'installation',
        operator: t.operator || t['operator:type'] || null,
        country: t['addr:country'] || null,
        lat: Math.round(lat * 1e5) / 1e5,
        lon: Math.round(lon * 1e5) / 1e5,
      });
    }
    out.sort((a, b) => {
      const r = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
      if (r) return r;
      // A named site is more useful than an unnamed polygon of the same kind.
      return (a.name ? 0 : 1) - (b.name ? 0 : 1);
    });
    const items = out.slice(0, 300);
    return {
      source: 'OpenStreetMap via Overpass', bbox: [bs, bw, bn, be],
      count: items.length, truncated: out.length > items.length, items,
    };
  });
  return { ...data, cache };
}

/* ------------------------------------------------------------- launches --
   Free, no key, and small. Both directions are useful on an intelligence
   board: what is about to go up, and what went up in the last few days.
*/
export async function launches(env) {
  const { data, cache } = await cached(env, `launches:${V}`, 1800, async () => {
    const base = 'https://ll.thespacedevs.com/2.2.0/launch/';
    const [up, prev] = await Promise.allSettled([
      get(base + 'upcoming/?limit=20'),
      get(base + 'previous/?limit=10'),
    ]);
    const rows = [];
    const take = (j, when) => {
      for (const r of (j && j.results) || []) {
        const pad = r.pad || {};
        const loc = pad.location || {};
        const lat = parseFloat(pad.latitude), lon = parseFloat(pad.longitude);
        rows.push({
          id: r.id, name: r.name, when,
          net: r.net || null,
          status: (r.status && (r.status.abbrev || r.status.name)) || null,
          provider: (r.launch_service_provider && r.launch_service_provider.name) || null,
          pad: pad.name || null,
          site: loc.name || null,
          lat: isFinite(lat) ? lat : null,
          lon: isFinite(lon) ? lon : null,
        });
      }
    };
    if (up.status === 'fulfilled' && up.value.ok) take(await up.value.json(), 'upcoming');
    if (prev.status === 'fulfilled' && prev.value.ok) take(await prev.value.json(), 'previous');
    if (!rows.length) throw new Error('no launch data');
    return { source: 'Launch Library 2', count: rows.length, items: rows };
  });
  return { ...data, cache };
}

/* ------------------------------------------------------------------ TLE --
   The dashboard was assembling its catalogue from eleven separate requests to
   a third-party mirror. CelesTrak is the source those mirrors copy, and one
   group request replaces the lot. It is served as three-line TLE text, which
   is parsed here into the {name, line1, line2, norad} records satellite.js
   already expects, so nothing downstream changes.

   Groups only — never the full active catalogue, which is over six megabytes
   and would be a hostile thing to hand a phone.
*/
const TLE_GROUPS = new Set([
  'stations', 'visual', 'active-geosynchronous', 'gps-ops', 'glo-ops', 'galileo',
  'beidou', 'science', 'weather', 'noaa', 'goes', 'resource', 'sarsat', 'military',
  'radar', 'geodetic', 'engineering', 'education', 'starlink', 'oneweb', 'planet',
  'spire', 'last-30-days',
]);

export async function tle(request, env) {
  const p = new URL(request.url).searchParams;
  const group = (p.get('group') || 'stations').toLowerCase();
  if (!TLE_GROUPS.has(group)) return { error: 'unknown group', groups: [...TLE_GROUPS] };
  const limit = Math.min(Math.max(parseInt(p.get('limit') || '300', 10) || 300, 1), 1200);
  try {

  // Twelve hours. CelesTrak asks clients to cache and it enforces that with
  // 503s — a handful of group requests in quick succession is enough to get
  // throttled. Elements stay usable for days, so this costs nothing in accuracy.
  const { data, cache } = await cached(env, `tle:${V}:${group}`, 43200, async () => {
    const res = await get(
      `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`,
      { Accept: 'text/plain' },
    );
    if (!res.ok) throw new Error(`celestrak ${res.status}`);
    const text = await res.text();
    if (/error|invalid/i.test(text.slice(0, 80)) && text.length < 200) {
      throw new Error('celestrak: ' + text.trim().slice(0, 80));
    }
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const items = [];
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const name = (lines[i] || '').trim();
      const l1 = lines[i + 1], l2 = lines[i + 2];
      if (!l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') continue;
      items.push({ name, line1: l1, line2: l2, norad: parseInt(l1.slice(2, 7), 10) });
    }
    if (!items.length) throw new Error('celestrak: no TLE records parsed');
    return { source: 'CelesTrak', group, count: items.length, items };
  });
  return { ...data, items: (data.items || []).slice(0, limit), cache };
  } catch (e) {
    return { source: 'CelesTrak', group, count: 0, items: [], error: String(e.message || e) };
  }
}

/* ------------------------------------------------------------- cameras --
   Public roadside cameras from operators that publish them openly. Both
   sources here are queried from their own official APIs and normalised to one
   record shape, so the dashboard does not have to know who runs which camera.

   The image URLs are handed back untouched and loaded directly by the browser;
   this worker deliberately does not proxy the frames themselves, which would
   turn a map pan into hundreds of megabytes through someone else's bandwidth
   and ours.
*/
async function tflCams() {
  const res = await get('https://api.tfl.gov.uk/Place/Type/JamCam');
  if (!res.ok) throw new Error(`tfl ${res.status}`);
  const j = await res.json();
  const out = [];
  for (const c of Array.isArray(j) ? j : []) {
    if (typeof c.lat !== 'number' || typeof c.lon !== 'number') continue;
    const props = {};
    for (const a of c.additionalProperties || []) props[a.key] = a.value;
    if (!props.imageUrl) continue;
    out.push({
      id: 'tfl:' + c.id, name: c.commonName || 'Camera',
      lat: c.lat, lon: c.lon,
      image: props.imageUrl, video: props.videoUrl || null,
      operator: 'Transport for London', region: 'London',
    });
  }
  return out;
}

// Caltrans publishes one file per district. Twelve small fetches beats asking
// the client to discover the districts itself, and the result is cached whole.
const CALTRANS_DISTRICTS = ['d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11','d12'];

async function caltransCams() {
  const results = await Promise.allSettled(CALTRANS_DISTRICTS.map((d) =>
    get(`https://cwwp2.dot.ca.gov/data/${d}/cctv/cctvStatusD${d.slice(1).padStart(2, '0')}.json`)
      .then((r) => (r.ok ? r.json() : null))));
  const out = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const row of r.value.data || []) {
      const c = row && row.cctv;
      if (!c) continue;
      const loc = c.location || {};
      const lat = parseFloat(loc.latitude), lon = parseFloat(loc.longitude);
      const img = ((c.imageData || {}).static || {}).currentImageURL;
      if (!isFinite(lat) || !isFinite(lon) || !img || !lat || !lon) continue;
      out.push({
        id: 'ct:' + (c.index || `${lat},${lon}`), name: loc.locationName || 'Camera',
        lat, lon, image: img, video: null,
        operator: 'Caltrans', region: 'California',
      });
    }
  }
  return out;
}

export async function cameras(request, env) {
  const src = (new URL(request.url).searchParams.get('src') || 'all').toLowerCase();
  const wanted = src === 'all' ? ['tfl', 'caltrans'] : [src];
  if (wanted.some((s) => s !== 'tfl' && s !== 'caltrans')) {
    return { error: 'unknown src', sources: ['tfl', 'caltrans', 'all'] };
  }
  const { data, cache } = await cached(env, `cams:${V}:${wanted.join('+')}`, 3600, async () => {
    const jobs = wanted.map((s) => (s === 'tfl' ? tflCams() : caltransCams()));
    const res = await Promise.allSettled(jobs);
    const items = [];
    const failed = [];
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...r.value);
      else failed.push(wanted[i] + ': ' + (r.reason && r.reason.message || 'failed'));
    });
    if (!items.length) throw new Error(failed.join('; ') || 'no cameras');
    return { source: 'operator open data', count: items.length, failed, items };
  });
  return { ...data, cache };
}

/* ------------------------------------------------------ wide-area traffic --
   adsb.lol answers all-traffic as a point and radius, capped at 250 nautical
   miles. That cap is per request, not a limit on what can be covered: a handful
   of overlapping circles tile a region several times wider, and merging them by
   Mode-S address removes the overlap.

   Global-in-one-call needs OpenSky, which cannot be reached from here — the
   connection is refused at the network level and Cloudflare synthesises a 522
   after twenty seconds, on the auth host as well as the data host, so
   credentials cannot help either. Tiling is what is actually available.

   Tiles are capped and cached deliberately. adsb.lol is community-run and free;
   a map that fans out nine uncached requests every thirty seconds is the kind
   of client that gets a service rate-limited for everybody.
*/
const NM_PER_DEG = 60;
const TILE_NM = 250;

/* How many tiles may be in flight at once. This is a rate-limit decision, not a
   performance one: the paid feed rejects a burst of six even when all six are
   comfortably inside the monthly plan, so widening this trades a working feed
   for a second of latency. Two is enough to keep a full sweep near three
   seconds while staying under the burst ceiling. */
const ADSBX_CONCURRENCY = 2;

/* Promise.allSettled with a width limit. Same result shape, so callers reading
   .status / .value / .reason do not change. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (e) { out[i] = { status: 'rejected', reason: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return out;
}
const MAX_TILES = 6;

export async function adsbArea(request, env) {
  try {
  const p = new URL(request.url).searchParams;
  const raw = (p.get('bbox') || '').split(',').map(Number);
  if (raw.length !== 4 || raw.some((n) => !isFinite(n))) {
    return { error: 'bbox required as south,west,north,east' };
  }
  let [s, w, n, e] = raw;
  if (n < s) [s, n] = [n, s];
  if (e < w) [w, e] = [e, w];
  s = Math.max(-85, s); n = Math.min(85, n);

  /* Circles of TILE_NM radius, spaced so their inscribed squares abut rather
     than their edges — otherwise the diagonals between circles are gaps.
     Longitude spacing widens with latitude because degrees of longitude get
     shorter towards the poles. */
  const stepLat = (TILE_NM / NM_PER_DEG) * 1.35;
  const midLat = (s + n) / 2;
  const lonScale = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const stepLon = stepLat / lonScale;

  /* Snapped to a fixed world grid rather than anchored to the bbox. This is the
     whole difference between a feed that works and one that gets rate-limited:
     centres derived from the camera shift on every pan, so every request is a
     fresh cache key and a fresh upstream hit. Snapped, panning within a tile
     reuses the cached answer and touches nothing upstream — which is why
     /v2/mil has been fine all along on one stable URL while point queries were
     429ing.

     Same lesson as rounding the Overpass bbox. Twice now. */
  const snap = (v, step) => Math.floor(v / step) * step + step / 2;
  const centres = [];
  for (let la = snap(s, stepLat); la <= n + stepLat && centres.length < MAX_TILES; la += stepLat) {
    for (let lo = snap(w, stepLon); lo <= e + stepLon && centres.length < MAX_TILES; lo += stepLon) {
      centres.push([Math.max(-85, Math.min(85, la)), lo]);
    }
  }
  if (!centres.length) centres.push([snap(midLat, stepLat), snap((w + e) / 2, stepLon)]);

  const key = 'adsb:area:' + V + ':' +
    centres.map(([a, o]) => a.toFixed(1) + ',' + o.toFixed(1)).join(';');

  const { data, cache } = await cached(env, key, 30, async () => {
    /* Paid feed first when configured — it is not subject to the shared-egress
       throttle that makes the free one return 429 to Cloudflare while answering
       a browser normally. Per tile, so one bad tile does not lose the rest. */
    const results = await mapPool(centres, ADSBX_CONCURRENCY, async ([la, lo]) => {
      const seg = '/v2/lat/' + la.toFixed(3) + '/lon/' + lo.toFixed(3) + '/dist/' + TILE_NM + '/';
      const paid = await adsbxFetch(env, seg);
      if (paid && !paid.error) return paid;
      // Carry the paid feed's reason forward. Reporting only the fallback's
      // failure hides why the primary did not answer, which is the same way
      // the milair collector sent me chasing the wrong host.
      const why = paid && paid.error ? paid.error : 'adsbx no key';
      const r = await get('https://api.adsb.lol/v2/point/'
        + la.toFixed(3) + '/' + lo.toFixed(3) + '/' + TILE_NM);
      if (!r.ok) throw new Error(why + ' -> adsb.lol ' + r.status);
      return r.json();
    });

    // Merged on Mode-S address, because overlapping circles return the same
    // aircraft more than once and a duplicated contact is worse than a missing
    // one — it looks like two aircraft in formation.
    const byHex = new Map();
    let ok = 0;
    const errs = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') { errs.push(String(r.reason && r.reason.message)); continue; }
      ok++;
      for (const a of (r.value && r.value.ac) || []) {
        if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
        if (!byHex.has(a.hex)) byHex.set(a.hex, a);
      }
    }
    if (!ok) throw new Error(errs[0] || 'no tile succeeded');
    const ac = [...byHex.values()];
    return {
      source: env.ADSBX_KEY ? 'adsbexchange, tiled' : 'adsb.lol, tiled',
      tiles: centres.length, tilesOk: ok,
      partial: ok < centres.length, errors: errs.slice(0, 3),
      count: ac.length,
      military: ac.filter((a) => (a.dbFlags || 0) & 1).length,
      ac,
    };
  });
  return { ...data, cache };
  } catch (e) {
    /* A throttled aggregator is an expected condition, not a server fault.
       Answer 200 with an empty set and say why, so the client can label it and
       keep the previous picture rather than clearing the sky on a hiccup. */
    const msg = String(e.message || e);
    return {
      source: 'adsb.lol, tiled', count: 0, ac: [],
      error: /429/.test(msg) ? 'rate limited upstream' : msg,
      rateLimited: /429/.test(msg),
    };
  }
}

/* ------------------------------------------------------------ ADSBexchange --
   A paid feed, which buys two things the free aggregators cannot give us from
   here: it does not rate-limit Cloudflare egress, and its quota is ours rather
   than shared with every Worker on the platform.

   The response format is the one adsb.lol mimics, so everything downstream —
   the parser, the airframe classification, the symbology — is unchanged. The
   only differences are the host, two headers, and that requests are now
   metered, which is why they are counted.

   Falls back to adsb.lol whenever the key is absent or the quota is spent, so
   the board degrades to the free feed rather than to an empty sky.
*/
const ADSBX_HOST = 'adsbexchange-com1.p.rapidapi.com';

// Rough running total, kept in KV. RapidAPI is the authority on billing; this
// exists so a runaway poll is visible on the board before it is visible on an
// invoice.
async function countThrottle(env) {
  try {
    const k = 'adsbx:429:' + new Date().toISOString().slice(0, 7);
    const cur = parseInt((await env.FEED_CACHE.get(k)) || '0', 10) || 0;
    await env.FEED_CACHE.put(k, String(cur + 1), { expirationTtl: 60 * 86400 });
  } catch (e) { /* bookkeeping must never break a feed */ }
}

async function countRequest(env, n = 1) {
  try {
    const k = 'adsbx:count:' + new Date().toISOString().slice(0, 7);   // per month
    const cur = parseInt((await env.FEED_CACHE.get(k)) || '0', 10) || 0;
    await env.FEED_CACHE.put(k, String(cur + n), { expirationTtl: 60 * 86400 });
    return cur + n;
  } catch (e) { return null; }
}

/* RapidAPI states the authoritative quota in response headers. Recording those
   beats counting calls ourselves: it counts what the biller counts, it survives
   a KV wipe, and it separates the two very different things a 429 can mean. */
async function noteQuota(env, remaining, limit, headers) {
  try {
    await env.FEED_CACHE.put('adsbx:quota', JSON.stringify({
      remaining, limit: isFinite(limit) ? limit : null, at: Date.now(), headers,
    }), { expirationTtl: 60 * 86400 });
  } catch (e) { /* bookkeeping must never break a feed */ }
}

export async function adsbxUsage(env) {
  const k = 'adsbx:count:' + new Date().toISOString().slice(0, 7);
  const [used, q] = await Promise.all([
    env.FEED_CACHE.get(k), env.FEED_CACHE.get('adsbx:quota'),
  ]);
  const quota = q ? JSON.parse(q) : null;
  return {
    month: k.slice(-7),
    requests: parseInt(used || '0', 10) || 0,       // our own count of 2xx calls
    remaining: quota ? quota.remaining : null,       // what RapidAPI last told us
    limit: quota ? quota.limit : null,
    quotaAt: quota ? new Date(quota.at).toISOString() : null,
    headers: quota ? quota.headers || null : null,
    throttled: parseInt((await env.FEED_CACHE.get('adsbx:429:' + k.slice(-7))) || '0', 10) || 0,
    configured: Boolean(env.ADSBX_KEY),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One call, whatever the path. Returns null when unusable so callers fall back.
export async function adsbxFetch(env, path, attempt = 0) {
  if (!env.ADSBX_KEY) return null;
  try {
    const r = await fetch('https://' + ADSBX_HOST + path, {
      headers: {
        'x-rapidapi-host': ADSBX_HOST,
        'x-rapidapi-key': env.ADSBX_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    /* RapidAPI names its quota headers after the plan, not uniformly, so the
       exact keys differ per API. Rather than guess, take whichever
       x-ratelimit-* pair actually arrives — the smallest 'remaining' is the
       binding one when a plan exposes several ceilings at once. */
    let remain = NaN, limit = NaN, seen = null;
    for (const [k, v] of r.headers) {
      if (!k.startsWith('x-ratelimit')) continue;
      (seen ||= {})[k] = v;
      const num = parseInt(v, 10);
      if (!isFinite(num)) continue;
      if (k.endsWith('-remaining') && (!isFinite(remain) || num < remain)) remain = num;
      else if (k.endsWith('-limit') && (!isFinite(limit) || num > limit)) limit = num;
    }
    if (seen) await noteQuota(env, isFinite(remain) ? remain : null, limit, seen);

    if (r.ok) { await countRequest(env); return await r.json(); }

    /* A 429 means one of two entirely different things, and treating them the
       same is what made six tiles look like a dead feed. With quota left it is
       the per-second burst limit — the tiles were dispatched together — so the
       answer is to wait and ask again. With the month spent, retrying only
       delays the fall back to the free feed. */
    if (r.status === 429) {
      const exhausted = isFinite(remain) && remain <= 0;
      if (!exhausted && attempt < 2) {
        await countThrottle(env);
        await sleep(300 * (attempt + 1) + Math.floor(Math.random() * 200));
        return adsbxFetch(env, path, attempt + 1);
      }
      return { error: exhausted ? 'adsbx quota spent' : 'adsbx 429', quotaExhausted: exhausted };
    }
    return { error: 'adsbx ' + r.status };
  } catch (e) {
    return { error: 'adsbx ' + (e.message || 'failed') };
  }
}

/* Live position for one named flight. This is the cheapest useful call on the
   board — one request whatever the sky is doing — which is what makes a flight
   watchlist practical on a metered plan. */
export async function flight(request, env) {
  const p = new URL(request.url).searchParams;
  const cs = (p.get('callsign') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const reg = (p.get('reg') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!cs && !reg) return { error: 'callsign or reg required' };

  const key = 'flight:' + V + ':' + (cs || 'r' + reg);
  const { data, cache } = await cached(env, key, 45, async () => {
    const path = cs ? '/v2/callsign/' + cs + '/' : '/v2/registration/' + reg + '/';
    let j = await adsbxFetch(env, path);
    let via = 'adsbexchange';
    if (!j || j.error) {
      // Free feed uses the same shape and the same path grammar.
      via = 'adsb.lol';
      const r = await get('https://api.adsb.lol' + path.replace(/\/$/, ''));
      j = r.ok ? await r.json() : null;
    }
    const ac = (j && j.ac) || [];
    if (!ac.length) return { via, found: false, query: cs || reg };
    const a = ac[0];
    return {
      via, found: true, query: cs || reg,
      callsign: (a.flight || '').trim(), hex: a.hex, reg: a.r, type: a.t,
      lat: a.lat, lon: a.lon, altFt: a.alt_baro, gs: a.gs, track: a.track,
      rate: a.baro_rate, squawk: a.squawk,
      onGround: a.alt_baro === 'ground',
    };
  });
  return { ...data, cache };
}
