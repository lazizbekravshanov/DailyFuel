"""Synthetic test inputs. Nothing in here comes from AAA or any real page.

The AAA builders copy only the page structure the parser relies on
(table#sortable, td.diesel, the two "Price as of" badges, and the homepage
table.table-mob with an E85 column). Every price is made up by a formula.
"""

from __future__ import annotations

import gzip
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import xlrd
from xlrd.biffh import XL_CELL_DATE, XL_CELL_EMPTY, XL_CELL_NUMBER, XL_CELL_TEXT
from xlrd.sheet import Cell

from dailyfuel import aaa, eia
from dailyfuel.http import NetworkError, Response
from dailyfuel.states import EIA_KEYS, load_states

FIXTURES = Path(__file__).resolve().parent / "fixtures"
EIA_XLS = FIXTURES / "eia_synthetic.xls"
XLS_LAST_MODIFIED = "Tue, 15 Sep 2026 22:28:31 GMT"

STATES = load_states()
CODES = [s.code for s in STATES.states]
NAMES = {s.code: s.name for s in STATES.states}


# ---------------------------------------------------------------- AAA pages


def _newest_synthetic_eia() -> dict[str, Decimal]:
    week = eia.parse_workbook(EIA_XLS.read_bytes()).weeks[-1]["values"]
    return {k: Decimal(repr(v)) for k, v in week.items()}


SYNTH_EIA_NEWEST = _newest_synthetic_eia()


def diesel_prices(day: int = 0) -> dict[str, Decimal]:
    """Made up diesel prices near the synthetic EIA region prices, so no state diverges.

    day shifts every price a little so different days never match.
    """
    out = {}
    for i, code in enumerate(sorted(CODES)):
        series = STATES.by_code(code).eia_series
        if series is None:
            base = SYNTH_EIA_NEWEST["NUS"] + (Decimal("1.1000") if code == "AK" else Decimal("1.6000"))
        else:
            base = SYNTH_EIA_NEWEST[series]
        offset = Decimal((i % 9) - 4) * Decimal("0.0310") + Decimal("0.0123")
        wiggle = Decimal(((i * 7 + day * 13) % 11) - 5) * Decimal("0.0042") * (1 if day else 0)
        out[code] = (base + offset + wiggle).quantize(Decimal("0.0001"))
    return out


def md(d: date) -> str:
    return f"{d.month}/{d.day}/{d.year % 100:02d}"


def all_states_html(
    prices: dict[str, str | Decimal] | None = None,
    as_of: date = date(2026, 9, 17),
    mobile_as_of: date | None = None,
    extra_head: str = "",
    extra_body: str = "",
    headers: tuple[str, ...] = ("State", "Regular", "Mid-Grade", "Premium", "Diesel"),
    order: list[str] | None = None,
    diesel_cell=None,
) -> str:
    prices = diesel_prices() if prices is None else prices
    codes = order if order is not None else sorted(prices)
    mobile = md(mobile_as_of or as_of)
    desktop = md(as_of)
    ths = "\n".join(f'                        <th tabindex="0">{h} <i class="fa fa-caret-down" aria-hidden="true"></i></th>' for h in headers)
    rows = []
    for code in codes:
        value = prices[code]
        cell = diesel_cell(code, value) if diesel_cell else f"${value}"
        rows.append(
            f"""                        <tr>
                            <td>
                              <a href="https://gasprices.aaa.com?state={code}">
                                {NAMES.get(code, code)}                              </a>
                            </td>
                            <td class="regular" style="display: table-cell;">$3.1234                            </td>
                            <td class="mid_grade">$3.5678                            </td>
                            <td class="premium">$3.9012                            </td>
                            <td class="diesel">{cell}                            </td>
                        </tr>"""
        )
    body_rows = "\n".join(rows)
    return f"""<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<title>Synthetic state averages test page</title>
{extra_head}
</head>
<body>
<main>
        <div class="mobi-average-price mobi-average-price--red">
    <p class="price-text price-text--red">
      National average $9.9999              <i class="fa fa-caret-up" aria-hidden="true"></i>
          </p>
    <p>Price as of {mobile}</p>
</div>
        <div class="map-box">
            <div class="container">
                <div class="map-badges">
                    <div class="average-price"><p>National<br />
average </p>
    <p class="numb">
      $9.9999              <i class="fa fa-caret-up" aria-hidden="true"></i>
          </p>
    <span>Price as of<br />{desktop}</span>
</div>
                </div>
            </div>
            <table id="sortable" class="sortable-table">
                <thead>
                    <tr>
{ths}
                    </tr>
                </thead>
                <tbody>
{body_rows}
                </tbody>
            </table>
        </div>
{extra_body}
</main>
</body>
</html>
"""


def homepage_html(
    current: str = "6.123",
    yesterday: str = "6.101",
    as_of: date = date(2026, 9, 17),
    columns: tuple[str, ...] = ("Regular", "Mid-Grade", "Premium", "Diesel", "E85"),
) -> str:
    def row(label: str, diesel: str) -> str:
        cells = []
        for col in columns:
            cells.append(f"<td>${diesel}</td>" if col == "Diesel" else "<td>$2.345</td>")
        return f"<tr>\n<td>{label}</td>\n" + "\n".join(cells) + "\n</tr>"

    ths = "\n".join(f"<th>{c}</th>" for c in columns)
    return f"""<!DOCTYPE html>
<html lang="en-US"><head><meta charset="UTF-8"><title>Synthetic homepage test page</title></head>
<body><main>
<div class="mobi-average-price"><p>Price as of {md(as_of)}</p></div>
<div class="average-price"><span>Price as of<br />{md(as_of)}</span></div>
<div class="tblwrap"><table class="table-mob">
<thead><tr>
<th></th>
{ths}
</tr></thead>
<tbody>
{row("Current Avg.", current)}
{row("Yesterday Avg.", yesterday)}
{row("Week Ago Avg.", "5.999")}
{row("Month Ago Avg.", "5.888")}
{row("Year Ago Avg.", "4.777")}
</tbody></table></div>
</main></body></html>
"""


