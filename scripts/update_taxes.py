#!/usr/bin/env python3
"""Refresh the state diesel tax file from FHWA table MF-121T.

This is a maintenance tool, not part of the scheduled job. FHWA posts one
table per reporting period, about once a year, so run it by hand when a new
year lands:

    python scripts/update_taxes.py                  # the default year
    python scripts/update_taxes.py --year 2025      # a new reporting period
    python scripts/update_taxes.py --file mf121t.xlsx   # a copy already on disk

It needs openpyxl, which is in scripts/requirements-dev.lock and deliberately
not in scripts/requirements.txt. The scheduled job never runs this.

Writes data/taxes/state_diesel_tax.json, validated against
schemas/state-diesel-tax.schema.json. A rerun on the same workbook rewrites
nothing.

A new reporting period stops the run until the hand checked state notes and
the out of date list in dailyfuel/taxes.py are checked again against the
states (NOTES_CHECKED_FOR). A rate that moves more than 10 cents against the
file on disk also stops it; check that rate, then pass --allow-big-moves.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import store, taxes  # noqa: E402
from dailyfuel.http import RequestsClient  # noqa: E402
from dailyfuel.paths import DATA_DIR, TAXES, utc_now  # noqa: E402
from dailyfuel.states import load_states  # noqa: E402

DEFAULT_YEAR = "2024"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--year", default=DEFAULT_YEAR, help=f"FHWA reporting period (default {DEFAULT_YEAR})")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="data folder to update (default: data/)")
    parser.add_argument("--file", type=Path, default=None, help="read this local .xlsx instead of downloading")
    parser.add_argument(
        "--allow-big-moves",
        action="store_true",
        help=f"write even when a rate moved more than {taxes.BIG_MOVE_CPG} cents (check it against the state first)",
    )
    args = parser.parse_args(argv)

    if not args.year.isdigit() or len(args.year) != 4:
        parser.error(f"--year takes a 4 digit reporting period, not {args.year!r}")

    now = utc_now()
    states = load_states()
    v = store.validators()

    url = taxes.URL_TEMPLATE.format(year=args.year)
    try:
        if args.file is not None:
            table = taxes.parse_workbook(args.file.read_bytes(), states, args.year)
            result = taxes.write(args.data_dir, table, url, now, v, args.allow_big_moves)
        else:
            result = taxes.update(args.data_dir, RequestsClient(), now, states, args.year, v, args.allow_big_moves)
    except (taxes.TaxParseError, store.SchemaError) as e:
        # The sheet is not the shape this build knows. Nothing was written.
        print(f"error: {e}", file=sys.stderr)
        print(f"error: nothing written. {url}", file=sys.stderr)
        return 1

    if result.status == "error":
        for w in result.warnings:
            print(f"error: {w}", file=sys.stderr)
        return 1

    t = result.table
    assert t is not None
    rated = [v2 for v2 in t.states.values() if v2 is not None]
    print(f"MF-121T {t.reporting_period} reporting period, published {t.published}")
    print(f"federal {t.federal}¢, {len(rated)} of {len(t.states)} states with a rate, {len(t.notes)} notes")
    if t.out_of_date:
        print(f"out of date in FHWA's table, not ranked: {', '.join(t.out_of_date)}")
    print(f"highest {max(rated)}¢, lowest {min(rated)}¢")
    for w in result.warnings:
        print(f"note: {w}")
    print(f"{args.data_dir / TAXES} {'rewritten' if result.changed else 'unchanged'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
