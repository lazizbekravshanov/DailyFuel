#!/usr/bin/env python3
"""Import a hand built point list into data/map/fleet_points.json.

A maintenance tool, not part of the scheduled job. The CSV (ID, Address,
Name, Latitude, Longitude, Radius, Tags, Notes, Type) stays outside the
repo. Run it by hand with the Census cartographic boundary file for the
states (public domain, cb_2023_us_state_500k from
https://www2.census.gov/geo/tiger/GENZ2023/kml/, the .zip or the .kml in it):

    python scripts/import_fleet_points.py --csv ~/geofences.csv \\
        --boundaries ~/census/cb_2023_us_state_500k.zip --dropped-report ~/fleet_dropped.csv

Every row is categorised from its Name alone (weigh station, inspection,
port of entry, TA, Petro, Love's shop, Speedco, LubeZone, ProFleet); the
rest is dropped. Pins of one category at the same coordinates are one pin,
with no direction when theirs differ, and pins of one category and
direction within 25 m are one pin. The output carries lat, lon, category,
direction, state and a label built from the category and direction, and
nothing from the CSV's text fields. Its counts are the points per category
and nothing else; how many rows were read, dropped or folded is only
printed here. --dropped-report writes the dropped rows with their reason
for the owner; it is refused inside the repo, the main checkout of a
worktree included.

--boundaries is required. It also takes a us-atlas TopoJSON or a GeoJSON
FeatureCollection of the states; both are coarser than the Census file. A pin in no state polygon is
tried again 1 km away, for causeways and piers the coast line cuts off.
Every run checks each assigned state against the "XX 12345" state and ZIP
the CSV wrote in its Address and Notes and prints every disagreement; there
should be none. The file is validated against
schemas/map-fleet-points.schema.json before it is written, and a rerun on
the same CSV rewrites nothing, even on a later day.
"""

from __future__ import annotations

import argparse
import gzip
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import fleetpoints, mapdata, store  # noqa: E402
from dailyfuel.paths import DATA_DIR, REPO_ROOT, utc_now  # noqa: E402
from dailyfuel.states import load_states  # noqa: E402

OVERLAP_M = 1500.0
EXISTING_WEIGH = (mapdata.WEIGH_OSM, mapdata.WEIGH_NTAD, mapdata.WEIGH_IA)


def _gzip_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=9))


def repo_roots(root: Path = REPO_ROOT) -> tuple[Path, ...]:
    """The running checkout's root, plus the main checkout's when root is a linked worktree.

    A linked worktree keeps a .git file whose gitdir line points into the
    main checkout's .git/worktrees/<name>. That directory's commondir file
    (or, without one, its worktrees parent) is the git common dir, and its
    parent is the main checkout's top level. Both are inside the repo for
    the dropped report. Everything is resolved, so symlinked temp dirs
    compare equal.
    """
    root = root.resolve()
    roots = [root]
    dotgit = root / ".git"
    if not dotgit.is_file():
        return tuple(roots)
    text = dotgit.read_text(encoding="utf-8").strip()
    if not text.startswith("gitdir:"):
        return tuple(roots)
    gitdir = Path(text[len("gitdir:"):].strip())
    if not gitdir.is_absolute():
        gitdir = root / gitdir
    commondir = gitdir / "commondir"
    if commondir.is_file():
        common = gitdir / commondir.read_text(encoding="utf-8").strip()
    elif gitdir.parent.name == "worktrees":
        common = gitdir.parent.parent
    else:
        return tuple(roots)
    common = common.resolve()
    if common.name == ".git" and common.parent != root:
        roots.append(common.parent)
    return tuple(roots)


def _inside_repo(path: Path, roots: tuple[Path, ...] | None = None) -> bool:
    resolved = path.resolve()
    for root in roots or repo_roots(REPO_ROOT):
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        return True
    return False


def _existing_weigh(data_dir: Path) -> list[tuple[float, float]]:
    out = []
    for rel in EXISTING_WEIGH:
        path = data_dir / rel
        if path.exists():
            out.extend((s["lat"], s["lon"]) for s in store.read_json(path).get("sites", []))
    return out


