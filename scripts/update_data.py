#!/usr/bin/env python3
"""Fetch new diesel prices and update data/.

Usage:
    python scripts/update_data.py [--data-dir DIR]

Environment:
    AAA_ENABLED          only the exact string "true" turns AAA on
    FORCE_AAA            "true" fetches AAA even if today's snapshot exists
    RUNNER_TEMP          where run_status.json goes (repo root when unset)
    GITHUB_OUTPUT        gets a commit_message=... line
    GITHUB_STEP_SUMMARY  gets a short Markdown summary

Exits 0 unless the script itself crashes. scripts/health.py decides whether
the run was good enough.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dailyfuel import pipeline  # noqa: E402
from dailyfuel.paths import DATA_DIR  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="data folder to update (default: data/)")
    args = parser.parse_args(argv)

    env = dict(os.environ)
    result = pipeline.run(data_dir=args.data_dir, env=env)
    path = pipeline.write_outputs(result, env)
    print(json.dumps(result.status(), indent=2))
    print(f"latest.json {'rebuilt' if result.latest_changed else 'unchanged'}")
    print(f"commit_message: {result.commit_message}")
    print(f"status written to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
