// Harbor Traffic relay (Cloudflare Worker, free plan).
//   GET /aircraft  aircraft around Grays Harbor as {"ac": [...], "source", "at"} (live ADS-B)
//   GET /buses     Grays Harbor Transit buses as {"routes": [...], "buses": [...], "at"} (from GHT's public GPS tracker)
//   GET /debug     which feeds answered last and why any didn't
//   GET /hello     an open dashboard page checking in (count.js), for the viewer count
//   GET /viewers   the viewer count and daily totals (stats.html; needs the X-Stats-Key header to match STATS_KEY)
//   GET /bus-stats bus on-time and off-route stats (stats.html; same key). Logged once a minute by a Cron Trigger,
//                  every 20 s while someone's watching
//   GET /bus-export the raw bus logs as CSV (same key): ?table=positions|departures|weather_obs|road_alerts&days=30
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
    lastBus = { buses, routeName: Object.fromEntries(routes.map((r) => [r.id, r.name])), routeIds: routes.map((r) => r.id) };
    busReport = `buses: OK, ${routes.length} routes, ${buses.length} buses`;
  } catch (e) { busReport = `buses: ${e.message}`; }
}

// ---- bus log, for the stats page and for rebuilding the routes from where buses really drive (same D1 database).
// Every bus position is kept: every 20 s while someone has the map open, once a minute otherwise (a Cron Trigger on
// this Worker), with whether it was on its route's line (data/route-cells.json says which ~55 m squares each route
// uses; a moving bus more than about one square away is off route).
// Lateness comes from GPS: GHT's tracker publishes each route's timed stops (where, and when buses leave them). When
// a bus's track passes within 80 m of one, the last moment it's there is when it left; minus the scheduled time =
// how late. Each one also notes the conditions then: the weather at the nearest weather station (NWS), and any
// WSDOT road alert within 1.5 km of the stop. Weather and road alerts are logged on their own too, every 10 minutes.
// It's the same public information the tracker, NWS and WSDOT show; nothing about riders. Nothing is deleted
// (except once: version 2 wiped the first day's numbers, from a method that could make late buses look on time).
let lastBus = null, lastLogAt = 0;
const prevPos = {}; // bus -> { lat, lon, t, route }: its last logged position, to see which stops it passed since
const BUS_SCHEMA = '2';
let busTablesReady = false;
async function busTables(db) {
  if (busTablesReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)').run();
  const ver = (await db.prepare("SELECT v FROM meta WHERE k = 'bus_schema'").first())?.v;
  if (ver !== BUS_SCHEMA) {
    // a fresh start: the earlier lateness method followed the tracker's schedule, not the buses
    await db.batch(['arrivals', 'bus_seen', 'offroute', 'route_day', 'departures', 'positions', 'weather_obs', 'road_alerts']
      .map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS departures (day TEXT, t INTEGER, route TEXT, bus TEXT, stop TEXT, sched_min INTEGER, actual_min INTEGER,
      delay INTEGER, wx TEXT, temp INTEGER, wind INTEGER, precip REAL, alert TEXT, alert_road TEXT, PRIMARY KEY (day, bus, stop, sched_min))`),
    db.prepare('CREATE INDEX IF NOT EXISTS departures_day ON departures(day)'),
    db.prepare('CREATE TABLE IF NOT EXISTS positions (t INTEGER, day TEXT, route TEXT, bus TEXT, lat REAL, lon REAL, heading INTEGER, mph INTEGER, off INTEGER)'),
    db.prepare('CREATE INDEX IF NOT EXISTS positions_day ON positions(day, route)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS weather_obs (t INTEGER, day TEXT, station TEXT, wx TEXT, temp INTEGER, wind INTEGER, gust INTEGER, precip REAL,
      PRIMARY KEY (station, t))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS road_alerts (id TEXT PRIMARY KEY, kind TEXT, road TEXT, milepost REAL, lat REAL, lon REAL, headline TEXT,
      first_seen INTEGER, last_seen INTEGER)`),
    db.prepare(`INSERT INTO meta (k, v) VALUES ('bus_schema', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1`).bind(BUS_SCHEMA)
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
// each route's timed stops from the tracker: where, and the minutes after midnight buses leave them today
let timepoints = {}, tpAt = 0;
async function routeTimepoints(routeIds) {
  if (Date.now() - tpAt < 6 * 3600 * 1000 && Object.keys(timepoints).length) return timepoints;
  const out = {};
  await Promise.all(routeIds.map(async (id) => {
    try {
      const list = await (await fetch(`${GHT}/public_transit.php?command=busstops_transit&route_id=${id}`, { headers: UA })).json();
      out[id] = (list || []).map((s) => {
        const p = JSON.parse(s.BusStop_Point || '{}');
        const mins = String(s.BusStop_Name2 || '').split('\n').map(clockMin).filter((m) => m != null).sort((a, b) => a - b);
        return { name: String(s.Custom_BusStop_Name || s.BusStop_Name || '').trim(), lat: +p.lat, lon: +p.lng, mins };
      }).filter((s) => s.lat && s.lon && s.mins.length);
    } catch { /* this route next time */ }
  }));
  if (Object.keys(out).length) { timepoints = out; tpAt = Date.now(); }
  return timepoints;
}
// conditions, refreshed every 10 minutes: the latest observation at each nearby NWS station, and WSDOT's road alerts
// (from the file the site's collector keeps)
const WX_STATIONS = [['KHQM', 46.9712, -123.9366], ['KOLM', 46.9733, -122.9026], ['KSHN', 47.2336, -123.1475], ['KCLS', 46.677, -122.9828], ['KUIL', 47.9375, -124.555]];
let wxNow = {}, alertsNow = [], condAt = 0;
async function conditions(db) {
  if (Date.now() - condAt < 600000) return;
  condAt = Date.now();
  const steps = [];
  await Promise.all(WX_STATIONS.map(async ([id, lat, lon]) => {
    try {
      const p = (await (await fetch(`https://api.weather.gov/stations/${id}/observations/latest`, { headers: { ...UA, Accept: 'application/geo+json' } })).json()).properties;
      if (!p?.timestamp) return;
      const v = (o, f) => (o?.value != null ? f(o.value) : null);
      const w = { id, lat, lon, t: Date.parse(p.timestamp), wx: p.textDescription || '', temp: v(p.temperature, (c) => Math.round(c * 9 / 5 + 32)),
        wind: v(p.windSpeed, (k) => Math.round(k / 1.609)), gust: v(p.windGust, (k) => Math.round(k / 1.609)),
        precip: v(p.precipitationLastHour, (mm) => Math.round(mm / 25.4 * 100) / 100) };
      wxNow[id] = w;
      steps.push(db.prepare('INSERT OR IGNORE INTO weather_obs (t, day, station, wx, temp, wind, gust, precip) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(w.t, pacificDay(w.t), id, w.wx, w.temp, w.wind, w.gust, w.precip));
    } catch { /* that station next time */ }
  }));
  try {
    const j = await (await fetch(`https://traffic.harborevents.org/data/wsdot-alerts.json?t=${Date.now()}`)).json();
    alertsNow = (j.alerts || []).filter((a) => a.lat && a.lon);
    const now = Date.now();
    for (const a of alertsNow) steps.push(db.prepare(`INSERT INTO road_alerts (id, kind, road, milepost, lat, lon, headline, first_seen, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) ON CONFLICT(id) DO UPDATE SET kind = ?2, headline = ?7, last_seen = ?8`)
      .bind(String(a.id), a.kind, a.roadLabel || a.road || '', a.milepost ?? null, a.lat, a.lon, String(a.headline || '').slice(0, 300), now));
  } catch { /* next time */ }
  if (steps.length) await db.batch(steps);
}
const mDist = (a, b) => Math.hypot((b.lon - a.lon) * 76000, (b.lat - a.lat) * 111000);
// the conditions at a stop right now: nearest station's weather, and the most serious road alert within 1.5 km
function conditionsAt(p) {
  const w = Object.values(wxNow).sort((a, b) => mDist(p, a) - mDist(p, b))[0] || null;
  const order = ['closure', 'collision', 'work', 'other'];
  const near = alertsNow.filter((a) => mDist(p, a) < 1500 || (a.lat2 && mDist(p, { lat: a.lat2, lon: a.lon2 }) < 1500))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] || null;
  return { wx: w?.wx ?? null, temp: w?.temp ?? null, wind: w?.wind ?? null, precip: w?.precip ?? null, alert: near?.kind ?? null, alertRoad: near ? (near.roadLabel || near.road || '') : null };
}
const pacificMin = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(t).map((x) => [x.type, x.value]));
  return +p.hour * 60 + +p.minute;
};
const clockMin = (s) => { const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*([AP])M/i); return m ? ((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : null; };
const shortRoute = (name) => (String(name || '').match(/^\s*([0-9]+[A-Z]?)/) || [])[1] || '';
// how close the stretch a bus drove between two positions came to a point, and where along it (0..1)
function passBy(a, b, p) {
  const ax = (a.lon - p.lon) * 76000, ay = (a.lat - p.lat) * 111000, bx = (b.lon - p.lon) * 76000, by = (b.lat - p.lat) * 111000;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const f = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return { d: Math.hypot(ax + f * dx, ay + f * dy), f };
}
async function logBuses(env, minGapMs = 20000) {
  if (!env.DB || !lastBus) return;
  const now = Date.now();
  if (now - lastLogAt < minGapMs) return; // (at most every 20 s, however many people are watching)
  lastLogAt = now;
  const db = env.DB;
  await busTables(db);
  const day = pacificDay(now);
  const [c, tps] = await Promise.all([routeCells(), routeTimepoints(lastBus.routeIds), conditions(db)]);
  const steps = [];
  for (const b of lastBus.buses) {
    const rt = shortRoute(lastBus.routeName[b.route]);
    if (!rt || !b.lat || !b.lon) continue;
    // where it is, and whether that's on its route's line
    const set = c?.routes[rt];
    let off = null;
    if (set) {
      const i = Math.floor(b.lat / c.lat), j = Math.floor(b.lon / c.lon);
      off = 1;
      for (let di = -1; di <= 1 && off; di++) for (let dj = -1; dj <= 1; dj++) if (set.has(`${i + di},${j + dj}`)) { off = 0; break; }
    }
    steps.push(db.prepare('INSERT INTO positions (t, day, route, bus, lat, lon, heading, mph, off) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(now, day, rt, b.id, b.lat, b.lon, Math.round(b.heading || 0), Math.round(b.mph || 0), off));
    // lateness: timed stops its track passed since last time (while it's there, the time keeps moving up, so what's
    // left is when it pulled away)
    const prev = prevPos[b.id];
    if (prev && prev.route === b.route && now - prev.t < 150000) {
      for (const tp of tps[b.route] || []) {
        const { d, f } = passBy(prev, b, tp);
        if (d > 80) continue;
        const at = prev.t + f * (now - prev.t), aMin = pacificMin(at);
        // its scheduled time: the latest one no more than 3 minutes after it was there, within the last 90 minutes
        let sched = null;
        for (const m of tp.mins) if (m <= aMin + 3 && aMin - m <= 90) sched = m;
        if (sched == null) continue;
        const k = conditionsAt(tp);
        steps.push(db.prepare(`INSERT INTO departures (day, t, route, bus, stop, sched_min, actual_min, delay, wx, temp, wind, precip, alert, alert_road)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
          ON CONFLICT(day, bus, stop, sched_min) DO UPDATE SET t = ?2, actual_min = ?7, delay = ?8`)
          .bind(day, Math.round(at), rt, b.id, tp.name, sched, aMin, aMin - sched, k.wx, k.temp, k.wind, k.precip, k.alert, k.alertRoad));
      }
    }
    prevPos[b.id] = { lat: b.lat, lon: b.lon, t: now, route: b.route };
  }
  if (steps.length) await db.batch(steps);
}
async function busStats(db, days) {
  await busTables(db);
  const since = pacificDay(Date.now() - (days - 1) * 86400 * 1000);
  const q = (sql) => db.prepare(sql).bind(since);
  // on time = left 0 to 5 minutes after the scheduled time (early: before it; late: more than 5 after)
  const sums = 'COUNT(*) AS n, ROUND(AVG(delay), 1) AS avg, SUM(delay BETWEEN 0 AND 5) AS ontime, SUM(delay > 5) AS late, SUM(delay < 0) AS early';
  const weather = `CASE WHEN precip > 0 OR wx LIKE '%rain%' OR wx LIKE '%shower%' OR wx LIKE '%drizzle%' THEN 'rain'
    WHEN wx LIKE '%snow%' OR wx LIKE '%ice%' THEN 'snow or ice' WHEN wx LIKE '%fog%' THEN 'fog' WHEN wind >= 20 THEN 'windy'
    WHEN wx IS NULL THEN 'unknown' ELSE 'dry' END`;
  const [byRoute, byHour, stops, off, spots, daily, dist, byWx, byAlert, span] = await db.batch([
    q(`SELECT route, ${sums} FROM departures WHERE day >= ?1 GROUP BY route`),
    q(`SELECT actual_min / 60 AS h, ${sums} FROM departures WHERE day >= ?1 GROUP BY h ORDER BY h`),
    q(`SELECT route, stop, COUNT(*) AS n, ROUND(AVG(delay), 1) AS avg FROM departures WHERE day >= ?1 GROUP BY route, stop HAVING n >= 3
       ORDER BY avg DESC LIMIT 10`),
    q('SELECT route, COUNT(*) AS samples, SUM(off) AS off FROM positions WHERE day >= ?1 AND mph >= 3 AND off IS NOT NULL GROUP BY route'),
    q(`SELECT route, ROUND(lat * 500) / 500 AS lat, ROUND(lon * 350) / 350 AS lon, COUNT(*) AS n, COUNT(DISTINCT day) AS days, COUNT(DISTINCT bus) AS buses
       FROM positions WHERE day >= ?1 AND off = 1 AND mph >= 3 GROUP BY route, ROUND(lat * 500), ROUND(lon * 350) HAVING n >= 3 ORDER BY n DESC LIMIT 12`),
    q(`SELECT day, ${sums} FROM departures WHERE day >= ?1 GROUP BY day ORDER BY day`),
    q('SELECT MAX(-5, MIN(30, delay)) AS m, COUNT(*) AS n FROM departures WHERE day >= ?1 GROUP BY m ORDER BY m'),
    q(`SELECT ${weather} AS cond, ${sums} FROM departures WHERE day >= ?1 GROUP BY cond`),
    q(`SELECT COALESCE(alert, 'none') AS alert, ${sums} FROM departures WHERE day >= ?1 GROUP BY alert`),
    db.prepare('SELECT (SELECT MIN(day) FROM positions) AS first, (SELECT COUNT(*) FROM positions) AS positions, (SELECT COUNT(*) FROM departures) AS n')
  ]);
  return { days, since, byRoute: byRoute.results, byHour: byHour.results, stops: stops.results, off: off.results, spots: spots.results,
    daily: daily.results, dist: dist.results, byWx: byWx.results, byAlert: byAlert.results, first: span.results[0] };
}
// the raw logs as CSV, for backups or your own graphs
async function busExport(db, table, days) {
  await busTables(db);
  const cols = { positions: 't, day, route, bus, lat, lon, heading, mph, off',
    departures: 'day, t, route, bus, stop, sched_min, actual_min, delay, wx, temp, wind, precip, alert, alert_road',
    weather_obs: 't, day, station, wx, temp, wind, gust, precip', road_alerts: 'id, kind, road, milepost, lat, lon, headline, first_seen, last_seen' }[table];
  if (!cols) return null;
  const since = pacificDay(Date.now() - (days - 1) * 86400 * 1000);
  const alerts = table === 'road_alerts';
  const rows = (await db.prepare(`SELECT ${cols} FROM ${table} WHERE ${alerts ? 'last_seen >= ?1' : 'day >= ?1'} ORDER BY ${alerts ? 'first_seen' : 't'}`)
    .bind(alerts ? Date.now() - days * 86400 * 1000 : since).all()).results;
  const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.replace(/ /g, ''), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n');
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
  async fetch(request, env, ctx) {
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
      // while people are watching, the log gets a position every 20 s (finer tracks than the once-a-minute timer)
      ctx?.waitUntil(logBuses(env).catch(() => {}));
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
    // the raw logs as a CSV download (?table=positions|departures|weather_obs|road_alerts&days=30); key in the header
    if (path === '/bus-export') {
      if (!env.DB) return new Response('not set up (no DB binding)', { status: 503, headers: cors });
      if (!env.STATS_KEY || request.headers.get('X-Stats-Key') !== env.STATS_KEY)
        return new Response(env.STATS_KEY ? 'wrong key' : 'set the STATS_KEY secret first', { status: 403, headers: cors });
      const u = new URL(request.url), table = u.searchParams.get('table') || 'positions';
      const days = Math.max(1, Math.min(366, +u.searchParams.get('days') || 30));
      try {
        const csv = await busExport(env.DB, table, days);
        if (csv == null) return new Response('unknown table', { status: 400, headers: cors });
        return new Response(csv, { headers: { ...cors, 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="ght-${table}-${pacificDay(Date.now())}.csv"` } });
      } catch (e) { return new Response(`database: ${e.message}`, { status: 500, headers: cors }); }
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
      // no buses out last time (overnight, between runs): only look every 10 minutes until they're back, to go
      // easy on GHT's server; the first bus of the morning is still picked up within 10 minutes
      if (lastBus && !lastBus.buses.length && new Date(event.scheduledTime).getUTCMinutes() % 10 !== 0) return;
      if (!bus.body || Date.now() - bus.at > 30000) await refreshBuses();
      try { await logBuses(env, 45000); } catch (e) { console.log('bus log', e.message); }
    })());
  }
};