def gz(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"), mtime=0)


# ---------------------------------------------------------------- fake HTTP


class FakeHttp:
    """Serves canned responses by URL and records every request."""

    def __init__(self):
        self.routes: dict[str, list] = {}
        self.calls: list[tuple[str, dict]] = []

    def add(self, url: str, *responses):
        self.routes.setdefault(url, []).extend(responses)
        return self

    def set(self, url: str, *responses):
        self.routes[url] = list(responses)
        return self

    def get(self, url, headers=None, timeout=30):
        self.calls.append((url, dict(headers or {})))
        if url not in self.routes or not self.routes[url]:
            raise AssertionError(f"unexpected request to {url}")
        queue = self.routes[url]
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return item(url, dict(headers or {}))
        return item

    def urls(self) -> list[str]:
        return [u for u, _ in self.calls]


def html_response(text: str | bytes, status: int = 200, headers=None, url: str = aaa.ALL_STATES_URL) -> Response:
    h = {"Content-Type": "text/html; charset=UTF-8"}
    h.update(headers or {})
    return Response.make(status, text, url=url, headers=h)


def xls_body() -> bytes:
    return EIA_XLS.read_bytes()


def xls_server(body: bytes | None = None, last_modified: str = XLS_LAST_MODIFIED):
    """A workbook endpoint that honours If-Modified-Since like EIA does."""
    payload = xls_body() if body is None else body

    def handler(url, headers):
        if headers.get("If-Modified-Since") == last_modified:
            return Response.make(304, b"", url=url, headers={"Last-Modified": last_modified})
        return Response.make(200, payload, url=url, headers={"Last-Modified": last_modified, "Content-Type": "application/vnd.ms-excel"})

    return handler


def network_error(msg: str = "connection reset") -> NetworkError:
    return NetworkError(msg)


# ---------------------------------------------------------------- USDA mirror


USDA_NAMES = {v: k for k, v in eia.USDA_REGIONS.items()}


def usda_rows(weeks: dict[date, dict[str, str]]) -> list[dict]:
    rows = []
    for period in sorted(weeks, reverse=True):
        for key, value in weeks[period].items():
            rows.append(
                {
                    "date": f"{period.isoformat()}T00:00:00.000",
                    "week": "37",
                    "month": str(period.month),
                    "year": str(period.year),
                    "region": USDA_NAMES.get(key, key),
                    "diesel_price": value,
                }
            )
    return rows


def usda_response(rows) -> Response:
    return Response.make(200, json.dumps(rows), url=eia.USDA_URL, headers={"Content-Type": "application/json"})


def usda_values(base: str) -> dict[str, str]:
    b = Decimal(base)
    return {k: str(b + Decimal(i) * Decimal("0.01")) for i, k in enumerate(EIA_KEYS)}


# ---------------------------------------------------------------- fake xlrd book


def excel_serial(d: date) -> float:
    return float((d - date(1899, 12, 30)).days)


def _cell(value) -> Cell:
    if value is None:
        return Cell(XL_CELL_EMPTY, "")
    if isinstance(value, date):
        return Cell(XL_CELL_DATE, excel_serial(value))
    if isinstance(value, (int, float)):
        return Cell(XL_CELL_NUMBER, float(value))
    return Cell(XL_CELL_TEXT, str(value))


class FakeSheet:
    def __init__(self, rows: list[list]):
        self._rows = rows
        self.nrows = len(rows)
        self.ncols = max((len(r) for r in rows), default=0)

    def row(self, r: int) -> list[Cell]:
        return [_cell(v) for v in self._rows[r]]


class FakeBook:
    datemode = 0

    def __init__(self, sheets: dict[str, list[list]]):
        self._sheets = {name: FakeSheet(rows) for name, rows in sheets.items()}

    def sheet_by_name(self, name: str) -> FakeSheet:
        if name not in self._sheets:
            raise xlrd.XLRDError(f"No sheet named <{name!r}>")
        return self._sheets[name]


def eia_book(
    periods: list[date],
    order: list[str] | None = None,
    value=None,
    release: str | None = "9/15/2026",
    next_release: str | None = "9/22/2026",
    sourcekeys: list[str] | None = None,
) -> FakeBook:
    """value(period, key) -> number, None for blank, or a string for a text cell."""
    order = list(order or EIA_KEYS)
    if value is None:
        def value(period, key):
            return round(5.0 + EIA_KEYS.index(key) * 0.1 + (period.toordinal() % 50) / 100, 3)
    keys = sourcekeys if sourcekeys is not None else [f"EMD_EPD2D_PTE_{k}_DPG" for k in order]
    rows = [
        ["Back to Contents", "Data 1: W Diesel Prices, All Types"],
        ["Sourcekey", *keys],
        ["Date", *[f"Weekly {k} (Dollars per Gallon)" for k in order]],
    ]
    for p in periods:
        rows.append([p, *[value(p, k) for k in order]])
    contents = [[None, "Workbook Contents"], [None, None]]
    if release is not None:
        contents.append([None, "Release Date:", release])
    if next_release is not None:
        contents.append([None, "Next Release Date:", next_release])
    return FakeBook({"Contents": contents, "Data 1": rows})
