// Grays Harbor Transit: live buses through the relay (GHT's public GPS tracker, shared 20 s refresh),
// route notices from the tracker, and service alerts the collector reads from ghtransit.com/alerts.
// Pick a route (tap its line, one of its buses, or its row in the panel) and a bar lets you step through
// routes and through the buses on that route, and follow one. Tap a stop for its next buses.
(() => {
  const map = window.htMap;
  const C = window.HT;
  if (!map) return;
  const qs = new URLSearchParams(location.search);
  const TV = qs.has('tv');
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const RELAY = (C.airRelay || '').replace(/\/aircraft$/, '');
  const phone = () => matchMedia('(max-width: 760px)').matches;

  let routes = {}, buses = [], notices = [], siteAlerts = null;
  const markers = new Map();
  // "20 - Aberdeen-Hoquiam" -> "20" and "Aberdeen-Hoquiam" (some names drop the space: "25- Hoquiam DASH")
  const parts = (name) => (name || '').match(/^\s*([0-9]+[A-Z]?)\s*-\s*(.*)$/) || [null, name || '', ''];
  const short = (name) => parts(name)[1].trim();
  const long = (name) => parts(name)[2].trim();
  const busRoute = (b) => short(routes[b.route]?.name);
  const natural = (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);

  // ---- route lines and stops (from GHT's published schedule data; data/bus-routes.json and bus-stops.json) ----
  const shapesByRoute = {}; // route number -> [{ c: [[lon,lat]...], d: [meters along], mps: typical speed }]
  const routeInfo = {}; // route number -> { name, color } from the schedule data (covers routes with no bus out)
  const mx = (a, b) => { const dx = (b[0] - a[0]) * 76000, dy = (b[1] - a[1]) * 111000; return Math.hypot(dx, dy); }; // meters, near 47°N
  let stopsGeo = null;
  async function loadRoutes() {
    try {
      const [r, s] = await Promise.all([fetch('data/bus-routes.json').then((x) => x.json()), fetch('data/bus-stops.json').then((x) => x.json())]);
      stopsGeo = s;
      // up close, routes that share a street spread apart: each route gets a lane, and every line keeps to the
      // right of its direction of travel (so a route's two directions sit on either side, like real traffic)
      const base = (rt) => rt.replace(/P$/, ''); // 20P (Port Industrial) shares route 20's lane
      const order = [...new Set(r.features.map((f) => base(f.properties.route)))].sort(natural);
      for (const f of r.features || []) {
        const p = f.properties;
        p.lane = (order.indexOf(base(p.route)) % 4) + 1;
        const c = f.geometry.coordinates, d = [0];
        for (let i = 1; i < c.length; i++) d.push(d[i - 1] + mx(c[i - 1], c[i]));
        (shapesByRoute[p.route] ||= []).push({ c, d, mps: p.mps || 7 });
        routeInfo[p.route] ||= { name: p.name, color: p.color };
      }
      const lanes = ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['*', ['get', 'lane'], 3.5]];
      // A line's offset is to the right of the way it was drawn, so a route's out-and-back legs would split to both
      // sides of the street (the doubled "candy cane" look). So the lines are cut into pieces that all point the same
      // general way (east-north-east), and each route's lane lands on one side no matter which way the bus goes.
      const REF = [Math.cos(0.35), Math.sin(0.35)]; // 20° north of east: no street grid runs square across it
      const pieces = [];
      for (const f of r.features || []) {
        const c = f.geometry.coordinates;
        let run = [c[0]], dir = 0;
        const flush = () => { if (run.length > 1) pieces.push({ type: 'Feature', properties: f.properties,
          geometry: { type: 'LineString', coordinates: dir < 0 ? run.slice().reverse() : run } }); };
        for (let i = 1; i < c.length; i++) {
          const dot = (c[i][0] - c[i - 1][0]) * 0.68 * REF[0] + (c[i][1] - c[i - 1][1]) * REF[1];
          const d = dot >= 0 ? 1 : -1;
          if (dir && d !== dir) { flush(); run = [c[i - 1]]; }
          dir = d; run.push(c[i]);
        }
        flush();
      }
      const laneData = { type: 'FeatureCollection', features: pieces };
      const add = () => {
        if (map.getSource('bus-routes')) return;
        map.addSource('bus-routes', { type: 'geojson', data: laneData });
        map.addSource('bus-stops', { type: 'geojson', data: s });
        map.addLayer({ id: 'bus-route-lines', type: 'line', source: 'bus-routes', minzoom: 9, layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-opacity': routeOpacity(), 'line-offset': lanes,
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 3] } }, 'flow-glow');
        // the picked route, drawn again on top of all the others (brighter and a bit wider)
        map.addLayer({ id: 'bus-route-picked', type: 'line', source: 'bus-routes', minzoom: 9, filter: ['==', ['get', 'route'], '__none__'],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-opacity': 1, 'line-offset': lanes,
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 14, 5] } }, 'flow-glow');
        map.addLayer({ id: 'bus-stops', type: 'circle', source: 'bus-stops', minzoom: 13.5, paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 2.5, 16, 6], 'circle-color': '#020807',
          'circle-stroke-color': '#bff4ff', 'circle-stroke-width': 1.4 } });
        // the stop you're looking at: a bright ring that shows at any zoom
        map.addLayer({ id: 'bus-stop-focus', type: 'circle', source: 'bus-stops', filter: ['==', ['get', 'id'], '__none__'], paint: {
          'circle-radius': 11, 'circle-color': 'rgba(0,229,255,.15)', 'circle-stroke-color': '#00e5ff', 'circle-stroke-width': 2.5, 'circle-blur': 0.1 } });
        // tap a stop to focus on it; tap a route line to bring that route to the top; tap anywhere else to clear
        map.on('click', (e) => {
          if (e.originalEvent?.target?.closest?.('.maplibregl-marker')) return;
          const box = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
          const stop = map.getLayer('bus-stops') && map.getLayoutProperty('bus-stops', 'visibility') !== 'none'
            ? map.queryRenderedFeatures(box, { layers: ['bus-stops'] })[0] : null;
          if (stop) return focusStop(stop.properties.id);
          const hit = map.queryRenderedFeatures(box, { layers: ['bus-route-picked'] })[0] || map.queryRenderedFeatures(box, { layers: ['bus-route-lines'] })[0];
          pickRoute(hit ? hit.properties.route.replace(/P$/, '') : null);
          if (hit) new maplibregl.Popup({ offset: 6, maxWidth: '240px', closeButton: false }).setLngLat(e.lngLat)
            .setHTML(`<h3>ROUTE ${esc(hit.properties.route)}</h3><p>${esc((hit.properties.name || '').toUpperCase())}</p>`).addTo(map);
        });
        map.on('mouseenter', 'bus-stops', () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', 'bus-stops', () => (map.getCanvas().style.cursor = ''));
        showLayers();
        if (picked) pickRoute(picked, { force: true });
      };
      if (map.isStyleLoaded()) add(); else map.once('load', add);
    } catch (e) { console.warn('bus routes', e); }
  }

  // ---- picking a route ----
  let picked = null; // the route brought to the top
  let busIdx = -1;   // which of its buses the bar is showing (-1: none yet)
  const routeOpacity = () => picked ? 0.2 : 0.6;
  // routes to step through (20P is part of 20: the same buses)
  const allRoutes = () => Object.keys(routeInfo).filter((r) => !(/P$/.test(r) && routeInfo[r.slice(0, -1)])).sort(natural);
  const routeBuses = (rt) => buses.filter((b) => busRoute(b) === rt).sort((a, b) => a.id.localeCompare(b.id));
  const routeColor = (rt) => Object.values(routes).find((r) => short(r.name) === rt)?.color || routeInfo[rt]?.color || '#bff4ff';
  const routeName = (rt) => long(Object.values(routes).find((r) => short(r.name) === rt)?.name) || routeInfo[rt]?.name || '';
  function pickRoute(route, opt = {}) {
    if (route === picked && !opt.force) return renderBar();
    if (route !== picked) busIdx = -1;
    picked = route;
    if (map.getLayer('bus-route-lines')) {
      map.setPaintProperty('bus-route-lines', 'line-opacity', routeOpacity());
      // route 20 also brings up its Port Industrial runs (20P)
      map.setFilter('bus-route-picked', ['in', ['get', 'route'], ['literal', picked ? [picked, picked + 'P'] : ['__none__']]]);
    }
    if (picked && opt.fit) fitRoute(picked);
    renderBar();
  }
  function fitRoute(rt) {
    const b = new maplibregl.LngLatBounds();
    for (const sh of shapesByRoute[rt] || []) sh.c.forEach((p) => b.extend(p));
    if (!b.isEmpty()) map.fitBounds(b, { padding: window.htFitPad ? window.htFitPad(50) : 50, maxZoom: 14.5 });
  }
  const showLayers = () => ['bus-route-lines', 'bus-route-picked', 'bus-stops', 'bus-stop-focus'].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));

  // move the map so a point sits in the middle of the part you can see (on phones the sheet covers the bottom)
  function covered() {
    if (!phone()) return 0;
    const mapBox = map.getContainer().getBoundingClientRect();
    return Math.max(0, mapBox.bottom - $('#panel').getBoundingClientRect().top);
  }
  const lookAt = (ll, zoom, duration = 900) => map.easeTo({ center: ll, zoom: zoom ?? map.getZoom(), offset: [0, -covered() / 2], duration });

  // ---- the bar: step through routes and buses, follow a bus ----
  const bar = $('#busBar');
  function renderBar() {
    if (!bar) return;
    bar.hidden = TV || (!picked && !follow);
    if (bar.hidden) return;
    markers.forEach((mk) => mk.getElement().classList.toggle('sel', !!mk._bus && (follow ? mk._bus.id === follow.id : busIdx >= 0 && mk._bus.id === routeBuses(picked)[busIdx]?.id)));
    if (follow) {
      const b = buses.find((x) => x.id === follow.id);
      const rt = b ? busRoute(b) : follow.route;
      const eta = b && follow.stop ? etaTo(b, follow.stop) : null;
      bar.innerHTML = `<div class="row"><span class="bus-no" style="background:${esc(routeColor(rt))}">${esc(rt)}</span>
        <span class="what"><b>FOLLOWING BUS ${esc(follow.id)}</b>${b ? ` · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}` : ' · LOST SIGNAL'}
        ${follow.stop ? `<br><span class="m">${eta != null ? `~${eta < 1 ? '<1' : eta} MIN TO ` : 'HEADED FOR '}${esc(follow.stop.name.toUpperCase())}</span>`
          : b?.nextStop ? `<br><span class="m">NEXT ${esc(b.nextStop.toUpperCase())}${b.nextTime ? ' · ' + esc(b.nextTime) : ''}</span>` : ''}</span>
        <button type="button" data-act="turn" aria-label="${followUp ? 'Switch to north up' : 'Switch to heading up'}" title="${followUp ? 'Bus faces up: tap for north up' : 'North up: tap so the bus faces up'}">${followUp ? '⬆' : 'N'}</button>
        <button type="button" data-act="unfollow" aria-label="Stop following">✕</button></div>`;
      return;
    }
    const list = routeBuses(picked), b = list[busIdx];
    bar.innerHTML = `<div class="row"><button type="button" data-act="prevRoute" aria-label="Previous route">◀</button>
        <span class="bus-no" style="background:${esc(routeColor(picked))}">${esc(picked)}</span>
        <span class="what">${esc(routeName(picked).toUpperCase())}</span>
        <button type="button" data-act="nextRoute" aria-label="Next route">▶</button>
        <button type="button" data-act="close" aria-label="Clear route">✕</button></div>
      <div class="row">${list.length ? `<button type="button" data-act="prevBus" aria-label="Previous bus">‹</button>
        <span class="what">${b ? `BUS ${esc(b.id)} · ${busIdx + 1} OF ${list.length} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}`
          : `${list.length} BUS${list.length > 1 ? 'ES' : ''} OUT · TAP › TO SEE ${list.length > 1 ? 'EACH' : 'IT'}`}</span>
        <button type="button" data-act="nextBus" aria-label="Next bus">›</button>
        ${b ? '<button type="button" data-act="follow" class="go">FOLLOW</button>' : ''}`
        : '<span class="what m">NO BUSES OUT ON THIS ROUTE RIGHT NOW</span>'}</div>`;
  }
  function showBus(b, zoom) {
    const mk = markers.get(b.id); if (!mk) return;
    lookAt(mk.getLngLat(), zoom ?? Math.max(map.getZoom(), 16));
  }
  bar?.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act; if (!act) return;
    const rs = allRoutes(), list = routeBuses(picked);
    if (act === 'close') { stopFollow(); pickRoute(null); }
    else if (act === 'unfollow') stopFollow();
    else if (act === 'turn') { followUp = !followUp; store.set('ht.followUp', followUp); renderBar(); keepFollowing(true); }
    else if (act === 'prevRoute' || act === 'nextRoute') {
      const i = rs.indexOf(picked), n = rs.length;
      pickRoute(rs[(i + (act === 'nextRoute' ? 1 : n - 1)) % n], { fit: true });
    } else if ((act === 'prevBus' || act === 'nextBus') && list.length) {
      busIdx = busIdx < 0 ? (act === 'nextBus' ? 0 : list.length - 1) : (busIdx + (act === 'nextBus' ? 1 : list.length - 1)) % list.length;
      showBus(list[busIdx]); renderBar();
    } else if (act === 'follow' && list[busIdx]) startFollow(list[busIdx].id, null);
  });

  // following: the map keeps the bus in view until you drag the map or press ✕. Like a car GPS, the map turns
  // so the bus points up (the road ahead fills the screen); the N button switches to north-up.
  let follow = null; // { id, route, stop: { id, name, at } | null, up: true for heading-up }
  let followUp = store.get('ht.followUp') !== false;
  function startFollow(id, stop) {
    const b = buses.find((x) => x.id === id); if (!b) return;
    follow = { id, route: busRoute(b), stop };
    document.querySelectorAll('.maplibregl-popup').forEach((p) => p.remove());
    pickRoute(busRoute(b), { force: true });
    renderBar();
    keepFollowing(true);
  }
  function stopFollow() {
    if (!follow) return;
    follow = null;
    if (map.getBearing()) map.easeTo({ bearing: 0, duration: 600 }); // back to north-up for the rest of the map
    renderBar();
  }
  map.on('dragstart', (e) => { if (e.originalEvent && follow) stopFollow(); });
  // which way the bus is going: along its route line when it's matched to one (steadier than the GPS heading)
  function headingOf(b) {
    if (b._snap) {
      const a = b._along ?? b._snap.sh.d[b._snap.i];
      return bearing(along(b._snap.sh, a), along(b._snap.sh, a + 40));
    }
    return b.mph >= 2 ? b.heading || 0 : null;
  }
  function keepFollowing(now) {
    if (!follow || (!now && map.isMoving())) return;
    const mk = markers.get(follow.id); if (!mk) return;
    const b = mk._bus, box = map.getContainer();
    const seen = box.clientHeight - covered(); // the part of the map not under the sheet
    // heading-up: the bus sits low on the screen so you can see where it's going; north-up: in the middle
    const want = [box.clientWidth / 2, followUp ? seen * 0.6 : seen / 2];
    const h = followUp ? headingOf(b) : 0;
    const turn = h == null ? 0 : Math.abs(((h - map.getBearing() + 540) % 360) - 180);
    const p = map.project(mk.getLngLat());
    // only move when it drifts or turns, so the map isn't always in motion
    if (now || turn > 6 || Math.hypot(p.x - want[0], p.y - want[1]) > Math.min(box.clientWidth, box.clientHeight) * 0.1) {
      map.easeTo({ center: mk.getLngLat(), zoom: now ? Math.max(map.getZoom(), 15.5) : map.getZoom(),
        bearing: h == null ? map.getBearing() : h, offset: [0, want[1] - box.clientHeight / 2], duration: now ? 900 : 1200 });
    }
  }

  // ---- estimated positions between GPS reports ----
  // Each report gives position, heading and speed. Between reports (20 s apart), each moving bus is slid along
  // its route line at its last speed, four times a second, for a little while. A stopped bus stays put.
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
  // Estimates are deliberately cautious (70% of the last speed, at most 45 s) so a bus rarely gets ahead of
  // reality, and when a new report arrives the bus glides there over 1.5 s from wherever it's drawn,
  // instead of jumping (forward or back).
  const PACE = 0.7, MAX_S = 45, BLEND_MS = 1500;
  function glide() {
    if (document.hidden || !on) return;
    const now = Date.now();
    for (const mk of markers.values()) {
      const b = mk._bus;
      if (!b) continue;
      // the route lines may arrive after the buses: match each bus to its line once they're in
      if (!b._snap && !b._tried && Object.keys(shapesByRoute).length) { b._tried = true; b._snap = snap(b, busRoute(b)); }
      // where the bus should be now: its report, slid along its route if it's moving
      let target = [b.lon, b.lat];
      if (b._snap) b._along = b._snap.sh.d[b._snap.i];
      if (b.mph >= 2 && b._snap) {
        const secs = Math.min(MAX_S, (now - b._at) / 1000);
        b._along += b.mph * 0.44704 * PACE * secs;
        target = along(b._snap.sh, b._along);
      }
      // ease from where it was drawn when the report arrived
      const k = b._from ? Math.min(1, (now - b._at) / BLEND_MS) : 1;
      const e = k < 1 ? k * k * (3 - 2 * k) : 1; // smooth start and stop
      const pos = k < 1 ? [b._from[0] + (target[0] - b._from[0]) * e, b._from[1] + (target[1] - b._from[1]) * e] : target;
      if (k < 1 || (b.mph >= 2 && b._snap)) mk.setLngLat(pos);
      // point the icon along the street it's on (the GPS heading is only as fresh as the last report,
      // so a bus that just turned a corner would otherwise sit sideways)
      const h = b._snap ? headingOf(b) : null;
      if (h != null && (mk._h == null || Math.abs(((h - mk._h + 540) % 360) - 180) > 2)) {
        mk._h = h;
        const ic = mk.getElement().querySelector('.ic');
        if (ic) ic.style.transform = `rotate(calc(${Math.round(h)}deg - var(--brg, 0deg)))`;
      }
    }
    keepFollowing();
  }
  setInterval(glide, 250);
  // for checking from the browser console: how many moving buses are matched to a route line
  window.htBusDebug = () => { const bs = [...markers.values()].map((m) => m._bus).filter(Boolean);
    return { buses: bs.length, moving: bs.filter((b) => b.mph >= 2).length, onRoute: bs.filter((b) => b.mph >= 2 && b._snap).length, hidden: document.hidden }; };

  // ---- stops: tap one for its next buses (live estimates plus the timetable) ----
  // a stop's route list says "20P" for the Port Industrial runs of route 20
  const serves = (stopRoutes, rt) => stopRoutes.some((r) => r === rt || r.replace(/P$/, '') === rt);
  // minutes until a bus reaches a stop, from where it is along its route line and the route's usual pace;
  // null when the stop isn't ahead of it on this trip
  function etaTo(b, stop) {
    if (!b._snap) return null;
    const sh = b._snap.sh, here = b._along ?? sh.d[b._snap.i];
    for (let j = 0; j < sh.c.length; j++) {
      if (sh.d[j] < here - 30) continue;
      if (mx(stop.at, sh.c[j]) < 45) return Math.round(Math.max(0, sh.d[j] - here) / sh.mps / 60);
    }
    return null;
  }
  // A bus finishing a trip (say, heading into the transit center) reaches this stop on its next trip: carry on
  // from the end of its route line onto the line that starts there and passes the stop. null if none does.
  function etaNextTrip(b, stop) {
    if (!b._snap) return null;
    const sh = b._snap.sh, here = b._along ?? sh.d[b._snap.i], end = sh.c[sh.c.length - 1];
    const rest = Math.max(0, sh.d[sh.d.length - 1] - here) / sh.mps;
    let best = null;
    for (const rt of [busRoute(b), busRoute(b) + 'P']) for (const nx of shapesByRoute[rt] || []) {
      if (mx(end, nx.c[0]) > 300) continue;
      const j = nx.c.findIndex((p) => mx(stop.at, p) < 45);
      if (j < 0) continue;
      const m = (rest + nx.d[j] / nx.mps) / 60;
      if (best == null || m < best) best = m;
    }
    return best == null ? null : Math.round(best);
  }
  let times = null; // the timetable, read the first time someone opens a stop
  const loadTimes = () => times ||= fetch('data/bus-times.json').then((x) => x.json()).catch(() => null);
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  // the rest of today's scheduled departures from a stop: [route, minutes after midnight, headed-to, days]
  function scheduled(t, stopId) {
    if (!t?.stops?.[stopId]) return [];
    const now = new Date(), m = nowMin();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const dow = (now.getDay() + 6) % 7; // Monday first, like the schedule's day list
    const runs = (svc) => { const s = t.svc[svc]; return s && s.d[dow] === '1' && !(s.x || []).includes(ymd); };
    // the same departure can be listed under two day-sets (weekdays and every day): keep one
    const seen = new Set();
    return t.stops[stopId].filter(([rt, min, h, svc]) => {
      const k = `${rt}|${min}|${h}`;
      if (min < m - 1 || !runs(svc) || seen.has(k)) return false;
      seen.add(k); return true;
    });
  }
  const clock = (min) => { const h = Math.floor(min / 60) % 24, m = min % 60; return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const baseRt = (rt) => rt.replace(/P$/, '');

  // live arrivals: buses already on their way here, then buses that will come by on their next trip. Those wait at
  // the end of the line until their scheduled run, so each is matched to the next timetable departure it can make.
  function liveArrivals(stop, sched) {
    const out = [];
    for (const b of buses) {
      if (!serves(stop.routes, busRoute(b))) continue;
      const eta = etaTo(b, stop);
      if (eta != null) { out.push({ b, eta }); continue; }
      const nx = etaNextTrip(b, stop);
      if (nx != null) out.push({ b, eta: nx, next: true });
    }
    const m = nowMin(), taken = new Set();
    for (const x of out.filter((x) => x.next).sort((a, b) => a.eta - b.eta)) {
      const k = sched.findIndex(([rt, min], i) => !taken.has(i) && baseRt(rt) === busRoute(x.b) && min - m >= x.eta - 3);
      if (k >= 0) { taken.add(k); x.eta = Math.max(x.eta, sched[k][1] - m); }
    }
    return out.filter((x) => x.eta <= 90).sort((a, b) => a.eta - b.eta);
  }

  let stopPop = null, stopFocus = null;
  async function stopHtml(stop) {
    const t = await loadTimes();
    const sched = scheduled(t, stop.id);
    const live = liveArrivals(stop, sched);
    const color = (rt) => esc(routeColor(baseRt(rt)));
    const chip = (rt) => `<span class="bus-no" style="background:${color(rt)}">${esc(rt)}</span>`;
    // route chips up top are buttons: tap one for that route's full timetable here, tap again for all routes
    const only = stop.only;
    const chips = stop.routes.map((rt) => `<button type="button" class="bus-no stop-rt${only === rt ? ' on' : ''}" data-stop-route="${esc(rt)}"
      style="background:${color(rt)}" aria-pressed="${only === rt}">${esc(rt)}</button>`).join('');
    let table;
    if (!t) table = '<div class="m">TIMETABLE UNAVAILABLE</div>';
    else if (only) {
      const rows = sched.filter(([rt]) => rt === only).slice(0, 14);
      table = rows.length ? rows.map(([rt, min, h]) => `<div class="stop-row">${chip(rt)}<span><b>${clock(min)}</b> → ${esc((t.heads[h] || '').toUpperCase())}</span></div>`).join('')
        : `<div class="m">NO MORE ROUTE ${esc(only)} BUSES HERE TODAY</div>`;
    } else {
      // every route here, each with its next few times (so a route that runs twice a day isn't buried)
      table = stop.routes.map((rt) => {
        const rows = sched.filter(([r]) => r === rt);
        const byHead = {};
        for (const [, min, h] of rows) (byHead[h] ||= []).push(min);
        const heads = Object.entries(byHead).sort((a, b) => a[1][0] - b[1][0]);
        return heads.length ? heads.map(([h, mins]) => `<div class="stop-row">${chip(rt)}<span><b>${mins.slice(0, 3).map(clock).join(' · ')}</b><br>
            <span class="m">→ ${esc((t.heads[h] || '').toUpperCase())}${mins.length > 3 ? ` · ${mins.length - 3} MORE TODAY` : ''}</span></span></div>`).join('')
          : `<div class="stop-row">${chip(rt)}<span class="m">NO MORE TODAY</span></div>`;
      }).join('');
    }
    return `<h3>BUS STOP · ${esc(stop.name.toUpperCase())}</h3>
      <div class="stop-rts"><span class="m">ROUTES</span>${chips}</div>
      <div class="stop-sec">COMING UP · LIVE</div>
      ${live.length ? live.map(({ b, eta, next }) => `<div class="stop-row">${chip(busRoute(b))}<span>BUS ${esc(b.id)} · <b>~${eta < 1 ? '<1' : eta} MIN</b>${next ? '<br><span class="m">AFTER ITS CURRENT TRIP</span>' : ''}</span>
        <button type="button" class="go" data-follow="${esc(b.id)}">FOLLOW</button></div>`).join('')
        : `<div class="m">NO BUS ON THE WAY RIGHT NOW${buses.length ? '' : ' (NONE REPORTING)'}</div>`}
      <div class="stop-sec">${only ? `ROUTE ${esc(only)} TIMETABLE · <button type="button" class="stop-all" data-stop-route="">ALL ROUTES</button>` : 'TIMETABLE · TAP A ROUTE FOR ALL ITS TIMES'}</div>
      ${table}
      <div class="m" style="margin-top:6px">LIVE TIMES ARE ESTIMATES FROM GPS AND THE ROUTE'S USUAL PACE</div>`;
  }
  async function focusStop(id) {
    const f = stopsGeo?.features.find((x) => x.properties.id === id); if (!f) return;
    stopFocus = { id, name: f.properties.name, routes: String(f.properties.routes || '').split(' ').filter(Boolean), at: f.geometry.coordinates };
    map.setFilter('bus-stop-focus', ['==', ['get', 'id'], id]);
    // one route at this stop: bring it up too
    const rts = [...new Set(stopFocus.routes.map((r) => r.replace(/P$/, '')))];
    if (rts.length === 1) pickRoute(rts[0]);
    lookAt(stopFocus.at, Math.max(map.getZoom(), 15.5));
    stopPop?.remove();
    const pop = stopPop = new maplibregl.Popup({ offset: 10, maxWidth: '300px' }).setLngLat(stopFocus.at).setHTML('<div class="m">LOADING…</div>').addTo(map);
    document.body.classList.add('stop-open'); // phones tuck the bus bar away while a stop is open
    pop.on('close', () => { if (stopPop === pop) { document.body.classList.remove('stop-open'); stopPop = null; stopFocus = null; map.getLayer('bus-stop-focus') && map.setFilter('bus-stop-focus', ['==', ['get', 'id'], '__none__']); } });
    const stop = stopFocus;
    pop.setHTML(await stopHtml(stop));
    map.once('moveend', () => window.htKeepInView?.(pop));
  }
  // refresh the open stop when new bus reports come in
  async function refreshStop() { if (stopPop && stopFocus) { const s = stopFocus; const h = await stopHtml(s); if (stopFocus === s) stopPop.setHTML(h); } }
  document.addEventListener('click', (e) => {
    // a route chip in a stop's popup: that route's timetable (again, or ALL ROUTES, for every route)
    const sr = e.target.closest('[data-stop-route]');
    if (sr && stopFocus) {
      stopFocus.only = sr.dataset.stopRoute && stopFocus.only !== sr.dataset.stopRoute ? sr.dataset.stopRoute : null;
      refreshStop(); return;
    }
    const f = e.target.closest('[data-follow]');
    if (f) { const s = stopFocus; startFollow(f.dataset.follow, s ? { id: s.id, name: s.name, at: s.at } : null); return; }
    // in a group's list, tapping a bus brings up that bus's route
    const row = e.target.closest('.bus-row[data-route]');
    if (row) { pickRoute(row.dataset.route); return; }
    // a route in the panel's transit list: bring it up and show the whole route
    const li = e.target.closest('#busBox li[data-route]');
    if (li) { pickRoute(li.dataset.route, { fit: true, force: true }); if (phone()) $('#panel').classList.add('min'); }
  });
  window.htPickRoute = (r) => pickRoute(r); // for checking from the browser console
  window.htFocusStop = (id) => focusStop(id);

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
        // tapping a bus also brings its route to the top, with this bus picked in the bar
        const theMk = mk;
        el.addEventListener('click', () => {
          const rt = theMk._bus ? busRoute(theMk._bus) : null;
          pickRoute(rt || null);
          if (rt) { busIdx = routeBuses(rt).findIndex((x) => x.id === theMk._bus.id); renderBar(); }
        });
        markers.set(b.id, mk);
      } else {
        // already on the map: remember where it's drawn and let glide() ease it to the new report
        const ll = mk.getLngLat();
        b._from = [ll.lng, ll.lat];
      }
      const el = mk.getElement();
      el.classList.toggle('stopped', b.mph < 2);
      el.innerHTML = `<div class="ic" style="transform:rotate(calc(${b.heading || 0}deg - var(--brg, 0deg)))">${busSvg(r.color || '#bff4ff')}</div><b style="color:${esc(r.color || '#bff4ff')};border-color:${esc(r.color || '#bff4ff')}">${esc(short(r.name))}</b>`;
      el.title = `Route ${short(r.name)} · bus ${b.id}`;
      mk._bus = b;
      mk._h = null; // the icon was redrawn at the GPS heading; glide() lines it up with the street again
      b._at = Date.now();
      b._snap = snap(b, short(r.name));
      b._along = b._snap ? b._snap.sh.d[b._snap.i] : undefined;
      mk.getPopup().setHTML(`<h3>ROUTE ${esc(short(r.name))} · ${esc(long(r.name).toUpperCase())}</h3>
        <p>BUS ${esc(b.id)} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}</p>
        ${b.nextStop ? `<div class="m">NEXT: ${esc(b.nextStop.toUpperCase())}${b.nextTime ? ' · ' + esc(b.nextTime) : ''}</div>` : ''}
        ${TV ? '' : `<button type="button" class="go" data-follow="${esc(b.id)}">FOLLOW THIS BUS</button>`}`);
    }
    for (const [id, mk] of markers) if (!seen.has(id)) { mk.remove(); markers.delete(id); }
    groupBuses();
    renderList();
    renderBar();
    refreshStop();
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
        return `<div class="m bus-row" data-route="${esc(short(r.name))}" style="cursor:pointer"><span class="bus-no" style="background:${esc(r.color || '#bff4ff')}">${esc(short(r.name))}</span>BUS ${esc(b.id)} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}${b.nextStop ? ' · NEXT ' + esc(b.nextStop.toUpperCase()) + (b.nextTime ? ' ' + esc(b.nextTime) : '') : ''}</div>`;
      }).join(''));
      const mk = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map);
      // tapping the group brings up its route when every bus in it is on the same route
      el.addEventListener('click', () => { if (oneRoute) pickRoute(short(routes[list[0].route]?.name) || null); });
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
    // every row brings its route up on the map (and the bar for stepping through its buses)
    box.innerHTML = items.join('') + (active.length ? active.map((r) => `<li class="clickable" data-route="${esc(short(r.name))}" style="border-left-color:${esc(r.color)}">
        <div class="t"><span class="bus-no" style="background:${esc(r.color)}">${esc(short(r.name))}</span> ${esc(long(r.name).toUpperCase())}</div>
        <div class="m">${counts[r.id] || 0} BUS${(counts[r.id] || 0) === 1 ? '' : 'ES'} OUT · TAP TO SHOW</div></li>`).join('')
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
    if (!v) { stopFollow(); pickRoute(null); stopPop?.remove(); }
    showLayers(); // route lines and stops follow the bus button
    window.htDeclutter?.();
  }
  $('#btnBus').addEventListener('click', () => setOn(!on));
  setOn(on);

  loadRoutes(); loadBuses(); loadAlerts();
  setInterval(loadBuses, 20000);
  setInterval(loadAlerts, 10 * 60 * 1000);
})();
