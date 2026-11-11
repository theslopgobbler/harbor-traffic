// Possible slowdowns: spots where a bus has been crawling for 3+ minutes where buses usually go 30+ mph (the relay
// works them out, see slowCheck in scripts/relay-worker.js; bus.js passes them along from /buses as window.htSlow).
// A little pixel turtle on the map, a line at the top of the ROADS tab, and the ticker. Shown and hidden with ROADS.
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

  // the turtle: drawn pixel by pixel (black outline, lit top edge), like the outage bolts
  const TURTLE = [
    '..####....',
    '.######.##',
    '########.#',
    '##########',
    '.#.#..#.#.'];
  function turtle(col, dim) {
    const w = TURTLE[0].length + 2, h = TURTLE.length + 2, k = 3, dpr = 2, px = k * dpr, img = new ImageData(w * px, h * px);
    const on = (x, y) => TURTLE[y - 1]?.[x - 1] === '#';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16));
    const a = dim ? 150 : 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c = null;
      if (on(x, y)) c = on(x, y - 1) ? [r, g, b, a] : [Math.min(255, r + 80), Math.min(255, g + 80), Math.min(255, b + 80), a];
      else for (let dy = -1; dy <= 1 && !c; dy++) for (let dx = -1; dx <= 1; dx++) if (on(x + dx, y + dy)) { c = [0, 0, 0, a]; break; }
      if (!c) continue;
      for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) img.data.set(c, ((y * px + yy) * w * px + x * px + xx) * 4);
    }
    return { img, dpr };
  }

  let list = [];
  const geo = () => ({ type: 'FeatureCollection', features: list.map((s, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: { i, icon: s.open ? 'slow-on' : 'slow-off' } })) });
  function addLayers() {
    if (map.getSource('slow')) return;
    for (const [name, dim] of [['slow-on', false], ['slow-off', true]]) if (!map.hasImage(name)) { const { img, dpr } = turtle('#ff7a1a', dim); map.addImage(name, img, { pixelRatio: dpr }); }
    map.addSource('slow', { type: 'geojson', data: geo() });
    map.addLayer({ id: 'slow-pt', type: 'symbol', source: 'slow', layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      paint: {} }, 'outside');
    map.setLayoutProperty('slow-pt', 'visibility', document.body.classList.contains('no-roads') ? 'none' : 'visible');
    map.on('click', 'slow-pt', (e) => popup(list[e.features[0].properties.i]));
    map.on('mouseenter', 'slow-pt', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'slow-pt', () => (map.getCanvas().style.cursor = ''));
  }
  if (map.isStyleLoaded()) addLayers(); else map.once('load', addLayers);

  const line = (s) => s.open
    ? `BUS AT ${s.min} MPH WHERE BUSES USUALLY DO ${s.usual} · ${mins((s.seen || Date.now()) - s.t0)} MIN SO FAR${s.n > 1 ? ` · ${s.n} BUSES` : ''}`
    : `EASED AT ${at(s.end)} AFTER ${mins(s.end - s.t0)} MIN`;
  const popup = (s) => s && new maplibregl.Popup({ offset: 10, maxWidth: '280px' }).setLngLat([s.lon, s.lat]).setHTML(
    `<h3>🐢 POSSIBLE SLOWDOWN${s.open ? '' : ' (EASED)'}</h3><div class="m">${esc(near(s))} · ROUTE ${esc(s.rt)} · SINCE ${at(s.t0)}</div>
    <p>${line(s)}.</p><div class="m">From the buses' GPS: shown when a bus has been crawling or stopped for 3+ minutes away from its stops, where buses usually go 30+ mph.</div>`).addTo(map);

  function render() {
    list = (window.htSlow || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    map.getSource('slow')?.setData(geo());
    const el = $('#slowList');
    if (el) {
      el.innerHTML = list.map((s, i) => `<li class="clickable k-work" data-i="${i}"${s.open ? '' : ' style="opacity:.6"'}>
        <div class="t">🐢 POSSIBLE SLOWDOWN${s.open ? '' : ' (EASED)'} · ${esc(near(s))}</div><div class="m">${line(s)} · ROUTE ${esc(s.rt)}</div></li>`).join('');
      el.onclick = (e) => { const li = e.target.closest('li[data-i]'); const s = li && list[+li.dataset.i]; if (!s) return; map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13) }); popup(s); };
    }
    const open = list.filter((s) => s.open);
    window.htTicker = window.htTicker || {};
    window.htTicker.slow = open.map((s) => `possible slowdown ${near(s).toLowerCase()} (bus at ${s.min} mph, usually ${s.usual})`).join(' · ');
    window.htTickerRefresh?.();
  }
  window.addEventListener('ht:slow', render);
  render();
})();
