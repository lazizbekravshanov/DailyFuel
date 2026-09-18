"""Filesystem locations used by the pipeline."""

from __future__ import annotations

from datetime import datetime, timezone, date
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = REPO_ROOT / "schemas"
STATES_PATH = REPO_ROOT / "src" / "data" / "states.json"
DATA_DIR = REPO_ROOT / "data"

NEW_YORK = ZoneInfo("America/New_York")

# Relative locations inside a data dir. The website reads the same layout.
EIA_WEEKLY = Path("eia") / "diesel_weekly.json"
TAXES = Path("taxes") / "state_diesel_tax.json"
LATEST = Path("latest.json")
AAA_DAILY_DIR = Path("aaa") / "daily"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def today_et(now: datetime) -> date:
    """The calendar date in America/New_York for an aware datetime."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone aware")
    return now.astimezone(NEW_YORK).date()


def iso_utc(now: datetime) -> str:
    """RFC 3339 timestamp in UTC with second precision, like 2026-09-17T12:17:03Z."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone aware")
    return now.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
