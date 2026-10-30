// Aircraft: ADS-B positions, low and local only (15,000 ft and below, inside the area).
// Source: a live relay if HT.airRelay is set in config.js (refreshed every 15 s; it merges a second feed's
// aircraft, flagged mine, with OpenSky's), otherwise the collector's
// data/aircraft.json (refreshed each collector run, so positions can be several minutes old).
(() => {
  const map = window.htMap;
  if (!map) return;
  const C = window.HT;
  const qs = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  // airfields and hospital pads, for "inbound/outbound" and distances
  const FIELDS = [
    { id: 'HQM', name: 'BOWERMAN (HOQUIAM)', lat: 46.9712, lon: -123.9366 },
    { id: 'W04', name: 'OCEAN SHORES', lat: 46.9973, lon: -124.1560 },
    { id: '14S', name: 'WESTPORT', lat: 46.8970, lon: -124.1011 },
    { id: 'SHN', name: 'SHELTON', lat: 47.2336, lon: -123.1478 },
    { id: 'OLM', name: 'OLYMPIA', lat: 46.9694, lon: -122.9025 },
    { id: 'CLS', name: 'CHEHALIS-CENTRALIA', lat: 46.6770, lon: -122.9830 },
    { id: 'HRMC', name: 'HARBOR REGIONAL HOSPITAL PAD', lat: 46.9765, lon: -123.8062, heli: true }
  ];
  const nm = (a, b) => {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 3440.07 * Math.asin(Math.sqrt(h));
  };
  const bearing = (a, b) => {
    const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const HOME = { lat: 46.9754, lon: -123.8157 }; // Aberdeen

  // ---- what kind of aircraft, and is it possibly military ----
  const HELI_TYPES = /^(R22|R44|R66|B06|B407|B412|B429|B505|EC\d+|AS\d+|H\d+|MH\d+|UH\d+|HH\d+|CH\d+|S76|S92|A109|A119|A139|AW\d+|BK17|MD\d+|H500)$/;
  const MIL_TYPES = /^(C130|C30J|C17|C5M|KC135|K35R|KC46|P8|E3TF|E6|EA18|F18[EFS]?|F35|F16|F15|B52|B1|B2|H60|UH60|MH60|HH60|MH65|AS65|HC27|C27J|V22|CH47|AH64|C12|C40|C37|T6|T38|U2|RC135|E8)$/;
  const MIL_CALLS = /^(RCH|REACH|PAT|NAVY|CNV|VV|EVAC|TOPCAT|GRZLY|SPAR|SAM|DUKE|COBRA|HAWK|RAIDR|CG\d|C\d{4}$)/;
  const isHeli = (a) => a.cat === 'A7' || HELI_TYPES.test(a.type || '');
  const isCoastGuard = (a) => /^C\d{4}$/.test(a.flight || '') || /^(MH65|AS65|MH60|HH60|HC27|C27J)$/.test(a.type || '') && /^C/.test(a.flight || '');
  const isMil = (a) => a.mil || MIL_TYPES.test(a.type || '') || MIL_CALLS.test(a.flight || '');
  const EMERG = { '7500': 'HIJACK', '7600': 'RADIO FAILURE', '7700': 'EMERGENCY' };

  function situation(a) {
    // hospital pads only count for helicopters
    const near = FIELDS.filter((f) => !f.heli || isHeli(a)).map((f) => ({ f, d: nm(a, f) })).sort((x, y) => x.d - y.d)[0];
    const alt = a.alt || 0, gs = a.gs || 0;
    let state;
    if (alt < 100 && gs < 40) state = 'ON GROUND';
    else if (isHeli(a) && gs < 20) state = 'HOVERING';
    else if (a.track == null) state = 'FLYING';
    else {
      const toward = angleDiff(a.track, bearing(a, near.f)) < 35;
      const away = angleDiff(a.track, bearing(a, near.f)) > 145;
      const descending = (a.rate ?? 0) < -300, climbing = (a.rate ?? 0) > 300;
      if (near.d < 15 && toward && (alt < 5000 || descending)) state = 'INBOUND';
      else if (near.d < 12 && away && (climbing || alt < 3000)) state = 'OUTBOUND';
      else state = 'OVERFLIGHT';
    }
    return { state, field: near.f, fieldNm: near.d, homeNm: nm(a, HOME) };
  }

  // ---- drawings (top-down, nose up) ----
  const planeSvg = (c) => `<svg viewBox="0 0 24 24"><path d="M12 1 L13.4 8 L22 12.5 L22 14 L13.4 12 L13 19 L16 21.5 L16 23 L12 22 L8 23 L8 21.5 L11 19 L10.6 12 L2 14 L2 12.5 L10.6 8 Z"
    fill="rgba(2,8,7,.8)" stroke="${c}" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  // helicopter from above: rotor disc with two blades, teardrop cabin, tail boom, tail rotor; a red cross if medical
  const heliSvg = (c, medical) => `<svg viewBox="0 0 28 28">
    <circle cx="14" cy="11" r="10.5" fill="none" stroke="${c}" stroke-width="1" opacity=".55"/>
    <path d="M14 5 Q18.5 5.5 18.5 11 Q18.5 15.5 14 16.5 Q9.5 15.5 9.5 11 Q9.5 5.5 14 5 Z" fill="rgba(2,8,7,.85)" stroke="${c}" stroke-width="1.6"/>
    <path d="M14 16.5 L14 25 M11 25 L17 25" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="square"/>
    <path d="M5 2.5 L23 19.5 M23 2.5 L5 19.5" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>
    ${medical ? '<path d="M12.6 9.2 H15.4 M14 7.8 V10.6" stroke="#ff2a3d" stroke-width="1.6"/>' : ''}</svg>`;
  // likely air ambulance (Life Flight Network, Airlift Northwest and others): medical call signs or registrations
  const isMedical = (a) => isHeli(a) && /LIFE|MEDEVAC|MEDIC|AIRLIFT|LIFEGUARD|MERCY|CARE|^LF|^LN|^AMF|^AIR ?EVAC/i.test(`${a.flight || ''} ${a.reg || ''}`) ||
    /^N\d+(LF|LN|AL|MT)$/i.test(a.reg || '');
  const colorOf = (a) => EMERG[a.squawk] ? '#ff2a3d' : isCoastGuard(a) ? '#ff2a3d' : isMil(a) ? '#ff7a1a' : isHeli(a) ? '#ffffff' : '#bff4ff';
  // airliners: big and medium jets and turboprops (by ADS-B category, or the type code when the category is missing)
  const AIRLINER_TYPES = /^(A2\d[N\d]|A3\d\d|A3\dN|B7\d\d|B7\dM|B3[789]M|B73\d|B74\d|B75\d|B76\d|B77\w|B78\d|BCS\d|E1[79]\d|E75[LS]|E2\d\d|E290|CRJ\d|DH8[A-D]|AT[47]\d|MD\d\d)$/;
  const isAirliner = (a) => /^A[345]$/.test(a.cat || '') || AIRLINER_TYPES.test(a.type || '');
  const kindOf = (a) => isCoastGuard(a) ? 'COAST GUARD' : a.milSure ? 'MILITARY' : isMil(a) ? 'MILITARY?' : isMedical(a) ? 'MEDICAL?' : isHeli(a) ? 'HELICOPTER' : isAirliner(a) ? 'AIRLINER' : 'AIRCRAFT';
  const altTxt = (alt) => alt < 100 ? 'GND' : alt >= 1000 ? (alt / 1000).toFixed(1) + 'K' : String(alt);

  // ---- what each aircraft is. Three sources, first one wins:
  //   planes/known.json: by hand (a call-sign pattern or an aircraft address), e.g. COUGR = Black Hawk
  //   data/aircraft-registry.json: the collector looks up every aircraft once by its address (model, registration,
  //     owner when it's an agency, military from adsb.lol's database or the US military's address block)
  //   the live feed's own type code
  // and a reference photo of the same model (never the actual aircraft): from known.json, or Commons photos the
  // collector found that were approved on the stats page (the relay keeps the yes/no list, /plane-photos)
  let KNOWN = [], REG = {}, PHOTOS = {}, infoAt = 0;
  async function loadKnown() {
    if (Date.now() - infoAt < 600000) return;
    infoAt = Date.now();
    const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const relay = (C.airRelay || '').replace(/\/aircraft$/, '');
    const [kn, reg, cand, dec] = await Promise.all([get(`planes/known.json?t=${Date.now()}`), get(`data/aircraft-registry.json?t=${Date.now()}`),
      get(`data/aircraft-photo-candidates.json?t=${Date.now()}`), relay ? get(`${relay}/plane-photos`) : {}]);
    KNOWN = (kn.callsigns || []).map((k) => { try { return { ...k, re: k.match ? new RegExp(k.match, 'i') : null, hex: (k.hex || []).map((h) => String(h).toLowerCase()) }; } catch { return null; } }).filter(Boolean);
    REG = reg.aircraft || {};
    const yes = new Set((dec.decisions || []).filter((d) => d.ok).map((d) => `${d.model}|${d.file}`));
    PHOTOS = {};
    for (const c of cand.candidates || []) if (yes.has(`${c.model}|${c.file}`)) (PHOTOS[c.model] ||= []).push({ src: c.thumb, w: c.w, h: c.h,
      caption: c.caption, credit: c.author, license: c.license, licenseUrl: c.licenseUrl, page: c.page });
  }
  const milBlock = (hex) => { const n = parseInt(hex, 16); return /^[0-9a-f]{6}$/.test(hex) && n >= 0xadf7c8 && n <= 0xafffff; }; // US military addresses
  function applyKnown(a) {
    const hex = String(a.hex || '').toLowerCase();
    const r = REG[hex];
    if (r) {
      if (r.t && !a.type) a.type = r.t;
      if (r.r && !a.reg) a.reg = r.r;
      if (r.model) a.model = `${r.maker || ''} ${r.model}`.replace(/\s+/g, ' ').trim();
      if (r.owner) a.owner = r.owner;
    }
    // military for sure (no question mark): adsb.lol's database flag (a.mil), the registry, or the address block
    if (a.mil || r?.mil || milBlock(hex)) { a.mil = true; a.milSure = true; }
    const k = KNOWN.find((x) => (x.hex || []).includes(hex)) || KNOWN.find((x) => x.re && x.re.test(a.flight || ''));
    if (!k) return;
    a.known = k;
    if (k.type) a.type = a.type || k.type; // (so the helicopter drawing and the military color follow)
    if (k.kind === 'MILITARY') { a.mil = true; a.milSure = true; }
  }
  const typeName = (a) => (a.known?.name || a.model || a.type || 'UNKNOWN TYPE').toUpperCase();
  const okSrc = (u) => /^(planes\/[\w.-]+\.(jpe?g|png|webp)|https:\/\/(upload|thumb)\.wikimedia\.org\/[^\s"'<>]+)$/i.test(u || '');
  function refPhoto(a) {
    const list = (a.known?.photos || []).concat(PHOTOS[a.model] || []).filter((x) => okSrc(x.src));
    if (!list.length) return '';
    const p = list[0];
    const link = (u, t) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>` : esc(t));
    return `<figure class="ship-photo"><img src="${esc(p.src)}" width="${+p.w || 4}" height="${+p.h || 3}" alt="${esc(typeName(a))}, for reference" loading="lazy">
      <figcaption><span class="cap">FOR REFERENCE (SAME TYPE, NOT THIS AIRCRAFT)${p.caption ? ': ' + esc(p.caption) : ''}</span><span class="cr">PHOTO: ${esc(p.credit || 'unknown')}${p.license ? ' · ' + link(p.licenseUrl, p.license) : ''}${p.page ? ' · ' + link(p.page, 'COMMONS') : ''}</span></figcaption></figure>`;
  }
  const regLine = (a) => [a.reg && a.reg !== a.flight ? 'REG ' + a.reg : '', a.owner ? a.owner.toUpperCase() : ''].filter(Boolean).join(' · ');

  // ---- markers ----
  let planes = [], updated = null, live = false, liveSource = '', stale = false;
  // check mode, only on a device that opened the map with ?rx=1 (?rx=0 turns it off): aircraft flagged mine are drawn
  // magenta and shown at any altitude. Everyone else sees no difference
  if (qs.has('rx')) store.set('ht.rx', qs.get('rx') === '1');
  const rx = store.get('ht.rx') === true;
  // airliners: off unless turned on in the menu (Map Layers › AIRLINERS) or with ?airliners=1 (remembered per device;
  // ?airliners=0 turns them off). On, they show at any height inside the area, like the jets to and from Sea-Tac
  if (qs.has('airliners')) store.set('ht.airliners', qs.get('airliners') === '1');
  let showAirliners = store.get('ht.airliners') === true;
  window.htAirliners = { get: () => showAirliners, set: (v) => { showAirliners = !!v; store.set('ht.airliners', showAirliners); load(); } };
  const RX = '#ff4fd8';
  const tint = (a) => rx && a.mine ? RX : colorOf(a);
  const markers = new Map(); // hex -> marker

  // ---- between reports: keep each aircraft moving the way it was going (dead reckoning) ----
  // Each report says where the aircraft was, when (pt), its speed, heading and climb, and often how fast it's
  // turning (turn rate, or bank angle), where the autopilot will stop the turn and the climb, and (from the desktop
  // receiver) a short trail of its last positions. From that the map moves it along, curving through turns. A new
  // report never pulls it backward: if the glide got ahead, it slows down until the aircraft catches up; if it fell
  // behind, it hurries forward. When reports get spotty it stops and waits: no guessing past what's known, no
  // dotted lines. No report for a while: it fades.
  const D2R = Math.PI / 180, KT = 0.514444, EARTH = 6371000;
  const COAST = { plane: 30, heli: 20, spotty: 8 }; // seconds of moving on past the last report
  const FADE_AFTER = 45000; // a report older than this: faded
  const models = new Map(); // hex -> what the last report says, plus the correction being eased out
  const wrap = (d) => ((d % 360) + 540) % 360 - 180;
  // turn rate (degrees a second, + = to the right) from the report, the trail, or the last two reports
  function trailRate(trail) {
    const pts = trail.slice().sort((x, y) => x[0] - y[0]), legs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = { lat: pts[i - 1][1], lon: pts[i - 1][2] }, b = { lat: pts[i][1], lon: pts[i][2] };
      if (nm(a, b) * 1852 < 25) continue; // too close together to give a direction
      legs.push([(pts[i - 1][0] + pts[i][0]) / 2000, bearing(a, b)]);
    }
    if (legs.length < 2 || legs[legs.length - 1][0] - legs[0][0] < 3) return null;
    for (let i = 1; i < legs.length; i++) legs[i][1] = legs[i - 1][1] + wrap(legs[i][1] - legs[i - 1][1]);
    const n = legs.length, mt = legs.reduce((s, l) => s + l[0], 0) / n, mb = legs.reduce((s, l) => s + l[1], 0) / n;
    let num = 0, den = 0;
    for (const [t, b] of legs) { num += (t - mt) * (b - mb); den += (t - mt) ** 2; }
    return den ? num / den : null;
  }
  function turnRate(a, prev, heli) {
    let w = null;
    if (Number.isFinite(a.trackRate)) w = a.trackRate;
    else if (a.trail?.length >= 3) w = trailRate(a.trail);
    if (w == null && Number.isFinite(a.roll) && (a.gs || 0) > 30) w = 9.81 * Math.tan(a.roll * D2R) / (a.gs * KT) / D2R;
    if (w == null && prev && prev.trk != null && a.track != null && a.pt - prev.t > 2000 && a.pt - prev.t < 45000)
      w = wrap(a.track - prev.trk) / ((a.pt - prev.t) / 1000);
    if (!Number.isFinite(w)) return 0;
    const cap = heli ? 8 : 4; // (a standard airliner turn is 3 a second)
    return Math.max(-cap, Math.min(cap, w));
  }
  // how long it may move on past its last report: shorter when reports have been coming in far apart
  // landing at Bowerman or the hospital pad (low, close, heading in, slowing or coming down): glide only as far as the
  // field or pad, then stop there and fade, like buses signing off at the depot, instead of coasting on past it
  const LAND = FIELDS.filter((f) => f.id === 'HQM' || f.id === 'HRMC');
  function landingAt(a, heli) {
    if ((a.alt || 0) > 1500 || a.track == null) return null;
    for (const f of LAND) {
      if (f.heli && !heli) continue;
      const d = nm(a, f);
      const toward = angleDiff(a.track, bearing(a, f)) < 60;
      if (d < 2 && (toward || d < 0.3) && ((a.rate ?? 0) < -100 || (a.gs || 0) < (heli ? 40 : 90))) return { f, secs: d * 1852 / Math.max(1, (a.gs || 0) * KT) };
    }
    return null;
  }
  const coastOf = (m) => Math.min(m.land ? m.land.secs : 1e9, m.spotty ? COAST.spotty : m.heli ? COAST.heli : COAST.plane);
  // where the report says it is `secs` seconds after it was heard
  function advance(m, secs) {
    const v = (m.gs || 0) * KT;
    let alt = m.alt;
    if (m.rate && !m.ground) {
      alt = m.alt + m.rate / 60 * secs;
      if (m.navAlt != null && Math.sign(m.navAlt - m.alt) === Math.sign(m.rate)) alt = m.rate > 0 ? Math.min(alt, m.navAlt) : Math.max(alt, m.navAlt);
      alt = Math.max(0, alt);
    }
    if (m.ground || v < 8 || m.trk == null || secs <= 0) return { lat: m.lat, lon: m.lon, trk: m.trk, alt }; // parked or hovering: stays put
    let w = m.w, tTurn = secs;
    // a turn ends at the heading the autopilot was set to (when it says so, and the turn is going that way)
    if (w && m.navHdg != null) { const need = wrap(m.navHdg - m.trk); if (Math.sign(need) === Math.sign(w)) tTurn = Math.min(secs, Math.abs(need / w)); }
    let n = 0, e = 0, th = m.trk * D2R;
    if (w && tTurn > 0) {
      const wr = w * D2R, th1 = th + wr * tTurn, r = v / wr;
      e += r * (Math.cos(th) - Math.cos(th1)); n += r * (Math.sin(th1) - Math.sin(th)); th = th1;
    }
    const rest = secs - (w ? tTurn : 0);
    if (rest > 0) { e += v * rest * Math.sin(th); n += v * rest * Math.cos(th); }
    return { lat: m.lat + n / EARTH / D2R, lon: m.lon + e / (EARTH * Math.cos(m.lat * D2R)) / D2R, trk: (th / D2R + 360) % 360, alt };
  }
  // where to draw it now: the glide, plus whatever is left of the last correction
  function place(m, now) {
    if (m.still) return { lat: m.lat, lon: m.lon, trk: m.trk, alt: m.alt };
    const p = advance(m, Math.min(Math.max(0, (now - m.t) / 1000), coastOf(m)));
    const o = m.off;
    if (o) {
      const k = (T) => Math.max(0, 1 - (now - o.at) / (T * 1000));
      const along = o.a * k(o.ta), side = o.l * k(o.tl);
      if (!along && !side) { m.off = null; return p; }
      const th = (p.trk ?? 0) * D2R, e = along * Math.sin(th) + side * Math.cos(th), n = along * Math.cos(th) - side * Math.sin(th);
      p.lat += n / EARTH / D2R; p.lon += e / (EARTH * Math.cos(p.lat * D2R)) / D2R;
    }
    return p;
  }
  // a new list from the relay: update each aircraft's report, keeping its drawn position continuous
  function syncModels(list, now) {
    const seen = new Set();
    for (const a of list) {
      seen.add(a.hex);
      const prev = models.get(a.hex), heli = isHeli(a);
      const t = Number.isFinite(a.pt) ? Math.min(a.pt, now) : now;
      if (prev && prev.t === t && !prev.still) continue; // the same report again: nothing new
      const m = { lat: a.lat, lon: a.lon, t, gs: a.gs, trk: a.track ?? null, alt: a.alt || 0, rate: Number.isFinite(a.geomRate) ? a.geomRate : a.rate || 0,
        navAlt: Number.isFinite(a.navAlt) ? a.navAlt : null, navHdg: Number.isFinite(a.navHdg) ? a.navHdg : null,
        ground: (a.alt || 0) < 100 && (a.gs || 0) < 40, heli, still: !Number.isFinite(a.pt), off: null,
        // spotty: this report came more than 40 s after the last one (or is already 20 s old when it gets here)
        spotty: (prev && !prev.still && t - prev.t > 40000) || now - t > 20000 };
      m.label = a.flight || a.reg || a.hex;
      m.w = turnRate(a, prev, heli);
      m.land = landingAt(a, heli);
      if (m.land) m.w = 0; // (heading in: straight at it)
      if (prev && prev.shown && !m.still) {
        // how far the drawn spot is from where the new report says it should be now: split into along the way it's
        // heading (ahead or behind) and to the side, and ease both out
        const p = advance(m, Math.min(Math.max(0, (now - t) / 1000), coastOf(m)));
        const n = (prev.shown.lat - p.lat) * D2R * EARTH, e = (prev.shown.lon - p.lon) * D2R * EARTH * Math.cos(p.lat * D2R);
        const th = (p.trk ?? 0) * D2R, along = e * Math.sin(th) + n * Math.cos(th), side = e * Math.cos(th) - n * Math.sin(th);
        const v = (m.gs || 0) * KT, far = Math.hypot(along, side);
        if (far > 5 && far < Math.max(3000, v * 40)) {
          // ahead: slow to no less than half speed until it's caught up (so it never goes backward); behind: hurry
          const ta = along > 0 ? (v > 8 ? Math.min(20, Math.max(1.5, along / (0.5 * v))) : 3) : 1.5;
          m.off = { a: along, l: side, at: now, ta, tl: 2.5 };
        }
      }
      models.set(a.hex, m);
    }
    for (const [hex, m] of models) if (!seen.has(hex)) {
      if (m.land) parkLanded(hex, m);
      models.delete(hex);
    }
    for (const hex of seen) if (landed.has(hex)) { landed.delete(hex); saveLanded(); } // (heard again: it's taking off)
  }
  // ---- landed: an aircraft that came down at Bowerman or the hospital pad and went quiet stays there, gray, until
  // it's heard again (taking off). Kept in this browser, so it survives a reload; anything parked over a week is dropped
  const landed = new Map(); // hex -> { lat, lon, at, field, label, heli }
  try { for (const [h, v] of Object.entries(JSON.parse(localStorage.getItem('ht.landed')) || {})) if (Date.now() - v.at < 7 * 864e5) landed.set(h, v); } catch {}
  const saveLanded = () => { try { localStorage.setItem('ht.landed', JSON.stringify(Object.fromEntries(landed))); } catch {} };
  // each parked aircraft gets its own spot in a row at the field or pad (a fixed number of pixels apart, so they never
  // sit on top of each other at any zoom and every one stays clickable)
  const freeSlot = (field) => { const used = new Set([...landed.values()].filter((v) => v.field === field).map((v) => v.slot)); let k = 0; while (used.has(k)) k++; return k; };
  const slotPx = (k) => [k ? (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 30 : 0, 0];
  for (const v of landed.values()) if (!Number.isInteger(v.slot)) v.slot = freeSlot(v.field);
  function parkLanded(hex, m) {
    const f = m.land.f;
    landed.set(hex, { lat: f.lat, lon: f.lon, at: Date.now(), field: f.name, slot: freeSlot(f.name), label: m.label || hex, heli: m.heli });
    saveLanded();
  }
  function drawLanded(hex, v) {
    let mk = markers.get(hex);
    if (!mk) {
      const el = document.createElement('div'); el.className = 'air-mk';
      mk = new maplibregl.Marker({ element: el }).setLngLat([v.lon, v.lat]).setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '300px' })).addTo(map);
      markers.set(hex, mk);
    }
    mk.setLngLat([v.lon, v.lat]).setOffset(slotPx(v.slot));
    const el = mk.getElement();
    el.classList.toggle('heli', !!v.heli); el.classList.remove('emerg');
    el.style.opacity = '0.6'; el.style.filter = 'grayscale(1)';
    el.innerHTML = `<div class="ic">${v.heli ? heliSvg('#9aa4a2', false) : planeSvg('#9aa4a2')}</div><span class="alt" style="color:#9aa4a2">LANDED</span>`;
    el.title = `${v.label} · landed`;
    const t = new Date(v.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }).toUpperCase();
    mk.getPopup().setHTML(`<h3>${esc(v.label)}</h3><p><b>LANDED</b> · ${esc(v.field)}</p><div class="m">LAST HEARD ${t} · STAYS HERE UNTIL IT'S HEARD AGAIN</div>`);
  }
  // move the markers along, about 10 times a second (4 on phones), only while aircraft are shown and the page is open
  let lastFrame = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!models.size || document.hidden || !on || ts - lastFrame < (window.htLite ? 250 : 100)) return;
    lastFrame = ts;
    const now = Date.now();
    for (const [hex, m] of models) {
      const mk = markers.get(hex); if (!mk) continue;
      const p = place(m, now);
      m.shown = { lat: p.lat, lon: p.lon };
      mk.setLngLat([p.lon, p.lat]);
      const el = mk.getElement();
      const ic = el.firstElementChild, lab = el.querySelector('.alt');
      if (p.trk != null && Math.abs(wrap(p.trk - (m.drawnTrk ?? -999))) > 0.5) {
        m.drawnTrk = p.trk; if (ic) ic.style.transform = `rotate(calc(${p.trk.toFixed(1)}deg - var(--brg, 0deg)))`;
      }
      const at = altTxt(Math.round(p.alt));
      if (lab && lab.textContent !== at) lab.textContent = at;
      const faded = now - m.t > (m.land ? 15000 : FADE_AFTER);
      if (faded !== !!m.faded) { m.faded = faded; el.style.opacity = faded ? '0.5' : ''; }
    }
  }
  requestAnimationFrame(frame);

  function render() {
    const seen = new Set();
    for (const a of planes) {
      seen.add(a.hex);
      const c = tint(a);
      let mk = markers.get(a.hex);
      if (!mk) {
        const el = document.createElement('div');
        el.className = 'air-mk';
        mk = new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '300px' })).addTo(map);
        markers.set(a.hex, mk);
      }
      const m = models.get(a.hex), p = m ? place(m, Date.now()) : { lat: a.lat, lon: a.lon, trk: a.track, alt: a.alt };
      if (m) { m.shown = { lat: p.lat, lon: p.lon }; m.drawnTrk = p.trk; }
      mk.setLngLat([p.lon, p.lat]).setOffset([0, 0]);
      const el = mk.getElement();
      el.style.filter = '';
      el.classList.toggle('emerg', !!EMERG[a.squawk]);
      el.classList.toggle('heli', isHeli(a));
      el.innerHTML = `<div class="ic" style="transform:rotate(calc(${p.trk ?? a.track ?? 0}deg - var(--brg, 0deg)))">${isHeli(a) ? heliSvg(c, isMedical(a)) : planeSvg(c)}</div><span class="alt" style="color:${c}">${altTxt(Math.round(p.alt ?? a.alt))}</span>`;
      if (m) { m.faded = Date.now() - m.t > (m.land ? 15000 : FADE_AFTER); el.style.opacity = m.faded ? '0.5' : ''; }
      el.title = `${a.flight || a.reg || a.hex} · ${a.type || ''}`;
      const s = a._sit;
      mk.getPopup().setHTML(`<h3>${esc(a.flight || a.reg || a.hex)}${a.reg && a.reg !== a.flight ? ' · ' + esc(a.reg) : ''}</h3>
        ${refPhoto(a)}<p><span style="color:${c}">${kindOf(a)}</span> · ${esc(typeName(a))} · <b>${s.state}</b></p>
        <div class="m">${altTxt(a.alt)} FT · ${Math.round(a.gs || 0)} KT${a.track != null ? ' · HDG ' + Math.round(a.track) + '°' : ''}${EMERG[a.squawk] ? ' · SQUAWK ' + a.squawk + ' ' + EMERG[a.squawk] : ''}</div>
        ${regLine(a) ? `<div class="m">${esc(regLine(a))}</div>` : ''}
        <div class="m">${s.fieldNm.toFixed(1)} NM FROM ${esc(s.field.name)} · ${s.homeNm.toFixed(1)} NM FROM ABERDEEN</div>`);
    }
    for (const [hex, v] of landed) if (!seen.has(hex)) { drawLanded(hex, v); seen.add(hex); }
    for (const [hex, mk] of markers) if (!seen.has(hex)) { mk.remove(); markers.delete(hex); }
    renderList();
    window.htDeclutter?.();
  }

  function renderList() {
    const alerts = $('#airAlerts'), list = $('#airList'), note = $('#airNote');
    if (!list) return;
    const flagged = planes.filter((a) => EMERG[a.squawk] || isMil(a) || isCoastGuard(a));
    alerts.innerHTML = flagged.map((a) => `<li class="${EMERG[a.squawk] ? 'k-closure' : 'k-work'} clickable" data-hex="${esc(a.hex)}">
      <div class="t">${EMERG[a.squawk] ? `⚠ SQUAWK ${a.squawk}: ${EMERG[a.squawk]}` : isCoastGuard(a) ? '⚠ COAST GUARD AIRCRAFT' : a.milSure ? '⚠ MILITARY AIRCRAFT' : '⚠ POSSIBLE MILITARY AIRCRAFT'} · ${esc(a.flight || a.reg || a.hex)}</div>
      <div class="m">${esc(typeName(a))} · ${altTxt(a.alt)} FT · ${a._sit.state} · ${a._sit.homeNm.toFixed(1)} NM FROM ABERDEEN</div></li>`).join('');
    // helicopters first, then nearest first
    const sorted = planes.slice().sort((a, b) => (isHeli(b) - isHeli(a)) || a._sit.homeNm - b._sit.homeNm);
    list.innerHTML = sorted.length ? sorted.map((a) => `<li class="clickable" data-hex="${esc(a.hex)}" style="border-left-color:${tint(a)}">
      <div class="t">${esc(a.flight || a.reg || a.hex)} <span class="pill st-${a._sit.state.replace(/\s/g, '')}">${a._sit.state}</span></div>
      <div class="m">${kindOf(a)} · ${esc(a.known?.name || a.model ? typeName(a) : a.type || '?')} · ${altTxt(a.alt)} FT · ${Math.round(a.gs || 0)} KT · ${a._sit.homeNm.toFixed(1)} NM AWAY
        ${a._sit.state === 'INBOUND' ? ' · TO ' + esc(a._sit.field.id) : a._sit.state === 'OUTBOUND' ? ' · FROM ' + esc(a._sit.field.id) : ''}</div></li>`).join('')
      : '<li class="empty">NO LOW AIRCRAFT IN THE AREA</li>';
    const age = updated ? Math.round((Date.now() - Date.parse(updated)) / 60000) : null;
    note.textContent = live ? `Live ADS-B positions (${liveSource}), refreshed about every 30 seconds.`
      : stale ? `No live aircraft positions right now (the backup copy is ${age != null ? age + ' min' : 'too'} old, so it isn’t shown).`
      : `ADS-B positions (adsb.lol) from the last collector run${age != null ? `, ${age} min ago` : ''}.${C.airRelay ? ' The live feeds have nothing right now.' : ''}`;
    $('#nAir').textContent = flagged.length || '';
    window.htTicker = window.htTicker || {};
    window.htTicker.air = flagged.map((a) => `${EMERG[a.squawk] ? 'SQUAWK ' + a.squawk : kindOf(a)} ${a.flight || a.reg || ''} ${altTxt(a.alt)} ft near ${a._sit.field.id}`).join(' · ');
    window.htTickerRefresh?.();
  }
  document.addEventListener('click', (e) => {
    const li = e.target.closest('#airList li[data-hex], #airAlerts li[data-hex]'); if (!li) return;
    const mk = markers.get(li.dataset.hex);
    if (mk) { map.flyTo({ center: mk.getLngLat(), zoom: Math.max(map.getZoom(), 11) }); if (!mk.getPopup().isOpen()) mk.togglePopup(); }
  });

  let soonT = 0;
  async function load() {
    try {
      let j = null;
      live = false;
      if (C.airRelay) {
        try {
          const r = await (await fetch(`${C.airRelay}?t=${Date.now()}`, { cache: 'no-store' })).json();
          // the relay's clock vs. ours (a phone's clock can be off by seconds), so position times line up
          const skew = Number.isFinite(r.now) ? Date.now() - r.now : 0;
          // the relay keeps serving its last good list when feeds refuse it; only call it live if it's under 3 minutes old
          if (Array.isArray(r.ac) && r.ac.length && (!r.at || Date.now() - Date.parse(r.at) < 180000)) {
            live = true; liveSource = r.source || 'adsb.lol';
            j = { updated: new Date().toISOString(), aircraft: r.ac.map((a) => ({ hex: a.hex, flight: (a.flight || '').trim(), reg: a.r, type: a.t, cat: a.category,
              alt: a.alt_baro === 'ground' ? 0 : +a.alt_baro || 0, gs: a.gs, track: a.track, rate: a.baro_rate, lat: a.lat, lon: a.lon, squawk: a.squawk, mil: !!(a.dbFlags & 1), mine: !!a.mine,
              // for the glide between reports (see syncModels)
              pt: Number.isFinite(a.pt) ? a.pt + skew : (r.at ? Date.parse(r.at) + skew : undefined),
              trackRate: a.track_rate, roll: a.roll, navHdg: a.nav_heading, navAlt: a.nav_altitude ?? a.nav_altitude_mcp ?? a.nav_altitude_fms, geomRate: a.geom_rate,
              trail: Array.isArray(a.trail) ? a.trail.map((q) => [q[0] + skew, q[1], q[2]]) : undefined })) };
          }
        } catch (e) { console.warn('air relay', e); }
      }
      // relay missing, down, or empty: fall back to the collector's copy
      if (!j) {
        j = await (await fetch(`data/aircraft.json?t=${Date.now()}`, { cache: 'no-store' })).json();
        // the collector's copy is only refreshed every 10-20 minutes: past 15 minutes old, a plane drawn where it was
        // then is just wrong, so show none (the note under the list says why)
        if (!(Date.now() - Date.parse(j.updated) < 15 * 60000)) j = { updated: j.updated, aircraft: [], stale: true };
      }
      stale = !!j.stale;
      updated = j.updated;
      for (const a of j.aircraft || []) applyKnown(a);
      // Olympia's busy training traffic is left out: everything west of about Rochester/McCleary, plus helicopters,
      // possible military and emergencies anywhere in the area
      const special = (a) => isHeli(a) || isMil(a) || isCoastGuard(a) || EMERG[a.squawk];
      planes = (j.aircraft || []).filter((a) => a.lat && a.lon && a.lat > 46.5 && a.lat < 48 && a.lon > -124.6 &&
        ((rx && a.mine) || (isAirliner(a) && !special(a) ? showAirliners
          : (a.alt || 0) <= 15000 && (a.lon < -123.05 || (a.lon < -122.7 && special(a))))));
      for (const a of planes) a._sit = situation(a);
      syncModels(planes, Date.now());
    } catch (e) { console.warn('aircraft', e); }
    render();
    // a helicopter on the map: ask again in 15 s instead of 30, so its glide gets corrected sooner
    clearTimeout(soonT);
    if (C.airRelay && planes.some((a) => isHeli(a))) soonT = setTimeout(() => { if (!document.hidden) load(); }, 15000);
  }

  // show/hide aircraft (on by default; remembered per device; ?aircraft=0 hides them)
  let on = qs.has('aircraft') ? qs.get('aircraft') !== '0' : store.get('ht.aircraft') !== false;
  function setOn(v) {
    on = v; store.set('ht.aircraft', v);
    const btn = $('#btnAir');
    btn.classList.toggle('on', v); btn.setAttribute('aria-pressed', v);
    document.body.classList.toggle('no-aircraft', !v);
    window.htDeclutter?.();
  }
  $('#btnAir').addEventListener('click', () => setOn(!on));
  setOn(on);

  loadKnown().then(load);
  // the relay refreshes about every 30 s (what each aircraft is: every 10 min); a background tab doesn't ask
  setInterval(() => { if (!document.hidden) loadKnown().then(load); }, C.airRelay ? 30000 : 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadKnown().then(load); });
})();
