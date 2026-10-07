// Crash notes, kept on this device only: every 5 s the map jots down how hard it's working (memory, frame rate,
// the slowest frame, map tiles, how many icons, 3D view or not, fog), plus any script errors and whether the
// graphics chip dropped the map. A page that closes normally says so on the way out; one that crashed doesn't, so
// the next visit files its last minute of notes as a crash, for the stats page (same device) to show.
(function () {
  const KEY = 'ht.diag', CRASHES = 'ht.diagCrash';
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const prev = read(KEY);
  if (prev && prev.open && prev.snaps?.length) {
    const list = (read(CRASHES) || []).slice(-4);
    list.push({ at: prev.snaps[prev.snaps.length - 1].t, about: prev.about, errors: prev.errors, events: prev.events, snaps: prev.snaps });
    write(CRASHES, list);
  }
  const build = (document.querySelector('script[src*="app.js?v="]')?.src.match(/v=(\d{12})/) || [])[1] || '';
  const rec = { open: true, snaps: [], errors: [], events: [],
    about: { build, screen: `${screen.width}x${screen.height}`, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency || null,
      memGB: navigator.deviceMemory || null, ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 140) } };
  write(KEY, rec);
  const note = (list, text) => { list.push({ t: Date.now(), text: String(text).slice(0, 200) }); if (list.length > 8) list.shift(); write(KEY, rec); };
  addEventListener('error', (e) => note(rec.errors, `${e.message} @ ${(e.filename || '').split('/').pop().split('?')[0]}:${e.lineno}`));
  addEventListener('unhandledrejection', (e) => note(rec.errors, `promise: ${e.reason?.message || e.reason}`));
  // the map's drawing surface: lost means the graphics chip gave up on it (the map goes blank or the tab dies)
  const hookGl = () => {
    const c = window.htMap?.getCanvas?.(); if (!c) return setTimeout(hookGl, 2000);
    c.addEventListener('webglcontextlost', () => note(rec.events, 'GRAPHICS LOST (webglcontextlost)'));
    c.addEventListener('webglcontextrestored', () => note(rec.events, 'graphics restored'));
  };
  hookGl();
  let frames = 0, lastFrame = 0, worst = 0;
  (function count(t) {
    frames++;
    if (lastFrame && t - lastFrame > worst) worst = t - lastFrame;
    lastFrame = t;
    requestAnimationFrame(count);
  })(0);
  let lastAt = performance.now();
  const tiles = (m) => { try { return Object.values(m.style.sourceCaches).reduce((n, s) => n + Object.keys(s._tiles || {}).length, 0); } catch { return null; } };
  setInterval(() => {
    const now = performance.now(), secs = (now - lastAt) / 1000; lastAt = now;
    if (document.hidden) { frames = 0; worst = 0; lastFrame = 0; return; }
    const m = window.htMap, b = document.body.classList;
    rec.snaps.push({
      t: Date.now(),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      fps: Math.round(frames / secs),
      busFps: window.htFrameMs ? Math.round(1000 / window.htFrameMs()) : null, // what the bus view stepped down to
      worstMs: Math.round(worst),
      tiles: m ? tiles(m) : null,
      icons: document.querySelectorAll('.maplibregl-marker').length,
      buses: document.querySelectorAll('.bus-mk').length,
      bus3d: document.querySelectorAll('.bus-mk.c3:not(.far)').length,
      nodes: document.getElementsByTagName('*').length,
      view: b.contains('chase') ? '3D' : b.contains('following') ? 'follow' : 'map',
      fx: !b.contains('fx-off'),
      fog: b.contains('chase-fog'),
      zoom: m ? +m.getZoom().toFixed(1) : null,
      pitch: m ? Math.round(m.getPitch()) : null
    });
    frames = 0; worst = 0;
    if (rec.snaps.length > 12) rec.snaps.shift(); // the last minute
    write(KEY, rec);
  }, 5000);
  addEventListener('pagehide', () => { rec.open = false; write(KEY, rec); });
  addEventListener('pageshow', () => { rec.open = true; write(KEY, rec); }); // (back from the back/forward cache)
})();
