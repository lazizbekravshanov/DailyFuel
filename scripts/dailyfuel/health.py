"""Checks that fail the scheduled job when data is bad or stale."""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path
from typing import Mapping

from . import aaa, eia
from .paths import today_et

BAD_AAA = ("blocked", "invalid", "error")
AAA_STALE_DAYS = 2
EIA_STALE_DAYS = 10


def problems(status: dict | None, data_dir: Path, env: Mapping[str, str], now: datetime) -> list[str]:
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
    return out


def read_status(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
