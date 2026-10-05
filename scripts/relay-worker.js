// Harbor Traffic relay (Cloudflare Worker, free plan).
//   GET /aircraft  aircraft around Grays Harbor as {"ac": [...], "source", "at"} (live ADS-B)
//   GET /buses     Grays Harbor Transit buses as {"routes": [...], "buses": [...], "at"} (from GHT's public GPS tracker)
//   GET /debug     which feeds answered last and why any didn't
//   GET /hello     an open dashboard page checking in (count.js), for the viewer count
//   GET /viewers   the viewer count and daily totals (stats.html; needs the X-Stats-Key header to match STATS_KEY)
//   GET /bus-stats bus on-time and off-route stats (stats.html; same key). Logged by a once-a-minute Cron Trigger
//   GET /bus-export the raw bus logs as CSV (same key): ?table=positions|departures|weather_obs|road_alerts|positions_v2
//                  &days=30, in pages: when the X-Next header is set, ask again with &after=<it> for the rest
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
// returns how many requests it made (the once-a-minute log has a budget of them, and skips GHT's notices)
async function refreshBuses(withNotices = true) {
  let used = 1;
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
    used += routes.filter((r) => r.next.length).length + (withNotices ? 1 : 0);
    await Promise.all(routes.filter((r) => r.next.length).map(async (r) => {
      try {
        const list = await (await fetch(`${GHT}/public_transit.php?command=fetchbus&route_id=${r.id}&asset_id=`, { headers: UA })).json();
        for (const b of list || []) {
          const nx = r.next.find((n) => n.bus === String(b.Asset_Id));
          // listed: the tracker's route list names this bus as running the route. Its position feed also returns
          // buses that aren't (parked at GHT's base, for one), which the bus log must not count
          buses.push({ id: String(b.Asset_Id), route: r.id, lat: +b.lat1, lon: +b.lng1, heading: +b.Heading, mph: +b.Speed,
            nextStop: nx?.stop || null, nextTime: nx?.time || null, listed: !!nx });
        }
      } catch { /* skip this route this time */ }
    }));
    // a bus can come back in several routes' feeds: keep it once, under the route the route list names it on
    const byId = new Map();
    for (const b of buses) { const had = byId.get(b.id); if (!had || (b.listed && !had.listed)) byId.set(b.id, b); }
    buses.splice(0, buses.length, ...byId.values());
    // route notices GHT posts to the tracker (detours, delays); shape varies, so keep any text they contain
    let notices = [];
    try { notices = JSON.parse(bus.body || '{}').notices || []; } catch { /* none kept */ }
    if (withNotices) try {
      notices = [];
      const ann = await (await fetch(`${GHT}/public_transit.php?command=load_announcements`, { headers: UA })).json();
      notices = (Array.isArray(ann) ? ann : []).map((a) => typeof a === 'string' ? text(a)
        : Object.values(a || {}).filter((v) => typeof v === 'string' && v.length > 3).map(text).join(' · ')).filter(Boolean);
    } catch { /* no notices this time */ }
    const at = Date.now();
    bus = { at, body: JSON.stringify({ routes: routes.map(({ id, color, name, next }) => ({ id, color, name, active: next.length })), buses, notices, at: new Date(at).toISOString() }) };
    lastBus = { buses, routeName: Object.fromEntries(routes.map((r) => [r.id, r.name])), routeIds: routes.map((r) => r.id) };
    busReport = `buses: OK, ${routes.length} routes, ${buses.length} buses`;
  } catch (e) { busReport = `buses: ${e.message}`; }
  return used;
}

