// Weather visuals: NEXRAD radar overlay, the sky icon by the clock, and forecast-zone weather effects
// (dotted zone outlines with rain/snow/hail/wind/fog particles and lightning). Reads the map from app.js
// (window.htMap) and the forecast from its 'ht:weather' event.
(() => {
  const map = window.htMap;
  if (!map) return;
  const qs = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // lines for the TV ticker (app.js builds the ticker from these)
  const tick = (key, text) => { window.htTicker = window.htTicker || {}; window.htTicker[key] = text; window.htTickerRefresh?.(); };
  const HOME = { lat: 46.9754, lon: -123.8157 }; // Aberdeen: where the sky icon is computed for
  const COLOR = { rain: '#00e5ff', snow: '#e8f6ff', hail: '#c9a6ff', storm: '#ff2bd6', fog: '#8fa8a8', wind: '#39ff88' };

  // ================= reading the forecast =================
  const RANK = { none: 0, fog: 1, rain: 2, snow: 3, hail: 4, storm: 5 };
  function classify(f = '', windMph = 0) {
    f = f.toLowerCase();
    let kind = 'none', level = 0;
    const lvl = (heavy, light) => (heavy.test(f) ? 3 : light.test(f) ? 1 : 2);
    if (/thunder|t-storm/.test(f)) { kind = 'storm'; level = /severe/.test(f) ? 3 : 2; }
    else if (/hail/.test(f)) { kind = 'hail'; level = 2; }
    else if (/snow|flurr|sleet|wintry|freezing/.test(f)) { kind = 'snow'; level = lvl(/heavy|blizzard/, /light|flurr|chance|slight|isolated|scattered|patchy/); }
    else if (/rain|shower|drizzle/.test(f)) { kind = 'rain'; level = lvl(/heavy/, /light|drizzle|chance|slight|isolated|scattered|patchy/); }
    else if (/fog|mist/.test(f)) { kind = 'fog'; level = /dense/.test(f) ? 3 : 2; }
    const wind = windMph >= 45 ? 3 : windMph >= 30 ? 2 : windMph >= 20 ? 1 : 0;
    const cloud = kind !== 'none' && kind !== 'fog' ? 2 : /overcast|cloudy/.test(f) && !/partly/.test(f) ? 2 : /partly|mostly sunny|mostly clear/.test(f) ? 1 : 0;
    return { kind, level, wind, cloud };
  }
  // NWS alerts can say more than the hourly text (wind warnings, dense fog, winter storms)
  function fromAlerts(zoneUrl, nws, c) {
    for (const a of nws || []) {
      if (!(a.affectedZones || []).includes(zoneUrl)) continue;
      const e = a.event || '';
      if (/High Wind Warning/.test(e)) c.wind = 3;
      else if (/Wind/.test(e)) c.wind = Math.max(c.wind, 2);
      if (/Thunderstorm/.test(e) && RANK[c.kind] < RANK.storm) { c.kind = 'storm'; c.level = /Warning/.test(e) ? 3 : 2; }
      if (/Winter Storm|Snow|Blizzard|Ice/.test(e) && RANK[c.kind] < RANK.snow) { c.kind = 'snow'; c.level = /Warning/.test(e) ? 3 : 2; }
      if (/Fog/.test(e) && c.kind === 'none') { c.kind = 'fog'; c.level = 3; }
    }
    return c;
  }
  // "SW" wind comes from the southwest, so it moves toward the northeast
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const windVector = (dir) => {
    const i = DIRS.indexOf(String(dir || '').toUpperCase());
    if (i < 0) return { x: 0.3, y: 0 };
    const to = (i * 22.5 + 180) * Math.PI / 180;
    return { x: Math.sin(to), y: -Math.cos(to) };
  };

  // ================= sky icon (sunrise / sun + weather / sunset / moon) =================
  // sunrise and sunset from the standard solar position formulas (as in SunCalc)
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, J0 = 0.0009, e = rad * 23.4397;
    const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
    const fromJ = (j) => new Date((j + 0.5 - J1970) * dayMs);
    const lw = rad * -lon, phi = rad * lat;
    const n = Math.round(toDays(date) - J0 - lw / (2 * Math.PI));
    const ds = J0 + lw / (2 * Math.PI) + n;
    const M = rad * (357.5291 + 0.98560028 * ds);
    const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const w = Math.acos((Math.sin(rad * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    const Jset = J2000 + J0 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return { rise: fromJ(Jnoon - (Jset - Jnoon)), set: fromJ(Jset) };
  }
  window.htSunTimes = sunTimes; // (the chase view turns bus headlights on after sunset)
  const moonPhase = (d) => (((d - 947182440000) / 864e5) % 29.530588853 + 29.530588853) % 29.530588853 / 29.530588853; // 0 new, .5 full

  let skyCond = { kind: 'none', level: 0, wind: 0, cloud: 0 };
  let moonName = '';
  function skySvg() {
    const now = new Date(), { rise, set } = sunTimes(now, HOME.lat, HOME.lon);
    const m = 60e3;
    const phase = now >= rise - 40 * m && now < +rise + 50 * m ? 'rise'
      : now >= set - 50 * m && now < +set + 40 * m ? 'set'
      : now > rise && now < set ? 'day' : 'night';
    const A = '#ffc400', Cy = '#00e5ff', Wt = '#c4ffe9';
    const g = (s) => `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${s}</g>`;
    let art = '';
    if (phase === 'rise' || phase === 'set') {
      const arrow = phase === 'rise' ? 'M24 3 L24 9 M21 6 L24 3 L27 6' : 'M24 3 L24 9 M21 6 L24 9 L27 6';
      art = g(`<path d="M13 24 A11 11 0 0 1 35 24" stroke="${A}" stroke-width="2"/>
        <path d="M6 24 H42" stroke="${Cy}" stroke-width="1.6"/><path d="M9 28 H39 M14 31 H34" stroke="${Cy}" stroke-width="1" stroke-dasharray="2 3"/>
        <path d="M8 17 L11 18.5 M40 17 L37 18.5 M13 10 L15.5 12.5 M35 10 L32.5 12.5" stroke="${A}" stroke-width="1.6"/>
        <path d="${arrow}" stroke="${A}" stroke-width="1.6"/>`);
    } else if (phase === 'day') {
      const rays = Array.from({ length: 8 }, (_, i) => {
        const a = i * Math.PI / 4, x1 = 17 + Math.cos(a) * 9, y1 = 14 + Math.sin(a) * 9, x2 = 17 + Math.cos(a) * 12.5, y2 = 14 + Math.sin(a) * 12.5;
        return `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`;
      }).join(' ');
      art = g(`<circle cx="17" cy="14" r="6" stroke="${A}" stroke-width="2"/><path d="${rays}" stroke="${A}" stroke-width="1.6"/>`);
    } else {
      // tonight's moon, as it looks from here: lit on the right while it waxes (new → full), on the left while it
      // wanes; the dark part a faint outline. The lit part is the half-disc on its lit side plus or minus the
      // terminator, a half-ellipse whose width follows the phase.
      const p = moonPhase(now), cx = 18, cy = 14, R = 9;
      const rx = (R * Math.abs(Math.cos(2 * Math.PI * p))).toFixed(2);
      const waxing = p < 0.5;
      // the edge on the lit side (top to bottom), then the terminator back up: it bulges toward the lit side while
      // a crescent, toward the dark side while gibbous
      const crescent = p < 0.25 || p > 0.75;
      const edge = waxing ? `A${R} ${R} 0 0 1 ${cx} ${cy + R}` : `A${R} ${R} 0 0 0 ${cx} ${cy + R}`;
      const term = `A${rx} ${R} 0 0 ${waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0)} ${cx} ${cy - R}`;
      const litPath = p < 0.02 || p > 0.98 ? '' : `<path d="M${cx} ${cy - R} ${edge} ${term} Z" fill="${Wt}" stroke="${Wt}" stroke-width=".8"/>`;
      art = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#020807" stroke="#5f9c8b" stroke-width="1.2" stroke-dasharray="1.5 1.5"/>${litPath}` +
        g(`<path d="M35 6 L35 9 M33.5 7.5 L36.5 7.5 M40 14 L40 16 M39 15 L41 15" stroke="${Cy}" stroke-width="1"/>`);
      moonName = p < 0.03 || p > 0.97 ? 'new moon' : p < 0.22 ? 'waxing crescent' : p < 0.28 ? 'first quarter' : p < 0.47 ? 'waxing gibbous'
        : p < 0.53 ? 'full moon' : p < 0.72 ? 'waning gibbous' : p < 0.78 ? 'last quarter' : 'waning crescent';
    }
    // weather laid over the sun or moon
    const c = skyCond;
    let over = '';
    if (c.cloud || c.kind !== 'none') {
      over += `<path d="M20 30 H40 A5 5 0 0 0 40 20 A7 7 0 0 0 27 18 A5.5 5.5 0 0 0 20 30 Z" fill="#020807" stroke="${Cy}" stroke-width="1.8" stroke-linejoin="round"/>`;
    }
    if (c.kind === 'rain' || c.kind === 'storm') {
      const n = c.level >= 3 ? 4 : c.level === 2 ? 3 : 2;
      over += Array.from({ length: n }, (_, i) => `<path d="M${24 + i * 5} 33 L${22 + i * 5} 38" stroke="${Cy}" stroke-width="1.5"/>`).join('');
    }
    if (c.kind === 'snow') over += [24, 30, 36].map((x, i) => `<circle cx="${x}" cy="${35 + (i % 2) * 2}" r="1.3" fill="${Wt}"/>`).join('');
    if (c.kind === 'hail') over += [24, 30, 36].map((x) => `<rect x="${x - 1.2}" y="34" width="2.4" height="2.4" fill="#c9a6ff"/>`).join('');
    if (c.kind === 'storm') over += `<path d="M31 29 L27 35 L31 35 L28 41" fill="none" stroke="#ff2bd6" stroke-width="1.8" stroke-linejoin="round"/>`;
    if (c.kind === 'fog') over += `<path d="M6 32 H30 M12 36 H40 M4 40 H26" stroke="#8fa8a8" stroke-width="1.6" stroke-dasharray="4 2"/>`;
    if (c.wind) over += `<path d="M2 19 H14 A3 3 0 1 0 11 16 M2 23 H18" fill="none" stroke="#39ff88" stroke-width="1.4" stroke-linecap="round"/>`;
    const label = { rise: 'SUNRISE', set: 'SUNSET', day: 'DAY', night: `NIGHT · ${moonName.toUpperCase()}` }[phase];
    const t = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#sky').innerHTML = `<svg viewBox="0 0 48 42" role="img" aria-label="${label}">${art}${over}</svg>`;
    // center whatever got drawn (a clear sky only fills the top of the box; rain and lightning reach the bottom),
    // keeping the same scale so the picture doesn't grow or shrink with the weather
    const skySvg = $('#sky svg');
    requestAnimationFrame(() => {
      try {
        const b = skySvg.getBBox();
        if (b.width && b.height) skySvg.setAttribute('viewBox', `${(b.x + b.width / 2 - 24).toFixed(2)} ${(b.y + b.height / 2 - 21).toFixed(2)} 48 42`);
      } catch {}
    });
    // SUN instrument
    const tt = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/i, '');
    const hm = (ms) => `${Math.floor(ms / 36e5)}:${String(Math.floor(ms % 36e5 / 6e4)).padStart(2, '0')}`;
    $('#insSun').innerHTML = `<span class="up">↑${tt(rise)}</span> <span class="dn">↓${tt(set)}</span>`;
    tick('sun', `sunrise ${t(rise)}, sunset ${t(set)}`);
    const nextRise = now < rise ? rise : sunTimes(new Date(+now + 864e5), HOME.lat, HOME.lon).rise;
    $('#insSunLeft').textContent = now > rise && now < set ? `${hm(set - now)} LEFT` : '';
    $('#insSunSub').textContent = now > rise && now < set ? `DAYLIGHT ${hm(set - rise)}` : `DARK · SUNRISE IN ${hm(nextRise - now)}`;
    $('#sky').title = `${label} · sunrise ${t(rise)} · sunset ${t(set)}`;
  }

  // ================= radar (Iowa State Mesonet NEXRAD composite; Langley Hill radar covers the coast) =================
  const RADAR_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
  let radarOn = qs.has('radar') ? qs.get('radar') !== '0' : !!store.get('ht.radar');
  const radarUrl = () => `${RADAR_TILES}?v=${Math.floor(Date.now() / 300000)}`; // new URL every 5 min = fresh frame
  function addRadar() {
    if (map.getSource('radar')) return;
    map.addSource('radar', { type: 'raster', tiles: [radarUrl()], tileSize: 256, maxzoom: 10,
      attribution: 'Radar: NWS NEXRAD via Iowa Environmental Mesonet' });
    map.addLayer({ id: 'radar', type: 'raster', source: 'radar',
      layout: { visibility: radarOn ? 'visible' : 'none' },
      paint: { 'raster-opacity': 0.62, 'raster-fade-duration': 0, 'raster-contrast': 0.15 } }, 'flow-glow');
  }
  async function radarTime() {
    try {
      const j = await (await fetch('https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json', { cache: 'no-store' })).json();
      const v = new Date(j.meta?.valid || j.valid);
      if (!isNaN(v)) return v.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {}
    return null;
  }
  async function setRadar(on) {
    radarOn = on;
    store.set('ht.radar', on);
    const btn = $('#btnRadar');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    if (map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', on ? 'visible' : 'none');
    btn.querySelector('.stamp').textContent = on ? (await radarTime() || 'LIVE') : '';
  }
  $('#btnRadar').addEventListener('click', () => setRadar(!radarOn));
  setInterval(() => {
    if (!radarOn || !map.getSource('radar')) return;
    map.getSource('radar').setTiles([radarUrl()]);
    radarTime().then((t) => { if (t) $('#btnRadar .stamp').textContent = t; });
  }, 5 * 60 * 1000);

  // ================= weather zones: dotted outlines + particles =================
  let fxOn = qs.has('fx') ? qs.get('fx') !== '0' : store.get('ht.fx') !== false;
  const zoneGeo = {};      // zone url -> GeoJSON geometry
  let zones = [];          // [{ url, cond, rings, path, box }]
  const empty = { type: 'FeatureCollection', features: [] };

  async function zoneGeometry(url) {
    if (zoneGeo[url]) return zoneGeo[url];
    const key = 'ht.zone.' + url.split('/').pop();
    let g = null;
    try { g = JSON.parse(sessionStorage.getItem(key)); } catch {}
    if (!g) {
      const j = await (await fetch(url, { headers: { Accept: 'application/geo+json' } })).json();
      g = j.geometry;
      try { sessionStorage.setItem(key, JSON.stringify(g)); } catch {}
    }
    return (zoneGeo[url] = g);
  }

  // forecast precipitation rate (mm per hour) right now at a town, from the NWS grid data.
  // The grid file is large, so each one is kept for 30 minutes.
  async function precipRate(townId, snow) {
    try {
      const pts = store.get('ht.points') || {};
      const hourly = pts[townId]?.hourly;
      if (!hourly) return null;
      const url = hourly.replace('/forecast/hourly', '');
      const key = 'ht.grid.' + url.split('/').slice(-2).join('.');
      let g = null;
      try { g = JSON.parse(sessionStorage.getItem(key)); } catch {}
      if (!g || Date.now() - g.at > 30 * 60 * 1000) {
        const j = await (await fetch(url, { headers: { Accept: 'application/geo+json' } })).json();
        const pick = (p) => (j.properties?.[p]?.values || []);
        g = { at: Date.now(), qpf: pick('quantitativePrecipitation'), snow: pick('snowfallAmount') };
        try { sessionStorage.setItem(key, JSON.stringify(g)); } catch {}
      }
      const now = Date.now();
      for (const v of snow ? g.snow : g.qpf) {
        const [start, dur] = v.validTime.split('/');
        const h = (+(dur.match(/(\d+)D/)?.[1] || 0)) * 24 + (+(dur.match(/(\d+)H/)?.[1] || 0)) || 1;
        const t0 = Date.parse(start);
        if (now >= t0 && now < t0 + h * 36e5) return (v.value || 0) / h;
      }
    } catch (e) { console.warn('precip rate', e); }
    return null;
  }

  const words = ['', 'LIGHT', 'MOD', 'HEAVY'];
  const kindWord = { rain: 'RAIN', snow: 'SNOW', hail: 'HAIL', storm: 'T-STORM', fog: 'FOG' };
  function zoneLabel(c) {
    const parts = [];
    if (c.kind !== 'none') parts.push(c.kind === 'storm' || c.kind === 'hail' ? kindWord[c.kind] : `${words[c.level]} ${kindWord[c.kind]}`);
    if (c.wind) parts.push(`WIND ${c.windMph ? c.windMph + ' MPH' : ''}`.trim());
    return parts.join(' · ');
  }

  async function updateZones({ wx, zonesByTown, nws, towns }) {
    // worst conditions among the towns in each NWS forecast zone
    const byZone = {};
    for (const t of towns) {
      const url = (zonesByTown[t.id] || [])[0], w = wx[t.id];
      if (!url || !w) continue;
      const c = classify(w.f, w.windMph);
      c.windMph = w.windMph; c.windDir = w.windDir; c.pop = w.rain; c.town = t.id;
      const z = byZone[url];
      if (!z) { byZone[url] = c; continue; }
      if (w.rain != null) z.pop = Math.max(z.pop ?? 0, w.rain);
      if (RANK[c.kind] > RANK[z.kind] || (c.kind === z.kind && c.level > z.level)) Object.assign(z, { kind: c.kind, level: c.level });
      if (c.wind > z.wind || (c.windMph || 0) > (z.windMph || 0)) Object.assign(z, { wind: Math.max(c.wind, z.wind), windMph: c.windMph, windDir: c.windDir });
      z.cloud = Math.max(z.cloud, c.cloud);
    }
    const next = [];
    for (const [url, c] of Object.entries(byZone)) {
      fromAlerts(url, nws, c);
      if (c.kind === 'none' && !c.wind && !SIM.length) continue;
      if (['rain', 'storm', 'snow', 'hail'].includes(c.kind) && !previewing) c.rate = await precipRate(c.town, c.kind === 'snow');
      try {
        const g = await zoneGeometry(url);
        if (!g) continue;
        const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
        next.push({ url, cond: c, geometry: g, rings, parts: [] });
      } catch (e) { console.warn('zone', url, e); }
    }
    // demo mode: ?sim=snow,storm takes turns across the forecast areas (for showing the effects off)
    if (SIM.length) {
      next.forEach((z, i) => Object.assign(z.cond, SIM_COND[SIM[i % SIM.length]] || {}, { rate: null, pop: 100 }));
    }
    zones = next;
    const color = (c) => COLOR[c.kind] || COLOR.wind;
    const fc = { type: 'FeatureCollection', features: zones.map((z) => ({ type: 'Feature', geometry: z.geometry,
      properties: { color: color(z.cond), label: zoneLabel(z.cond) } })) };
    // one label per zone, at the middle of its biggest piece (zones are made of many small islands)
    const labels = { type: 'FeatureCollection', features: zones.map((z) => {
      const ring = z.rings.reduce((a, b) => (b.length > a.length ? b : a), []);
      const at = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
      return { type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { color: color(z.cond), label: zoneLabel(z.cond) } };
    }) };
    if (map.getSource('wxzones')) { map.getSource('wxzones').setData(fc); map.getSource('wxlabels').setData(labels); }
    else pendingZones = [fc, labels];
    reproject();
    resetParticles();
    // the sky icon uses Aberdeen's own conditions
    const home = wx.aberdeen;
    if (home) { skyCond = SIM.length ? { ...SIM_COND[SIM[SIM.length - 1]], cloud: 2 } : classify(home.f, home.windMph); skySvg(); }
  }
  let pendingZones = null;
  let previewing = false; // htWx.preview() in use: skip the real precipitation rates
  const SIM = (qs.get('sim') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const SIM_COND = {
    rain: { kind: 'rain', level: 3, wind: 1, windMph: 24, windDir: 'SW' },
    snow: { kind: 'snow', level: 3, wind: 1, windMph: 20, windDir: 'W' },
    storm: { kind: 'storm', level: 3, wind: 2, windMph: 35, windDir: 'SW' },
    hail: { kind: 'hail', level: 2, wind: 1, windMph: 22, windDir: 'SW' },
    fog: { kind: 'fog', level: 3, wind: 0 },
    wind: { kind: 'none', level: 0, wind: 3, windMph: 50, windDir: 'SW' }
  };
  function addZoneLayers() {
    if (map.getSource('wxzones')) return;
    map.addSource('wxzones', { type: 'geojson', data: pendingZones ? pendingZones[0] : empty });
    map.addSource('wxlabels', { type: 'geojson', data: pendingZones ? pendingZones[1] : empty });
    map.addLayer({ id: 'wxzones-fill', type: 'fill', source: 'wxzones', layout: { visibility: fxOn ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.05 } }, 'outside');
    map.addLayer({ id: 'wxzones-line', type: 'line', source: 'wxzones', layout: { visibility: fxOn ? 'visible' : 'none', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.8, 'line-width': 1.6, 'line-dasharray': [0.5, 3] } }, 'outside');
    map.addLayer({ id: 'wxzones-label', type: 'symbol', source: 'wxlabels', layout: { visibility: fxOn ? 'visible' : 'none',
      'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-letter-spacing': 0.2, 'symbol-placement': 'point' },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#030807', 'text-halo-width': 2 } });
  }

  // ---------- particle canvas ----------
  const wrap = map.getContainer().parentElement;
  const cv = document.createElement('canvas');
  cv.className = 'fx';
  wrap.insertBefore(cv, wrap.querySelector('.hud'));
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, dirty = true;
  function size() {
    dpr = Math.min(1.5, devicePixelRatio || 1);
    W = wrap.clientWidth; H = wrap.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    dirty = true;
  }
  new ResizeObserver(size).observe(wrap);
  size();
  map.on('move', () => (dirty = true));
  // (chase view moves the camera every frame: weather effects and the sea pause until it ends)
  // (following a bus also moves the camera every frame: hold the resets until it's over)
  const chasing = () => document.body.classList.contains('chase') || document.body.classList.contains('following');
  map.on('moveend', () => { if (!chasing()) resetParticles(); });

  function reproject() {
    for (const z of zones) {
      z.path = new Path2D();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ring of z.rings) {
        ring.forEach(([lng, lat], i) => {
          const p = map.project([lng, lat]);
          i ? z.path.lineTo(p.x, p.y) : z.path.moveTo(p.x, p.y);
          if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
        });
        z.path.closePath();
      }
      // only the part of the zone that's on screen matters
      z.box = { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x1), y1: Math.min(H, y1) };
    }
    dirty = false;
  }

  // particles per 10,000 square pixels, by level
  // particles per 10,000 square pixels at the heaviest rate; lighter precipitation scales this down
  const DENSITY = { rain: 16, storm: 18, snow: 16, hail: 12, fog: 0.35, wind: 3.5 };
  const MAX = 2600;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // 0..1: how hard it's coming down. Uses the forecast precipitation rate when we have it
  // (NWS: heavy rain is 7.6 mm/h and up), otherwise the forecast wording and chance of rain.
  function share(c) {
    if (c.kind === 'fog') return [0, 0.45, 0.7, 1][c.level];
    if (c.rate != null) {
      const heavy = c.kind === 'snow' ? 25 : 7.6;
      return clamp(0.06 + c.rate / heavy, 0.06, 1);
    }
    const base = [0, 0.25, 0.55, 1][c.level];
    return base * (c.pop != null ? clamp(c.pop / 100, 0.35, 1) : 1);
  }
  function resetParticles() {
    if (dirty) reproject();
    let budget = MAX;
    for (const z of zones) {
      const b = z.box, area = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
      const c = z.cond;
      const n = (k, f) => Math.min(budget, Math.round(area / 1e4 * DENSITY[k] * f));
      z.fall = []; z.gusts = []; z.fogs = []; z.haze = [];
      if (c.kind !== 'none') {
        const k = c.kind === 'fog' ? 'fog' : c.kind;
        const count = n(k, share(c)); budget -= count;
        const arr = c.kind === 'fog' ? z.fogs : z.fall;
        for (let i = 0; i < count; i++) arr.push(spawn(z, c.kind === 'fog' ? 'fog' : c.kind === 'storm' ? 'rain' : c.kind, true));
        // fog also gets thin dashed haze lines drifting sideways, like interference on an old radar screen (more of
        // them the thicker it is), over a faint tint
        if (c.kind === 'fog') {
          const lines = Math.min(budget, Math.round((b.y1 - b.y0) / 10 * share(c) * Math.max(1, (b.x1 - b.x0) / 400))); budget -= lines;
          const dir = windVector(c.windDir).x >= 0 ? 1 : -1;
          for (let i = 0; i < lines; i++) z.haze.push({ y: rnd(b.y0, b.y1), x: rnd(b.x0, b.x1), len: rnd(60, 200), vx: dir * rnd(0.12, 0.4), a: rnd(0.28, 0.5) });
        }
      }
      if (c.wind) {
        const count = n('wind', c.wind / 3); budget -= count;
        for (let i = 0; i < count; i++) z.gusts.push(spawn(z, 'wind', true));
      }
      z.flash = 0; z.bolt = null; z.nextBolt = performance.now() + rnd(1500, 6000);
    }
  }
  function spawn(z, kind, anywhere) {
    const b = z.box, w = windVector(z.cond.windDir), windy = Math.min(1, (z.cond.windMph || 0) / 30);
    const x = rnd(b.x0, b.x1), y = anywhere ? rnd(b.y0, b.y1) : b.y0 - 10;
    switch (kind) {
      case 'rain': { const s = rnd(7, 12) + z.cond.level * 2; return { kind, x, y, vx: w.x * windy * 4, vy: s, len: rnd(8, 14) + z.cond.level * 3 }; }
      case 'snow': return { kind, x, y, vx: w.x * windy * 2.5, vy: rnd(0.6, 1.4), r: rnd(0.8, 2), ph: rnd(0, 6.28) };
      case 'hail': return { kind, x, y, vx: w.x * windy * 2, vy: rnd(9, 14), r: rnd(1.2, 2.2) };
      case 'fog': return { kind, x, y, vx: 0.15 + w.x * 0.3, vy: 0, r: rnd(40, 90), a: rnd(0.12, 0.22) };
      // mostly sideways (east/west), like the rain's slant, with only a hint of the north/south part
      case 'wind': { const sp = 3 + z.cond.wind * 1.5; return { kind, x: rnd(b.x0, b.x1), y: rnd(b.y0, b.y1), vx: (Math.abs(w.x) < 0.2 ? Math.sign(w.x || 1) * 0.6 : w.x) * sp, vy: w.y * sp * 0.15, len: rnd(18, 40), life: 0, max: rnd(40, 90) }; }
    }
  }
  function boltPath(z) {
    const b = z.box;
    let x = rnd(b.x0 + 20, b.x1 - 20), y = rnd(b.y0, b.y0 + (b.y1 - b.y0) * 0.4);
    const pts = [[x, y]], steps = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < steps; i++) { x += rnd(-14, 14); y += rnd(10, 22); pts.push([x, y]); }
    return pts;
  }

  let last = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (t - last < 33 || document.hidden || document.body.classList.contains('chase')) return; // ~30 fps
    last = t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!fxOn || REDUCED) return;
    drawOcean(t);
    if (!zones.length) return;
    if (dirty) reproject();
    for (const z of zones) {
      const b = z.box;
      if (b.x1 <= b.x0 || b.y1 <= b.y0) continue;
      ctx.save();
      ctx.clip(z.path, 'evenodd');
      // fog: a faint tint, slow soft banks, and drifting dashed haze lines
      if (z.cond.kind === 'fog') {
        ctx.fillStyle = `rgba(140,175,175,${0.04 + 0.04 * z.cond.level})`;
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
        for (const h of z.haze || []) {
          h.x += h.vx;
          if (h.vx > 0 && h.x > b.x1) h.x = b.x0 - h.len; else if (h.vx < 0 && h.x + h.len < b.x0) h.x = b.x1;
          ctx.strokeStyle = `rgba(170,205,205,${h.a})`;
          ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(h.x + h.len, h.y); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      for (const p of z.fogs) {
        p.x += p.vx; if (p.x - p.r > b.x1) p.x = b.x0 - p.r;
        const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        gr.addColorStop(0, `rgba(160,190,190,${p.a})`); gr.addColorStop(1, 'rgba(160,190,190,0)');
        ctx.fillStyle = gr; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      // rain, snow, hail
      ctx.lineWidth = 1;
      for (let i = 0; i < z.fall.length; i++) {
        const p = z.fall[i];
        p.x += p.vx; p.y += p.vy;
        if (p.kind === 'snow') { p.ph += 0.05; p.x += Math.sin(p.ph) * 0.4; }
        if (p.y > b.y1 + 10 || p.x < b.x0 - 20 || p.x > b.x1 + 20) { z.fall[i] = spawn(z, p.kind, false); continue; }
        if (p.kind === 'rain') {
          ctx.strokeStyle = z.cond.kind === 'storm' ? 'rgba(200,120,255,.55)' : 'rgba(0,229,255,.5)';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * p.len / p.vy, p.y - p.len); ctx.stroke();
        } else if (p.kind === 'snow') {
          ctx.fillStyle = 'rgba(232,246,255,.8)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(210,180,255,.9)'; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        }
      }
      // wind: streaks that fade in and out along the wind direction
      ctx.lineWidth = 1.2;
      for (let i = 0; i < z.gusts.length; i++) {
        const p = z.gusts[i];
        p.x += p.vx; p.y += p.vy; p.life++;
        if (p.life > p.max) { z.gusts[i] = spawn(z, 'wind', true); continue; }
        const a = Math.sin(Math.PI * p.life / p.max) * 0.45;
        const m = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = `rgba(57,255,136,${a})`;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx / m * p.len, p.y - p.vy / m * p.len); ctx.stroke();
      }
      // lightning
      if (z.cond.kind === 'storm') {
        if (t > z.nextBolt) { z.flash = 1; z.bolt = boltPath(z); z.nextBolt = t + (SIM.length ? rnd(500, 1400) : rnd(z.cond.level >= 3 ? 1200 : 2500, 7000)); }
        if (z.flash > 0.02) {
          ctx.fillStyle = `rgba(255,190,250,${0.22 * z.flash})`; ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
          if (z.bolt) {
            ctx.strokeStyle = `rgba(255,255,255,${z.flash})`; ctx.lineWidth = 2; ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 12;
            ctx.beginPath(); z.bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
            ctx.shadowBlur = 0;
          }
          z.flash *= SIM.length ? 0.95 : 0.82; // demo mode lets each strike linger so it shows up in screenshots
        }
      }
      ctx.restore();
    }
  }
  requestAnimationFrame(frame);

  function setFx(on) {
    fxOn = on;
    store.set('ht.fx', on);
    const btn = $('#btnFx');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    for (const id of ['wxzones-fill', 'wxzones-line', 'wxzones-label', 'barline']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    document.body.classList.toggle('fx-off', !on);
  }
  $('#btnFx').addEventListener('click', () => setFx(!fxOn));

  // show/hide ships (on by default; remembered per device; ?vessels=0 hides them, e.g. on a TV)
  let vesselsOn = qs.has('vessels') ? qs.get('vessels') !== '0' : store.get('ht.vessels') !== false;
  function setVessels(on) {
    vesselsOn = on;
    store.set('ht.vessels', on);
    const btn = $('#btnVessels');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    document.body.classList.toggle('no-vessels', !on);
    window.htDeclutter?.();
  }
  $('#btnVessels').addEventListener('click', () => setVessels(!vesselsOn));
  setVessels(vesselsOn);

  // ================= tide (NOAA CO-OPS predictions, Aberdeen station 9441187) =================
  const TIDE_STATION = '9441187';
  // NOAA's "lst_ldt" dates are Pacific local time, whatever time zone the viewer is in
  const pacific = (d) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}${p.month}${p.day} ${p.hour}:${p.minute}`;
  };
  // "2026-09-29 14:55" in Pacific time -> Date
  const fromPacific = (s) => {
    const guess = new Date(s.replace(' ', 'T') + 'Z');
    const off = guess - new Date(guess.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' UTC');
    return new Date(+guess + off);
  };
  const tideUrl = (extra) => `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=harbor_traffic` +
    `&datum=MLLW&station=${TIDE_STATION}&time_zone=lst_ldt&units=english&format=json&${extra}`;
  async function loadTide() {
    try {
      const now = new Date(), H = 36e5;
      const span = `begin_date=${encodeURIComponent(pacific(new Date(now - 6 * H)))}&end_date=${encodeURIComponent(pacific(new Date(+now + 6 * H)))}`;
      const [curve, hilo] = await Promise.all([
        fetch(tideUrl(`${span}&interval=6`)).then((r) => r.json()),
        fetch(tideUrl(`begin_date=${encodeURIComponent(pacific(now))}&range=26&interval=hilo`)).then((r) => r.json())
      ]);
      const pts = (curve.predictions || []).map((p) => ({ t: fromPacific(p.t), v: +p.v }));
      if (pts.length < 2) throw new Error('no tide data');
      const t0 = now - 6 * H, t1 = +now + 6 * H;
      const vs = pts.map((p) => p.v), lo = Math.min(...vs) - 0.5, hi = Math.max(...vs) + 0.5;
      const X = (t) => ((t - t0) / (t1 - t0)) * 160, Y = (v) => 36 - ((v - lo) / (hi - lo)) * 32;
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
      // current level: the prediction closest to now
      const cur = pts.reduce((a, b) => (Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a));
      const after = pts.find((p) => p.t > cur.t);
      const rising = after ? after.v > cur.v : false;
      // how fast the tide is moving right now (ft per hour) drives the harbor current streaks
      tideInfo = { rising, rate: after ? Math.abs(after.v - cur.v) / ((after.t - cur.t) / 36e5) : 0 };
      updateBays();
      const zero = lo < 0 && hi > 0 ? `<path d="M0 ${Y(0).toFixed(1)} H160" stroke="#12403a" stroke-dasharray="2 3"/>` : '';
      $('#tideChart').innerHTML = `${zero}
        <path d="${line} L160 40 L0 40 Z" fill="rgba(0,229,255,.12)"/>
        <path d="${line}" fill="none" stroke="#00e5ff" stroke-width="1.6" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 2px #00e5ff)"/>
        <path d="M80 0 V40" stroke="#ff2a3d" stroke-width="1.4" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 3px #ff2a3d)"/>
        <circle cx="80" cy="${Y(cur.v).toFixed(1)}" r="2.2" fill="#ff2a3d"/>`;
      $('#tideNow').textContent = `${cur.v.toFixed(1)} FT ${rising ? '▲' : '▼'}`;
      const nx = (hilo.predictions || []).map((p) => ({ t: fromPacific(p.t), v: +p.v, type: p.type })).find((p) => p.t > now);
      // (the rail note: big ships waiting off Westport come in on the high tide)
      nextHigh = (hilo.predictions || []).map((p) => ({ t: fromPacific(p.t), v: +p.v, type: p.type })).find((p) => p.type === 'H' && p.t > now) || null;
      renderRail();
      tick('tide', `${cur.v.toFixed(1)} ft and ${rising ? 'rising' : 'falling'} at Aberdeen` +
        (nx ? `, ${nx.type === 'H' ? 'high' : 'low'} ${nx.v.toFixed(1)} ft at ${nx.t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''));
      // ---- low tide warning for paddlers: mudflats exposed and shallow river mouths ----
      // on now (1.5 ft or lower) or coming soon (a low of 1.0 ft or less within 3 hours)
      const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const lows = (hilo.predictions || []).map((p) => ({ t: fromPacific(p.t), v: +p.v, type: p.type })).filter((p) => p.type === 'L');
      const lowNow = cur.v <= 1.5;
      const soon = lows.find((p) => p.t > now && p.t - now < 3 * H && p.v <= 1.0);
      const theLow = lowNow ? (lows.find((p) => Math.abs(p.t - now) < 4 * H) || { t: now, v: cur.v }) : soon;
      let tideMsg = '';
      if (theLow) {
        const back = pts.find((p) => p.t > theLow.t && p.v > 1.5); // when it's back above 1.5 ft
        const minus = theLow.v < 0;
        tideMsg = `${minus ? 'MINUS TIDE' : 'LOW TIDE'} ${theLow.v.toFixed(1)} FT ${theLow.t > now ? 'AT' : 'WAS AT'} ${hm(theLow.t)}` +
          `${back ? ` · ABOVE 1.5 FT AGAIN ABOUT ${hm(back.t)}` : ''}`;
        $('#tideAlert').innerHTML = `<li class="k-work"><div class="t">〰 ${tideMsg}</div>
          <div class="m">${lowNow ? `NOW ${cur.v.toFixed(1)} FT. ` : ''}Mudflats exposed and river mouths shallow around Grays Harbor${minus ? ', even more than usual' : ''}. Kayaks and small boats can get stranded; plan launches and returns around the tide.</div></li>`;
      } else $('#tideAlert').innerHTML = '';
      window.htPerilTide = theLow ? 1 : 0;
      window.htPerilRefresh?.();
      tick('lowtide', tideMsg.toLowerCase());
      const next = (hilo.predictions || []).map((p) => ({ t: fromPacific(p.t), v: +p.v, type: p.type })).find((p) => p.t > now);
      const tm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toUpperCase();
      $('#tideNext').innerHTML = next ? `<span>-6H</span><span>${next.type === 'H' ? 'HIGH' : 'LOW'} ${tm(next.t)} ${next.v.toFixed(1)}FT</span><span>+6H</span>` : '';
      $('#tide').title = `Tide at Aberdeen (NOAA ${TIDE_STATION}), feet above mean lower low water. ${rising ? 'Rising' : 'Falling'}.`;
    } catch (e) {
      console.warn('tide', e);
      $('#tideNow').textContent = 'N/A';
    }
  }
  loadTide();
  setInterval(loadTide, 10 * 60 * 1000);

  // ================= wind gauge (NOAA Westport station, observed; aviation style in knots) =================
  function dialSvg(deg, kt) {
    const ticks = Array.from({ length: 36 }, (_, i) => {
      const a = i * 10 * Math.PI / 180, long = i % 3 === 0, r1 = long ? 21 : 23.5;
      return `<line x1="${(30 + Math.sin(a) * r1).toFixed(1)}" y1="${(30 - Math.cos(a) * r1).toFixed(1)}" x2="${(30 + Math.sin(a) * 26).toFixed(1)}" y2="${(30 - Math.cos(a) * 26).toFixed(1)}"
        stroke="${long ? '#c4ffe9' : '#1d6358'}" stroke-width="${long ? 1.2 : 0.8}"/>`;
    }).join('');
    const card = [['N', 30, 14], ['E', 46.5, 32.2], ['S', 30, 49.5], ['W', 13.5, 32.2]]
      .map(([t, x, y]) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="6.5" fill="${t === 'N' ? '#ffc400' : '#5f9c8b'}" font-family="Share Tech Mono, monospace">${t}</text>`).join('');
    // the needle points to where the wind comes FROM, like a vane; the tail shows where it's going
    const needle = deg == null ? '' : `<g transform="rotate(${deg} 30 30)" style="filter:drop-shadow(0 0 2px #ffc400)">
      <polygon points="30,7 33,20 30,17.5 27,20" fill="#ffc400"/><line x1="30" y1="18" x2="30" y2="46" stroke="#ffc400" stroke-width="1.4"/>
      <path d="M26.5 44 L30 47 L33.5 44 M26.5 40.5 L30 43.5 L33.5 40.5" fill="none" stroke="#00e5ff" stroke-width="1.1"/></g>`;
    return `<circle cx="30" cy="30" r="28.5" fill="#020807" stroke="#1d6358" stroke-width="1.5"/>
      <circle cx="30" cy="30" r="26" fill="none" stroke="#12403a" stroke-width=".6"/>${ticks}${card}${needle}
      <circle cx="30" cy="30" r="2.4" fill="#020807" stroke="#ffc400" stroke-width="1"/>`;
  }
  // The wind gauge reads the weather station nearest the middle of the map: NOAA's Westport and Toke Point
  // stations, the airport stations (Hoquiam, Olympia, Shelton, Chehalis, Quillayute), and WSDOT's roadside stations
  // (the collector saves those). A station that hasn't reported lately is skipped for the next nearest.
  // The harbor chop on the water always uses Westport, since that's the water it draws.
  const WIND_STATIONS = [
    { id: '9441102', name: 'WESTPORT', lat: 46.9043, lon: -124.1051, src: 'coops' },
    { id: '9440910', name: 'TOKE POINT', lat: 46.7075, lon: -123.9669, src: 'coops' },
    { id: 'KHQM', name: 'HOQUIAM AIRPORT', lat: 46.9712, lon: -123.9366, src: 'nws' },
    { id: 'KOLM', name: 'OLYMPIA AIRPORT', lat: 46.9733, lon: -122.9026, src: 'nws' },
    { id: 'KSHN', name: 'SHELTON AIRPORT', lat: 47.2336, lon: -123.1475, src: 'nws' },
    { id: 'KCLS', name: 'CHEHALIS AIRPORT', lat: 46.677, lon: -122.9828, src: 'nws' },
    { id: 'KUIL', name: 'QUILLAYUTE AIRPORT', lat: 47.9375, lon: -124.555, src: 'nws' }
  ];
  let roadWind = [];
  async function loadRoadWind() {
    try {
      const j = await (await fetch(`data/road-weather.json?t=${Date.now()}`, { cache: 'no-store' })).json();
      roadWind = (j.stations || []).filter((s) => s.lat && s.lon && s.wind != null)
        .map((s) => ({ id: 'wsdot' + s.id, name: String(s.name).replace(/\s+on\s+.*$/i, '').toUpperCase(), lat: s.lat, lon: s.lon, src: 'wsdot', s }));
    } catch {}
  }
  const windCache = {}; // station -> { at, d }
  const hhmm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  async function readWind(st) {
    const c = windCache[st.id];
    if (c && Date.now() - c.at < 6 * 60 * 1000) return c.d;
    let d = null;
    try {
      if (st.src === 'coops') {
        const j = await (await fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=wind&date=latest&station=${st.id}&units=english&time_zone=lst_ldt&format=json&application=harbor_traffic`)).json();
        const x = j.data?.[0];
        if (x && x.s !== '') d = { kt: Math.round(+x.s), gust: Math.round(+x.g || 0), deg: +x.d, dr: x.dr, t: x.t ? hhmm(new Date(x.t.replace(' ', 'T'))) : '' };
      } else if (st.src === 'nws') {
        const p = (await (await fetch(`https://api.weather.gov/stations/${st.id}/observations/latest`)).json()).properties;
        const age = p?.timestamp ? Date.now() - new Date(p.timestamp) : Infinity;
        if (p?.windSpeed?.value != null && age < 3 * 3600 * 1000) {
          const deg = p.windDirection?.value;
          d = { kt: Math.round(p.windSpeed.value / 1.852), gust: p.windGust?.value != null ? Math.round(p.windGust.value / 1.852) : 0,
            deg: deg ?? 0, dr: deg != null ? compass(deg) : '', t: hhmm(new Date(p.timestamp)) };
        }
      } else {
        const s = st.s, age = s.time ? Date.now() - new Date(s.time) : Infinity;
        if (age < 3 * 3600 * 1000) d = { kt: Math.round(s.wind / 1.151), gust: s.gust ? Math.round(s.gust / 1.151) : 0,
          deg: Math.max(0, DIRS.indexOf(s.dir)) * 22.5, dr: s.dir || '', t: hhmm(new Date(s.time)) };
      }
    } catch (e) { console.warn('wind', st.id, e.message); }
    windCache[st.id] = { at: Date.now(), d };
    return d;
  }
  let windShown = null;
  function showWind(st, d) {
    windShown = st.id;
    const { kt, gust, deg, dr } = d;
    $('#windDial').innerHTML = dialSvg(kt < 1 ? null : deg, kt);
    $('#windDir').textContent = kt < 1 ? 'CALM' : `${dr} ${String(Math.round(deg)).padStart(3, '0')}°`;
    $('#windSpd').textContent = kt < 1 ? '' : `${String(kt).padStart(2, '0')}KT${gust > kt + 2 ? ' G' + gust : ''}`;
    $('#windWhere').textContent = st.name;
    const place = st.name.replace(/ AIRPORT$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    tick('wind', kt < 1 ? `calm at ${place}` : `from the ${dr} at ${kt} kt (${Math.round(kt * 1.151)} mph)${gust > kt + 2 ? `, gusts ${gust} kt` : ''} at ${place}`);
    $('#windGauge').title = `Wind at ${place}: from the ${dr} at ${kt} knots (${Math.round(kt * 1.151)} mph)${gust ? `, gusts ${gust} kt` : ''}. Observed ${d.t}.`;
  }
  // the nearest station to the middle of the map that has a recent reading (tries the three nearest)
  async function updateWindGauge() {
    const c = map.getCenter();
    const near = [...WIND_STATIONS, ...roadWind]
      .map((s) => [Math.hypot((s.lon - c.lng) * 0.68, s.lat - c.lat), s]).sort((a, b) => a[0] - b[0]).slice(0, 3).map((x) => x[1]);
    for (const st of near) {
      const d = await readWind(st);
      if (d) { showWind(st, d); return; }
    }
    if (!windShown) $('#windDial').innerHTML = dialSvg(null, 0);
  }
  // Westport for the harbor chop, then the gauge
  async function loadWind() {
    const d = await readWind(WIND_STATIONS[0]);
    if (d) windKt = d.kt;
    await loadRoadWind();
    updateWindGauge();
  }
  loadWind();
  setInterval(loadWind, 6 * 60 * 1000);
  // the 12/24-hour switch: redraw the times shown here (sun, tide, sea, wind)
  window.addEventListener('ht:clock', () => {
    skySvg(); loadTide(); loadSea();
    for (const k in windCache) delete windCache[k];
    updateWindGauge();
  });
  // when the map settles somewhere new (at most every 5 s: following a bus moves it all the time)
  let windAt = 0, windTimer = 0;
  map.on('moveend', () => {
    clearTimeout(windTimer);
    windTimer = setTimeout(() => { windAt = Date.now(); updateWindGauge(); }, Math.max(800, 5000 - (Date.now() - windAt)));
  });

  // ================= sea state (Grays Harbor buoy + NWS bar forecast, saved by the collector) =================
  const compass = (deg) => DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  // light / moderate / rough / severe, from the first thing the bar forecast says
  const barLevel = (s = '') => /severe|very rough|closed|restrict/i.test(s.split(/becoming|,/)[0]) ? 3
    : /rough/i.test(s.split(/becoming|,/)[0]) ? 2 : /moderate/i.test(s.split(/becoming|,/)[0]) ? 1 : 0;
  const barColor = ['#39ff88', '#ffc400', '#ff7a1a', '#ff2a3d'];
  let waveAmp = 4, wavePeriod = 10, waveColor = '#00e5ff';
  function drawWave(t) {
    // two waves moving at a speed tied to the swell period
    const ph = (t / 1000) * (2 * Math.PI / Math.max(4, wavePeriod)) * 2;
    let d1 = '', d2 = '';
    for (let x = 0; x <= 120; x += 3) {
      const y1 = 12 + Math.sin(x / 9 - ph) * waveAmp;
      const y2 = 14 + Math.sin(x / 6 - ph * 1.4 + 1) * waveAmp * 0.45;
      d1 += `${x ? 'L' : 'M'}${x} ${y1.toFixed(1)}`; d2 += `${x ? 'L' : 'M'}${x} ${y2.toFixed(1)}`;
    }
    $('#seaWave').innerHTML = `<path d="${d1}" fill="none" stroke="${waveColor}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
      <path d="${d2}" fill="none" stroke="${waveColor}" stroke-opacity=".45" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }
  let waveLast = 0;
  (function waveLoop(t) { requestAnimationFrame(waveLoop); if (t - waveLast > 60 && !document.hidden) { waveLast = t; drawWave(REDUCED ? 0 : t); } })(0);

  async function loadSea() {
    let m = null, waterWestport = null;
    try { m = await (await fetch(`data/marine.json?t=${Date.now()}`, { cache: 'no-store' })).json(); } catch {}
    try {
      const j = await (await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature&date=latest&station=9441102&units=english&time_zone=lst_ldt&format=json&application=harbor_traffic')).json();
      waterWestport = j.data?.[0] ? +j.data[0].v : null;
    } catch {}
    const b = m?.buoy, bar = m?.bar, lvl = barLevel(bar?.conditions);
    waveColor = bar ? barColor[lvl] : '#00e5ff';
    if (b?.waveFt != null) { waveAmp = clamp(b.waveFt / 2.2, 1.2, 10); wavePeriod = b.periodS || 10; }
    sea = { waveFt: b?.waveFt ?? null, periodS: b?.periodS || 10, dirDeg: b?.dirDeg ?? 270, color: waveColor, bar: bar?.conditions || null };
    updateBar();
    const water = waterWestport ?? b?.waterF;
    $('#seaBar').textContent = bar?.conditions ? `BAR ${bar.conditions.toUpperCase().replace(', BECOMING', ' →')}` : 'BAR --';
    $('#seaBar').style.color = waveColor;
    $('#seaWaves').textContent = b?.waveFt != null ? `WAVES ${b.waveFt}FT @${b.periodS}S ${compass(b.dirDeg)}` : 'WAVES --';
    $('#seaWater').textContent = water != null ? `WATER ${Math.round(water)}°` : '';
    const alerts = m?.alerts || [];
    $('#sea').classList.toggle('alert', alerts.length > 0 || lvl >= 2);
    tick('sea', [bar?.conditions ? `Grays Harbor bar ${bar.conditions}` : '', b?.waveFt != null ? `waves ${b.waveFt} ft @ ${b.periodS}s` : '',
      water != null ? `water ${Math.round(water)}°` : '', ...alerts.map((a) => a.event)].filter(Boolean).join(' · '));
    $('#sea').title = [bar?.text, b ? `Buoy 46211: ${b.waveFt} ft, ${b.periodS} s, from ${compass(b.dirDeg)}` : ''].filter(Boolean).join('\n');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const when = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    $('#seaDetail').innerHTML = `
      <ul class="list" id="shipAlerts"></ul>
      <ul class="list">
        ${alerts.map((a) => `<li class="k-closure"><div class="t">${esc(a.event.toUpperCase())}</div><div class="m">${esc(a.area)}${a.ends ? ' · UNTIL ' + esc(when(a.ends)) : ''}</div></li>`).join('')}
        <li style="border-left-color:${waveColor}"><div class="t">BAR: ${esc((bar?.conditions || 'no forecast').toUpperCase())}</div>
          <div class="m">${esc(bar?.text || '')}</div><div class="m">NWS COASTAL FORECAST · ${esc(when(bar?.issued))}</div></li>
        <li><div class="t">WAVES ${b?.waveFt ?? '--'} FT · ${b?.periodS ?? '--'} S · FROM ${b?.dirDeg != null ? compass(b.dirDeg) + ' ' + b.dirDeg + '°' : '--'}</div>
          <div class="m">GRAYS HARBOR BUOY 46211 · ${esc(when(b?.time))}</div></li>
        <li><div class="t">WATER ${water != null ? Math.round(water) + '°F' : '--'}</div><div class="m">${waterWestport != null ? 'WESTPORT (NOAA 9441102)' : 'GRAYS HARBOR BUOY'}</div></li>
      </ul>
      <h2>SHIPS</h2><ul class="list" id="shipList"></ul>
      <p class="fine">Positions from ships' AIS transponders (aisstream.io), refreshed each collector run; ships within 15 nautical miles of the harbor entrances. Entering/leaving is worked out from each ship's course. Ships tied up only report every few minutes, so each stays on the map up to 3 hours after it was last heard.</p>
      <p class="fine">Check with the Coast Guard (Station Grays Harbor) for bar restrictions before crossing. This is a summary, not a navigation aid.</p>`;
    renderShipList(); // the SEA tab was just rebuilt
  }
  $('#sea').addEventListener('click', () => window.htOpenTab?.('sea'));
  loadSea();
  setInterval(loadSea, 10 * 60 * 1000);

  // ================= ships (AIS, saved by the collector) =================
  const SHIP_KIND = (t) => t === 30 ? ['FISHING', '#39ff88'] : [31, 32, 52].includes(t) ? ['TUG', '#c28bff']
    : t >= 60 && t <= 69 ? ['PASSENGER', '#ff2bd6'] : t >= 70 && t <= 79 ? ['CARGO', '#bff4ff'] : t >= 80 && t <= 89 ? ['TANKER', '#ffc400']
    : t === 50 ? ['PILOT', '#00e5ff'] : t === 51 ? ['SEARCH & RESCUE', '#ff2a3d'] : t === 55 ? ['LAW ENFORCEMENT', '#00e5ff']
    : t === 36 ? ['SAILING', '#5f9c8b'] : t === 37 ? ['PLEASURE', '#5f9c8b'] : ['VESSEL', '#8fa8a8'];
  const isTug = (t) => [31, 32, 52].includes(t);
  const isCargo = (t) => t >= 70 && t <= 79;
  const shipMarkers = [];
  let shipList = [], ghostList = []; // (ghostList: boats not heard for over an hour, shown faded where last heard)
  const escS = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stopped = (s) => s.status === 1 || s.status === 5 || (s.sog ?? 0) < 0.5; // at anchor, moored, or not moving

  // ---- where ships are and what they're doing, relative to the harbor ----
  const GH_MOUTH = { lat: 46.915, lon: -124.11 }, WB_MOUTH = { lat: 46.69, lon: -124.07 };
  const MAX_NM = 40; // out to about 40 nm (what the collector listens to)
  const nmBetween = (a, b) => {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 3440.07 * Math.asin(Math.sqrt(h));
  };
  const bearingTo = (a, b) => {
    const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const inBox = (s, [w, so, e, n]) => s.lon > w && s.lon < e && s.lat > so && s.lat < n;
  const GH_BOX = [-124.13, 46.84, -123.76, 47.02], WB_BOX = [-124.08, 46.36, -123.72, 46.73];
  const PORT_BOX = [-123.97, 46.94, -123.76, 47.0]; // Aberdeen/Hoquiam waterfront, where the terminals are
  function situation(s) {
    const mouth = nmBetween(s, WB_MOUTH) < nmBetween(s, GH_MOUTH) ? WB_MOUTH : GH_MOUTH;
    const dist = nmBetween(s, mouth);
    const inside = inBox(s, GH_BOX) || inBox(s, WB_BOX);
    const cog = s.cog ?? s.heading;
    let state;
    if (stopped(s)) state = inBox(s, PORT_BOX) ? 'DOCKED' : s.status === 5 ? 'MOORED' : inside ? 'ANCHORED' : (s.status === 1 ? 'ANCHORED' : 'STOPPED');
    else if (cog == null) state = 'UNDER WAY';
    else if (inside) state = cog > 200 && cog < 340 ? 'LEAVING' : cog > 20 && cog < 160 ? 'ENTERING' : 'IN HARBOR';
    else { const d = angleDiff(cog, bearingTo(s, mouth)); state = d < 40 ? 'ENTERING' : d > 140 ? 'LEAVING' : 'PASSING'; }
    return { state, dist: inside ? 0 : dist, inside, bay: mouth === WB_MOUTH ? 'WILLAPA BAY' : 'GRAYS HARBOR' };
  }
  const shipColor = (s, sit) => isCargo(s.type) ? (sit.state === 'ENTERING' ? '#ff7a1a' : '#d11a2a') : SHIP_KIND(s.type)[1];

  // ---- drawings ----
  // a pixel-art anchor for ships that are docked, moored or anchored
  const ANCHOR = ['....#....', '...#.#...', '....#....', '..#####..', '....#....', '#...#...#', '##..#..##', '.#######.', '...###...'];
  const anchorSvg = (color) => `<svg viewBox="0 0 9 9" shape-rendering="crispEdges"><g fill="${color}">${ANCHOR.flatMap((row, y) =>
    [...row].map((c, x) => (c === '#' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ''))).join('')}</g></svg>`;
  // top-down silhouettes, bow up, in a 20 x 100 box
  function shipOutline(type, color) {
    const line = `stroke="${color}" stroke-width="1.3" vector-effect="non-scaling-stroke"`;
    const hull = `<path d="M10 0 C15 8 18 18 18 30 L18 94 Q18 100 12 100 L8 100 Q2 100 2 94 L2 30 C2 18 5 8 10 0 Z" fill="rgba(2,8,7,.8)" ${line}/>`;
    const blk = (x, y, w, h, o) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" fill-opacity="${o}" ${line}/>`;
    if (isCargo(type)) {
      // container ship: square-shouldered hull, rows of container stacks, deckhouse aft
      const h = `<path d="M10 0 C16 6 19 16 19 26 L19 95 L16 100 L4 100 L1 95 L1 26 C1 16 4 6 10 0 Z" fill="rgba(2,8,7,.85)" ${line}/>`;
      let stacks = '';
      for (let y = 16; y < 76; y += 7) stacks += blk(3.5, y, 6, 5.5, y % 14 ? 0.55 : 0.3) + blk(10.5, y, 6, 5.5, y % 14 ? 0.3 : 0.55);
      return h + stacks + blk(3, 80, 14, 11, 0.9) + `<path d="M0 83 L20 83" ${line}/>`;
    }
    if (type >= 80 && type <= 89) // tanker: pipe run, manifold, deckhouse aft
      return hull + `<path d="M10 12 L10 78 M5 46 L15 46" fill="none" ${line}/><circle cx="10" cy="46" r="2.2" fill="none" ${line}/>` + blk(4, 82, 12, 10, 0.5);
    if (isTug(type)) // tug: stubby, round bow, heavy fender, tall wheelhouse forward, towing hook aft
      return `<path d="M10 22 C19 22 20 36 20 50 L20 88 Q20 98 10 98 Q0 98 0 88 L0 50 C0 36 1 22 10 22 Z" fill="rgba(2,8,7,.85)" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"/>` +
        blk(4.5, 36, 11, 18, 0.7) + blk(6.5, 56, 7, 10, 0.35) + `<path d="M6 84 L14 84 M10 80 L10 88" fill="none" ${line}/>`;
    if (type === 30) // fishing: wheelhouse forward, outrigger booms
      return hull + blk(5, 24, 10, 16, 0.5) + `<path d="M2 50 L-10 64 M18 50 L30 64 M10 60 L10 90" fill="none" ${line}/>`;
    if (type >= 60 && type <= 69) // passenger: stacked decks
      return hull + blk(4, 22, 12, 66, 0.2) + blk(6, 30, 8, 50, 0.4);
    return hull + blk(5, 60, 10, 18, 0.45);
  }
  // how many screen pixels a ship's length covers at the current zoom
  const metersToPx = (m, lat) => m / (156543.03 * Math.cos(lat * Math.PI / 180) / 2 ** map.getZoom());
  // minimum on-screen length by type, so nothing gets lost when zoomed out; real size takes over up close
  const minLen = (s) => isCargo(s.type) ? 40 : s.type >= 80 && s.type <= 89 ? 36 : s.type >= 60 && s.type <= 69 ? 32 : isTug(s.type) ? 24 : s.classB ? 18 : 22;
  function drawShip(el, s) {
    const sit = s._sit;
    const color = shipColor(s, sit);
    if (stopped(s)) {
      const px = isCargo(s.type) || (s.lengthM || 0) >= 100 ? 30 : 22;
      el.style.width = el.style.height = px + 'px';
      el.innerHTML = anchorSvg('#c28bff');
      el.classList.add('anchored');
      return;
    }
    el.classList.remove('anchored');
    const len = Math.max(minLen(s), Math.min(260, s.lengthM ? metersToPx(s.lengthM, s.lat) : 0));
    el.style.width = el.style.height = len + 'px';
    el.innerHTML = `<svg viewBox="-12 0 44 100" style="transform:rotate(calc(${s.heading ?? s.cog ?? 0}deg - var(--brg, 0deg)))">${shipOutline(s.type, color)}</svg>`;
  }
  map.on('zoomend', () => { shipMarkers.forEach((m) => drawShip(m.getElement(), m._ship)); groupShips(); });

  // zoomed out, ships that would pile up merge into one icon with a count (like the road alerts):
  // a purple anchor if they're all tied up or anchored, otherwise a small hull
  const shipGroups = [];
  function groupShips() {
    shipGroups.splice(0).forEach((m) => m.remove());
    shipMarkers.forEach((m) => (m.getElement().style.display = ''));
    if (map.getZoom() >= 12) return;
    const pts = shipMarkers.map((m) => ({ m, p: map.project(m.getLngLat()) }));
    const used = new Set();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const grp = [i];
      for (let j = i + 1; j < pts.length; j++) if (!used.has(j) && Math.hypot(pts[i].p.x - pts[j].p.x, pts[i].p.y - pts[j].p.y) < 36) grp.push(j);
      if (grp.length < 2) continue;
      grp.forEach((k) => { used.add(k); pts[k].m.getElement().style.display = 'none'; });
      const ships = grp.map((k) => pts[k].m._ship);
      const lls = grp.map((k) => pts[k].m.getLngLat());
      const at = [lls.reduce((s, l) => s + l.lng, 0) / lls.length, lls.reduce((s, l) => s + l.lat, 0) / lls.length];
      const allStopped = ships.every(stopped);
      const color = allStopped ? '#c28bff' : ships.some((s) => isCargo(s.type)) ? '#d11a2a' : '#bff4ff';
      const el = document.createElement('div');
      el.className = 'ship-mk ship-grp' + (allStopped ? ' anchored' : '');
      el.style.width = el.style.height = '30px';
      el.innerHTML = (allStopped ? anchorSvg(color)
        : `<svg viewBox="0 0 16 16"><polygon points="8,1 13,6 13,15 3,15 3,6" fill="rgba(2,8,7,.85)" stroke="${color}" stroke-width="1.4"/></svg>`) +
        `<b style="color:${color}">${ships.length}</b>`;
      el.title = `${ships.length} vessels here: ${ships.map((s) => s.name || 'vessel').join(', ')}. Click to zoom in.`;
      el.addEventListener('click', () => {
        const b = new maplibregl.LngLatBounds(); lls.forEach((l) => b.extend(l));
        map.fitBounds(b, { padding: 90, maxZoom: 14, minZoom: 12.2 });
      });
      shipGroups.push(new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map));
    }
  }

  // ---- boat photos: your own (ships/photos.json, made by scripts/ship-photos.ps1, plus a few from Wikimedia Commons
  // added by hand) and Commons photos the collector found that you approved on the stats page (the relay keeps
  // the yes/no list). Shown in the boat's popup with the photographer's credit and license.
  let shipPhotos = {}, photosAt = 0;
  const safeUrl = (u) => (/^(ships\/[\w.-]+|https:\/\/(upload|thumb)\.wikimedia\.org\/[^\s"'<>]+)$/.test(u || '') ? u : null);
  async function loadShipPhotos() {
    if (Date.now() - photosAt < 600000) return;
    photosAt = Date.now();
    const relay = (window.HT?.airRelay || '').replace(/\/aircraft$/, '');
    const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const [own, cand, dec] = await Promise.all([get(`ships/photos.json?t=${Date.now()}`), get(`data/ship-photo-candidates.json?t=${Date.now()}`),
      relay ? fetch(`${relay}/ship-photos`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) : {}]);
    const out = {};
    for (const [mmsi, list] of Object.entries(own.photos || {})) out[mmsi] = [...list];
    const yes = new Set((dec.decisions || []).filter((d) => d.ok).map((d) => `${d.mmsi}|${d.file}`));
    for (const c of cand.candidates || []) {
      if (!yes.has(`${c.mmsi}|${c.file}`)) continue;
      const have = (out[c.mmsi] ||= []);
      if (!have.some((p) => p.file === c.file)) have.push({ src: c.thumb, w: c.w, h: c.h, caption: c.caption, credit: c.author, license: c.license,
        licenseUrl: c.licenseUrl, page: c.page, file: c.file, source: 'commons' });
    }
    shipPhotos = out;
  }
  function photoHtml(s) {
    const list = (shipPhotos[String(s.mmsi)] || []).filter((p) => safeUrl(p.src));
    if (!list.length) return '';
    const i = (s._pi || 0) % list.length, p = list[i];
    const link = (u, t) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? `<a href="${escS(u)}" target="_blank" rel="noopener">${escS(t)}</a>` : escS(t));
    const credit = `PHOTO: ${escS(p.credit || 'unknown')}` + (p.source === 'own' ? '' : `${p.license ? ' · ' + link(p.licenseUrl, p.license) : ''}${p.page ? ' · ' + link(p.page, 'COMMONS') : ''}`);
    return `<figure class="ship-photo"><img src="${escS(p.src)}" width="${+p.w || 4}" height="${+p.h || 3}" alt="${escS(s.name || 'vessel')}" loading="lazy">
      <figcaption>${p.caption ? `<span class="cap">${escS(p.caption)}</span>` : ''}<span class="cr">${credit}</span>
      ${list.length > 1 ? `<button type="button" class="ph-next" data-mmsi="${escS(s.mmsi)}" aria-label="Next photo">${i + 1}/${list.length} ›</button>` : ''}</figcaption></figure>`;
  }
  // stepping through a boat's photos
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.ph-next'); if (!b) return;
    const mk = shipMarkers.find((m) => String(m._ship.mmsi) === b.dataset.mmsi); if (!mk) return;
    mk._ship._pi = (mk._ship._pi || 0) + 1;
    mk.getPopup().setHTML(mk._html(mk._ship));
  });

  async function loadShips() {
    loadShipPhotos();
    try {
      const j = await (await fetch(`data/ships.json?t=${Date.now()}`, { cache: 'no-store' })).json();
      shipList = (j.ships || []).filter((s) => s.lat && s.lon);
    } catch { shipList = []; }
    // demo: ?simship adds made-up traffic (a cargo ship coming in over the bar, one heading out, a tug and a fishing boat)
    if (qs.has('simship')) {
      const now = new Date().toISOString();
      shipList.push(
        { mmsi: 1, name: 'DEMO INBOUND (SIMULATED)', type: 70, lengthM: 190, lat: 46.905, lon: -124.2, sog: 11, cog: 75, heading: 75, status: 0, seen: now, dest: 'ABERDEEN' },
        { mmsi: 2, name: 'DEMO OUTBOUND (SIMULATED)', type: 70, lengthM: 180, lat: 46.955, lon: -123.99, sog: 8, cog: 255, heading: 255, status: 0, seen: now, dest: 'TOKYO' },
        { mmsi: 3, name: 'DEMO TUG (SIMULATED)', type: 52, lengthM: 30, lat: 46.95, lon: -123.97, sog: 7, cog: 250, heading: 250, status: 0, seen: now },
        { mmsi: 4, name: 'DEMO FISHING (SIMULATED)', type: 30, lengthM: 22, lat: 46.86, lon: -124.3, sog: 6, cog: 200, heading: 200, status: 7, seen: now });
    }
    for (const s of shipList) s._sit = situation(s);
    shipList = shipList.filter((s) => s._sit.inside || s._sit.dist <= MAX_NM);
    // ghosts: not heard for over an hour (AIS switched off, or out of range), shown faded where last heard, for a
    // day (the collector keeps them that long); gone as soon as they're heard again. They don't count for the rail
    // or bridge alerts or the vessel list, since where they are now is unknown
    for (const s of shipList) s._ghost = !!s.seen && Date.now() - Date.parse(s.seen) > 3600e3;
    ghostList = shipList.filter((s) => s._ghost);
    shipList = shipList.filter((s) => !s._ghost);
    shipMarkers.splice(0).forEach((m) => m.remove());
    for (const s of [...shipList, ...ghostList]) {
      const kind = isCarCarrier(s) ? 'VEHICLE CARRIER' : SHIP_KIND(s.type)[0], sit = s._sit, color = shipColor(s, sit);
      const el = document.createElement('div');
      el.className = 'ship-mk' + (s.classB ? ' small' : '') + (isCargo(s.type) ? ' cargo' : '') + (s._ghost ? ' ghost' : '');
      drawShip(el, s);
      const dir = s.heading ?? s.cog ?? 0;
      el.title = s.name || 'Vessel';
      const ago = s.seen ? Math.round((Date.now() - Date.parse(s.seen)) / 60000) : null;
      const lastHeard = s.seen ? new Date(s.seen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase() : '';
      const html = (x) => x._ghost ? `${photoHtml(x)}<h3>${escS((x.name || 'UNKNOWN VESSEL').toUpperCase())} · NOT HEARD</h3>
        <p><span style="color:${color}">${kind}</span> · <b>LAST HEARD ${escS(lastHeard)}</b> (${Math.round(ago / 60)} H AGO)</p>
        <div class="m">THIS IS WHERE ITS AIS WAS LAST HEARD. IT MAY HAVE SWITCHED IT OFF (TIED UP) OR GONE OUT OF RANGE. SHOWN FOR UP TO A DAY, OR UNTIL IT'S HEARD AGAIN.</div>`
        : `${photoHtml(x)}<h3>${escS((x.name || 'UNKNOWN VESSEL').toUpperCase())}</h3>
        <p><span style="color:${color}">${kind}</span> · <b>${sit.state}</b>${stopped(x) ? '' : ` · ${(x.sog ?? 0).toFixed(1)} KT ${compass(dir)}`}</p>
        <div class="m">${sit.inside ? 'IN ' + sit.bay : `${sit.dist.toFixed(1)} NM FROM THE ${sit.bay} ENTRANCE`}${x.dest ? ' · BOUND FOR ' + escS(x.dest.toUpperCase()) : ''}${x.lengthM ? ' · ' + x.lengthM + ' M' : ''}${ago != null ? ` · SEEN ${ago < 2 ? 'JUST NOW' : ago + ' MIN AGO'}` : ''}</div>`;
      const pop = new maplibregl.Popup({ offset: 10, maxWidth: '300px' }).setHTML(html(s));
      pop.on('open', () => pop.setHTML(html(s))); // (photos may have loaded since)
      const mk = new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).setPopup(pop).addTo(map);
      mk._ship = s; mk._html = html;
      shipMarkers.push(mk);
    }
    groupShips();
    checkBridges();
    renderShipList();
    renderRail();
    window.htDeclutter?.();
  }

  // any vessel other than a tug near a drawbridge: the bridge may be about to open
  let nearBridge = [];
  function checkBridges() {
    nearBridge = [];
    for (const b of (window.HT?.bridges || [])) {
      for (const s of shipList) {
        if (isTug(s.type)) continue;
        const nm = nmBetween(s, b);
        if (nm <= 0.22) nearBridge.push({ bridge: b, ship: s, m: Math.round(nm * 1852) }); // about 400 m
      }
    }
    window.htNearBridge = Object.fromEntries(nearBridge.map((x) => [x.bridge.id, (x.ship.name || 'a vessel').toUpperCase()]));
    window.htRenderBridges?.();
    tick('bridge', nearBridge.map((x) => `${(x.ship.name || 'vessel').toUpperCase()} ${x.m} m from the ${x.bridge.name}: bridge may open`).join(' · '));
  }

  // ---- rail activity: the port's rail-served terminals load and unload big ships, so a big ship at berth
  // in Grays Harbor usually means trains through Aberdeen/Hoquiam. It's an educated guess, not a train feed.
  const IN_HARBOR = [-124.09, 46.91, -123.76, 47.0];
  const railChip = document.createElement('div');
  railChip.className = 'rail-chip';
  new maplibregl.Marker({ element: railChip, anchor: 'top' }).setLngLat([-123.84, 46.962]).addTo(map);
  // Per the port: the big vehicle carriers all but guarantee trains (the cars come and go by rail); the smaller
  // bulk ships (soy meal) often don't. Car carriers are told apart by name: nearly all belong to a few lines that
  // name them in a set pattern (NYK "... LEADER", K Line "... HIGHWAY", MOL "... ACE", EUKOR "MORNING ...",
  // Hyundai Glovis, Höegh, Toyofuji "TRANS FUTURE"). Size alone overlaps too much with bulk ships to go by.
  function isCarCarrier(x) { return /(\bLEADER|\bHIGHWAY|\bACE)$|^(MORNING|GLOVIS|HOEGH|HÖEGH|TRANS FUTURE)\b/i.test(String(x.name || '').trim()); }
  // Also per the port: the biggest ships wait outside, off Westport, for the tide before coming in to load. So a car
  // carrier (or a 190 m+ ship) sitting or creeping within about 12 nm outside the Grays Harbor entrance is a heads-up.
  let nextHigh = null;
  function renderRail() {
    const [w, s, e, n] = IN_HARBOR;
    const big = shipList.filter((x) => x.lon > w && x.lon < e && x.lat > s && x.lat < n &&
      ((x.lengthM || 0) >= 100 || (x.type >= 70 && x.type <= 89)));
    // at berth = stopped at the Aberdeen/Hoquiam terminals. Stopped anywhere else (just inside the entrance by
    // Westport, or outside it) counts as waiting for the tide
    // (a vessel that hasn't broadcast its size or type yet, stopped at the deep-water terminals along the Aberdeen
    // side of the Chehalis, counts too: on Oct 6 GOLD ETERNITY sat there unidentified during a train. Tug and fishing
    // docks up the Hoquiam and Wishkah rivers are outside that stretch)
    const TERMINALS = [-123.875, 46.955, -123.81, 46.972];
    const unknownAtTerminal = shipList.filter((x) => x.type == null && !x.lengthM && stopped(x) && inBox(x, TERMINALS) && !big.includes(x));
    big.push(...unknownAtTerminal);
    const atBerth = big.filter((x) => stopped(x) && inBox(x, PORT_BOX)), moving = big.filter((x) => !stopped(x));
    const cars = atBerth.filter(isCarCarrier);
    const waiting = shipList.filter((x) => x._sit && x._sit.bay === 'GRAYS HARBOR' && (x.sog ?? 0) < 3 && !atBerth.includes(x) &&
      (x._sit.inside ? stopped(x) : x._sit.dist <= 12) && (isCarCarrier(x) || (x.lengthM || 0) >= 190));
    // likely: a car carrier at berth. Possible: any other big ship at berth or moving in the harbor, or a big one
    // waiting outside for the tide
    const level = cars.length ? 2 : atBerth.length || moving.length || waiting.length ? 1 : 0;
    const names = (list) => list.map((x) => (x.name || 'a large vessel').toUpperCase() + (unknownAtTerminal.includes(x) ? ' (size not broadcast)' : '')).join(', ');
    const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const tide = nextHigh && nextHigh.t - Date.now() < 14 * 3600e3 ? `, high tide ${hm(nextHigh.t)}` : '';
    const who = level === 2 ? names(cars) : atBerth.length ? names(atBerth) : moving.length ? names(moving) : names(waiting);
    const carWaiting = waiting.some(isCarCarrier);
    const where = level === 2 ? ' (vehicle carrier) at berth' : atBerth.length ? ' at berth' : moving.length ? ' under way'
      : `${carWaiting ? ' (vehicle carrier)' : ''} waiting by Westport for the tide${tide}`;
    const why = (who + where).toUpperCase();
    railChip.innerHTML = level ? `<b>⚠ RAIL ACTIVITY ${level === 2 ? 'LIKELY' : 'POSSIBLE'}</b><span>${escS(why)}</span>` : '';
    railChip.classList.toggle('likely', level === 2);
    const box = $('#railNote');
    const more = level === 2 ? 'Vehicle carriers are loaded and unloaded by train, so expect trains at crossings.'
      : atBerth.length ? 'Bulk ships (like soy meal) don\'t always bring trains; vehicle carriers almost always do.'
      : moving.length ? 'Trains often follow a vehicle carrier\'s arrival.'
      : `The biggest ships wait by Westport for the tide before coming up to load${carWaiting ? '; vehicle carriers almost always mean trains once they dock.' : '.'}`;
    if (box) box.innerHTML = level ? `<li class="${level === 2 ? 'k-work' : ''}"><div class="t">⚠ RAIL ACTIVITY ${level === 2 ? 'LIKELY' : 'POSSIBLE'} · ABERDEEN / HOQUIAM</div>
      <div class="m">${escS(`${who}${where}${atBerth.length || moving.length || level === 2 ? ' in the harbor' : ''}. ${more}`)}</div></li>` : '';
    window.htRailLevel = level;
    tick('rail', level ? `activity ${level === 2 ? 'likely' : 'possible'} in Aberdeen/Hoquiam: ${who}${where}` : '');
    window.htDeclutter?.();
  }
  function renderShipList() {
    // alerts first: vessels near a drawbridge, then ships docked at the port (purple)
    const alerts = $('#shipAlerts');
    if (alerts) {
      const docked = shipList.filter((s) => s._sit.state === 'DOCKED');
      alerts.innerHTML = nearBridge.map((x) => `<li class="k-work clickable" data-lon="${x.ship.lon}" data-lat="${x.ship.lat}">
          <div class="t">⚠ ${escS((x.ship.name || 'VESSEL').toUpperCase())} NEAR THE ${escS(x.bridge.name.toUpperCase())}</div>
          <div class="m">${x.m} m away · the bridge may open soon</div></li>`).join('') +
        docked.map((s) => `<li class="k-port clickable" data-lon="${s.lon}" data-lat="${s.lat}">
          <div class="t">⚓ ${escS((s.name || 'VESSEL').toUpperCase())} DOCKED AT THE PORT</div>
          <div class="m">${SHIP_KIND(s.type)[0]}${s.lengthM ? ' · ' + s.lengthM + ' M' : ''}${isCargo(s.type) || (s.type >= 80 && s.type <= 89) ? ' · loading/unloading: expect trains' : ''}</div></li>`).join('');
    }
    const box = $('#shipList');
    if (!box) return;
    const sorted = shipList.slice().sort((a, b) => a._sit.dist - b._sit.dist || (b.lengthM || 0) - (a.lengthM || 0));
    box.innerHTML = sorted.length ? sorted.map((s) => {
      const kind = isCarCarrier(s) ? 'VEHICLE CARRIER' : SHIP_KIND(s.type)[0], sit = s._sit, color = shipColor(s, sit);
      const where = sit.inside ? `IN ${sit.bay}` : `${sit.dist.toFixed(1)} NM OUT`;
      return `<li class="clickable ship-row" data-lon="${s.lon}" data-lat="${s.lat}" style="border-left-color:${color}">
        <div class="t">${escS((s.name || 'UNKNOWN VESSEL').toUpperCase())} <span class="pill st-${sit.state.replace(/\s/g, '')}">${sit.state}</span></div>
        <div class="m">${kind} · ${where}${stopped(s) ? '' : ` · ${(s.sog ?? 0).toFixed(1)} KT`}${s.dest ? ' · ' + escS(s.dest.toUpperCase()) : ''}</div></li>`;
    }).join('') : '<li class="empty">NO SHIPS WITHIN 15 NM IN THE LAST 3 HOURS</li>';
  }
  document.addEventListener('click', (e) => {
    const li = e.target.closest('#shipList li[data-lon], #shipAlerts li[data-lon]'); if (!li) return;
    map.flyTo({ center: [+li.dataset.lon, +li.dataset.lat], zoom: 13 });
  });
  loadShips();
  setInterval(loadShips, 5 * 60 * 1000);

  // ================= the ocean and the bays, drawn on the water itself =================
  // Open ocean: swell crests rolling in from the buoy's wave direction (spacing and speed from the period,
  // brightness from the height, whitecaps in big seas). Bays: current streaks flowing out on the ebb and in
  // on the flood, as fast as the tide is changing. The map's own water shapes are the mask, so nothing
  // draws on land.
  let sea = null, tideInfo = null;
  var windKt = 0; // set by the wind gauge (var: the gauge's code above runs first)
  const BAYS = [
    // reaches out to the jetty tips, so swell stops at the harbor mouth
    { id: 'gh', name: 'GRAYS HARBOR', box: [-124.135, 46.84, -123.76, 47.1], label: [-123.97, 46.93] },
    { id: 'wb', name: 'WILLAPA BAY', box: [-124.03, 46.36, -123.72, 46.73], label: [-123.93, 46.62] }
  ];
  const BAR_LINE = [[-124.175, 46.955], [-124.16, 46.9]]; // across the Grays Harbor bar, just outside the jetties
  let water = null, waterDirty = true, bayPx = [];
  function rebuildWater() {
    try {
      const feats = map.querySourceFeatures('omt', { sourceLayer: 'water', filter: ['==', ['get', 'class'], 'ocean'] });
      const p = new Path2D();
      for (const f of feats) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
        for (const poly of polys) for (const ring of poly) {
          ring.forEach(([lng, lat], i) => { const q = map.project([lng, lat]); i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y); });
          p.closePath();
        }
      }
      water = feats.length ? p : null;
      bayPx = BAYS.map((bay) => {
        const a = map.project([bay.box[0], bay.box[3]]), c = map.project([bay.box[2], bay.box[1]]);
        return { ...bay, x0: a.x, y0: a.y, x1: c.x, y1: c.y };
      });
      waterDirty = false;
      resetCurrents();
    } catch (e) { console.warn('water', e); }
  }
  // rebuild shortly after the view settles or new tiles arrive (the map is never fully "idle":
  // the road-work pulse keeps it busy)
  let waterTimer = 0;
  const soon = () => { clearTimeout(waterTimer); waterTimer = setTimeout(rebuildWater, 250); };
  map.on('move', () => { waterDirty = true; clearTimeout(waterTimer); });
  map.on('moveend', () => { const b = document.body.classList; if (!b.contains('chase') && !b.contains('following')) soon(); });
  map.on('sourcedata', (e) => { if (e.sourceId === 'omt' && e.tile && !map.isMoving()) soon(); });

  // bay current streaks
  let currents = [];
  let chop = []; // wind chop flecks on the bays (drawn in drawOcean)
  function spawnChop() {
    const b = bayPx[Math.floor(Math.random() * bayPx.length)];
    return { x: rnd(b.x0, b.x1), y: rnd(b.y0, b.y1), r: rnd(2, 3.5 + windKt / 8), life: 0, max: rnd(20, 50) };
  }
  function resetCurrents() {
    currents = [];
    if (!tideInfo) return;
    const strength = clamp(tideInfo.rate / 1.5, 0.15, 1); // ~1.5 ft/h is a strong tide here
    for (const b of bayPx) {
      const area = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
      const n = Math.min(260, Math.round(area / 1e4 * 2.2 * strength));
      for (let i = 0; i < n; i++) currents.push(spawnCurrent(b, strength, true));
    }
  }
  function spawnCurrent(b, strength) {
    const dir = tideInfo.rising ? 1 : -1; // flood runs in (east), ebb runs out (west)
    return { b, x: rnd(b.x0, b.x1), y: rnd(b.y0, b.y1), vx: dir * (0.6 + strength * 2.2) * rnd(0.7, 1.2), vy: rnd(-0.08, 0.08),
      len: rnd(8, 18), life: 0, max: rnd(50, 110), strength };
  }
  // text labels in the bays and on the bar
  const bayMarkers = BAYS.map((bay) => {
    const el = document.createElement('div');
    el.className = 'bay-lbl';
    return { bay, el, m: new maplibregl.Marker({ element: el }).setLngLat(bay.label).addTo(map) };
  });
  function updateBays() {
    for (const { bay, el } of bayMarkers) {
      if (!tideInfo) { el.textContent = ''; continue; }
      const word = tideInfo.rising ? 'FLOOD ▶' : '◀ EBB';
      el.innerHTML = `<b>${bay.name}</b><span class="${tideInfo.rising ? 'fl' : 'eb'}">${word} ${tideInfo.rate.toFixed(1)} FT/H</span>`;
    }
    resetCurrents();
    window.htDeclutter?.();
  }
  const barEl = document.createElement('div');
  barEl.className = 'bar-lbl';
  new maplibregl.Marker({ element: barEl, anchor: 'right', offset: [-8, 0] }).setLngLat([(BAR_LINE[0][0] + BAR_LINE[1][0]) / 2, (BAR_LINE[0][1] + BAR_LINE[1][1]) / 2]).addTo(map);
  function updateBar() {
    if (!sea?.bar) { barEl.textContent = ''; return; }
    barEl.textContent = `BAR ${sea.bar.split(',')[0].toUpperCase()}`;
    barEl.style.color = sea.color;
    barEl.style.borderColor = sea.color;
    window.htDeclutter?.();
    const src = map.getSource('barline');
    if (src) { src.setData(barGeo()); map.setPaintProperty('barline', 'line-color', sea.color); }
  }
  const barGeo = () => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: BAR_LINE }, properties: {} });
  function addBarLayer() {
    if (map.getSource('barline')) return;
    map.addSource('barline', { type: 'geojson', data: barGeo() });
    map.addLayer({ id: 'barline', type: 'line', source: 'barline', layout: { 'line-cap': 'round', visibility: fxOn ? 'visible' : 'none' },
      paint: { 'line-color': sea?.color || '#ffc400', 'line-width': 3, 'line-dasharray': [0.6, 1.8] } }, 'outside');
  }

  function drawOcean(t) {
    if (!water || waterDirty) return;
    ctx.save();
    ctx.clip(water, 'nonzero');
    // --- swell on the open ocean (the bays are cut out) ---
    if (sea?.waveFt != null) {
      ctx.save();
      // only the open Pacific off our coast: nothing inland (Puget Sound, Hood Canal) or north of the Strait (San Juans)
      const nw = map.project([-127, 48.0]), se = map.project([-123.98, 46.2]);
      // two separate cuts: first keep only the open-ocean box, then remove the bays. (Done in one even-odd cut,
      // the part of a bay outside the box flipped back to "ocean" and swell showed in the inner harbor.)
      const ocean = new Path2D();
      ocean.rect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
      ctx.clip(ocean);
      const noBays = new Path2D();
      noBays.rect(-10, -10, W + 20, H + 20);
      for (const b of bayPx) noBays.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.clip(noBays, 'evenodd');
      const toward = ((sea.dirDeg + 180) % 360) * Math.PI / 180;
      const tx = Math.sin(toward), ty = -Math.cos(toward);   // direction the swell travels, on screen
      const cx = -ty, cy = tx;                               // along the crest
      const spacing = clamp(sea.periodS * 4.5, 28, 80);
      const speed = spacing / Math.max(3, sea.periodS * 0.5); // px per second
      const off = (t / 1000 * speed) % spacing;
      const diag = Math.hypot(W, H);
      const alpha = clamp(sea.waveFt / 12, 0.18, 0.8);
      ctx.strokeStyle = '#bff4ff'; // cool sea color; the bar's condition color lives on the bar line and the meter
      ctx.lineWidth = 1 + clamp(sea.waveFt / 8, 0, 1.6);
      ctx.setLineDash([14, 7, 4, 7]);
      for (let k = -Math.ceil(diag / spacing); k <= Math.ceil(diag / spacing); k++) {
        const d = k * spacing + off;
        const px = W / 2 + tx * d, py = H / 2 + ty * d;
        ctx.globalAlpha = alpha * (0.55 + 0.45 * Math.sin(k * 1.7)); // uneven sets, like real swell
        ctx.lineDashOffset = k * 11;
        ctx.beginPath(); ctx.moveTo(px - cx * diag, py - cy * diag); ctx.lineTo(px + cx * diag, py + cy * diag); ctx.stroke();
        // whitecaps once the seas get big
        if (sea.waveFt >= 8) {
          ctx.globalAlpha = clamp((sea.waveFt - 6) / 10, 0.2, 0.8) * (0.5 + 0.5 * Math.sin(t / 300 + k));
          ctx.fillStyle = '#e8f6ff';
          for (let s = -8; s <= 8; s++) {
            const u = s * 70 + ((k * 37) % 70);
            ctx.fillRect(px + cx * u, py + cy * u, 2, 2);
          }
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    // --- tidal current in the bays: calm water, just small chevrons drifting with the flow ---
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'miter';
    for (let i = 0; i < currents.length; i++) {
      const p = currents[i];
      p.x += p.vx * 0.5; p.y += p.vy; p.life++;
      if (p.life > p.max || p.x < p.b.x0 || p.x > p.b.x1) { currents[i] = spawnCurrent(p.b, p.strength); continue; }
      const a = Math.sin(Math.PI * p.life / p.max) * (0.25 + 0.35 * p.strength);
      const s = Math.sign(p.vx); // › points the way the water is going
      ctx.strokeStyle = `rgba(80,230,190,${a})`;
      ctx.beginPath();
      for (const k of [0, 6]) { ctx.moveTo(p.x - s * (k + 4), p.y - 3.5); ctx.lineTo(p.x - s * k, p.y); ctx.lineTo(p.x - s * (k + 4), p.y + 3.5); }
      ctx.stroke();
    }
    // --- wind chop on the bays: little wave crests that flicker in and out, more of them the windier it is ---
    if (windKt >= 5 && bayPx.length) {
      const area = bayPx.reduce((n, b) => n + Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0), 0);
      const want = Math.min(220, Math.round(area / 1e4 * Math.min(6, (windKt - 4) / 3)));
      while (chop.length < want) chop.push(spawnChop());
      chop.length = want;
      ctx.lineWidth = 1;
      for (let i = 0; i < chop.length; i++) {
        const p = chop[i];
        p.life++;
        if (p.life > p.max) { chop[i] = spawnChop(); continue; }
        const a = Math.sin(Math.PI * p.life / p.max) * Math.min(0.55, 0.2 + windKt / 50);
        ctx.strokeStyle = `rgba(191,244,255,${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y + 2, p.r, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); // a small crest
      }
    }
    ctx.restore();
  }

  // ================= wiring =================
  const ready = () => { addRadar(); addZoneLayers(); addBarLayer(); setRadar(radarOn); setFx(fxOn); };
  if (map.isStyleLoaded()) ready(); else map.once('load', ready);
  let lastWx = null;
  window.addEventListener('ht:weather', (e) => {
    lastWx = e.detail;
    clearTimeout(updateZones._t);
    updateZones._t = setTimeout(() => updateZones(lastWx), 300); // weather and alerts arrive separately; let both land
  });
  skySvg();
  setInterval(skySvg, 60 * 1000);

  // for testing from the console: htWx.preview('Heavy Rain', 35, 'SW') or htWx.preview('Thunderstorms')
  window.htWx = {
    debug: () => zones.map((z) => ({ zone: z.url.split('/').pop(), kind: z.cond.kind, level: z.cond.level, box: z.box, fall: z.fall?.length, gusts: z.gusts?.length })),
    preview(forecast, windMph = 10, windDir = 'SW') {
      if (!lastWx) return 'weather not loaded yet';
      const wx = Object.fromEntries(Object.entries(lastWx.wx).map(([k, v]) => [k, { ...v, f: forecast, windMph, windDir, rain: 100 }]));
      previewing = true;
      updateZones({ ...lastWx, wx });
      return 'previewing; reload the page to go back to live weather';
    }
  };
})();
