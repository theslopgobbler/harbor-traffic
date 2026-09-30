// Aircraft: ADS-B positions, low and local only (15,000 ft and below, inside the area).
// Source: a live relay if HT.airRelay is set in config.js (refreshed every 15 s), otherwise the collector's
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
  const kindOf = (a) => isCoastGuard(a) ? 'COAST GUARD' : isMil(a) ? 'MILITARY?' : isMedical(a) ? 'MEDICAL?' : isHeli(a) ? 'HELICOPTER' : a.cat === 'A3' || a.cat === 'A4' || a.cat === 'A5' ? 'AIRLINER' : 'AIRCRAFT';
  const altTxt = (alt) => alt < 100 ? 'GND' : alt >= 1000 ? (alt / 1000).toFixed(1) + 'K' : String(alt);

  // ---- markers ----
  let planes = [], updated = null, live = false, liveSource = '';
  const markers = new Map(); // hex -> marker
  function render() {
    const seen = new Set();
    for (const a of planes) {
      seen.add(a.hex);
      const c = colorOf(a);
      let mk = markers.get(a.hex);
      if (!mk) {
        const el = document.createElement('div');
        el.className = 'air-mk';
        mk = new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '300px' })).addTo(map);
        markers.set(a.hex, mk);
      } else mk.setLngLat([a.lon, a.lat]);
      const el = mk.getElement();
      el.classList.toggle('emerg', !!EMERG[a.squawk]);
      el.classList.toggle('heli', isHeli(a));
      el.innerHTML = `<div class="ic" style="transform:rotate(${a.track ?? 0}deg)">${isHeli(a) ? heliSvg(c, isMedical(a)) : planeSvg(c)}</div><span class="alt" style="color:${c}">${altTxt(a.alt)}</span>`;
      el.title = `${a.flight || a.reg || a.hex} · ${a.type || ''}`;
      const s = a._sit;
      mk.getPopup().setHTML(`<h3>${esc(a.flight || a.reg || a.hex)}${a.reg && a.reg !== a.flight ? ' · ' + esc(a.reg) : ''}</h3>
        <p><span style="color:${c}">${kindOf(a)}</span> · ${esc(a.type || 'UNKNOWN TYPE')} · <b>${s.state}</b></p>
        <div class="m">${altTxt(a.alt)} FT · ${Math.round(a.gs || 0)} KT${a.track != null ? ' · HDG ' + Math.round(a.track) + '°' : ''}${EMERG[a.squawk] ? ' · SQUAWK ' + a.squawk + ' ' + EMERG[a.squawk] : ''}</div>
        <div class="m">${s.fieldNm.toFixed(1)} NM FROM ${esc(s.field.name)} · ${s.homeNm.toFixed(1)} NM FROM ABERDEEN</div>`);
    }
    for (const [hex, mk] of markers) if (!seen.has(hex)) { mk.remove(); markers.delete(hex); }
    renderList();
    window.htDeclutter?.();
  }

  function renderList() {
    const alerts = $('#airAlerts'), list = $('#airList'), note = $('#airNote');
    if (!list) return;
    const flagged = planes.filter((a) => EMERG[a.squawk] || isMil(a) || isCoastGuard(a));
    alerts.innerHTML = flagged.map((a) => `<li class="${EMERG[a.squawk] ? 'k-closure' : 'k-work'} clickable" data-hex="${esc(a.hex)}">
      <div class="t">${EMERG[a.squawk] ? `⚠ SQUAWK ${a.squawk}: ${EMERG[a.squawk]}` : isCoastGuard(a) ? '⚠ COAST GUARD AIRCRAFT' : '⚠ POSSIBLE MILITARY AIRCRAFT'} · ${esc(a.flight || a.reg || a.hex)}</div>
      <div class="m">${esc(a.type || 'UNKNOWN TYPE')} · ${altTxt(a.alt)} FT · ${a._sit.state} · ${a._sit.homeNm.toFixed(1)} NM FROM ABERDEEN</div></li>`).join('');
    // helicopters first, then nearest first
    const sorted = planes.slice().sort((a, b) => (isHeli(b) - isHeli(a)) || a._sit.homeNm - b._sit.homeNm);
    list.innerHTML = sorted.length ? sorted.map((a) => `<li class="clickable" data-hex="${esc(a.hex)}" style="border-left-color:${colorOf(a)}">
      <div class="t">${esc(a.flight || a.reg || a.hex)} <span class="pill st-${a._sit.state.replace(/\s/g, '')}">${a._sit.state}</span></div>
      <div class="m">${kindOf(a)} · ${esc(a.type || '?')} · ${altTxt(a.alt)} FT · ${Math.round(a.gs || 0)} KT · ${a._sit.homeNm.toFixed(1)} NM AWAY
        ${a._sit.state === 'INBOUND' ? ' · TO ' + esc(a._sit.field.id) : a._sit.state === 'OUTBOUND' ? ' · FROM ' + esc(a._sit.field.id) : ''}</div></li>`).join('')
      : '<li class="empty">NO LOW AIRCRAFT IN THE AREA</li>';
    const age = updated ? Math.round((Date.now() - Date.parse(updated)) / 60000) : null;
    note.textContent = live ? `Live ADS-B positions (${liveSource}), refreshed every 15 seconds.`
      : `ADS-B positions (adsb.lol) from the last collector run${age != null ? `, ${age} min ago` : ''}.${C.airRelay ? ' The live relay isn\'t answering right now.' : ''}`;
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

  async function load() {
    try {
      let j = null;
      live = false;
      if (C.airRelay) {
        try {
          const r = await (await fetch(`${C.airRelay}?t=${Date.now()}`, { cache: 'no-store' })).json();
          // the relay keeps serving its last good list when feeds refuse it; only call it live if it's under 3 minutes old
          if (Array.isArray(r.ac) && r.ac.length && (!r.at || Date.now() - Date.parse(r.at) < 180000)) {
            live = true; liveSource = r.source || 'adsb.lol';
            j = { updated: new Date().toISOString(), aircraft: r.ac.map((a) => ({ hex: a.hex, flight: (a.flight || '').trim(), reg: a.r, type: a.t, cat: a.category,
              alt: a.alt_baro === 'ground' ? 0 : +a.alt_baro || 0, gs: a.gs, track: a.track, rate: a.baro_rate, lat: a.lat, lon: a.lon, squawk: a.squawk, mil: !!(a.dbFlags & 1) })) };
          }
        } catch (e) { console.warn('air relay', e); }
      }
      // relay missing, down, or empty: fall back to the collector's copy
      if (!j) j = await (await fetch(`data/aircraft.json?t=${Date.now()}`, { cache: 'no-store' })).json();
      updated = j.updated;
      // Olympia's busy training traffic is left out: everything west of about Rochester/McCleary, plus helicopters,
      // possible military and emergencies anywhere in the area
      const special = (a) => isHeli(a) || isMil(a) || isCoastGuard(a) || EMERG[a.squawk];
      planes = (j.aircraft || []).filter((a) => a.lat && a.lon && a.lat > 46.5 && a.lat < 48 && a.lon > -124.6 && (a.alt || 0) <= 15000 &&
        (a.lon < -123.05 || (a.lon < -122.7 && special(a))));
      for (const a of planes) a._sit = situation(a);
    } catch (e) { console.warn('aircraft', e); }
    render();
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

  load();
  setInterval(load, C.airRelay ? 15000 : 60000);
})();
