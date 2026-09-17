#!/usr/bin/env python3
"""Fail the job when the last update went wrong or the data is stale.

Usage:
    python scripts/health.py [--data-dir DIR] [--status FILE]

Exits 1 when any of these is true:
    AAA status is blocked, invalid or error
    AAA is on and the newest AAA snapshot is 2 or more days old (New York date)
    EIA status is error
    the newest EIA week is more than 10 days old
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import health, pipeline  # noqa: E402
from dailyfuel.paths import DATA_DIR, utc_now  # noqa: E402


def main(argv: list[str] | None = None, env=None, now=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--status", type=Path, default=None, help="run_status.json (default: $RUNNER_TEMP or repo root)")
    args = parser.parse_args(argv)

    env = dict(os.environ if env is None else env)
    status_file = args.status or pipeline.status_path(env)
    status = health.read_status(status_file)
    found = health.problems(status, args.data_dir, env, now or utc_now())

    lines = [f"* {p}" for p in found] if found else ["All good."]
    print("\n".join(lines))
    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("### DailyFuel health check\n\n" + "\n".join(lines) + "\n")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
