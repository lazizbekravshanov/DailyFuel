#!/usr/bin/env python3
"""Rebuild the map data files under data/map/ from open sources.

A maintenance tool, not part of the scheduled job. Run it by hand:

    python scripts/update_map_data.py                    # build from the cache (tmp/map-cache)
    python scripts/update_map_data.py --from-cache DIR   # build from another cache directory
    python scripts/update_map_data.py --live             # refresh the cache first, then build

--live runs the four Overpass queries one at a time with a 240 s timeout and
a User-Agent naming the repo, then the NTAD and Iowa DOT feature services,
and writes every raw response into the cache before building. Building never
touches the network. The state DOT layers used for the coverage spot check
are read from the cache only; --live does not fetch them (see
data/map/README.md).

Writes data/map/stations.json, weigh_osm.json, weigh_ntad.json, weigh_ia.json
and coverage.json, each validated against its schema in schemas/. A rerun on
the same cache rewrites nothing. Needs node_modules/us-atlas (npm ci) for the
state boundaries.
"""

from __future__ import annotations

import argparse
import gzip
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import mapdata, store  # noqa: E402
from dailyfuel.http import RequestsClient  # noqa: E402
from dailyfuel.paths import DATA_DIR, utc_now  # noqa: E402
from dailyfuel.states import load_states  # noqa: E402


def _gzip_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=9))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--from-cache",
        metavar="DIR",
        type=Path,
        default=mapdata.DEFAULT_CACHE_DIR,
        help=f"cache directory of raw responses (default {mapdata.DEFAULT_CACHE_DIR.relative_to(mapdata.REPO_ROOT)})",
    )
    parser.add_argument("--live", action="store_true", help="refresh the cache from Overpass, NTAD and Iowa DOT first")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="data folder to update (default: data/)")
    args = parser.parse_args(argv)

    cache_dir: Path = args.from_cache
    states = load_states()
    try:
        if args.live:
            cache_dir.mkdir(parents=True, exist_ok=True)
            written = mapdata.fetch_live(cache_dir, RequestsClient(), utc_now(), time.sleep)
            print(f"cache refreshed: {', '.join(written)}")
        boundaries = mapdata.Boundaries.from_us_atlas(states)
        outline = mapdata.Outline.from_us_atlas()
        result = mapdata.build(cache_dir, args.data_dir, states, boundaries, outline)
    except (mapdata.MapDataError, store.SchemaError) as e:
        print(f"error: {e}", file=sys.stderr)
        print("error: nothing written.", file=sys.stderr)
        return 1

    c = result.counts
    st = c["stations"]
    brands = ", ".join(f"{k} {st[f'brand_{k}']}" for k in mapdata.BRANDS)
    print(f"stations: {st['sites']} sites from {st['elements']} OSM objects ({brands})")
    print(f"  dropped: ambest {st['dropped_ambest']}, outside the US {st['dropped_outside_us']}")
    w = c["weigh_osm"]
    dropped = ", ".join(f"{k[8:]} {n}" for k, n in w.items() if k.startswith("dropped_"))
    print(
        f"weigh_osm: {w['sites']} sites in {w['states']} states from {w['elements']} OSM objects "
        f"({w['via_tag']} by tag, {w['via_name']} by name)"
    )
    print(f"  dropped: {dropped}")
    n = c["weigh_ntad"]
    print(f"weigh_ntad: {n['sites']} sites from {n['rows']} rows (outside the US {n['dropped_outside_us']})")
    i = c["weigh_ia"]
    print(f"weigh_ia: {i['sites']} sites from {i['rows']} rows (outside Iowa {i['dropped_outside_iowa']})")
    cv = c["coverage"]
    share = "n/a" if cv["weigh_share"] is None else f"{cv['weigh_share']:.0%}"
    print(
        f"coverage: weigh stations {cv['weigh_matched']} of {cv['weigh_official']} official points matched "
        f"({share}) in {cv['weigh_states']} states"
    )
    for warning in result.warnings:
        print(f"note: {warning}")
    for rel, changed in result.changed.items():
        path = args.data_dir / rel
        print(f"{path} {'rewritten' if changed else 'unchanged'}, {path.stat().st_size:,} bytes, {_gzip_size(path):,} gzip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
