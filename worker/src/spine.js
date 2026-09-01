/**
 * SENTINEL spine — the part that keeps watching when nobody is looking.
 *
 * The dashboard fetched everything on page load and forgot it on unload, which
 * meant it could only ever answer "what is happening". The question an intel
 * board actually has to answer is "what changed since I last looked", and that
 * needs something that accumulates. This is that something: a cron pass that
 * samples a handful of cheap global metrics, keeps a rolling history, and
 * writes an event whenever a metric crosses out of its own normal range.
 *
 * Two things fall out of having a history that were impossible without one:
 *
 *   - Context. "12 military aircraft" is a number. "12, against a 7-day median
 *     of 3" is intelligence. Every counter can carry its own baseline.
 *   - Continuity. Close the tab for six hours and the board can tell you what
 *     it saw while you were gone.
 *
 * Storage is the KV namespace the proxy already binds, under a `spine:` prefix,
 * so this needs no new infrastructure to run. KV cannot aggregate, so the
 * samples are kept as one array per day and the derived baselines are written
 * back on every tick — reading the board costs two gets, not seven hundred.
 * If this outgrows KV the natural move is D1, where the medians become SQL.
 */

const DAY = 86400000;
const KEEP_DAYS = 14;            // history retained; baselines use the last 7
const TTL = (KEEP_DAYS + 2) * 86400;
const MIN_TICK_MS = 60000;       // floor between ticks, so /spine/tick cannot be used to hammer upstreams

// The same identity the proxy sends. adsb.lol answers 403 to an unidentified
// client, which is how the first version of this file recorded a dead feed.
const UA = 'Sentinel-OSINT/1.0 (+https://github.com/sentinel)';

const iso = (t) => new Date(t).toISOString();
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/* --------------------------------------------------------------- metrics --
   Each collector is independent and failure-tolerant: an upstream that is down
   records null for its metrics rather than losing the whole sample. Baselines
   skip nulls, so a feed outage leaves a gap instead of a false zero — which
   matters, because a zero here would read as "nothing happening" rather than
   "we could not see". Every host below is already in the proxy allowlist and
   has been measured working from the edge.
*/
const COLLECTORS = [
  {
    keys: ['milair'],
    // Two aggregators for one number, same order the dashboard tries them in:
    // whichever is answering, the series stays continuous rather than gapping
    // every time one of them rate-limits.
    async run() {
      // adsb.lol rate-limits shared Cloudflare egress and answers 429
      // intermittently — the passthrough route survives that with a stale cache
      // and a background retry, and this had no equivalent, so a single 429 was
      // recording a null for the whole sample. One patient retry is enough:
      // measured, the second attempt succeeds.
      const bases = ['https://api.adsb.lol/v2/mil', 'https://api.airplanes.live/v2/mil'];
      const errs = [];
      for (const url of bases) {
        const host = new URL(url).host;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 2500));
          try {
            const r = await fetch(url, {
              headers: { Accept: 'application/json', 'User-Agent': UA },
              signal: AbortSignal.timeout(12000),
            });
            if (!r.ok) {
              errs.push(`${host} ${r.status}`);
              if (r.status === 429) continue;      // worth waiting out
              break;                               // 403 will not change on retry
            }
            const j = await r.json();
            if (Array.isArray(j.ac)) return { milair: j.ac.length };
            errs.push(`${host} no ac[]`);
            break;
          } catch (e) {
            errs.push(`${host} ${e.message}`);
            break;
          }
        }
      }
      // Every host and every attempt, not just the last — reporting only the
      // final failure hid which source actually broke and sent me chasing the
      // wrong one.
      throw new Error(errs.join(', '));
    },
  },
  {
    keys: ['quakes', 'quakeM5', 'quakeM6'],
    async run() {
      const r = await fetch(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
        { signal: AbortSignal.timeout(12000) },
      );
      if (!r.ok) throw new Error(`usgs ${r.status}`);
      const j = await r.json();
      const f = j.features || [];
      const mag = (x) => (x.properties && typeof x.properties.mag === 'number' ? x.properties.mag : 0);
      return {
        quakes: f.length,
        quakeM5: f.filter((x) => mag(x) >= 5 && mag(x) < 6).length,
        quakeM6: f.filter((x) => mag(x) >= 6).length,
      };
    },
  },
  {
    keys: ['gdacsRed', 'gdacsOrange'],
    async run() {
      // Same 14-day last-update window the dashboard uses, so the two agree.
      const fmt = (d) => new Date(d).toISOString().slice(0, 10);
      const url =
        'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH' +
        `?fromDate=${fmt(Date.now() - 14 * DAY)}&toDate=${fmt(Date.now())}` +
        '&alertlevel=Orange;Red';
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`gdacs ${r.status}`);
      const j = await r.json();
      const f = (j && j.features) || [];
      const lvl = (x) => String((x.properties && x.properties.alertlevel) || '').toLowerCase();
      return {
        gdacsRed: f.filter((x) => lvl(x) === 'red').length,
        gdacsOrange: f.filter((x) => lvl(x) === 'orange').length,
      };
    },
  },
  {
    keys: ['kp'],
    async run() {
      const r = await fetch(
        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
        { signal: AbortSignal.timeout(12000) },
      );
      if (!r.ok) throw new Error(`swpc ${r.status}`);
      const rows = await r.json();
      // Measured, not assumed: this product is an array of objects
      // ({time_tag, kp, observed}), unlike the array-of-arrays SWPC uses
      // elsewhere. Take the most recent row that is not a forecast.
      const now = Date.now();
      let best = null;
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        if (String(row.observed || '').toLowerCase() === 'predicted') continue;
        const t = Date.parse(String(row.time_tag || '') + 'Z');
        const v = typeof row.kp === 'number' ? row.kp : parseFloat(row.kp);
        if (!isFinite(t) || !isFinite(v) || t > now + 60000) continue;
        if (!best || t > best.t) best = { t, v };
      }
      if (!best) throw new Error('no observed Kp row');
      return { kp: best.v };
    },
  },
];

