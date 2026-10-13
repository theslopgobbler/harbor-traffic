# Harbor Traffic

Roads, drawbridges, buses, boats and weather for Grays Harbor and the coast: Hoh Rain Forest to South Bend, the coast to Olympia and I-5.
Live at https://traffic.harborevents.org — add `?tv` for the TV display; `stats.html` is the private stats page.

## What's where
- `index.html`, `styles.css`, `app.js` (map and roads), `bus.js` (buses), `wx.js` (weather, sea, boats), `air.js`, `river.js`, `seis.js`, `menu.js` (menu and What's New), `landmarks.js`, `config.js` (towns, routes, bridges).
- `data/`: written by the collector, kept on the **`data` branch** (not main). GitHub puts main and `data` together on every deploy.
- `ships/`, `landmarks/`: photos for the map (clean copies; originals stay in the private `photos/` folder).
- The bus relay (`harbor-traffic-relay` on Cloudflare Workers, free plan) serves live buses and aircraft, and logs bus on-time data to its D1 database. Its source is kept privately; deploy by pasting it into the Cloudflare editor.

## How it runs
- `.github/workflows/site.yml`, about every 10 minutes (GitHub often starts it 5–15 minutes late): runs `scripts/collect.ps1` (WSDOT alerts, cameras, travel times, ships, crossings, history; rebuilds the bus schedule with `scripts/build-gtfs.ps1` when GHT publishes a new one), commits the results to the `data` branch, and deploys the site. It also deploys right after each publish. The collector is PowerShell; GitHub runs it on Linux.
- Secrets on GitHub: `WSDOT_ACCESS_CODE`, `AISSTREAM_KEY`.

## Working on it (Linux)
- `python3 scripts/serve.py`: local preview at http://localhost:8765/ (`data/` comes from the live site).
- `python3 scripts/publish.py "What changed"`: publish (`--dry-run` to see what would change; `--data data/<file>` to put a data file on the `data` branch).
- `python3 scripts/ship_photos.py`: your own boat and landmark photos from `photos/` (needs `sudo apt install imagemagick`), then publish.
- Add a line to What's New in `menu.js` whenever something people would notice goes out.

Bridges: WSDOT says openings are on request from boats, with no published schedule. The Chehalis River Bridge (US 101) can't open on weekdays 7:15–8:15 a.m. and 4:15–5:15 p.m.; the page shows that, and flags a bridge when a WSDOT alert mentions it.
