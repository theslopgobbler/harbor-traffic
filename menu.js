// The ☰ menu, top left of the map: Themes (more coming), Settings (the same switches as the buttons on the page),
// and About (what's new, Discord, copyright, disclaimers, data credits, privacy).
(function () {
  const wrap = document.querySelector('.map-wrap');
  if (!wrap || document.body.classList.contains('tv')) return;
  const $ = (s, r = document) => r.querySelector(s);
  const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } } };
  const build = (document.querySelector('script[src*="app.js?v="]')?.src.match(/v=(\d{12})/) || [])[1];
  const buildText = build ? `${build.slice(0, 4)}-${build.slice(4, 6)}-${build.slice(6, 8)} ${build.slice(8, 10)}:${build.slice(10, 12)} UTC` : '';

  // what's new: newest first, in plain words (add one whenever something people would notice goes out)
  // (kept general on purpose: a line of what got better, not every detail)
  const NEWS = [
    ['Oct 7', 'A menu, and handy little extras around the map.'],
    ['Oct 6', 'Weather effects, buses, boats and your location look and behave better.'],
    ['Oct 5', 'More to see in the 3D bus view, and parks and landmarks on the map.'],
    ['Oct 4', 'More about the boats in the harbor.'],
    ['Since Sept 29', 'Roads, bridges, buses, boats, weather and more around Grays Harbor, live on one map.']
  ];
  const DISCORD = 'https://discord.gg/M7AbfBuTsn';

  const btn = document.createElement('button');
  btn.className = 'menu-btn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Menu'); btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5 H17 M3 10 H17 M3 15 H17" stroke="currentColor" stroke-width="2"/></svg>';
  const panel = document.createElement('div');
  panel.className = 'menu-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Menu');
  wrap.append(btn, panel);

  const row = (id, label, extra = '') => `<button type="button" class="menu-row" data-go="${id}">${label}<span>${extra || '›'}</span></button>`;
  const back = '<button type="button" class="menu-back" data-go="main">‹ BACK</button>';
  const pages = {
    main: () => `<div class="menu-title">HARBOR TRAFFIC</div>${row('themes', 'THEMES')}${row('settings', 'SETTINGS')}${row('about', 'ABOUT')}`,
    themes: () => `${back}<div class="menu-title">THEMES</div>
      <div class="menu-opt on">✓ HARBOR NIGHT <small>THE CURRENT LOOK</small></div>
      <div class="menu-opt soon">NORMAL <small>COMING SOON</small></div>
      <div class="menu-opt soon">KAWAII <small>COMING SOON</small></div>`,
    settings: () => {
      const on = (b) => (b ? 'ON' : 'OFF');
      return `${back}<div class="menu-title">SETTINGS</div>
      <button type="button" class="menu-row" data-set="clock">CLOCK<span>${window.htClock24 ? '24-HOUR' : '12-HOUR'}</span></button>
      <button type="button" class="menu-row" data-set="big">BIGGER TEXT<span>${on(store.get('ht.bigText'))}</span></button>
      <button type="button" class="menu-row" data-set="fx">WEATHER EFFECTS<span>${on($('#btnFx')?.classList.contains('on'))}</span></button>`;
    },
    about: () => `${back}<div class="menu-title">ABOUT</div>
      <p class="menu-p">Roads, bridges, buses, boats and weather around Grays Harbor, live, on one map.</p>
      ${buildText ? `<p class="menu-p dim">VERSION ${buildText}</p>` : ''}
      ${row('news', "WHAT'S NEW")}
      <button type="button" class="menu-row" data-discord>JOIN THE DISCORD<span>↗</span></button>
      ${row('legal', 'COPYRIGHT & DISCLAIMERS')}${row('credits', 'DATA & CREDITS')}${row('privacy', 'PRIVACY')}`,
    news: () => `<button type="button" class="menu-back" data-go="about">‹ ABOUT</button><div class="menu-title">WHAT'S NEW</div>
      ${NEWS.map(([d, t]) => `<div class="menu-news"><b>${d.toUpperCase()}</b><span>${t}</span></div>`).join('')}`,
    legal: () => `<button type="button" class="menu-back" data-go="about">‹ ABOUT</button><div class="menu-title">COPYRIGHT & DISCLAIMERS</div>
      <p class="menu-p">© 2026 Harbor Events · harborevents.org. All rights reserved.</p>
      <p class="menu-p">Harbor Traffic is an independent project. It isn't affiliated with or endorsed by WSDOT, Grays Harbor Transit, the Port of Grays Harbor, NOAA, the National Weather Service or anyone else whose information it shows.</p>
      <p class="menu-p">Everything here can be delayed, incomplete or wrong. Check official sources, and what's in front of you, before making travel or safety decisions. Don't use it while driving.</p>
      <p class="menu-p">Bus times, lateness and "not in service" come from Grays Harbor Transit's public tracker and are our own reading of it. Train hints are educated guesses from the ships in port, not a train feed. Bridge openings and weather effects are approximate.</p>
      <p class="menu-p dim">Map data © OpenStreetMap contributors. Photos belong to their photographers, credited where shown.</p>`,
    credits: () => `<button type="button" class="menu-back" data-go="about">‹ ABOUT</button><div class="menu-title">DATA & CREDITS</div>
      <ul class="menu-list">
        <li>Roads, alerts, cameras, travel times, bridges: WSDOT</li>
        <li>Weather, alerts, radar: NOAA / National Weather Service</li>
        <li>Tides: NOAA Tides &amp; Currents · Rivers: NOAA National Water Prediction Service</li>
        <li>Earthquakes: USGS</li>
        <li>Buses: Grays Harbor Transit's public tracker and published schedule</li>
        <li>Boats: AIS, via aisstream.io</li>
        <li>Aircraft: community ADS-B feeds and OpenSky Network</li>
        <li>Map: OpenStreetMap contributors, tiles by OpenFreeMap</li>
        <li>Boat photos: their photographers (Wikimedia Commons, credited on each)</li>
      </ul>`,
    privacy: () => `<button type="button" class="menu-back" data-go="about">‹ ABOUT</button><div class="menu-title">PRIVACY</div>
      <p class="menu-p">No accounts, no ads, no tracking cookies.</p>
      <p class="menu-p">Your location, if you turn it on, stays on your device: it's used only to show you on the map and to notice when you're riding a bus.</p>
      <p class="menu-p">To count how many people are watching, each open page sends a random code every couple of minutes. It isn't tied to you or your device, and old codes are deleted within an hour.</p>
      <p class="menu-p">Settings like 12/24-hour time are saved in your browser only.</p>`
  };
  let page = 'main';
  const show = (p) => { page = p; panel.innerHTML = pages[p](); panel.scrollTop = 0; };
  const open = (v) => { panel.hidden = !v; btn.classList.toggle('on', v); btn.setAttribute('aria-expanded', String(v)); if (v) show('main'); };
  btn.addEventListener('click', () => open(panel.hidden));
  panel.addEventListener('click', (e) => {
    // (a tap inside never counts as "outside", even after the page it was on has been swapped out)
    e.stopPropagation();
    const go = e.target.closest('[data-go]'); if (go) return show(go.dataset.go);
    const set = e.target.closest('[data-set]');
    if (set) { ({ clock: '#clockFmt', big: '#btnBig', fx: '#btnFx' })[set.dataset.set] && $(({ clock: '#clockFmt', big: '#btnBig', fx: '#btnFx' })[set.dataset.set])?.click(); return setTimeout(() => show('settings'), 50); }
    if (e.target.closest('[data-discord]') && confirm('Open the Harbor Events Discord in a new tab?')) window.open(DISCORD, '_blank', 'noopener');
  });
  // (only a real tap outside closes it: a setting works by pressing the page's own button for you, which isn't one)
  document.addEventListener('click', (e) => { if (e.isTrusted && !panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });
})();
