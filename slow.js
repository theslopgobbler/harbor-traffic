// Possible slowdowns from the buses' GPS (the relay works them out, see slowCheck and stretchCheck in
// scripts/relay-worker.js; bus.js passes them along from /buses as window.htSlow and window.htStretch). A pixel turtle
// in a warning triangle on the map, colored lines along slow stretches, a line at the top of the ROADS tab, and the
// ticker. Shown and hidden with ROADS.
(() => {
  const map = window.htMap;
  if (!map) return;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const towns = (window.HT?.towns || []).filter((t) => !t.minor);
  const near = (s) => {
    let best = null, bd = Infinity;
    for (const t of towns) { const d = Math.hypot((t.lon - s.lon) * 76, (t.lat - s.lat) * 111); if (d < bd) { bd = d; best = t; } }
    if (!best) return '';
    const mi = bd / 1.609;
    return mi < 1.5 ? `IN ${best.name.toUpperCase()}` : `${Math.round(mi)} MI FROM ${best.name.toUpperCase()}`;
  };
  const mins = (ms) => Math.max(1, Math.round(ms / 60000));
  const at = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // the turtle, seen from above, head up: drawn pixel by pixel with a black outline, like the outage bolts.
  // S shell, p shell pattern, r shell rim, b skin, e eye
  const TURTLE = [
    '....bbb....',
    '...bebeb...',
    '....bbb....',
    'bb.rrrrr.bb',
    'bbrSpppSrbb',
    '.rSpSSSpSr.',
    '.rpSSSSSpr.',
    '.rSpSSSpSr.',
    '.rSSpppSSr.',
    'bbrSSSSSrbb',
    'bb.rrrrr.bb',
    '.....b.....'];
  const PAL = { S: [255, 122, 26], p: [170, 60, 10], r: [205, 85, 15], b: [150, 210, 90], e: [0, 0, 0] };
  // the turtle inside the same orange warning triangle as the road alerts (dark fill, orange edge, soft glow)
  function turtle(dim) {
    const dpr = 2, W = 36, H = 33, Z = 1, cv = document.createElement('canvas');
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.globalAlpha = dim ? 0.55 : 1;
    g.beginPath(); g.moveTo(W / 2, 4); g.lineTo(W - 3, H - 4); g.lineTo(3, H - 4); g.closePath();
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fill();
    g.shadowColor = 'rgba(255,122,26,.8)'; g.shadowBlur = 5;
    g.lineJoin = 'miter'; g.lineWidth = 2.6; g.strokeStyle = '#ff7a1a'; g.stroke();
    g.shadowBlur = 0;
    // the pixel turtle (each turtle pixel is 2 screen pixels on a phone), sitting on the bottom edge
    const tw = TURTLE[0].length + 2, th = TURTLE.length + 2, ox = Math.round((W - tw * Z)) / 2, oy = H - 6 - th * Z;
    const ch = (x, y) => TURTLE[y - 1]?.[x - 1];
    const on = (x, y) => { const c = ch(x, y); return c != null && c !== '.'; };
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      let c = null;
      if (on(x, y)) {
        const k = ch(x, y);
        c = PAL[k];
      } else for (let dy = -1; dy <= 1 && !c; dy++) for (let dx = -1; dx <= 1; dx++) if (on(x + dx, y + dy)) { c = [0, 0, 0]; break; }
      if (!c) continue;
      g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.fillRect(ox + x * Z, oy + y * Z, Z, Z);
    }
    return { img: g.getImageData(0, 0, cv.width, cv.height), dpr };
  }

  // two kinds: stops (window.htSlow: a bus crawling or stopped 3+ minutes) and slow stretches (window.htStretch: a bus
  // driving slower than usual along the road; see stretchCheck in scripts/relay-worker.js). A stretch at 75-90% of
  // the usual speed is only a faint yellow line; slower than that it gets a colored line and the turtle too
  const LVL = { moderate: ['#ffc400', 'MODERATE'], heavy: ['#ff7a1a', 'HEAVY'], stop: ['#ff2a3d', 'STOP AND GO'] };
  let list = []; // the turtles: { kind: 'stop' | 'str', s }
  let strs = [];
  // a stretch is only a handful of GPS points ~300 m apart: joined straight they cut across every curve, so lay
  // them onto the route's own road shape (bus.js has the shapes) and follow it between them. Off any shape: as is
  const snapCache = new Map();
  function onRoad(s) {
    const shapes = window.htBusInternals?.shapesByRoute;
    if (!shapes || !Object.keys(shapes).length || s.pts.length < 2) return s.pts; // (not loaded yet: try again next time)
    const key = s.id + ':' + s.pts.length + ':' + s.pts[s.pts.length - 1];
    if (snapCache.has(key)) return snapCache.get(key);
    const K = [76000, 111000];
    // where a point lands on one shape: the nearest spot within 120 m (a looping route passes some spots twice: a
    // little nudge toward the spot nearest the last point's keeps it on the same pass)
    const land = (sh, p, prev) => {
      let best = null;
      for (let i = 0; i < sh.c.length - 1; i++) {
        const a = sh.c[i], b = sh.c[i + 1];
        const ax = (b[0] - a[0]) * K[0], ay = (b[1] - a[1]) * K[1], px = (p[0] - a[0]) * K[0], py = (p[1] - a[1]) * K[1];
        const L2 = ax * ax + ay * ay, t = L2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / L2)) : 0;
        const dist = Math.hypot(px - t * ax, py - t * ay);
        if (dist > 120) continue;
        const along = sh.d[i] + t * (sh.d[i + 1] - sh.d[i]);
        const score = dist + (prev == null ? 0 : 0.02 * Math.abs(along - prev));
        if (!best || score < best.score) best = { i, t, along, dist, score, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
      }
      return best;
    };
    let pick = null;
    const all = [...(shapes[s.rt] || []), ...(shapes[s.rt + 'P'] || [])];
    for (const sh of all.length ? all : Object.values(shapes).flat()) {
      const hits = [];
      for (const p of s.pts) { const h = land(sh, p, hits.length ? hits[hits.length - 1].along : null); if (!h) break; hits.push(h); }
      if (hits.length < s.pts.length) continue;
      const span = Math.abs(hits[hits.length - 1].along - hits[0].along);
      if (span > 2 * (s.m || 0) + 500) continue; // (jumped to another pass of a looping route)
      const err = hits.reduce((n, h) => n + h.dist, 0);
      if (!pick || err < pick.err) pick = { sh, hits, err };
    }
    let out = s.pts;
    if (pick) {
      const { sh, hits } = pick;
      out = [hits[0].at];
      for (let k = 1; k < hits.length; k++) {
        const a = hits[k - 1], b = hits[k];
        if (b.along >= a.along) for (let i = a.i + 1; i <= b.i; i++) out.push(sh.c[i]);
        else for (let i = a.i; i > b.i; i--) out.push(sh.c[i]);
        out.push(b.at);
      }
    }
    if (snapCache.size > 300) snapCache.clear();
    snapCache.set(key, out);
    return out;
  }
  // the turtle sits halfway along the stretch (by distance, on the road)
  const mid = (s) => {
    const c = onRoad(s), seg = (i) => Math.hypot((c[i][0] - c[i - 1][0]) * 76, (c[i][1] - c[i - 1][1]) * 111);
    let tot = 0; for (let i = 1; i < c.length; i++) tot += seg(i);
    let run = 0; for (let i = 1; i < c.length; i++) { run += seg(i); if (run >= tot / 2) return c[i]; }
    return c[0];
  };
  const geo = () => ({ type: 'FeatureCollection', features: list.map((x, i) => {
    const [lon, lat] = x.kind === 'str' ? mid(x.s) : [x.s.lon, x.s.lat];
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { i, icon: x.s.open ? 'slow-on' : 'slow-off' } };
  }) });
  const lineGeo = () => ({ type: 'FeatureCollection', features: strs.filter((s) => s.pts.length > 1).map((s) => ({ type: 'Feature',
    geometry: { type: 'LineString', coordinates: onRoad(s) },
    properties: { id: s.id, level: s.level, color: (LVL[s.level] || LVL.moderate)[0], one: s.n > 1 ? 0 : 1, op: s.open ? 0.95 : 0.55 * fadeOf(s), fade: fadeOf(s) } })) });
  // an eased stretch fades out over its keep time (render runs every minute): full strength when it eased, a quarter at the end
  const fadeOf = (s) => s.open || !s.until || !s.t1 || s.until <= s.t1 ? 1 : 0.25 + 0.75 * Math.max(0, Math.min(1, (s.until - Date.now()) / (s.until - s.t1)));
  const LINES = ['slow-faint', 'slow-glow', 'slow-case', 'slow-line', 'slow-line-1'];
  function addLayers() {
    if (map.getSource('slow')) return;
    for (const [name, dim] of [['slow-on', false], ['slow-off', true]]) if (!map.hasImage(name)) { const { img, dpr } = turtle(dim); map.addImage(name, img, { pixelRatio: dpr }); }
    map.addSource('slow', { type: 'geojson', data: geo() });
    map.addSource('slow-str', { type: 'geojson', data: lineGeo() });
    const lay = { 'line-cap': 'round', 'line-join': 'round' };
    const alert = ['!=', ['get', 'level'], 'slower'];
    // "a little slower than usual": just a faint line along the road
    map.addLayer({ id: 'slow-faint', type: 'line', source: 'slow-str', filter: ['==', ['get', 'level'], 'slower'], layout: lay,
      paint: { 'line-color': '#ffc400', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 4], 'line-opacity': ['*', 0.4, ['get', 'fade']], 'line-blur': 1 } }, 'outside');
    map.addLayer({ id: 'slow-glow', type: 'line', source: 'slow-str', filter: alert, layout: lay,
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 22], 'line-blur': 8, 'line-opacity': ['*', 0.45, ['get', 'op']] } }, 'outside');
    map.addLayer({ id: 'slow-case', type: 'line', source: 'slow-str', filter: alert, layout: lay,
      paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 6, 14, 12], 'line-opacity': ['*', 0.75, ['get', 'op']] } }, 'outside');
    // seen by 2+ buses: solid; one bus's word: dashed
    map.addLayer({ id: 'slow-line', type: 'line', source: 'slow-str', filter: ['all', alert, ['==', ['get', 'one'], 0]], layout: lay,
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7], 'line-opacity': ['get', 'op'] } }, 'outside');
    map.addLayer({ id: 'slow-line-1', type: 'line', source: 'slow-str', filter: ['all', alert, ['==', ['get', 'one'], 1]], layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7], 'line-opacity': ['get', 'op'], 'line-dasharray': [2, 1.2] } }, 'outside');
    map.addLayer({ id: 'slow-pt', type: 'symbol', source: 'slow', layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      paint: {} }, 'outside');
    const vis = document.body.classList.contains('no-roads') ? 'none' : 'visible';
    for (const id of [...LINES, 'slow-pt']) map.setLayoutProperty(id, 'visibility', vis);
    map.on('click', 'slow-pt', (e) => popup(list[e.features[0].properties.i]));
    for (const id of ['slow-line', 'slow-line-1']) map.on('click', id, (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['slow-pt'] }).length) return; // (the turtle has it)
      const x = list.find((y) => y.kind === 'str' && y.s.id === e.features[0].properties.id);
      if (x) popup(x, e.lngLat);
    });
    for (const id of ['slow-pt', 'slow-line', 'slow-line-1']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
  }
  if (map.isStyleLoaded()) addLayers(); else map.once('load', addLayers);

  // (the wording stays vague on purpose: what's slow and where, not how it's known)
  const lineStop = (s) => s.open
    ? `NEARLY STOPPED WHERE TRAFFIC USUALLY MOVES ${s.usual} MPH · ${mins((s.seen || Date.now()) - s.t0)} MIN SO FAR${s.n > 1 ? ' · CONFIRMED' : ''}`
    : `EASED AT ${at(s.end)} AFTER ${mins(s.end - s.t0)} MIN`;
  const lineStr = (s) => `ABOUT ${Math.round((s.avg || 0) * 100)}% OF THE USUAL SPEED FOR ${(s.m / 1609).toFixed(1)} MI`
    + (s.open ? ` · ${mins(Date.now() - s.t0)} MIN SO FAR` : ` · EASED AT ${at(s.t1)}`) + (s.n > 1 ? ' · CONFIRMED' : '');
  const title = (x) => x.kind === 'str' ? `SLOW TRAFFIC · ${LVL[x.s.level][1]}${x.s.open ? '' : ' (EASED)'}` : `POSSIBLE SLOWDOWN${x.s.open ? '' : ' (EASED)'}`;
  const whereOf = (x) => { const [lon, lat] = x.kind === 'str' ? mid(x.s) : [x.s.lon, x.s.lat]; return { lon, lat }; };
  const popup = (x, ll) => {
    if (!x) return;
    const s = x.s, w = whereOf(x);
    const how = x.kind === 'str'
      ? `Traffic moving well under its usual speed along this stretch. ${s.n > 1 ? 'Confirmed.' : 'Dashed until it is confirmed.'} Clears once things are moving normally again.`
      : `Traffic crawling or stopped here for a few minutes. Clears once things are moving normally again.`;
    new maplibregl.Popup({ offset: 10, maxWidth: '280px' }).setLngLat(ll || [w.lon, w.lat]).setHTML(
      `<h3>${title(x)}</h3><div class="m">${esc(near(w))} · SINCE ${at(s.t0)}</div>
      <p>${x.kind === 'str' ? lineStr(s) : lineStop(s)}.</p><div class="m">${how}</div>`).addTo(map);
  };

  function render() {
    const now = Date.now();
    const stops = (window.htSlow || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    strs = (window.htStretch || []).filter((s) => Array.isArray(s.pts) && s.pts.length && (!s.until || now < s.until) && (s.level === 'slower' || LVL[s.level]));
    list = stops.map((s) => ({ kind: 'stop', s }));
    // a turtle for each colored stretch, unless a stop turtle already sits within 500 m of it
    for (const s of strs) {
      if (s.level === 'slower') continue;
      const [lon, lat] = mid(s);
      if (stops.some((o) => Math.hypot((o.lon - lon) * 76, (o.lat - lat) * 111) < 0.5)) continue;
      list.push({ kind: 'str', s });
    }
    map.getSource('slow')?.setData(geo());
    map.getSource('slow-str')?.setData(lineGeo());
    // above the bus route lines (bus.js adds those later; a red route under a red stretch hid it)
    if (map.getLayer('slow-pt') && map.getLayer('bus-route-lines')) {
      const order = map.getStyle().layers.map((l) => l.id);
      if (order.indexOf('slow-pt') < order.indexOf('bus-route-lines')) for (const id of [...LINES, 'slow-pt']) map.moveLayer(id);
    }
    const el = $('#slowList');
    if (el) {
      el.innerHTML = list.map((x, i) => `<li class="clickable k-work" data-i="${i}" style="${x.kind === 'str' ? `border-left-color:${LVL[x.s.level][0]};` : ''}${x.s.open ? '' : 'opacity:.6'}">
        <div class="t">${title(x)} · ${esc(near(whereOf(x)))}</div><div class="m">${x.kind === 'str' ? lineStr(x.s) : lineStop(x.s)}</div></li>`).join('');
      el.onclick = (e) => {
        const li = e.target.closest('li[data-i]'); const x = li && list[+li.dataset.i]; if (!x) return;
        const w = whereOf(x);
        map.flyTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 13) }); popup(x);
      };
    }
    window.htTicker = window.htTicker || {};
    window.htTicker.slow = list.filter((x) => x.s.open).map((x) => x.kind === 'str'
      ? `${LVL[x.s.level][1].toLowerCase()} traffic ${near(whereOf(x)).toLowerCase()}`
      : `possible slowdown ${near(x.s).toLowerCase()}`).join(' · ');
    window.htTickerRefresh?.();
  }
  window.addEventListener('ht:slow', render);
  setInterval(render, 60000); // (eased stretches fade out on time between bus updates)
  render();
})();
