// Grays Harbor Transit: live buses through the relay (GHT's public GPS tracker, shared 20 s refresh),
// route notices from the tracker, and service alerts the collector reads from ghtransit.com/alerts.
(() => {
  const map = window.htMap;
  const C = window.HT;
  if (!map) return;
  const qs = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const RELAY = (C.airRelay || '').replace(/\/aircraft$/, '');

  let routes = {}, buses = [], notices = [], siteAlerts = null;
  const markers = new Map();
  // "20 - Aberdeen-Hoquiam" -> "20" and "Aberdeen-Hoquiam" (some names drop the space: "25- Hoquiam DASH")
  const parts = (name) => (name || '').match(/^\s*([0-9]+[A-Z]?)\s*-\s*(.*)$/) || [null, name || '', ''];
  const short = (name) => parts(name)[1].trim();
  const long = (name) => parts(name)[2].trim();

  // ---- route lines and stops (from GHT's published schedule data; data/bus-routes.json and bus-stops.json) ----
  const shapesByRoute = {}; // route number -> [{ c: [[lon,lat]...], d: [meters along] }]
  const mx = (a, b) => { const dx = (b[0] - a[0]) * 76000, dy = (b[1] - a[1]) * 111000; return Math.hypot(dx, dy); }; // meters, near 47°N
  async function loadRoutes() {
    try {
      const [r, s] = await Promise.all([fetch('data/bus-routes.json').then((x) => x.json()), fetch('data/bus-stops.json').then((x) => x.json())]);
      for (const f of r.features || []) {
        const c = f.geometry.coordinates, d = [0];
        for (let i = 1; i < c.length; i++) d.push(d[i - 1] + mx(c[i - 1], c[i]));
        (shapesByRoute[f.properties.route] ||= []).push({ c, d });
      }
      const add = () => {
        if (map.getSource('bus-routes')) return;
        map.addSource('bus-routes', { type: 'geojson', data: r });
        map.addSource('bus-stops', { type: 'geojson', data: s });
        map.addLayer({ id: 'bus-route-lines', type: 'line', source: 'bus-routes', minzoom: 9, layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 3.5] } }, 'flow-glow');
        map.addLayer({ id: 'bus-stops', type: 'circle', source: 'bus-stops', minzoom: 13.5, paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 2.5, 16, 5], 'circle-color': '#020807',
          'circle-stroke-color': '#bff4ff', 'circle-stroke-width': 1.4 } });
        map.on('click', 'bus-stops', (e) => {
          const p = e.features[0].properties;
          new maplibregl.Popup({ offset: 8, maxWidth: '260px' }).setLngLat(e.lngLat)
            .setHTML(`<h3>BUS STOP</h3><p>${esc(p.name)}</p><div class="m">ROUTES ${esc(p.routes)}</div>`).addTo(map);
        });
        map.on('mouseenter', 'bus-stops', () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', 'bus-stops', () => (map.getCanvas().style.cursor = ''));
        showLayers();
      };
      if (map.isStyleLoaded()) add(); else map.once('load', add);
    } catch (e) { console.warn('bus routes', e); }
  }
  const showLayers = () => ['bus-route-lines', 'bus-stops'].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));

  // ---- estimated positions between GPS reports ----
  // Each report gives position, heading and speed. Between reports (20 s apart), each moving bus is slid along
  // its route line at its last speed, twice a second, for up to 90 s. A stopped bus stays put.
  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * 0.68, b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  function snap(b, routeNo) {
    let best = null;
    for (const sh of shapesByRoute[routeNo] || []) {
      for (let i = 0; i < sh.c.length - 1; i++) {
        const dist = mx([b.lon, b.lat], sh.c[i]);
        if (dist > 250 || (best && dist >= best.dist)) continue;
        if (diff(bearing(sh.c[i], sh.c[i + 1]), b.heading || 0) > 90) continue; // going the right way along it
        best = { sh, i, dist };
      }
    }
    return best;
  }
  function along(sh, meters) {
    const d = sh.d, c = sh.c;
    if (meters >= d[d.length - 1]) return c[c.length - 1];
    let i = 1; while (d[i] < meters) i++;
    const f = (meters - d[i - 1]) / ((d[i] - d[i - 1]) || 1);
    return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f];
  }
  function glide() {
    if (document.hidden || !on) return;
    const now = Date.now();
    for (const mk of markers.values()) {
      const b = mk._bus;
      if (!b || b.mph < 2) continue;
      // the route lines may arrive after the buses: match each bus to its line once they're in
      if (!b._snap && !b._tried && Object.keys(shapesByRoute).length) { b._tried = true; b._snap = snap(b, short(routes[b.route]?.name)); }
      if (!b._snap) continue;
      const secs = Math.min(90, (now - b._at) / 1000);
      const start = b._snap.sh.d[b._snap.i];
      mk.setLngLat(along(b._snap.sh, start + b.mph * 0.44704 * secs));
    }
  }
  setInterval(glide, 500);
  // for checking from the browser console: how many moving buses are matched to a route line
  window.htBusDebug = () => { const bs = [...markers.values()].map((m) => m._bus).filter(Boolean);
    return { buses: bs.length, moving: bs.filter((b) => b.mph >= 2).length, onRoute: bs.filter((b) => b.mph >= 2 && b._snap).length, hidden: document.hidden }; };


  // a bus from above, front up, in the same line style as the ships and alerts: a hollow outline in the
  // route color over a dark fill, windshield bar up front, window dashes down both sides
  const busSvg = (c) => `<svg viewBox="0 0 12 28"><rect x="1.2" y="1.2" width="9.6" height="25.6" rx="2.4" fill="rgba(2,8,7,.85)" stroke="${c}" stroke-width="1.4"/>
    <path d="M3 4 H9" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M3.2 8 V23.5 M8.8 8 V23.5" stroke="${c}" stroke-width="1" stroke-dasharray="2.4 1.4" opacity=".85"/></svg>`;

  function render() {
    const seen = new Set();
    for (const b of buses) {
      seen.add(b.id);
      const r = routes[b.route] || {};
      let mk = markers.get(b.id);
      if (!mk) {
        const el = document.createElement('div');
        el.className = 'bus-mk';
        mk = new maplibregl.Marker({ element: el }).setLngLat([b.lon, b.lat]).setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '280px' })).addTo(map);
        markers.set(b.id, mk);
      } else mk.setLngLat([b.lon, b.lat]);
      const el = mk.getElement();
      el.classList.toggle('stopped', b.mph < 2);
      el.innerHTML = `<div class="ic" style="transform:rotate(${b.heading || 0}deg)">${busSvg(r.color || '#bff4ff')}</div><b style="color:${esc(r.color || '#bff4ff')};border-color:${esc(r.color || '#bff4ff')}">${esc(short(r.name))}</b>`;
      el.title = `Route ${short(r.name)} · bus ${b.id}`;
      mk._bus = b;
      b._at = Date.now();
      b._snap = snap(b, short(r.name));
      mk.getPopup().setHTML(`<h3>ROUTE ${esc(short(r.name))} · ${esc(long(r.name).toUpperCase())}</h3>
        <p>BUS ${esc(b.id)} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}</p>
        ${b.nextStop ? `<div class="m">NEXT: ${esc(b.nextStop.toUpperCase())}${b.nextTime ? ' · ' + esc(b.nextTime) : ''}</div>` : ''}
        `);
    }
    for (const [id, mk] of markers) if (!seen.has(id)) { mk.remove(); markers.delete(id); }
    groupBuses();
    renderList();
    window.htDeclutter?.();
  }

  // buses that would pile up (transit centers, zoomed out) merge into one icon with a count, like the ships
  const groups = [];
  function groupBuses() {
    groups.splice(0).forEach((m) => m.remove());
    const all = [...markers.values()];
    all.forEach((m) => (m.getElement().style.display = ''));
    if (map.getZoom() >= 16) return;
    const pts = all.map((m) => ({ m, p: map.project(m.getLngLat()) }));
    const used = new Set();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const grp = [i];
      for (let j = i + 1; j < pts.length; j++) if (!used.has(j) && Math.hypot(pts[i].p.x - pts[j].p.x, pts[i].p.y - pts[j].p.y) < 28) grp.push(j);
      if (grp.length < 2) continue;
      grp.forEach((k) => { used.add(k); pts[k].m.getElement().style.display = 'none'; });
      const list = grp.map((k) => pts[k].m._bus);
      const lls = grp.map((k) => pts[k].m.getLngLat());
      const at = [lls.reduce((s, l) => s + l.lng, 0) / lls.length, lls.reduce((s, l) => s + l.lat, 0) / lls.length];
      const oneRoute = list.every((b) => b.route === list[0].route);
      const color = oneRoute ? (routes[list[0].route]?.color || '#bff4ff') : '#bff4ff';
      const el = document.createElement('div');
      // a pile of parked buses (all stopped, e.g. at a transit center) is drawn faint so it doesn't hog the map
      el.className = 'bus-mk bus-grp' + (list.every((b) => b.mph < 2) ? ' parked' : '');
      el.innerHTML = `<div class="ic">${busSvg(color)}</div><b class="n">${list.length}</b>`;
      el.title = `${list.length} buses here: click for details`;
      // parked together (a transit center): list them; spread out: zoom in until they separate
      const spreadM = Math.max(...lls.map((a) => Math.max(...lls.map((b) => a.distanceTo(b)))));
      const pop = new maplibregl.Popup({ offset: 14, maxWidth: '300px' }).setHTML(`<h3>${list.length} BUSES HERE</h3>` + list.map((b) => {
        const r = routes[b.route] || {};
        return `<div class="m"><span class="bus-no" style="background:${esc(r.color || '#bff4ff')}">${esc(short(r.name))}</span>BUS ${esc(b.id)} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}${b.nextStop ? ' · NEXT ' + esc(b.nextStop.toUpperCase()) + (b.nextTime ? ' ' + esc(b.nextTime) : '') : ''}</div>`;
      }).join(''));
      const mk = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map);
      if (spreadM < 60) mk.setPopup(pop);
      else el.addEventListener('click', () => {
        const bb = new maplibregl.LngLatBounds(); lls.forEach((l) => bb.extend(l));
        map.fitBounds(bb, { padding: 90, maxZoom: 16.5, minZoom: Math.min(16.5, map.getZoom() + 1.5) });
      });
      groups.push(mk);
    }
  }
  map.on('zoomend', groupBuses);

  function renderList() {
    const box = $('#busBox');
    if (!box) return;
    const items = [];
    for (const a of siteAlerts?.alerts || []) items.push(`<li class="k-work"><div class="t">🚌 ${a.route ? 'ROUTE ' + esc(a.route) + (a.name ? ' ' + esc(a.name.toUpperCase()) : '') : 'SERVICE ALERT'}</div><div class="m">${esc(a.text)}</div></li>`);
    for (const n of notices) items.push(`<li class="k-work"><div class="t">🚌 ROUTE NOTICE</div><div class="m">${esc(n)}</div></li>`);
    if (!items.length && siteAlerts?.status) items.push(`<li class="empty">${esc(siteAlerts.status.toUpperCase())}</li>`);
    const active = Object.values(routes).filter((r) => r.active);
    const counts = {};
    for (const b of buses) counts[b.route] = (counts[b.route] || 0) + 1;
    box.innerHTML = items.join('') + (active.length ? active.map((r) => `<li style="border-left-color:${esc(r.color)}">
        <div class="t"><span class="bus-no" style="background:${esc(r.color)}">${esc(short(r.name))}</span> ${esc(long(r.name).toUpperCase())}</div>
        <div class="m">${counts[r.id] || 0} BUS${(counts[r.id] || 0) === 1 ? '' : 'ES'} OUT</div></li>`).join('')
      : `<li class="empty">${RELAY ? 'NO BUSES REPORTING RIGHT NOW' : 'LIVE BUSES NEED THE RELAY'}</li>`);
    window.htTicker = window.htTicker || {};
    window.htTicker.bus = [...(siteAlerts?.alerts || []).map((a) => `${a.route ? 'Route ' + a.route + ': ' : ''}${a.text}`), ...notices].join(' · ');
    window.htTickerRefresh?.();
  }

  async function loadBuses() {
    if (!RELAY) return renderList();
    try {
      const j = await (await fetch(`${RELAY}/buses?t=${Date.now()}`, { cache: 'no-store' })).json();
      routes = Object.fromEntries((j.routes || []).map((r) => [r.id, r]));
      buses = (j.buses || []).filter((b) => b.lat && b.lon);
      notices = j.notices || [];
    } catch (e) { console.warn('buses', e); }
    render();
  }
  async function loadAlerts() {
    try { siteAlerts = await (await fetch(`data/bus-alerts.json?t=${Date.now()}`, { cache: 'no-store' })).json(); } catch { siteAlerts = null; }
    renderList();
  }

  // show/hide buses (on by default; remembered per device; ?buses=0 hides them)
  let on = qs.has('buses') ? qs.get('buses') !== '0' : store.get('ht.buses') !== false;
  function setOn(v) {
    on = v; store.set('ht.buses', v);
    const btn = $('#btnBus');
    btn.classList.toggle('on', v); btn.setAttribute('aria-pressed', v);
    document.body.classList.toggle('no-buses', !v);
    showLayers(); // route lines and stops follow the bus button
    window.htDeclutter?.();
  }
  $('#btnBus').addEventListener('click', () => setOn(!on));
  setOn(on);

  loadRoutes(); loadBuses(); loadAlerts();
  setInterval(loadBuses, 20000);
  setInterval(loadAlerts, 10 * 60 * 1000);
})();
