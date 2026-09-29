# Harbor Traffic

Roads, drawbridges and weather for Grays Harbor and the coast: Hoh Rain Forest to South Bend, the coast to Olympia and I-5.
Public site (once DNS is set): https://traffic.harborevents.org — add `?tv` for the TV display.

- `index.html`, `styles.css`, `app.js`: the page. The map is MapLibre with OpenFreeMap tiles plus terrain shading and contours from free elevation tiles.
- `config.js`: towns (weather markers), routes for the route picker, and the movable bridges. Edit this file to add places.
- Weather and weather alerts come straight from the National Weather Service (api.weather.gov) in the browser; no key needed.
- `scripts/collect.ps1`: pulls WSDOT highway alerts for the region into `data/wsdot-alerts.json` and adds a line to `data/history/YYYY-MM.jsonl`.
  Uses the `WSDOT_ACCESS_CODE` GitHub secret, or `wsdot-key.txt` locally (never committed).
- `.github/workflows/collect.yml`: runs the collector about every 10 minutes (GitHub often starts it 5–15 minutes late).
- `scripts/serve.ps1`: local preview at http://localhost:8765/.

Bridges: WSDOT says openings are on request from boats, with no published schedule. The Chehalis River Bridge (US 101) can't open on weekdays 7:15–8:15 a.m. and 4:15–5:15 p.m.; the page shows that, and flags a bridge when a WSDOT alert mentions it.

## Coming next
- Store busyness (Walmart, Starbucks): weekly curves entered by hand from Google Maps, shown as "busy now" on the map.
- "Worst times on each road" report built from `data/history`.
- Live congestion colors (needs a TomTom or HERE key).
