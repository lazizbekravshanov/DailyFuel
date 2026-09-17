"""AAA daily state diesel averages. Built, but switched off by default.

Nothing in this module runs unless the pipeline decided AAA_ENABLED is exactly
"true". Parsers work on HTML strings, so tests feed them synthetic pages.

Only the 51 state diesel numbers and the 2 national diesel numbers are stored.
No other grades, no raw HTML.
"""

from __future__ import annotations

import gzip
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Callable

from bs4 import BeautifulSoup

from . import store
from .http import USER_AGENT, HttpClient, NetworkError, Response
from .paths import AAA_DAILY_DIR, iso_utc

ALL_STATES_URL = "https://gasprices.aaa.com/state-gas-price-averages/"
HOMEPAGE_URL = "https://gasprices.aaa.com/"
SCHEMA_ID = "dailyfuel/aaa-daily/1"

REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html",
    "Accept-Language": "en-US,en;q=0.8",
}
TIMEOUT = 30
RETRY_WAIT = 30
HOMEPAGE_WAIT = 15

MIN_PRICE = Decimal("1.50")
MAX_PRICE = Decimal("15.00")
LARGE_MOVE = Decimal("0.50")
PRICE_STEP = Decimal("0.0001")

BLOCK_STATUSES = (403, 429, 503)
BLOCK_MARKERS = ("Just a moment", "cf-chl")

_PRICE = re.compile(r"\$(\d{1,2}\.\d{2,4})")
_AS_OF = re.compile(r"Price as of\s*((\d{1,2})/(\d{1,2})/(\d{2}))")
_SNAPSHOT_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")


class Invalid(ValueError):
    """The page loaded but didn't parse or failed a blocking check."""


@dataclass
class Fetch:
    status: str  # ok | blocked | error
    html: str | None = None
    detail: str = ""


@dataclass
class AllStates:
    as_of: date
    as_of_raw: str
    diesel: dict[str, Decimal]


@dataclass
class National:
    as_of: date
    current: Decimal
    yesterday: Decimal


@dataclass
class AaaResult:
    status: str  # ok | noop | skipped | blocked | invalid | error
    changed: bool = False
    as_of: str | None = None
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- fetching


def decode_body(body: bytes) -> str:
    """Bodies are normally decompressed by requests, but a gzip body can still show up raw."""
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    return body.decode("utf-8", errors="replace")


def block_reason(resp: Response, text: str) -> str | None:
    if resp.status in BLOCK_STATUSES:
        return f"HTTP {resp.status}"
    if "cf-mitigated" in resp.headers:
        return f"cf-mitigated: {resp.headers.get('cf-mitigated')}"
    for marker in BLOCK_MARKERS:
        if marker in text:
            return f"body contains {marker!r}"
    # "challenge-platform" and "cdn-cgi" show up on normal pages, so they are not signals.
    return None


def fetch(http: HttpClient, url: str, sleep: Callable[[float], None]) -> Fetch:
    """One GET, plus one retry after 30 s for network errors and 5xx other than 503.

    Blocks are never retried.
    """
    last = ""
    for attempt in (1, 2):
        try:
            resp = http.get(url, headers=REQUEST_HEADERS, timeout=TIMEOUT)
        except NetworkError as e:
            last = f"network error: {e}"
            if attempt == 1:
                sleep(RETRY_WAIT)
                continue
            return Fetch("error", detail=last)
        try:
            text = decode_body(resp.body)
        except (OSError, EOFError) as e:
            text = ""
            decode_error = f"couldn't decompress body: {e}"
        else:
            decode_error = None
        reason = block_reason(resp, text)
        if reason:
            return Fetch("blocked", detail=reason)
        if 500 <= resp.status <= 599:
            last = f"HTTP {resp.status}"
            if attempt == 1:
                sleep(RETRY_WAIT)
                continue
            return Fetch("error", detail=last)
        if resp.status != 200:
            return Fetch("error", detail=f"HTTP {resp.status}")
        if decode_error:
            return Fetch("error", detail=decode_error)
        return Fetch("ok", html=text)
    return Fetch("error", detail=last)  # pragma: no cover


# ---------------------------------------------------------------- parsing


def _as_of(soup: BeautifulSoup) -> tuple[date, str]:
    matches = _AS_OF.findall(soup.get_text(" "))
    dates = {(int(mo), int(d), int(yy)) for _, mo, d, yy in matches}
    if len(dates) != 1:
        raise Invalid(f"expected one 'Price as of' date, found {sorted(dates)}")
    mo, d, yy = dates.pop()
    try:
        as_of = date(2000 + yy, mo, d)
    except ValueError as e:
        raise Invalid(f"bad 'Price as of' date {mo}/{d}/{yy}") from e
    return as_of, matches[0][0]


