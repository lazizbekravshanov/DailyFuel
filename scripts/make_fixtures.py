#!/usr/bin/env python3
"""Write a complete SYNTHETIC aaa+eia data folder for CI builds and previews.

Usage:
    python scripts/make_fixtures.py [OUT_DIR] [--days N] [--end YYYY-MM-DD] [--eia FILE]

OUT_DIR defaults to tmp/fixture-data/. Point the site at it with
DAILYFUEL_DATA_DIR=tmp/fixture-data npm run build.

What it writes:
    eia/diesel_weekly.json  a copy of the real EIA file (public domain)
    aaa/daily/*.json        made up daily prices, origin "synthetic"
    latest.json             derived in aaa+eia mode

Nothing here comes from AAA. Every AAA style number is invented by a seeded
random walk around the EIA regional price, so the output is the same on every
run with the same inputs. The newest day has a one day gap before it, one state
with a large move, one state far from its EIA region, one state with no change,
and a spread of rises and falls across every map bin. Use --days 1 to get a
single snapshot, which exercises prev_missing instead.
"""

from __future__ import annotations

import argparse
import hashlib
import random
import sys
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import aaa, derive, store  # noqa: E402
from dailyfuel.paths import AAA_DAILY_DIR, DATA_DIR, EIA_WEEKLY, LATEST, REPO_ROOT  # noqa: E402
from dailyfuel.states import load_states  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "tmp" / "fixture-data"
DEFAULT_DAYS = 96

STEP = Decimal("0.0001")
LARGE_MOVE_STATE = "OH"
DIVERGENT_STATE = "WA"
FLAT_STATE = "VT"
NATIONAL_NULL_DAYS_BEFORE_END = 40

# Newest day changes (dollars, over the 2 day gap) cycled across the other
# states so the map gets every bin in both directions.
END_CHANGES = [
    "0.0012", "-0.0015", "0.0110", "-0.0135", "0.0420", "-0.0380", "0.0750", "-0.0920",
    "0.0180", "-0.0060", "0.0290", "-0.0450", "0.0008", "0.0640", "-0.0210",
]


def _rng(label: str) -> random.Random:
    seed = int.from_bytes(hashlib.sha256(f"dailyfuel-fixture:{label}".encode()).digest()[:8], "big")
    return random.Random(seed)


def _q(x: Decimal) -> Decimal:
    return x.quantize(STEP, rounding=ROUND_HALF_UP)


def _dec(x: float, places: str = "0.0001") -> Decimal:
    return Decimal(repr(x)).quantize(Decimal(places), rounding=ROUND_HALF_UP)


def benchmark_series(eia_doc: dict, key: str):
    """Daily benchmark by straight line between weekly EIA values, flat after the newest week."""
    points = [(date.fromisoformat(w["period"]), w["values"][key]) for w in eia_doc["weeks"]]
    points = [(p, store.dec(v)) for p, v in points if v is not None]

    def at(day: date) -> Decimal:
        if day <= points[0][0]:
            return points[0][1]
        for (p0, v0), (p1, v1) in zip(points, points[1:]):
            if p0 <= day < p1:
                frac = Decimal((day - p0).days) / Decimal((p1 - p0).days)
                return v0 + (v1 - v0) * frac
        return points[-1][1]

    return at