async function collect() {
  const m = {};
  const failed = [];
  const results = await Promise.allSettled(COLLECTORS.map((c) => c.run()));
  results.forEach((res, i) => {
    const c = COLLECTORS[i];
    if (res.status === 'fulfilled' && res.value) {
      Object.assign(m, res.value);
    } else {
      c.keys.forEach((k) => { m[k] = null; });
      failed.push(c.keys[0] + ': ' + (res.reason && res.reason.message ? res.reason.message : 'failed'));
    }
  });
  return { t: Date.now(), m, failed };
}

/* ------------------------------------------------------------- statistics --
   Median rather than mean, because these series are spiky by nature and one
   M7 should not drag the "normal" up for a week. p90 gives the threshold for
   "unusual" without having to assume a distribution.
*/
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// A metric is only "high" if it is both outside its own recent range and large
// enough in absolute terms to be worth saying out loud. Without the floor, a
// median of 0 makes every 1 an anomaly.
const FLOOR = { milair: 40, quakes: 12, quakeM5: 3, quakeM6: 1, gdacsRed: 1, gdacsOrange: 4, kp: 5 };

const LABEL = {
  milair: 'military aircraft airborne',
  quakes: 'earthquakes M2.5+ (24h)',
  quakeM5: 'earthquakes M5–6 (24h)',
  quakeM6: 'earthquakes M6+ (24h)',
  gdacsRed: 'GDACS red alerts',
  gdacsOrange: 'GDACS orange alerts',
  kp: 'geomagnetic Kp index',
};

const METRICS = Object.keys(LABEL);

/* ------------------------------------------------------------------- store */