// ---- bus log, for the stats page and for rebuilding the routes from where buses really drive (same D1 database).
// Only the once-a-minute timer (a Cron Trigger on this Worker) writes, never the map's requests: Cloudflare runs many
// copies of this Worker at once, and each copy logging on its own blew through D1's free daily allowance.
// Each run looks at the buses three times (every 20 s) and saves them as ONE row of CSV text (tracks), with whether
// each was on its route's line (data/route-cells.json says which ~55 m squares each route uses; a moving bus more
// than about one square away is off route). Totals for the stats page are kept as they go, one row per day
// (day_sum), so the stats page reads a few rows instead of every position.
// Lateness comes from GPS: GHT's tracker publishes each route's timed stops (where, and when buses leave them). While
// a bus's track passes within 80 m of one it's "there"; the last moment it's there is when it left; minus the
// scheduled time = how late. Each one also notes the conditions then: the weather at the nearest weather station
// (NWS), and any WSDOT road alert within 1.5 km of the stop. Weather and road alerts are logged on their own too,
// every 10 minutes. It's the same public information the tracker, NWS and WSDOT show; nothing about riders.
// Version 3 keeps version 2's positions as positions_v2 (stats from them are folded into the day totals).
// Free-plan budget: about 3 writes a minute while buses run, plus one per timed stop passed; well under 100,000 a day.
let lastBus = null;
const BUS_SCHEMA = '4';
let busTablesReady = false;
async function busTables(db) {
  if (busTablesReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)').run();
  const ver = (await db.prepare("SELECT v FROM meta WHERE k = 'bus_schema'").first())?.v;
  if (ver !== BUS_SCHEMA && ver !== '2' && ver !== '3') {
    // first run, or the first version (its lateness followed the tracker's schedule, not the buses): start fresh
    await db.batch(['arrivals', 'bus_seen', 'offroute', 'route_day', 'departures', 'positions', 'weather_obs', 'road_alerts']
      .map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  }
  if (ver === '3') {
    // version 3's lateness counted parked, out-of-service buses at GHT's base (next to a route 20 timed stop) as
    // buses leaving hours late. Start lateness over; the GPS tracks and off-route totals stay
    await db.batch([db.prepare('DROP TABLE IF EXISTS departures'), db.prepare("UPDATE day_sum SET data = json_remove(data, '$.dep')"),
      db.prepare("DELETE FROM meta WHERE k = 'bus_state'")]);
  }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS departures (day TEXT, t INTEGER, route TEXT, bus TEXT, stop TEXT, sched_min INTEGER, actual_min INTEGER,
      delay INTEGER, wx TEXT, temp INTEGER, wind INTEGER, precip REAL, alert TEXT, alert_road TEXT, arrive_min INTEGER, how TEXT,
      PRIMARY KEY (day, bus, stop, sched_min))`),
    db.prepare('CREATE TABLE IF NOT EXISTS missed (day TEXT, route TEXT, stop TEXT, sched_min INTEGER, PRIMARY KEY (day, route, stop, sched_min))'),
    db.prepare('CREATE INDEX IF NOT EXISTS departures_day ON departures(day)'),
    db.prepare('CREATE TABLE IF NOT EXISTS tracks (minute INTEGER PRIMARY KEY, day TEXT, data TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS day_sum (day TEXT PRIMARY KEY, data TEXT)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS weather_obs (t INTEGER, day TEXT, station TEXT, wx TEXT, temp INTEGER, wind INTEGER, gust INTEGER, precip REAL,
      PRIMARY KEY (station, t))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS road_alerts (id TEXT PRIMARY KEY, kind TEXT, road TEXT, milepost REAL, lat REAL, lon REAL, headline TEXT,
      first_seen INTEGER, last_seen INTEGER)`)
  ]);
  if (ver === '2') await migrateV2(db);
  await db.prepare(`INSERT INTO meta (k, v) VALUES ('bus_schema', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1`).bind(BUS_SCHEMA).run();
  busTablesReady = true;
}
// version 2 -> 3, once: day totals from what version 2 logged; its positions stay, renamed positions_v2
async function migrateV2(db) {
  const hasPos = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'positions'").first();
  const sums = {};
  const S = (day) => (sums[day] ||= newSum());
  for (const r of (await db.prepare('SELECT day, route, stop, actual_min, delay, wx, wind, precip, alert FROM departures').all()).results) addDeparture(S(r.day), r);
  if (hasPos) {
    // one pass over the old positions (D1's free plan counts every row read)
    const rows = (await db.prepare(`SELECT day, route, CAST(ROUND(lat * 500) AS INTEGER) AS la, CAST(ROUND(lon * 350) AS INTEGER) AS lo, COUNT(*) AS n,
        SUM(mph >= 3 AND off IS NOT NULL) AS moving, SUM(mph >= 3 AND off = 1) AS offn, GROUP_CONCAT(DISTINCT CASE WHEN mph >= 3 AND off = 1 THEN bus END) AS buses
      FROM positions GROUP BY day, route, la, lo`).all()).results;
    for (const r of rows) {
      const s = S(r.day);
      s.pos += r.n;
      if (r.moving) { const o = (s.off[r.route] ||= [0, 0]); o[0] += r.moving; o[1] += r.offn; }
      if (r.offn) s.spots[`${r.route}|${r.la}|${r.lo}`] = [r.offn, r.buses || ''];
    }
  }
  const steps = Object.entries(sums).map(([day, s]) => db.prepare('INSERT INTO day_sum (day, data) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET data = ?2')
    .bind(day, JSON.stringify(s)));
  if (hasPos) steps.push(db.prepare('ALTER TABLE positions RENAME TO positions_v2'));
  if (steps.length) await db.batch(steps);
}

// running totals for one day. s = [count, total minutes late, on time, late, early]. worst: departures 10+ minutes
// late, with what's needed to judge them; missed: scheduled times no bus was seen at
const newDep = () => ({ all: [0, 0, 0, 0, 0], route: {}, hour: {}, stop: {}, wx: {}, alert: {}, dist: {}, worst: [], missed: {}, missedList: [] });
const newSum = () => ({ pos: 0, off: {}, spots: {}, dep: newDep() });
const wxCond = (r) => (r.precip > 0 || /rain|shower|drizzle/i.test(r.wx || '') ? 'rain' : /snow|ice/i.test(r.wx || '') ? 'snow or ice'
  : /fog/i.test(r.wx || '') ? 'fog' : r.wind >= 20 ? 'windy' : r.wx == null ? 'unknown' : 'dry');
