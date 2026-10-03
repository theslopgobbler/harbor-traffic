// Harbor Traffic relay (Cloudflare Worker, free plan).
//   GET /aircraft  aircraft around Grays Harbor as {"ac": [...], "source", "at"} (live ADS-B)
//   GET /buses     Grays Harbor Transit buses as {"routes": [...], "buses": [...], "at"} (from GHT's public GPS tracker)
//   GET /debug     which feeds answered last and why any didn't
//   GET /hello     an open dashboard page checking in (count.js), for the viewer count
//   GET /viewers   the viewer count and daily totals (stats.html; needs the X-Stats-Key header to match STATS_KEY)
//   GET /bus-stats bus on-time and off-route stats (stats.html; same key). Logged once a minute by a Cron Trigger.
//   GET /site-stats harborevents.org visit stats from Umami Cloud (stats.html; same X-Stats-Key): the private
//                  share link (UMAMI_SHARE_URL secret), plus a numbers summary if UMAMI_API_KEY (paid plan) is set
// It only ever fetches those fixed lists (it's not an open proxy), answers only the dashboard's own site, and
// shares one fetch among everyone watching: aircraft at most every 15 s, buses at most every 9 s.

const ALLOWED = ['https://traffic.harborevents.org', 'http://localhost:8765'];
const UA = { 'User-Agent': 'harbor-traffic relay (traffic.harborevents.org)', Accept: 'application/json' };

// ---- aircraft: free community ADS-B feeds, tried in order (some refuse requests from Cloudflare's servers)
const AIR_SOURCES = [
  { name: 'adsb.lol', url: 'https://api.adsb.lol/v2/point/47.2/-123.65/55', list: (j) => j.ac },
  { name: 'adsb.fi', url: 'https://opendata.adsb.fi/api/v2/lat/47.2/lon/-123.65/dist/55', list: (j) => j.aircraft || j.ac }
];
let air = { at: 0, body: null, source: null, tried: 0 };
let airReport = [];

// OpenSky Network, used first when its credentials are set as Worker secrets (OPENSKY_CLIENT_ID and
// OPENSKY_CLIENT_SECRET). It accepts Cloudflare's servers because the account identifies us. Its replies
// don't include aircraft type or the military flag, so those come from call signs only.
let osToken = { value: null, until: 0 };
async function openSky(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) throw new Error('not set up (no secrets)');
  if (!osToken.value || Date.now() > osToken.until) {
    const t = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(env.OPENSKY_CLIENT_ID)}&client_secret=${encodeURIComponent(env.OPENSKY_CLIENT_SECRET)}`
    });
    if (!t.ok) throw new Error(`login HTTP ${t.status}`);
    const tj = await t.json();
    osToken = { value: tj.access_token, until: Date.now() + ((tj.expires_in || 1800) - 60) * 1000 };
  }
  const r = await fetch('https://opensky-network.org/api/states/all?lamin=46.5&lomin=-124.6&lamax=48&lomax=-122.7&extended=1',
    { headers: { Authorization: `Bearer ${osToken.value}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  // OpenSky's arrays -> the same shape as the ADS-B feeds (feet, knots, feet per minute)
  return (j.states || []).map((s) => ({
    hex: s[0], flight: (s[1] || '').trim(), lon: s[5], lat: s[6],
    alt_baro: s[8] ? 'ground' : s[7] != null ? Math.round(s[7] * 3.28084) : null,
    gs: s[9] != null ? s[9] * 1.94384 : null, track: s[10], baro_rate: s[11] != null ? Math.round(s[11] * 196.85) : null,
    squawk: s[14], category: s[17] >= 2 && s[17] <= 8 ? `A${s[17] - 1}` : null
  })).filter((a) => a.lat != null && a.lon != null);
}