def report(built: fleetpoints.Build, data_dir: Path, out=print) -> None:
    doc, dropped, stats = built.doc, built.dropped, built.stats
    points = doc["points"]
    cats = ", ".join(f"{k} {n}" for k, n in doc["counts"].items() if n)
    out(f"fleet points: {len(points)} points from {stats['rows']} rows ({cats})")
    out(
        f"  dropped {stats['dropped']} rows, {stats['duplicates']} pins at the coordinates of another, "
        f"{stats['near_duplicates']} within {doc['dedupe_m']} m of another, {stats['no_state']} points in no state"
    )
    directions = Counter(p["direction"] or "none" for p in points if p["category"] in fleetpoints.DIRECTED)
    out("  directions: " + ", ".join(f"{k} {directions[k]}" for k in (*fleetpoints.DIRECTIONS, "none")))
    states = Counter(p["state"] or "none" for p in points)
    out("  states (top 10): " + ", ".join(f"{k} {n}" for k, n in states.most_common(10)))
    out(
        f"  state cross check: {stats['checkable']} of {len(points)} points carry a state and ZIP in the CSV, "
        f"{len(built.mismatches)} disagree with the assigned state"
    )
    for m in built.mismatches:
        rows = ", ".join(str(n) for n in m.rows[:5]) + (", ..." if len(m.rows) > 5 else "")
        out(f"    {m.lat},{m.lon} assigned {m.state or 'none'}, the CSV says {'/'.join(m.hints)} (row {rows})")
    reasons = Counter(d.reason for d in dropped)
    if reasons:
        out("  drop reasons: " + ", ".join(f"{k} {n}" for k, n in reasons.most_common()))
    existing = _existing_weigh(data_dir)
    if existing:
        fleet_weigh = [(p["lat"], p["lon"]) for p in points if p["category"] == "weigh"]
        a, b = fleetpoints.overlap(fleet_weigh, existing, OVERLAP_M)
        out(
            f"  overlap at {OVERLAP_M / 1000:g} km: {a} of {len(fleet_weigh)} fleet weigh points near an existing "
            f"weigh point, {b} of {len(existing)} existing weigh points near a fleet one"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--csv", required=True, type=Path, metavar="PATH", help="the point list CSV (kept out of the repo)")
    parser.add_argument(
        "--boundaries",
        required=True,
        type=Path,
        metavar="FILE",
        help="state polygons: the Census cb_2023_us_state_500k .zip or .kml (use this), "
        "a us-atlas TopoJSON or a GeoJSON FeatureCollection",
    )
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="data folder to update (default: data/)")
    parser.add_argument("--dropped-report", type=Path, metavar="PATH", help="write the dropped rows with their reason here")
    parser.add_argument("--imported", metavar="YYYY-MM-DD", help="the import date to record (default: today, UTC)")
    args = parser.parse_args(argv)

    if args.dropped_report is not None and _inside_repo(args.dropped_report):
        print("error: the dropped report names the owner's places; write it outside the repo.", file=sys.stderr)
        return 2
    if _inside_repo(args.csv):
        print(f"note: {args.csv} is inside the repo. Never commit it.", file=sys.stderr)

    states = load_states()
    try:
        boundaries = fleetpoints.load_boundaries(args.boundaries, states)
        rows = fleetpoints.read_rows(args.csv)
        imported = args.imported or utc_now().date().isoformat()
        built = fleetpoints.build(rows, boundaries, imported)
        path = args.data_dir / fleetpoints.FLEET_POINTS
        existing = store.read_json(path) if path.exists() else None
        doc = fleetpoints.keep_imported_date(built.doc, existing)
        changed = fleetpoints.write(doc, args.data_dir)
    except (fleetpoints.FleetError, mapdata.MapDataError, store.SchemaError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        print("error: nothing written.", file=sys.stderr)
        return 1

    if args.dropped_report is not None:
        fleetpoints.write_dropped_report(built.dropped, args.dropped_report)
        print(f"dropped rows written to {args.dropped_report}")
    built.doc = doc
    report(built, args.data_dir)
    print(f"{path} {'rewritten' if changed else 'unchanged'}, {path.stat().st_size:,} bytes, {_gzip_size(path):,} gzip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