def parse_all_states(html: str) -> AllStates:
    s = BeautifulSoup(html, "html.parser")
    tbl = s.select_one("table#sortable")
    if tbl is None:
        raise Invalid("no table#sortable")
    hdr = [th.get_text(strip=True) for th in tbl.select("thead th")]
    if "Diesel" not in hdr:
        raise Invalid(f"headers {hdr}")
    rows: dict[str, Decimal] = {}
    for tr in tbl.select("tbody > tr"):
        a = tr.select_one("td a[href]")
        td = tr.select_one("td.diesel")
        m = re.search(r"state=([A-Z]{2})", a["href"]) if a else None
        v = _PRICE.fullmatch(td.get_text(strip=True)) if td else None
        if not (m and v):
            raise Invalid("bad row")
        if m.group(1) in rows:
            raise Invalid(f"duplicate code {m.group(1)}")
        rows[m.group(1)] = Decimal(v.group(1))
    as_of, raw = _as_of(s)
    return AllStates(as_of=as_of, as_of_raw=raw, diesel=rows)


def parse_homepage(html: str) -> National:
    s = BeautifulSoup(html, "html.parser")
    tbl = s.select_one("table.table-mob")
    if tbl is None:
        raise Invalid("no table.table-mob")
    hdr = [th.get_text(strip=True) for th in tbl.select("thead th")]
    if hdr.count("Diesel") != 1:
        raise Invalid(f"headers {hdr}")
    col = hdr.index("Diesel")
    found: dict[str, Decimal] = {}
    for tr in tbl.select("tbody tr"):
        cells = tr.find_all(["td", "th"], recursive=False)
        if not cells:
            continue
        label = cells[0].get_text(strip=True)
        if label not in ("Current Avg.", "Yesterday Avg."):
            continue
        if label in found:
            raise Invalid(f"row {label} appears twice")
        if col >= len(cells):
            raise Invalid(f"row {label} has no Diesel cell")
        v = _PRICE.fullmatch(cells[col].get_text(strip=True))
        if not v:
            raise Invalid(f"row {label} Diesel cell {cells[col].get_text(strip=True)!r}")
        found[label] = Decimal(v.group(1))
    if len(found) != 2:
        raise Invalid(f"found rows {sorted(found)}")
    as_of, _ = _as_of(s)
    for label, value in found.items():
        if not (MIN_PRICE <= value <= MAX_PRICE):
            raise Invalid(f"national {label} {value} out of range")
    return National(as_of=as_of, current=found["Current Avg."], yesterday=found["Yesterday Avg."])


# ---------------------------------------------------------------- validation


def validate(
    page: AllStates,
    codes: frozenset[str],
    today_et: date,
    prev_as_of: date | None,
    prev_diesel: dict[str, Decimal] | None,
) -> tuple[str, list[str]]:
    """Returns ("noop" | "ok", warnings) or raises Invalid for a blocking problem."""
    if len(page.diesel) != 51:
        raise Invalid(f"expected 51 rows, found {len(page.diesel)}")
    unknown = sorted(set(page.diesel) - codes)
    if unknown:
        raise Invalid(f"unknown codes {unknown}")
    for code, value in sorted(page.diesel.items()):
        if not (MIN_PRICE <= value <= MAX_PRICE):
            raise Invalid(f"{code} diesel {value} outside [{MIN_PRICE}, {MAX_PRICE}]")
    if page.as_of > today_et + timedelta(days=1):
        raise Invalid(f"as_of {page.as_of} is after {today_et + timedelta(days=1)}")
    if prev_as_of is not None and page.as_of < prev_as_of:
        raise Invalid(f"as_of {page.as_of} is older than stored {prev_as_of}")
    if prev_as_of is not None and page.as_of == prev_as_of:
        return "noop", []
    warnings: list[str] = []
    if prev_as_of is None or prev_diesel is None:
        warnings.append("prev_missing: no earlier AAA snapshot")
        return "ok", warnings
    if all(prev_diesel.get(c) == page.diesel[c] for c in page.diesel):
        raise Invalid(f"as_of moved to {page.as_of} but all 51 values equal {prev_as_of}")
    gap = (page.as_of - prev_as_of).days
    if gap > 1:
        warnings.append(f"gap: {gap} days since {prev_as_of}")
    for code in sorted(page.diesel):
        before = prev_diesel.get(code)
        if before is None:
            continue
        change = page.diesel[code] - before
        if abs(change) >= LARGE_MOVE:
            warnings.append(f"large_move: {code} {change:+.4f}")
    return "ok", warnings


