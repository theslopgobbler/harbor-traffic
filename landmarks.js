// Landmarks: little pixel diamonds, only zoomed in to street level, each with a popup (photo, caption, a fun fact).
// The list is landmarks/landmarks.json; photos come from photos\landmarks\ via scripts\ship-photos.ps1 (named by
// the landmark's id, e.g. "kurt-cobain-landing.jpg"). Easter eggs, per landmark:
//   "hidden": true   only shows at the deepest zoom (17+), for people who go exploring
//   "secret": "..."  shown after tapping the landmark's popup photo or title three times
//   "night": "..."   an extra line shown only between sunset and sunrise
(function () {
  const map = window.htMap; if (!map) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeSrc = (u) => (/^landmarks\/[\w.-]+$/.test(u || '') ? u : null);
  const diamond = '<svg viewBox="0 0 7 7" shape-rendering="crispEdges"><g fill="#ffc400"><rect x="3" y="0" width="1" height="1"/><rect x="2" y="1" width="3" height="1"/>' +
    '<rect x="1" y="2" width="5" height="1"/><rect x="0" y="3" width="7" height="1"/><rect x="1" y="4" width="5" height="1"/><rect x="2" y="5" width="3" height="1"/><rect x="3" y="6" width="1" height="1"/></g>' +
    '<rect x="3" y="3" width="1" height="1" fill="#030807"/></svg>';
  const markers = [];
  function dark() {
    const c = map.getCenter(), s = window.htSunTimes?.(new Date(), c.lat, c.lng), now = new Date();
    return s ? now < s.rise || now > s.set : false;
  }
  function html(l, taps) {
    const p = (l.photos || []).find((x) => safeSrc(x.src));
    return `${p ? `<figure class="ship-photo"><img class="lm-tap" src="${esc(p.src)}" width="${+p.w || 4}" height="${+p.h || 3}" alt="${esc(l.name)}" loading="lazy">
        <figcaption>${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}<span class="cr">PHOTO: ${esc(p.credit || 'harborevents.org')}</span></figcaption></figure>` : ''}
      <h3 class="lm-tap">◆ ${esc(String(l.name).toUpperCase())}</h3>
      ${l.caption ? `<p>${esc(l.caption)}</p>` : ''}${l.fact ? `<div class="m">${esc(l.fact)}</div>` : ''}
      ${l.night && dark() ? `<div class="m lm-night">☾ ${esc(l.night)}</div>` : ''}
      ${l.secret && taps >= 3 ? `<div class="m lm-secret">✦ ${esc(l.secret)}</div>` : ''}`;
  }
  function show() {
    const z = map.getZoom(), chase = document.body.classList.contains('chase');
    for (const m of markers) m.getElement().style.display = !chase && z >= (m._l.hidden ? 17 : 13.5) ? '' : 'none';
  }
  fetch(`landmarks/landmarks.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { landmarks: [] })).then((j) => {
    for (const l of j.landmarks || []) {
      if (!(l.lon && l.lat && l.name)) continue;
      const el = document.createElement('div');
      el.className = 'lm-mk'; el.innerHTML = diamond; el.title = l.name;
      let taps = 0;
      const pop = new maplibregl.Popup({ offset: 10, maxWidth: '300px' }).setHTML(html(l, 0));
      pop.on('open', () => { taps = 0; pop.setHTML(html(l, 0)); });
      // three taps on the photo or title: the secret
      document.addEventListener('click', (e) => {
        if (!pop.isOpen() || !e.target.closest('.lm-tap') || !pop.getElement()?.contains(e.target)) return;
        if (++taps === 3 && l.secret) pop.setHTML(html(l, taps));
      });
      const m = new maplibregl.Marker({ element: el }).setLngLat([l.lon, l.lat]).setPopup(pop).addTo(map);
      m._l = l; markers.push(m);
    }
    show();
  }).catch(() => {});
  map.on('zoom', show);
  new MutationObserver(show).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