async function refreshAir(env) {
  airReport = [];
  air.tried = Date.now();
  try {
    const list = await openSky(env);
    const at = Date.now();
    air = { at, tried: at, source: 'OpenSky', body: JSON.stringify({ ac: list, source: 'OpenSky', at: new Date(at).toISOString() }) };
    airReport.push(`OpenSky: OK, ${list.length} aircraft`);
    return;
  } catch (e) { airReport.push(`OpenSky: ${e.message}`); }
  for (const s of AIR_SOURCES) {
    try {
      const up = await fetch(s.url, { headers: UA });
      if (!up.ok) { airReport.push(`${s.name}: HTTP ${up.status}`); continue; }
      const list = s.list(await up.json());
      if (!Array.isArray(list)) { airReport.push(`${s.name}: unexpected reply`); continue; }
      const at = Date.now();
      air = { at, tried: at, source: s.name, body: JSON.stringify({ ac: list, source: s.name, at: new Date(at).toISOString() }) };
      airReport.push(`${s.name}: OK, ${list.length} aircraft`);
      return;
    } catch (e) { airReport.push(`${s.name}: ${e.message}`); }
  }
}

// ---- buses: Grays Harbor Transit's public GPS tracker (Unite GPS)
const GHT = 'https://transit.unitegps.com/gh/php';
let bus = { at: 0, body: null };
let busReport = '';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function refreshBuses() {
  try {
    const html = await (await fetch(`${GHT}/route_list.php`, { method: 'POST', headers: UA })).text();
    // each route: <div class='routeContainer ...' value='6251' style='...background-color:#f91701'> 20 - Aberdeen-Hoquiam<div> 811 - Stop - 12:30 PM<br>... </div>
    const routes = [];
    const re = /value='(\d+)'[^>]*?background-color:\s*(#[0-9a-fA-F]{3,6})[^>]*>([\s\S]*?)<div>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
      const name = text(m[3]);
      const next = m[4].split(/<br\s*\/?>/i).map(text).filter((s) => s && !/No Active Buses/i.test(s))
        .map((s) => { const p = s.split(' - '); return { bus: p[0], stop: p.slice(1, -1).join(' - '), time: p[p.length - 1] }; });
      routes.push({ id: m[1], color: m[2], name, next });
    }
    const buses = [];
    await Promise.all(routes.filter((r) => r.next.length).map(async (r) => {
      try {
        const list = await (await fetch(`${GHT}/public_transit.php?command=fetchbus&route_id=${r.id}&asset_id=`, { headers: UA })).json();
        for (const b of list || []) {
          const nx = r.next.find((n) => n.bus === String(b.Asset_Id));
          buses.push({ id: String(b.Asset_Id), route: r.id, lat: +b.lat1, lon: +b.lng1, heading: +b.Heading, mph: +b.Speed,
            nextStop: nx?.stop || null, nextTime: nx?.time || null });
        }
      } catch { /* skip this route this time */ }
    }));
    // route notices GHT posts to the tracker (detours, delays); shape varies, so keep any text they contain
    let notices = [];
    try {
      const ann = await (await fetch(`${GHT}/public_transit.php?command=load_announcements`, { headers: UA })).json();
      notices = (Array.isArray(ann) ? ann : []).map((a) => typeof a === 'string' ? text(a)
        : Object.values(a || {}).filter((v) => typeof v === 'string' && v.length > 3).map(text).join(' · ')).filter(Boolean);
    } catch { /* no notices this time */ }
    const at = Date.now();
    bus = { at, body: JSON.stringify({ routes: routes.map(({ id, color, name, next }) => ({ id, color, name, active: next.length })), buses, notices, at: new Date(at).toISOString() }) };
    lastBus = { buses, routeName: Object.fromEntries(routes.map((r) => [r.id, r.name])) };
    busReport = `buses: OK, ${routes.length} routes, ${buses.length} buses`;
  } catch (e) { busReport = `buses: ${e.message}`; }
}

