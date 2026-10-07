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
      // Routes that share a street simply overlap (side-by-side lanes pulled the lines, buses and stops off the
      // road); the route you're looking at (picked, or the bus you're following) is drawn again on top
      for (const f of r.features || []) {
        const p = f.properties;
        p.color = COLORS[p.route] || p.color;
        const c = f.geometry.coordinates, d = [0];
        for (let i = 1; i < c.length; i++) d.push(d[i - 1] + mx(c[i - 1], c[i]));
        (shapesByRoute[p.route] ||= []).push({ c, d, mps: p.mps || 7 });
        routeInfo[p.route] ||= { name: p.name, color: p.color };
      }
      const add = () => {
        if (map.getSource('bus-routes')) return;
        map.addSource('bus-routes', { type: 'geojson', data: r });
        map.addSource('bus-stops', { type: 'geojson', data: s });
        const width = (w0, w1) => ['interpolate', ['linear'], ['zoom'], 9, w0, 14, w1];
        map.addLayer({ id: 'bus-route-lines', type: 'line', source: 'bus-routes', minzoom: 9, layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-opacity': routeOpacity(), 'line-width': width(1.2, 3) } }, 'flow-glow');
        // the picked route, drawn again on top of all the others (brighter and a bit wider)
        map.addLayer({ id: 'bus-route-picked', type: 'line', source: 'bus-routes', minzoom: 9, filter: ['==', ['get', 'route'], '__none__'],
          layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-opacity': 1, 'line-width': width(2.2, 5) } }, 'flow-glow');
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
          pickRoute(hit ? hit.properties.route.replace(/P$/, '') : null, { bar: !!hit });
          if (hit) new maplibregl.Popup({ offset: 6, maxWidth: '240px', closeButton: false }).setLngLat(e.lngLat)
            .setHTML(`<h3>ROUTE ${esc(hit.properties.route)}</h3><p>${esc((hit.properties.name || '').toUpperCase())}</p>`).addTo(map);
        });
        map.on('mouseenter', 'bus-stops', () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', 'bus-stops', () => (map.getCanvas().style.cursor = ''));
        showLayers();
        if (picked) pickRoute(picked, { force: true, bar: barOn });
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
  // not in service: GHT's tracker reports the bus's position under a route, but its route list doesn't name it as
  // running (parked at the base, deadheading). Shown dimmed; left out of counts and stepping through a route
  // (the relay decides: not on the route list AND parked at GHT's base; older relays only sent "listed")
  const oos = (b) => (b.oos != null ? b.oos : b.listed === false);
  const routeBuses = (rt) => buses.filter((b) => busRoute(b) === rt && !oos(b)).sort((a, b) => a.id.localeCompare(b.id));
  const routeColor = (rt) => Object.values(routes).find((r) => short(r.name) === rt)?.color || routeInfo[rt]?.color || '#bff4ff';
  const routeName = (rt) => long(Object.values(routes).find((r) => short(r.name) === rt)?.name) || routeInfo[rt]?.name || '';
  // the bar (step through routes and buses) opens when you pick a route itself: its line or its row in the panel.
  // Tapping a bus, a stop or a group only brings its route up; their own popups have what you need.
  let barOn = false;
  function pickRoute(route, opt = {}) {
    if ('bar' in opt) barOn = opt.bar; else if (route !== picked) barOn = true;
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
      // a stop named for its direction ("... Eastbound") only counts where the line runs that way, not for
      // buses going the other way past it on the far side of the road
      const dir = { north: 0, east: 90, south: 180, west: 270 }[(String(f.properties.name).match(/(north|south|east|west)\s*bound/i)?.[1] || '').toLowerCase()];
      // every pass by the stop (a line can go by the same corner more than once)
      let last = -1e9;
      for (let i = 0; i < sh.c.length; i++) {
        if (mx(p, sh.c[i]) < 30 && sh.d[i] - last > 100) {
          if (dir != null && i < sh.c.length - 1 && diff(bearing(sh.c[i], sh.c[i + 1]), dir) > 80) continue;
          // buses stop on the right side of the road: a stop more than 4 m to the left of the way the line runs
          // is the stop for the other direction (on an out-and-back street both are within reach of the line)
          const a = sh.c[Math.max(0, Math.min(i, sh.c.length - 2))], z = sh.c[Math.max(1, Math.min(i + 1, sh.c.length - 1))];
          const vx = (z[0] - a[0]) * 76000, vy = (z[1] - a[1]) * 111000, wx = (p[0] - a[0]) * 76000, wy = (p[1] - a[1]) * 111000;
          const len = Math.hypot(vx, vy);
          if (len > 0 && (vx * wy - vy * wx) / len > 4) continue;
          sh.stops.push({ d: sh.d[i], name: f.properties.name }); last = sh.d[i];
        }
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
  // where the followed bus is with its stops: at one, pulling in, just leaving one, or on the way to the next
  function stopStatus(b) {
    if (!b?._snap || !stopsGeo) return null;
    const here = b._along ?? b._obs ?? 0, list = lineStops(b._snap.sh, busRoute(b));
    const next = list.find((s) => s.d > here + 15);
    let prev = null; for (const s of list) { if (s.d <= here + 15) prev = s; else break; }
    const rolling = markers.get(b.id)?._rolling;
    if (!rolling && prev && here - prev.d < 35) return { word: 'AT', name: prev.name };
    if (!rolling && next && next.d - here < 35) return { word: 'AT', name: next.name };
    if (next && next.d - here < 150) return { word: 'NOW ARRIVING', name: next.name };
    if (rolling && prev && here - prev.d < 120) return { word: 'DEPARTING', name: prev.name, then: next?.name };
    return next ? { word: 'NEXT STOP', name: next.name } : null;
  }
  // the street the bus is on: the named street under it on the map that runs the same way it's going (so a
  // cross street at an intersection doesn't count), from an invisible copy of the street lines (app.js 'street-q')
  function segDist(p, a, b) {
    const ax = (a[0] - p[0]) * 76000, ay = (a[1] - p[1]) * 111000, bx = (b[0] - p[0]) * 76000, by = (b[1] - p[1]) * 111000;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  function streetOf(mk) {
    const ll = mk.getLngLat(), here = [ll.lng, ll.lat];
    // at a transit center (a bus bay, not a road): say that instead
    const tc = stopsGeo?.features.find((f) => /transit (center|ctr)/i.test(f.properties.name) && mx(here, f.geometry.coordinates) < 70);
    if (tc) return 'AT ' + String(tc.properties.name).toUpperCase();
    if (!map.getLayer('street-q') || map.getZoom() < 12) return null;
    const p = map.project(ll);
    const feats = map.queryRenderedFeatures([[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]], { layers: ['street-q'] });
    const h = mk._bus ? headingOf(mk._bus) : null;
    let best = null;
    for (const f of feats) {
      const g = f.geometry, lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const c of lines) for (let i = 0; i < c.length - 1; i++) {
        const dist = segDist(here, c[i], c[i + 1]);
        if (dist > 40) continue;
        const b = bearing(c[i], c[i + 1]);
        const turn = h == null ? 0 : Math.min(diff(b, h), diff(b, (h + 180) % 360)); // either way along the street
        if (turn > 35) continue;
        const score = dist + turn;
        if (!best || score < best.s) best = { s: score, name: f.properties.name };
      }
    }
    return best ? 'ON ' + (window.htShortStreet ? window.htShortStreet(best.name) : best.name.toUpperCase()) : null;
  }
  // ---- the route ahead of the followed bus: road alerts along the rest of its line, and a change in the weather
  // at a town it's heading for (rechecked every 10 s)
  const MI = 1609.34;
  function routeAhead(b) {
    if (!b?._snap) return null;
    const sh = b._snap.sh, s0 = b._along ?? b._obs ?? 0;
    // the rest of the line, a point every 120 m or so, each with how far ahead it is
    const pts = [];
    for (let i = 0; i < sh.c.length; i++) {
      if (sh.d[i] < s0) continue;
      if (!pts.length || sh.d[i] - pts[pts.length - 1][1] - s0 >= 120) pts.push([sh.c[i], sh.d[i] - s0]);
    }
    if (!pts.length) return null;
    // road alerts within about 150 m of it, nearest first
    const order = ['closure', 'collision', 'work', 'other'];
    const alerts = [];
    for (const r of window.htRoads?.() || []) {
      if (!r.lat && !(r.path?.length)) continue;
      const ap = Array.isArray(r.path) && r.path.length > 1 ? r.path.filter((_, k) => k % 3 === 0 || k === r.path.length - 1) : [[r.lon, r.lat]];
      let ahead = null;
      for (const [p, dist] of pts) { for (const q of ap) if (mx(p, q) < 150) { ahead = dist; break; } if (ahead != null) break; }
      if (ahead != null) alerts.push({ r, ahead });
    }
    alerts.sort((x, y) => order.indexOf(x.r.kind) - order.indexOf(y.r.kind) || x.ahead - y.ahead);
    // weather: the town nearest the bus now, against towns the rest of its line passes (within 3 km)
    const towns = window.htTownWx?.() || [];
    const nearTown = (p, max) => towns.map((t) => [mx(p, [t.lon, t.lat]), t]).filter(([d]) => d < max).sort((x, y) => x[0] - y[0])[0]?.[1];
    const here = nearTown(pts[0][0], 15000);
    let wx = null;
    if (here) for (const [p, dist] of pts) {
      const t = nearTown(p, 3000);
      if (t && t.name !== here.name && t.code !== here.code && t.code !== '---') { wx = { t, ahead: dist, from: here }; break; }
    }
    return { alerts, wx };
  }
  const aheadText = (a) => {
    if (!a) return '';
    const mi = (m) => (m < 0.15 * MI ? 'just ahead' : `${(m / MI).toFixed(1)} mi ahead`);
    const lines = [];
    const word = { closure: '✕ CLOSED', collision: '! CRASH', work: '△ WORK', other: '△ ALERT' };
    if (a.alerts.length) {
      const x = a.alerts[0];
      lines.push(`ROUTE AHEAD: ${word[x.r.kind] || '△'} ${x.r.roadLabel || x.r.road || ''}${x.r.milepost ? ' MP ' + x.r.milepost : ''} · ${mi(x.ahead).toUpperCase()}` +
        (a.alerts.length > 1 ? ` · +${a.alerts.length - 1} MORE` : ''));
    } else lines.push('ROUTE AHEAD: NO ROAD ALERTS');
    if (a.wx) lines.push(`WEATHER AHEAD: ${a.wx.t.code} AT ${a.wx.t.name.toUpperCase()} (${a.wx.t.temp}°) · ${mi(a.wx.ahead).toUpperCase()} · NOW ${a.wx.from.code}`);
    return lines.join('\n');
  };

  // ---- riding a bus: with your location on (the ◎ button), you're on a bus when YOU are moving at bus speed, in
  // the same direction as a moving bus, close to it, for about 20 s straight (8 checks). Just being near one (at a
  // stop, walking past, driving beside it for a moment) doesn't count. Then the map follows it, and it glows
  let ridingId = null;
  const rideHits = {};
  let rideMiss = 0;
  const myTrack = []; // my recent positions, for my own speed and direction (the phone's own speed is often missing)
  function myMotion(me) {
    const last = myTrack[myTrack.length - 1];
    if (!last || last.t !== me.t) myTrack.push({ t: me.t, p: [me.lon, me.lat] });
    while (myTrack.length && me.t - myTrack[0].t > 30000) myTrack.shift();
    const old = myTrack.find((x) => me.t - x.t >= 8000); // compare with about 8+ s ago
    if (!old) return null;
    const d = mx(old.p, [me.lon, me.lat]), s = d / ((me.t - old.t) / 1000);
    return { speed: me.speed != null && me.speed >= 0 ? Math.max(me.speed, s * 0.8) : s, heading: d > 25 ? bearing(old.p, [me.lon, me.lat]) : null };
  }
  function checkRiding() {
    const me = window.htMe;
    if (!me || Date.now() - me.t > 20000 || TV) return;
    const p = [me.lon, me.lat], mine = myMotion(me);
    const moving = mine && mine.speed >= 3; // about 7 mph: faster than walking
    let near = null;
    if (moving) for (const mk of markers.values()) {
      const b = mk._bus; if (!b || b._lost || b.mph < 4 || oos(b)) continue;
      const ll = mk.getLngLat();
      const bh = (b._snap ? headingOf(b) : null) ?? b.heading;
      // (its last report is up to 10 s old, 90 m behind at 20 mph: also compare with where it should be by now)
      const run = b.mph * 0.44704 * Math.min(15, (Date.now() - (b._at || Date.now())) / 1000), hr = (bh ?? 0) * Math.PI / 180;
      const ahead = [b.lon + (run * Math.sin(hr)) / 76000, b.lat + (run * Math.cos(hr)) / 111000];
      const d = Math.min(mx(p, [ll.lng, ll.lat]), mx(p, [b.lon, b.lat]), mx(p, ahead));
      const sameWay = mine.heading == null || bh == null || Math.abs(((mine.heading - bh + 540) % 360) - 180) < 50;
      if (sameWay && d < 40 + Math.min(40, me.acc || 0) && (!near || d < near.d)) near = { id: b.id, d };
    }
    for (const k of Object.keys(rideHits)) if (k !== near?.id) rideHits[k] = 0;
    if (near) rideHits[near.id] = (rideHits[near.id] || 0) + 1;
    if (ridingId) {
      // (a bus stopped at a stop with you on it: still riding; you walked off and it left: not)
      const b = markers.get(ridingId)?._bus;
      const still = b && b.mph < 4 && mx(p, [b.lon, b.lat]) < 50;
      if (near?.id === ridingId || still) rideMiss = 0; else if (++rideMiss >= 6) setRiding(null);
    } else if (near && rideHits[near.id] >= 8) setRiding(near.id);
  }
  function setRiding(id) {
    if (ridingId) markers.get(ridingId)?.getElement().classList.remove('riding');
    ridingId = id; rideMiss = 0;
    document.body.classList.toggle('riding-bus', !!id); // (the 3D view hides your dot then: the glowing bus is you)
    if (id) {
      markers.get(id)?.getElement().classList.add('riding');
      if (!follow || follow.id !== id) startFollow(id, null);
    }
    renderFollow();
  }
  setInterval(checkRiding, 2500);

  // the banner's big line: where it is with its stops, or that it's off its route (moving, but not along any
  // of its route's lines: a detour or a shortcut)
  const followStatus = (b) => (!b._snap && b.mph >= 2 ? { word: 'OFF ROUTE', name: 'Detour or shortcut' } : stopStatus(b));
  // following: a see-through banner across the top of the map (under the instruments, clear of + and -), big
  // enough to read at a glance; the bottom bar is only for picking routes
  const followBar = $('#followBar');
  const followTop = () => (follow && followBar && !followBar.hidden ? followBar.offsetTop + followBar.offsetHeight + 8 : 0);
  function renderFollow() {
    if (!followBar) return;
    followBar.hidden = TV || !follow;
    document.body.classList.toggle('following', !!follow && !TV);
    if (!follow) return;
    // desktop: start just right of the column of map buttons (it widens when, say, the radar shows its time)
    const tools = $('.map-tools');
    followBar.style.left = !phone() && tools ? `${Math.round(tools.getBoundingClientRect().right - map.getContainer().getBoundingClientRect().left + 14)}px` : '';
    const b = buses.find((x) => x.id === follow.id);
    const rt = b ? busRoute(b) : follow.route;
    const st = b ? followStatus(b) : null;
    follow.status = st ? st.word + st.name : '';
    const eta = b && follow.stop ? etaTo(b, follow.stop) : null;
    // four parts: the bus (route, number, speed, street) · its stop · the details (due at, route ahead) · buttons.
    // Phones stack them; desktop lays them out in one row (styles.css)
    followBar.innerHTML = `<div class="fb-bus"><span class="bus-no big" style="background:${esc(routeColor(rt))}">${esc(rt)}</span>
        <span class="fb-id">BUS ${esc(follow.id)}<small>${b ? (b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH') : 'LOST SIGNAL'}${follow.street && !(st && follow.street === 'AT ' + st.name.toUpperCase()) ? ` · ${esc(follow.street)}` : ''}</small></span></div>
      <div class="fb-btns">
        <button type="button" data-act="turn" ${chase ? 'hidden' : ''} aria-label="${followUp ? 'Switch to north up' : 'Switch to heading up'}" title="${followUp ? 'Bus faces up: tap for north up' : 'North up: tap so the bus faces up'}">${followUp ? UP_SVG : 'N'}</button>
        <button type="button" data-act="chase" class="${chase ? 'on' : ''}" aria-label="${chase ? 'Leave the chase view' : 'Chase view: ride behind the bus'}">${chase ? '2D' : '3D'}</button>
        <button type="button" data-act="unfollow" aria-label="Stop following">✕</button></div>
      <div class="fb-main">${ridingId === follow.id ? '<div class="fb-ride">◉ YOU\'RE ON THIS BUS</div>' : ''}
        ${st ? `<div class="fb-stop"><span class="fb-word">${st.word}</span>${esc(st.name.toUpperCase())}</div>` : ''}</div>
      <div class="fb-info"><div class="fb-sub">${follow.stop ? `${eta != null ? `~${eta < 1 ? '<1' : eta} MIN TO ` : 'HEADED FOR '}${esc(follow.stop.name.toUpperCase())}`
        : b?.nextStop ? `DUE AT ${esc(b.nextStop.toUpperCase())}${b.nextTime ? ' · ' + tt(b.nextTime) : ''}` : ''}${chase ? '<span class="fb-note">TRAFFIC LIGHTS ARE FOR LOOKS · NOT LIVE</span>' : ''}</div>
      ${follow.ahead ? `<div class="fb-ahead">${follow.ahead.split('\n').map((l) => `<span class="${/^ROUTE AHEAD: NO/.test(l) ? 'ok' : /WEATHER/.test(l) ? 'wx' : 'warn'}">${esc(l)}</span>`).join('')}</div>` : ''}</div>`;
  }
  // recheck the route ahead every 10 s while following; redraw the banner only when it changes
  setInterval(() => {
    if (!follow) return;
    const b = buses.find((x) => x.id === follow.id);
    const text = aheadText(routeAhead(b));
    if (text !== follow.ahead) { follow.ahead = text; renderFollow(); }
  }, 10000);
  function renderBar() {
    if (!bar) return;
    markers.forEach((mk) => mk.getElement().classList.toggle('sel', !!mk._bus && (follow ? mk._bus.id === follow.id : busIdx >= 0 && mk._bus.id === routeBuses(picked)[busIdx]?.id)));
    renderFollow();
    bar.hidden = TV || !!follow || !(picked && barOn);
    if (bar.hidden) return;
    // desktop: the route bar also starts just right of the column of map buttons (centered, it could slide
    // over them in a narrow window)
    const tools = $('.map-tools');
    if (!phone() && tools) {
      const left = Math.round(tools.getBoundingClientRect().right - map.getContainer().getBoundingClientRect().left + 14);
      Object.assign(bar.style, { left: left + 'px', transform: 'none', width: `min(440px, calc(100% - ${left + 60}px))` });
    } else Object.assign(bar.style, { left: '', transform: '', width: '' });
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
  const onBarClick = (e) => {
    const act = e.target.closest('button')?.dataset.act; if (!act) return;
    const rs = allRoutes(), list = routeBuses(picked);
    if (act === 'close') { stopFollow(); pickRoute(null); }
    else if (act === 'unfollow') stopFollow();
    else if (act === 'chase') { setChase(!chase); store.set('ht.follow3d', chase); } // (remembered: following starts that way next time)
    else if (act === 'turn') { followUp = !followUp; store.set('ht.followUp', followUp); renderBar(); keepFollowing(true); }
    else if (act === 'prevRoute' || act === 'nextRoute') {
      const i = rs.indexOf(picked), n = rs.length;
      pickRoute(rs[(i + (act === 'nextRoute' ? 1 : n - 1)) % n], { fit: true });
    } else if ((act === 'prevBus' || act === 'nextBus') && list.length) {
      busIdx = busIdx < 0 ? (act === 'nextBus' ? 0 : list.length - 1) : (busIdx + (act === 'nextBus' ? 1 : list.length - 1)) % list.length;
      showBus(list[busIdx]); renderBar();
    } else if (act === 'follow' && list[busIdx]) startFollow(list[busIdx].id, null);
  };
  bar?.addEventListener('click', onBarClick);
  followBar?.addEventListener('click', onBarClick);

  // following: the map keeps the bus in view until you drag the map or press ✕. Like a car GPS, the map turns
  // so the bus points up (the road ahead fills the screen); the N button switches to north-up.
  let follow = null; // { id, route, stop: { id, name, at } | null, up: true for heading-up }
  window.htBusFollowing = () => !!follow; // (compass mode follows you, except while you follow a bus)
  let followUp = store.get('ht.followUp') !== false;
  function startFollow(id, stop) {
    const b = buses.find((x) => x.id === id); if (!b) return;
    follow = { id, route: busRoute(b), stop };
    follow.ahead = aheadText(routeAhead(b));
    // switching buses in chase view: the old one becomes an "other bus" sprite and the new one the chase sprite
    if (chase) for (const m of markers.values()) if (m._bus) { m._c3 = null; drawBus(m); }
    document.querySelectorAll('.maplibregl-popup').forEach((p) => p.remove());
    pickRoute(busRoute(b), { force: true });
    renderBar();
    // following starts in the 3D view unless you've picked 2D before (remembered on this device)
    if (!chase && !TV && store.get('ht.follow3d') !== false) setChase(true);
    else keepFollowing(true);
  }
  function stopFollow() {
    if (!follow) return;
    // back to north-up (and flat) for the rest of the map, in one camera move so neither cancels the other
    if (chase) setChase(false, true);
    else map.easeTo({ bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    follow = null;
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
  let chase = false, chaseBrg = 0, radarWas = null;
  const CHASE_PITCH = 58, CHASE_ZOOM = 17;
  function setChase(v, northUp) {
    if (v === chase || (v && !follow)) return;
    chase = v;
    document.body.classList.toggle('chase', v);
    const mk = follow && markers.get(follow.id);
    // the camera rides with the bus, so dragging is off in chase view (on a phone, a pinch counts as a drag, and a
    // drag ends following); pinching to zoom still works
    if (!TV) v ? map.dragPan.disable() : map.dragPan.enable();
    // keep the phone cool: the tilted view looks far down the road, so it draws a lot more map. While chasing,
    // draw at a lower resolution and leave out the contour lines and hill shading (computed on the phone itself
    // from elevation tiles), then put both back after
    // (parks too: the chase view keeps to the road)
    for (const id of ['hillshade', 'contours', 'contour-label', 'park-fill', 'park-edge', 'park-area-edge', 'park-names', 'park-area-names'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'none' : 'visible');
    // the radar overlay too, if it's on (put back the way it was)
    if (map.getLayer('radar')) {
      if (v) { radarWas = map.getLayoutProperty('radar', 'visibility'); map.setLayoutProperty('radar', 'visibility', 'none'); }
      else if (radarWas) map.setLayoutProperty('radar', 'visibility', radarWas);
    }
    // resolution: at most 1.5×, and fewer pixels on a big screen (about 1.2 million drawn per frame at most),
    // which is what makes a large desktop window struggle
    const box = map.getContainer();
    map.setPixelRatio(v ? Math.max(0.6, Math.min(devicePixelRatio, 1.5, Math.sqrt(0.9e6 / Math.max(1, box.clientWidth * box.clientHeight)))) : devicePixelRatio);
    padCache = null;
    if (v) {
      if (phone() && !$('#panel').classList.contains('gone')) $('#panel').classList.add('min'); // more road on screen
      map.setMaxZoom(18);
      chaseBrg = (mk && headingOf(mk._bus)) ?? map.getBearing();
      map.easeTo({ center: mk ? mk.getLngLat() : map.getCenter(), zoom: CHASE_ZOOM, pitch: CHASE_PITCH, bearing: chaseBrg,
        padding: chasePad(), duration: 1400 });
    } else {
      // still following (flat view next): settle where the flat follow keeps the bus; done following: no padding
      const pad = northUp ? { top: 0, bottom: 0, left: 0, right: 0 } : chasePad();
      map.easeTo({ pitch: 0, zoom: Math.min(map.getZoom(), 15.5), padding: pad,
        ...(northUp ? { bearing: 0 } : followUp ? {} : { bearing: 0 }), duration: 800 });
      map.once('moveend', () => { if (!chase) map.setMaxZoom(16); });
    }
    // every bus changes look: the chased one to its sprite, the others to theirs (or back to map icons)
    for (const m of markers.values()) if (m._bus) { m._c3 = null; drawBus(m); }
    if (v) headlights(); else setChaseFog(null);
    renderBar();
    updateSignals();
  }
  setInterval(() => { if (chase) headlights(); }, 60000);
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
  // turn signals: looking up to 100 m ahead along its route line, a bend of more than 55° within that stretch is a
  // turn coming up, and the chased bus blinks that side (gentle highway curves don't count)
  function turnAhead(b) {
    if (!b?._snap) return null;
    const sh = b._snap.sh, s = b._along ?? b._obs ?? 0;
    const now = bearing(along(sh, s), along(sh, s + 20));
    for (let d = 20; d <= 100; d += 10) {
      const later = bearing(along(sh, s + d), along(sh, s + d + 20));
      const turn = ((later - now + 540) % 360) - 180; // + right, - left
      if (Math.abs(turn) > 55) return turn > 0 ? 'r' : 'l';
    }
    return null;
  }
  function signalTurn() {
    if (!chase || !follow) return;
    const mk = markers.get(follow.id); if (!mk) return;
    const side = mk._rolling || mk._bus.mph >= 2 ? turnAhead(mk._bus) : null;
    const el = mk.getElement();
    el.classList.toggle('turn-l', side === 'l');
    el.classList.toggle('turn-r', side === 'r');
  }
  // the tilted view looks far up the road: things on screen within 2 km of the bus, plus anything right around it
  let viewBounds = null, viewAt = 0;
  function inChaseView(here, p) {
    const d = mx(here, p);
    if (d < 250) return true;
    if (d > 2000) return false;
    if (!viewBounds || Date.now() - viewAt > 500) { viewBounds = map.getBounds(); viewAt = Date.now(); }
    return viewBounds.contains(p);
  }
  async function updateSignals() {
    if (!chase || !follow) { sigMarkers.forEach((m) => m.remove()); sigMarkers.clear(); updateStopSigns(null); return; }
    if (!signals) { try { signals = (await (await fetch('data/signals.json')).json()).signals || []; } catch { signals = []; } clusterSignals(); }
    const mk = markers.get(follow.id); if (!mk) return;
    const at = mk.getLngLat(), here = [at.lng, at.lat], now = Date.now();
    const near = new Set();
    // the nearest 15 in view at most
    const pick = [];
    signals.forEach((p, i) => { if (inChaseView(here, p)) pick.push([mx(here, p), i]); });
    pick.sort((a, b) => a[0] - b[0]);
    pick.slice(0, 15).forEach(([, i]) => {
      const p = signals[i];
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
    updateStopSigns(here);
  }

  // bus stops near the chased bus as little pixel signs on poles: the stops on its route get their name, the
  // other routes' stops stay small and dim, and its next stop glows
  const stopSigns = new Map();
  const STOP_SVG = `<svg viewBox="0 0 10 24" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="4" y="8" width="2" height="16" fill="#3b4b49"/><rect x="0" y="0" width="10" height="9" fill="#020807"/>
    <rect x="1" y="1" width="8" height="7" style="fill:var(--sc)"/>
    <rect x="3" y="2" width="4" height="4" fill="#020807"/><rect x="3" y="3" width="4" height="1" style="fill:var(--sc)"/>
    <rect x="3" y="6" width="1" height="1" fill="#020807"/><rect x="6" y="6" width="1" height="1" fill="#020807"/></svg>`;
  function updateStopSigns(here) {
    if (!chase || !follow || !here || !stopsGeo) { stopSigns.forEach((m) => m.remove()); stopSigns.clear(); return; }
    const b = markers.get(follow.id)?._bus, rt = b ? busRoute(b) : follow.route;
    const next = b ? nextStopOf(b) : null, color = routeColor(rt);
    const near = new Set();
    // only the next 4 stops ahead of the bus on its route get a sign (with its name); a stop's twin across the
    // street (same name, a few meters away) is one sign: the one nearest the bus's line
    const s0 = b?._along ?? b?._obs ?? 0;
    const all = b?._snap ? lineStops(b._snap.sh, rt) : [];
    const ahead = all.filter((s) => s.d > s0 - 10).slice(0, 4).map((s) => s.name);
    // plus the stop it just passed, dimmed, until it's well behind (off the bottom of the screen)
    let passed = null;
    for (const s of all) { if (s.d <= s0 - 10) passed = s; else break; }
    if (passed && s0 - passed.d > 300) passed = null;
    const line = b?._snap?.sh;
    const pick = [];
    for (const name of [...ahead, ...(passed && !ahead.includes(passed.name) ? [passed.name] : [])]) {
      let best = null;
      for (const f of stopsGeo.features) {
        if (f.properties.name !== name || !serves(String(f.properties.routes || '').split(' '), rt)) continue;
        const p = f.geometry.coordinates;
        const d = line ? Math.min(...line.c.map((c) => mx(p, c))) : mx(here, p);
        if (!best || d < best[0]) best = [d, f];
      }
      if (best && !pick.includes(best[1])) pick.push(best[1]);
    }
    for (const f of pick) {
      const p = f.geometry.coordinates;
      const id = f.properties.id;
      near.add(id);
      let m = stopSigns.get(id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'stop-sign';
        el.innerHTML = `${STOP_SVG}<span>${esc(String(f.properties.name).toUpperCase())}</span>`;
        m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p).addTo(map);
        stopSigns.set(id, m);
      }
      const el = m.getElement(), mine = serves(String(f.properties.routes || '').split(' '), rt);
      el.classList.toggle('mine', mine);
      el.classList.toggle('next', mine && f.properties.name === next);
      el.classList.toggle('named', mine);
      el.classList.toggle('past', !!passed && f.properties.name === passed.name && !ahead.includes(passed.name));
      el.style.setProperty('--sc', mine ? color : '#5f9c8b');
    }
    for (const [id, m] of stopSigns) if (!near.has(id)) { m.remove(); stopSigns.delete(id); }
    // and no two name tags on top of each other: the next stop first, then nearest first; a tag that would
    // overlap one already shown waits until there's room
    const tags = [...stopSigns.values()].map((m) => m.getElement()).filter((el) => el.classList.contains('named'));
    tags.forEach((el) => el.classList.remove('quiet'));
    const order = tags.map((el) => ({ el, r: el.querySelector('span').getBoundingClientRect() }))
      .sort((a, b) => (b.el.classList.contains('next') - a.el.classList.contains('next')) ||
        (a.el.classList.contains('past') - b.el.classList.contains('past')) || (b.r.bottom - a.r.bottom)); // (the passed stop gives way)
    const placed = [];
    for (const { el, r } of order) {
      if (placed.some((p) => r.left < p.right + 4 && p.left < r.right + 4 && r.top < p.bottom + 2 && p.top < r.bottom + 2)) el.classList.add('quiet');
      else placed.push(r);
    }
  }
  setInterval(updateSignals, 1000);
  // Where the bus sits on screen while following: in the part of the map you can see (below the follow banner,
  // above the sheet), a share of the way down it: the middle when north-up, lower when it faces up or in chase
  // view, so more of the road ahead shows. Done with map padding, so the bus stays exactly there.
  // (measured twice a second, not every frame: measuring the page every frame makes the browser redo its layout)
  let padCache = null, padAt = 0;
  const followShare = () => (chase ? 0.65 : followUp ? 0.6 : 0.5);
  const chasePad = () => {
    if (!padCache || Date.now() - padAt > 500) {
      const top = followTop(), seen = map.getContainer().clientHeight - covered() - top;
      padCache = { top: Math.max(0, top + (2 * followShare() - 1) * seen), bottom: covered(), left: 0, right: 0 };
      padAt = Date.now();
    }
    return padCache;
  };
  // every frame while following (flat or chase view): stay locked on the bus and turn smoothly with the road
  // (heading-up and chase), or keep north up
  function chaseCamera(dt) {
    if (!follow || map.isEasing()) return;
    const mk = markers.get(follow.id); if (!mk) return;
    const h = chase || followUp ? headingOf(mk._bus) : 0;
    if (h != null) chaseBrg += (((h - chaseBrg + 540) % 360) - 180) * Math.min(1, dt * 2);
    map.jumpTo({ center: mk.getLngLat(), bearing: chaseBrg, padding: chasePad() });
  }
  // when not following, the map is always flat and unpadded: if a pinch interrupted the camera on its way back,
  // straighten it once the map settles
  map.on('moveend', () => {
    if (chase || follow || map.isEasing()) return;
    const p = map.getPadding();
    if (map.getPitch() > 0.5 || p.top || p.bottom) {
      map.easeTo({ pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 400 });
      if (map.getMaxZoom() > 16) map.once('moveend', () => { if (!chase) map.setMaxZoom(16); });
    }
  });
  // zooming all the way in while following starts it; zooming well out ends it
  map.on('zoomend', (e) => {
    if (follow && !chase && e.originalEvent && map.getZoom() >= 15.95) setChase(true);
    else if (chase && e.originalEvent && map.getZoom() < 15) setChase(false);
  });
  // starting to follow (or switching north-up / heading-up): glide over to the bus; from then on chaseCamera()
  // keeps it locked in place every frame
  function keepFollowing(now) {
    if (!follow || chase || !now) return;
    const mk = markers.get(follow.id); if (!mk) return;
    const h = followUp ? headingOf(mk._bus) : 0;
    chaseBrg = h ?? map.getBearing();
    padCache = null;
    map.easeTo({ center: mk.getLngLat(), zoom: Math.max(map.getZoom(), 15.5), bearing: chaseBrg, padding: chasePad(), duration: 900 });
  }

  // ---- estimated positions between GPS reports ----
  // Each report gives position, heading and speed. Between reports (20 s apart), each moving bus is slid along
  // its route line at its last speed, four times a second, for a little while. A stopped bus stays put.
  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * 0.68, b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  // a bus counts as on its route line within 60 m of it (radius). Farther than that it's on a detour or a
  // shortcut, and is drawn going its own way (its GPS heading) until it's back.
  function snap(b, routeNo, radius = 60) {
    let best = null;
    for (const sh of shapesByRoute[routeNo] || []) {
      for (let i = 0; i < sh.c.length - 1; i++) {
        const dist = mx([b.lon, b.lat], sh.c[i]);
        if (dist > radius || (best && dist >= best.dist)) continue;
        if (diff(bearing(sh.c[i], sh.c[i + 1]), b.heading || 0) > 90) continue; // going the right way along it
        best = { sh, i, dist };
      }
    }
    return best;
  }
  // the point a given distance along a line
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
    const dirHere = i0 < main.c.length - 1 ? bearing(main.c[i0], main.c[i0 + 1]) : null;
    for (const r of [rt, rt + 'P']) for (const sh of shapesByRoute[r] || []) {
      if (sh === main) continue;
      const o = onLine(sh, p, null, heading, 40);
      if (!o) continue; // this version doesn't come by here
      // only a version running along this same road the same way counts (not one crossing at an intersection,
      // and not the other side of the street)
      if (mx(main.c[i0], sh.c[o.i]) > 30) continue;
      if (dirHere != null && o.i < sh.c.length - 1 && diff(bearing(sh.c[o.i], sh.c[o.i + 1]), dirHere) > 30) continue;
      // walk both lines forward together until they're more than 25 m apart
      let j = o.i;
      for (let k = i0; k < main.c.length && main.d[k] - main.d[i0] < 4000; k++) {
        while (j < sh.c.length - 1 && mx(main.c[k], sh.c[j + 1]) <= mx(main.c[k], sh.c[j])) j++;
        if (mx(main.c[k], sh.c[j]) > 35) { limit = Math.min(limit, main.d[Math.max(i0, k - 1)]); break; }
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
      if (!b || mk._lostAt) continue; // (a ghost stays where it was last heard)
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
      } else if (b.mph >= 2) {
        // off its route line (heading out to start a route, a detour): carry on straight along its GPS heading
        // for a little while, a bit under its speed
        const m = b.mph * 0.44704 * PACE * Math.min(15, (now - b._at) / 1000), h = (b.heading || 0) * Math.PI / 180;
        pos = [b.lon + (m * Math.sin(h)) / 76000, b.lat + (m * Math.cos(h)) / 111000];
      } else pos = [b.lon, b.lat];
      // a bus that jumped to a new line, or has none, eases over from where it was drawn
      const k = b._from ? Math.min(1, (now - b._at) / BLEND_MS) : 1;
      if (k < 1) { const e = k * k * (3 - 2 * k); pos = [b._from[0] + (pos[0] - b._from[0]) * e, b._from[1] + (pos[1] - b._from[1]) * e]; }
      const ll = mk.getLngLat();
      if (Math.abs(ll.lng - pos[0]) > 1e-7 || Math.abs(ll.lat - pos[1]) > 1e-7) mk.setLngLat(pos);
      // is the drawn bus rolling? (smoothed, so a moment's pause doesn't flicker) Standing still, the chase sprite
      // shows brake lights; after 20 s still it also stops bobbing (parked)
      const speed = dt > 0 ? mx([ll.lng, ll.lat], pos) / dt : 0;
      mk._ds = (mk._ds || 0) * 0.85 + speed * 0.15;
      const rolling = mk._ds > 0.6;
      if (rolling || mk._stillSince == null) mk._stillSince = rolling ? null : now;
      const parked = !rolling && now - mk._stillSince > 20000;
      const el = mk.getElement();
      if (rolling !== mk._rolling) { mk._rolling = rolling; el.classList.toggle('rolling', rolling); }
      if (parked !== mk._parked) { mk._parked = parked; el.classList.toggle('parked', parked); }
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
    // chase view: the other buses face the right way and shrink with distance (measured after the camera moved)
    if (chase) {
      const fm = follow && markers.get(follow.id), nearPx = fm ? pxPerMeter(fm.getLngLat()) : 0;
      // (ghosts too: they don't move, but the camera does, and a ghost left at its old size looked nearer or farther
      // than it was)
      for (const mk of markers.values()) if (mk !== fm && mk._bus) place3d(mk, nearPx, fm?.getLngLat());
    }
    if (t - lastFollow > 250) {
      lastFollow = t; signalTurn();
      // the banner's stop line changes as the bus reaches, stops at and leaves each stop
      if (follow) {
        const mk = markers.get(follow.id), b = mk?._bus, st = b ? followStatus(b) : null;
        // and the street it's on, once a second (keeping the last one through a gap, like an intersection)
        let street = follow.street;
        if (mk && t - (follow.streetAt || 0) > 1000) { follow.streetAt = t; street = streetOf(mk) || follow.street; }
        if ((st ? st.word + st.name : '') !== follow.status || street !== follow.street) { follow.street = street; renderFollow(); }
      }
    }
  }
  requestAnimationFrame(glide);
  // for checking from the browser console
  window.htBusInternals = { markers, shapesByRoute, lineStops: (sh, rt) => lineStops(sh, rt), nextDeparture: (id, rts) => nextDeparture(timesValue, id, rts) };
  // for checking from the browser console: how many moving buses are matched to a route line
  window.htBusDebug = () => { const bs = [...markers.values()].map((m) => m._bus).filter(Boolean);
    return { buses: bs.length, moving: bs.filter((b) => b.mph >= 2).length, onRoute: bs.filter((b) => b.mph >= 2 && b._snap).length, hidden: document.hidden,
      splitAhead: bs.filter((b) => b._snap).map((b) => `${busRoute(b)}/${b.id}: ${Math.round((b._fork ?? 0) - (b._obs ?? 0))} m${turnAhead(b) ? ' turn ' + turnAhead(b) : ''}`) }; };

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
  let timesValue = null; // the same timetable once it's here, for code that can't wait for it
  const loadTimes = () => times ||= fetch('data/bus-times.json').then((x) => x.json()).then((v) => (timesValue = v)).catch(() => null);
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
  // The next scheduled departure from a stop (or from anywhere, stopId null) after now, looking up to a week
  // ahead (weekends and holidays have less or no service): { rt, min, h, days (0 today, 1 tomorrow...), date }
  function nextDeparture(t, stopId, routes) {
    if (!t?.stops) return null;
    const now = new Date(), lists = stopId ? [t.stops[stopId] || []] : Object.values(t.stops);
    for (let k = 0; k < 8; k++) {
      const d = new Date(now); d.setDate(d.getDate() + k);
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const dow = (d.getDay() + 6) % 7, after = k ? -1 : nowMin();
      let best = null;
      for (const list of lists) for (const [rt, min, h, svc] of list) {
        if (min <= after || (best && min >= best.min) || (routes && !routes.includes(rt))) continue;
        const s = t.svc[svc];
        if (s && s.d[dow] === '1' && !(s.x || []).includes(ymd)) best = { rt, min, h, days: k, date: d };
      }
      if (best) return best;
    }
    return null;
  }
  const whenDay = (n) => n.days === 0 ? 'TODAY' : n.days === 1 ? 'TOMORROW' : n.date.toLocaleDateString([], { weekday: 'long' }).toUpperCase();
  // "over for tonight" late in the day or when no buses are out; otherwise just "none left here today"
  const overText = (allBuses) => (new Date().getHours() >= 18 || new Date().getHours() < 4 || !allBuses ? 'SERVICE IS OVER FOR TONIGHT' : 'NO MORE BUSES HERE TODAY');
  const clock = (min) => {
    const h = Math.floor(min / 60) % 24, m = String(min % 60).padStart(2, '0');
    return window.htClock24 ? `${String(h).padStart(2, '0')}:${m}` : `${(h % 12) || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  };
  // the tracker's times ("05:45 PM") in the page's 12/24-hour format
  const tt = (s) => esc(window.htClockText ? window.htClockText(s) : s);
  // the 12/24-hour switch: redraw the bus bits showing times
  window.addEventListener('ht:clock', () => { renderBar(); refreshStop(); render(); });
  const baseRt = (rt) => rt.replace(/P$/, '');

  // live arrivals: buses already on their way here, then buses that will come by on their next trip. Those wait at
  // the end of the line until their scheduled run, so each is matched to the next timetable departure it can make.
  function liveArrivals(stop, sched) {
    const out = [];
    for (const b of buses) {
      if (oos(b) || !serves(stop.routes, busRoute(b))) continue;
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
      const n = rows.length ? null : nextDeparture(t, stop.id, [only]);
      table = rows.length ? rows.map(([rt, min, h]) => `<div class="stop-row">${chip(rt)}<span><b>${clock(min)}</b> → ${esc((t.heads[h] || '').toUpperCase())}</span></div>`).join('')
        : `<div class="m">NO MORE ROUTE ${esc(only)} BUSES HERE TODAY${n ? ` · NEXT ONE ${clock(n.min)} ${whenDay(n)}` : ''}</div>`;
    } else if (!sched.length) {
      // nothing more here today: say so, and when the next bus comes
      const n = nextDeparture(t, stop.id);
      table = `<div class="stop-over">${overText(buses.length)}</div>` + (n ? `<div class="stop-row">${chip(n.rt)}<span>NEXT BUS <b>${clock(n.min)} ${whenDay(n)}</b><br>
        <span class="m">→ ${esc((t.heads[n.h] || '').toUpperCase())}</span></span></div>` : '');
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
    try { map.setFilter('bus-stop-focus', ['==', ['get', 'id'], id]); } catch {} // (the map may still be loading)
    // one route at this stop: bring it up too
    const rts = [...new Set(stopFocus.routes.map((r) => r.replace(/P$/, '')))];
    if (rts.length === 1) pickRoute(rts[0], { bar: false });
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
    if (row) { pickRoute(row.dataset.route, { bar: false }); return; }
    // a route in the panel's transit list: bring it up and show the whole route
    const li = e.target.closest('#busBox li[data-route]');
    if (li) { pickRoute(li.dataset.route, { fit: true, force: true, bar: true }); if (phone() && !$('#panel').classList.contains('gone')) $('#panel').classList.add('min'); }
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
    <rect class="tl" x="4" y="15" width="3" height="2"/><rect class="tl" x="17" y="15" width="3" height="2"/>
    <rect class="ts ts-l" x="4" y="17" width="2" height="1.5"/><rect class="ts ts-r" x="18" y="17" width="2" height="1.5"/>
    <rect x="9" y="15" width="6" height="2" fill="#020807" opacity=".6"/>
    <rect x="3" y="19" width="18" height="2" fill="#2b3b39"/>
    <rect x="4" y="21" width="4" height="2" fill="#000"/><rect x="16" y="21" width="4" height="2" fill="#000"/></svg>`;
  // ---- the other buses in chase view: pixel sprites seen from whichever way each faces compared with the camera
  // (from behind, behind diagonal, side, front diagonal, front; the in-between ones mirrored for the other side),
  // sized by how far away each is. Approved on the sprite sheet (notes/bus-sprites.html).
  const DK = '#020807', GL = '#0b2b2a', GT = '#bff4ff', TRIM = '#2b3b39';
  let mirrorText = false; // (while drawing a mirrored sprite: its route number still reads the right way)
  const sign = (x, y, w, rt, fs = 3.6) => `<rect x="${x}" y="${y}" width="${w}" height="${fs + 0.4}" fill="${DK}"/>
    <text x="${x + w / 2}" y="${y + fs - 0.2}" ${mirrorText ? `transform="translate(${2 * (x + w / 2)} 0) scale(-1 1)"` : ''} text-anchor="middle"
      font-family="Share Tech Mono, monospace" font-size="${fs}" fill="#ffc400">${esc(rt)}</text>`;
  // the diagonal views: a face (back or front) on the left, its side going away to the right, a little smaller as it goes
  const diagBody = (c) => `<polygon points="2,21 15,23 34,20 34,22 15,25 2,24" fill="rgba(0,0,0,.45)"/>
    <polygon points="3,1 15,1 33,3.5 33,5 15,3 3,3" fill="${c}" opacity=".55"/>
    <polygon points="15,3 34,5 34,19.5 15,21.5" fill="${DK}"/><polygon points="15.5,4 33,6 33,18.5 15.5,20.5" fill="${c}"/>
    <polygon points="15.5,4 33,6 33,18.5 15.5,20.5" fill="#000" opacity=".28"/>`;
  const diagWheels = `<polygon points="15.5,17.5 33,16.3 33,18.5 15.5,20.5" fill="${TRIM}"/>`;
  const diagFeet = `<rect x="2" y="19" width="13" height="2" fill="${TRIM}"/><rect x="3" y="21" width="3.5" height="2" fill="#000"/><rect x="11" y="21" width="3.5" height="2" fill="#000"/>
    <polygon points="18,19.6 22,19.2 22,22.8 18,23.2" fill="#000"/><polygon points="27.5,18.4 31,18.1 31,21.4 27.5,21.7" fill="#000"/>`;
  const VIEWS = {
    rear: { w: 24, h: 25, svg: (c, rt) => spriteSvg(c, rt).replace(/^<svg[^>]*>|<\/svg>$/g, '') },
    front: { w: 24, h: 25, svg: (c, rt) => `<rect x="2" y="22" width="20" height="3" fill="rgba(0,0,0,.5)"/>
      <rect x="4" y="0" width="16" height="3" fill="${c}" opacity=".55"/>
      <rect x="0.5" y="5" width="2.5" height="1" fill="${DK}"/><rect x="0.5" y="5" width="1.5" height="4" fill="${DK}"/>
      <rect x="21" y="5" width="2.5" height="1" fill="${DK}"/><rect x="22" y="5" width="1.5" height="4" fill="${DK}"/>
      <rect x="3" y="2" width="18" height="18" fill="${DK}"/><rect x="4" y="3" width="16" height="16" fill="${c}"/>
      ${sign(5, 3.6, 14, rt, 3.2)}
      <rect x="5" y="8" width="14" height="7" fill="${GL}"/><rect x="11.5" y="8" width="1" height="7" fill="${DK}" opacity=".7"/>
      <rect x="6" y="9" width="3" height="1" fill="${GT}" opacity=".7"/><rect x="6" y="10" width="1" height="2" fill="${GT}" opacity=".7"/>
      <rect class="hl" x="4" y="16" width="3" height="2"/><rect class="hl" x="17" y="16" width="3" height="2"/>
      <rect x="9" y="16" width="6" height="2" fill="${DK}" opacity=".6"/>
      <rect x="3" y="19" width="18" height="2" fill="${TRIM}"/>
      <rect x="4" y="21" width="4" height="2" fill="#000"/><rect x="16" y="21" width="4" height="2" fill="#000"/>` },
    side: { w: 44, h: 21, svg: (c, rt) => `<rect x="3" y="18" width="38" height="3" fill="rgba(0,0,0,.5)"/>
      <rect x="4" y="0" width="37" height="2" fill="${c}" opacity=".55"/>
      <rect x="2" y="1" width="40" height="16" fill="${DK}"/><rect x="3" y="2" width="38" height="13" fill="${c}"/>
      <rect x="3" y="3" width="3" height="7" fill="${GL}"/><rect x="3" y="3" width="1" height="2" fill="${GT}" opacity=".6"/>
      <rect x="7" y="3" width="4" height="12" fill="${DK}"/><rect x="7.5" y="3.5" width="1.5" height="6" fill="${GL}"/><rect x="9.5" y="3.5" width="1.5" height="6" fill="${GL}"/>
      <rect x="7.5" y="10" width="1.5" height="4.5" fill="${GL}" opacity=".75"/><rect x="9.5" y="10" width="1.5" height="4.5" fill="${GL}" opacity=".75"/>
      ${[12, 17.5, 23, 28.5, 34].map((x) => `<rect x="${x}" y="3.5" width="4.5" height="5" fill="${GL}"/><rect x="${x + 0.5}" y="4" width="1.5" height="1" fill="${GT}" opacity=".55"/>`).join('')}
      ${sign(20, 10.2, 8, rt, 3.4)}
      <rect class="hl" x="2" y="11" width="1" height="2"/><rect class="tl" x="41" y="11" width="1" height="2"/>
      <rect x="3" y="14" width="38" height="2" fill="${TRIM}"/>
      <rect x="13" y="14.5" width="6" height="4.5" fill="#000"/><rect x="14.5" y="15.5" width="3" height="2" fill="${TRIM}"/>
      <rect x="31" y="14.5" width="6" height="4.5" fill="#000"/><rect x="32.5" y="15.5" width="3" height="2" fill="${TRIM}"/>` },
    rearDiag: { w: 36, h: 25, svg: (c, rt) => `${diagBody(c)}
      <polygon points="16.5,7 32,8.7 32,12.4 16.5,11.7" fill="${GL}"/>
      ${[20, 24, 28].map((x) => `<rect x="${x}" y="${7 + (x - 16.5) * 0.11}" width=".8" height="4.8" fill="${DK}" opacity=".8"/>`).join('')}
      <polygon points="29.5,9 31.8,9.2 31.8,17.2 29.5,17.6" fill="${DK}" opacity=".7"/>${diagWheels}
      <rect x="2" y="3" width="13" height="18" fill="${DK}"/><rect x="3" y="4" width="12" height="16" fill="${c}"/>
      ${sign(4, 4.6, 10, rt, 3.2)}
      <rect x="4" y="9" width="10" height="5" fill="${GL}"/><rect x="5" y="10" width="2" height="1" fill="${GT}" opacity=".7"/>
      <rect class="tl" x="3" y="15" width="2.5" height="2"/><rect class="tl" x="12.5" y="15" width="2.5" height="2"/>${diagFeet}` },
    frontDiag: { w: 36, h: 25, svg: (c, rt) => `${diagBody(c)}
      <polygon points="16,5.2 19,5.5 19,18 16,18.4" fill="${DK}"/>
      <polygon points="16.5,6 18.5,6.2 18.5,11.4 16.5,11.3" fill="${GL}"/><polygon points="16.5,12 18.5,12 18.5,17.4 16.5,17.6" fill="${GL}" opacity=".75"/>
      <polygon points="20,7.4 32,8.7 32,12.4 20,12" fill="${GL}"/>
      ${[23.5, 27.5].map((x) => `<rect x="${x}" y="${7.3 + (x - 20) * 0.11}" width=".8" height="4.7" fill="${DK}" opacity=".8"/>`).join('')}
      <rect class="tl" x="32.5" y="13" width=".8" height="1.8"/>${diagWheels}
      <rect x="0" y="5" width="2.5" height="1" fill="${DK}"/><rect x="0" y="5" width="1.5" height="4" fill="${DK}"/>
      <rect x="2" y="3" width="13" height="18" fill="${DK}"/><rect x="3" y="4" width="12" height="16" fill="${c}"/>
      ${sign(4, 4.4, 10, rt, 3)}
      <rect x="4" y="8.5" width="10" height="6.5" fill="${GL}"/><rect x="8.6" y="8.5" width=".8" height="6.5" fill="${DK}" opacity=".7"/>
      <rect x="5" y="9.5" width="2" height="1" fill="${GT}" opacity=".7"/>
      <rect class="hl" x="3" y="16" width="2.5" height="2"/><rect class="hl" x="12.5" y="16" width="2.5" height="2"/>
      <rect x="7" y="16" width="4" height="2" fill="${DK}" opacity=".6"/>${diagFeet}` }
  };
  // which view for a bus heading `rel` degrees clockwise of the way the camera looks, and whether it's mirrored
  function viewFor(rel) {
    rel = ((rel % 360) + 540) % 360 - 180;
    const a = Math.abs(rel), right = rel > 0;
    if (a < 22.5) return ['rear', false];
    if (a < 67.5) return ['rearDiag', !right];
    if (a < 112.5) return ['side', right];
    if (a < 157.5) return ['frontDiag', right];
    return ['front', false];
  }
  const viewSvg = (view, mirror, c, rt) => {
    const v = VIEWS[view];
    mirrorText = mirror;
    return `<svg viewBox="0 0 ${v.w} ${v.h}" shape-rendering="crispEdges" aria-hidden="true"${mirror ? ' style="transform:scaleX(-1)"' : ''}>${v.svg(c, rt)}</svg>`;
  };
  // how many screen pixels a meter of road is (side to side) at a spot: the tilted camera makes far spots smaller
  function pxPerMeter(ll) {
    const t = (map.getBearing() + 90) * Math.PI / 180;
    const a = map.project(ll), b = map.project([ll.lng + 10 * Math.sin(t) / 76000, ll.lat + 10 * Math.cos(t) / 111000]);
    return Math.hypot(b.x - a.x, b.y - a.y) / 10;
  }
  const CHASE_H = 69; // the followed bus's sprite height (styles.css), the size of a bus right where it is
  // every frame in chase view: each other bus's view and size (far ones under 14 px tall aren't drawn: just specks)
  function place3d(mk, nearPx, nearLL) {
    const el = mk.getElement(), b = mk._bus, box = el.querySelector('.s3');
    if (!box || !nearPx) return;
    // only buses on screen and within 2 km of the chased one (like the signals): past the top of the tilted view,
    // perspective sizes stop meaning anything
    const ll = mk.getLngLat(), p = map.project(ll), c = map.getContainer();
    if (ll.distanceTo(nearLL) > 2000 || p.y < -10 || p.x < -80 || p.x > c.clientWidth + 80) {
      if (mk._far !== true) { mk._far = true; el.classList.add('far'); }
      return;
    }
    const h = (b._snap ? headingOf(b) : null) ?? mk._h3 ?? b.heading ?? 0;
    mk._h3 = h;
    const [view, mirror] = viewFor(h - map.getBearing());
    const r = routes[b.route] || {}, key = `${view}${mirror ? '-m' : ''}`;
    if (key !== mk._view) { mk._view = key; box.innerHTML = viewSvg(view, mirror, r.color || '#bff4ff', short(r.name)); }
    const px = Math.min(CHASE_H * 1.6, CHASE_H * pxPerMeter(ll) / nearPx), v = VIEWS[view];
    const far = !(px >= 14);
    if (far !== mk._far) { mk._far = far; el.classList.toggle('far', far); }
    if (far || Math.abs(px - (mk._px || 0)) < 0.5) return;
    mk._px = px;
    el.style.zIndex = String(Math.round(px)); // nearer (bigger) buses in front of farther ones and of the chased bus
    box.style.height = `${px.toFixed(1)}px`; box.style.width = `${(px * v.w / v.h).toFixed(1)}px`;
    el.classList.toggle('tagged', px >= 30);
  }
  // headlights on (front views) after sunset, before sunrise, or in rain, showers, drizzle, fog or snow near the bus
  function headlights() {
    const mk = follow && markers.get(follow.id), at = mk ? mk.getLngLat() : map.getCenter();
    const sun = window.htSunTimes?.(new Date(), at.lat, at.lng), now = new Date();
    const dark = sun ? now < sun.rise || now > sun.set : false;
    const town = (window.htTownWx?.() || []).sort((a, b) => Math.hypot(a.lon - at.lng, a.lat - at.lat) - Math.hypot(b.lon - at.lng, b.lat - at.lat))[0];
    const murky = /rain|shower|drizzle|fog|mist|haze|smoke|snow|sleet|thunder/i.test(town?.f || '');
    document.body.classList.toggle('headlights', dark || murky);
    // fog in the 3D view: the road ahead fades into it, closer the worse it is (forecast fog near the bus, or the
    // nearest station seeing under 2 miles)
    const vis = window.htVisMi;
    const foggy = /fog|mist|haze|smoke/i.test(town?.f || '') || (vis != null && vis < 2);
    setChaseFog(chase && foggy ? (vis != null && vis < 0.5 ? 78 : vis != null && vis < 1 ? 64 : 50) : null);
  }
  // (the map's own fog only covers 3D terrain, which this flat map doesn't have, so the fog is the draw-distance
  // fade over the top of the view, grown down toward the bus: the number is how much of the view it covers, in %)
  function setChaseFog(depth) {
    document.body.classList.toggle('chase-fog', depth != null);
    if (depth != null) document.body.style.setProperty('--chase-fog', `${depth}%`);
  }

  // draw a bus marker: the top-down icon pointed along its street, the chase sprite for the bus being chased, or
  // (in chase view) a sprite from whichever side the camera sees it
  function drawBus(mk) {
    const b = mk._bus, r = routes[b.route] || {}, rt = short(r.name), color = r.color || '#bff4ff';
    const el = mk.getElement();
    el.classList.toggle('stopped', b.mph < 2);
    el.classList.toggle('oos', oos(b));
    const chased = chase && follow?.id === b.id;
    el.classList.toggle('chase', chased);
    el.classList.toggle('c3', chase && !chased);
    if (!chase || chased) { el.style.zIndex = ''; el.classList.remove('far', 'tagged'); mk._c3 = null; }
    if (chased) {
      el.innerHTML = `<div class="sprite" style="--c:${esc(color)}">${spriteSvg(color, rt, b.mph < 2)}</div><span class="tag" style="border-color:${esc(color)}">BUS ${esc(b.id)}</span>`;
    } else if (chase) {
      // (the view and size are set every frame by place3d; rebuilt only when the route or service changes)
      const key = `${color}|${rt}|${oos(b)}`;
      if (mk._c3 === key && el.querySelector('.s3')) { el.title = oos(b) ? `Bus ${b.id} · not in service` : `Route ${rt} · bus ${b.id}`; return; }
      mk._c3 = key; mk._view = null; mk._px = null; mk._far = null;
      el.innerHTML = `<div class="s3"></div><b style="color:${esc(color)};border-color:${esc(color)}">${oos(b) ? 'OUT' : esc(rt)}</b>`;
    } else {
      const h = Math.round((b._snap ? headingOf(b) : null) ?? b.heading ?? 0);
      mk._h = h;
      el.innerHTML = `<div class="ic" style="transform:rotate(calc(${h}deg - var(--brg, 0deg)))">${busSvg(color)}</div><b style="color:${esc(color)};border-color:${esc(color)}">${b._lost ? 'NO SIGNAL' : oos(b) ? 'OUT' : esc(rt)}</b>`;
    }
    el.title = b._lost ? `Bus ${b.id} · not transmitting` : oos(b) ? `Bus ${b.id} · not in service` : `Route ${rt} · bus ${b.id}`;
  }

  const coordLine = (lat, lon) => window.htCoordLine?.(lat, lon) || '';
  // ---- ghosts: buses that stopped transmitting ----
  const GHOST_MS = 24 * 3600 * 1000;
  const loadGhosts = () => { try { return JSON.parse(localStorage.getItem('ht.busGhosts') || '{}'); } catch { return {}; } };
  function saveGhost(id, g) {
    try { const all = loadGhosts(); if (g) all[id] = g; else delete all[id]; localStorage.setItem('ht.busGhosts', JSON.stringify(all)); } catch { /* fine without */ }
  }
  // at: when it last reported (its last time in the feed). It's placed at that report's position, not where it was
  // drawn: the map draws buses gliding ahead along their routes, and a page that slept would have one drawn far from
  // where it really was (Oct 6: bus 801 drawn by Walmart at 7:45, really last heard by the depot at 7:57)
  function ghostBus(mk, at) {
    const b = mk._bus; if (!b) return;
    mk._lostAt = at; b._lost = true; b.mph = 0;
    if (b.lat && b.lon) mk.setLngLat([b.lon, b.lat]);
    const r = routes[b.route] || {};
    mk.getElement().classList.add('lost');
    drawBus(mk);
    const when = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase();
    mk.getPopup().setHTML(`<h3>BUS ${esc(b.id)} · NO LONGER IN THE FEED</h3>
      <p>LAST REPORTED ${esc(when)}${r.name ? ' ON ROUTE ' + esc(short(r.name)) : ''}</p>
      <div class="m">THIS IS WHERE IT LAST REPORTED BEFORE DROPPING OUT OF GHT'S TRACKER: TRACKER SWITCHED OFF, NO SIGNAL, OR THE TRACKER STOPPED LISTING IT. SHOWN FOR UP TO A DAY, OR UNTIL IT REPORTS AGAIN.</div>
      ${coordLine(b.lat, b.lon)}`);
    saveGhost(b.id, { id: b.id, route: b.route, lat: b.lat, lon: b.lon, heading: b.heading || 0, at });
  }
  // ...but not a bus that dropped out at a transit center or the depot (or already not in service): that's a run
  // ending and the driver switching off, not a bus gone missing (Oct 7: a crowd of ghosts at Aberdeen station)
  const DEPOT = [-123.8556, 46.9725];
  function signedOff(b) {
    if (!b || b.lat == null) return false;
    if (oos(b)) return true;
    const p = [b.lon, b.lat];
    if (mx(p, DEPOT) < 300) return true;
    return (stopsGeo?.features || []).some((f) => /Transit Center/i.test(f.properties.name || '') && mx(p, f.geometry.coordinates) < 250);
  }
  let ghostsRestored = false, lastRenderAt = 0;
  function restoreGhosts(seen, now) {
    if (ghostsRestored) return;
    ghostsRestored = true;
    for (const g of Object.values(loadGhosts())) {
      if (seen.has(g.id) || markers.has(g.id)) { saveGhost(g.id, null); continue; }
      if (now - g.at > GHOST_MS) { saveGhost(g.id, null); continue; }
      const el = document.createElement('div'); el.className = 'bus-mk';
      const mk = new maplibregl.Marker({ element: el }).setLngLat([g.lon, g.lat]).setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '280px' })).addTo(map);
      mk._bus = { id: g.id, route: g.route, lat: g.lat, lon: g.lon, heading: g.heading, mph: 0 };
      markers.set(g.id, mk);
      ghostBus(mk, g.at);
    }
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
        // tapping a bus brings its route to the top (its popup has FOLLOW; the bar stays closed), with this bus
        // picked in case the bar is opened later
        const theMk = mk;
        el.addEventListener('click', () => {
          const rt = theMk._bus ? busRoute(theMk._bus) : null;
          pickRoute(rt || null, { bar: false });
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
      // off its route last time: it has to come back within 40 m to count as on it again (not just 60), so a
      // bus running along a street next to its route doesn't flicker on and off the line
      const wasOff = prev && prev.route === b.route && !prev._snap && prev.mph >= 2;
      const reach = wasOff ? 40 : 60;
      let sn = null;
      if (mk._sh && prev && prev.route === b.route) {
        const o = onLine(mk._sh, [b.lon, b.lat], mk._s, b.mph >= 2 ? b.heading : null, reach);
        if (o) sn = { sh: mk._sh, i: o.i, dist: o.dist };
      }
      b._snap = sn || snap(b, rt, reach);
      b._obs = b._snap ? b._snap.sh.d[b._snap.i] : undefined;
      b._fork = b._snap ? forkAhead(b, rt) : undefined;
      if (window.htTrace && follow?.id === b.id) window.htTrace.push({ t: Date.now(), same: !!sn, newLine: b._snap?.sh !== mk._sh, obs: Math.round(b._obs), drawn: Math.round(mk._s), mph: Math.round(b.mph) });
      b._along = b._snap && b._snap.sh === mk._sh ? mk._s : b._obs;
      b._at = Date.now();
      mk._bus = b;
      if (mk._lostAt) { mk._lostAt = null; mk.getElement().classList.remove('lost'); saveGhost(b.id, null); } // back on the air
      drawBus(mk);
      const el = mk.getElement();
      mk.getPopup().setHTML(oos(b) ? `<h3>BUS ${esc(b.id)} · NOT IN SERVICE</h3>
        <p>${b.mph < 2 ? 'PARKED' : Math.round(b.mph) + ' MPH'} · LAST ON ROUTE ${esc(short(r.name))}</p>
        <div class="m">GHT'S TRACKER ISN'T LISTING THIS BUS ON A ROUTE RIGHT NOW (PARKED, OR DRIVING TO OR FROM A ROUTE).</div>${coordLine(b.lat, b.lon)}`
        : `<h3>ROUTE ${esc(short(r.name))} · ${esc(long(r.name).toUpperCase())}</h3>
        <p>BUS ${esc(b.id)} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}</p>
        ${b.nextStop ? `<div class="m">NEXT: ${esc(b.nextStop.toUpperCase())}${b.nextTime ? ' · ' + tt(b.nextTime) : ''}</div>` : ''}
        ${TV ? '' : `<button type="button" class="go" data-follow="${esc(b.id)}">FOLLOW THIS BUS</button>`}${coordLine(b.lat, b.lon)}`);
    }
    // a bus that dropped out of the tracker's feed (tracker switched off, or no signal): left faded where it was last
    // heard, saying so, for up to a day, or until it reports again. Remembered on this device, so a reload keeps it
    const now = Date.now();
    restoreGhosts(seen, now);
    // (a page that was asleep for a while, a phone in a pocket, doesn't know where a bus went while it wasn't
    // looking: those are just removed, no ghost)
    const watching = lastRenderAt && now - lastRenderAt < 90000;
    lastRenderAt = now;
    for (const [id, mk] of markers) if (!seen.has(id)) {
      if (!mk._lostAt && watching && !signedOff(mk._bus)) ghostBus(mk, mk._bus?._at || now);
      else if (!mk._lostAt || now - mk._lostAt > GHOST_MS || signedOff(mk._bus)) { mk.remove(); markers.delete(id); saveGhost(id, null); }
    }
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
    // (the TV shows every bus: nobody can zoom in on a TV to pull a group apart)
    if (map.getZoom() >= 16 || TV) return;
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
      const oneRoute = list.every((b) => b.route === list[0].route && !oos(b));
      const color = oneRoute ? (routes[list[0].route]?.color || '#bff4ff') : '#bff4ff';
      const el = document.createElement('div');
      // a pile of parked buses (all stopped, e.g. at a transit center) is drawn faint so it doesn't hog the map
      el.className = 'bus-mk bus-grp' + (list.every((b) => b.mph < 2 || oos(b)) ? ' parked' : '');
      el.innerHTML = `<div class="ic">${busSvg(color)}</div><b class="n">${list.length}</b>`;
      el.title = `${list.length} buses here: click for details`;
      // parked together (a transit center): list them; spread out: zoom in until they separate
      const spreadM = Math.max(...lls.map((a) => Math.max(...lls.map((b) => a.distanceTo(b)))));
      const pop = new maplibregl.Popup({ offset: 14, maxWidth: '300px' }).setHTML(`<h3>${list.length} BUSES HERE</h3>` + list.map((b) => {
        const r = routes[b.route] || {};
        if (b._lost) return `<div class="m bus-row" style="opacity:.55"><span class="bus-no" style="background:#3d5a53">?</span>BUS ${esc(b.id)} · NOT TRANSMITTING</div>`;
        if (oos(b)) return `<div class="m bus-row" style="opacity:.55"><span class="bus-no" style="background:#3d5a53">OUT</span>BUS ${esc(b.id)} · NOT IN SERVICE${b.mph < 2 ? '' : ' · ' + Math.round(b.mph) + ' MPH'}</div>`;
        return `<div class="m bus-row" data-route="${esc(short(r.name))}" style="cursor:pointer"><span class="bus-no" style="background:${esc(r.color || '#bff4ff')}">${esc(short(r.name))}</span>BUS ${esc(b.id)} · ${b.mph < 2 ? 'STOPPED' : Math.round(b.mph) + ' MPH'}${b.nextStop ? ' · NEXT ' + esc(b.nextStop.toUpperCase()) + (b.nextTime ? ' ' + tt(b.nextTime) : '') : ''}</div>`;
      }).join(''));
      const mk = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map);
      // tapping the group brings up its route when every bus in it is on the same route
      el.addEventListener('click', () => { if (oneRoute) pickRoute(short(routes[list[0].route]?.name) || null, { bar: false }); });
      if (spreadM < 60) mk.setPopup(pop);
      else el.addEventListener('click', () => {
        const bb = new maplibregl.LngLatBounds(); lls.forEach((l) => bb.extend(l));
        map.fitBounds(bb, { padding: 90, maxZoom: 16.5, minZoom: Math.min(16.5, map.getZoom() + 1.5) });
      });
      groups.push(mk);
    }
  }
  map.on('zoomend', groupBuses);

  // no buses out: when the first ones come back (from the timetable; it loads the first time it's needed)
  function serviceOverItem() {
    if (!times) { loadTimes().then(() => renderList()); return '<li class="empty">NO BUSES REPORTING RIGHT NOW</li>'; }
    const n = timesValue && nextDeparture(timesValue, null);
    const late = new Date().getHours() >= 18 || new Date().getHours() < 4;
    return `<li class="empty">${late ? 'SERVICE IS OVER FOR TONIGHT' : 'NO BUSES REPORTING RIGHT NOW'}${n ? `<br>FIRST BUSES ${clock(n.min)} ${whenDay(n)}` : ''}</li>`;
  }
  function renderList() {
    const box = $('#busBox');
    if (!box) return;
    const items = [];
    for (const a of siteAlerts?.alerts || []) items.push(`<li class="k-work"><div class="t">🚌 ${a.route ? 'ROUTE ' + esc(a.route) + (a.name ? ' ' + esc(a.name.toUpperCase()) : '') : 'SERVICE ALERT'}</div><div class="m">${esc(a.text)}</div></li>`);
    for (const n of notices) items.push(`<li class="k-work"><div class="t">🚌 ROUTE NOTICE</div><div class="m">${esc(n)}</div></li>`);
    if (!items.length && siteAlerts?.status) items.push(`<li class="empty">${esc(siteAlerts.status.toUpperCase())}</li>`);
    const active = Object.values(routes).filter((r) => r.active);
    const counts = {};
    for (const b of buses) if (!oos(b)) counts[b.route] = (counts[b.route] || 0) + 1;
    // every row brings its route up on the map (and the bar for stepping through its buses)
    box.innerHTML = items.join('') + (active.length ? active.map((r) => `<li class="clickable" data-route="${esc(short(r.name))}" style="border-left-color:${esc(r.color)}">
        <div class="t"><span class="bus-no" style="background:${esc(r.color)}">${esc(short(r.name))}</span> ${esc(long(r.name).toUpperCase())}</div>
        <div class="m">${counts[r.id] || 0} BUS${(counts[r.id] || 0) === 1 ? '' : 'ES'} OUT · TAP TO SHOW</div></li>`).join('')
      : !RELAY ? '<li class="empty">LIVE BUSES NEED THE RELAY</li>' : serviceOverItem());
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