def generate(eia_doc: dict, end: date, days: int) -> list[dict]:
    states = load_states()
    if days < 1:
        raise SystemExit("--days must be at least 1")
    # days + 2 calendar days: a lead in day (so the oldest snapshot has a
    # national "yesterday"), then days + 1 days with one missing before the end.
    span = [end - timedelta(days=i) for i in range(days + 1, -1, -1)]
    gap_day = end - timedelta(days=1)
    written = [d for d in span[1:] if d != gap_day]

    newest_week = eia_doc["weeks"][-1]["values"]
    series = {}
    prices: dict[str, dict[date, Decimal]] = {}
    for st in states.states:
        key = st.eia_series or "NUS"
        if key not in series:
            series[key] = benchmark_series(eia_doc, key)
        bench = series[key]
        rng = _rng(st.code)
        if st.code == "AK":
            offset = Decimal("1.0500")
        elif st.code == "HI":
            offset = Decimal("1.5500")
        elif st.code == DIVERGENT_STATE:
            offset = Decimal("1.1200")
        else:
            offset = _dec(rng.uniform(-0.30, 0.65))
        noise = 0.0
        out = {}
        for day in span:
            noise = 0.85 * noise + rng.uniform(-0.02, 0.02)
            value = _q(bench(day) + offset + _dec(noise))
            out[day] = min(max(value, Decimal("1.60")), Decimal("14.90"))
        prices[st.code] = out

    # Shape the newest day so every flag and bin shows up.
    if days >= 2:
        prev_day = end - timedelta(days=2)
        others = [s.code for s in states.states if s.code not in (LARGE_MOVE_STATE, DIVERGENT_STATE, FLAT_STATE)]
        for i, code in enumerate(others):
            prices[code][end] = _q(prices[code][prev_day] + Decimal(END_CHANGES[i % len(END_CHANGES)]))
        prices[LARGE_MOVE_STATE][end] = _q(prices[LARGE_MOVE_STATE][prev_day] + Decimal("0.6150"))
        prices[FLAT_STATE][end] = prices[FLAT_STATE][prev_day]
    prices[DIVERGENT_STATE][end] = _q(store.dec(newest_week["R5XCA"]) + Decimal("1.1800"))

    def national(day: date) -> Decimal:
        total = sum(prices[s.code][day] for s in states.states)
        return (total / Decimal(len(states.states))).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)

    docs = []
    for day in written:
        nat = None
        if day != end - timedelta(days=NATIONAL_NULL_DAYS_BEFORE_END):
            nat = aaa.National(as_of=day, current=national(day), yesterday=national(day - timedelta(days=1)))
        page = aaa.AllStates(
            as_of=day,
            as_of_raw=f"{day.month}/{day.day}/{day.year % 100:02d}",
            diesel={code: prices[code][day] for code in prices},
        )
        docs.append(aaa.build_snapshot(page, f"{day.isoformat()}T12:17:00Z", "synthetic", nat))

    for a, b in zip(docs, docs[1:]):
        if a["diesel"] == b["diesel"]:
            raise SystemExit(f"synthetic days {a['as_of']} and {b['as_of']} came out identical")
    return docs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write synthetic aaa+eia site data.")
    parser.add_argument("out_dir", nargs="?", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help="number of daily snapshots (default 96)")
    parser.add_argument("--end", type=date.fromisoformat, default=None, help="newest snapshot date (default: newest EIA week + 3 days)")
    parser.add_argument("--eia", type=Path, default=DATA_DIR / EIA_WEEKLY, help="EIA weekly file to copy")
    args = parser.parse_args(argv)

    out = args.out_dir.resolve()
    real = DATA_DIR.resolve()
    if out == real or real in out.parents:
        raise SystemExit(f"refusing to write synthetic data into {real}")

    v = store.validators()
    if not args.eia.exists():
        raise SystemExit(f"{args.eia} not found. Run scripts/update_data.py first.")
    eia_doc = store.read_json(args.eia)
    v.validate("eia-diesel-weekly", eia_doc)

    end = args.end or date.fromisoformat(eia_doc["weeks"][-1]["period"]) + timedelta(days=3)
    docs = generate(eia_doc, end, args.days)

    daily = out / AAA_DAILY_DIR
    if daily.is_dir():
        for old in daily.glob("*.json"):
            old.unlink()
    store.write_doc("eia-diesel-weekly", out / EIA_WEEKLY, eia_doc, v)
    for doc in docs:
        store.write_doc("aaa-daily", daily / f"{doc['as_of']}.json", doc, v)

    latest = derive.build_latest(load_states(), eia_doc, docs, True, f"{end.isoformat()}T12:20:00Z")
    store.write_doc("latest", out / LATEST, latest, v)

    flags = sorted({f for row in latest["states"] for f in row["flags"]})
    print(f"wrote {len(docs)} synthetic AAA days ({docs[0]['as_of']} to {docs[-1]['as_of']}) to {out}")
    print(f"latest.json mode {latest['mode']}, flags present: {', '.join(flags)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
