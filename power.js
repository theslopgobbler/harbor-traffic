// Power outages: Grays Harbor PUD's own outage map data (NISC "outagemap.coop", refreshed by the PUD about every
// 5 minutes; their data host allows our site to read it directly, so no relay needed). Shaded areas on the map, a
// POWER OUTAGES section in the PERIL tab (alert line when it's a big one), and a ticker line.
(() => {
  const map = window.htMap;
  if (!map) return;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BASE = 'https://outagemap-data.cloud.coop/ghpud/Hosted_Outage_Map/';
  // the PUD's points and areas are sent as meters (web mercator) counted from the corner of their service area
  // (their config's boundaryExtent); fetched fresh from config.json in case they ever move it
  let X0 = -13851161, Y0 = 5889142;
  const R = 6378137, D = 180 / Math.PI;
  const toLL = (x, y) => [(x + X0) / R * D, (2 * Math.atan(Math.exp((y + Y0) / R)) - Math.PI / 2) * D];
  // worth an alert line (and the PERIL count, and the ticker): this many PUD customers out at once
  const ALERT_AT = 250;
  // color by customers out: amber for a handful, orange, red, deep red for the big ones
  const COLORS = ['#ffc400', '#ff7a1a', '#ff2a3d', '#ff2a8a'];
  const tier = (n) => n <= 10 ? 0 : n <= 100 ? 1 : n <= 500 ? 2 : 3;
  const color = (n) => COLORS[tier(n)];
  // the outage dots are little pixel-art lightning bolts: drawn here as bitmaps (one per color and size, each pixel a
  // solid square, black outline) so they stay crisp instead of being smoothed
  const BOLT = [
    '....###',
    '...###.',
    '..###..',
    '.###...',
    '#######',
    '....##.',
    '...##..',
    '..##...',
    '.##....',
    '##.....',
    '#......'];
  const SIZES = { s: 2, m: 3, l: 4 }; // screen pixels per bolt pixel (on a normal screen; doubled on sharp ones)
  const size = (n) => n < 10 ? 's' : n < 500 ? 'm' : 'l';
  function boltImage(col, k) {
    const w = BOLT[0].length + 2, h = BOLT.length + 2, on = (x, y) => BOLT[y - 1]?.[x - 1] === '#';
    const dpr = 2, px = k * dpr, img = new ImageData(w * px, h * px);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c = null;
      if (on(x, y)) c = (on(x, y - 1) || on(x - 1, y)) ? [r, g, b, 255] : [Math.min(255, r + 90), Math.min(255, g + 90), Math.min(255, b + 90), 255]; // lit top-left edge
      else for (let dy = -1; dy <= 1 && !c; dy++) for (let dx = -1; dx <= 1; dx++) if (on(x + dx, y + dy)) { c = [0, 0, 0, 255]; break; }
      if (!c) continue;
      for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) img.data.set(c, ((y * px + yy) * w * px + x * px + xx) * 4);
    }
    return { img, dpr };
  }
  const fmt = (n) => Number(n || 0).toLocaleString();
  const since = (t) => {
    const m = Math.max(0, Math.round((Date.now() - t) / 60000)); // (their clock can run a little ahead of ours)
    const at = new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `SINCE ${at} (${m < 60 ? m + ' MIN' : Math.floor(m / 60) + ' H ' + (m % 60) + ' MIN'})`;
  };

  let outages = [], areas = [], regions = [], served = 0, updated = 0, failed = false;
  const empty = { type: 'FeatureCollection', features: [] };
  const areaGeo = () => ({ type: 'FeatureCollection', features: areas
    .slice().sort((a, b) => b.n - a.n) // big areas first so the small ones inside them draw on top
    .map((a) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [a.ring] }, properties: { id: a.id, n: a.n, color: color(a.n) } })) });
  const pointGeo = () => ({ type: 'FeatureCollection', features: outages.map((o) => ({ type: 'Feature',
    geometry: { type: 'Point', coordinates: [o.lon, o.lat] }, properties: { id: o.id, n: o.n, icon: `bolt-${tier(o.n)}-${size(o.n)}` } })) });

  function addLayers() {
    if (map.getSource('power-areas')) return;
    map.addSource('power-areas', { type: 'geojson', data: areaGeo() });
    map.addSource('power-pts', { type: 'geojson', data: pointGeo() });
    map.addLayer({ id: 'power-fill', type: 'fill', source: 'power-areas', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.13 } }, 'outside');
    map.addLayer({ id: 'power-line', type: 'line', source: 'power-areas', layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [3, 2] } }, 'outside');
    // every outage as a pixel lightning bolt (single houses have no area): colored and sized by customers out, the
    // biggest drawn on top
    COLORS.forEach((col, i) => Object.entries(SIZES).forEach(([s, k]) => {
      const name = `bolt-${i}-${s}`;
      if (!map.hasImage(name)) { const { img, dpr } = boltImage(col, k); map.addImage(name, img, { pixelRatio: dpr }); }
    }));
    map.addLayer({ id: 'power-pt', type: 'symbol', source: 'power-pts', layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'symbol-sort-key': ['get', 'n'] } }, 'outside');
    // a tap opens an outage only when nothing else is there: outage dots and shaded areas give way to markers, road
    // warnings, traffic lines, bus stops and routes, the railroad and quakes (they open their own popups)
    const OTHERS = ['inc-glow', 'inc', 'inc-glow-p', 'inc-p', 'flow-glow', 'flow', 'bus-stops', 'bus-route-picked', 'bus-route-lines', 'rail-hit', 'quake-ring'];
    const open = (f, at) => { const o = outages.find((x) => x.id === f.properties.id); if (o) popup(o, at); };
    map.on('click', (e) => {
      if (e.originalEvent?.target?.closest?.('.maplibregl-marker, .maplibregl-popup')) return;
      const near = (px) => [[e.point.x - px, e.point.y - px], [e.point.x + px, e.point.y + px]];
      const others = OTHERS.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      if (others.length && map.queryRenderedFeatures(near(8), { layers: others }).length) return;
      const dot = map.queryRenderedFeatures(near(6), { layers: ['power-pt'] })[0];
      if (dot) return open(dot, e.lngLat);
      // (the top area under the tap is the smallest one, since the big ones are drawn first)
      const area = map.queryRenderedFeatures(e.point, { layers: ['power-fill'] })[0];
      if (area) open(area, e.lngLat);
    });
    map.on('mouseenter', 'power-pt', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'power-pt', () => (map.getCanvas().style.cursor = ''));
  }
  // shown or hidden with the WX FX button (wx.js switches these layers along with its own; this catches the start,
  // when WX FX was already off)
  const addAll = () => {
    addLayers();
    const vis = document.body.classList.contains('fx-off') ? 'none' : 'visible';
    for (const id of ['power-fill', 'power-line', 'power-pt']) map.setLayoutProperty(id, 'visibility', vis);
  };
  if (map.isStyleLoaded()) addAll(); else map.once('load', addAll);

  const popup = (o, at) => new maplibregl.Popup({ offset: 8, maxWidth: '280px' }).setLngLat(at || [o.lon, o.lat]).setHTML(
    `<h3>⚡ POWER OUT · ${fmt(o.n)} CUSTOMER${o.n === 1 ? '' : 'S'}</h3>
    <div class="m">${since(o.off)}${o.planned ? ' · PLANNED' : ''}</div>${o.comment ? `<p>${esc(o.comment)}</p>` : ''}
    <div class="m">Grays Harbor PUD · <a href="https://ghpud.outagemap.coop/" target="_blank" rel="noopener">OUTAGE MAP</a></div>`).addTo(map);

  function render() {
    map.getSource('power-areas')?.setData(areas.length ? areaGeo() : empty);
    map.getSource('power-pts')?.setData(outages.length ? pointGeo() : empty);
    // (the PUD's region numbers are the real count: its outages can overlap, one feeder and the lines below it)
    const out = regions.reduce((s, r) => s + (r.out || 0), 0);
    const pct = served ? out / served * 100 : 0;
    const big = out >= ALERT_AT;
    $('#powerAlert').innerHTML = big ? `<li class="k-closure"><div class="t">⚡ POWER OUT FOR ${fmt(out)} PUD CUSTOMERS (${pct < 1 ? '<1' : Math.round(pct)}%)</div>
      <div class="m">${esc(regions.filter((r) => r.out).sort((a, b) => b.out - a.out).map((r) => `${r.name.toUpperCase()} ${fmt(r.out)}`).join(' · '))}</div></li>` : '';
    const when = updated ? ` · PUD UPDATED ${new Date(updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    const rows = regions.filter((r) => r.served || r.out).map((r) => `<li${r.out ? ` style="border-left-color:${color(r.out)}"` : ''}>
      <div class="t">${esc(r.name.toUpperCase())} <span style="color:${r.out ? color(r.out) : 'var(--green)'}">${r.out ? fmt(r.out) + ' OUT' : 'ON'}</span></div>
      ${r.served ? `<div class="m">${fmt(r.served)} CUSTOMERS${r.out ? ` · ${Math.max(1, Math.round(r.out / r.served * 100))}% OUT` : ''}</div>` : ''}</li>`).join('');
    const top = outages.filter((o) => o.n >= 10).sort((a, b) => b.n - a.n).slice(0, 8).map((o) => `<li class="clickable" data-pw="${esc(o.id)}" style="border-left-color:${color(o.n)}">
      <div class="t">⚡ ${fmt(o.n)} OUT${o.planned ? ' · PLANNED' : ''}</div><div class="m">${since(o.off)} · TAP TO SEE AREA</div></li>`).join('');
    $('#powerList').innerHTML = failed && !updated ? '<li class="empty">PUD OUTAGE MAP NOT ANSWERING RIGHT NOW</li>'
      : !out && !outages.length ? `<li class="empty">NO PUD OUTAGES${when}</li>`
      : `<li class="m" style="border:0;padding-top:0">${fmt(out)} OF ${fmt(served)} PUD CUSTOMERS OUT${when}</li>${rows}${top ? '<li class="m" style="border:0">BIGGEST OUTAGE AREAS (THEY CAN OVERLAP: A MAIN LINE AND THE LINES BELOW IT)</li>' + top : ''}`;
    // PERIL count and ticker
    window.htPerilPower = big ? 1 : 0;
    window.htPerilRefresh?.();
    window.htTicker = window.htTicker || {};
    window.htTicker.power = out ? `${fmt(out)} PUD customers out (${regions.filter((r) => r.out).sort((a, b) => b.out - a.out).map((r) => `${r.name} ${fmt(r.out)}`).join(', ')})` : '';
    window.htTickerRefresh?.();
  }
  document.addEventListener('click', (e) => {
    const li = e.target.closest('#powerList li[data-pw]'); if (!li) return;
    const o = outages.find((x) => x.id === li.dataset.pw); if (!o) return;
    const a = areas.find((x) => x.id === o.id);
    if (a) {
      const xs = a.ring.map((p) => p[0]), ys = a.ring.map((p) => p[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, maxZoom: 13 });
    } else map.flyTo({ center: [o.lon, o.lat], zoom: Math.max(map.getZoom(), 12) });
    popup(o);
  });

  let configTried = false;
  async function load() {
    try {
      if (!configTried) {
        configTried = true;
        const c = await (await fetch(BASE + 'config.json')).json().catch(() => null);
        const b = c?.mapSettings?.boundaryExtent;
        if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) [X0, Y0] = b;
      }
      const t = Date.now();
      const [s, b] = await Promise.all([
        fetch(`${BASE}summary.json?t=${t}`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`${BASE}outage.bounds.json?t=${t}`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : { outageBoundaries: [] }).catch(() => ({ outageBoundaries: [] }))
      ]);
      outages = (s.outages || []).filter((o) => o.nbrOut > 0 && Number.isFinite(o.x) && Number.isFinite(o.y)).map((o) => {
        const [lon, lat] = toLL(o.x, o.y);
        return { id: String(o.id), n: o.nbrOut, off: o.timeOff, planned: !!o.planned, comment: o.comment || '', lon, lat };
      });
      // (the PUD's own map only draws areas for outages of 3 or more)
      areas = (b.outageBoundaries || []).filter((a) => a.nbrOut > 2 && (a.outageGeometry || []).length > 2)
        .map((a) => ({ id: String(a.outageId), n: a.nbrOut, ring: a.outageGeometry.map(([x, y]) => toLL(x, y)) }));
      const set = (s.regionDataSets || [])[0];
      regions = (set?.regions || []).map((r) => ({ name: r.name || r.id || 'Other', out: r.numberOut || 0, served: r.numberServed || 0 }));
      served = s.totalServed || regions.reduce((n, r) => n + r.served, 0);
      updated = s.lastUpdate || t;
      failed = false;
    } catch (e) { console.warn('power', e); failed = true; }
    render();
  }
  load();
  setInterval(load, 2 * 60 * 1000);
})();
