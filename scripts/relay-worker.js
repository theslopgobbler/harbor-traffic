// Harbor Traffic relay (Cloudflare Worker, free plan).
//   GET /aircraft  aircraft around Grays Harbor as {"ac": [...], "source", "at"} (live ADS-B)
//   GET /buses     Grays Harbor Transit buses as {"routes": [...], "buses": [...], "at"} (from GHT's public GPS tracker)
//   GET /debug     which feeds answered last and why any didn't
//   GET /hello     an open dashboard page checking in (count.js), for the viewer count
//   GET /viewers   the viewer count and daily totals (stats.html; needs the X-Stats-Key header to match STATS_KEY)
// It only ever fetches those fixed lists (it's not an open proxy), answers only the dashboard's own site, and
// shares one fetch among everyone watching: aircraft at most every 15 s, buses at most every 20 s.

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
    busReport = `buses: OK, ${routes.length} routes, ${buses.length} buses`;
  } catch (e) { busReport = `buses: ${e.message}`; }
}

// ---- viewers: one Durable Object (binding VIEWERS, class Viewers) keeps the tally for everyone.
// It remembers only random tab IDs and when each last checked in (in memory, gone in 3 minutes), plus
// per-day totals (stored): page opens, the most at once, and opens by kind (TV, phone, desktop).
const WINDOW_MS = 3 * 60 * 1000;
const KINDS = ['tv', 'phone', 'desktop'];
const pacificDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t); // YYYY-MM-DD
export class Viewers {
  constructor(state) { this.state = state; this.seen = new Map(); this.days = null; }
  async fetch(request) {
    const u = new URL(request.url), now = Date.now();
    for (const [k, v] of this.seen) if (now - v.t > WINDOW_MS) this.seen.delete(k);
    this.days ||= (await this.state.storage.get('days')) || {};
    const today = pacificDay(now);
    const d = this.days[today] ||= { opens: 0, peak: 0, peakAt: null, tv: 0, phone: 0, desktop: 0 };
    if (u.pathname === '/hello') {
      const id = u.searchParams.get('id') || '', k = KINDS.includes(u.searchParams.get('k')) ? u.searchParams.get('k') : 'desktop';
      if (!/^[a-z0-9]{8,32}$/.test(id)) return new Response('bad id', { status: 400 });
      let dirty = false;
      if (u.searchParams.get('first') === '1' && !this.seen.has(id)) { d.opens++; d[k]++; dirty = true; }
      this.seen.set(id, { t: now, k });
      if (this.seen.size > d.peak) { d.peak = this.seen.size; d.peakAt = new Date(now).toISOString(); dirty = true; }
      if (dirty) {
        for (const day of Object.keys(this.days).sort().slice(0, -60)) delete this.days[day]; // keep 60 days
        await this.state.storage.put('days', this.days);
      }
      return Response.json({ ok: true });
    }
    // /stats
    const byKind = Object.fromEntries(KINDS.map((x) => [x, 0]));
    for (const v of this.seen.values()) byKind[v.k]++;
    const days = Object.keys(this.days).sort().reverse().slice(0, 30).map((day) => ({ day, ...this.days[day] }));
    return Response.json({ now: this.seen.size, byKind, days, at: new Date(now).toISOString() });
  }
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
      if (!bus.body || Date.now() - bus.at > 20000) await refreshBuses();
      return json(bus.body || '{"routes":[],"buses":[]}');
    }
    if (path === '/hello' || path === '/viewers') {
      if (!env.VIEWERS) return new Response('viewer count not set up (no VIEWERS binding)', { status: 503, headers: cors });
      if (path === '/viewers' && (!env.STATS_KEY || request.headers.get('X-Stats-Key') !== env.STATS_KEY))
        return new Response(env.STATS_KEY ? 'wrong key' : 'set the STATS_KEY secret first', { status: 403, headers: cors });
      // only the dashboard's own pages check in
      if (path === '/hello' && !ALLOWED.includes(origin)) return new Response('', { status: 403, headers: cors });
      const counter = env.VIEWERS.get(env.VIEWERS.idFromName('all'));
      const r = await counter.fetch(new URL((path === '/hello' ? '/hello' : '/stats') + new URL(request.url).search, 'https://viewers').toString());
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    return new Response('Harbor Traffic relay. Try /aircraft or /buses', { status: 404, headers: cors });
  }
};
