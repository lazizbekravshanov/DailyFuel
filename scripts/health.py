#!/usr/bin/env python3
"""Fail the job when the last update went wrong or the data is stale.

Usage:
    python scripts/health.py [--data-dir DIR] [--status FILE] [--before-commit] [--report FILE]

Exits 1 when any of these is true:
    AAA status is blocked, invalid or error
    AAA is on and the newest AAA snapshot is 2 or more days old (New York date)
    EIA status is error
    the newest EIA week is more than 10 days old
    the newest EIA week came from the USDA backup on an earlier New York day,
        and EIA's workbook failed again on this run
    the site build would refuse the data, like a week where EIA left a region blank

--before-commit runs only the last check. The scheduled job runs it between
fetching and committing, so data the site would refuse never reaches main and
the site keeps the week it already shows.

--report FILE also writes the problems to FILE, for the data-failure issue.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import health, pipeline  # noqa: E402
from dailyfuel.paths import DATA_DIR, utc_now  # noqa: E402

NOT_COMMITTED = "The new data was not committed, so the site keeps the prices it already shows."


def main(argv: list[str] | None = None, env=None, now=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--status", type=Path, default=None, help="run_status.json (default: $RUNNER_TEMP or repo root)")
    parser.add_argument("--before-commit", action="store_true", help="only check what the site build would refuse")
    parser.add_argument("--report", type=Path, default=None, help="also write any problems to this file")
    args = parser.parse_args(argv)

    env = dict(os.environ if env is None else env)
    if args.before_commit:
        found = health.build_problems(args.data_dir)
        title = "DailyFuel check before commit"
    else:
        status_file = args.status or pipeline.status_path(env)
        status = health.read_status(status_file)
        found = health.problems(status, args.data_dir, env, now or utc_now())
        title = "DailyFuel health check"

    lines = [f"* {p}" for p in found] if found else ["All good."]
    if found and args.before_commit:
        lines += ["", NOT_COMMITTED]
    text = "\n".join(lines) + "\n"
    print(text, end="")
    if found and args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### {title}\n\n" + text)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
