// Earthquakes (USGS, last 7 days within 300 km, M1.5+) and tsunami alerts (from the NWS alerts app.js already
// loads). Rings on the map, a list and alerts in the PERIL tab, lines for the TV ticker.
(() => {
  const map = window.htMap;
  if (!map) return;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HOME = { lat: 46.9754, lon: -123.8157 }; // Aberdeen
  const km = (a, b) => {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? `${m} MIN AGO` : m < 1440 ? `${Math.round(m / 60)} H AGO` : `${Math.round(m / 1440)} D AGO`;
  };
  // color by strength: pale for small quakes, deepening to red and crimson for big ones
  const magColor = (m) => m < 2.5 ? '#fff1a8' : m < 3.5 ? '#ffc400' : m < 4.5 ? '#ff7a1a' : m < 5.5 ? '#ff2a3d' : '#c0001e';
  // age shows as fading: full strength today, fainter over the week
  const ageFade = (t) => { const h = (Date.now() - t) / 36e5; return h < 24 ? 1 : h < 72 ? 0.7 : 0.4; };
  // worth an alert (the red count and the ticker) for its first 24 hours: big and regional, or moderate and close
  const BIG = (q) => (q.mag >= 5 && q.km <= 300 || q.mag >= 4 && q.km <= 60) && Date.now() - q.time < 864e5;
  // what shows on the map and in the list: nearby quakes, plus big ones farther out
  const SHOWN = (q) => q.km <= 150 || q.mag >= 5;

  let quakes = [], tsunami = [];
  const empty = { type: 'FeatureCollection', features: [] };
  const toGeo = () => ({ type: 'FeatureCollection', features: quakes.map((q) => ({ type: 'Feature',
    geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
    properties: { id: q.id, mag: q.mag, color: magColor(q.mag), op: ageFade(q.time), fresh: Date.now() - q.time < 36e5 ? 1 : 0 } })) });
  function addLayers() {
    if (map.getSource('quakes')) return;
    map.addSource('quakes', { type: 'geojson', data: toGeo() });
    // a faint filled disc and a crisp ring, both sized by magnitude
    map.addLayer({ id: 'quake-fill', type: 'circle', source: 'quakes', paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 1.5, 4, 3, 8, 5, 18, 7, 34],
      'circle-color': ['get', 'color'], 'circle-opacity': ['*', 0.16, ['get', 'op']], 'circle-blur': 0.3 } }, 'outside');
    map.addLayer({ id: 'quake-ring', type: 'circle', source: 'quakes', paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 1.5, 4, 3, 8, 5, 18, 7, 34],
      'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': ['get', 'op'] } }, 'outside');
    // the newest ones get a ring that keeps expanding outward
    map.addLayer({ id: 'quake-pulse', type: 'circle', source: 'quakes', filter: ['==', ['get', 'fresh'], 1], paint: {
      'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ff2a3d', 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.8 } }, 'outside');
    map.on('click', 'quake-ring', (e) => {
      const q = quakes.find((x) => x.id === e.features[0].properties.id);
      if (q) new maplibregl.Popup({ offset: 8, maxWidth: '300px' }).setLngLat([q.lon, q.lat]).setHTML(popupHtml(q)).addTo(map);
    });
    map.on('mouseenter', 'quake-ring', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'quake-ring', () => (map.getCanvas().style.cursor = ''));
  }
  if (map.isStyleLoaded()) addLayers(); else map.once('load', addLayers);
  let pulseLast = 0;
  (function pulse(t) {
    requestAnimationFrame(pulse);
    if (t - pulseLast < 50 || document.hidden || !map.getLayer('quake-pulse')) return;
    pulseLast = t;
    const p = (t % 2000) / 2000;
    map.setPaintProperty('quake-pulse', 'circle-radius', 8 + p * 40);
    map.setPaintProperty('quake-pulse', 'circle-stroke-opacity', 0.9 * (1 - p));
  })(0);

  const popupHtml = (q) => `<h3>M${q.mag.toFixed(1)} EARTHQUAKE</h3><p>${esc(q.place)}</p>
    <div class="m">${ago(q.time)} · ${new Date(q.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
    · DEPTH ${q.depth.toFixed(0)} KM · ${Math.round(q.km)} KM FROM ABERDEEN${q.felt ? ` · ${q.felt} FELT REPORTS` : ''}
    ${/^https:/.test(q.url) ? ` · <a href="${esc(q.url)}" target="_blank" rel="noopener">USGS</a>` : ''}</div>`;

  function render() {
    const src = map.getSource('quakes');
    if (src) src.setData(toGeo());
    // tsunami first, always
    const tBox = $('#tsunamiBox');
    tBox.innerHTML = tsunami.length ? tsunami.map((a) => `<li class="k-closure tsunami"><div class="t">🌊 ${esc(a.event.toUpperCase())}</div>
        <div class="m">${esc(a.headline || a.areaDesc || '')}</div>
        <div class="m"><b>On the coast: strong shaking or a long quake means move to high ground right away. Don't wait for an alert.</b></div></li>`).join('')
      : '<li class="empty">NO TSUNAMI ALERTS FOR THE COAST</li>';
    // strong nearby quake
    const big = quakes.filter(BIG);
    $('#quakeAlerts').innerHTML = big.map((q) => `<li class="k-work clickable" data-q="${esc(q.id)}"><div class="t">⚠ M${q.mag.toFixed(1)} EARTHQUAKE ${Math.round(q.km)} KM AWAY</div>
      <div class="m">${esc(q.place)} · ${ago(q.time)} · depth ${q.depth.toFixed(0)} km</div></li>`).join('');
    $('#quakeList').innerHTML = quakes.length ? quakes.map((q) => `<li class="clickable" data-q="${esc(q.id)}" style="border-left-color:${magColor(q.mag)}">
      <div class="t"><span style="color:${magColor(q.mag)}">M${q.mag.toFixed(1)}</span> ${esc(q.place.toUpperCase())}</div>
      <div class="m">${ago(q.time)} · ${Math.round(q.km)} KM FROM ABERDEEN · DEPTH ${q.depth.toFixed(0)} KM</div></li>`).join('')
      : '<li class="empty">NO EARTHQUAKES M1.5+ NEARBY THIS WEEK</li>';
    // counts and ticker
    window.htPerilExtra = tsunami.length + big.length;
    window.htPerilRefresh?.();
    window.htTicker = window.htTicker || {};
    window.htTicker.tsunami = tsunami.map((a) => a.event).join(' · ');
    window.htTicker.quake = big.map((q) => `M${q.mag.toFixed(1)} ${q.place} (${ago(q.time).toLowerCase()})`).join(' · ');
    window.htTickerRefresh?.();
  }
  document.addEventListener('click', (e) => {
    const li = e.target.closest('#quakeList li[data-q], #quakeAlerts li[data-q]'); if (!li) return;
    const q = quakes.find((x) => x.id === li.dataset.q); if (!q) return;
    map.flyTo({ center: [q.lon, q.lat], zoom: Math.min(map.getZoom(), 8) });
    new maplibregl.Popup({ offset: 8, maxWidth: '300px' }).setLngLat([q.lon, q.lat]).setHTML(popupHtml(q)).addTo(map);
  });

  async function loadQuakes() {
    try {
      const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 16);
      const j = await (await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=47.0&longitude=-123.8&maxradiuskm=300&minmagnitude=1.5&starttime=${since}&orderby=time`)).json();
      quakes = (j.features || []).map((f) => ({ id: f.id, mag: f.properties.mag, place: f.properties.place || 'Unknown location', time: f.properties.time,
        url: f.properties.url, felt: f.properties.felt, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: f.geometry.coordinates[2] || 0 }))
        .map((q) => ({ ...q, km: km(HOME, q) })).filter(SHOWN);
    } catch (e) { console.warn('quakes', e); }
    render();
  }
  // tsunami alerts ride in with the NWS alerts app.js loads (any tsunami product that names our coast)
  window.addEventListener('ht:weather', (e) => {
    const zones = new Set(Object.values(e.detail.zonesByTown || {}).flat());
    tsunami = (e.detail.nws || []).filter((a) => /tsunami/i.test(a.event || '') &&
      ((a.affectedZones || []).some((z) => zones.has(z)) || /Grays Harbor|Pacific County|Jefferson|Washington Coast|north coast|south coast/i.test(a.areaDesc || '')));
    render();
  });
  loadQuakes();
  setInterval(loadQuakes, 5 * 60 * 1000);
})();
