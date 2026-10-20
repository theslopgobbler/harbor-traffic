// Viewer count: while the page is open and on screen, it says hello to the relay every 2 minutes with a random
// ID made up for this tab (nothing about the person or device). The relay counts the IDs it heard from in the
// last 3 minutes: that's how many people are watching right now. Totals show on stats.html.
// Each hello also says how long this tab has been on screen so far, and how many times each kind of thing was
// tapped ("bus", "camera", "button radar"...): kinds and counts only, never what or where.
(() => {
  const relay = (window.HT?.airRelay || '').replace(/\/aircraft$/, '');
  const qs = new URLSearchParams(location.search);
  if (!relay) return;
  // testing on this computer doesn't count (add ?count to try it)
  if (/^(localhost|127\.)/.test(location.hostname) && !qs.has('count')) return;
  // a device marked "don't count me" on the stats page (the owner's own phone and computer)
  try { if (localStorage.getItem('ht.noCount') === '1') return; } catch {}
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
  // one ID per tab: kept across the page's own reloads (after an update) so those don't count as new visits
  let id = ss.get('ht.vid'), first = false;
  if (!id) {
    id = (Math.random().toString(36).slice(2) + Date.now().toString(36)).padEnd(12, '0').slice(0, 20);
    first = true;
    ss.set('ht.vid', id);
  }
  const kind = qs.has('tv') ? 'tv' : matchMedia('(max-width: 760px)').matches ? 'phone' : 'desktop';

  // time on screen (a background tab doesn't add any), kept across the page's own reloads
  let secs = +ss.get('ht.vsecs') || 0, shownAt = document.hidden ? 0 : Date.now();
  const onScreen = () => Math.round(secs + (shownAt ? (Date.now() - shownAt) / 1000 : 0));
  // what got tapped, by kind
  let acts = {}; try { acts = JSON.parse(ss.get('ht.vacts')) || {}; } catch {}
  const act = (k) => {
    if (!/^[a-z ]{1,20}$/.test(k) || (!acts[k] && Object.keys(acts).length >= 30)) return;
    acts[k] = Math.min(999, (acts[k] || 0) + 1);
    ss.set('ht.vacts', JSON.stringify(acts));
  };
  window.htAct = act; // (bus.js: opening a stop, following a bus)
  const TAPS = [['.bus-mk', 'bus'], ['.ship-mk', 'ship'], ['.air-mk', 'aircraft'], ['.cam-mk', 'camera'],
    ['.br-mk, .br-chip', 'bridge'], ['.x-mk, .inc-mk', 'road alert'], ['.river-mk', 'river'], ['.lm-mk', 'landmark'],
    ['.rg-chip, .rw-mk, .wx-mk', 'weather'], ['.menu-btn', 'menu'], ['.sig-mk', 'traffic light']];
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !e.target.closest) return;
    const btn = e.target.closest('button[id^="btn"]'), tab = e.target.closest('.tabs button[data-tab]');
    if (btn) return act('button ' + btn.id.slice(3).toLowerCase().replace(/[^a-z]/g, ''));
    if (tab) return act('list ' + String(tab.dataset.tab).toLowerCase().replace(/[^a-z]/g, ''));
    for (const [sel, name] of TAPS) if (e.target.closest(sel)) return act(name);
  }, true);

  let last = 0;
  const url = (extra) => `${relay}/hello?id=${id}&k=${kind}&s=${onScreen()}`
    + `&a=${encodeURIComponent(Object.entries(acts).map(([k, n]) => `${k}:${n}`).join(','))}${extra}`;
  const hello = () => {
    if (document.hidden) return; // a tab in the background isn't being watched
    last = Date.now();
    fetch(url(first ? '&first=1' : ''), { cache: 'no-store' })
      .then((r) => { if (r.ok) first = false; }).catch(() => {});
  };
  hello();
  setInterval(hello, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // leaving (another tab, the phone locked, or closing): one last note of the time on screen
      if (shownAt) { secs += (Date.now() - shownAt) / 1000; shownAt = 0; ss.set('ht.vsecs', String(Math.round(secs))); }
      if (!first) fetch(url('&bye=1'), { cache: 'no-store', keepalive: true }).catch(() => {});
    } else {
      shownAt = Date.now();
      if (Date.now() - last > 60 * 1000) hello();
    }
  });
})();