// ---- bus log, for the stats page (same D1 database). Once a minute (a Cron Trigger on this Worker) the relay
// reads the buses and notes:
//   * lateness: the tracker lists each bus's next scheduled stop and time; when that switches to a later stop,
//     the bus has just passed the earlier one, so how late it was = now minus that stop's scheduled time
//   * how often each route's buses are off their route lines, and where (data/route-cells.json says which
//     ~55 m squares each route uses; a moving bus more than about one square from them is off route)
// It's the same public information the tracker shows; nothing about riders.
let lastBus = null;
let busTablesReady = false;
async function busTables(db) {
  if (busTablesReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS bus_seen (bus TEXT PRIMARY KEY, route TEXT, stop TEXT, sched TEXT, t INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS arrivals (day TEXT, t INTEGER, route TEXT, bus TEXT, stop TEXT, sched_min INTEGER, actual_min INTEGER, delay INTEGER)'),
    db.prepare('CREATE INDEX IF NOT EXISTS arrivals_day ON arrivals(day)'),
    db.prepare('CREATE TABLE IF NOT EXISTS offroute (day TEXT, t INTEGER, route TEXT, bus TEXT, lat REAL, lon REAL, heading INTEGER, mph INTEGER)'),
    db.prepare('CREATE INDEX IF NOT EXISTS offroute_day ON offroute(day)'),
    db.prepare('CREATE TABLE IF NOT EXISTS route_day (day TEXT, route TEXT, samples INTEGER DEFAULT 0, off INTEGER DEFAULT 0, PRIMARY KEY (day, route))')
  ]);
  busTablesReady = true;
}
let cells = null, cellsAt = 0;
async function routeCells() {
  if (!cells || Date.now() - cellsAt > 6 * 3600 * 1000) {
    try {
      const j = await (await fetch('https://traffic.harborevents.org/data/route-cells.json')).json();
      cells = { lat: j.lat, lon: j.lon, routes: Object.fromEntries(Object.entries(j.routes).map(([k, v]) => [k, new Set(v)])) };
      cellsAt = Date.now();
    } catch { /* try again next time */ }
  }
  return cells;
}
const pacificMin = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(t).map((x) => [x.type, x.value]));
  return +p.hour * 60 + +p.minute;
};
const clockMin = (s) => { const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*([AP])M/i); return m ? ((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : null; };
const shortRoute = (name) => (String(name || '').match(/^\s*([0-9]+[A-Z]?)/) || [])[1] || '';
async function logBuses(env) {
  if (!env.DB || !lastBus) return;
  const db = env.DB;
  await busTables(db);
  const now = Date.now(), day = pacificDay(now), nowMin = pacificMin(now);
  const seen = Object.fromEntries((await db.prepare('SELECT bus, route, stop, sched FROM bus_seen').all()).results.map((r) => [r.bus, r]));
  const c = await routeCells();
  const steps = [];
  for (const b of lastBus.buses) {
    const rt = shortRoute(lastBus.routeName[b.route]);
    const prev = seen[b.id];
    // passed a scheduled stop: how late
    if (prev && prev.stop && b.nextStop && prev.stop !== b.nextStop && prev.route === rt) {
      const sched = clockMin(prev.sched);
      if (sched != null) {
        let delay = nowMin - sched;
        if (delay < -720) delay += 1440; else if (delay > 720) delay -= 1440;
        if (delay > -30 && delay < 120) steps.push(db.prepare('INSERT INTO arrivals (day, t, route, bus, stop, sched_min, actual_min, delay) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
          .bind(day, now, rt, b.id, prev.stop, sched, nowMin, delay));
      }
    }
    if (!prev || prev.stop !== b.nextStop || prev.route !== rt)
      steps.push(db.prepare('INSERT INTO bus_seen (bus, route, stop, sched, t) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(bus) DO UPDATE SET route = ?2, stop = ?3, sched = ?4, t = ?5')
        .bind(b.id, rt, b.nextStop, b.nextTime, now));
    // on or off its route (moving buses only)
    const set = c?.routes[rt];
    if (set && b.mph >= 3) {
      const i = Math.floor(b.lat / c.lat), j = Math.floor(b.lon / c.lon);
      let on = false;
      for (let di = -1; di <= 1 && !on; di++) for (let dj = -1; dj <= 1; dj++) if (set.has(`${i + di},${j + dj}`)) { on = true; break; }
      steps.push(db.prepare('INSERT INTO route_day (day, route, samples, off) VALUES (?1, ?2, 1, ?3) ON CONFLICT(day, route) DO UPDATE SET samples = samples + 1, off = off + ?3')
        .bind(day, rt, on ? 0 : 1));
      if (!on) steps.push(db.prepare('INSERT INTO offroute (day, t, route, bus, lat, lon, heading, mph) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(day, now, rt, b.id, b.lat, b.lon, Math.round(b.heading || 0), Math.round(b.mph)));
    }
  }
  // once a day around 3 AM: off-route spots older than 60 days go (lateness records are kept)
  if (nowMin === 180) steps.push(db.prepare('DELETE FROM offroute WHERE day < ?1').bind(pacificDay(now - 60 * 86400 * 1000)));
  if (steps.length) await db.batch(steps);
}
async function busStats(db, days) {
  await busTables(db);
  const since = pacificDay(Date.now() - (days - 1) * 86400 * 1000);
  const q = (sql) => db.prepare(sql).bind(since);
  const [byRoute, byHour, stops, off, spots, span] = await db.batch([
    q(`SELECT route, COUNT(*) AS n, ROUND(AVG(delay), 1) AS avg, SUM(delay BETWEEN -1 AND 5) AS ontime, SUM(delay > 5) AS late, SUM(delay < -1) AS early
       FROM arrivals WHERE day >= ?1 GROUP BY route`),
    q('SELECT actual_min / 60 AS h, COUNT(*) AS n, ROUND(AVG(delay), 1) AS avg FROM arrivals WHERE day >= ?1 GROUP BY h ORDER BY h'),
    q(`SELECT route, stop, COUNT(*) AS n, ROUND(AVG(delay), 1) AS avg FROM arrivals WHERE day >= ?1 GROUP BY route, stop HAVING n >= 3
       ORDER BY avg DESC LIMIT 10`),
    q('SELECT route, SUM(samples) AS samples, SUM(off) AS off FROM route_day WHERE day >= ?1 GROUP BY route'),
    q(`SELECT route, ROUND(lat * 500) / 500 AS lat, ROUND(lon * 350) / 350 AS lon, COUNT(*) AS n, COUNT(DISTINCT day) AS days, COUNT(DISTINCT bus) AS buses
       FROM offroute WHERE day >= ?1 GROUP BY route, ROUND(lat * 500), ROUND(lon * 350) HAVING n >= 3 ORDER BY n DESC LIMIT 12`),
    db.prepare('SELECT MIN(day) AS first, COUNT(*) AS n FROM arrivals')
  ]);
  return { days, since, byRoute: byRoute.results, byHour: byHour.results, stops: stops.results, off: off.results, spots: spots.results, first: span.results[0] };
}

// ---- viewers: a small D1 database (binding DB) keeps the tally for everyone, so it can be set up entirely in
// the Cloudflare dashboard. It holds only random tab IDs with when each last checked in (cleared after an
// hour), plus per-day totals: page opens, the most at once, and opens by kind (TV, phone, desktop).
const WINDOW_MS = 3 * 60 * 1000;
const KINDS = ['tv', 'phone', 'desktop'];
const pacificDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t); // YYYY-MM-DD
let tablesReady = false;
async function viewerTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, kind TEXT, t INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, opens INTEGER DEFAULT 0, peak INTEGER DEFAULT 0, peak_at TEXT, tv INTEGER DEFAULT 0, phone INTEGER DEFAULT 0, desktop INTEGER DEFAULT 0)')
  ]);
  tablesReady = true;
}
async function hello(db, u) {
  const id = u.searchParams.get('id') || '', k = KINDS.includes(u.searchParams.get('k')) ? u.searchParams.get('k') : 'desktop';
  if (!/^[a-z0-9]{8,32}$/.test(id)) return new Response('bad id', { status: 400 });
  await viewerTables(db);
  const now = Date.now(), today = pacificDay(now);
  const steps = [
    db.prepare('INSERT INTO seen (id, kind, t) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET kind = ?2, t = ?3').bind(id, k, now),
    db.prepare('INSERT INTO days (day) VALUES (?1) ON CONFLICT(day) DO NOTHING').bind(today)
  ];
  // a newly opened tab: one more visit today (kind is one of three fixed names, so it's safe in the SQL)
  if (u.searchParams.get('first') === '1') steps.push(db.prepare(`UPDATE days SET opens = opens + 1, ${k} = ${k} + 1 WHERE day = ?1`).bind(today));
  // the most watching at once today
  steps.push(db.prepare(`UPDATE days SET peak = (SELECT COUNT(*) FROM seen WHERE t > ?3), peak_at = ?2
    WHERE day = ?1 AND peak < (SELECT COUNT(*) FROM seen WHERE t > ?3)`).bind(today, new Date(now).toISOString(), now - WINDOW_MS));
  // now and then, forget tabs that went quiet and days older than 60
  if (Math.random() < 0.05) {
    steps.push(db.prepare('DELETE FROM seen WHERE t < ?1').bind(now - 3600 * 1000));
    steps.push(db.prepare('DELETE FROM days WHERE day < ?1').bind(pacificDay(now - 60 * 86400 * 1000)));
  }
  await db.batch(steps);
  return Response.json({ ok: true });
}
async function viewerStats(db) {
  await viewerTables(db);
  const now = Date.now();
  const [live, days] = await db.batch([
    db.prepare('SELECT kind, COUNT(*) AS n FROM seen WHERE t > ?1 GROUP BY kind').bind(now - WINDOW_MS),
    db.prepare('SELECT day, opens, peak, peak_at AS peakAt, tv, phone, desktop FROM days ORDER BY day DESC LIMIT 30')
  ]);
  const byKind = Object.fromEntries(KINDS.map((x) => [x, 0]));
  for (const r of live.results) byKind[r.kind] = r.n;
  return Response.json({ now: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, days: days.results, at: new Date(now).toISOString() });
}

