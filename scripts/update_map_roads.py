#!/usr/bin/env python3
"""Rebuild the map's road, state outline and place files under data/map/ from open sources.

A maintenance tool, not part of the scheduled job. Run it by hand:

    python scripts/update_map_roads.py                     # build from the cache (tmp/map-cache)
    python scripts/update_map_roads.py --from-cache DIR    # build from another cache directory
    python scripts/update_map_roads.py --live              # refresh the cache first, then build
    python scripts/update_map_roads.py --live --only nhfn --resume
                                                           # page the NHFN again, keeping pages already
                                                           # cached for the same version of the layer
    python scripts/update_map_roads.py --staa-estimate     # size the STAA network, write nothing

--live downloads the Census 1:20,000,000 state outlines, GeoNames
cities5000 and the National Highway Freight Network, one request at a time
with a 30 s timeout each and a User-Agent naming the repo, and writes every
raw download into the cache before building. Building never touches the
network. Writes data/map/roads_nhfn.json, states.json and places.json, each
validated against its schema in schemas/. A rerun on the same cache
rewrites nothing.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import roads, store  # noqa: E402
from dailyfuel.http import RequestsClient  # noqa: E402
from dailyfuel.paths import DATA_DIR, REPO_ROOT, utc_now  # noqa: E402
from dailyfuel.states import load_states  # noqa: E402


def _log(msg: str) -> None:
    print(msg, flush=True)


def _kb(n: int) -> str:
    return f"{n / 1024:.1f} KB"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    try:
        default_cache = roads.DEFAULT_CACHE_DIR.relative_to(REPO_ROOT)
    except ValueError:  # pragma: no cover
        default_cache = roads.DEFAULT_CACHE_DIR
    parser.add_argument("--from-cache", metavar="DIR", type=Path, default=roads.DEFAULT_CACHE_DIR,
                        help=f"cache directory of raw downloads (default {default_cache})")
    parser.add_argument("--live", action="store_true", help="refresh the cache from the three sources first")
    parser.add_argument("--only", action="append", choices=roads.SOURCES,
                        help="with --live, refresh just this source (repeatable)")
    parser.add_argument("--resume", action="store_true",
                        help="with --live, keep NHFN pages cached for the same version of the layer")
    parser.add_argument("--staa-estimate", action="store_true",
                        help="count the STAA National Network and size a national file from the built roads file")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="data folder to update (default: data/)")
    args = parser.parse_args(argv)

    cache_dir: Path = args.from_cache
    states = load_states()
    http = RequestsClient()
    try:
        if args.staa_estimate:
            path = args.data_dir / roads.ROADS_NHFN
            if not path.exists():
                raise roads.RoadsError(f"{path} is missing; build it first")
            est = roads.staa_estimate(http, time.sleep, roads.gzip_size(path.read_bytes()), log=_log)
            print(f"STAA layer: {est['records']:,} records, {est['staa_records']:,} on the National Network (NN = 1)")
            print(f"length: STAA {est['staa_length']:,.1f}, NHFN {est['nhfn_length']:,.1f} "
                  f"({est['staa_length'] / est['nhfn_length']:.1f} times), in the service's Shape__Length units")
            print(f"low end, scaled from the NHFN file ({_kb(est['roads_gzip'])}): {_kb(est['by_nhfn_gzip'])} gzip")
            print(f"high end, scaled from a sample of {est['sample_records']:,} records in {est['sample_states']} states "
                  f"({est['sample_lines']:,} lines, {_kb(est['sample_gzip'])} gzip, length {est['sample_length']:,.2f}): "
                  f"{_kb(est['by_sample_gzip'])} gzip")
            return 0
        if args.live:
            cache_dir.mkdir(parents=True, exist_ok=True)
            done = roads.fetch_live(cache_dir, http, utc_now(), time.sleep, log=_log,
                                    sources=tuple(args.only or roads.SOURCES), resume=args.resume)
            print(f"cache refreshed: {', '.join(done)}")
        result = roads.build(cache_dir, args.data_dir, states, log=_log)
    except (roads.RoadsError, store.SchemaError) as e:
        print(f"error: {e}", file=sys.stderr)
        print("error: nothing written.", file=sys.stderr)
        return 1

    c = result.counts
    s = c["states"]
    print(f"states: {s['features']} features, {s['polygons']} polygons, {s['points']:,} points, "
          f"{s['dropped_islands']} islands dropped")
    r = c["roads"]
    dropped = ", ".join(f"{k} {n}" for k, n in r["dropped_by_state"].items()) or "none"
    print(f"roads: {r['lines']:,} lines, {r['signs']} route signs, {r['points']:,} points "
          f"(from {r['features']:,} features, {r['paths']:,} paths, {r['points_before_simplify']:,} points)")
    print(f"  dropped outside the 50 states plus DC: {r['dropped_outside_us']} ({dropped})")
    p = c["places"]
    print(f"places: {p['places']:,} ({p['top']:,} largest plus {p['capitals_added']} capitals; "
          f"{p['capitals']} capitals in all)")
    for rel, changed in result.changed.items():
        path = args.data_dir / rel
        body = path.read_bytes()
        print(f"{path} {'rewritten' if changed else 'unchanged'}, {len(body):,} bytes, "
              f"{roads.gzip_size(body):,} gzip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
