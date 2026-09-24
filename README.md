# DailyFuel

Diesel prices for every US state plus DC, and which way they moved.

Live at **[dailydiesel.vercel.app](https://dailydiesel.vercel.app)**

DailyFuel is a free site for truck drivers, owner operators, dispatchers, farmers and anyone else who fills up with diesel. It answers one question fast: what does diesel cost in my state right now, and did it go up or down? No ads, no cookies, no accounts. Visits are counted with Vercel Web Analytics, which uses no cookies and stores no personal data.

## Design

The site is a paper terminal: a white page, near black ink, the monospace font already on your device (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), hairline rules, and colour in exactly one place, on a change (red when diesel rose, blue when it fell). No web font, no icons, no arrows, no cards, nothing animates. Prices print as `$6.285` in headings and `6.285` in tables, changes as `+31.8¢ +5.3%`, with the sign carrying the direction. Dark mode is the true inverse, white ink on black; it follows the system setting and the DARK button in the header can force either one, remembered on that phone only. The tokens live in `src/styles/tokens.css` and the shared classes in `src/styles/global.css`.

## How the data works

There's no server and no database. A scheduled GitHub Actions job fetches prices, saves them as JSON in `data/`, and commits the change. Every commit to `main` makes Vercel rebuild the static site from those files. Vercel never fetches prices itself.

* The job lives in `.github/workflows/update-data.yml`. It runs three times a day, at 12:17, 15:47 and 20:17 UTC, and you can also start it by hand.
* `scripts/update_data.py` checks each source and validates every file against the JSON Schemas in `schemas/` before writing it. It only writes when the numbers actually changed, so a run with nothing new leaves the repo alone and makes no commit.
* It then rebuilds `data/latest.json`, the snapshot the site renders.
* `scripts/health.py` fails the job when a source errored or the data is stale: EIA's newest week is more than 10 days old, or, while AAA is on, AAA's newest day is 2 or more days old. A failed scheduled run opens an issue labeled `data-failure`, or comments on the one that's already open.
* The site checks the data again at build time, so bad data fails the deploy instead of going live.

EIA's weekly prices are as of Monday morning and come out on Tuesday, or Wednesday after a Monday holiday.

## Two modes

The same code runs in one of two modes. The `mode` field in `data/latest.json` says which.

* **`eia_only`** is the launch mode and what's live now. It shows the official weekly prices from the U.S. Energy Information Administration. EIA reports diesel by region, not by state (California is the only state it breaks out), so states in the same region share a price. EIA doesn't survey Alaska or Hawaii, so those two have no weekly price.
* **`aaa+eia`** adds AAA's daily diesel average for each state, with EIA's weekly price shown as a benchmark.

**AAA is switched off for now.** We read AAA's site terms as limiting reuse to personal, non commercial use, so the owner is asking AAA for permission before turning this on. The AAA code is built and tested, but while it's off nothing contacts AAA and there's no AAA data in this repo. Tests and CI only use made up AAA pages and numbers.

The switch is the repo variable `AAA_ENABLED`. Only the exact string `true` turns it on. Unset, `false`, `True`, `1` or anything else means off.

## Sources and licenses

| What | Where it comes from | License |
|---|---|---|
| Weekly diesel prices | U.S. Energy Information Administration, [Gasoline and Diesel Fuel Update](https://www.eia.gov/petroleum/gasdiesel/) | Public domain. EIA asks for credit with the release date, and the site shows it. |
| Backup copy of the same EIA prices, only used when EIA's workbook fails | USDA Agricultural Marketing Service, [agtransport.usda.gov](https://agtransport.usda.gov/) | U.S. government data |
| State diesel tax rates | Federal Highway Administration, Highway Statistics [table MF-121T](https://www.fhwa.dot.gov/policyinformation/statistics/2024/mf121t.cfm) | U.S. government work, public domain. The site credits FHWA with the reporting period. |
| Daily state prices (off for now) | AAA, [gasprices.aaa.com](https://gasprices.aaa.com/), data by OPIS | Not covered by this repo's license. See [data/aaa/README.md](data/aaa/README.md). |
| Share image font | [Red Hat Mono](https://github.com/RedHatOfficial/RedHatFont) by the Red Hat Project Authors, in `src/assets/fonts/`, drawn into the `/og/` PNGs at build time only. The pages load no font. | SIL Open Font License 1.1 |
| Truck stops and weigh stations on `/map` | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, in `data/map/stations.json` and `data/map/weigh_osm.json` | Open Database License 1.0 |
| More weigh stations on `/map` | U.S. DOT BTS, NTAD Truck Stop Parking (2019), in `data/map/weigh_ntad.json`, and Iowa DOT weigh scales, in `data/map/weigh_ia.json` | NTAD is public domain. Iowa DOT is CC BY 4.0. |
| Weigh station and truck service points on `/map` | DailyFuel, in `data/map/fleet_points.json` | CC BY 4.0 |
| Freight roads on `/map` | U.S. DOT BTS, NTAD [National Highway Freight Network](https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Highway_Freight_Network/FeatureServer/0), in `data/map/roads_nhfn.json` | Public domain. The file keeps the source's metadata note, which asks to travel with the data. |
| State outlines on `/map` | U.S. Census Bureau cartographic boundary file, in `data/map/states.json` | Public domain |
| Place names for the route strip | [GeoNames](https://www.geonames.org) cities5000, in `data/map/places.json` | CC BY 4.0 |
| Map library | [Leaflet](https://leafletjs.com) 1.9.4, served from `public/vendor/leaflet/` | BSD 2 clause, see `public/vendor/leaflet/LICENSE` |
| DailyFuel code | this repo | MIT, see [LICENSE](LICENSE) |

The MIT license covers the code only. Each data source keeps its own terms, and each file under `data/map/` carries its own source and licence. DailyFuel isn't affiliated with EIA, USDA, FHWA, AAA or OPIS, or with any truck stop chain; chain names on the map only say whose stop it is.

## Run it locally

You need Python 3.12 and Node 24 (see `.nvmrc`). No API keys.

### Data pipeline

```sh
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements-dev.txt

python -m pytest                  # all tests, real network sockets are blocked
python scripts/update_data.py     # fetch EIA and update data/, AAA stays off
python scripts/health.py          # the same checks the scheduled job runs
```

Run `update_data.py` twice in a row and the second run changes nothing. Locally it writes `run_status.json` in the repo root, which git ignores.

### Diesel tax

State diesel tax rates come from FHWA's table MF-121T, which FHWA posts once a year. They aren't part of the scheduled job. Refresh them by hand when a new reporting period comes out:

```sh
python scripts/update_taxes.py --year 2025     # fetches MF-121T for that year
python scripts/update_taxes.py --file mf121t.xlsx --year 2025   # or read a copy you downloaded
```

It needs `openpyxl`, which is in the dev packages only. It writes `data/taxes/state_diesel_tax.json`, validated against its schema, and a rerun on the same table changes nothing. If FHWA changes the shape of the sheet, it stops and writes nothing.

FHWA's footnotes are old (every one is dated 2002) and some describe taxes states have since changed, so the site never repeats a footnote just because FHWA prints it. The few state notes in `scripts/dailyfuel/taxes.py` were each checked against the state's own law or tax agency, with the source written beside them. The same goes for `OUT_OF_DATE`, the rates FHWA still prints that are known to be stale (Utah's 2021 rate in the 2024 table). A new reporting period stops the run until someone checks those again and bumps `NOTES_CHECKED_FOR`. A rate that moves more than 10 cents against the file on disk stops it too; check it, then pass `--allow-big-moves`.

Tax is shown on its own. It never goes into a price or a change.

`scripts/make_fixtures.py` writes a complete `aaa+eia` data folder with made up AAA numbers to `tmp/fixture-data/` (also ignored by git). Nothing in it comes from AAA. By default the newest fake day is 3 days after EIA's newest week. For a preview without the "older than usual" banner, date it today:

```sh
python scripts/make_fixtures.py --end "$(TZ=America/New_York date +%F)"
```

### Website

```sh
npm ci
npm test              # vitest, including a build into tmp/dist-test for the built page checks
npm run dev           # dev server on http://localhost:4321
npm run build         # static site in dist/, built from data/
npm run preview       # serve dist/ on http://localhost:4321
```

Point the build at other data with `DAILYFUEL_DATA_DIR`:

```sh
python scripts/make_fixtures.py
DAILYFUEL_DATA_DIR=tmp/fixture-data npm run build
```

The build stops with `DailyFuel data check failed: ...` when a file is missing, doesn't match its schema, or disagrees with another file.

### CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request. It runs pytest and vitest, builds the site against `data/`, then writes the synthetic AAA data and builds again against that.

## Repo layout

```
.github/workflows/
  update-data.yml          scheduled data job
  ci.yml                   tests and both mode builds
data/
  eia/diesel_weekly.json   EIA weekly prices since 2022-06-13, one week per line
  aaa/README.md            rights notice (aaa/daily/ only shows up once AAA is on)
  taxes/state_diesel_tax.json  state diesel tax rates from FHWA, refreshed by hand once a year
  map/                     what /map draws: truck stops, weigh stations, fleet points, roads, state outlines, places; one file per source, never touched by the job
  latest.json              the snapshot the site renders
schemas/                   JSON Schemas for the data files, the contract
scripts/
  update_data.py           the data job
  health.py                fails the job on errors or stale data
  update_taxes.py          refreshes the tax file from FHWA, run by hand, not by the job
  update_map_data.py       builds data/map/stations.json, the weigh station files and coverage.json from a local cache of OpenStreetMap, NTAD and Iowa DOT and the us-atlas 3 boundary files; run by hand
  update_map_roads.py      builds data/map/roads_nhfn.json, states.json and places.json from a local cache; run by hand
  import_fleet_points.py   builds data/map/fleet_points.json (weigh stations and truck service pins) from a hand built point list, which stays out of the repo, and the Census state boundaries; run by hand
  make_fixtures.py         synthetic aaa+eia data for CI and previews
  make_app_icons.mjs       renders the favicon and home screen icons into public/, run by hand
  requirements.txt         requests, beautifulsoup4, xlrd, jsonschema (pinned)
  requirements-dev.txt     pytest and openpyxl (pinned)
  dailyfuel/               the Python package: states, http, store, eia, aaa, derive, pipeline, health, taxes
tests/                     pytest, synthetic fixtures only
src/
  assets/fonts/            Red Hat Mono, for the share images only
  data/states.json         every state with its FIPS code, PADD and EIA region (the tile field stays for the data schema only)
  lib/                     data loading, formatting, stats and share cards, with vitest tests
  components/              header controls, footer, tables, charts
  layouts/  pages/  styles/  the page shell, the pages, the paper terminal tokens and base styles
  scripts/                 small inline browser scripts: chart readouts, table sort, stale banner, your state, share button, dark mode
public/                    favicon.svg and .ico, home screen icons, site.webmanifest, robots.txt
```

## Turning AAA on

1. Get written permission from AAA.
2. Set the repo variable `AAA_ENABLED` to `true`. On GitHub that's Settings, then Secrets and variables, then Actions, on the Variables tab. Or run `gh variable set AAA_ENABLED --body true`.
3. Run the `update-data` workflow by hand with `force_aaa` checked. A clean run makes 2 AAA requests: the all states page, then the homepage for the national average at least 15 seconds later. A page that returns a 5xx is retried once after 30 seconds, so a bad run can reach 4. Once a day's snapshot is saved, later runs that day leave AAA alone, and `force_aaa` can't change a day that's already stored.
4. The data commit deploys the site in `aaa+eia` mode. Day over day changes show up for every state the day after.

If AAA ever blocks a request, the job writes nothing and doesn't retry. The health check fails the run, and on a scheduled run that opens an issue.

To turn it off again, for example if AAA or OPIS objects: set `AAA_ENABLED` to `false`, run the job once, and delete `data/aaa/daily/`.

## Python packages

`scripts/requirements.txt` and `scripts/requirements-dev.txt` are the human edited inputs. The workflows install from `scripts/requirements.lock` and `scripts/requirements-dev.lock`, which pin every transitive package with a hash, because the data job can push to this repo. Because the install uses `--require-hashes`, a workflow step that adds a package will fail until it's in the lock. Regenerate after editing a `.txt`:

```
pip install pip-tools
pip-compile --generate-hashes --strip-extras --output-file scripts/requirements.lock scripts/requirements.txt
pip-compile --generate-hashes --strip-extras --output-file scripts/requirements-dev.lock scripts/requirements-dev.txt
```

## License

The code is MIT licensed, see [LICENSE](LICENSE). Data licensing is covered in [Sources and licenses](#sources-and-licenses) above.
