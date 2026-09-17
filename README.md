# DailyFuel

Diesel prices for every US state plus DC, and which way they moved.

Live at **[dailydiesel.vercel.app](https://dailydiesel.vercel.app)**

DailyFuel is a free site for truck drivers, owner operators, dispatchers, farmers and anyone else who fills up with diesel. It answers one question fast: what does diesel cost in my state right now, and did it go up or down? No ads, no tracking, no accounts.

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
| Daily state prices (off for now) | AAA, [gasprices.aaa.com](https://gasprices.aaa.com/), data by OPIS | Not covered by this repo's license. See [data/aaa/README.md](data/aaa/README.md). |
| US map shapes | [us-atlas](https://github.com/topojson/us-atlas) © 2013 to 2019 Michael Bostock, from U.S. Census Bureau boundaries | ISC |
| Map drawing | [d3-geo](https://github.com/d3/d3-geo) and [topojson-client](https://github.com/topojson/topojson-client) | ISC |
| Font | [Overpass](https://github.com/RedHatOfficial/Overpass) by The Overpass Project Authors, self hosted through Fontsource | SIL Open Font License 1.1 |
| DailyFuel code | this repo | MIT, see [LICENSE](LICENSE) |

The MIT license covers the code only. Each data source keeps its own terms. DailyFuel isn't affiliated with EIA, USDA, AAA or OPIS.

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

`scripts/make_fixtures.py` writes a complete `aaa+eia` data folder with made up AAA numbers to `tmp/fixture-data/` (also ignored by git). Nothing in it comes from AAA. By default the newest fake day is 3 days after EIA's newest week. For a preview without the "older than usual" banner, date it today:

```sh
python scripts/make_fixtures.py --end "$(TZ=America/New_York date +%F)"
```

### Website

```sh
npm ci
npm test              # vitest
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
  latest.json              the snapshot the site renders
schemas/                   JSON Schemas for the three data files, the contract
scripts/
  update_data.py           the data job
  health.py                fails the job on errors or stale data
  make_fixtures.py         synthetic aaa+eia data for CI and previews
  requirements.txt         requests, beautifulsoup4, xlrd, jsonschema (pinned)
  requirements-dev.txt     pytest (pinned)
  dailyfuel/               the Python package: states, http, store, eia, aaa, derive, pipeline, health
tests/                     pytest, synthetic fixtures only
src/
  data/states.json         every state with its FIPS code, EIA region and tile map spot
  lib/                     data loading, formatting, stats and color bins, with vitest tests
  components/              sign, map, charts, tables
  layouts/  pages/  styles/
  scripts/                 small inline browser scripts: map and chart tooltips, table sort, stale banner, price roll
public/                    favicon.svg, robots.txt
PROMPT.md                  the full build spec
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
