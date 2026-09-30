// Harbor Traffic relay (Cloudflare Worker, free plan).
// Serves live aircraft for the dashboard: GET /aircraft returns the Grays Harbor area's aircraft as {"ac": [...]}.
// It only ever fetches that one list (it's not an open proxy), answers only the dashboard's own site,
// and asks the upstream feed at most once every 15 seconds no matter how many screens are watching.
// GET /debug shows which feed answered last and why any didn't.

const ALLOWED = ['https://traffic.harborevents.org', 'http://localhost:8765'];
// free community ADS-B feeds, tried in order (some refuse requests from Cloudflare's servers)
const SOURCES = [
  { name: 'adsb.lol', url: 'https://api.adsb.lol/v2/point/47.2/-123.65/55', list: (j) => j.ac },
  { name: 'adsb.fi', url: 'https://opendata.adsb.fi/api/v2/lat/47.2/lon/-123.65/dist/55', list: (j) => j.aircraft || j.ac }
];
const KEEP_MS = 15000;

let last = { at: 0, body: null, source: null }; // kept in memory between requests on the same Cloudflare machine
let report = [];

async function refresh() {
  report = [];
  for (const s of SOURCES) {
    try {
      const up = await fetch(s.url, { headers: { 'User-Agent': 'harbor-traffic relay (traffic.harborevents.org)', Accept: 'application/json' } });
      if (!up.ok) { report.push(`${s.name}: HTTP ${up.status}`); continue; }
      const list = s.list(await up.json());
      if (!Array.isArray(list)) { report.push(`${s.name}: unexpected reply`); continue; }
      last = { at: Date.now(), body: JSON.stringify({ ac: list, source: s.name }), source: s.name };
      report.push(`${s.name}: OK, ${list.length} aircraft`);
      return;
    } catch (e) { report.push(`${s.name}: ${e.message}`); }
  }
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

    const path = new URL(request.url).pathname;
    if (path === '/debug') {
      await refresh();
      return new Response(report.join('\n') + `\nserving: ${last.source || 'nothing yet'}`, { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }
    if (path !== '/aircraft') return new Response('Harbor Traffic relay. Try /aircraft', { status: 404, headers: cors });

    if (!last.body || Date.now() - last.at > KEEP_MS) await refresh();
    return new Response(last.body || '{"ac":[]}', {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
};
