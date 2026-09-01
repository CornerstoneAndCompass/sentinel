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
