// Everything place-specific lives here. Coordinates are approximate town centers.
window.HT = {
  // [west, south, east, north]: Hoh Rain Forest to South Bend, coast to I-5 at Olympia/Grand Mound
  bounds: [-124.45, 46.60, -122.80, 47.92],

  // live aircraft relay (Cloudflare Worker, code in scripts/relay-worker.js); leave empty to use the collector's copy
  airRelay: 'https://harbor-traffic-relay.sms-relay-protocol.workers.dev/aircraft',

  // Views for the region buttons. bounds = [west, south, east, north]; null = everything.
  // chip = where the region's summary sits in the zoomed-out overview, a = which side of that point
  regions: [
    { id: 'all',     name: 'Full',          bounds: null },
    { id: 'north',   name: 'North Coast',   bounds: [-124.45, 47.18, -123.72, 47.92], chip: [-124.02, 47.55] },
    { id: 'harbor',  name: 'Harbor',        bounds: [-124.22, 46.86, -123.68, 47.08], chip: [-124.12, 47.02], a: 'right' },
    { id: 'willapa', name: 'Willapa',       bounds: [-124.10, 46.60, -123.62, 46.93], chip: [-123.86, 46.72] },
    { id: 'east',    name: 'East County',   bounds: [-123.72, 46.77, -123.10, 47.13], chip: [-123.42, 46.86], a: 'top' },
    { id: 'olympia', name: 'Olympia · I-5', bounds: [-123.20, 46.74, -122.78, 47.12], chip: [-122.95, 47.10], a: 'bottom' }
  ],

  // a = which side of the town its weather label sits on (keeps close towns apart); minor = hidden in the zoomed-out view
  towns: [
    { id: 'hoh',        name: 'Hoh Rain Forest', lat: 47.8606, lon: -123.9349 },
    { id: 'kalaloch',   name: 'Kalaloch',        lat: 47.6082, lon: -124.3735 },
    { id: 'queets',     name: 'Queets',          lat: 47.5371, lon: -124.3257, a: 'top-left', minor: true },
    { id: 'quinault',   name: 'Amanda Park',     lat: 47.4589, lon: -123.8993 },
    { id: 'humptulips', name: 'Humptulips',      lat: 47.2312, lon: -123.9585, a: 'left' },
    { id: 'moclips',    name: 'Moclips',         lat: 47.2393, lon: -124.2141, a: 'right' },
    { id: 'oshores',    name: 'Ocean Shores',    lat: 46.9737, lon: -124.1563, a: 'right' },
    { id: 'hoquiam',    name: 'Hoquiam',         lat: 46.9809, lon: -123.8893, a: 'bottom-right' },
    { id: 'aberdeen',   name: 'Aberdeen',        lat: 46.9754, lon: -123.8157, a: 'top-left' },
    { id: 'montesano',  name: 'Montesano',       lat: 46.9812, lon: -123.6027, a: 'top' },
    { id: 'elma',       name: 'Elma',            lat: 47.0040, lon: -123.4088, a: 'bottom' },
    { id: 'mccleary',   name: 'McCleary',        lat: 47.0532, lon: -123.2654, a: 'bottom', minor: true },
    { id: 'olympia',    name: 'Olympia',         lat: 47.0379, lon: -122.9007 },
    { id: 'oakville',   name: 'Oakville',        lat: 46.8393, lon: -123.2321, a: 'right' },
    { id: 'rochester',  name: 'Rochester',       lat: 46.8218, lon: -123.0962, a: 'bottom-left', minor: true },
    { id: 'grandmound', name: 'Grand Mound',     lat: 46.7887, lon: -123.0096, a: 'top-left' },
    { id: 'westport',   name: 'Westport',        lat: 46.8901, lon: -124.1040 },
    { id: 'tokeland',   name: 'Tokeland',        lat: 46.7071, lon: -123.9824, a: 'right', minor: true },
    { id: 'raymond',    name: 'Raymond',         lat: 46.6865, lon: -123.7329, a: 'bottom-left' },
    { id: 'southbend',  name: 'South Bend',      lat: 46.6631, lon: -123.8046, a: 'top-right' }
  ],

  // Routes people pick to see alerts along the way. roads = [ref, OpenMapTiles network]
  // spots the corner label names when you're zoomed in on them (the map's own data has towns and neighborhoods,
  // but not these). box: [west, south, east, north]; or a point with a radius r in meters. The port's box is a
  // best guess at the terminals along the north shore between Hoquiam and Aberdeen.
  landmarks: [
    { name: 'Port', box: [-123.905, 46.955, -123.835, 46.9705] },
    { name: 'Downtown', lon: -123.8153, lat: 46.9763, r: 600 },          // Aberdeen
    { name: 'Downtown', lon: -123.8866, lat: 46.9776, r: 500 },          // Hoquiam
    { name: 'Bowerman Airport', lon: -123.9357, lat: 46.972, r: 1000 },
    { name: 'Hospital', lon: -123.847, lat: 46.9795, r: 300 },
    { name: 'Grays Harbor College', lon: -123.8012, lat: 46.9552, r: 500 },
    { name: 'Marina', lon: -124.1079, lat: 46.9074, r: 600 },            // Westport
    { name: 'Lighthouse', lon: -124.1169, lat: 46.8875, r: 450 },        // Westport
    { name: 'Westport Airport', lon: -124.1017, lat: 46.8973, r: 500 }
  ],
  corridors: [
    { id: 'olympia',  name: 'Aberdeen ↔ Olympia',  // a = which side of the town its weather label sits on (keeps close towns apart); minor = hidden in the zoomed-out view
  towns: ['aberdeen','montesano','elma','mccleary','olympia'],
      roads: [['12','us-highway'],['8','us-state'],['101','us-highway']] },
    { id: 'i5',       name: 'Elma ↔ Oakville ↔ I-5', towns: ['elma','oakville','rochester','grandmound'],
      roads: [['12','us-highway'],['5','us-interstate']] },
    { id: 'north101', name: 'US 101 north to the Hoh', towns: ['hoquiam','humptulips','quinault','queets','kalaloch','hoh'],
      roads: [['101','us-highway']] },
    { id: 'coast',    name: 'North Beach (SR 109/115)', towns: ['hoquiam','oshores','moclips'],
      roads: [['109','us-state'],['115','us-state']] },
    { id: 'westport', name: 'Westport & Tokeland (SR 105)', towns: ['aberdeen','westport','tokeland','raymond'],
      roads: [['105','us-state']] },
    { id: 'south101', name: 'US 101 south to South Bend', towns: ['aberdeen','raymond','southbend'],
      roads: [['101','us-highway']] }
  ],

  // Movable bridges (WSDOT "Movable bridges on state routes"). Openings are on request, not scheduled;
  // noOpen = weekday windows when marine openings are not allowed. Coordinates approximate.
  bridges: [
    { id: 'chehalis', name: 'Chehalis River Bridge', route: 'US 101', town: 'Aberdeen',
      lat: 46.9690, lon: -123.8120, cam: 10228,
      noOpen: [['07:15','08:15'],['16:15','17:15']],
      note: 'Weekday openings not allowed 7:15–8:15 a.m. and 4:15–5:15 p.m. Any time on weekends and federal holidays.' },
    { id: 'simpson', name: 'Simpson Ave Bridge', route: 'US 101', town: 'Hoquiam',
      lat: 46.9765, lon: -123.8905, noOpen: [], cam: 10230,
      note: 'No time restrictions; boats call at least an hour ahead.' },
    { id: 'riverside', name: 'Riverside Bridge', route: 'US 101', town: 'Hoquiam',
      lat: 46.9818, lon: -123.8878, noOpen: [],
      note: 'No time restrictions; boats call at least an hour ahead.' },
    { id: 'heron', name: 'Heron St Bridge', route: 'US 12', town: 'Aberdeen',
      lat: 46.9770, lon: -123.8045, noOpen: [],
      note: 'Wishkah River. No time restrictions.' },
    { id: 'wishkah', name: 'Wishkah St Bridge', route: 'US 12', town: 'Aberdeen',
      lat: 46.9763, lon: -123.8050, noOpen: [], cam: 10229,
      note: 'Wishkah River. No time restrictions.' }
  ]
};