// ---- harborevents.org visit stats: read from Umami Cloud's API with the UMAMI_API_KEY secret and boiled down
// for stats.html. Cached for 5 minutes so the free API allowance is never an issue.
const UMAMI = 'https://api.umami.is/v1', UMAMI_SITE = '7268a50d-28a7-4129-849b-812cfb2ed175';
let siteCache = { at: 0, body: null };
async function siteStats(env) {
  if (siteCache.body && Date.now() - siteCache.at < 300000) return siteCache.body;
  const get = async (path, q = {}) => {
    const r = await fetch(`${UMAMI}/websites/${UMAMI_SITE}${path}?${new URLSearchParams(q)}`, { headers: { 'x-umami-api-key': env.UMAMI_API_KEY, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Umami ${path}: HTTP ${r.status}`);
    return r.json();
  };
  const num = (v) => (v && typeof v === 'object' ? v.value : v) || 0;   // older API wraps numbers as {value, prev}
  // midnight Pacific time today (works across daylight saving changes)
  const now = Date.now(), wall = Date.parse(new Date(now).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' UTC');
  const todayStart = Date.parse(`${pacificDay(now)}T00:00:00Z`) - (wall - now);
  const range = (days) => ({ startAt: String(now - days * 86400000), endAt: String(now) });
  const summary = async (q) => { const s = await get('/stats', q); const visits = num(s.visits);
    return { visitors: num(s.visitors), visits, views: num(s.pageviews), bounceRate: visits ? Math.round(num(s.bounces) / visits * 100) : 0,
      avgSeconds: visits ? Math.round(num(s.totaltime) / visits) : 0 }; };
  const metric = async (type, days = 30, limit = 10) => { try { return (await get('/metrics', { ...range(days), type, limit: String(limit) })).map((m) => ({ name: m.x || '(none)', n: m.y })); } catch { return []; } };
  const eventValues = async (event, propertyName) => { try {
    return (await get('/event-data/values', { ...range(30), event, propertyName })).map((v) => ({ name: v.value, n: v.total })).sort((a, b) => b.n - a.n).slice(0, 10);
  } catch { return []; } };
  const [active, today, week, month, daily, referrers, cities, regions, devices, browsers, clicks, areas, views, filters] = await Promise.all([
    get('/active').then((a) => num(a.visitors ?? a.x ?? a)).catch(() => null),
    summary({ startAt: String(todayStart), endAt: String(now) }), summary(range(7)), summary(range(30)),
    get('/pageviews', { ...range(30), unit: 'day', timezone: 'America/Los_Angeles' }).catch(() => ({})),
    metric('referrer'), metric('city'), metric('region'), metric('device'), metric('browser'), metric('event', 30, 20),
    eventValues('area', 'area'), eventValues('view', 'view'), eventValues('filter', 'filter')
  ]);
  const byDay = {};
  for (const p of daily.pageviews || []) (byDay[p.x.slice(0, 10)] ||= { views: 0, visitors: 0 }).views = p.y;
  for (const s of daily.sessions || []) (byDay[s.x.slice(0, 10)] ||= { views: 0, visitors: 0 }).visitors = s.y;
  const days = Object.entries(byDay).map(([day, v]) => ({ day, ...v })).sort((a, b) => b.day.localeCompare(a.day));
  siteCache = { at: now, body: JSON.stringify({ active, today, week, month, days, referrers, cities, regions, devices, browsers, clicks, areas, views, filters, at: new Date(now).toISOString() }) };
  return siteCache.body;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'X-Stats-Key',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const json = (body) => new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const path = new URL(request.url).pathname;

    if (path === '/debug') {
      await Promise.all([refreshAir(env), refreshBuses()]);
      return new Response([...airReport, `serving aircraft from: ${air.source || 'nothing yet'}`, busReport].join('\n'),
        { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }
    if (path === '/aircraft') {
      // OpenSky's free allowance (4,000 a day) covers one check every 30 s; the others every 15 s
      if (Date.now() - air.tried > (air.source === 'OpenSky' ? 30000 : 15000)) await refreshAir(env);
      return json(air.body || '{"ac":[]}');
    }
    if (path === '/buses') {
      if (!bus.body || Date.now() - bus.at > 9000) await refreshBuses(); // GHT's GPS updates about every 8 s
      return json(bus.body || '{"routes":[],"buses":[]}');
    }
    if (path === '/site-stats') {
      if (!env.STATS_KEY || request.headers.get('X-Stats-Key') !== env.STATS_KEY)
        return new Response(env.STATS_KEY ? 'wrong key' : 'set the STATS_KEY secret first', { status: 403, headers: cors });
      // Free Umami plan: only the private share link (UMAMI_SHARE_URL secret), which stats.html shows after the key.
      // The numbers summary needs an API key (UMAMI_API_KEY), which Umami only gives on its paid Pro plan.
      const share = /^https:\/\/cloud\.umami\.is\//.test(env.UMAMI_SHARE_URL || '') ? env.UMAMI_SHARE_URL : null;
      if (!env.UMAMI_API_KEY) return share ? json(JSON.stringify({ share }))
        : new Response('site stats not set up (add the UMAMI_SHARE_URL secret)', { status: 503, headers: cors });
      try { return json(JSON.stringify({ ...JSON.parse(await siteStats(env)), share })); }
      catch (e) { return share ? json(JSON.stringify({ share, error: e.message })) : new Response(e.message, { status: 502, headers: cors }); }
    }
    // bus on-time and off-route stats for stats.html (?days=7, up to 60)
    if (path === '/bus-stats') {
      if (!env.DB) return new Response('bus stats not set up (no DB binding)', { status: 503, headers: cors });
      if (!env.STATS_KEY || request.headers.get('X-Stats-Key') !== env.STATS_KEY)
        return new Response(env.STATS_KEY ? 'wrong key' : 'set the STATS_KEY secret first', { status: 403, headers: cors });
      const days = Math.max(1, Math.min(60, +new URL(request.url).searchParams.get('days') || 7));
      try { return json(JSON.stringify(await busStats(env.DB, days))); }
      catch (e) { return new Response(`database: ${e.message}`, { status: 500, headers: cors }); }
    }
    if (path === '/hello' || path === '/viewers') {
      if (!env.DB) return new Response('viewer count not set up (no DB binding)', { status: 503, headers: cors });
      if (path === '/viewers' && (!env.STATS_KEY || request.headers.get('X-Stats-Key') !== env.STATS_KEY))
        return new Response(env.STATS_KEY ? 'wrong key' : 'set the STATS_KEY secret first', { status: 403, headers: cors });
      // only the dashboard's own pages check in
      if (path === '/hello' && !ALLOWED.includes(origin)) return new Response('', { status: 403, headers: cors });
      try {
        const r = path === '/hello' ? await hello(env.DB, new URL(request.url)) : await viewerStats(env.DB);
        return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(`database: ${e.message}`, { status: 500, headers: cors });
      }
    }
    return new Response('Harbor Traffic relay. Try /aircraft or /buses', { status: 404, headers: cors });
  },
  // once a minute (a Cron Trigger "* * * * *" on this Worker): read the buses and log for the stats page, even
  // when nobody has the map open
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!bus.body || Date.now() - bus.at > 30000) await refreshBuses();
      try { await logBuses(env); } catch (e) { console.log('bus log', e.message); }
    })());
  }
};