# ---------------------------------------------------------------- storage


def snapshot_dates(data_dir: Path) -> list[date]:
    folder = Path(data_dir) / AAA_DAILY_DIR
    if not folder.is_dir():
        return []
    out = []
    for p in folder.iterdir():
        m = _SNAPSHOT_NAME.match(p.name)
        if m:
            out.append(date.fromisoformat(m.group(1)))
    return sorted(out)


def snapshot_path(data_dir: Path, as_of: date) -> Path:
    return Path(data_dir) / AAA_DAILY_DIR / f"{as_of.isoformat()}.json"


def load_snapshot(data_dir: Path, as_of: date) -> dict:
    doc = store.read_json(snapshot_path(data_dir, as_of))
    if doc.get("as_of") != as_of.isoformat():
        raise Invalid(f"snapshot file {as_of} says as_of {doc.get('as_of')}")
    return doc


def build_snapshot(
    page: AllStates,
    fetched_at: str,
    origin: str,
    national: National | None,
) -> dict:
    return {
        "schema": SCHEMA_ID,
        "as_of": page.as_of.isoformat(),
        "as_of_raw": page.as_of_raw,
        "fetched_at": fetched_at,
        "origin": origin,
        "source_url": ALL_STATES_URL,
        "national": None
        if national is None
        else {
            "current": store.num(national.current.quantize(PRICE_STEP, rounding=ROUND_HALF_UP)),
            "yesterday": store.num(national.yesterday.quantize(PRICE_STEP, rounding=ROUND_HALF_UP)),
        },
        "diesel": {code: store.num(page.diesel[code].quantize(PRICE_STEP, rounding=ROUND_HALF_UP)) for code in sorted(page.diesel)},
    }


def update(
    data_dir: Path,
    http: HttpClient,
    sleep: Callable[[float], None],
    now: datetime,
    today_et: date,
    codes: frozenset[str],
    v: store.Validators | None = None,
) -> AaaResult:
    """Fetch, validate and store one AAA snapshot. The caller decides whether AAA runs at all."""
    data_dir = Path(data_dir)
    got = fetch(http, ALL_STATES_URL, sleep)
    if got.status != "ok":
        return AaaResult(got.status, warnings=[f"aaa {got.status}: {got.detail}"])
    try:
        page = parse_all_states(got.html)
    except Invalid as e:
        return AaaResult("invalid", warnings=[f"aaa invalid: {e}"])

    dates = snapshot_dates(data_dir)
    prev_as_of = dates[-1] if dates else None
    prev_diesel = None
    if prev_as_of is not None:
        prev_doc = load_snapshot(data_dir, prev_as_of)
        prev_diesel = {c: store.dec(x) for c, x in prev_doc["diesel"].items()}
    try:
        outcome, warnings = validate(page, codes, today_et, prev_as_of, prev_diesel)
    except Invalid as e:
        return AaaResult("invalid", as_of=page.as_of.isoformat(), warnings=[f"aaa invalid: {e}"])
    if outcome == "noop":
        return AaaResult("noop", as_of=page.as_of.isoformat())

    path = snapshot_path(data_dir, page.as_of)
    fetched_at = iso_utc(now)
    doc = build_snapshot(page, fetched_at, "live", None)
    try:
        store.write_doc("aaa-daily", path, doc, v)
    except store.SchemaError as e:
        return AaaResult("invalid", as_of=page.as_of.isoformat(), warnings=[f"aaa invalid: {e}"])

    # National is optional. Nothing that happens here can undo the state data.
    sleep(HOMEPAGE_WAIT)
    national, note = _national(http, sleep, page.as_of)
    if note:
        warnings.append(note)
    if national is not None:
        with_national = build_snapshot(page, fetched_at, "live", national)
        try:
            store.write_doc("aaa-daily", path, with_national, v)
        except store.SchemaError as e:
            store.write_doc("aaa-daily", path, doc, v)
            warnings.append(f"national dropped: {e}")
    return AaaResult("ok", changed=True, as_of=page.as_of.isoformat(), warnings=warnings)


def _national(http: HttpClient, sleep: Callable[[float], None], as_of: date) -> tuple[National | None, str | None]:
    got = fetch(http, HOMEPAGE_URL, sleep)
    if got.status != "ok":
        return None, f"national {got.status}: {got.detail}"
    try:
        nat = parse_homepage(got.html)
    except Invalid as e:
        return None, f"national invalid: {e}"
    if nat.as_of != as_of:
        return None, f"national date {nat.as_of} doesn't match state date {as_of}"
    return nat, None
