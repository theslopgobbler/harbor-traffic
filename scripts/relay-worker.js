// Harbor Traffic relay (Cloudflare Worker, free plan).
//   GET /aircraft  aircraft around Grays Harbor as {"ac": [...], "source", "at"} (live ADS-B)
//   GET /buses     Grays Harbor Transit buses as {"routes": [...], "buses": [...], "at"} (from GHT's public GPS tracker)
//   GET /debug     which feeds answered last and why any didn't
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
async function refreshAir() {
  airReport = [];
  air.tried = Date.now();
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

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'GET',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const json = (body) => new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const path = new URL(request.url).pathname;

    if (path === '/debug') {
      await Promise.all([refreshAir(), refreshBuses()]);
      return new Response([...airReport, `serving aircraft from: ${air.source || 'nothing yet'}`, busReport].join('\n'),
        { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }
    if (path === '/aircraft') {
      if (Date.now() - air.tried > 15000) await refreshAir();
      return json(air.body || '{"ac":[]}');
    }
    if (path === '/buses') {
      if (!bus.body || Date.now() - bus.at > 20000) await refreshBuses();
      return json(bus.body || '{"routes":[],"buses":[]}');
    }
    return new Response('Harbor Traffic relay. Try /aircraft or /buses', { status: 404, headers: cors });
  }
};