async function readDay(env, d) {
  const raw = await env.FEED_CACHE.get(`spine:day:${d}`);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function readEvents(env, d) {
  const raw = await env.FEED_CACHE.get(`spine:events:${d}`);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function recentSamples(env, days) {
  const out = [];
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(dayKey(Date.now() - i * DAY));
  const parts = await Promise.all(keys.map((d) => readDay(env, d)));
  parts.forEach((p) => out.push(...p));
  return out.sort((a, b) => a.t - b.t);
}

function computeBaselines(samples) {
  const out = {};
  for (const k of METRICS) {
    const vals = samples.map((s) => s.m && s.m[k]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    out[k] = vals.length
      ? { n: vals.length, median: quantile(vals, 0.5), p90: quantile(vals, 0.9), min: vals[0], max: vals[vals.length - 1] }
      : { n: 0, median: null, p90: null, min: null, max: null };
  }
  return out;
}

/* ------------------------------------------------------------------- tick --
   One pass: sample, append, recompute, and record any metric that has just
   crossed out of normal. Crossing is compared against the previous sample, so
   an event fires on the transition rather than every fifteen minutes for as
   long as the condition holds.
*/
export async function tick(env, { force = false } = {}) {
  const lastRaw = await env.FEED_CACHE.get('spine:latest');
  let last = null;
  try { last = lastRaw ? JSON.parse(lastRaw) : null; } catch { last = null; }
  if (!force && last && Date.now() - last.t < MIN_TICK_MS) {
    return { skipped: 'throttled', last: iso(last.t) };
  }

  const sample = await collect();
  const d = dayKey(sample.t);

  const day = await readDay(env, d);
  day.push({ t: sample.t, m: sample.m });
  await env.FEED_CACHE.put(`spine:day:${d}`, JSON.stringify(day), { expirationTtl: TTL });

  const samples = await recentSamples(env, 7);
  const base = computeBaselines(samples);
  await env.FEED_CACHE.put('spine:baselines', JSON.stringify({ t: sample.t, base }), { expirationTtl: TTL });

  // Crossings, against the previous sample so each transition speaks once.
  const events = [];
  for (const k of METRICS) {
    const now = sample.m[k];
    const then = last && last.m ? last.m[k] : null;
    const b = base[k];
    if (typeof now !== 'number' || !b || b.n < 8 || b.p90 === null) continue;
    const floor = FLOOR[k] ?? 1;
    const hot = (v) => typeof v === 'number' && v >= floor && v > b.p90 && v >= (b.median || 0) * 1.5;
    if (hot(now) && !hot(then)) {
      events.push({
        t: sample.t, kind: 'threshold', metric: k, value: now,
        median: b.median, p90: b.p90,
        sev: now >= (b.median || 0) * 3 ? 'high' : 'moderate',
        text: `${LABEL[k]}: ${round(now)} — normal is ${round(b.median)} (7-day median)`,
      });
    }
  }
  // A feed that stops answering is itself worth recording; a silent gap in the
  // history otherwise looks identical to a quiet period.
  if (sample.failed.length) {
    events.push({
      t: sample.t, kind: 'collector', sev: 'low',
      text: `collector failure — ${sample.failed.join('; ')}`,
    });
  }

  if (events.length) {
    const existing = await readEvents(env, d);
    existing.push(...events);
    await env.FEED_CACHE.put(`spine:events:${d}`, JSON.stringify(existing), { expirationTtl: TTL });
  }

  await env.FEED_CACHE.put('spine:latest', JSON.stringify(sample), { expirationTtl: TTL });
  return { t: iso(sample.t), metrics: sample.m, failed: sample.failed, events: events.length, samples: samples.length };
}

function round(v) {
  if (typeof v !== 'number') return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// Kp arrives as thirds, so subtracting two samples produces things like
// 1.0099999999999998. Nothing downstream wants more than two decimals, and
// shipping the artifact makes the API look careless.
function num(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
}

/* ------------------------------------------------------------------ reads */

async function loadBaselines(env) {
  const raw = await env.FEED_CACHE.get('spine:baselines');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function loadLatest(env) {
  const raw = await env.FEED_CACHE.get('spine:latest');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// Everything the board needs to render current-with-context in one request.
export async function state(env) {
  const [latest, baselines] = await Promise.all([loadLatest(env), loadBaselines(env)]);
  if (!latest) return { ready: false, reason: 'no samples yet' };
  const base = (baselines && baselines.base) || {};
  const metrics = {};
  for (const k of METRICS) {
    const b = base[k] || {};
    const v = latest.m[k];
    metrics[k] = {
      label: LABEL[k],
      value: typeof v === 'number' ? num(v) : null,
      median: num(b.median ?? null),
      p90: num(b.p90 ?? null),
      n: b.n || 0,
      // Only claim a metric is unusual once there is enough history to say so.
      state: classify(v, b, FLOOR[k] ?? 1),
    };
  }
  return { ready: true, t: iso(latest.t), ageSec: Math.round((Date.now() - latest.t) / 1000), metrics, failed: latest.failed || [] };
}

function classify(v, b, floor) {
  if (typeof v !== 'number') return 'unknown';
  if (!b || (b.n || 0) < 8 || b.p90 === null) return 'learning';
  if (v >= floor && v > b.p90 && v >= (b.median || 0) * 1.5) return 'high';
  if (b.median !== null && v < (b.median || 0) * 0.5 && (b.median || 0) >= floor) return 'low';
  return 'normal';
}

// "What changed while I was away." Events since the cursor, plus a then/now on
// every metric so the answer is a difference rather than another snapshot.
export async function since(env, sinceMs) {
  const cutoff = Number.isFinite(sinceMs) ? sinceMs : Date.now() - 6 * 3600000;
  const days = Math.min(KEEP_DAYS, Math.max(1, Math.ceil((Date.now() - cutoff) / DAY) + 1));

  const dayKeys = [];
  for (let i = 0; i < days; i++) dayKeys.push(dayKey(Date.now() - i * DAY));
  const [eventParts, samples, baselines] = await Promise.all([
    Promise.all(dayKeys.map((d) => readEvents(env, d))),
    recentSamples(env, days),
    loadBaselines(env),
  ]);

  const events = eventParts.flat().filter((e) => e.t > cutoff).sort((a, b) => b.t - a.t);
  const newest = samples[samples.length - 1] || null;
  // The sample nearest the cursor is the "then" side of the comparison.
  let then = null;
  for (const s of samples) { if (s.t <= cutoff) then = s; }
  if (!then) then = samples[0] || null;

  const base = (baselines && baselines.base) || {};
  const deltas = {};
  if (newest && then) {
    for (const k of METRICS) {
      const a = then.m ? then.m[k] : null;
      const b = newest.m ? newest.m[k] : null;
      if (typeof a !== 'number' || typeof b !== 'number' || a === b) continue;
      deltas[k] = {
        label: LABEL[k], then: num(a), now: num(b), change: num(b - a),
        median: num((base[k] || {}).median ?? null),
      };
    }
  }
  return {
    ready: Boolean(newest),
    since: iso(cutoff),
    now: newest ? iso(newest.t) : null,
    gapSec: newest ? Math.round((newest.t - cutoff) / 1000) : 0,
    events: events.slice(0, 60),
    deltas,
  };
}

// Raw series for sparklines. Downsampled so a week of 15-minute samples does
// not ship 700 points to draw 60 pixels.
export async function series(env, metric, days, points) {
  if (!METRICS.includes(metric)) return { error: 'unknown metric', metrics: METRICS };
  const d = Math.min(KEEP_DAYS, Math.max(1, days || 7));
  const samples = await recentSamples(env, d);
  const vals = samples
    .map((s) => ({ t: s.t, v: s.m ? s.m[metric] : null }))
    .filter((x) => typeof x.v === 'number');
  const want = Math.min(Math.max(points || 60, 8), 400);
  const step = Math.max(1, Math.ceil(vals.length / want));
  const out = [];
  for (let i = 0; i < vals.length; i += step) out.push([vals[i].t, vals[i].v]);
  return { metric, label: LABEL[metric], days: d, n: vals.length, points: out };
}

export const SPINE_METRICS = METRICS;
