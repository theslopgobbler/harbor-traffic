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
  // One color per route for both its line and its buses. GHT's tracker and its schedule data use different
  // colors, and some vanish on this dark map (50 is black, 60 and the WAVE are the map's own cyan), so these are
  // GHT's schedule colors, brightened where too dark and swapped where they clash.
  const COLORS = { '5': '#c6ff3d', '10N': '#3373ff', '10S': '#c4672f', '20': '#e8202a', '20P': '#e8202a', '25': '#ff7e5e',
    '30': '#e08a14', '40': '#fff700', '45': '#ffc60a', '50': '#a678ff', '60': '#ff5ac8', '70': '#3fae1a', '161': '#ff5ac8', '171': '#3fae1a' };
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
        p.color = COLORS[p.route] || p.color;
        p.lane =(order.indexOf(base(p.route)) % 4) + 1;
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
  // heading-up button: a pixel arrow (an arrow character turns into a color emoji on phones)
  const UP_SVG = '<svg class="px" viewBox="0 0 9 10" width="14" height="16" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M4 0h1v1h-1zM3 1h3v1h-3zM2 2h5v1h-5zM1 3h7v1h-7zM0 4h9v1h-9zM3 5h3v5h-3z"/></svg>';
  // the next stop ahead of a bus along its route line (its stops are found once per line, then cached)
  function lineStops(sh, rt) {
    if (sh.stops) return sh.stops;
    sh.stops = [];
    for (const f of stopsGeo?.features || []) {
      if (!serves(String(f.properties.routes || '').split(' '), rt)) continue;
      const p = f.geometry.coordinates;
      // every pass by the stop (a line can go by the same corner more than once)
      let last = -1e9;
      for (let i = 0; i < sh.c.length; i++) {
        if (mx(p, sh.c[i]) < 30 && sh.d[i] - last > 100) { sh.stops.push({ d: sh.d[i], name: f.properties.name }); last = sh.d[i]; }
      }
    }
    sh.stops.sort((a, b) => a.d - b.d);
    return sh.stops;
  }
  function nextStopOf(b) {
    if (!b._snap || !stopsGeo) return null;
    const here = b._along ?? b._obs ?? 0;
    return lineStops(b._snap.sh, busRoute(b)).find((s) => s.d > here + 15)?.name || null;
  }
  function renderBar() {
    if (!bar) return;
    bar.hidden = TV || (!picked && !follow);
    if (bar.hidden) return;
    markers.forEach((mk) => mk.getElement().classList.toggle('sel', !!mk._bus && (follow ? mk._bus.id === follow.id : busIdx >= 0 && mk._bus.id === routeBuses(picked)[busIdx]?.id)));
    if (follow) {
      const b = buses.find((x) => x.id === follow.id);
      const rt = b ? busRoute(b) : follow.route;
      const eta = b && follow.stop ? etaTo(b, follow.stop) : null;
      const nx = b ? nextStopOf(b) : null;
      bar.innerHTML = `<div class="row"><span class="bus-no" style="background:${esc(routeColor(rt))}">${esc(rt)}</span>
        <span class="what follow"><b>BUS ${esc(follow.id)}</b>${b ? ` · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}` : ' · LOST SIGNAL'}${nx ? ` · NEXT STOP <b>${esc(nx.toUpperCase())}</b>` : ''}
        ${follow.stop ? `<br><span class="m">${eta != null ? `~${eta < 1 ? '<1' : eta} MIN TO ` : 'HEADED FOR '}${esc(follow.stop.name.toUpperCase())}</span>`
          : b?.nextStop ? `<br><span class="m">DUE AT ${esc(b.nextStop.toUpperCase())}${b.nextTime ? ' · ' + esc(b.nextTime) : ''}</span>` : ''}</span>
        <button type="button" data-act="turn" ${chase ? 'hidden' : ''} aria-label="${followUp ? 'Switch to north up' : 'Switch to heading up'}" title="${followUp ? 'Bus faces up: tap for north up' : 'North up: tap so the bus faces up'}">${followUp ? UP_SVG : 'N'}</button>
        <button type="button" data-act="chase" class="${chase ? 'on' : ''}" aria-label="${chase ? 'Leave the chase view' : 'Chase view: ride behind the bus'}">${chase ? '2D' : '3D'}</button>
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
    else if (act === 'chase') setChase(!chase);
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
    setChase(false);
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
  // ---- chase view: zoom all the way in while following (or press 3D) and the camera drops in behind the bus,
  // tilted like a driving game, and the bus becomes a pixel sprite seen from behind. Zoom out or press 2D to leave.
  let chase = false, chaseBrg = 0;
  const CHASE_PITCH = 58, CHASE_ZOOM = 17;
  function setChase(v) {
    if (v === chase || (v && !follow)) return;
    chase = v;
    document.body.classList.toggle('chase', v);
    const mk = follow && markers.get(follow.id);
    if (v) {
      if (phone()) $('#panel').classList.add('min'); // more road on screen
      map.setMaxZoom(18);
      chaseBrg = (mk && headingOf(mk._bus)) ?? map.getBearing();
      map.easeTo({ center: mk ? mk.getLngLat() : map.getCenter(), zoom: CHASE_ZOOM, pitch: CHASE_PITCH, bearing: chaseBrg,
        padding: chasePad(), duration: 1400 });
    } else {
      map.easeTo({ pitch: 0, zoom: Math.min(map.getZoom(), 15.5), padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
      map.once('moveend', () => { if (!chase) map.setMaxZoom(16); });
    }
    if (mk) drawBus(mk);
    renderBar();
    updateSignals();
  }
  // traffic signals near the chased bus (where OpenStreetMap has them: data/signals.json), as little pixel
  // signals standing at the corners. They're decoration: they cycle on their own, not in step with the real ones.
  let signals = null;
  const sigMarkers = new Map();
  const SIG_SVG = `<svg viewBox="0 0 8 23" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="3" y="10" width="2" height="13" fill="#3b4b49"/><rect x="1" y="0" width="6" height="11" fill="#020807"/>
    <rect x="1.5" y="0.5" width="5" height="10" fill="none" stroke="#1d6358" stroke-width=".5"/>
    <rect class="l-r" x="2.5" y="1.5" width="3" height="2.5"/><rect class="l-y" x="2.5" y="4.25" width="3" height="2.5"/>
    <rect class="l-g" x="2.5" y="7" width="3" height="2.5"/></svg>`;
  // Pretend timing that at least behaves like real lights: signals within 45 m of each other are one
  // intersection on one 90 s cycle (north-south green 40 s, yellow 4, then east-west the same, a second of
  // all-red between), each intersection starting at its own point in the cycle. The lights you see are the
  // ones for the way the camera (and the bus) is facing.
  let sigCluster = null, sigOffset = null;
  function clusterSignals() {
    const n = signals.length, parent = signals.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (mx(signals[i], signals[j]) < 45) parent[find(i)] = find(j);
    sigCluster = signals.map((_, i) => find(i));
    // a steady offset per intersection, from where it is (the same on every phone and every visit)
    sigOffset = sigCluster.map((c) => Math.abs(Math.round(signals[c][0] * 1e4 * 7 + signals[c][1] * 1e4 * 13)) % 90);
  }
  function signalPhase(i, now) {
    const t = (now / 1000 + sigOffset[i]) % 90;
    const northSouth = Math.abs(((chaseBrg % 180) + 180) % 180 - 90) > 45; // facing roughly north or south
    const s = northSouth ? t : (t + 45) % 90;
    return s < 40 ? 'go' : s < 44 ? 'slow' : 'stop';
  }
  async function updateSignals() {
    if (!chase || !follow) { sigMarkers.forEach((m) => m.remove()); sigMarkers.clear(); return; }
    if (!signals) { try { signals = (await (await fetch('data/signals.json')).json()).signals || []; } catch { signals = []; } clusterSignals(); }
    const mk = markers.get(follow.id); if (!mk) return;
    const at = mk.getLngLat(), here = [at.lng, at.lat], now = Date.now();
    const near = new Set();
    signals.forEach((p, i) => {
      if (mx(here, p) > 700) return;
      near.add(i);
      let m = sigMarkers.get(i);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'sig-mk';
        el.innerHTML = SIG_SVG;
        m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p).addTo(map);
        sigMarkers.set(i, m);
      }
      m.getElement().dataset.phase = signalPhase(i, now);
    });
    for (const [i, m] of sigMarkers) if (!near.has(i)) { m.remove(); sigMarkers.delete(i); }
  }
  setInterval(updateSignals, 1000);
  // say so on the map, so nobody waits on a pretend green
  const chaseNote = document.createElement('div');
  chaseNote.className = 'chase-note';
  chaseNote.textContent = 'TRAFFIC LIGHTS ARE FOR LOOKS · NOT LIVE';
  map.getContainer().parentElement.appendChild(chaseNote);
  // the camera centers on the bus but lower on the screen, so you see the road ahead of it
  const chasePad = () => { const seen = map.getContainer().clientHeight - covered(); return { top: seen * 0.3, bottom: covered(), left: 0, right: 0 }; };
  // every frame in chase view: stay on the bus and turn smoothly with the road
  function chaseCamera(dt) {
    if (!chase || !follow || map.isEasing()) return;
    const mk = markers.get(follow.id); if (!mk) return;
    const h = headingOf(mk._bus);
    if (h != null) chaseBrg += (((h - chaseBrg + 540) % 360) - 180) * Math.min(1, dt * 2);
    map.jumpTo({ center: mk.getLngLat(), bearing: chaseBrg, padding: chasePad() });
  }
  // zooming all the way in while following starts it; zooming well out ends it
  map.on('zoomend', (e) => {
    if (follow && !chase && e.originalEvent && map.getZoom() >= 15.95) setChase(true);
    else if (chase && e.originalEvent && map.getZoom() < 15) setChase(false);
  });
  function keepFollowing(now) {
    if (!follow || chase || (!now && map.isMoving())) return;
    const mk = markers.get(follow.id); if (!mk) return;
    const b = mk._bus, box = map.getContainer();
    // passed a stop since the bar was drawn: show the new next stop
    const nx = nextStopOf(b);
    if (nx !== follow.nx) { follow.nx = nx; renderBar(); }
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
  // A bus on a route line moves like a car, never backwards: it's drawn at a distance along the line and driven
  // toward where the reports say it should be (the last report, slid forward at its speed). Behind, it speeds up
  // to close the gap over a few seconds; ahead (the real bus slowed or stopped), it eases off and waits for the
  // reports to catch up, instead of snapping back. A bus with no line (or a new one) glides straight to its report.
  const PACE = 0.9, MAX_S = 30, CATCH_S = 8, BLEND_MS = 1500;
  // where along a line a reported position is: the closest point near where the bus is drawn now
  // A route can have several versions that share streets and then split (a detour loop, a different end of the
  // line). Before the next report shows which way the bus went, it shouldn't guess: so this finds how far ahead
  // every version of its route that fits where the bus is (and the way it's heading) still runs together,
  // and the bus waits at the split for the next report.
  function forkAhead(b, rt) {
    const main = b._snap.sh, i0 = b._snap.i, p = [b.lon, b.lat];
    const heading = b.mph >= 2 ? b.heading : null;
    let limit = main.d[main.d.length - 1];
    for (const r of [rt, rt + 'P']) for (const sh of shapesByRoute[r] || []) {
      if (sh === main) continue;
      const o = onLine(sh, p, null, heading, 40);
      if (!o) continue; // this version doesn't come by here
      // walk both lines forward together until they're more than 25 m apart
      let j = o.i;
      for (let k = i0; k < main.c.length && main.d[k] - main.d[i0] < 4000; k++) {
        while (j < sh.c.length - 1 && mx(main.c[k], sh.c[j + 1]) <= mx(main.c[k], sh.c[j])) j++;
        if (mx(main.c[k], sh.c[j]) > 25) { limit = Math.min(limit, main.d[Math.max(i0, k - 1)]); break; }
      }
    }
    return limit;
  }
  function onLine(sh, p, near, heading, radius) {
    let best = null;
    for (let i = 0; i < sh.c.length; i++) {
      if (near != null && Math.abs(sh.d[i] - near) > 800) continue;
      // moving: only the part of the line going its way (not the other side of an out-and-back street)
      if (heading != null && i < sh.c.length - 1 && diff(bearing(sh.c[i], sh.c[i + 1]), heading) > 90) continue;
      const dist = mx(p, sh.c[i]);
      if (dist < (radius || 60) && (!best || dist < best.dist)) best = { i, dist };
    }
    return best;
  }
  let lastFrame = 0, lastFollow = 0;
  function glide(t) {
    requestAnimationFrame(glide);
    if (document.hidden || !on || t - lastFrame < 33) return; // about 30 frames a second
    const dt = Math.min(0.25, (t - (lastFrame || t)) / 1000);
    lastFrame = t;
    const now = Date.now();
    for (const mk of markers.values()) {
      const b = mk._bus;
      if (!b) continue;
      // the route lines may arrive after the buses: match each bus to its line once they're in
      if (!b._snap && !b._tried && Object.keys(shapesByRoute).length) { b._tried = true; b._snap = snap(b, busRoute(b)); if (b._snap) { b._obs = b._snap.sh.d[b._snap.i]; b._fork = forkAhead(b, busRoute(b)); } }
      let pos;
      if (b._snap) {
        const sh = b._snap.sh, end = sh.d[sh.d.length - 1];
        if (mk._sh !== sh || mk._s == null) { mk._sh = sh; mk._s = b._obs; } // a new line: start at the report
        const v = b.mph >= 2 ? b.mph * 0.44704 : 0; // meters a second
        // (never past a split in its route: it waits there for the next report to say which way it went)
        const target = Math.min(end, b._fork ?? end, b._obs + v * PACE * Math.min(MAX_S, (now - b._at) / 1000));
        const gap = target - mk._s;
        if (gap > 400 || gap < -200) mk._s = target; // far off (a missed turn, a stale report): just go there
        // never faster than a bit over the bus's own speed, so catching up looks like driving, not a lurch
        // (and hard-stopped at a split: up to it, or holding still if it's already there)
        else mk._s = Math.min(end, Math.max(mk._s, b._fork ?? end), mk._s + Math.min(v * 1.5 + 5, Math.max(0, v * PACE + gap / CATCH_S)) * dt);
        b._along = mk._s;
        pos = along(sh, mk._s);
      } else pos = [b.lon, b.lat];
      // a bus that jumped to a new line, or has none, eases over from where it was drawn
      const k = b._from ? Math.min(1, (now - b._at) / BLEND_MS) : 1;
      if (k < 1) { const e = k * k * (3 - 2 * k); pos = [b._from[0] + (pos[0] - b._from[0]) * e, b._from[1] + (pos[1] - b._from[1]) * e]; }
      const ll = mk.getLngLat();
      if (Math.abs(ll.lng - pos[0]) > 1e-7 || Math.abs(ll.lat - pos[1]) > 1e-7) mk.setLngLat(pos);
      // point the icon along the street it's on (the GPS heading is only as fresh as the last report,
      // so a bus that just turned a corner would otherwise sit sideways)
      const h = b._snap ? headingOf(b) : null;
      if (h != null && (mk._h == null || Math.abs(((h - mk._h + 540) % 360) - 180) > 2)) {
        mk._h = h;
        const ic = mk.getElement().querySelector('.ic');
        if (ic) ic.style.transform = `rotate(calc(${Math.round(h)}deg - var(--brg, 0deg)))`;
      }
    }
    chaseCamera(dt);
    if (t - lastFollow > 250) { lastFollow = t; keepFollowing(); }
  }
  requestAnimationFrame(glide);
  // for checking from the browser console: how many moving buses are matched to a route line
  window.htBusDebug = () => { const bs = [...markers.values()].map((m) => m._bus).filter(Boolean);
    return { buses: bs.length, moving: bs.filter((b) => b.mph >= 2).length, onRoute: bs.filter((b) => b.mph >= 2 && b._snap).length, hidden: document.hidden,
      splitAhead: bs.filter((b) => b._snap).map((b) => `${busRoute(b)}/${b.id}: ${Math.round((b._fork ?? 0) - (b._obs ?? 0))} m`) }; };

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

  // in chase view, the followed bus seen from behind and a little above, in pixel art: roof, route sign, rear
  // window, tail lights (bright red while it's stopped, like brake lights), bumper and wheels
  const spriteSvg = (c, rt, stopped) => `<svg viewBox="0 0 24 25" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="2" y="22" width="20" height="3" fill="rgba(0,0,0,.5)"/>
    <rect x="4" y="0" width="16" height="3" fill="${c}" opacity=".55"/>
    <rect x="3" y="2" width="18" height="18" fill="#020807"/><rect x="4" y="3" width="16" height="16" fill="${c}"/>
    <rect x="5" y="4" width="14" height="4" fill="#020807"/>
    <text x="12" y="7.3" text-anchor="middle" font-family="Share Tech Mono, monospace" font-size="3.6" fill="#ffc400">${esc(rt)}</text>
    <rect x="5" y="9" width="14" height="5" fill="#0b2b2a"/><rect x="6" y="10" width="3" height="1" fill="#bff4ff" opacity=".7"/><rect x="6" y="11" width="1" height="1" fill="#bff4ff" opacity=".7"/>
    <rect x="4" y="15" width="3" height="2" fill="${stopped ? '#ff2a3d' : '#8a1520'}"/><rect x="17" y="15" width="3" height="2" fill="${stopped ? '#ff2a3d' : '#8a1520'}"/>
    <rect x="9" y="15" width="6" height="2" fill="#020807" opacity=".6"/>
    <rect x="3" y="19" width="18" height="2" fill="#2b3b39"/>
    <rect x="4" y="21" width="4" height="2" fill="#000"/><rect x="16" y="21" width="4" height="2" fill="#000"/></svg>`;
  // draw a bus marker: the top-down icon pointed along its street, or the chase sprite for the bus being chased
  function drawBus(mk) {
    const b = mk._bus, r = routes[b.route] || {}, rt = short(r.name), color = r.color || '#bff4ff';
    const el = mk.getElement();
    el.classList.toggle('stopped', b.mph < 2);
    const chased = chase && follow?.id === b.id;
    el.classList.toggle('chase', chased);
    if (chased) {
      el.innerHTML = `<div class="sprite" style="--c:${esc(color)}">${spriteSvg(color, rt, b.mph < 2)}</div><span class="tag" style="border-color:${esc(color)}">BUS ${esc(b.id)}</span>`;
    } else {
      const h = Math.round((b._snap ? headingOf(b) : null) ?? b.heading ?? 0);
      mk._h = h;
      el.innerHTML = `<div class="ic" style="transform:rotate(calc(${h}deg - var(--brg, 0deg)))">${busSvg(color)}</div><b style="color:${esc(color)};border-color:${esc(color)}">${esc(rt)}</b>`;
    }
    el.title = `Route ${rt} · bus ${b.id}`;
  }

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
        // already on the map: remember where it's drawn and let glide() carry it on from there
        const ll = mk.getLngLat();
        b._from = [ll.lng, ll.lat];
      }
      // where the report is on its route line: on the line it's already drawn on when it's still on it
      // (so it carries on smoothly), otherwise the best match among its route's lines
      const prev = mk._bus, rt = short(r.name);
      let sn = null;
      if (mk._sh && prev && prev.route === b.route) {
        const o = onLine(mk._sh, [b.lon, b.lat], mk._s, b.mph >= 2 ? b.heading : null);
        if (o) sn = { sh: mk._sh, i: o.i, dist: o.dist };
      }
      b._snap = sn || snap(b, rt);
      b._obs = b._snap ? b._snap.sh.d[b._snap.i] : undefined;
      b._fork = b._snap ? forkAhead(b, rt) : undefined;
      if (window.htTrace && follow?.id === b.id) window.htTrace.push({ t: Date.now(), same: !!sn, newLine: b._snap?.sh !== mk._sh, obs: Math.round(b._obs), drawn: Math.round(mk._s), mph: Math.round(b.mph) });
      b._along = b._snap && b._snap.sh === mk._sh ? mk._s : b._obs;
      b._at = Date.now();
      mk._bus = b;
      drawBus(mk);
      const el = mk.getElement();
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

  let lastAt = null;
  async function loadBuses() {
    if (!RELAY) return renderList();
    try {
      const j = await (await fetch(`${RELAY}/buses?t=${Date.now()}`, { cache: 'no-store' })).json();
      // the relay shares one reading among everyone; the same reading again has nothing new
      if (j.at && j.at === lastAt) return;
      lastAt = j.at;
      routes = Object.fromEntries((j.routes || []).map((r) => [r.id, { ...r, color: COLORS[short(r.name)] || r.color }]));
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

  loadRoutes(); loadAlerts();
  // GHT's GPS updates about every 8 s: check every 10 s while someone's watching buses closely
  // (following one, a stop open, a route picked), every 20 s otherwise
  (async function poll() {
    await loadBuses();
    setTimeout(poll, follow || stopPop || picked ? 10000 : 20000);
  })();
  setInterval(loadAlerts, 10 * 60 * 1000);
})();
