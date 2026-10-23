// Buses that stopped dead mid-route (the relay's /bus-incidents; see stallCheck in scripts/relay-worker.js): a big
// pulsing red dot where it stopped and a banner across the top. Only on the owner's own devices: the ones holding the
// stats key (stats.html saves it). Everyone else gets nothing, not even the request. The texts come from
// scripts/bus_alerts.py on the desktop.
(() => {
  let key = null;
  try { key = localStorage.getItem('ht.statsKey'); } catch {}
  const relay = (window.HT?.airRelay || '').replace(/\/aircraft$/, '');
  const map = window.htMap;
  if (!key || !relay || !map || !window.maplibregl) return;

  const css = document.createElement('style');
  css.textContent = `
    .inc-dot { width: 26px; height: 26px; border-radius: 50%; background: #ff1a1a; border: 3px solid #fff; cursor: pointer;
      box-shadow: 0 0 0 0 rgba(255,26,26,.8); animation: incpulse 1.4s ease-out infinite; }
    .inc-dot.ended { background: #7a1010; border-color: #ffb3b3; animation: none; opacity: .85; }
    @keyframes incpulse { to { box-shadow: 0 0 0 28px rgba(255,26,26,0); } }
    .inc-bar { position: fixed; left: 50%; top: 10px; transform: translateX(-50%); z-index: 50; max-width: min(92vw, 640px);
      background: #b00000; color: #fff; border: 2px solid #fff; padding: 10px 40px 10px 14px; font: 600 14px/1.35 system-ui, sans-serif;
      box-shadow: 0 4px 18px rgba(0,0,0,.5); cursor: pointer; }
    .inc-bar button { position: absolute; right: 6px; top: 6px; background: none; border: 0; color: #fff; font-size: 20px; cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { .inc-dot { animation: none; } }`;
  document.head.appendChild(css);

  const hm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mins = (ms) => Math.max(1, Math.round(ms / 60000));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const what = (x) => `Bus ${esc(x.bus)}${x.route ? ` (route ${esc(x.route)})` : ''}`;
  const status = (x) => x.open
    ? `STILL THERE · ${mins(Date.now() - x.t)} MIN`
    : x.quiet ? `TRACKER WENT QUIET AT ${hm(x.end)}, ${mins(x.end - x.t)} MIN AFTER`
    : `MOVED ON AT ${hm(x.end)}, AFTER ${mins(x.end - x.t)} MIN`;
  const popHtml = (x) => `<h3>${what(x).toUpperCase()} STOPPED DEAD</h3>
    <div class="m">${esc(x.from)} MPH TO 0 AT ${hm(x.t)}, AWAY FROM ANY STOP</div>
    <div class="m">${status(x)}</div>
    <div class="m"><a href="https://maps.google.com/?q=${x.lat},${x.lon}" target="_blank" rel="noopener" style="color:inherit">${x.lat}, ${x.lon}</a></div>
    <div class="m" style="opacity:.7">Only you see this (your stats key).</div>`;

  const marks = new Map(); // id -> marker
  let seenOpen = new Set();
  try { seenOpen = new Set(JSON.parse(sessionStorage.getItem('ht.incSeen')) || []); } catch {}
  let bar = null;
  function banner(x) {
    bar?.remove();
    bar = document.createElement('div'); bar.className = 'inc-bar'; bar.setAttribute('role', 'alert');
    bar.innerHTML = `⚠ ${what(x)} stopped dead: ${esc(x.from)} mph to 0 at ${hm(x.t)}, not at a stop. Tap to see it.<button type="button" aria-label="Close">×</button>`;
    bar.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); bar.remove(); bar = null; });
    bar.addEventListener('click', () => { map.flyTo({ center: [x.lon, x.lat], zoom: Math.max(map.getZoom(), 14) }); marks.get(x.id)?.togglePopup(); bar.remove(); bar = null; });
    document.body.appendChild(bar);
  }

  async function load() {
    if (document.hidden) return;
    let j;
    try {
      const r = await fetch(`${relay}/bus-incidents`, { headers: { 'X-Stats-Key': key }, cache: 'no-store' });
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    // shown: open ones, and ones that ended in the last 6 hours
    const show = (j.inc || []).filter((x) => x.open || Date.now() - x.end < 6 * 3600000);
    const ids = new Set(show.map((x) => x.id));
    for (const [id, m] of marks) if (!ids.has(id)) { m.remove(); marks.delete(id); }
    for (const x of show) {
      let m = marks.get(x.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'inc-dot';
        m = new maplibregl.Marker({ element: el }).setLngLat([x.lon, x.lat])
          .setPopup(new maplibregl.Popup({ offset: 18, maxWidth: '280px' })).addTo(map);
        marks.set(x.id, m);
      }
      m.getElement().classList.toggle('ended', !x.open); // (classList: MapLibre keeps its own classes on it)
      m.getElement().title = `${what(x)} stopped dead at ${hm(x.t)}`;
      m.getPopup().setHTML(popHtml(x));
      if (x.open && !seenOpen.has(x.id)) {
        seenOpen.add(x.id);
        try { sessionStorage.setItem('ht.incSeen', JSON.stringify([...seenOpen])); } catch {}
        banner(x);
      }
    }
  }
  load();
  setInterval(load, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
