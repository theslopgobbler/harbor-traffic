// River levels: NOAA/NWS river gauges (National Water Prediction Service), current stage and forecast with
// flood status. Markers on the map, a RIVERS list in the WX tab, and flood alerts in PERIL and the ticker.
(() => {
  const map = window.htMap;
  if (!map) return;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const API = 'https://api.water.noaa.gov/nwps/v1/gauges';
  // flood categories, mildest to worst, with their colors
  const CAT = {
    no_flooding: { rank: 1, word: 'NORMAL', color: '#39ff88' },
    action: { rank: 2, word: 'NEAR FLOOD', color: '#ffc400' },
    minor: { rank: 3, word: 'MINOR FLOOD', color: '#ff7a1a' },
    moderate: { rank: 4, word: 'MODERATE FLOOD', color: '#ff2a3d' },
    major: { rank: 5, word: 'MAJOR FLOOD', color: '#ff2bd6' }
  };
  const cat = (c) => CAT[c] || { rank: 0, word: 'NO FLOOD LEVELS SET', color: '#5f9c8b' };
  // same area as the rest of the map: leave out Chehalis/Centralia and Hood Canal
  const inArea = (g) => !(g.longitude > -123.05 && g.latitude < 46.76) && !(g.longitude > -123.3 && g.latitude > 47.25);
  const short = (n) => n.replace(/\s+(River|Rver|R)\b/i, '').replace(/ near /i, ' nr ').replace(/ at /i, ' @ ');

  let gauges = [];
  const markers = new Map();
  const details = {}; // lid -> flood stages (fetched when a gauge is opened)

  function worst(g) {
    const o = cat(g.status?.observed?.floodCategory), f = cat(g.status?.forecast?.floodCategory);
    return f.rank > o.rank ? { ...f, forecast: true } : o;
  }
  const fmt = (v, u) => v == null || v < -900 ? '--' : `${(+v).toFixed(u === 'kcfs' ? 2 : 1)} ${String(u || '').toUpperCase()}`;

  async function popupHtml(g) {
    if (!details[g.lid]) {
      try {
        const d = await (await fetch(`${API}/${g.lid}`)).json();
        details[g.lid] = d.flood?.categories || {};
      } catch { details[g.lid] = {}; }
    }
    const cats = details[g.lid];
    const stages = ['action', 'minor', 'moderate', 'major'].filter((k) => cats[k]?.stage > -900)
      .map((k) => `<span style="color:${CAT[k].color}">${CAT[k].word.replace(' FLOOD', '')} ${cats[k].stage} FT</span>`).join(' · ');
    const o = g.status?.observed || {}, f = g.status?.forecast || {};
    const t = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    return `<h3>${esc(g.name.toUpperCase())}</h3>
      <p>NOW <b style="color:${cat(o.floodCategory).color}">${fmt(o.primary, o.primaryUnit)}</b> · ${cat(o.floodCategory).word}${o.secondary != null && o.secondary > -900 ? ` · ${fmt(o.secondary, o.secondaryUnit)}` : ''}</p>
      ${f.primary != null && f.primary > -900 ? `<p>FORECAST <b style="color:${cat(f.floodCategory).color}">${fmt(f.primary, f.primaryUnit)}</b> · ${cat(f.floodCategory).word} · ${esc(t(f.validTime))}</p>` : ''}
      ${stages ? `<div class="m">FLOOD STAGES: ${stages}</div>` : ''}
      <div class="m">NOAA RIVER GAUGE ${esc(g.lid)} · ${esc(t(o.validTime))} · <a href="https://water.noaa.gov/gauges/${esc(g.lid.toLowerCase())}" target="_blank" rel="noopener">HYDROGRAPH</a></div>`;
  }

  function render() {
    const seen = new Set();
    for (const g of gauges) {
      seen.add(g.lid);
      const w = worst(g);
      let mk = markers.get(g.lid);
      if (!mk) {
        const el = document.createElement('div');
        el.className = 'river-mk';
        const p = new maplibregl.Popup({ offset: 10, maxWidth: '300px' });
        p.on('open', async () => { p.setHTML('<div class="m">LOADING…</div>'); p.setHTML(await popupHtml(markers.get(g.lid)._g)); window.htKeepInView?.(p); });
        mk = new maplibregl.Marker({ element: el }).setLngLat([g.longitude, g.latitude]).setPopup(p).addTo(map);
        markers.set(g.lid, mk);
      }
      mk._g = g;
      const el = mk.getElement();
      el.classList.toggle('flood', w.rank >= 3);
      el.style.setProperty('--c', w.color);
      const o = g.status?.observed || {};
      el.innerHTML = `<i></i><span>${o.primary != null && o.primary > -900 ? (+o.primary).toFixed(1) : '--'}</span>`;
      el.title = `${g.name}: ${w.word}${w.forecast ? ' (forecast)' : ''}`;
    }
    for (const [lid, mk] of markers) if (!seen.has(lid)) { mk.remove(); markers.delete(lid); }
    showByZoom();
    renderList();
  }
  // up close they all show; zoomed out, only gauges at or near flood stage
  function showByZoom() {
    const z = map.getZoom();
    for (const mk of markers.values()) mk.getElement().style.display = z >= 9 || worst(mk._g).rank >= 2 ? '' : 'none';
    window.htDeclutter?.();
  }
  map.on('zoomend', showByZoom);

  function renderList() {
    const sorted = gauges.slice().sort((a, b) => worst(b).rank - worst(a).rank || a.name.localeCompare(b.name));
    const box = $('#riverList');
    if (box) box.innerHTML = sorted.length ? sorted.map((g) => {
      const w = worst(g), o = g.status?.observed || {};
      return `<li class="clickable" data-lid="${esc(g.lid)}" style="border-left-color:${w.color}">
        <span>${esc(short(g.name).toUpperCase())}<br><span class="m" style="color:${w.color}">${w.word}${w.forecast ? ' (FORECAST)' : ''}</span></span>
        <span class="temp" style="color:${cat(o.floodCategory).color}">${fmt(o.primary, o.primaryUnit)}</span></li>`;
    }).join('') : '<li class="empty">NO RIVER DATA RIGHT NOW</li>';
    // flooding (or forecast to flood): an alert in PERIL and the ticker
    const flooding = sorted.filter((g) => worst(g).rank >= 3);
    const alerts = $('#floodAlerts');
    if (alerts) alerts.innerHTML = flooding.map((g) => { const w = worst(g); return `<li class="${w.rank >= 4 ? 'k-closure' : 'k-work'} clickable" data-lid="${esc(g.lid)}">
      <div class="t">🌊 ${w.word}${w.forecast ? ' FORECAST' : ''}: ${esc(g.name.toUpperCase())}</div>
      <div class="m">NOW ${fmt(g.status?.observed?.primary, g.status?.observed?.primaryUnit)}${w.forecast ? ` · FORECAST ${fmt(g.status?.forecast?.primary, g.status?.forecast?.primaryUnit)}` : ''}</div></li>`; }).join('');
    window.htPerilFlood = flooding.length;
    window.htPerilRefresh?.();
    window.htTicker = window.htTicker || {};
    window.htTicker.flood = flooding.map((g) => `${worst(g).word.toLowerCase()}${worst(g).forecast ? ' forecast' : ''}: ${g.name}`).join(' · ');
    window.htTickerRefresh?.();
  }
  document.addEventListener('click', (e) => {
    const li = e.target.closest('#riverList li[data-lid], #floodAlerts li[data-lid]'); if (!li) return;
    const mk = markers.get(li.dataset.lid); if (!mk) return;
    map.flyTo({ center: mk.getLngLat(), zoom: Math.max(map.getZoom(), 11) });
    if (!mk.getPopup().isOpen()) mk.togglePopup();
  });

  async function load() {
    try {
      const j = await (await fetch(`${API}?bbox.xmin=-124.45&bbox.ymin=46.6&bbox.xmax=-122.8&bbox.ymax=47.92&srid=EPSG_4326`, { cache: 'no-store' })).json();
      gauges = (j.gauges || []).filter((g) => inArea(g) && g.status?.observed?.floodCategory !== 'out_of_service' &&
        g.status?.observed?.floodCategory !== 'obs_not_current' && g.status?.observed?.primaryUnit === 'ft');
    } catch (e) { console.warn('rivers', e); }
    render();
  }
  load();
  setInterval(load, 10 * 60 * 1000); // gauges report every 15 min to an hour
})();
