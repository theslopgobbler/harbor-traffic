// Viewer count: while the page is open and on screen, it says hello to the relay every 2 minutes with a random
// ID made up for this tab (nothing about the person or device). The relay counts the IDs it heard from in the
// last 3 minutes: that's how many people are watching right now. Totals show on stats.html.
(() => {
  const relay = (window.HT?.airRelay || '').replace(/\/aircraft$/, '');
  const qs = new URLSearchParams(location.search);
  if (!relay) return;
  // testing on this computer doesn't count (add ?count to try it)
  if (/^(localhost|127\.)/.test(location.hostname) && !qs.has('count')) return;
  // one ID per tab: kept across the page's own reloads (after an update) so those don't count as new visits
  let id = null, first = false;
  try { id = sessionStorage.getItem('ht.vid'); } catch {}
  if (!id) {
    id = (Math.random().toString(36).slice(2) + Date.now().toString(36)).padEnd(12, '0').slice(0, 20);
    first = true;
    try { sessionStorage.setItem('ht.vid', id); } catch {}
  }
  const kind = qs.has('tv') ? 'tv' : matchMedia('(max-width: 760px)').matches ? 'phone' : 'desktop';
  let last = 0;
  const hello = () => {
    if (document.hidden) return; // a tab in the background isn't being watched
    last = Date.now();
    fetch(`${relay}/hello?id=${id}&k=${kind}${first ? '&first=1' : ''}`, { cache: 'no-store' })
      .then((r) => { if (r.ok) first = false; }).catch(() => {});
  };
  hello();
  setInterval(hello, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > 60 * 1000) hello(); });
})();