function addDeparture(sum, r) {
  // on time = left 0 to 5 minutes after the scheduled time (early: before it; late: more than 5 after)
  const add = (o, k) => { const s = (o[k] ||= [0, 0, 0, 0, 0]); s[0]++; s[1] += r.delay; s[2] += r.delay >= 0 && r.delay <= 5; s[3] += r.delay > 5; s[4] += r.delay < 0; };
  const d = sum.dep;
  add(d, 'all'); add(d.route, r.route); add(d.hour, Math.floor(r.actual_min / 60)); add(d.wx, wxCond(r)); add(d.alert, r.alert || 'none');
  const st = (d.stop[`${r.route}|${r.stop}`] ||= [0, 0]); st[0]++; st[1] += r.delay;
  const m = Math.max(-5, Math.min(31, r.delay)); d.dist[m] = (d.dist[m] || 0) + 1; // (31 = more than 30)
  if (r.delay >= 10) {
    d.worst ||= [];
    d.worst.push({ t: r.t, route: r.route, bus: r.bus, stop: r.stop, sched: r.sched_min, dep: r.actual_min, arr: r.arrive_min, how: r.how,
      delay: r.delay, wx: r.wx, temp: r.temp, alert: r.alert, alertRoad: r.alertRoad, lat: r.lat, lon: r.lon });
    d.worst.sort((a, b) => b.delay - a.delay); d.worst.length = Math.min(d.worst.length, 40);
  }
}
function addMissed(sum, x) {
  const d = sum.dep;
  d.missed ||= {}; d.missedList ||= [];
  d.missed[x.route] = (d.missed[x.route] || 0) + 1;
  if (d.missedList.length < 80) d.missedList.push(x);
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
// each route's timed stops from the tracker: where, and the minutes after midnight buses leave them. Fetched once a
// day and kept in the database too, since each copy of the Worker would otherwise fetch all 14 routes again
let timepoints = { day: null, tps: {} };
async function routeTimepoints(db, routeIds, day) {
  if (timepoints.day === day) return timepoints.tps;
  try { const v = JSON.parse((await db.prepare("SELECT v FROM meta WHERE k = 'timepoints'").first())?.v || 'null'); if (v?.day === day) return (timepoints = v).tps; } catch { /* fetch them */ }
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
  if (Object.keys(out).length) {
    timepoints = { day, tps: out };
    await db.prepare("INSERT INTO meta (k, v) VALUES ('timepoints', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(JSON.stringify(timepoints)).run();
  }
  return out;
}
// conditions, refreshed every 10 minutes: the latest observation at each nearby NWS station, and WSDOT's road alerts
// (from the file the site's collector keeps). Kept in the run's state, so a fresh copy of the Worker still knows them
const WX_STATIONS = [['KHQM', 46.9712, -123.9366], ['KOLM', 46.9733, -122.9026], ['KSHN', 47.2336, -123.1475], ['KCLS', 46.677, -122.9828], ['KUIL', 47.9375, -124.555]];
async function conditions(db, st) {
  if (Date.now() - (st.condAt || 0) < 600000) return;
  st.condAt = Date.now();
  const steps = [];
  st.wx ||= {};
  await Promise.all(WX_STATIONS.map(async ([id, lat, lon]) => {
    try {
      const p = (await (await fetch(`https://api.weather.gov/stations/${id}/observations/latest`, { headers: { ...UA, Accept: 'application/geo+json' } })).json()).properties;
      if (!p?.timestamp) return;
      const v = (o, f) => (o?.value != null ? f(o.value) : null);
      const w = { id, lat, lon, t: Date.parse(p.timestamp), wx: p.textDescription || '', temp: v(p.temperature, (c) => Math.round(c * 9 / 5 + 32)),
        wind: v(p.windSpeed, (k) => Math.round(k / 1.609)), gust: v(p.windGust, (k) => Math.round(k / 1.609)),
        precip: v(p.precipitationLastHour, (mm) => Math.round(mm / 25.4 * 100) / 100) };
      const known = st.wx[id]?.t === w.t;
      st.wx[id] = w;
      if (!known) steps.push(db.prepare('INSERT OR IGNORE INTO weather_obs (t, day, station, wx, temp, wind, gust, precip) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(w.t, pacificDay(w.t), id, w.wx, w.temp, w.wind, w.gust, w.precip));
    } catch { /* that station next time */ }
  }));
  try {
    const j = await (await fetch(`https://traffic.harborevents.org/data/wsdot-alerts.json?t=${Date.now()}`)).json();
    const now = Date.now();
    st.alerts = (j.alerts || []).filter((a) => a.lat && a.lon)
      .map((a) => ({ id: String(a.id), kind: a.kind, road: a.roadLabel || a.road || '', milepost: a.milepost ?? null, lat: a.lat, lon: a.lon,
        lat2: a.lat2 ?? null, lon2: a.lon2 ?? null, headline: String(a.headline || '').slice(0, 300) }));
    // new alerts are added; ones already logged only get "still there" marked about once an hour
    for (const a of st.alerts) steps.push(db.prepare(`INSERT INTO road_alerts (id, kind, road, milepost, lat, lon, headline, first_seen, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) ON CONFLICT(id) DO UPDATE SET kind = ?2, headline = ?7, last_seen = ?8 WHERE road_alerts.last_seen < ?9`)
      .bind(a.id, a.kind, a.road, a.milepost, a.lat, a.lon, a.headline, now, now - 3600000));
  } catch { /* next time */ }
  if (steps.length) await db.batch(steps);
}
const mDist = (a, b) => Math.hypot((b.lon - a.lon) * 76000, (b.lat - a.lat) * 111000);
// the conditions at a stop right now: nearest station's weather, and the most serious road alert within 1.5 km
function conditionsAt(st, p) {
  const w = Object.values(st.wx || {}).sort((a, b) => mDist(p, a) - mDist(p, b))[0] || null;
  const order = ['closure', 'collision', 'work', 'other'];
  const near = (st.alerts || []).filter((a) => mDist(p, a) < 1500 || (a.lat2 && mDist(p, { lat: a.lat2, lon: a.lon2 }) < 1500))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] || null;
  return { wx: w?.wx ?? null, temp: w?.temp ?? null, wind: w?.wind ?? null, precip: w?.precip ?? null, alert: near?.kind ?? null, alertRoad: near ? near.road : null };
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
// one look at the buses: a CSV line each for the track, the day's off-route totals, and timed stops passed.
// Only buses the tracker's route list names as running a route count (it also reports parked ones)
function busSample(st, sum, c, tps, now, lines, done) {
  const nowMin = pacificMin(now);
  for (const b of lastBus.buses) {
    if (!b.listed) continue;
    const rt = shortRoute(lastBus.routeName[b.route]);
    if (!rt || !b.lat || !b.lon) continue;
    const set = c?.routes[rt];
    let off = null;
    if (set) {
      const i = Math.floor(b.lat / c.lat), j = Math.floor(b.lon / c.lon);
      off = 1;
      for (let di = -1; di <= 1 && off; di++) for (let dj = -1; dj <= 1; dj++) if (set.has(`${i + di},${j + dj}`)) { off = 0; break; }
    }
    const mph = Math.round(b.mph || 0);
    lines.push(`${now},${rt},${b.id},${b.lat.toFixed(5)},${b.lon.toFixed(5)},${Math.round(b.heading || 0)},${mph},${off ?? ''}\n`);
    sum.pos++;
    if (off != null && mph >= 3) {
      const o = (sum.off[rt] ||= [0, 0]); o[0]++; o[1] += off;
      if (off) {
        const s = (sum.spots[`${rt}|${Math.round(b.lat * 500)}|${Math.round(b.lon * 350)}`] ||= [0, '']);
        s[0]++; if (!s[1].split(',').includes(b.id)) s[1] = s[1] ? `${s[1]},${b.id}` : b.id;
      }
    }
    st.seen[b.route] ??= nowMin; // the route's first bus in service today (for "no bus seen")
    // what the tracker says this bus is headed for: its next timed stop's scheduled time (the last 20 minutes of it)
    const nm = clockMin(b.nextTime);
    const hist = (st.nx[b.id] || []).filter((h) => now - h.t < 1200000 && h.route === b.route);
    if (nm != null && !hist.some((h) => h.m === nm)) hist.push({ m: nm, t: now, route: b.route });
    st.nx[b.id] = hist.slice(-6);
    // timed stops its track passed since last time. While it's still there, the time keeps moving up, so what's
    // left when it goes is when it left. Which scheduled time that was is decided then (see settle)
    const prev = st.prev[b.id];
    if (prev && prev.route === b.route && now - prev.t < 150000) {
      for (const tp of tps[b.route] || []) {
        const { d, f } = passBy(prev, b, tp);
        if (d > 80) continue;
        const at = Math.round(prev.t + f * (now - prev.t));
        const p = (st.pend[`${b.id}|${b.route}|${tp.name}`] ||= { arr: at, rid: b.route, rt, bus: b.id, stop: tp.name, lat: tp.lat, lon: tp.lon, hints: [] });
        p.at = at; p.seen = now;
        for (const h of st.nx[b.id]) if (tp.mins.some((m) => Math.abs(m - h.m) <= 1) && !p.hints.includes(h.m)) p.hints.push(h.m);
      }
    }
    st.prev[b.id] = { lat: b.lat, lon: b.lon, t: now, route: b.route };
  }
  // the ones it has left (not near it this time)
  for (const [k, p] of Object.entries(st.pend)) if (p.seen < now) { delete st.pend[k]; const r = settle(p, tps); if (r) done.push(r); }
}
// which scheduled time a departure was for. First choice: a time the tracker said this bus was headed for (it knows
// the bus's trip). Otherwise the stop's nearest time, leaning late: leaving 4 minutes before one time reads as 4
// early, not as most of a headway late; a layover bus waiting for its next trip matches that trip, not the last one
function settle(p, tps) {
  const tp = (tps[p.rid] || []).find((t) => t.name === p.stop);
  if (!tp) return null;
  const dep = pacificMin(p.at);
  const cost = (m) => (dep - m >= 0 ? dep - m : 2 * (m - dep));
  const pick = (list) => list.filter((m) => dep - m <= 90 && m - dep <= 15).sort((a, b) => cost(a) - cost(b))[0];
  let sched = pick(p.hints), how = 'tracker';
  if (sched == null) { sched = pick(tp.mins); how = 'nearest'; }
  return sched == null ? null : { ...p, sched, how, dep, arrMin: pacificMin(p.arr) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the once-a-minute run
async function busMinute(env, t0) {
  if (!env.DB) return;
  const db = env.DB;
  await busTables(db);
  let st = {};
  try { st = JSON.parse((await db.prepare("SELECT v FROM meta WHERE k = 'bus_state'").first())?.v || '{}'); } catch { /* start over */ }
  st.prev ||= {}; st.pend ||= {}; st.nx ||= {};
  const day = pacificDay(t0), nowMin = pacificMin(t0);
  if (st.day !== day) Object.assign(st, { day, seen: {}, served: {}, missFrom: null, span: null });
  // every minute from 10 minutes before the day's first scheduled bus to 45 after its last (known once today's
  // timetable is loaded); outside that, while no buses are out, every 10 minutes to go easy on GHT's server
  const inService = !!st.span && nowMin >= st.span[0] - 10 && nowMin <= st.span[1] + 45;
  if (st.empty && !inService && new Date(t0).getUTCMinutes() % 10 !== 0) return;
  // a gap in the log (paused, or runs skipped): don't call buses missing that we couldn't have seen
  if (inService && st.lastRun && t0 - st.lastRun > 180000) st.missFrom = nowMin - 45;
  st.lastRun = t0;
  let sum = newSum();
  try { const v = (await db.prepare('SELECT data FROM day_sum WHERE day = ?1').bind(day).first())?.data; if (v) sum = { ...newSum(), ...JSON.parse(v) }; } catch { /* new day */ }
  sum.dep ||= newDep();
  const lines = [], done = [];
  let used = 0, c = null, tps = {};
  const inServiceNow = () => lastBus.buses.filter((b) => b.listed);
  // free plan: at most 50 outside requests per run. Each look is 1 + one per route with buses out
  for (let i = 0; i < 3; i++) {
    const wait = t0 + i * 20000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() - t0 > 50000) break;
    const active = lastBus ? new Set(lastBus.buses.map((b) => b.route)).size + 1 : 15;
    if (used + active > 44) break;
    const before = bus.at;
    used += await refreshBuses(false);
    if (bus.at === before || !lastBus) break; // the tracker didn't answer
    if (i === 0) {
      // today's timetable, even with no buses out (it says when service starts and ends, and what to expect)
      const any = inServiceNow().length > 0;
      const needTp = timepoints.day !== day ? lastBus.routeIds.length : 0, needWx = any && Date.now() - (st.condAt || 0) >= 600000 ? 6 : 0;
      [c, tps] = await Promise.all([any ? routeCells() : null, routeTimepoints(db, lastBus.routeIds, day), any ? conditions(db, st) : null]);
      used += (any ? 1 : 0) + needTp + needWx;
      const all = Object.values(tps).flat().flatMap((t) => t.mins);
      if (all.length) st.span = [Math.min(...all), Math.max(...all)];
      if (!any) break;
    }
    busSample(st, sum, c, tps, Date.now(), lines, done);
  }
  const empty = !lastBus || !inServiceNow().length;
  if (empty) for (const [k, p] of Object.entries(st.pend)) { delete st.pend[k]; const r = settle(p, tps); if (r) done.push(r); }
  for (const r of done) (st.served[`${r.rid}|${r.stop}`] ||= []).push(r.sched);
  // no bus seen: 45 minutes after each scheduled time, on routes that have had a bus in service today, was a bus
  // there? (an arrive/leave pair a few minutes apart is one visit)
  const missed = [], upto = nowMin - 45;
  if (st.missFrom == null) st.missFrom = upto;
  if (upto > st.missFrom && Object.keys(tps).length) {
    for (const [rid, list] of Object.entries(tps)) {
      const first = st.seen[rid];
      if (first == null) continue;
      for (const tp of list) {
        const served = st.served[`${rid}|${tp.name}`] || [];
        let lastM = -99;
        for (const m of tp.mins) {
          const pair = m - lastM <= 3; lastM = m;
          if (pair || m <= st.missFrom || m > upto || m < first) continue;
          if (served.some((s) => Math.abs(s - m) <= 3)) continue;
          missed.push({ route: shortRoute(lastBus?.routeName[rid]), stop: tp.name, sched: m, lat: tp.lat, lon: tp.lon });
        }
      }
    }
    st.missFrom = upto;
  }
  const quiet = empty && st.empty && !done.length && !missed.length && !inService;
  st.empty = empty;
  if (quiet) return; // nothing out and nothing expected: nothing to save
  for (const [id, p] of Object.entries(st.prev)) if (t0 - p.t > 600000) { delete st.prev[id]; delete st.nx[id]; }
  const steps = [];
  if (lines.length) steps.push(db.prepare('INSERT OR REPLACE INTO tracks (minute, day, data) VALUES (?1, ?2, ?3)').bind(Math.floor(t0 / 60000), day, lines.join('')));
  for (const p of done) {
    const k = conditionsAt(st, p);
    const r = { t: p.at, day: pacificDay(p.at), route: p.rt, bus: p.bus, stop: p.stop, sched_min: p.sched, actual_min: p.dep, arrive_min: p.arrMin, how: p.how,
      delay: p.dep - p.sched, lat: p.lat, lon: p.lon, ...k };
    steps.push(db.prepare(`INSERT OR IGNORE INTO departures (day, t, route, bus, stop, sched_min, actual_min, delay, wx, temp, wind, precip, alert, alert_road, arrive_min, how)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`)
      .bind(r.day, r.t, r.route, r.bus, r.stop, r.sched_min, r.actual_min, r.delay, k.wx, k.temp, k.wind, k.precip, k.alert, k.alertRoad, r.arrive_min, r.how));
    addDeparture(sum, r);
  }
  for (const x of missed) {
    steps.push(db.prepare('INSERT OR IGNORE INTO missed (day, route, stop, sched_min) VALUES (?1, ?2, ?3, ?4)').bind(day, x.route, x.stop, x.sched));
    addMissed(sum, x);
  }
  if (lines.length || done.length || missed.length) steps.push(db.prepare('INSERT INTO day_sum (day, data) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET data = ?2').bind(day, JSON.stringify(sum)));
  steps.push(db.prepare("INSERT INTO meta (k, v) VALUES ('bus_state', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(JSON.stringify(st)));
  await db.batch(steps);
}

// stats for stats.html: added up from the day totals (a few rows, however much has been logged)
let statsCache = { key: '', at: 0, body: null };
async function busStats(db, days) {
  await busTables(db);
  const since = pacificDay(Date.now() - (days - 1) * 86400 * 1000);
  if (statsCache.key === since && Date.now() - statsCache.at < 60000) return statsCache.body;
  const [rows, all] = await db.batch([
    db.prepare('SELECT day, data FROM day_sum WHERE day >= ?1 ORDER BY day').bind(since),
    db.prepare("SELECT MIN(day) AS first, SUM(json_extract(data, '$.pos')) AS positions, SUM(json_extract(data, '$.dep.all[0]')) AS n FROM day_sum")
  ]);
  const S = (s) => ({ n: s[0], avg: s[0] ? Math.round(s[1] / s[0] * 10) / 10 : null, ontime: s[2], late: s[3], early: s[4] });
  const merge = (into, from) => { for (const [k, s] of Object.entries(from || {})) { const t = (into[k] ||= s.map(() => 0)); s.forEach((v, i) => { t[i] += v; }); } };
  const m = { route: {}, hour: {}, stop: {}, wx: {}, alert: {}, dist: {}, off: {}, missed: {} }, spots = {}, daily = [], worst = [], missedList = [];
  for (const row of rows.results) {
    const d = JSON.parse(row.data), dep = d.dep || {};
    for (const [k, n] of Object.entries(dep.missed || {})) m.missed[k] = (m.missed[k] || 0) + n;
    for (const w of dep.worst || []) worst.push({ day: row.day, ...w });
    for (const x of dep.missedList || []) missedList.push({ day: row.day, ...x });
    for (const k of ['route', 'hour', 'stop', 'wx', 'alert']) merge(m[k], dep[k]);
    for (const [k, n] of Object.entries(dep.dist || {})) m.dist[k] = (m.dist[k] || 0) + n;
    merge(m.off, d.off);
    for (const [k, [n, buses]] of Object.entries(d.spots || {})) {
      const s = (spots[k] ||= { n: 0, days: 0, buses: new Set() }); s.n += n; s.days++; String(buses).split(',').filter(Boolean).forEach((b) => s.buses.add(b));
    }
    const dd = dep.dist || {}, over = (from) => Object.entries(dd).reduce((a, [k, n]) => a + (+k > from ? n : 0), 0);
    const missedN = Object.values(dep.missed || {}).reduce((a, n) => a + n, 0);
    if (dep.all?.[0] || missedN) daily.push({ day: row.day, ...S(dep.all || [0, 0, 0, 0, 0]), over10: over(10), over30: over(30), missed: missedN });
  }
  const body = {
    days, since,
    byRoute: Object.entries(m.route).map(([route, s]) => ({ route, ...S(s) })),
    byHour: Object.entries(m.hour).map(([h, s]) => ({ h: +h, ...S(s) })).sort((a, b) => a.h - b.h),
    stops: Object.entries(m.stop).filter(([, s]) => s[0] >= 3).map(([k, s]) => ({ route: k.split('|')[0], stop: k.slice(k.indexOf('|') + 1), n: s[0], avg: Math.round(s[1] / s[0] * 10) / 10 }))
      .sort((a, b) => b.avg - a.avg).slice(0, 10),
    off: Object.entries(m.off).map(([route, [samples, off]]) => ({ route, samples, off })),
    spots: Object.entries(spots).filter(([, s]) => s.n >= 3).map(([k, s]) => { const [route, la, lo] = k.split('|');
      return { route, lat: la / 500, lon: lo / 350, n: s.n, days: s.days, buses: s.buses.size }; }).sort((a, b) => b.n - a.n).slice(0, 12),
    daily,
    dist: Object.entries(m.dist).map(([k, n]) => ({ m: +k, n })).sort((a, b) => a.m - b.m),
    byWx: Object.entries(m.wx).map(([cond, s]) => ({ cond, ...S(s) })),
    byAlert: Object.entries(m.alert).map(([alert, s]) => ({ alert, ...S(s) })),
    missed: Object.entries(m.missed).map(([route, n]) => ({ route, n })),
    worst: worst.sort((a, b) => b.delay - a.delay).slice(0, 25),
    missedList: missedList.sort((a, b) => (b.day + String(b.sched).padStart(4, '0')).localeCompare(a.day + String(a.sched).padStart(4, '0'))).slice(0, 40),
    first: all.results[0]
  };
  statsCache = { key: since, at: Date.now(), body };
  return body;
}
// the raw logs as CSV, for backups or your own graphs. In pages (X-Next says where the next one starts), so no one
// request has too much to do
async function busExport(db, table, days, after) {
  await busTables(db);
  const since = pacificDay(Date.now() - (days - 1) * 86400 * 1000);
  const a = Math.max(0, Math.floor(+after || 0));
  if (table === 'positions') {
    const rows = (await db.prepare('SELECT minute, data FROM tracks WHERE day >= ?1 AND minute > ?2 ORDER BY minute LIMIT 1440').bind(since, a).all()).results;
    return { csv: 't,route,bus,lat,lon,heading,mph,off\n' + rows.map((r) => r.data).join(''), next: rows.length === 1440 ? rows[rows.length - 1].minute : null };
  }
  const cols = { positions_v2: 't, day, route, bus, lat, lon, heading, mph, off',
    departures: 'day, t, route, bus, stop, sched_min, arrive_min, actual_min, delay, how, wx, temp, wind, precip, alert, alert_road',
    missed: 'day, route, stop, sched_min',
    weather_obs: 't, day, station, wx, temp, wind, gust, precip', road_alerts: 'id, kind, road, milepost, lat, lon, headline, first_seen, last_seen' }[table];
  if (!cols) return null;
  const where = table === 'road_alerts' ? 'last_seen >= ?1' : table === 'positions_v2' ? '1' : 'day >= ?1';
  const PAGE = 5000;
  let rows;
  try {
    rows = (await db.prepare(`SELECT rowid AS _r, ${cols} FROM ${table} WHERE ${where} AND rowid > ?2 ORDER BY rowid LIMIT ${PAGE}`)
      .bind(table === 'road_alerts' ? Date.now() - days * 86400 * 1000 : since, a).all()).results;
  } catch { rows = []; } // (positions_v2 only exists where version 2 ran)
  const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const body = rows.map((r) => { const { _r, ...rest } = r; return Object.values(rest).map(csvCell).join(','); }).join('\n');
  return { csv: cols.replace(/ /g, '') + '\n' + body + (body ? '\n' : ''), next: rows.length === PAGE ? rows[rows.length - 1]._r : null };
}

// ---- database use meter. D1's free plan allows 5,000,000 rows read and 100,000 written a day (reset at midnight
// UTC); going over locks the database until then. Every query here goes through counted(), which adds up the rows
// D1 says it read and wrote; each copy of the Worker adds its share to the usage table every 5 minutes. At half
// of either allowance the bus log and viewer count pause for the rest of the UTC day (the map itself never
// touches the database, so it keeps working).
const FREE_READS = 5000000, FREE_WRITES = 100000;
const usage = { reads: 0, writes: 0, flushedAt: Date.now(), day: null, total: null, over: false };
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
function counted(db) {
  const tally = (m) => { if (m) { usage.reads += m.rows_read || 0; usage.writes += m.rows_written || 0; } };
  const wrap = (s) => ({ _s: s, bind: (...a) => wrap(s.bind(...a)),
    all: async () => { const r = await s.all(); tally(r.meta); return r; },
    run: async () => { const r = await s.run(); tally(r.meta); return r; },
    first: async () => { const r = await s.all(); tally(r.meta); return r.results[0] ?? null; } });
  return { prepare: (q) => wrap(db.prepare(q)), batch: async (list) => { const rs = await db.batch(list.map((x) => x._s)); rs.forEach((r) => tally(r?.meta)); return rs; } };
}
let usageReady = false;
async function flushUsage(raw, force = false) {
  const now = Date.now(), day = utcDay(now);
  if (usage.day !== day) { usage.day = day; usage.over = false; usage.total = null; }
  if (!force && usage.total && now - usage.flushedAt < 300000) return usage.over; // (a new copy checks in right away)
  const r = usage.reads, w = usage.writes;
  usage.reads = 0; usage.writes = 0; usage.flushedAt = now;
  try {
    if (!usageReady) { await raw.prepare('CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, reads INTEGER, writes INTEGER)').run(); usageReady = true; }
    const row = await raw.prepare(`INSERT INTO usage (day, reads, writes) VALUES (?1, ?2, ?3)
      ON CONFLICT(day) DO UPDATE SET reads = reads + ?2, writes = writes + ?3 RETURNING reads, writes`).bind(day, r + 1, w + 2).first();
    usage.total = row;
    usage.over = row.reads > FREE_READS / 2 || row.writes > FREE_WRITES / 2;
  } catch (e) { usage.reads += r; usage.writes += w; if (/limit/i.test(e.message)) usage.over = true; }
  return usage.over;
}
async function usageReport(raw) {
  await flushUsage(raw, true);
  const t = usage.total || { reads: 0, writes: 0 };
  return { day: usage.day, reads: t.reads, writes: t.writes, limitReads: FREE_READS, limitWrites: FREE_WRITES, paused: usage.over };
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
    // every database query is counted (the meter above); only these paths use the database
    const raw = env.DB;
    if (raw && ['/hello', '/viewers', '/bus-stats', '/bus-export'].includes(path)) {
      env = { ...env, DB: counted(raw) };
      ctx?.waitUntil(flushUsage(raw).catch(() => {}));
    }

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
      try { return json(JSON.stringify({ ...(await busStats(env.DB, days)), usage: await usageReport(raw) })); }
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
        const out = await busExport(env.DB, table, days, u.searchParams.get('after'));
        if (out == null) return new Response('unknown table', { status: 400, headers: cors });
        return new Response(out.csv, { headers: { ...cors, 'Content-Type': 'text/csv', 'Access-Control-Expose-Headers': 'X-Next',
          ...(out.next != null ? { 'X-Next': String(out.next) } : {}),
          'Content-Disposition': `attachment; filename="ght-${table}-${pacificDay(Date.now())}.csv"` } });
      } catch (e) { return new Response(`database: ${e.message}`, { status: 500, headers: cors }); }
    }
    if (path === '/hello' || path === '/viewers') {
      if (!env.DB) return new Response('viewer count not set up (no DB binding)', { status: 503, headers: cors });
      if (path === '/viewers' && (!env.STATS_KEY || request.headers.get('X-Stats-Key') !== env.STATS_KEY))
        return new Response(env.STATS_KEY ? 'wrong key' : 'set the STATS_KEY secret first', { status: 403, headers: cors });
      // only the dashboard's own pages check in
      if (path === '/hello' && !ALLOWED.includes(origin)) return new Response('', { status: 403, headers: cors });
      // over half the free database allowance today: don't count (the page doesn't mind)
      if (path === '/hello' && usage.over) return json('{"ok":true,"paused":true}');
      try {
        const r = path === '/hello' ? await hello(env.DB, new URL(request.url)) : await viewerStats(env.DB);
        return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(`database: ${e.message}`, { status: 500, headers: cors });
      }
    }
    return new Response('Harbor Traffic relay. Try /aircraft or /buses', { status: 404, headers: cors });
  },
  // once a minute (a Cron Trigger "* * * * *" on this Worker): the only thing that writes the bus log
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const raw = env.DB;
    ctx.waitUntil((async () => {
      if (await flushUsage(raw)) return; // over half the free database allowance today: wait for midnight UTC
      await busMinute({ ...env, DB: counted(raw) }, event.scheduledTime);
    })().catch((e) => console.log('bus log', e.message)));
  }
};
