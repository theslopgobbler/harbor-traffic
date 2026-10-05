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

  // ---- 12- or 24-hour time, everywhere on the page ----
  // 12-hour unless this device chose 24 (the switch under LIVE), or a TV link says ?clock=24.
  // Every time the page writes goes through the browser's toLocaleTimeString / toLocaleString with an hour in it,
  // so those follow the setting here; the few made by hand ask window.htClock24.
  window.htClock24 = qs.get('clock') ? qs.get('clock') === '24' : store.get('ht.clock24') === true;
  for (const fn of ['toLocaleTimeString', 'toLocaleString']) {
    const orig = Date.prototype[fn];
    Date.prototype[fn] = function (loc, opts) {
      if (opts && 'hour' in opts && !opts.hourCycle) opts = { ...opts, hour12: !window.htClock24 };
      else if (!opts && fn === 'toLocaleTimeString') opts = { hour12: !window.htClock24 };
      return orig.call(this, loc, opts);
    };
  }
  // a time someone else wrote as "05:45 PM" (the bus tracker's), in the page's format
  window.htClockText = (s) => {
    const m = String(s || '').match(/^\s*(\d{1,2}):(\d{2})\s*([AP])M\s*$/i);
    if (!m || !window.htClock24) return s;
    const h = (+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0);
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  };
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

  // (the old route filter is gone: the road list follows whatever part of the map is on screen)
  const state = { route: '', wx: {}, zonesByTown: {}, nws: [], roads: [], roadsUpdated: null, me: null, heading: null };

  // ---------------- colors (kept in sync with styles.css) ----------------
  const K = { bg: '#030807', cyan: '#00e5ff', green: '#39ff88', amber: '#ffc400', orange: '#ff7a1a', red: '#ff2a3d', dim: '#5f9c8b', magenta: '#ff2bd6' };
  const kindColor = { closure: K.red, collision: K.orange, work: K.amber, other: K.dim };

  // ---------------- map ----------------
  const [W, S, E, N] = C.bounds;
  const pad = 1.0;
  const OVERVIEW_Z = 8.4; // below this zoom: region summaries instead of town-by-town detail
  const dem = new mlcontour.DemSource({
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium', maxzoom: 12, worker: true
  });
  dem.setupMaplibre(maplibregl);

  const font = (w) => [w === 'b' ? 'Noto Sans Bold' : 'Noto Sans Regular'];
  const up = (f) => ['upcase', ['get', f]];
  // Street names shortened the way street signs do (East Wishkah Street → E WISHKAH ST, Simpson Avenue South →
  // SIMPSON AVE S). The map's label rules can't search and replace, but they can check how a name starts and ends
  // and cut pieces off, so: a direction word at the front, a direction word at the end, then the street type
  // before it. window.htShortStreet does the same for text on the page.
  const DIRS_W = [['Northeast', 'NE'], ['Northwest', 'NW'], ['Southeast', 'SE'], ['Southwest', 'SW'], ['North', 'N'], ['South', 'S'], ['East', 'E'], ['West', 'W']];
  const STREET_TYPES = [[' Street', ' ST'], [' Avenue', ' AVE'], [' Boulevard', ' BLVD'], [' Road', ' RD'], [' Drive', ' DR'],
    [' Lane', ' LN'], [' Place', ' PL'], [' Court', ' CT'], [' Highway', ' HWY'], [' Parkway', ' PKWY'], [' Circle', ' CIR'], [' Terrace', ' TER']];
  const shortStreetExpr = (() => {
    const v = (k) => ['var', k];
    const ends = (s, a) => ['all', ['>', ['length', s], a.length], ['==', ['slice', s, ['-', ['length', s], a.length]], a]];
    const cut = (s, a) => ['slice', s, 0, ['-', ['length', s], a.length]];
    // n: the name; m: without a leading direction; d: a trailing direction's letters ('' if none); q: m without it
    const m = ['case', ...DIRS_W.flatMap(([a, b]) => [['==', ['slice', v('n'), 0, a.length + 1], a + ' '], ['concat', b + ' ', ['slice', v('n'), a.length + 1]]]), v('n')];
    const d = ['case', ...DIRS_W.flatMap(([a, b]) => [ends(v('m'), ' ' + a), ' ' + b]), ''];
    const q = ['case', ...DIRS_W.flatMap(([a]) => [ends(v('m'), ' ' + a), cut(v('m'), ' ' + a)]), v('m')];
    const r = ['case', ...STREET_TYPES.flatMap(([a, b]) => [ends(v('q'), a), ['concat', cut(v('q'), a), b]]), v('q')];
    return ['upcase', ['let', 'n', ['to-string', ['get', 'name']], ['let', 'm', m, ['let', 'd', d, ['let', 'q', q, ['concat', r, v('d')]]]]]];
  })();
  window.htShortStreet = (s) => {
    let t = String(s || ''), tail = '';
    for (const [a, b] of DIRS_W) if (t.startsWith(a + ' ')) { t = b + ' ' + t.slice(a.length + 1); break; }
    for (const [a, b] of DIRS_W) if (t.length > a.length + 1 && t.endsWith(' ' + a)) { t = t.slice(0, -(a.length + 1)); tail = ' ' + b; break; }
    for (const [a, b] of STREET_TYPES) if (t.length > a.length && t.endsWith(a)) { t = t.slice(0, -a.length) + b; break; }
    return (t + tail).toUpperCase();
  };
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
      regionboxes: { type: 'geojson', data: { type: 'FeatureCollection', features: C.regions.filter((r) => r.bounds).map((r) => {
        const [w, s, e, n] = r.bounds;
        return { type: 'Feature', properties: { name: r.name }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
      }) } },
      flow: { type: 'geojson', data: empty },
      crossings: { type: 'geojson', data: empty },
      incidents: { type: 'geojson', data: empty }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': K.bg } },
      { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
        paint: { 'fill-color': '#04130e' } },
      { id: 'town', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail']]],
        paint: { 'fill-color': '#0a1b1f' } },
      // parks (OpenStreetMap's park shapes), from town zoom in: a barely-there tint and a faint dashed green edge,
      // like a zone marked on an old nav display rather than a green blob. State and national parks and reserves
      // get just the dashed edge, a little farther out
      { id: 'park-fill', type: 'fill', source: 'omt', 'source-layer': 'landcover', minzoom: 12,
        filter: ['in', ['get', 'subclass'], ['literal', ['park', 'recreation_ground']]],
        paint: { 'fill-color': '#0a2a1c', 'fill-opacity': 0.45 } },
      { id: 'park-edge', type: 'line', source: 'omt', 'source-layer': 'landcover', minzoom: 12,
        filter: ['in', ['get', 'subclass'], ['literal', ['park', 'recreation_ground']]],
        paint: { 'line-color': '#2f9a6c', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.25, 15, 0.55], 'line-width': 1, 'line-dasharray': [3, 2] } },
      { id: 'park-area-edge', type: 'line', source: 'omt', 'source-layer': 'park', minzoom: 9,
        paint: { 'line-color': '#2f9a6c', 'line-opacity': 0.3, 'line-width': 1, 'line-dasharray': [4, 3] } },
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
      // railroads (Puget Sound & Pacific: Centralia–Elma–Aberdeen–Hoquiam and the port), classic tie-hatched line
      { id: 'rail-ties', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': '#c28bff', 'line-opacity': 0.6, 'line-width': zw(3, 7), 'line-dasharray': [0.25, 2.5] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': '#c28bff', 'line-opacity': 0.8, 'line-width': zw(0.8, 1.6) } },
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
      // the region boxes, only in the zoomed-out overview
      { id: 'region-box', type: 'line', source: 'regionboxes', maxzoom: OVERVIEW_Z,
        paint: { 'line-color': K.cyan, 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [2, 3] } },
      { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 8,
        layout: { 'text-field': up('name'), 'text-font': font('r'), 'text-size': 11, 'text-letter-spacing': 0.25 },
        paint: { 'text-color': '#0bb3cc', 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      { id: 'peaks', type: 'symbol', source: 'omt', 'source-layer': 'mountain_peak', minzoom: 9,
        layout: { 'text-field': ['concat', '△ ', up('name'), '\n', ['to-string', ['get', 'ele_ft']], ' FT'],
          'text-font': font('r'), 'text-size': 10, 'text-anchor': 'top', 'text-letter-spacing': 0.1 },
        paint: { 'text-color': '#27c48d', 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      // street names, only zoomed well in: small and dim, along the street (lying flat on the road in the bus
      // chase view, like road markings), well spaced, and dropped wherever they'd crowd; the highway number
      // shields below win any space they both want
      // park names: small and dim green, only zoomed in, and the first thing dropped when space is tight (listed
      // before the street names, which win)
      { id: 'park-names', type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: 14.5, filter: ['==', ['get', 'class'], 'park'],
        layout: { 'text-field': up('name'), 'text-font': font('r'), 'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 9, 17, 11],
          'text-letter-spacing': 0.15, 'text-max-width': 8, 'text-padding': 4 },
        paint: { 'text-color': '#4fae86', 'text-opacity': 0.85, 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      { id: 'park-area-names', type: 'symbol', source: 'omt', 'source-layer': 'park', minzoom: 10, filter: ['has', 'name'],
        layout: { 'text-field': up('name'), 'text-font': font('r'), 'text-size': 10, 'text-letter-spacing': 0.15, 'text-max-width': 9 },
        paint: { 'text-color': '#3f8f6c', 'text-opacity': 0.8, 'text-halo-color': K.bg, 'text-halo-width': 1.5 } },
      // (an invisible copy of the named streets, wide, so the bus banner can ask which street the bus is on)
      { id: 'street-q', type: 'line', source: 'omt', 'source-layer': 'transportation_name', minzoom: 12, filter: ['has', 'name'],
        paint: { 'line-opacity': 0, 'line-width': 10 } },
      { id: 'street-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 15,
        filter: ['has', 'name'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 380, 'text-field': shortStreetExpr, 'text-font': font('r'),
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 17, 11], 'text-letter-spacing': 0.12,
          'text-max-angle': 30, 'text-padding': 6, 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map' },
        paint: { 'text-color': '#8cc7ba', 'text-opacity': 0.85, 'text-halo-color': K.bg, 'text-halo-width': 1.6 } },
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
    // extra room to the south: on phones the view centers below the area so it clears the bottom sheet
    // a pan limit with extra room to the south: on phones the view sits south of the area to clear the bottom sheet
    maxBounds: [W - pad * 2, S - pad * 3.5, E + pad * 2, N + pad * 1.5], minZoom: 5.5, maxZoom: 16,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
    interactive: !TV
  });
  window.htMap = map; // handy from the browser console
  map.on('error', (e) => console.warn('map:', e.error?.message || e));
  if (!TV) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  // my location, compass heading and bigger text: in a second box right under + and -
  if (!TV) {
    const ctl = document.createElement('div');
    ctl.className = 'maplibregl-ctrl maplibregl-ctrl-group ht-ctl';
    for (const id of ['btnLocate', 'btnCompass']) { const b = $('#' + id); b.classList.remove('tool'); b.classList.add('ctl-btn'); ctl.appendChild(b); }
    ctl.insertAdjacentHTML('beforeend', '<button id="btnBig" class="ctl-btn" type="button" aria-pressed="false" aria-label="Bigger text" title="Bigger text">Aa</button>');
    map.addControl({ onAdd: () => ctl, onRemove: () => ctl.remove() }, 'top-right');
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
  const phone = () => matchMedia('(max-width: 760px)').matches;
  // on phones the bottom sheet covers the lower part of the map
  // on phones, keep things clear of whatever the bottom sheet and the button row above it actually cover
  const fitPad = (p) => {
    if (!phone()) return p;
    const mapBox = map.getContainer().getBoundingClientRect();
    const sheet = document.querySelector('#panel').getBoundingClientRect();
    const tools = document.querySelector('.map-tools').getBoundingClientRect();
    const covered = Math.max(0, mapBox.bottom - Math.min(sheet.top, tools.height ? tools.top : sheet.top));
    return { top: p, left: p, right: p, bottom: Math.min(mapBox.height * 0.6, covered + p) };
  };
  window.htFitPad = fitPad;
  // for the bus banner's "route ahead": current road alerts, and the weather town by town
  window.htRoads = () => state.roads;
  window.htTownWx = () => C.towns.filter((t) => state.wx[t.id]?.f).map((t) => ({ name: t.name, lon: t.lon, lat: t.lat,
    code: wxCode(state.wx[t.id].f), temp: state.wx[t.id].temp, f: state.wx[t.id].f }));
  const popup = (html) => new maplibregl.Popup({ offset: 16, maxWidth: '320px' }).setHTML(html);
  // if an open popup runs off the map (or under the phone's bottom sheet and buttons), slide the map so it all shows
  function keepInView(p) {
    requestAnimationFrame(() => {
      const el = p.getElement(); if (!el) return;
      const r = el.getBoundingClientRect(), box = map.getContainer().getBoundingClientRect();
      const tools = document.querySelector('.map-tools')?.getBoundingClientRect();
      const sheet = document.querySelector('#panel')?.getBoundingClientRect();
      const bottom = phone() ? Math.min(box.bottom, sheet?.top ?? box.bottom, tools?.height ? tools.top : box.bottom) : box.bottom;
      const m = 10;
      let dx = 0, dy = 0;
      if (r.top < box.top + m) dy = r.top - box.top - m;
      else if (r.bottom > bottom - m) dy = Math.min(r.bottom - bottom + m, r.top - box.top - m);
      if (r.left < box.left + m) dx = r.left - box.left - m;
      else if (r.right > box.right - m) dx = r.right - box.right + m;
      if (dx || dy) map.panBy([dx, dy], { duration: 300 });
    });
  }
  window.htKeepInView = keepInView;

  // coordinate readout, for the look of it
  const readout = () => {
    const c = map.getCenter();
    $('#readout').textContent = `N ${c.lat.toFixed(4)}  W ${Math.abs(c.lng).toFixed(4)}  Z${map.getZoom().toFixed(1)}`;
  };
  map.on('move', readout);
  // when the map turns (following a bus heading-up), icons drawn at a compass heading turn back by the same amount
  // (at most 10 times a second and only when it's turned a bit: changing it makes the browser restyle every icon)
  let brgSet = 0, brgAt = 0, brgTimer = 0;
  const setBrg = () => { brgTimer = 0; brgAt = Date.now(); brgSet = map.getBearing(); map.getContainer().style.setProperty('--brg', `${brgSet.toFixed(1)}deg`); };
  map.on('rotate', () => {
    if (Math.abs(((map.getBearing() - brgSet + 540) % 360) - 180) < 0.5 || brgTimer) return;
    const wait = 100 - (Date.now() - brgAt);
    if (wait <= 0) setBrg(); else brgTimer = setTimeout(setBrg, wait);
  });

  // data that arrives before the style is ready waits here
  const setSource = (id, data) => {
    const s = map.getSource(id);
    if (s) s.setData(data); else map.once('load', () => map.getSource(id).setData(data));
  };

  // ---------------- regions ----------------
  const regionById = Object.fromEntries(C.regions.map((r) => [r.id, r]));
  // the TV starts on the full view unless its URL names a region; phones and PCs remember the last pick
  let region = regionById[qs.get('region')] ? qs.get('region') : TV ? 'all' : (store.get('ht.region') || 'all');
  if (!regionById[region]) region = 'all';
  const regionBar = $('#regions');
  regionBar.innerHTML = C.regions.map((r) => `<button type="button" data-r="${r.id}">${esc(r.name)}</button>`).join('');
  function showRegion(id, animate = true) {
    region = id;
    const r = regionById[id];
    regionBar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.r === id));
    if (!cycleTimer) $('#regionName').textContent = `▸ ${r.name.toUpperCase()}`;
    // phones jump straight there: an animated fit could end up off when the sheet moves mid-flight
    map.fitBounds(r.bounds || C.bounds, { padding: fitPad(30), duration: animate && !TV && !phone() ? 700 : 0 });
  }
  regionBar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]'); if (!b) return;
    stopCycle();
    store.set('ht.region', b.dataset.r);
    showRegion(b.dataset.r);
  });
  // TV: steps through the regions on its own (10 s each; ?cycle=20 to change, ?cycle=0 or ?region=x to hold still),
  // with a countdown on the map and a bar that drains until the next area
  let cycleTimer = null, cycleNext = 0, cycleMs = 0;
  const stopCycle = () => { clearInterval(cycleTimer); cycleTimer = null; $('#cycleBar').style.display = 'none'; spotPopup?.remove(); showRegionName(); };
  const ids = C.regions.map((r) => r.id);
  // The TV's tour: each region in turn, then a stop at each current road issue (closures first, then crashes,
  // then road work; up to 6), zoomed in with the alert's details showing; then round again (rebuilt each lap, so
  // new issues join and cleared ones drop out).
  let tour = [], tourIdx = 0, stepMs = 0, spotPopup = null;
  const ISSUE_ORDER = ['closure', 'collision', 'work'];
  function buildTour() {
    const issues = state.roads.filter((r) => r.lat && ISSUE_ORDER.includes(r.kind))
      .sort((a, b) => ISSUE_ORDER.indexOf(a.kind) - ISSUE_ORDER.indexOf(b.kind)).slice(0, 6);
    return [...ids.map((id) => ({ kind: 'region', id })), ...issues.map((r) => ({ kind: 'issue', r }))];
  }
  const stepName = (s) => !s ? '' : s.kind === 'region' ? regionById[s.id].name.toUpperCase()
    : `${kindLabel[s.r.kind]} · ${s.r.roadLabel || s.r.road}${s.r.milepost ? ' MP ' + s.r.milepost : ''}`.toUpperCase();
  function showStep(s) {
    spotPopup?.remove(); spotPopup = null;
    if (s.kind === 'region') return showRegion(s.id);
    const r = s.r;
    if (Array.isArray(r.path) && r.path.length > 1) {
      const b = new maplibregl.LngLatBounds(); r.path.forEach((p) => b.extend(p));
      map.fitBounds(b, { padding: 160, maxZoom: 13.5, duration: 1500 });
    } else map.flyTo({ center: [r.lon, r.lat], zoom: 13, duration: 1500 });
    const at = Array.isArray(r.path) && r.path.length > 1 ? r.path[Math.floor(r.path.length / 2)] : [r.lon, r.lat];
    // the alert's details, once the camera has arrived
    map.once('moveend', () => {
      if (tour[tourIdx] !== s) return;
      spotPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 18, maxWidth: '460px', className: 'tv-spot' })
        .setLngLat(at).setHTML(alertHtml(r)).addTo(map);
    });
  }
  function showRegionName(secsLeft) {
    const cur = cycleTimer ? stepName(tour[tourIdx]) : regionById[region].name.toUpperCase();
    const next = cycleTimer ? stepName(tour[(tourIdx + 1) % tour.length]) : '';
    $('#regionName').textContent = secsLeft != null ? `▸ ${cur} · NEXT ${next} ${secsLeft}` : `▸ ${cur}`;
  }
  map.once('load', () => {
    showRegion(region, false);
    // ?at=lon,lat,zoom (the stats page links to off-route spots this way)
    const at = (qs.get('at') || '').split(',').map(Number);
    if (at.length >= 2 && at.every((v) => !isNaN(v))) map.jumpTo({ center: [at[0], at[1]], zoom: at[2] || 16 });
    const secs = qs.has('cycle') ? +qs.get('cycle') : 10;
    if (TV && secs > 0 && !qs.has('region')) {
      cycleMs = Math.max(5, secs) * 1000;
      tour = buildTour(); tourIdx = Math.max(0, ids.indexOf(region));
      stepMs = cycleMs; cycleNext = Date.now() + stepMs;
      $('#cycleBar').style.display = 'block';
      cycleTimer = setInterval(() => {
        if (cycleNext - Date.now() <= 0) {
          tourIdx++;
          if (tourIdx >= tour.length) { tour = buildTour(); tourIdx = 0; }
          const s = tour[tourIdx];
          stepMs = s.kind === 'issue' ? Math.round(cycleMs * 1.3) : cycleMs; // a little longer to read an alert
          showStep(s);
          cycleNext = Date.now() + stepMs;
        }
        const l = Math.max(0, cycleNext - Date.now());
        showRegionName(Math.ceil(l / 1000));
        $('#cycleBar').style.transform = `scaleX(${l / stepMs})`;
      }, 200);
    }
  });
  window.addEventListener('resize', () => TV && showRegion(region, false));

  // the label (and button) follow wherever you pan: zoomed out it's FULL, otherwise the smallest region
  // containing the middle of the view, or the nearest one if you're between them
  map.on('moveend', (ev) => {
    if (cycleTimer) return; // the TV's cycle sets its own label
    if (!ev.originalEvent) return; // only when you pan or zoom yourself; a region you pick keeps its name
    // the middle of what you can actually see (on phones the sheet and buttons cover the bottom of the map)
    const box = map.getContainer().getBoundingClientRect();
    const cover = phone() ? Math.max(0, box.bottom - Math.min(document.querySelector('#panel').getBoundingClientRect().top,
      document.querySelector('.map-tools').getBoundingClientRect().top || box.bottom)) : 0;
    const c = map.unproject([box.width / 2, (box.height - cover) / 2]);
    let id = 'all';
    if (map.getZoom() >= OVERVIEW_Z) {
      const withB = C.regions.filter((r) => r.bounds);
      const inside = withB.filter(({ bounds: [w, s, e, n] }) => c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n)
        .sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]));
      const mid = (r) => [(r.bounds[0] + r.bounds[2]) / 2, (r.bounds[1] + r.bounds[3]) / 2];
      id = (inside[0] || withB.sort((a, b) => Math.hypot(mid(a)[0] - c.lng, mid(a)[1] - c.lat) - Math.hypot(mid(b)[0] - c.lng, mid(b)[1] - c.lat))[0]).id;
    }
    if (id !== region) {
      region = id;
      regionBar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.r === id));
    }
    placeLabel(c, id);
  });

  // The corner label gets more specific as you zoom in: the region; then the town; then the neighborhood or a
  // landmark (the port, downtown, the airport...), or the water if you're looking at the bay. The most specific
  // name is big, with what it's part of in small type under it.
  const mDist = (a, b) => Math.hypot((b[0] - a[0]) * 76000, (b[1] - a[1]) * 111000);
  function placeLabel(c, id) {
    const z = map.getZoom(), here = [c.lng, c.lat], regionText = regionById[id].name.toUpperCase();
    let town = null, spot = null;
    if (z >= 11.5) {
      let places = [];
      try { places = map.querySourceFeatures('omt', { sourceLayer: 'place' }); } catch {}
      const nearest = (classes, maxM) => places.filter((f) => classes.includes(f.properties.class) && f.properties.name)
        .map((f) => [mDist(here, f.geometry.coordinates), f.properties.name]).filter(([d]) => d < maxM).sort((a, b) => a[0] - b[0])[0]?.[1];
      // the town: from our own town list (the map only has a town's name in the tile its label sits in)
      town = C.towns.map((t) => [mDist(here, [t.lon, t.lat]), t.name]).filter(([d]) => d < 6000).sort((a, b) => a[0] - b[0])[0]?.[1]
        || nearest(['city', 'town', 'village'], 5000);
      if (z >= 13.5) {
        const lm = (C.landmarks || []).find((l) => l.box ? c.lng >= l.box[0] && c.lng <= l.box[2] && c.lat >= l.box[1] && c.lat <= l.box[3]
          : mDist(here, [l.lon, l.lat]) <= l.r);
        spot = lm?.name || nearest(['suburb', 'neighbourhood', 'quarter', 'hamlet'], 1200) || null;
        // looking at the water: the bay's name
        if (!spot) {
          const p = map.project(c);
          if (map.queryRenderedFeatures([p.x, p.y], { layers: ['water'] }).length) {
            let names = [];
            try { names = map.querySourceFeatures('omt', { sourceLayer: 'water_name' }); } catch {}
            spot = names.filter((f) => f.properties.name && f.geometry.type === 'Point')
              .map((f) => [mDist(here, f.geometry.coordinates), f.properties.name]).filter(([d]) => d < 15000).sort((a, b) => a[0] - b[0])[0]?.[1] || null;
          }
        }
        if (spot && town && spot.toLowerCase() === town.toLowerCase()) spot = null;
      }
    }
    const big = (spot || town || regionText).toUpperCase();
    // (without repeating a name: in Olympia the region is already called Olympia)
    const reg = town && regionText.startsWith(town.toUpperCase()) ? '' : regionText;
    const under = spot ? [town, reg].filter(Boolean).join(' · ') : town ? reg : '';
    $('#regionName').innerHTML = `▸ ${esc(big)}${under ? `<small>${esc(under.toUpperCase())}</small>` : ''}`;
  }

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
  // temperature colors: icy blue at freezing, through cyan, green, amber and orange, to red when hot
  const tempColor = (f) => f == null ? '' : f <= 32 ? '#7fb8ff' : f <= 45 ? '#00e5ff' : f <= 60 ? '#39ff88' : f <= 72 ? '#d4ff3a' : f <= 82 ? '#ffc400' : f <= 90 ? '#ff7a1a' : '#ff2a3d';
  const tempSpan = (f, text = `${f}°`) => `<span style="color:${tempColor(f)}">${text}</span>`;
  const wxMarkers = {};
  // a small gap between the town's dot and its label, on whichever side config.js puts it
  const gap = (a = 'center') => [/left/.test(a) ? 7 : /right/.test(a) ? -7 : 0, /^top/.test(a) ? 7 : /^bottom/.test(a) ? -7 : 0];
  for (const t of C.towns) {
    const el = document.createElement('div');
    el.className = 'wx-mk';
    if (t.minor) el.dataset.minor = '1';
    el.innerHTML = `<span class="n">${esc(t.name)}</span><span class="v">--°</span><span class="e">---</span>`;
    const dot = document.createElement('div');
    dot.className = 'town-dot';
    wxMarkers[t.id] = { el, dot, minor: !!t.minor,
      m: new maplibregl.Marker({ element: el, anchor: t.a || 'left', offset: gap(t.a || 'left') }).setLngLat([t.lon, t.lat]).addTo(map),
      d: new maplibregl.Marker({ element: dot }).setLngLat([t.lon, t.lat]).addTo(map) };
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
        windDir: now.windDirection, windMph: parseInt(String(now.windSpeed).split(' to ').pop(), 10) || 0,
        rain: now.probabilityOfPrecipitation?.value ?? null };
      const mk = wxMarkers[t.id].el;
      mk.querySelector('.e').textContent = wxCode(now.shortForecast, now.isDaytime);
      mk.querySelector('.v').textContent = `${now.temperature}°`;
      mk.querySelector('.v').style.color = tempColor(now.temperature);
      mk.title = `${t.name}: ${now.shortForecast}, wind ${now.windDirection} ${now.windSpeed}`;
    });
    renderWeather();
    renderAlerts(); // alerts are matched to towns through the zones found above
    announceWeather();
  }
  // wx.js (radar, sky icon, weather effects) listens for this
  const announceWeather = () => (renderOverview(), window.dispatchEvent(new CustomEvent('ht:weather', {
    detail: { wx: state.wx, zonesByTown: state.zonesByTown, nws: state.nws, towns: C.towns } })));
  async function loadAlerts() {
    const j = await nws('https://api.weather.gov/alerts/active?area=WA');
    state.nws = j.features.map((f) => f.properties);
    renderAlerts();
    announceWeather();
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
        p.on('open', () => {
          p.setHTML(`<h3>CAM ${esc(cam.title)}</h3>${camHtml(cam)}`);
          keepInView(p);
          // the image changes the popup's size when it arrives, so check again then
          p.getElement()?.querySelector('img')?.addEventListener('load', () => keepInView(p), { once: true });
        });
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
        el.innerHTML = `<span class="e">RD</span><span class="v" style="color:${tempColor(s.temp)}">${Math.round(s.temp)}°</span>`;
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
      state.flowUpdated = j.updated;
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
          features.push({ type: 'Feature', properties: { level, color: flowColor[level], dir: a.dir, mp: `${Math.min(a.mp, b.mp)}–${Math.max(a.mp, b.mp)}` },
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
    const vessel = (window.htNearBridge || {})[b.id] || null; // wx.js: a non-tug vessel close by
    return { blocked, issues, vessel };
  }

  // markers that only make sense up close
  function showByZoom() {
    const z = map.getZoom();
    camMarkers.forEach(({ el }) => (el.style.display = z >= 10 ? '' : 'none'));
    rwMarkers.forEach((m) => (m.getElement().style.display = z >= 10 ? '' : 'none'));
    bridgeChip.style.display = z >= 11 ? 'none' : '';
    for (const { el } of Object.values(bridgeMarkers)) el.style.display = z >= 11 ? '' : 'none';
    const ov = z < OVERVIEW_Z;
    document.body.classList.toggle('overview-mode', ov);
    regionChips.forEach(({ el }) => (el.style.display = ov ? '' : 'none'));
    if (ov !== lastOverview) { lastOverview = ov; renderOverview(); }
    for (const { el, dot, minor } of Object.values(wxMarkers)) {
      const hide = minor && z < 8.6;
      el.style.display = hide ? 'none' : '';
      dot.style.display = hide ? 'none' : '';
    }
    groupAlerts();
    declutterSoon();
  }
  map.on('zoomend', showByZoom);

  // ---------------- keep labels from overlapping ----------------
  // Labels are placed in priority order. Each takes its own spot if it's free, otherwise the nearest free
  // nudge around it (the town's dot stays at the true location), otherwise it's hidden. Markers, the map
  // buttons and the legend count as things to stay off of. Uses the CSS "translate" property, which
  // stacks on top of the transform MapLibre uses to position markers.
  const LABELS = [
    ['.rg-chip', 0], ['.bar-lbl', 1], ['.wx-mk:not(.rw-mk):not(.br-chip):not(.rg-chip)', 2],
    ['.br-chip', 3], ['.rail-chip', 3], ['.bay-lbl', 4], ['.rw-mk', 6]
  ];
  const OBSTACLES = '.x-mk, .inc-mk, .br-mk, .cam-mk, .ship-mk, .air-mk, .bus-mk, .river-mk, .town-dot, .me, .map-tools .tool, .nav-tools .tool, .maplibregl-ctrl-group, .legend';
  function declutter() {
    const wrapBox = map.getContainer().getBoundingClientRect();
    const shown = (el) => el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    const placed = [];
    for (const o of document.querySelectorAll(OBSTACLES)) {
      if (!shown(o)) continue;
      const r = o.getBoundingClientRect();
      if (r.width && r.height) placed.push(r);
    }
    const hits = (r) => placed.some((p) => r.left < p.right + 2 && r.right > p.left - 2 && r.top < p.bottom + 2 && r.bottom > p.top - 2);
    const inside = (r) => r.left >= wrapBox.left - 40 && r.right <= wrapBox.right + 40 && r.top >= wrapBox.top - 20 && r.bottom <= wrapBox.bottom + 20;
    const labels = [];
    for (const [sel, pri] of LABELS) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.translate = ''; el.style.visibility = '';
        // minor towns go after the main ones
        if (shown(el)) labels.push({ el, pri: pri === 2 && el.dataset.minor ? 5 : pri });
      });
    }
    labels.sort((a, b) => a.pri - b.pri);
    for (const { el } of labels) {
      const r0 = el.getBoundingClientRect();
      const w = r0.width, h = r0.height, dx = w / 2 + 6, dy = h + 3;
      const tries = [[0, 0], [0, -dy], [0, dy], [dx, 0], [-dx, 0], [dx, -dy], [-dx, -dy], [dx, dy], [-dx, dy],
        [0, -2 * dy], [0, 2 * dy], [2 * dx, 0], [-2 * dx, 0]];
      let ok = false;
      for (const [x, y] of tries) {
        const r = { left: r0.left + x, right: r0.right + x, top: r0.top + y, bottom: r0.bottom + y };
        if ((x || y) && !inside(r)) continue;
        if (!hits(r)) {
          if (x || y) el.style.translate = `${x}px ${y}px`;
          placed.push(r); ok = true; break;
        }
      }
      if (!ok) el.style.visibility = 'hidden';
    }
  }
  let declutterTimer = 0;
  const declutterSoon = () => { clearTimeout(declutterTimer); declutterTimer = setTimeout(declutter, 60); };
  map.on('moveend', declutterSoon);
  window.addEventListener('resize', declutterSoon);
  window.htDeclutter = declutterSoon; // wx.js calls this when its labels change
  setInterval(declutter, 5000);        // text inside labels changes as data arrives

  // ---------------- overview (zoomed out): one summary per region ----------------
  const CODE_RANK = { TSTM: 9, ICE: 8, SNOW: 7, RAIN: 5, SHWR: 4, FOG: 3, WIND: 3, HAZE: 2, CLDY: 1, PCLD: 1, SUN: 0, CLR: 0, '---': -1 };
  const inBox = (lat, lon, [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n;
  let lastOverview = null;
  const regionChips = C.regions.filter((r) => r.bounds).map((r) => {
    const el = document.createElement('div');
    el.className = 'wx-mk rg-chip';
    el.addEventListener('click', () => { store.set('ht.region', r.id); showRegion(r.id); });
    const [w, s, e, n] = r.bounds;
    return { r, el, m: new maplibregl.Marker({ element: el, anchor: r.a || 'center' }).setLngLat(r.chip || [(w + e) / 2, (s + n) / 2]).addTo(map) };
  });
  function regionSummary(r) {
    const towns = C.towns.filter((t) => inBox(t.lat, t.lon, r.bounds) && state.wx[t.id]);
    const temps = towns.map((t) => state.wx[t.id].temp);
    const codes = towns.map((t) => wxCode(state.wx[t.id].f, state.wx[t.id].day));
    const worst = codes.sort((a, b) => (CODE_RANK[b] ?? 0) - (CODE_RANK[a] ?? 0))[0] || '---';
    const roads = state.roads.filter((x) => x.lat && inBox(x.lat, x.lon, r.bounds));
    const zones = new Set(C.towns.filter((t) => inBox(t.lat, t.lon, r.bounds)).flatMap((t) => state.zonesByTown[t.id] || []));
    const wxAlerts = state.nws.filter((a) => (a.affectedZones || []).some((z) => zones.has(z)));
    return { temps, worst, closures: roads.filter((x) => x.kind === 'closure'), alerts: roads.filter((x) => x.kind !== 'closure'), wxAlerts };
  }
  const tempRange = (t) => !t.length ? '--°' : Math.min(...t) === Math.max(...t) ? `${t[0]}°` : `${Math.min(...t)}–${Math.max(...t)}°`;
  const counts = (s) => (s.closures.length ? `<span class="x">✕${s.closures.length}</span> ` : '') +
    (s.alerts.length ? `<span class="a">△${s.alerts.length}</span> ` : '') +
    (s.wxAlerts.length ? `<span class="a">⚠${s.wxAlerts.length}</span>` : '') ||
    '<span class="ok">ROADS CLEAR</span>';
  function renderOverview() {
    for (const { r, el } of regionChips) {
      const s = regionSummary(r);
      el.classList.toggle('bad', s.closures.length > 0);
      el.innerHTML = `<span class="nm">${esc(r.name.toUpperCase())}</span><span class="t">${s.temps.length ? tempSpan(Math.max(...s.temps), tempRange(s.temps)) : tempRange(s.temps)}</span><span class="c">${s.worst}</span><span class="k">${counts(s).replace('ROADS CLEAR', 'CLEAR')}</span>`;
    }
    const box = $('#overview');
    if (!box) return;
    if (!lastOverview) { box.innerHTML = ''; return; }
    box.innerHTML = `<h2>REGION OVERVIEW</h2><ul class="list">${regionChips.map(({ r }) => {
      const s = regionSummary(r);
      const top = s.closures[0] || s.alerts.find((a) => a.kind === 'collision') || s.alerts[0];
      return `<li class="clickable ${s.closures.length ? 'k-closure' : s.alerts.length ? 'k-work' : ''}" data-r="${r.id}">
        <span><span class="rg">${esc(r.name.toUpperCase())}</span> · ${s.temps.length ? tempSpan(Math.max(...s.temps), tempRange(s.temps)) : tempRange(s.temps)} ${s.worst}</span><span class="cnt">${counts(s)}</span>
        ${s.wxAlerts.length ? `<span class="m">⚠ ${esc([...new Set(s.wxAlerts.map((a) => a.event.toUpperCase()))].join(' · '))}</span>` : ''}
        ${top ? `<span class="m">${esc(kindLabel[top.kind])}: ${esc(top.headline.slice(0, 110))}${top.headline.length > 110 ? '…' : ''}</span>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  $('#overview').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-r]'); if (!li) return;
    store.set('ht.region', li.dataset.r);
    showRegion(li.dataset.r);
  });

  // zoomed out, alerts that would sit on top of each other merge into one triangle with a count
  const groupMarkers = [];
  function groupAlerts() {
    groupMarkers.splice(0).forEach((m) => m.remove());
    const items = roadMarkers.filter((x) => x.kind !== 'closure');
    items.forEach((x) => (x.el.style.display = ''));
    if (map.getZoom() >= 10.5) return;
    const pts = items.map((x) => ({ x, p: map.project(x.m.getLngLat()) }));
    const used = new Set();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const grp = [i];
      for (let j = i + 1; j < pts.length; j++) {
        if (!used.has(j) && Math.hypot(pts[i].p.x - pts[j].p.x, pts[i].p.y - pts[j].p.y) < 34) grp.push(j);
      }
      if (grp.length < 2) continue;
      grp.forEach((k) => { used.add(k); pts[k].x.el.style.display = 'none'; });
      const lls = grp.map((k) => pts[k].x.m.getLngLat());
      const at = [lls.reduce((s, l) => s + l.lng, 0) / lls.length, lls.reduce((s, l) => s + l.lat, 0) / lls.length];
      const el = document.createElement('div');
      el.className = `inc-mk group${grp.some((k) => pts[k].x.kind === 'work') ? ' work' : ''}`;
      el.innerHTML = triSvg(String(grp.length));
      el.title = `${grp.length} alerts here: click to zoom in`;
      el.addEventListener('click', () => {
        const b = new maplibregl.LngLatBounds(); lls.forEach((l) => b.extend(l));
        map.fitBounds(b, { padding: fitPad(90), maxZoom: 12.5 });
      });
      groupMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map));
    }
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
    // tsunami alerts get their own banner from seis.js, so they're left out of this list
    const list = state.nws.filter((a) => (a.affectedZones || []).some((z) => zones.has(z)) && !/tsunami/i.test(a.event || ''));
    const alertedTowns = new Set(list.flatMap((a) => townsForZones(a.affectedZones || []).map((t) => t.id)));
    for (const [id, { el }] of Object.entries(wxMarkers)) el.classList.toggle('alerted', alertedTowns.has(id));
    // PERIL count: weather warnings plus tsunami alerts and strong nearby quakes (from seis.js)
    window.htPerilRefresh = () => { $('#nAlerts').textContent = (list.length + (window.htPerilExtra || 0) + (window.htPerilFlood || 0) + (window.htPerilTide || 0)) || ''; };
    window.htPerilRefresh();
    // WX ALERTS instrument: the whole area
    const allZones = new Set(Object.values(state.zonesByTown).flat());
    const areaAlerts = state.nws.filter((a) => (a.affectedZones || []).some((z) => allZones.has(z)));
    $('#insWx').innerHTML = areaAlerts.length ? `<span class="a">⚠${areaAlerts.length}</span>` : '<span class="ok">NONE</span>';
    $('#insWxSub').textContent = [...new Set(areaAlerts.map((a) => a.event.toUpperCase()))].join(' · ');
    $('#alertList').innerHTML = list.length ? list.map((a) => {
      const towns = townsForZones(a.affectedZones || []).map((t) => t.name);
      return `<li class="sev-${esc(a.severity)}"><div class="t">${esc(a.event.toUpperCase())}</div>
        <div class="m">${towns.length ? esc(towns.join(', ')) + ' · ' : ''}UNTIL ${esc(fmtWhen(a.ends || a.expires))}</div>
        ${TV ? '' : `<details><summary class="m">DETAILS</summary><p class="m">${esc(a.description).replace(/\n\n/g, '<br><br>')}</p></details>`}</li>`;
    }).join('') : `<li class="empty">NO WEATHER ALERTS ${corridor() ? 'ON ROUTE' : 'IN REGION'}</li>`;
  }

  const midpoint = (path) => path[Math.floor(path.length / 2)];
  const alertHtml = (r) => `<h3>${esc(kindLabel[r.kind])} · ${esc(r.roadLabel)}${r.milepost ? ' MP ' + esc(r.milepost) : ''}${r.direction && r.direction !== 'B' ? ' ' + esc(r.direction) + 'B' : ''}</h3>
    <p>${esc(r.headline.replace(/\s*More info\.?$/i, ''))}</p>${r.description ? `<p class="m">${esc(r.description)}</p>` : ''}
    <div class="m">${esc(r.category || '')}${r.start ? ` · SINCE ${esc(fmtWhen(r.start))}` : ''}${r.end ? ` · UNTIL ${esc(fmtWhen(r.end))}` : ''}${r.link && /^https:/.test(r.link) ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener">WSDOT DETAILS</a>` : ''}</div>`;

  // the stretches themselves are clickable (the wide glow layer makes an easy target, even on a phone)
  const flowText = ['NO DATA', 'WIDE OPEN', 'MODERATE', 'HEAVY', 'STOP AND GO'];
  const linePopup = new maplibregl.Popup({ offset: 6, maxWidth: '320px' });
  map.on('click', (e) => {
    if (!map.getLayer('inc-glow')) return;
    // a tap on a marker also reaches the map; the marker handles it, so don't open a second popup
    if (e.originalEvent?.target?.closest?.('.maplibregl-marker')) return;
    const box = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    const inc = map.queryRenderedFeatures(box, { layers: ['inc-glow', 'inc'] });
    // closures first when stretches overlap
    const hit = inc.sort((a, b) => (b.properties.kind === 'closure') - (a.properties.kind === 'closure'))[0];
    if (hit) {
      // a stretch opens its own marker's popup, so there's only ever one
      const rm = roadMarkers.find((x) => x.id === hit.properties.id);
      if (!rm) return;
      if (rm.el.style.display === 'none') {
        // merged into a group: zoom in until it stands alone, then open it
        const r = state.roads.find((x) => x.id === hit.properties.id);
        const b = new maplibregl.LngLatBounds(); (r?.path || [[r.lon, r.lat]]).forEach((p) => b.extend(p));
        map.once('moveend', () => setTimeout(() => { if (!rm.m.getPopup().isOpen()) rm.m.togglePopup(); }, 50));
        map.fitBounds(b, { padding: fitPad(80), maxZoom: 13, minZoom: 10.6 });
      } else if (!rm.m.getPopup().isOpen()) rm.m.togglePopup();
      return;
    }
    const fl = map.queryRenderedFeatures(box, { layers: ['flow-glow', 'flow'] })[0];
    if (fl) {
      const p = fl.properties;
      linePopup.setLngLat(e.lngLat).setHTML(`<h3>I-5 ${esc(p.dir)} · MP ${esc(p.mp)}</h3>
        <p style="color:${esc(p.color)}">${flowText[p.level]}</p><div class="m">LIVE WSDOT SENSOR · UPDATED ${esc(fmtWhen(state.flowUpdated))}</div>`).addTo(map);
    }
  });
  for (const id of ['inc-glow', 'flow-glow', 'flow']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  // closure: a pixel-art X on an 11x11 grid, two blocks thick, hard edges
  const X_RED = '#d11a2a';
  const X_SVG = (() => {
    const cells = new Set();
    for (let i = 0; i < 11; i++) for (const x of [i, i + 1, 10 - i, 9 - i]) if (x >= 0 && x <= 10) cells.add(`${x},${i}`);
    const rects = [...cells].map((c) => { const [x, y] = c.split(','); return `<rect x="${x}" y="${y}" width="1" height="1"/>`; }).join('');
    return `<svg viewBox="0 0 11 11" shape-rendering="crispEdges" aria-hidden="true"><g fill="${X_RED}">${rects}</g></svg>`;
  })();
  // hollow orange warning triangle for every other alert
  const triSvg = (mark) => `<svg viewBox="0 0 28 26" aria-hidden="true"><polygon points="14,2 26,24 2,24" fill="rgba(0,0,0,.55)"
    stroke="${K.orange}" stroke-width="2.6" stroke-linejoin="miter"/>${mark ? `<text x="14" y="21" text-anchor="middle" fill="${K.orange}"
    font-family="Share Tech Mono, monospace" font-size="${mark.length > 1 ? 11 : 13}" font-weight="700">${mark}</text>` : ''}</svg>`;

  // closure and road-work stretches breathe in step with the markers (about 15 frames a second is plenty)
  let pulseLast = 0;
  const pulse = (t) => {
    // (paused in the bus chase view, which redraws the map every frame already)
    if (t - pulseLast > 66 && map.getLayer('inc-glow') && !document.body.classList.contains('chase')) {
      pulseLast = t;
      const s = (Math.sin(t / 1800 * Math.PI * 2) + 1) / 2; // 0..1 over 1.8 s, like the CSS pulse
      map.setPaintProperty('inc-glow', 'line-opacity',
        ['match', ['get', 'kind'], ['closure', 'work'], 0.2 + 0.6 * s, 0.5]);
      map.setPaintProperty('inc', 'line-opacity',
        ['match', ['get', 'kind'], ['closure', 'work'], 0.6 + 0.4 * s, 1]);
    }
    requestAnimationFrame(pulse);
  };
  requestAnimationFrame(pulse);
  function renderRoads() {
    roadMarkers.splice(0).forEach(({ m }) => m.remove());

    // stretches on the map
    const features = state.roads.filter((r) => Array.isArray(r.path) && r.path.length > 1).map((r) => ({
      type: 'Feature', properties: { id: r.id, kind: r.kind, color: kindColor[r.kind] || K.dim },
      geometry: { type: 'LineString', coordinates: r.path } }));
    // closures draw on top
    features.sort((a, b) => (a.properties.kind === 'closure') - (b.properties.kind === 'closure'));
    setSource('incidents', { type: 'FeatureCollection', features });

    for (const r of state.roads) {
      if (!r.lat) continue;
      const el = document.createElement('div');
      // one X-shaped outline, so the arms don't show a seam where they cross
      if (r.kind === 'closure') { el.className = 'x-mk'; el.innerHTML = X_SVG; }
      else { el.className = `inc-mk ${r.kind}`; el.innerHTML = triSvg(r.kind === 'collision' ? '!' : ''); }
      const at = Array.isArray(r.path) && r.path.length > 1 ? midpoint(r.path) : [r.lon, r.lat];
      const m = new maplibregl.Marker({ element: el }).setLngLat(at).setPopup(popup(alertHtml(r))).addTo(map);
      roadMarkers.push({ el, m, kind: r.kind, id: r.id });
    }
    showByZoom();
    renderOverview();
    renderRoadList();
  }

  // is an alert (its stretch or its point) inside the part of the map the viewer can see?
  function onScreen(r) {
    const b = map.getBounds();
    // on a phone the bottom sheet covers part of the map: only count what's above it
    const sheet = $('#panel'), mapEl = map.getContainer();
    if (sheet && window.innerWidth <= 760) {
      const covered = mapEl.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top;
      if (covered > 0) b.setSouthWest([b.getWest(), map.unproject([0, mapEl.clientHeight - covered]).lat]);
    }
    const pts = Array.isArray(r.path) && r.path.length > 1 ? r.path : r.lat ? [[r.lon, r.lat]] : [];
    return pts.some((p) => b.contains(p));
  }

  function renderRoadList() {
    let list = TV ? state.roads.slice() : state.roads.filter(onScreen);
    const elsewhere = state.roads.length - list.length;
    if (state.me) list = list.map((r) => ({ ...r, dist: r.lat ? miles(state.me, r) : null })).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    else list = list.slice().sort((a, b) => ['closure', 'collision', 'work', 'other'].indexOf(a.kind) - ['closure', 'collision', 'work', 'other'].indexOf(b.kind));

    $('#nRoads').textContent = list.filter((r) => r.kind === 'closure' || r.kind === 'collision').length || '';
    // ROADS instrument: the whole area, whatever is on screen
    const allC = state.roads.filter((r) => r.kind === 'closure'), allA = state.roads.filter((r) => r.kind !== 'closure');
    const topR = allC[0] || state.roads.find((r) => r.kind === 'collision') || allA[0];
    $('#insRoads').innerHTML = !state.roads.length ? '<span class="ok">ALL CLEAR</span>'
      : `${allC.length ? `<span class="x">✕${allC.length}</span> ` : ''}<span class="a">△${allA.length}</span>`;
    $('#insRoadsSub').textContent = topR ? `${topR.roadLabel}${topR.milepost ? ' MP ' + topR.milepost : ''}: ${topR.headline}` : '';
    $('#insRoadsSync').textContent = state.roadsUpdated ? fmtTime(new Date(state.roadsUpdated)).toUpperCase() : '';
    const stale = state.roadsUpdated ? `WSDOT SYNC ${fmtWhen(state.roadsUpdated)}` : 'WSDOT FEED OFFLINE';
    $('#roadList').innerHTML = (list.length ? list.map((r, i) => `<li class="clickable k-${r.kind}" data-i="${i}">
        <div class="t"><span class="tag ${r.kind}">${kindLabel[r.kind]}</span>${esc(r.headline)}</div>
        <div class="m">${esc(r.roadLabel || r.road)}${r.milepost ? ' MP ' + esc(r.milepost) : ''}${r.dist != null ? ` · ${r.dist.toFixed(1)} MI AWAY` : ''}</div></li>`).join('')
      : `<li class="empty">NO CLOSURES OR INCIDENTS${TV ? '' : ' ON SCREEN'}</li>`) +
      (elsewhere > 0 ? `<li class="empty m" style="border:0;padding:2px 0">${elsewhere} MORE ELSEWHERE · PAN OR ZOOM OUT TO SEE THEM</li>` : '') +
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
      const { blocked, issues, vessel } = bridgeStatus(b);
      const pill = issues.length ? '<span class="pill bad">WSDOT ALERT</span>'
        : vessel ? '<span class="pill bad">VESSEL NEAR · MAY OPEN</span>'
        : blocked ? `<span class="pill ok">DOWN TILL ${fmtTime(new Date(`${new Date().toDateString()} ${blocked}`)).toUpperCase()}</span>`
        : '<span class="pill">OPENS ON REQUEST</span>';
      const vesselLine = vessel ? `${vessel} is close to the bridge; it may open soon.` : '';
      const html = `<h3>▲ ${esc(b.name)}</h3><div class="m">${esc(b.route)} · ${esc(b.town)}</div><p class="m">${esc(b.note)}</p>` +
        (vessel ? `<p style="color:var(--orange)">⚠ ${esc(vesselLine)}</p>` : '') + issues.map((r) => `<p>${esc(r.headline)}</p>`).join('');
      bridgeMarkers[b.id].m.getPopup().setHTML(html);
      bridgeMarkers[b.id].el.classList.toggle('shut', !!issues.length || !!vessel);
      b._issue = !!issues.length || !!vessel;
      const cam = camById[b.cam];
      return `<li class="clickable ${issues.length || vessel ? 'k-closure' : ''}" data-b="${b.id}"><div class="t">${esc(b.name.toUpperCase())} ${pill}</div>
        <div class="m">${esc(b.route)} · ${esc(b.town.toUpperCase())}</div>${vessel ? `<div class="m">⚠ ${esc(vesselLine)}</div>` : ''}${issues.map((r) => `<div class="m">${esc(r.headline)}</div>`).join('')}
        ${cam && !TV ? `<button type="button" class="cam-show" data-cam="${cam.id}">◉ SHOW CAMERA</button><div class="cam-slot"></div>` : ''}</li>`;
    }).join('');
    const bad = C.bridges.filter((b) => b._issue).length;
    bridgeChip.classList.toggle('shut', bad > 0);
    bridgeChip.querySelector('.v').textContent = bad ? `▲ ${bad} BRIDGE ALERT${bad > 1 ? 'S' : ''}` : state.roadsUpdated ? '▲ BRIDGES OK' : '▲ BRIDGES';
  }
  window.htRenderBridges = () => renderBridges();
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
        <span class="temp">${tempSpan(w.temp)}</span></li>`;
    }).join('');
    const rw = state.roadWx || [];
    $('#roadWxList').innerHTML = rw.length ? rw.map((s) => `<li><span>${esc(s.name.toUpperCase())}<br><span class="m">WIND ${esc(s.dir || '')} ${s.wind ?? '?'} MPH${s.gust ? ` G${s.gust}` : ''}${s.precip ? ` · ${s.precip}" PRECIP` : ''}</span></span>
      <span class="temp">${s.temp != null ? tempSpan(Math.round(s.temp)) : '–'}</span></li>`).join('') : '<li class="empty">NO ROADSIDE READINGS</li>';
  }

  // the road list follows the map: when it settles after a pan or zoom, list what's on screen
  let roadListTimer = 0;
  map.on('moveend', () => { clearTimeout(roadListTimer); roadListTimer = setTimeout(renderRoadList, 250); });

  // ---------------- tabs & sheet ----------------
  const panel = $('#panel');
  // the handle shows a fat chevron: up while tapping will raise the sheet, down once it's all the way up
  const handle = $('#sheetHandle');
  const syncHandle = () => {
    const up = !panel.classList.contains('max');
    handle.classList.toggle('down', !up);
    handle.setAttribute('aria-label', up ? 'Raise the details' : 'Lower the details');
  };
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    panel.classList.remove('min', 'gone');
    syncHandle();
  }));
  $('#tab-roads').classList.add('on');
  handle.innerHTML = '<svg viewBox="0 0 40 14" aria-hidden="true"><path d="M4 11 L20 3 L36 11" fill="none" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"/></svg>';
  // the handle cycles: half → full → tucked away (only the handle showing) → half (small counts as half).
  // Swiping on the handle works too (down to lower, up to raise).
  const setSheet = (s) => { panel.classList.remove('min', 'max', 'gone'); if (s) panel.classList.add(s); syncHandle(); };
  const sheetState = () => (['gone', 'min', 'max'].find((c) => panel.classList.contains(c)) || '');
  handle.addEventListener('click', () => {
    const s = sheetState();
    setSheet(s === 'max' ? 'gone' : s === 'gone' ? '' : 'max');
  });
  let swipeY = null;
  handle.addEventListener('touchstart', (e) => { swipeY = e.touches[0].clientY; }, { passive: true });
  handle.addEventListener('touchend', (e) => {
    if (swipeY == null) return;
    const dy = e.changedTouches[0].clientY - swipeY; swipeY = null;
    if (Math.abs(dy) < 30) return; // a tap: the click handles it
    e.preventDefault(); // (no click after a swipe)
    const s = sheetState();
    if (dy > 0) setSheet(s === 'max' ? '' : 'gone');
    else setSheet(s === 'gone' || s === 'min' ? '' : 'max');
  });
  syncHandle();

  // the top instrument panel can be hidden for more map (the little tab at the top of the map brings it back)
  const setTop = (hide) => {
    document.body.classList.toggle('no-top', hide);
    $('#topToggle').setAttribute('aria-label', hide ? 'Show the instruments' : 'Hide the instruments');
    store.set('ht.noTop', hide);
    setTimeout(() => map.resize(), 50);
  };
  $('#topToggle').addEventListener('click', () => setTop(!document.body.classList.contains('no-top')));
  if (!TV && store.get('ht.noTop') === true) setTop(true);

  // phones: tap an instrument to blow it up over the whole instrument panel (for reading it easily); tap again
  // to put it back
  const instruments = $('.instruments');
  instruments?.addEventListener('click', (e) => {
    if (!phone() || TV || e.target.closest('#clockFmt')) return;
    const inst = e.target.closest('.inst'); if (!inst) return;
    e.stopPropagation(); e.preventDefault(); // (instead of the instrument's own tap, like the sea opening its tab)
    const open = instruments.querySelector('.inst.zoomed');
    if (open) { open.classList.remove('zoomed'); open.style.width = open.style.height = ''; }
    if (open === inst) return;
    // the instrument is drawn at half the panel's size and doubled, so it covers the panel exactly
    const r = instruments.getBoundingClientRect();
    inst.style.width = r.width / 2 + 'px'; inst.style.height = r.height / 2 + 'px';
    inst.classList.add('zoomed');
  }, true);
  // open a tab from elsewhere (the SEA instrument): pick the tab, raise the sheet on phones, start at the top
  window.htOpenTab = (name) => {
    document.querySelector(`.tabs button[data-tab="${name}"]`)?.click();
    if (phone()) { panel.classList.remove('min', 'gone'); panel.classList.add('max'); syncHandle(); }
    panel.scrollTop = 0;
  };

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
    cone.style.transform = `rotate(calc(${h}deg - var(--brg, 0deg)))`;
  }
  $('#btnLocate').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return alert('This browser cannot share location.');
    if (watching && state.me) return map.flyTo({ center: [state.me.lon, state.me.lat], zoom: 12 });
    watching = true;
    $('#btnLocate').classList.add('on');
    let first = true;
    navigator.geolocation.watchPosition((p) => {
      state.me = { lat: p.coords.latitude, lon: p.coords.longitude };
      // for bus.js: am I riding a bus? (position, speed in m/s if the phone knows it, and when)
      window.htMe = { lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, acc: p.coords.accuracy, t: Date.now() };
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

  // ---------------- bigger text (the Aa button; remembered per device) ----------------
  // Labels and tags drawn by the page get bigger through CSS; the map's own text (road names, route numbers
  // on the highway shields, places) is resized in the map style.
  const BIG = 1.35;
  const textSizes = {};
  const scaleSize = (v, f) => {
    if (typeof v === 'number') return v * f;
    if (Array.isArray(v) && v[0] === 'interpolate') return v.map((x, i) => (i > 3 && i % 2 === 1 && typeof x === 'number' ? x * f : x));
    if (Array.isArray(v) && v[0] === 'step') return v.map((x, i) => ((i === 2 || (i > 2 && i % 2 === 0)) && typeof x === 'number' ? x * f : x));
    if (v && Array.isArray(v.stops)) return { ...v, stops: v.stops.map(([z, s]) => [z, s * f]) };
    return v;
  };
  function applyBigText(on) {
    document.body.classList.toggle('big-text', on);
    const btn = $('#btnBig');
    if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on); }
    // (not map.isStyleLoaded(): that's false whenever tiles are still loading, which would skip this)
    let layers = [];
    try { layers = map.getStyle()?.layers || []; } catch { return; }
    for (const l of layers) {
      if (l.type !== 'symbol' || !l.layout?.['text-field']) continue;
      if (!(l.id in textSizes)) textSizes[l.id] = map.getLayoutProperty(l.id, 'text-size') ?? 16;
      try { map.setLayoutProperty(l.id, 'text-size', on ? scaleSize(textSizes[l.id], BIG) : textSizes[l.id]); } catch {}
    }
    window.htDeclutter?.();
  }
  let bigText = !TV && store.get('ht.bigText') === true;
  $('#btnBig')?.addEventListener('click', () => { bigText = !bigText; store.set('ht.bigText', bigText); applyBigText(bigText); });
  if (bigText) { document.body.classList.add('big-text'); if (map.loaded()) applyBigText(true); else map.once('load', () => applyBigText(true)); }

  // ---------------- clock & refresh ----------------
  // the switch under LIVE flips every time on the page between 12- and 24-hour (see window.htClock24 above)
  const tick = () => {
    const d = new Date();
    $('#clock').innerHTML = window.htClock24 ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${(d.getHours() % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')}<small>${d.getHours() < 12 ? 'AM' : 'PM'}</small>`;
    $('#clockFmt').textContent = window.htClock24 ? '24H' : '12H';
  };
  let lastSync = null;
  const showSync = () => { if (lastSync) $('#updated').textContent = 'SYNC ' + fmtTime(lastSync).toUpperCase(); };
  $('#clockFmt').addEventListener('click', () => {
    window.htClock24 = !window.htClock24; store.set('ht.clock24', window.htClock24);
    tick(); showSync();
    // redraw what's on screen with the new times; the rest catches up on its next refresh
    renderRoads(); renderBridges(); renderAlerts();
    window.dispatchEvent(new Event('ht:clock'));
  });
  tick(); setInterval(tick, 10000);
  async function refresh() {
    await Promise.allSettled([loadWeather(), loadAlerts(), loadRoads(), loadRoadWeather(), loadFlow()]);
    window.htTickerRefresh();
    lastSync = new Date(); showSync();
  }
  // ---------------- TV: scrolling ticker and a side panel that scrolls itself ----------------
  window.htTicker = window.htTicker || {}; // wx.js adds tide, wind, sea, rail and sun lines here
  let tickerSig = '';
  function renderTicker() {
    if (!TV) return;
    const items = [];
    const add = (cls, label, text) => items.push(`<span class="ti ${cls}"><b>${esc(label)}</b> ${esc(text)}</span>`);
    for (const r of state.roads.filter((x) => x.kind === 'closure')) add('x', '✕ CLOSED', `${r.roadLabel}${r.milepost ? ' MP ' + r.milepost : ''}: ${r.headline.slice(0, 120)}`);
    for (const r of state.roads.filter((x) => x.kind === 'collision')) add('a', '! INCIDENT', `${r.roadLabel}: ${r.headline.slice(0, 120)}`);
    const allZones = new Set(Object.values(state.zonesByTown).flat());
    for (const a of state.nws.filter((x) => (x.affectedZones || []).some((z) => allZones.has(z))))
      add('a', `⚠ ${a.event.toUpperCase()}`, `until ${fmtWhen(a.ends || a.expires)}`);
    const t = window.htTicker;
    if (t.tsunami) add('x', '🌊 TSUNAMI', t.tsunami);
    if (t.quake) add('a', '⚠ QUAKE', t.quake);
    if (t.flood) add('x', '🌊 FLOOD', t.flood);
    if (t.lowtide) add('w', '〰 TIDE', t.lowtide);
    if (t.bridge) add('a', '⚠ BRIDGE', t.bridge);
    if (t.air) add('a', '✈ AIR', t.air);
    if (t.bus) add('a', '🚌 BUS', t.bus);
    if (t.rail) add('r', '⚠ RAIL', t.rail);
    if (t.sea) add('c', 'BAR', t.sea);
    // (the TV has no side panel, so the ticker carries what the panel would: every road alert, every travel
    // time, and the weather town by town)
    for (const r of state.roads.filter((x) => x.kind === 'work' || x.kind === 'other'))
      add('w', r.kind === 'work' ? '△ WORK' : '△ ALERT', `${r.roadLabel || r.road}${r.milepost ? ' MP ' + r.milepost : ''}: ${r.headline.slice(0, 100)}`);
    for (const r of state.travel || []) {
      if (!r.now) continue;
      const slow = r.avg && r.now > r.avg * 1.25;
      add(slow ? 'a' : 'c', slow ? 'SLOW' : 'DRIVE', `${r.name.replace(/^\w+\s/, '')} ${r.now} min${r.avg ? ` (normal ${r.avg})` : ''}`);
    }
    const wx = C.towns.filter((tw) => !tw.minor && state.wx[tw.id]?.temp != null)
      .map((tw) => `${tw.name} ${state.wx[tw.id].temp}° ${wxCode(state.wx[tw.id].f)}`);
    if (wx.length) add('c', 'WX', wx.join(' · '));
    if (t.tide) add('c', 'TIDE', t.tide);
    if (t.wind) add('c', 'WIND', t.wind);
    if (t.sun) add('c', 'SUN', t.sun);
    if (!state.roads.some((x) => x.kind === 'closure' || x.kind === 'collision')) add('ok', 'ROADS', 'no closures or collisions reported');
    const html = items.join('<i class="sep">◆</i>');
    if (html === tickerSig) return; // unchanged: don't restart the scroll
    tickerSig = html;
    const track = $('#ticker');
    track.innerHTML = `<div class="tk">${html}<i class="sep">◆</i></div><div class="tk">${html}<i class="sep">◆</i></div>`;
    const w = track.firstElementChild.getBoundingClientRect().width;
    track.style.animationDuration = `${Math.max(20, w / 90)}s`; // about 90 px a second
  }
  window.htTickerRefresh = () => { clearTimeout(renderTicker._t); renderTicker._t = setTimeout(renderTicker, 400); };
  if (TV) {
    setInterval(renderTicker, 60 * 1000);
    // the side panel scrolls down slowly, rests at the bottom, then starts again from the top
    let hold = 0;
    setInterval(() => {
      const p = $('#panel');
      if (p.scrollHeight <= p.clientHeight + 4) return;
      if (hold > 0) { hold--; return; }
      if (p.scrollTop + p.clientHeight >= p.scrollHeight - 2) { hold = 60; setTimeout(() => { p.scrollTop = 0; hold = 60; }, 3000); return; }
      p.scrollTop += 1;
    }, 50);
  }

  loadCameras(); // the list only; images wait for a click
  // show/hide road warnings: closures, alert triangles and their stretches (on by default; remembered per device;
  // ?roads=0 hides them). The I-5 speed colors stay.
  let roadsOn = qs.has('roads') ? qs.get('roads') !== '0' : store.get('ht.roads') !== false;
  function setRoads(on) {
    roadsOn = on; store.set('ht.roads', on);
    const btn = $('#btnRoads');
    btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on);
    document.body.classList.toggle('no-roads', !on);
    const apply = () => ['inc', 'inc-glow'].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
    declutterSoon();
  }
  $('#btnRoads').addEventListener('click', () => setRoads(!roadsOn));
  setRoads(roadsOn);

  // (rail crossings used to be drawn here; removed to keep the map clear. The collector still keeps
  // data/crossings.json for the future train sensor project.)
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
  setInterval(renderBridges, 60 * 1000);
  if (TV) setTimeout(() => location.reload(), 6 * 60 * 60 * 1000); // keeps a TV browser from bogging down

  // pick up new versions on their own: publish.ps1 writes the build stamp to version.txt and into the
  // ?v= of every script. When they differ, reload at a new address so no cached copy is reused.
  const BUILD = (document.querySelector('script[src*="app.js"]')?.src.match(/[?&]v=(\w+)/) || [])[1];
  let lastCheck = 0;
  async function checkVersion() {
    if (Date.now() - lastCheck < 60000) return; // at most once a minute
    lastCheck = Date.now();
    try {
      const v = (await (await fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' })).text()).trim();
      if (BUILD && /^\w+$/.test(v) && v !== BUILD) {
        const q = new URLSearchParams(location.search);
        q.set('build', v);
        location.replace(`${location.pathname}?${q}`);
      }
    } catch {}
  }
  setInterval(checkVersion, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); }); // phone brought back up
})();
