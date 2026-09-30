(() => {
  const C = window.HT;
  const qs = new URLSearchParams(location.search);
  const TV = qs.has('tv') || qs.get('mode') === 'tv';
  if (TV) document.body.classList.add('tv');

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const townById = Object.fromEntries(C.towns.map((t) => [t.id, t]));
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? fmtTime(d) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const miles = (a, b) => {
    const R = 3958.8, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const roadNum = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  const getJson = async (path) => (await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' })).json();

  const state = { route: TV ? '' : store.get('ht.route') || '', wx: {}, zonesByTown: {}, nws: [], roads: [], roadsUpdated: null, me: null, heading: null };

  // ---------------- colors (kept in sync with styles.css) ----------------
  const K = { bg: '#030807', cyan: '#00e5ff', green: '#39ff88', amber: '#ffc400', orange: '#ff7a1a', red: '#ff2a3d', dim: '#5f9c8b', magenta: '#ff2bd6' };
  const kindColor = { closure: K.red, collision: K.orange, work: K.amber, other: K.dim };

  // ---------------- map ----------------
  const [W, S, E, N] = C.bounds;
  const pad = 0.35;
  const dem = new mlcontour.DemSource({
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium', maxzoom: 12, worker: true
  });
  dem.setupMaplibre(maplibregl);

  const font = (w) => [w === 'b' ? 'Noto Sans Bold' : 'Noto Sans Regular'];
  const up = (f) => ['upcase', ['get', f]];
  const outside = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [
    [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
    [[W, S], [W, N], [E, N], [E, S], [W, S]]
  ] } };
  const empty = { type: 'FeatureCollection', features: [] };
  const zw = (a, b) => ['interpolate', ['linear'], ['zoom'], 7, a, 14, b];
  // zoom curve whose ends depend on a condition (MapLibre wants the zoom curve outermost)
  const zwIf = (cond, [a1, b1], [a2, b2]) => ['interpolate', ['linear'], ['zoom'], 7, ['case', cond, a1, a2], 14, ['case', cond, b1, b2]];
  const mainRoads = ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]];

  const style = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: { type: 'raster-dem', encoding: 'terrarium', tiles: [dem.sharedDemProtocolUrl], maxzoom: 12, tileSize: 256,
        attribution: 'Elevation: Mapzen/AWS Terrain Tiles' },
      contours: { type: 'vector', maxzoom: 15, tiles: [dem.contourProtocolUrl({
        multiplier: 3.28084,
        thresholds: { 8: [500, 2500], 9: [400, 2000], 10: [250, 1000], 11: [200, 1000], 12: [100, 500], 13: [50, 250] },
        elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours'
      })] },
      outside: { type: 'geojson', data: outside },
      flow: { type: 'geojson', data: empty },
      incidents: { type: 'geojson', data: empty }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': K.bg } },
      { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
        paint: { 'fill-color': '#04130e' } },
      { id: 'town', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail']]],
        paint: { 'fill-color': '#0a1b1f' } },
      { id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
        'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#0d3a30',
        'hillshade-accent-color': '#000000', 'hillshade-exaggeration': 0.35 } },
      // wireframe terrain
      { id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours', paint: {
        'line-color': ['match', ['get', 'level'], 1, '#27c48d', '#15694f'],
        'line-opacity': ['match', ['get', 'level'], 1, 0.55, 0.45],
        'line-width': ['match', ['get', 'level'], 1, 0.9, 0.5] } },
      { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 11, filter: ['>', ['get', 'level'], 0],
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ''], 'text-font': font('r'), 'text-size': 9 },
        paint: { 'text-color': '#27c48d', 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#021a24' } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': K.cyan, 'line-opacity': 0.75, 'line-width': zw(0.6, 1.6) } },
      { id: 'coast-glow', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': K.cyan, 'line-opacity': 0.18, 'line-width': zw(3, 8), 'line-blur': 4 } },
      { id: 'river', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 9,
        paint: { 'line-color': '#0a8aa0', 'line-opacity': 0.6, 'line-width': zw(0.4, 1.6) } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
        paint: { 'line-color': '#1d4046', 'line-width': zw(0.4, 2.5) } },
      { id: 'road-sec', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
        filter: ['in', ['get', 'class'], ['literal', ['secondary']]],
        paint: { 'line-color': '#3a6f78', 'line-width': zw(0.6, 3) } },
      { id: 'road-main-glow', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: mainRoads,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#7fe9ff', 'line-opacity': 0.22, 'line-width': zw(5, 16), 'line-blur': 5 } },
      { id: 'road-main', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: mainRoads,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#bff4ff', 'line-width': zw(1.1, 4) } },
      { id: 'route-hl', type: 'line', source: 'omt', 'source-layer': 'transportation_name',
        filter: ['==', ['get', 'ref'], '__none__'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': K.magenta, 'line-opacity': 0.55, 'line-width': zw(7, 18), 'line-blur': 3 } },
      // live I-5 speeds: segments between sensors, each direction offset to its own side
      { id: 'flow-glow', type: 'line', source: 'flow', filter: ['>=', ['get', 'level'], 2],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.5, 'line-width': zw(8, 18), 'line-blur': 5, 'line-offset': zw(2, 6) } },
      { id: 'flow', type: 'line', source: 'flow', layout: { 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-opacity': ['case', ['>=', ['get', 'level'], 2], 1, 0.55],
          'line-width': zwIf(['>=', ['get', 'level'], 2], [3, 7], [1.2, 3]), 'line-offset': zw(2, 6) } },
      // WSDOT alert stretches along the road
      { id: 'inc-glow', type: 'line', source: 'incidents', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.55, 'line-width': zw(10, 24), 'line-blur': 6 } },
      { id: 'inc', type: 'line', source: 'incidents', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': zwIf(['==', ['get', 'kind'], 'closure'], [4, 9], [3, 7]) } },
      { id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': '#000000', 'fill-opacity': 0.6 } },
      { id: 'outside-edge', type: 'line', source: 'outside', paint: { 'line-color': K.cyan, 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [4, 4] } },
      { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 8,
        layout: { 'text-field': up('name'), 'text-font': font('r'), 'text-size': 11, 'text-letter-spacing': 0.25 },
        paint: { 'text-color': '#0bb3cc', 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      { id: 'peaks', type: 'symbol', source: 'omt', 'source-layer': 'mountain_peak', minzoom: 9,
        layout: { 'text-field': ['concat', '△ ', up('name'), '\n', ['to-string', ['get', 'ele_ft']], ' FT'],
          'text-font': font('r'), 'text-size': 10, 'text-anchor': 'top', 'text-letter-spacing': 0.1 },
        paint: { 'text-color': '#27c48d', 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      { id: 'shields', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 8,
        filter: ['in', ['get', 'network'], ['literal', ['us-interstate', 'us-highway', 'us-state']]],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-field': ['get', 'ref'], 'text-font': font('b'),
          'text-size': 11, 'text-rotation-alignment': 'viewport', 'text-letter-spacing': 0.1 },
        paint: { 'text-color': '#000000', 'text-halo-color': '#bff4ff', 'text-halo-width': 3 } },
      { id: 'villages', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 10,
        filter: ['in', ['get', 'class'], ['literal', ['village', 'hamlet', 'suburb', 'neighbourhood']]],
        layout: { 'text-field': up('name'), 'text-font': font('r'), 'text-size': 10, 'text-letter-spacing': 0.15 },
        paint: { 'text-color': '#5f9c8b', 'text-halo-color': K.bg, 'text-halo-width': 1.5 } }
    ]
  };

  const map = new maplibregl.Map({
    container: 'map', style, bounds: C.bounds, fitBoundsOptions: { padding: 30 },
    maxBounds: [W - pad, S - pad, E + pad, N + pad], minZoom: 7, maxZoom: 16,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
    interactive: !TV
  });
  window.htMap = map; // handy from the browser console
  map.on('error', (e) => console.warn('map:', e.error?.message || e));
  if (!TV) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
  const phone = () => matchMedia('(max-width: 760px)').matches;
  // on phones the bottom sheet covers the lower part of the map
  const fitPad = (p) => phone() ? { top: p, left: p, right: p, bottom: Math.round(innerHeight * 0.42) + p } : p;
  const popup = (html) => new maplibregl.Popup({ offset: 16, maxWidth: '320px' }).setHTML(html);

  // coordinate readout, for the look of it
  const readout = () => {
    const c = map.getCenter();
    $('#readout').textContent = `N ${c.lat.toFixed(4)}  W ${Math.abs(c.lng).toFixed(4)}  Z${map.getZoom().toFixed(1)}`;
  };
  map.on('move', readout);

  // data that arrives before the style is ready waits here
  const setSource = (id, data) => {
    const s = map.getSource(id);
    if (s) s.setData(data); else map.once('load', () => map.getSource(id).setData(data));
  };

  // ---------------- regions ----------------
  const regionById = Object.fromEntries(C.regions.map((r) => [r.id, r]));
  let region = regionById[qs.get('region')] ? qs.get('region') : (store.get('ht.region') || 'all');
  if (!regionById[region]) region = 'all';
  const regionBar = $('#regions');
  regionBar.innerHTML = C.regions.map((r) => `<button type="button" data-r="${r.id}">${esc(r.name)}</button>`).join('');
  function showRegion(id, animate = true) {
    region = id;
    const r = regionById[id];
    regionBar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.r === id));
    $('#regionName').textContent = `▸ ${r.name.toUpperCase()}`;
    map.fitBounds(r.bounds || C.bounds, { padding: fitPad(30), duration: animate && !TV ? 700 : 0 });
  }
  regionBar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]'); if (!b) return;
    stopCycle();
    store.set('ht.region', b.dataset.r);
    showRegion(b.dataset.r);
  });
  // TV: ?tv&cycle=30 steps through the regions every 30 seconds
  let cycleTimer = null;
  const stopCycle = () => { clearInterval(cycleTimer); cycleTimer = null; };
  map.once('load', () => {
    showRegion(region, false);
    const secs = +qs.get('cycle');
    if (TV && qs.has('cycle')) {
      const ids = C.regions.map((r) => r.id);
      cycleTimer = setInterval(() => showRegion(ids[(ids.indexOf(region) + 1) % ids.length]), Math.max(10, secs || 30) * 1000);
    }
  });
  window.addEventListener('resize', () => TV && showRegion(region, false));

  // ---------------- weather ----------------
  // short readout codes instead of pictures, like an old nav unit
  const wxCode = (f = '', day = true) => {
    f = f.toLowerCase();
    if (/thunder/.test(f)) return 'TSTM';
    if (/snow|flurr/.test(f)) return 'SNOW';
    if (/sleet|ice|freezing/.test(f)) return 'ICE';
    if (/shower/.test(f)) return 'SHWR';
    if (/rain|drizzle/.test(f)) return 'RAIN';
    if (/fog/.test(f)) return 'FOG';
    if (/haze|smoke/.test(f)) return 'HAZE';
    if (/wind|breezy/.test(f)) return 'WIND';
    if (/partly|mostly sunny|mostly clear/.test(f)) return 'PCLD';
    if (/cloud|overcast/.test(f)) return 'CLDY';
    if (/sunny|clear/.test(f)) return day ? 'SUN' : 'CLR';
    return '---';
  };
  const wxMarkers = {};
  for (const t of C.towns) {
    const el = document.createElement('div');
    el.className = 'wx-mk';
    el.innerHTML = `<span class="n">${esc(t.name)}</span><span class="v">--°</span><span class="e">---</span>`;
    wxMarkers[t.id] = { el, m: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([t.lon, t.lat]).addTo(map) };
  }

  const nws = async (url) => {
    const r = await fetch(url, { headers: { Accept: 'application/geo+json' } });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  };
  async function pool(items, n, fn) {
    const q = items.slice();
    await Promise.all(Array.from({ length: n }, async () => { while (q.length) { const x = q.shift(); try { await fn(x); } catch (e) { console.warn(e); } } }));
  }
  async function loadWeather() {
    const pts = store.get('ht.points') || {};
    await pool(C.towns, 4, async (t) => {
      let p = pts[t.id];
      if (!p) {
        const j = await nws(`https://api.weather.gov/points/${t.lat.toFixed(4)},${t.lon.toFixed(4)}`);
        p = { hourly: j.properties.forecastHourly, zones: [j.properties.forecastZone, j.properties.county, j.properties.fireWeatherZone].filter(Boolean) };
        pts[t.id] = p; store.set('ht.points', pts);
      }
      state.zonesByTown[t.id] = p.zones;
      const h = await nws(p.hourly);
      const now = h.properties.periods[0];
      state.wx[t.id] = { temp: now.temperature, f: now.shortForecast, day: now.isDaytime, wind: `${now.windDirection} ${now.windSpeed}`,
        rain: now.probabilityOfPrecipitation?.value ?? null };
      const mk = wxMarkers[t.id].el;
      mk.querySelector('.e').textContent = wxCode(now.shortForecast, now.isDaytime);
      mk.querySelector('.v').textContent = `${now.temperature}°`;
      mk.title = `${t.name}: ${now.shortForecast}, wind ${now.windDirection} ${now.windSpeed}`;
    });
    renderWeather();
    renderAlerts(); // alerts are matched to towns through the zones found above
  }
  async function loadAlerts() {
    const j = await nws('https://api.weather.gov/alerts/active?area=WA');
    state.nws = j.features.map((f) => f.properties);
    renderAlerts();
  }

  // ---------------- WSDOT alerts (written by the collector) ----------------
  const roadMarkers = [];
  async function loadRoads() {
    try {
      const j = await getJson('data/wsdot-alerts.json');
      state.roads = j.alerts || [];
      state.roadsUpdated = j.updated;
    } catch (e) { console.warn('road data', e); }
    renderRoads();
    renderBridges();
  }
  const kindLabel = { closure: 'CLOSED', collision: 'INCIDENT', work: 'WORK', other: 'INFO' };

  // ---------------- cameras: nothing downloads until someone clicks ----------------
  const CAM_MIN_MS = 2 * 60 * 1000; // at most one fresh image per camera every 2 minutes
  const camLast = {};
  const camById = {};
  function camImg(cam) {
    const now = Date.now();
    if (!camLast[cam.id] || now - camLast[cam.id] >= CAM_MIN_MS) camLast[cam.id] = now;
    // same URL inside the window, so the browser reuses its copy instead of downloading again
    return `${cam.img}${cam.img.includes('?') ? '&' : '?'}t=${camLast[cam.id]}`;
  }
  function camHtml(cam) {
    return `<div class="cam" data-cam="${cam.id}"><img alt="${esc(cam.title)}" src="${esc(camImg(cam))}">
      <div class="m"><span class="age">IMG ${fmtTime(new Date(camLast[cam.id]))}</span>
      <button type="button" class="cam-refresh">REFRESH</button></div></div>`;
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cam-refresh');
    if (!btn) return;
    const box = btn.closest('.cam'), cam = camById[box.dataset.cam];
    const wait = CAM_MIN_MS - (Date.now() - camLast[cam.id]);
    if (wait > 0) { btn.textContent = `WAIT ${Math.ceil(wait / 1000)}S`; setTimeout(() => (btn.textContent = 'REFRESH'), 2500); return; }
    box.querySelector('img').src = camImg(cam);
    box.querySelector('.age').textContent = 'IMG ' + fmtTime(new Date(camLast[cam.id]));
  });
  const camMarkers = [];
  async function loadCameras() {
    try {
      const j = await getJson('data/cameras.json');
      for (const cam of j.cameras || []) {
        camById[cam.id] = cam;
        const el = document.createElement('div');
        el.className = 'cam-mk';
        el.title = cam.title;
        const p = new maplibregl.Popup({ offset: 12, maxWidth: '340px' });
        p.on('open', () => p.setHTML(`<h3>CAM ${esc(cam.title)}</h3>${camHtml(cam)}`));
        camMarkers.push({ el, m: new maplibregl.Marker({ element: el }).setLngLat([cam.lon, cam.lat]).setPopup(p).addTo(map) });
      }
      showByZoom();
      renderBridges();
    } catch (e) { console.warn('cameras', e); }
  }

  // ---------------- roadside weather stations ----------------
  const rwMarkers = [];
  async function loadRoadWeather() {
    try {
      const j = await getJson('data/road-weather.json');
      state.roadWx = j.stations || [];
      rwMarkers.splice(0).forEach((m) => m.remove());
      for (const s of state.roadWx) {
        if (s.temp == null) continue;
        const el = document.createElement('div');
        el.className = 'wx-mk rw-mk';
        el.innerHTML = `<span class="e">RD</span><span class="v">${Math.round(s.temp)}°</span>`;
        el.title = `${s.name}: ${Math.round(s.temp)}°F, wind ${s.dir || ''} ${s.wind ?? '?'} mph (roadside sensor)`;
        rwMarkers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [10, 0] }).setLngLat([s.lon, s.lat]).addTo(map));
      }
      showByZoom();
      renderWeather();
    } catch (e) { console.warn('road weather', e); }
  }

  // ---------------- I-5 live traffic sensors + travel times ----------------
  const flowColor = [K.dim, K.green, K.amber, K.orange, K.red];
  async function loadFlow() {
    try {
      const j = await getJson('data/flow.json');
      // join neighbouring sensors (by milepost, per direction) into colored road segments
      const groups = {};
      for (const [lat, lon, level, mp, dir, road] of j.stations || []) (groups[`${road}|${dir}`] ||= []).push({ lat, lon, level, mp, dir });
      const features = [];
      for (const list of Object.values(groups)) {
        const dec = /^S|^W/.test(list[0].dir); // draw each direction the way traffic moves, so the offset lands on its side
        list.sort((a, b) => dec ? b.mp - a.mp : a.mp - b.mp);
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1], b = list[i];
          if (Math.abs(a.mp - b.mp) > 1.6) continue;
          const level = Math.max(a.level, b.level);
          if (!level) continue;
          features.push({ type: 'Feature', properties: { level, color: flowColor[level] },
            geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } });
        }
      }
      setSource('flow', { type: 'FeatureCollection', features });
    } catch (e) { console.warn('flow', e); }
    try { state.travel = (await getJson('data/travel-times.json')).routes || []; } catch { state.travel = []; }
    renderTravel();
  }
  function renderTravel() {
    const t = state.travel || [];
    $('#travelList').innerHTML = t.length ? t.map((r) => {
      const slow = r.avg && r.now > r.avg * 1.25;
      return `<li class="${slow ? 'k-closure' : ''}"><div class="t">${esc(r.name.replace(/^\w+\s/, '').toUpperCase())} <span class="pill ${slow ? 'bad' : 'ok'}">${r.now} MIN</span></div>
        <div class="m">NORMAL ${r.avg} MIN · ${r.miles} MI</div></li>`;
    }).join('') : '<li class="empty">NO TRAVEL TIMES</li>';
  }

  // ---------------- bridges ----------------
  const bridgeMarkers = {};
  for (const b of C.bridges) {
    const el = document.createElement('div');
    el.className = 'br-mk';
    el.textContent = '▲';
    bridgeMarkers[b.id] = { el, m: new maplibregl.Marker({ element: el }).setLngLat([b.lon, b.lat]).setPopup(popup('')).addTo(map) };
  }
  // zoomed out, the five bridges would bury Aberdeen/Hoquiam, so they share one chip
  const bridgeChip = document.createElement('div');
  bridgeChip.className = 'wx-mk br-chip mk';
  bridgeChip.innerHTML = '<span class="v">▲ BRIDGES</span>';
  bridgeChip.addEventListener('click', () => map.flyTo({ center: [-123.85, 46.975], zoom: 12.5 }));
  new maplibregl.Marker({ element: bridgeChip }).setLngLat([-123.86, 46.935]).addTo(map);
  const hhmm = (d) => d.toTimeString().slice(0, 5);
  const isWeekday = (d) => d.getDay() > 0 && d.getDay() < 6;
  function bridgeStatus(b) {
    const now = new Date();
    const win = isWeekday(now) && b.noOpen.find(([a, z]) => hhmm(now) >= a && hhmm(now) < z);
    const blocked = win ? win[1] : null; // "stays down until" time
    const issues = state.roads.filter((r) =>
      (r.lat && miles({ lat: r.lat, lon: r.lon }, b) < 0.4) ||
      new RegExp(b.name.replace(/ bridge/i, ''), 'i').test(`${r.headline} ${r.description || ''}`));
    return { blocked, issues };
  }

  // markers that only make sense up close
  function showByZoom() {
    const z = map.getZoom();
    camMarkers.forEach(({ el }) => (el.style.display = z >= 10 ? '' : 'none'));
    rwMarkers.forEach((m) => (m.getElement().style.display = z >= 10 ? '' : 'none'));
    bridgeChip.style.display = z >= 11 ? 'none' : '';
    for (const { el } of Object.values(bridgeMarkers)) el.style.display = z >= 11 ? '' : 'none';
    roadMarkers.forEach(({ el, kind }) => (el.style.display = kind === 'closure' || z >= 9.5 ? '' : 'none'));
  }
  map.on('zoomend', showByZoom);

  // ---------------- rendering ----------------
  const corridor = () => C.corridors.find((c) => c.id === state.route);
  const routeZones = () => {
    const c = corridor();
    const towns = c ? c.towns : C.towns.map((t) => t.id);
    return new Set(towns.flatMap((id) => state.zonesByTown[id] || []));
  };
  const townsForZones = (zones) => C.towns.filter((t) => (state.zonesByTown[t.id] || []).some((z) => zones.includes(z)));
  const onRoute = (r) => {
    const c = corridor();
    if (!c) return true;
    return c.roads.some(([ref]) => roadNum(r.road) === ref);
  };

  function renderAlerts() {
    const zones = routeZones();
    const list = state.nws.filter((a) => (a.affectedZones || []).some((z) => zones.has(z)));
    const alertedTowns = new Set(list.flatMap((a) => townsForZones(a.affectedZones || []).map((t) => t.id)));
    for (const [id, { el }] of Object.entries(wxMarkers)) el.classList.toggle('alerted', alertedTowns.has(id));
    $('#nAlerts').textContent = list.length || '';
    $('#alertList').innerHTML = list.length ? list.map((a) => {
      const towns = townsForZones(a.affectedZones || []).map((t) => t.name);
      return `<li class="sev-${esc(a.severity)}"><div class="t">${esc(a.event.toUpperCase())}</div>
        <div class="m">${towns.length ? esc(towns.join(', ')) + ' · ' : ''}UNTIL ${esc(fmtWhen(a.ends || a.expires))}</div>
        ${TV ? '' : `<details><summary class="m">DETAILS</summary><p class="m">${esc(a.description).replace(/\n\n/g, '<br><br>')}</p></details>`}</li>`;
    }).join('') : `<li class="empty">NO WEATHER ALERTS ${corridor() ? 'ON ROUTE' : 'IN REGION'}</li>`;
  }

  const midpoint = (path) => path[Math.floor(path.length / 2)];
  function renderRoads() {
    roadMarkers.splice(0).forEach(({ m }) => m.remove());
    let list = state.roads.filter(onRoute);
    if (state.me) list = list.map((r) => ({ ...r, dist: r.lat ? miles(state.me, r) : null })).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    else list = list.slice().sort((a, b) => ['closure', 'collision', 'work', 'other'].indexOf(a.kind) - ['closure', 'collision', 'work', 'other'].indexOf(b.kind));

    // stretches on the map
    const features = state.roads.filter((r) => Array.isArray(r.path) && r.path.length > 1).map((r) => ({
      type: 'Feature', properties: { kind: r.kind, color: kindColor[r.kind] || K.dim },
      geometry: { type: 'LineString', coordinates: r.path } }));
    // closures draw on top
    features.sort((a, b) => (a.properties.kind === 'closure') - (b.properties.kind === 'closure'));
    setSource('incidents', { type: 'FeatureCollection', features });

    for (const r of state.roads) {
      if (!r.lat) continue;
      const el = document.createElement('div');
      if (r.kind === 'closure') el.className = 'x-mk';
      else { el.className = `inc-mk ${r.kind}`; el.textContent = r.kind === 'collision' ? '!' : ''; }
      const at = Array.isArray(r.path) && r.path.length > 1 ? midpoint(r.path) : [r.lon, r.lat];
      const m = new maplibregl.Marker({ element: el }).setLngLat(at)
        .setPopup(popup(`<h3>${esc(kindLabel[r.kind])} · ${esc(r.roadLabel)}${r.milepost ? ' MP ' + esc(r.milepost) : ''}</h3><p>${esc(r.headline)}</p>
          <div class="m">SINCE ${esc(fmtWhen(r.start))}${r.link && /^https:/.test(r.link) ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener">WSDOT DETAILS</a>` : ''}</div>`)).addTo(map);
      roadMarkers.push({ el, m, kind: r.kind });
    }
    showByZoom();

    $('#nRoads').textContent = list.filter((r) => r.kind === 'closure' || r.kind === 'collision').length || '';
    const stale = state.roadsUpdated ? `WSDOT SYNC ${fmtWhen(state.roadsUpdated)}` : 'WSDOT FEED OFFLINE';
    $('#roadList').innerHTML = (list.length ? list.map((r, i) => `<li class="clickable k-${r.kind}" data-i="${i}">
        <div class="t"><span class="tag ${r.kind}">${kindLabel[r.kind]}</span>${esc(r.headline)}</div>
        <div class="m">${esc(r.roadLabel || r.road)}${r.milepost ? ' MP ' + esc(r.milepost) : ''}${r.dist != null ? ` · ${r.dist.toFixed(1)} MI AWAY` : ''}</div></li>`).join('')
      : `<li class="empty">NO CLOSURES OR INCIDENTS ${corridor() ? 'ON ROUTE' : ''}</li>`) +
      `<li class="empty m" style="border:0;padding:2px 0">${stale}</li>`;
    $('#roadList').onclick = (e) => {
      const li = e.target.closest('li[data-i]'); if (!li) return;
      const r = list[+li.dataset.i];
      if (Array.isArray(r.path) && r.path.length > 1) {
        const b = new maplibregl.LngLatBounds(); r.path.forEach((p) => b.extend(p));
        map.fitBounds(b, { padding: fitPad(80), maxZoom: 14 });
      } else if (r.lat) map.flyTo({ center: [r.lon, r.lat], zoom: 13 });
    };
  }

  function renderBridges() {
    $('#bridgeList').innerHTML = C.bridges.map((b) => {
      const { blocked, issues } = bridgeStatus(b);
      const pill = issues.length ? '<span class="pill bad">WSDOT ALERT</span>'
        : blocked ? `<span class="pill ok">DOWN TILL ${fmtTime(new Date(`${new Date().toDateString()} ${blocked}`)).toUpperCase()}</span>`
        : '<span class="pill">OPENS ON REQUEST</span>';
      const html = `<h3>▲ ${esc(b.name)}</h3><div class="m">${esc(b.route)} · ${esc(b.town)}</div><p class="m">${esc(b.note)}</p>` +
        issues.map((r) => `<p>${esc(r.headline)}</p>`).join('');
      bridgeMarkers[b.id].m.getPopup().setHTML(html);
      bridgeMarkers[b.id].el.classList.toggle('shut', !!issues.length);
      b._issue = !!issues.length;
      const cam = camById[b.cam];
      return `<li class="clickable ${issues.length ? 'k-closure' : ''}" data-b="${b.id}"><div class="t">${esc(b.name.toUpperCase())} ${pill}</div>
        <div class="m">${esc(b.route)} · ${esc(b.town.toUpperCase())}</div>${issues.map((r) => `<div class="m">${esc(r.headline)}</div>`).join('')}
        ${cam && !TV ? `<button type="button" class="cam-show" data-cam="${cam.id}">◉ SHOW CAMERA</button><div class="cam-slot"></div>` : ''}</li>`;
    }).join('');
    const bad = C.bridges.filter((b) => b._issue).length;
    bridgeChip.classList.toggle('shut', bad > 0);
    bridgeChip.querySelector('.v').textContent = bad ? `▲ ${bad} BRIDGE ALERT${bad > 1 ? 'S' : ''}` : state.roadsUpdated ? '▲ BRIDGES OK' : '▲ BRIDGES';
  }
  $('#bridgeList').addEventListener('click', (e) => {
    const show = e.target.closest('.cam-show');
    if (show) {
      const slot = show.nextElementSibling;
      if (slot.innerHTML) { slot.innerHTML = ''; show.textContent = '◉ SHOW CAMERA'; }
      else { slot.innerHTML = camHtml(camById[show.dataset.cam]); show.textContent = '◉ HIDE CAMERA'; }
      return;
    }
    if (e.target.closest('.cam')) return;
    const li = e.target.closest('li[data-b]'); if (!li) return;
    const b = C.bridges.find((x) => x.id === li.dataset.b);
    map.flyTo({ center: [b.lon, b.lat], zoom: 14 });
  });

  function renderWeather() {
    const c = corridor();
    const towns = c ? c.towns.map((id) => townById[id]) : C.towns;
    $('#wxList').innerHTML = towns.map((t) => {
      const w = state.wx[t.id];
      if (!w) return `<li><span>${esc(t.name.toUpperCase())}</span><span class="m">…</span></li>`;
      return `<li><span>${esc(t.name.toUpperCase())}<br><span class="m">${esc(w.f)} · WIND ${esc(w.wind)}${w.rain != null ? ` · ${w.rain}% PRECIP` : ''}</span></span>
        <span class="temp">${w.temp}°</span></li>`;
    }).join('');
    const rw = state.roadWx || [];
    $('#roadWxList').innerHTML = rw.length ? rw.map((s) => `<li><span>${esc(s.name.toUpperCase())}<br><span class="m">WIND ${esc(s.dir || '')} ${s.wind ?? '?'} MPH${s.gust ? ` G${s.gust}` : ''}${s.precip ? ` · ${s.precip}" PRECIP` : ''}</span></span>
      <span class="temp">${s.temp != null ? Math.round(s.temp) + '°' : '–'}</span></li>`).join('') : '<li class="empty">NO ROADSIDE READINGS</li>';
  }

  // ---------------- route filter ----------------
  const sel = $('#route');
  for (const c of C.corridors) sel.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.name.toUpperCase())}</option>`);
  sel.value = state.route;
  function applyRoute(fit) {
    const c = corridor();
    if (map.getLayer('route-hl')) {
      let filter = ['==', ['get', 'ref'], '__none__'];
      if (c) {
        // only the stretch between the route's towns, not the whole highway
        const ts = c.towns.map((id) => townById[id]), g = 0.06;
        const w = Math.min(...ts.map((t) => t.lon)) - g, e = Math.max(...ts.map((t) => t.lon)) + g;
        const s = Math.min(...ts.map((t) => t.lat)) - g, n = Math.max(...ts.map((t) => t.lat)) + g;
        const box = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
        filter = ['all', ['within', box],
          ['any', ...c.roads.map(([ref, net]) => ['all', ['==', ['get', 'ref'], ref], ['==', ['get', 'network'], net]])]];
      }
      map.setFilter('route-hl', filter);
    }
    if (c && fit) {
      const b = new maplibregl.LngLatBounds();
      c.towns.forEach((id) => b.extend([townById[id].lon, townById[id].lat]));
      map.fitBounds(b, { padding: fitPad(60), maxZoom: 11 });
    }
    renderAlerts(); renderRoads(); renderWeather();
  }
  sel.addEventListener('change', () => { state.route = sel.value; store.set('ht.route', state.route); applyRoute(true); });
  map.on('load', () => applyRoute(false));

  // ---------------- tabs & sheet ----------------
  const panel = $('#panel');
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    panel.classList.remove('min');
  }));
  $('#tab-roads').classList.add('on');
  $('#sheetHandle').addEventListener('click', () => {
    if (panel.classList.contains('min')) panel.classList.remove('min');
    else if (panel.classList.contains('max')) { panel.classList.remove('max'); panel.classList.add('min'); }
    else panel.classList.add('max');
  });

  // ---------------- my location & facing direction ----------------
  let meMarker = null, watching = false;
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.innerHTML = `<svg class="cone" viewBox="0 0 64 64" style="display:none"><defs><radialGradient id="cg" cx="50%" cy="100%" r="100%">
    <stop offset="0" stop-color="#00e5ff" stop-opacity=".6"/><stop offset="1" stop-color="#00e5ff" stop-opacity="0"/></radialGradient></defs>
    <path d="M32 32 L14 2 A36 36 0 0 1 50 2 Z" fill="url(#cg)" stroke="#00e5ff" stroke-opacity=".5" stroke-width=".6"/></svg><div class="dot"></div>`;
  const cone = meEl.querySelector('.cone');
  function setHeading(h) {
    if (h == null || isNaN(h)) return;
    state.heading = h;
    cone.style.display = '';
    cone.style.transform = `rotate(${h}deg)`;
  }
  $('#btnLocate').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return alert('This browser cannot share location.');
    if (watching && state.me) return map.flyTo({ center: [state.me.lon, state.me.lat], zoom: 12 });
    watching = true;
    $('#btnLocate').classList.add('on');
    let first = true;
    navigator.geolocation.watchPosition((p) => {
      state.me = { lat: p.coords.latitude, lon: p.coords.longitude };
      if (!meMarker) meMarker = new maplibregl.Marker({ element: meEl }).setLngLat([state.me.lon, state.me.lat]).addTo(map);
      else meMarker.setLngLat([state.me.lon, state.me.lat]);
      // while driving, GPS course is steadier than the compass
      if (p.coords.speed > 2 && p.coords.heading != null) setHeading(p.coords.heading);
      if (first) { first = false; map.flyTo({ center: [state.me.lon, state.me.lat], zoom: 11 }); renderRoads(); }
    }, (err) => { watching = false; $('#btnLocate').classList.remove('on'); alert('Location unavailable: ' + err.message); },
    { enableHighAccuracy: true, maximumAge: 10000 });
  });

  const hasCompass = 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches;
  if (hasCompass && !TV) $('#btnCompass').hidden = false;
  $('#btnCompass').addEventListener('click', async () => {
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return;
      }
    } catch { return; }
    $('#btnCompass').classList.add('on');
    const onOrient = (e) => {
      if (e.webkitCompassHeading != null) setHeading(e.webkitCompassHeading);         // iPhone
      else if (e.absolute && e.alpha != null) setHeading((360 - e.alpha) % 360);      // Android
    };
    window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
    if (!state.me) $('#btnLocate').click();
  });

  // ---------------- clock & refresh ----------------
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); };
  tick(); setInterval(tick, 10000);
  async function refresh() {
    await Promise.allSettled([loadWeather(), loadAlerts(), loadRoads(), loadRoadWeather(), loadFlow()]);
    $('#updated').textContent = 'SYNC ' + fmtTime(new Date()).toUpperCase();
  }
  loadCameras(); // the list only; images wait for a click
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
  setInterval(renderBridges, 60 * 1000);
  if (TV) setTimeout(() => location.reload(), 6 * 60 * 60 * 1000); // keeps a TV browser from bogging down
})();
