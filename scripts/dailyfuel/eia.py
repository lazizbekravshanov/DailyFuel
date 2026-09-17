"""EIA weekly retail diesel prices.

Primary source is EIA's workbook psw18vwall.xls, fetched with a conditional GET
(If-Modified-Since only, EIA ignores ETags). When the workbook fails to download
or parse, the USDA AgTransport mirror of the same series fills in the 2 newest
weeks.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import xlrd
from xlrd.biffh import XL_CELL_BLANK, XL_CELL_DATE, XL_CELL_EMPTY, XL_CELL_NUMBER, XL_CELL_TEXT

from . import store
from .http import HttpClient, NetworkError
from .paths import EIA_WEEKLY, iso_utc
from .states import EIA_KEYS

XLS_URL = "https://www.eia.gov/petroleum/gasdiesel/xls/psw18vwall.xls"
USDA_URL = "https://agtransport.usda.gov/resource/x88w-atzp.json?$order=date%20DESC&$limit=22"
SCHEMA_ID = "dailyfuel/eia-diesel-weekly/1"

MIN_PERIOD = date(2022, 6, 13)
MIN_PRICE = Decimal("1.5")
MAX_PRICE = Decimal("15")
PRICE_STEP = Decimal("0.001")

USDA_REGIONS = {
    "US": "NUS",
    "East Coast": "R10",
    "New England": "R1X",
    "Central Atlantic": "R1Y",
    "Lower Atlantic": "R1Z",
    "Midwest": "R20",
    "Gulf Coast": "R30",
    "Rocky Mountains": "R40",
    "West Coast": "R50",
    "California": "SCA",
    "West Coast exc California": "R5XCA",
}

_SOURCEKEY = re.compile(r"EMD_EPD2D_PTE_([A-Z0-9]+)_DPG")
_MDY = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")


class EiaParseError(ValueError):
    pass


@dataclass
class Workbook:
    weeks: list[dict]
    release_date: str | None
    next_release_date: str | None


@dataclass
class EiaResult:
    status: str  # ok | not_modified | unchanged | fallback | error
    changed: bool = False
    newest_period: str | None = None
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- parsing


def _price(raw) -> Decimal:
    value = store.dec(raw).quantize(PRICE_STEP)
    if not (MIN_PRICE <= value <= MAX_PRICE):
        raise EiaParseError(f"price {raw} outside [{MIN_PRICE}, {MAX_PRICE}]")
    return value


def _week(period: date, values: dict[str, Decimal | None]) -> dict:
    return {
        "period": period.isoformat(),
        "values": {k: (None if values[k] is None else store.num(values[k])) for k in EIA_KEYS},
    }


def _is_blank(cell) -> bool:
    if cell.ctype in (XL_CELL_EMPTY, XL_CELL_BLANK):
        return True
    return cell.ctype == XL_CELL_TEXT and str(cell.value).strip() == ""


def _parse_mdy(cell, datemode: int) -> str | None:
    if cell.ctype in (XL_CELL_NUMBER, XL_CELL_DATE):
        try:
            return xlrd.xldate_as_datetime(cell.value, datemode).date().isoformat()
        except Exception:
            return None
    m = _MDY.fullmatch(str(cell.value).strip())
    if not m:
        return None
    mo, d, y = map(int, m.groups())
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def release_dates(book) -> tuple[str | None, str | None]:
    """Reads 'Release Date:' and 'Next Release Date:' from the Contents sheet."""
    try:
        sheet = book.sheet_by_name("Contents")
    except Exception:
        return None, None
    found = {"Release Date:": None, "Next Release Date:": None}
    for r in range(sheet.nrows):
        row = sheet.row(r)
        for c, cell in enumerate(row):
            label = str(cell.value).strip() if cell.ctype == XL_CELL_TEXT else ""
            if label in found and found[label] is None:
                for nxt in row[c + 1 :]:
                    if not _is_blank(nxt):
                        found[label] = _parse_mdy(nxt, book.datemode)
                        break
    return found["Release Date:"], found["Next Release Date:"]


def parse_book(book) -> Workbook:
    """Parse an opened workbook (xlrd Book or anything with the same small interface)."""
    try:
        sheet = book.sheet_by_name("Data 1")
    except Exception as e:
        raise EiaParseError("no 'Data 1' sheet") from e
    if sheet.nrows < 4:
        raise EiaParseError(f"'Data 1' has only {sheet.nrows} rows")

    header = sheet.row(1)
    if not header or str(header[0].value).strip() != "Sourcekey":
        raise EiaParseError("row 1 of 'Data 1' doesn't start with Sourcekey")
    columns: dict[str, int] = {}
    for idx, cell in enumerate(header[1:], start=1):
        text = str(cell.value).strip()
        if not text:
            continue
        m = _SOURCEKEY.fullmatch(text)
        if not m:
            raise EiaParseError(f"unexpected Sourcekey {text!r}")
        key = m.group(1)
        if key in columns:
            raise EiaParseError(f"Sourcekey {key} appears twice")
        columns[key] = idx
    if set(columns) != set(EIA_KEYS):
        raise EiaParseError(f"Sourcekeys {sorted(columns)} are not the expected 11")

    weeks: dict[date, dict] = {}
    for r in range(3, sheet.nrows):
        row = sheet.row(r)
        if not row or _is_blank(row[0]):
            continue
        if row[0].ctype not in (XL_CELL_NUMBER, XL_CELL_DATE):
            raise EiaParseError(f"row {r} has a non date cell {row[0].value!r}")
        try:
            period = xlrd.xldate_as_datetime(row[0].value, book.datemode).date()
        except Exception as e:
            raise EiaParseError(f"row {r} has a bad date {row[0].value!r}") from e
        if period.weekday() != 0:
            raise EiaParseError(f"row {r} date {period} is not a Monday")
        if period < MIN_PERIOD:
            continue
        if period in weeks:
            raise EiaParseError(f"period {period} appears twice")
        values: dict[str, Decimal | None] = {}
        for key in EIA_KEYS:
            idx = columns[key]
            cell = row[idx] if idx < len(row) else None
            if cell is None or _is_blank(cell):
                values[key] = None
            elif cell.ctype == XL_CELL_NUMBER:
                values[key] = _price(cell.value)
            else:
                raise EiaParseError(f"row {r} {key} has a non number cell {cell.value!r}")
        if all(v is None for v in values.values()):
            continue
        weeks[period] = _week(period, values)

    ordered = [weeks[p] for p in sorted(weeks)]
    if len(ordered) < 2:
        raise EiaParseError(f"only {len(ordered)} weeks on or after {MIN_PERIOD}")
    if ordered[-1]["values"]["NUS"] is None:
        raise EiaParseError(f"newest week {ordered[-1]['period']} has no U.S. price")
    rel, nxt = release_dates(book)
    return Workbook(weeks=ordered, release_date=rel, next_release_date=nxt)


def parse_workbook(body: bytes) -> Workbook:
    try:
        book = xlrd.open_workbook(file_contents=body)
    except Exception as e:
        raise EiaParseError(f"xlrd couldn't open the workbook: {type(e).__name__}: {e}") from e
    return parse_book(book)


def parse_usda(rows) -> list[dict]:
    """The 2 newest weeks from the USDA mirror. All 11 regions must map for the newest date."""
    if not isinstance(rows, list) or not rows:
        raise EiaParseError("USDA mirror returned no rows")
    by_date: dict[date, dict[str, Decimal]] = {}
    unknown: dict[date, set[str]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise EiaParseError("USDA row is not an object")
        try:
            period = datetime.fromisoformat(str(row["date"])).date()
        except (KeyError, ValueError) as e:
            raise EiaParseError(f"USDA row has a bad date {row.get('date')!r}") from e
        region = str(row.get("region", "")).strip()
        key = USDA_REGIONS.get(region)
        bucket = by_date.setdefault(period, {})
        if key is None:
            unknown.setdefault(period, set()).add(region)
            continue
        if key in bucket:
            raise EiaParseError(f"USDA region {region} appears twice for {period}")
        raw = row.get("diesel_price")
        if raw in (None, ""):
            continue
        try:
            bucket[key] = _price(str(raw))
        except ArithmeticError as e:
            raise EiaParseError(f"USDA price {raw!r} is not a number") from e

    dates = sorted(by_date, reverse=True)
    newest = dates[0]
    if unknown.get(newest):
        raise EiaParseError(f"USDA regions {sorted(unknown[newest])} don't map to EIA keys")
    missing = [k for k in EIA_KEYS if k not in by_date[newest]]
    if missing:
        raise EiaParseError(f"USDA newest date {newest} is missing {missing}")

    weeks = []
    for period in dates[:2]:
        if period.weekday() != 0:
            raise EiaParseError(f"USDA date {period} is not a Monday")
        if period < MIN_PERIOD:
            continue
        values = by_date[period]
        if any(k not in values for k in EIA_KEYS) or unknown.get(period):
            # Only a complete week may replace stored data.
            continue
        weeks.append(_week(period, values))
    return sorted(weeks, key=lambda w: w["period"])


# ---------------------------------------------------------------- merge + update


def merge_weeks(existing: list[dict], new: list[dict]) -> list[dict]:
    """Replace weeks with the same period (EIA revises), keep sorted and unique."""
    merged = {w["period"]: w for w in existing}
    for w in new:
        merged[w["period"]] = w
    return [merged[p] for p in sorted(merged)]


def _content(doc: dict | None) -> dict | None:
    if doc is None:
        return None
    return {k: v for k, v in doc.items() if k not in ("fetched_at", "last_modified")}


def load(data_dir: Path) -> dict | None:
    path = Path(data_dir) / EIA_WEEKLY
    if not path.exists():
        return None
    return store.read_json(path)


def update(data_dir: Path, http: HttpClient, now: datetime, v: store.Validators | None = None) -> EiaResult:
    data_dir = Path(data_dir)
    path = data_dir / EIA_WEEKLY
    existing = load(data_dir)
    if existing is not None and existing.get("schema") != SCHEMA_ID:
        existing = None

    headers = {"Accept": "application/vnd.ms-excel, */*"}
    if existing and existing.get("last_modified"):
        headers["If-Modified-Since"] = existing["last_modified"]

    failure = None
    try:
        resp = http.get(XLS_URL, headers=headers, timeout=60)
    except NetworkError as e:
        resp = None
        failure = f"eia_xls network error: {e}"

    if resp is not None:
        if resp.status == 304 and existing is not None:
            return EiaResult("not_modified", newest_period=existing["weeks"][-1]["period"])
        if resp.status != 200:
            failure = f"eia_xls HTTP {resp.status}"
        else:
            try:
                book = parse_workbook(resp.body)
            except EiaParseError as e:
                failure = f"eia_xls parse failed: {e}"
            else:
                doc = {
                    "schema": SCHEMA_ID,
                    "source": "eia_xls",
                    "source_url": XLS_URL,
                    "fetched_at": iso_utc(now),
                    "last_modified": resp.headers.get("Last-Modified"),
                    "release_date": book.release_date,
                    "next_release_date": book.next_release_date,
                    "weeks": merge_weeks(existing["weeks"] if existing else [], book.weeks),
                }
                newest = doc["weeks"][-1]["period"]
                if existing is not None and _content(doc) == _content(existing):
                    return EiaResult("unchanged", newest_period=newest)
                try:
                    changed = store.write_doc("eia-diesel-weekly", path, doc, v)
                except store.SchemaError as e:
                    failure = f"eia_xls data failed validation: {e}"
                else:
                    return EiaResult("ok", changed=changed, newest_period=newest)

    return _fallback(path, existing, http, now, v, failure)


def _fallback(path: Path, existing: dict | None, http: HttpClient, now: datetime, v, failure: str) -> EiaResult:
    warnings = [failure]
    try:
        resp = http.get(USDA_URL, headers={"Accept": "application/json"}, timeout=30)
    except NetworkError as e:
        warnings.append(f"usda network error: {e}")
        return EiaResult("error", warnings=warnings, newest_period=_newest(existing))
    if resp.status != 200:
        warnings.append(f"usda HTTP {resp.status}")
        return EiaResult("error", warnings=warnings, newest_period=_newest(existing))
    try:
        weeks = parse_usda(json.loads(resp.body.decode("utf-8")))
    except (EiaParseError, ValueError, UnicodeDecodeError) as e:
        warnings.append(f"usda parse failed: {e}")
        return EiaResult("error", warnings=warnings, newest_period=_newest(existing))

    merged = merge_weeks(existing["weeks"] if existing else [], weeks)
    if existing is not None and merged == existing["weeks"]:
        return EiaResult("fallback", changed=False, newest_period=merged[-1]["period"], warnings=warnings)
    doc = {
        "schema": SCHEMA_ID,
        "source": "usda_socrata",
        "source_url": USDA_URL,
        "fetched_at": iso_utc(now),
        # Keep the workbook's Last-Modified so the next conditional GET still works.
        "last_modified": existing.get("last_modified") if existing else None,
        "release_date": existing.get("release_date") if existing else None,
        "next_release_date": existing.get("next_release_date") if existing else None,
        "weeks": merged,
    }
    try:
        changed = store.write_doc("eia-diesel-weekly", path, doc, v)
    except store.SchemaError as e:
        warnings.append(f"usda data failed validation: {e}")
        return EiaResult("error", warnings=warnings, newest_period=_newest(existing))
    return EiaResult("fallback", changed=changed, newest_period=merged[-1]["period"], warnings=warnings)


def _newest(doc: dict | None) -> str | None:
    if not doc or not doc.get("weeks"):
        return None
    return doc["weeks"][-1]["period"]
