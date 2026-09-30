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
    return sameDay ? fmtTime(d) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  };
  const miles = (a, b) => {
    const R = 3958.8, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const roadNum = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');

  const state = { route: TV ? '' : store.get('ht.route') || '', wx: {}, zonesByTown: {}, nws: [], roads: [], roadsUpdated: null, me: null, heading: null };

  // ---------------- map ----------------
  const [W, S, E, N] = C.bounds;
  const pad = 0.35;
  const dem = new mlcontour.DemSource({
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium', maxzoom: 12, worker: true
  });
  dem.setupMaplibre(maplibregl);

  const font = (w) => [w === 'b' ? 'Noto Sans Bold' : w === 'i' ? 'Noto Sans Italic' : 'Noto Sans Regular'];
  const outside = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [
    [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
    [[W, S], [W, N], [E, N], [E, S], [W, S]]
  ] } };

  const style = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: { type: 'raster-dem', encoding: 'terrarium', tiles: [dem.sharedDemProtocolUrl], maxzoom: 12, tileSize: 256,
        attribution: 'Elevation: Mapzen/AWS Terrain Tiles' },
      contours: { type: 'vector', maxzoom: 15, tiles: [dem.contourProtocolUrl({
        multiplier: 3.28084,
        thresholds: { 9: [500, 2500], 10: [250, 1000], 11: [200, 1000], 12: [100, 500], 13: [50, 250] },
        elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours'
      })] },
      outside: { type: 'geojson', data: outside }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9eedd' } },
      { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
        paint: { 'fill-color': '#cbdab0' } },
      { id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland', 'wetland']]],
        paint: { 'fill-color': '#dce6c6', 'fill-opacity': 0.8 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#bfd49c', 'fill-opacity': 0.45 } },
      { id: 'town', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail']]],
        paint: { 'fill-color': '#dcdcc8', 'fill-opacity': 0.7 } },
      { id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
        'hillshade-shadow-color': '#2a3d2e', 'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#586b5a', 'hillshade-exaggeration': 0.5 } },
      { id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours', paint: {
        'line-color': 'rgba(70,90,60,0.35)', 'line-width': ['match', ['get', 'level'], 1, 1, 0.5] } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#9ec4d3' } },
      { id: 'river', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 8,
        paint: { 'line-color': '#9ec4d3', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 2.5] } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 5] } },
      { id: 'road-sec', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['secondary']]],
        paint: { 'line-color': '#f7f1e3', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 15, 7] } },
      { id: 'road-main-case', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8a5a2b', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 15, 12] } },
      { id: 'road-main', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f0c27b', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.4, 15, 9] } },
      { id: 'route-hl', type: 'line', source: 'omt', 'source-layer': 'transportation_name',
        filter: ['==', ['get', 'ref'], '__none__'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1f58a6', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 5, 14, 14] } },
      { id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': '#132318', 'fill-opacity': 0.28 } },
      { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 8,
        layout: { 'text-field': ['get', 'name'], 'text-font': font('i'), 'text-size': 12, 'symbol-placement': 'point' },
        paint: { 'text-color': '#2d6a8a', 'text-halo-color': 'rgba(255,255,255,.7)', 'text-halo-width': 1 } },
      { id: 'peaks', type: 'symbol', source: 'omt', 'source-layer': 'mountain_peak', minzoom: 9,
        layout: { 'text-field': ['concat', '▲ ', ['get', 'name'], '\n', ['to-string', ['get', 'ele_ft']], ' ft'],
          'text-font': font('r'), 'text-size': 11, 'text-anchor': 'top' },
        paint: { 'text-color': '#34493a', 'text-halo-color': 'rgba(255,255,255,.75)', 'text-halo-width': 1 } },
      { id: 'shields', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 8,
        filter: ['in', ['get', 'network'], ['literal', ['us-interstate', 'us-highway', 'us-state']]],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 300, 'text-field': ['get', 'ref'], 'text-font': font('b'),
          'text-size': 11, 'text-rotation-alignment': 'viewport' },
        paint: { 'text-color': '#15261a', 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 } },
      { id: 'villages', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 10,
        filter: ['in', ['get', 'class'], ['literal', ['village', 'hamlet', 'suburb', 'neighbourhood']]],
        layout: { 'text-field': ['get', 'name'], 'text-font': font('r'), 'text-size': 11 },
        paint: { 'text-color': '#586b5a', 'text-halo-color': 'rgba(255,255,255,.8)', 'text-halo-width': 1 } }
    ]
  };

  const map = new maplibregl.Map({
    container: 'map', style, bounds: C.bounds, fitBoundsOptions: { padding: 20 },
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
  const fitAll = () => map.fitBounds(C.bounds, { padding: fitPad(20), duration: TV ? 0 : 600 });
  map.once('load', () => phone() && fitAll());
  window.addEventListener('resize', () => TV && fitAll());

  const popup = (html) => new maplibregl.Popup({ offset: 16, maxWidth: '280px' }).setHTML(html);

  // ---------------- weather ----------------
  const wxEmoji = (f = '', day = true) => {
    f = f.toLowerCase();
    if (/thunder/.test(f)) return '⛈';
    if (/snow|flurr|sleet|ice/.test(f)) return '🌨';
    if (/rain|shower|drizzle/.test(f)) return '🌧';
    if (/fog|haze|smoke/.test(f)) return '🌫';
    if (/wind/.test(f)) return '💨';
    if (/partly|mostly sunny|mostly clear/.test(f)) return day ? '⛅' : '☁';
    if (/cloud|overcast/.test(f)) return '☁';
    if (/sunny|clear/.test(f)) return day ? '☀' : '🌙';
    return '·';
  };
  const wxMarkers = {};
  for (const t of C.towns) {
    const el = document.createElement('div');
    el.className = 'wx-mk';
    el.innerHTML = `<span class="e">·</span><span class="v">--°</span><span class="n">${esc(t.name)}</span>`;
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
      mk.querySelector('.e').textContent = wxEmoji(now.shortForecast, now.isDaytime);
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

  // ---------------- WSDOT (written by the collector every ~10 min) ----------------
  const roadMarkers = [];
  async function loadRoads() {
    try {
      const r = await fetch('data/wsdot-alerts.json?t=' + Date.now(), { cache: 'no-store' });
      const j = await r.json();
      state.roads = j.alerts || [];
      state.roadsUpdated = j.updated;
    } catch (e) { console.warn('road data', e); }
    renderRoads();
    renderBridges();
  }
  const kindIcon = { closure: '✕', collision: '!', work: '⚒', other: 'i' };
  const getJson = async (path) => (await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' })).json();

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
      <div class="m">${esc(cam.title)} · <span class="age">loaded ${fmtTime(new Date(camLast[cam.id]))}</span>
      <button type="button" class="cam-refresh">Refresh</button></div></div>`;
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cam-refresh');
    if (!btn) return;
    const box = btn.closest('.cam'), cam = camById[box.dataset.cam];
    const wait = CAM_MIN_MS - (Date.now() - camLast[cam.id]);
    if (wait > 0) { btn.textContent = `Refresh in ${Math.ceil(wait / 1000)}s`; setTimeout(() => (btn.textContent = 'Refresh'), 2500); return; }
    box.querySelector('img').src = camImg(cam);
    box.querySelector('.age').textContent = 'loaded ' + fmtTime(new Date(camLast[cam.id]));
  });
  const camMarkers = [];
  async function loadCameras() {
    try {
      const j = await getJson('data/cameras.json');
      for (const cam of j.cameras || []) {
        camById[cam.id] = cam;
        const el = document.createElement('div');
        el.className = 'mk cam-mk';
        el.title = cam.title;
        el.innerHTML = '<i class="ic ic-cam">📷</i>';
        const p = new maplibregl.Popup({ offset: 14, maxWidth: '340px' });
        p.on('open', () => p.setHTML(`<h3>${esc(cam.title)}</h3>${camHtml(cam)}`));
        camMarkers.push({ el, m: new maplibregl.Marker({ element: el }).setLngLat([cam.lon, cam.lat]).setPopup(p).addTo(map) });
      }
      showCams();
      renderBridges();
    } catch (e) { console.warn('cameras', e); }
  }
  const showCams = () => { const on = map.getZoom() >= 10; camMarkers.forEach(({ el }) => (el.style.display = on ? '' : 'none')); };
  map.on('zoomend', showCams);

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
        el.innerHTML = `<span class="e">🌡</span><span class="v">${Math.round(s.temp)}°</span>`;
        el.title = `${s.name}: ${Math.round(s.temp)}°F, wind ${s.dir || ''} ${s.wind ?? '?'} mph (roadside sensor)`;
        rwMarkers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [8, 0] }).setLngLat([s.lon, s.lat]).addTo(map));
      }
      showRw();
      renderWeather();
    } catch (e) { console.warn('road weather', e); }
  }
  const showRw = () => { const on = map.getZoom() >= 10; rwMarkers.forEach((m) => (m.getElement().style.display = on ? '' : 'none')); };
  map.on('zoomend', showRw);

  // ---------------- I-5 live traffic sensors + travel times ----------------
  const flowColor = ['#9aa39a', '#4f8a2b', '#e0b020', '#d4611c', '#b8322a'];
  let flowData = { type: 'FeatureCollection', features: [] };
  map.on('load', () => {
    map.addSource('flow', { type: 'geojson', data: flowData });
    map.addLayer({ id: 'flow', type: 'circle', source: 'flow', filter: ['>', ['get', 'level'], 0],
      layout: { 'circle-sort-key': ['get', 'level'] },
      paint: { 'circle-color': ['to-color', ['at', ['get', 'level'], ['literal', flowColor]]],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 7, 15, 10],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } }, 'outside');
  });
  async function loadFlow() {
    try {
      const j = await getJson('data/flow.json');
      flowData = { type: 'FeatureCollection', features: (j.stations || []).map(([lat, lon, level, mp, dir, road]) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { level, mp, dir, road } })) };
      map.getSource('flow')?.setData(flowData);
    } catch (e) { console.warn('flow', e); }
    try { state.travel = (await getJson('data/travel-times.json')).routes || []; } catch { state.travel = []; }
    renderTravel();
  }
  function renderTravel() {
    const t = state.travel || [];
    $('#travelList').innerHTML = t.length ? t.map((r) => {
      const slow = r.avg && r.now > r.avg * 1.25;
      return `<li><div class="t">${esc(r.name.replace(/^\w+\s/, ''))} <span class="pill ${slow ? 'bad' : 'ok'}">${r.now} min</span></div>
        <div class="m">usually ${r.avg} min · ${r.miles} mi</div></li>`;
    }).join('') : '<li class="empty">No travel times right now.</li>';
  }

  // ---------------- bridges ----------------
  const bridgeMarkers = {};
  for (const b of C.bridges) {
    const el = document.createElement('div');
    el.className = 'mk';
    el.innerHTML = '<i class="ic ic-bridge">⌂</i>';
    bridgeMarkers[b.id] = { el, m: new maplibregl.Marker({ element: el }).setLngLat([b.lon, b.lat]).setPopup(popup('')).addTo(map) };
  }
  // zoomed out, the five bridges would bury Aberdeen/Hoquiam, so they share one chip
  const bridgeChip = document.createElement('div');
  bridgeChip.className = 'wx-mk mk';
  bridgeChip.innerHTML = '<i class="ic ic-bridge" style="width:20px;height:20px;font-size:12px">⌂</i><span class="v">Bridges</span>';
  bridgeChip.addEventListener('click', () => map.flyTo({ center: [-123.85, 46.975], zoom: 12.5 }));
  new maplibregl.Marker({ element: bridgeChip }).setLngLat([-123.86, 46.935]).addTo(map);
  const showBridges = () => {
    const close = map.getZoom() >= 11;
    bridgeChip.style.display = close ? 'none' : '';
    for (const { el } of Object.values(bridgeMarkers)) el.style.display = close ? '' : 'none';
  };
  map.on('zoomend', showBridges);
  showBridges();
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
      return `<li class="sev-${esc(a.severity)}"><div class="t">${esc(a.event)}</div>
        <div class="m">${towns.length ? esc(towns.join(', ')) + ' · ' : ''}until ${esc(fmtWhen(a.ends || a.expires))}</div>
        ${TV ? '' : `<details><summary class="m">Details</summary><p class="m">${esc(a.description).replace(/\n\n/g, '<br><br>')}</p></details>`}</li>`;
    }).join('') : `<li class="empty">No weather alerts ${corridor() ? 'along this route' : 'in the region'}.</li>`;
  }

  function renderRoads() {
    roadMarkers.splice(0).forEach((m) => m.remove());
    let list = state.roads.filter(onRoute);
    if (state.me) list = list.map((r) => ({ ...r, dist: r.lat ? miles(state.me, r) : null })).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    for (const r of state.roads) {
      if (!r.lat) continue;
      const el = document.createElement('div');
      el.className = 'mk';
      el.innerHTML = `<i class="ic ic-${r.kind}">${kindIcon[r.kind] || 'i'}</i>`;
      roadMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat])
        .setPopup(popup(`<h3>${esc(r.roadLabel)}: ${esc(r.category)}</h3><p>${esc(r.headline)}</p>
          <div class="m">Since ${esc(fmtWhen(r.start))}${r.link && /^https:/.test(r.link) ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener">WSDOT details</a>` : ''}</div>`)).addTo(map));
    }
    $('#nRoads').textContent = list.filter((r) => r.kind === 'closure' || r.kind === 'collision').length || '';
    const stale = state.roadsUpdated ? ` · WSDOT data ${fmtWhen(state.roadsUpdated)}` : ' · WSDOT feed not connected yet';
    $('#roadList').innerHTML = (list.length ? list.map((r, i) => `<li class="clickable" data-i="${i}">
        <div class="t"><i class="ic ic-${r.kind}">${kindIcon[r.kind] || 'i'}</i> ${esc(r.headline)}</div>
        <div class="m">${esc(r.roadLabel || r.road)}${r.dist != null ? ` · ${r.dist.toFixed(1)} mi away` : ''} · ${esc(r.category)}</div></li>`).join('')
      : `<li class="empty">No closures or incidents ${corridor() ? 'on this route' : 'reported'}.</li>`) +
      `<li class="empty m" style="border:0;background:none;padding:2px 0">${stale.slice(3)}</li>`;
    $('#roadList').onclick = (e) => {
      const li = e.target.closest('li[data-i]'); if (!li) return;
      const r = list[+li.dataset.i]; if (r.lat) map.flyTo({ center: [r.lon, r.lat], zoom: 13 });
    };
  }

  function renderBridges() {
    $('#bridgeList').innerHTML = C.bridges.map((b) => {
      const { blocked, issues } = bridgeStatus(b);
      const pill = issues.length ? '<span class="pill bad">WSDOT alert</span>'
        : blocked ? `<span class="pill ok">Stays down till ${fmtTime(new Date(`${new Date().toDateString()} ${blocked}`))}</span>`
        : '<span class="pill">May open on request</span>';
      const html = `<h3>${esc(b.name)}</h3><div class="m">${esc(b.route)} · ${esc(b.town)}</div><p class="m">${esc(b.note)}</p>` +
        issues.map((r) => `<p><b>${esc(r.headline)}</b></p>`).join('');
      bridgeMarkers[b.id].m.getPopup().setHTML(html);
      bridgeMarkers[b.id].el.querySelector('.ic').classList.toggle('shut', !!issues.length);
      b._issue = !!issues.length;
      const cam = camById[b.cam];
      return `<li class="clickable" data-b="${b.id}"><div class="t">${esc(b.name)} ${pill}</div>
        <div class="m">${esc(b.route)} · ${esc(b.town)}</div>${issues.map((r) => `<div class="m"><b>${esc(r.headline)}</b></div>`).join('')}
        ${cam && !TV ? `<button type="button" class="cam-show" data-cam="${cam.id}">📷 Show camera</button><div class="cam-slot"></div>` : ''}</li>`;
    }).join('');
    const bad = C.bridges.filter((b) => b._issue).length;
    bridgeChip.querySelector('.ic').classList.toggle('shut', bad > 0);
    bridgeChip.querySelector('.v').textContent = bad ? `${bad} bridge alert${bad > 1 ? 's' : ''}` : state.roadsUpdated ? 'Bridges OK' : 'Bridges';
  }
  $('#bridgeList').addEventListener('click', (e) => {
    const show = e.target.closest('.cam-show');
    if (show) {
      const slot = show.nextElementSibling;
      if (slot.innerHTML) { slot.innerHTML = ''; show.textContent = '📷 Show camera'; }
      else { slot.innerHTML = camHtml(camById[show.dataset.cam]); show.textContent = '📷 Hide camera'; }
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
      if (!w) return `<li><span>${esc(t.name)}</span><span class="m">…</span></li>`;
      return `<li><span><b>${esc(t.name)}</b><br><span class="m">${esc(w.f)} · wind ${esc(w.wind)}${w.rain != null ? ` · ${w.rain}% rain` : ''}</span></span>
        <span class="temp">${wxEmoji(w.f, w.day)} ${w.temp}°</span></li>`;
    }).join('');
    const rw = state.roadWx || [];
    $('#roadWxList').innerHTML = rw.length ? rw.map((s) => `<li><span><b>${esc(s.name)}</b><br><span class="m">wind ${esc(s.dir || '')} ${s.wind ?? '?'} mph${s.gust ? `, gusts ${s.gust}` : ''}${s.precip ? ` · ${s.precip}" rain` : ''}</span></span>
      <span class="temp">${s.temp != null ? Math.round(s.temp) + '°' : '–'}</span></li>`).join('') : '<li class="empty">No roadside readings.</li>';
  }

  // ---------------- route picker ----------------
  const sel = $('#route');
  for (const c of C.corridors) sel.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.name)}</option>`);
  sel.value = state.route;
  function applyRoute() {
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
    if (c) {
      const pts = c.towns.map((id) => townById[id]);
      const b = new maplibregl.LngLatBounds();
      pts.forEach((t) => b.extend([t.lon, t.lat]));
      map.fitBounds(b, { padding: fitPad(60), maxZoom: 11 });
    }
    renderAlerts(); renderRoads(); renderWeather();
  }
  sel.addEventListener('change', () => { state.route = sel.value; store.set('ht.route', state.route); applyRoute(); });
  map.on('load', applyRoute);

  // ---------------- tabs & sheet ----------------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    panel.classList.remove('min');
  }));
  const panel = $('#panel');
  $('#tab-alerts').classList.add('on');
  $('#sheetHandle').addEventListener('click', () => {
    if (panel.classList.contains('min')) panel.classList.remove('min');
    else if (panel.classList.contains('max')) { panel.classList.remove('max'); panel.classList.add('min'); }
    else panel.classList.add('max');
  });
  $('#btnReset').addEventListener('click', fitAll);

  // ---------------- my location & facing direction ----------------
  let meMarker = null, watching = false;
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.innerHTML = `<svg class="cone" viewBox="0 0 64 64" style="display:none"><defs><radialGradient id="cg" cx="50%" cy="100%" r="100%">
    <stop offset="0" stop-color="#1f58a6" stop-opacity=".55"/><stop offset="1" stop-color="#1f58a6" stop-opacity="0"/></radialGradient></defs>
    <path d="M32 32 L14 2 A36 36 0 0 1 50 2 Z" fill="url(#cg)"/></svg><div class="dot"></div>`;
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
  const tick = () => { $('#clock').textContent = fmtTime(new Date()); };
  tick(); setInterval(tick, 15000);
  async function refresh() {
    await Promise.allSettled([loadWeather(), loadAlerts(), loadRoads(), loadRoadWeather(), loadFlow()]);
    $('#updated').textContent = 'Updated ' + fmtTime(new Date());
  }
  loadCameras(); // the list only; images wait for a click
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
  setInterval(renderBridges, 60 * 1000);
  if (TV) setTimeout(() => location.reload(), 6 * 60 * 60 * 1000); // keeps a TV browser from bogging down
})();
