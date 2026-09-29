// Everything place-specific lives here. Coordinates are approximate town centers.
window.HT = {
  // [west, south, east, north]: Hoh Rain Forest to South Bend, coast to I-5 at Olympia/Grand Mound
  bounds: [-124.45, 46.60, -122.80, 47.92],

  towns: [
    { id: 'hoh',        name: 'Hoh Rain Forest', lat: 47.8606, lon: -123.9349 },
    { id: 'kalaloch',   name: 'Kalaloch',        lat: 47.6082, lon: -124.3735 },
    { id: 'queets',     name: 'Queets',          lat: 47.5371, lon: -124.3257 },
    { id: 'quinault',   name: 'Amanda Park',     lat: 47.4589, lon: -123.8993 },
    { id: 'humptulips', name: 'Humptulips',      lat: 47.2312, lon: -123.9585 },
    { id: 'moclips',    name: 'Moclips',         lat: 47.2393, lon: -124.2141 },
    { id: 'oshores',    name: 'Ocean Shores',    lat: 46.9737, lon: -124.1563 },
    { id: 'hoquiam',    name: 'Hoquiam',         lat: 46.9809, lon: -123.8893 },
    { id: 'aberdeen',   name: 'Aberdeen',        lat: 46.9754, lon: -123.8157 },
    { id: 'montesano',  name: 'Montesano',       lat: 46.9812, lon: -123.6027 },
    { id: 'elma',       name: 'Elma',            lat: 47.0040, lon: -123.4088 },
    { id: 'mccleary',   name: 'McCleary',        lat: 47.0532, lon: -123.2654 },
    { id: 'olympia',    name: 'Olympia',         lat: 47.0379, lon: -122.9007 },
    { id: 'oakville',   name: 'Oakville',        lat: 46.8393, lon: -123.2321 },
    { id: 'rochester',  name: 'Rochester',       lat: 46.8218, lon: -123.0962 },
    { id: 'grandmound', name: 'Grand Mound',     lat: 46.7887, lon: -123.0096 },
    { id: 'westport',   name: 'Westport',        lat: 46.8901, lon: -124.1040 },
    { id: 'tokeland',   name: 'Tokeland',        lat: 46.7071, lon: -123.9824 },
    { id: 'raymond',    name: 'Raymond',         lat: 46.6865, lon: -123.7329 },
    { id: 'southbend',  name: 'South Bend',      lat: 46.6631, lon: -123.8046 }
  ],

  // Routes people pick to see alerts along the way. roads = [ref, OpenMapTiles network]
  corridors: [
    { id: 'olympia',  name: 'Aberdeen ↔ Olympia',  towns: ['aberdeen','montesano','elma','mccleary','olympia'],
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
      lat: 46.9690, lon: -123.8120,
      noOpen: [['07:15','08:15'],['16:15','17:15']],
      note: 'Weekday openings not allowed 7:15–8:15 a.m. and 4:15–5:15 p.m. Any time on weekends and federal holidays.' },
    { id: 'simpson', name: 'Simpson Ave Bridge', route: 'US 101', town: 'Hoquiam',
      lat: 46.9765, lon: -123.8905, noOpen: [],
      note: 'No time restrictions; boats call at least an hour ahead.' },
    { id: 'riverside', name: 'Riverside Bridge', route: 'US 101', town: 'Hoquiam',
      lat: 46.9818, lon: -123.8878, noOpen: [],
      note: 'No time restrictions; boats call at least an hour ahead.' },
    { id: 'heron', name: 'Heron St Bridge', route: 'US 12', town: 'Aberdeen',
      lat: 46.9770, lon: -123.8045, noOpen: [],
      note: 'Wishkah River. No time restrictions.' },
    { id: 'wishkah', name: 'Wishkah St Bridge', route: 'US 12', town: 'Aberdeen',
      lat: 46.9763, lon: -123.8050, noOpen: [],
      note: 'Wishkah River. No time restrictions.' }
  ]
};
