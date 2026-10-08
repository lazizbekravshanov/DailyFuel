"""Checks that fail the scheduled job when data is bad or stale."""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path
from typing import Mapping

from . import aaa, eia, store
from .paths import LATEST, today_et
from .states import StateTable, load_states

BAD_AAA = ("blocked", "invalid", "error")
AAA_STALE_DAYS = 2
EIA_STALE_DAYS = 10


def problems(
    status: dict | None,
    data_dir: Path,
    env: Mapping[str, str],
    now: datetime,
    states: StateTable | None = None,
) -> list[str]:
    today = today_et(now)
    out = []
    if status is None:
        out.append("run_status.json is missing, so the update step didn't finish")
    else:
        if status.get("aaa") in BAD_AAA:
            out.append(f"AAA status is {status.get('aaa')}")
        if status.get("eia") == "error":
            out.append("EIA status is error")

    if env.get("AAA_ENABLED") == "true":
        dates = aaa.snapshot_dates(data_dir)
        if not dates:
            out.append("AAA is on but there are no AAA snapshots")
        elif (today - dates[-1]).days >= AAA_STALE_DAYS:
            out.append(f"newest AAA snapshot is {dates[-1]}, {(today - dates[-1]).days} days old")

    doc = None
    try:
        doc = eia.load(data_dir)
    except (OSError, ValueError) as e:
        out.append(f"couldn't read EIA data: {e}")
    if doc is None or not doc.get("weeks"):
        if not any(p.startswith("couldn't read EIA") for p in out):
            out.append("there is no EIA weekly data")
    else:
        newest = date.fromisoformat(doc["weeks"][-1]["period"])
        age = (today - newest).days
        if age > EIA_STALE_DAYS:
            out.append(f"newest EIA week is {newest}, {age} days old")

    out.extend(build_problems(data_dir, states))
    return out


def build_problems(data_dir: Path, states: StateTable | None = None) -> list[str]:
    """What the site build would refuse, so the job can stop before it commits.

    The build checks the data again in src/lib/data.ts and throws on anything
    wrong, and Vercel then keeps serving the last deploy while this job looks
    green. Most of those checks can't fail on what the pipeline writes. This one
    can: in eia_only mode every state EIA surveys needs a price in the newest
    week, and EIA does sometimes leave one region's cell blank. Keep it in step
    with checkConsistency in data.ts.
    """
    path = Path(data_dir) / LATEST
    try:
        latest = store.read_json(path)
    except FileNotFoundError:
        return [f"{path} is missing, so the site can't build"]
    except (OSError, ValueError) as e:
        return [f"couldn't read {path}: {e}"]
    if latest.get("mode") != "eia_only" or latest.get("eia") is None:
        return []

    table = states or load_states()
    missing: dict[str, list[str]] = {}
    # Rows are in states.json order, which data.ts checks before this rule.
    for row, ref in zip(latest.get("states") or [], table.states):
        if ref.eia_series is not None and row.get("eia") is None:
            missing.setdefault(ref.eia_series, []).append(ref.code)
    period = latest["eia"]["period"]
    out = []
    for key, codes in missing.items():
        label = table.benchmarks.get(key, {}).get("label", key)
        out.append(
            f"EIA left the {label} price ({key}) blank for the week of {period}, so {_and(codes)} "
            "would have no price and the site build would refuse the data"
        )
    return out


def _and(items: list[str]) -> str:
    """CO, then CO and ID, then CO, ID and MT."""
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def read_status(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
