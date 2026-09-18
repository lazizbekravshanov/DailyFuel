"""State diesel excise tax, from FHWA Highway Statistics table MF-121T.

This is not part of the daily job. Tax rates move about once a year, so
scripts/update_taxes.py is run by hand when FHWA posts a new reporting period.

The workbook is a .xlsx, so it needs openpyxl, not the xlrd the EIA workbook
uses. Three things in FHWA's own sheet will bite a naive reader:

  1. Massachusetts and Utah are stored in DOLLARS (0.24, 0.31) while every
     other state is in CENTS. No state charges under 1.5 cents a gallon, so a
     value under that is read as dollars and multiplied by 100.
  2. Sheet MF121TP3 holds sales tax PERCENTAGES in its fifth column. Columns
     here are found by the machine header names on sheet MF121TP1
     ("DieselRate"), never by position, and no other sheet is read for rates.
  3. FHWA's footnotes on sheet MF121TP2 are old. Every one is dated 1/1/2002,
     and several describe taxes states have since repealed or rewritten. So a
     footnote is never repeated on the site just because FHWA still prints it.
     The few state notes in NOTES were each checked against the state's own
     law or tax agency (sources beside each one), and the run stops when the
     reporting period moves past NOTES_CHECKED_FOR until someone checks them
     again.

FHWA's figure can also be stale. Utah's 2024 row still holds its January 2021
rate although Utah resets the rate every January. OUT_OF_DATE marks those, so
the site shows them as out of date instead of ranking a wrong number.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from . import store
from .http import HttpClient, NetworkError
from .paths import TAXES, iso_utc
from .states import StateTable

URL_TEMPLATE = "https://www.fhwa.dot.gov/policyinformation/statistics/{year}/xls/mf121t.xlsx"
SOURCE = "FHWA Highway Statistics, table MF-121T"
SCHEMA_ID = "dailyfuel/state-diesel-tax/1"

RATES_SHEET = "MF121TP1"
FOOTNOTES_SHEET = "MF121TP2"

# Machine header names on the rates sheet. FHWA puts them in a hidden row under
# the human headings, which is the only place column order is spelled out.
STATE_HEADER = "State"
RATE_HEADER = "DieselRate"
DATE_HEADER = "DieselEffDate"
COMMENTS_HEADER = "Comments"
ROWNUM_HEADER = "RowNum"

# Row labels on the rates sheet that are not one of the 51 jurisdictions.
FEDERAL_LABEL = "Federal Tax"
IGNORED_LABELS = frozenset({"Puerto Rico"})

# The sheet writes DC short. Everything else matches src/data/states.json.
NAME_ALIASES = {"DC": "District of Columbia"}

# Cents per gallon. The lowest real rate in the table is Alaska at 8 and the
# highest is Pennsylvania at 74.1, so this band is wide enough to survive a few
# years of increases and still catch a column read from the wrong place.
MIN_CPG = Decimal("5")
MAX_CPG = Decimal("100")
# Under this, the cell is dollars per gallon rather than cents.
DOLLARS_CUTOFF = Decimal("1.5")
CPG_STEP = Decimal("0.001")
# A rate that moves more than this against the file on disk stops the run
# until someone confirms it with --allow-big-moves. Real yearly changes are a
# few cents; a sales tax percentage or a dollars cell read as cents is not.
BIG_MOVE_CPG = Decimal("10")

# An effective date cell of "-" means FHWA has no per gallon rate to show.
NO_RATE_DATES = frozenset({"-", "", "--"})

_MDY = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2,4})")

# State notes, in DailyFuel's own words. Each one was checked against the
# state's own law or tax agency, not just FHWA's footnote, because FHWA's
# footnotes are all dated 1/1/2002 and several are wrong today (Indiana's
# motor carrier surcharge was repealed in 2018, Vermont has no 26 cent heavy
# vehicle rate, New Jersey's gross receipts tax is already inside its rate).
# Each note also keeps the phrase from FHWA's footnote it matches, so a note
# goes away loudly if FHWA drops the footnote.
#
# Checked in September 2026 for the 2024 reporting period:
#   AZ  A.R.S. 28-5606, azleg.gov/ars/28/05606.htm: use class 26 cents,
#       light class the gasoline rate of 18 cents.
#   KY  KRS 138.660(2), apps.legislature.ky.gov: motor carrier surtax of 4.7
#       percent of the average wholesale price on special fuels.
#   OR  ODOT Fuels Tax, oregon.gov/odot/FTG/Pages/Use-Fuel.aspx: vehicles over
#       26,000 pounds pay weight mile tax and are exempt from use fuel tax.
NOTES_CHECKED_FOR = "2024"
NOTES: dict[str, tuple[str, str]] = {
    "AZ": (
        "Arizona's rate here is the truck rate. It applies to trucks with more than two axles "
        "or over 26,000 pounds. Lighter vehicles pay 18 cents.",
        "26 cents per gallon if used to propel a truck",
    ),
    "KY": (
        "Motor carriers in Kentucky also pay a surtax on diesel of 4.7 percent of the average "
        "wholesale price.",
        "4.7 percent on special fuels",
    ),
    "OR": (
        "Trucks over 26,000 pounds pay Oregon's weight mile tax instead of this per gallon tax. "
        "It's for everyone else.",
        "exempt from payment of the motor-fuel tax",
    ),
}

# Rates FHWA still prints but that are known to be out of date, keyed by the
# effective date and rate FHWA shows. The site shows these as out of date and
# leaves them out of the ranking. If FHWA's row changes at all, the run stops
# so someone can check the new figure and take the state off this list.
#   UT  tax.utah.gov/fuel/rates: special fuel 31.4 cents in 2021, 36.5 from
#       January 2024, 38.5 in 2025, 37.9 in 2026. FHWA's 2024 row still has
#       0.31 dollars effective 01/01/21.
OUT_OF_DATE: dict[str, tuple[str, Decimal, str]] = {
    "UT": (
        "2021-01-01",
        Decimal("31"),
        "Utah resets its diesel tax every January, but FHWA's table still has Utah's rate from "
        "January 2021. That's out of date, so it isn't shown or ranked here. The Utah State Tax "
        "Commission posts the current rate.",
    ),
    # Minnesota indexes its rate every January since 2023. Its Department of
    # Revenue lists 32.6 cents on diesel from Jan 1, 2026 (29.1 excise plus a
    # 3.5 cent surcharge), checked 2026-09-18 at
    # revenue.state.mn.us/petroleum-tax-fuel-excise-tax-rates-and-fees.
    "MN": (
        "2012-07-01",
        Decimal("28.5"),
        "Minnesota has adjusted its diesel tax every January since 2023, but FHWA's table still "
        "has Minnesota's rate from July 2012. That's out of date, so it isn't shown or ranked "
        "here. The Minnesota Department of Revenue posts the current rate.",
    ),
}

# FHWA's footnote (1) says what the table leaves out. Every state page carries
# this line, so it's anchored the same way the state notes are. It doesn't
# repeat FHWA's claim that taxes on all petroleum products are left out,
# because New Jersey's and Connecticut's rates already include theirs. Local
# fuel taxes aren't in the table either: every Florida county adds 7 cents on
# diesel, for one.
SCOPE_NOTE = (
    "This counts state taxes charged by the gallon. Sales taxes, local fuel taxes and some other "
    "state taxes on fuel aren't in it, so what you pay can be more.",
    "Only taxes that are levied as a dollar amount per volume of motor fuel are included",
)

# Written when FHWA publishes no per gallon diesel rate for a jurisdiction.
# In the 2024 sheet that is DC, whose diesel cell is 0 with no effective date.
# DC does tax diesel, so the note must not read as "no tax".
NO_RATE_NOTE = (
    "FHWA's table has no diesel rate for {name}. That doesn't mean there's no tax on diesel "
    "there, only that this table doesn't show one."
)

# Names that need an article to read right in a sentence.
IN_SENTENCE = {"District of Columbia": "the District of Columbia"}


class TaxParseError(ValueError):
    """The workbook didn't look like MF-121T. Nothing was written."""


@dataclass
class TaxTable:
    reporting_period: str
    published: str
    states: dict[str, Decimal | None]
    federal: Decimal
    notes: dict[str, str]
    # What the table counts and what it leaves out, one line for every page.
    scope: str
    # The day each state's rate took effect, as FHWA has it. None with no rate.
    effective: dict[str, str | None] = field(default_factory=dict)
    # Codes whose FHWA figure is known to be out of date (see OUT_OF_DATE).
    out_of_date: list[str] = field(default_factory=list)
    # Codes whose cell was stored in dollars and multiplied by 100.
    dollars: list[str] = field(default_factory=list)


@dataclass
class TaxResult:
    status: str  # ok | unchanged | error
    changed: bool = False
    table: TaxTable | None = None
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- cells


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def _iso_date(value, latest_year: int | None = None) -> str | None:
    """FHWA writes '10/16/2025'. Some years hand back a real date cell instead.

    Effective dates use two digit years going back to 1990 ('07/01/90'), so a
    two digit year that would land after latest_year belongs to the 1900s.
    """
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    m = _MDY.fullmatch(_text(value))
    if not m:
        return None
    mo, d, y = (int(p) for p in m.groups())
    if y < 100:
        y += 2000
        if latest_year is not None and y > latest_year:
            y -= 100
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _rate(raw, code: str) -> Decimal:
    """One diesel rate as written in the cell, not yet rounded.

    The caller rounds to CPG_STEP after the dollars trap, so a dollars cell
    like 0.0625 becomes 6.25 cents rather than 0.063 dollars and then 6.3.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float, Decimal, str)):
        raise TaxParseError(f"{code} has a diesel rate that is not a number: {raw!r}")
    try:
        return store.dec(raw)
    except Exception as e:
        raise TaxParseError(f"{code} has a diesel rate that is not a number: {raw!r}") from e


def _cents(value: Decimal) -> Decimal:
    return value.quantize(CPG_STEP, rounding=ROUND_HALF_UP)


def _in_band(value: Decimal, what: str) -> Decimal:
    if not (MIN_CPG <= value <= MAX_CPG):
        raise TaxParseError(f"{what} rate {value} is outside [{MIN_CPG}, {MAX_CPG}] cents per gallon")
    return value


# ---------------------------------------------------------------- sheet reading


def _rows(sheet) -> list[list]:
    return [list(row) for row in sheet.iter_rows(values_only=True)]


def _sheet(book, name: str):
    if name not in book.sheetnames:
        raise TaxParseError(f"no '{name}' sheet, so this isn't table MF-121T (sheets: {book.sheetnames})")
    return book[name]


def _header_row(rows: list[list], required: tuple[str, ...], sheet_name: str) -> tuple[int, dict[str, int]]:
    """Find the row that names the columns, and map each name to its index.

    Positions are never assumed. MF121TP3's fifth column is a sales tax
    percentage, and this is what keeps it from ever being read as a rate.
    A name that appears twice in the row (the footnotes sheet has RowNum at
    both ends) maps to its first column.
    """
    for r, row in enumerate(rows):
        labels: dict[str, int] = {}
        for c, cell in enumerate(row):
            if _text(cell):
                labels.setdefault(_text(cell), c)
        if all(name in labels for name in required):
            return r, labels
    raise TaxParseError(f"no header row on '{sheet_name}' with {', '.join(required)}")


def _squash(text: str) -> str:
    """Lowercase with runs of whitespace as one space, for phrase matching."""
    return re.sub(r"\s+", " ", text).strip().lower()


def _meta(rows: list[list], label: str) -> str:
    """Read the value under a label cell, the way FHWA lays out CurrDate and CurrYear."""
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            if _text(cell) == label:
                below = rows[r + 1][c] if r + 1 < len(rows) and c < len(rows[r + 1]) else None
                if _text(below):
                    return _text(below)
    raise TaxParseError(f"no value under '{label}' on '{RATES_SHEET}'")


def footnotes(book) -> dict[str, str]:
    """State name to the footnote text FHWA prints for it, continuation lines joined.

    Only numbered rows (a digit in the RowNum column) are footnote lines. The
    sheet repeats its title and header block partway down as a page break,
    sometimes in the middle of one state's footnote (New Hampshire in 2024),
    so those unnumbered rows are skipped rather than allowed to end it.
    """
    rows = _rows(_sheet(book, FOOTNOTES_SHEET))
    _, labels = _header_row(rows, (ROWNUM_HEADER, STATE_HEADER, COMMENTS_HEADER), FOOTNOTES_SHEET)
    num_col, name_col, text_col = labels[ROWNUM_HEADER], labels[STATE_HEADER], labels[COMMENTS_HEADER]
    out: dict[str, list[str]] = {}
    current: str | None = None
    for row in rows:
        num = _text(row[num_col]) if num_col < len(row) else ""
        if not num.isdigit():
            continue
        name = _text(row[name_col]) if name_col < len(row) else ""
        text = _text(row[text_col]) if text_col < len(row) else ""
        if name:
            current = name
            out.setdefault(current, [])
        if current and text:
            out[current].append(text)
    return {name: " ".join(parts) for name, parts in out.items() if parts}


def sheet_text(book, name: str) -> str:
    """Every text cell on a sheet, in reading order, as one squashed string."""
    parts = [cell for row in _rows(_sheet(book, name)) for cell in row if isinstance(cell, str) and cell.strip()]
    return _squash(" ".join(parts))


def parse_book(book, states: StateTable, year: str | None = None) -> TaxTable:
    """Read an opened .xlsx workbook. Raises TaxParseError on anything unexpected."""
    rows = _rows(_sheet(book, RATES_SHEET))
    header, labels = _header_row(rows, (STATE_HEADER, RATE_HEADER, DATE_HEADER), RATES_SHEET)
    name_col, rate_col, date_col = labels[STATE_HEADER], labels[RATE_HEADER], labels[DATE_HEADER]

    reporting_period = _meta(rows, "CurrYear")
    if not re.fullmatch(r"[0-9]{4}", reporting_period):
        raise TaxParseError(f"reporting period {reporting_period!r} is not a 4 digit year")
    if year is not None and reporting_period != year:
        raise TaxParseError(f"asked for {year} but the workbook says its reporting period is {reporting_period}")
    published = _iso_date(_meta(rows, "CurrDate"))
    if published is None:
        raise TaxParseError("CurrDate on the rates sheet is not a date FHWA usually writes")

    by_name = {s.name: s.code for s in states.states}
    found: dict[str, Decimal | None] = {}
    effective: dict[str, str | None] = {}
    dollars: list[str] = []
    no_rate: list[str] = []
    federal: Decimal | None = None
    unknown: list[str] = []

    for row in rows[header + 1 :]:
        name = _text(row[name_col]) if name_col < len(row) else ""
        if not name:
            continue
        name = NAME_ALIASES.get(name, name)
        if name in IGNORED_LABELS:
            continue
        raw = row[rate_col] if rate_col < len(row) else None
        eff = _text(row[date_col]) if date_col < len(row) else ""
        if name == FEDERAL_LABEL:
            if federal is not None:
                raise TaxParseError(f"'{FEDERAL_LABEL}' appears twice on '{RATES_SHEET}'")
            federal = _in_band(_cents(_rate(raw, FEDERAL_LABEL)), FEDERAL_LABEL)
            continue
        code = by_name.get(name)
        if code is None:
            unknown.append(name)
            continue
        if code in found:
            raise TaxParseError(f"{name} appears twice on '{RATES_SHEET}'")
        if raw is None:
            raise TaxParseError(f"{name} has an empty diesel rate cell")
        value = _rate(raw, code)
        if value < 0:
            raise TaxParseError(f"{name} has a negative diesel rate {value}")
        if value == 0:
            # A zero rate with no effective date is FHWA saying it has nothing
            # to publish, the same way it writes LPG for states that charge an
            # annual fee instead. A zero with a real date would be a new fact
            # and is not something to guess at.
            if eff not in NO_RATE_DATES:
                raise TaxParseError(f"{name} has a diesel rate of 0 effective {eff}")
            found[code] = None
            effective[code] = None
            no_rate.append(code)
            continue
        since = _iso_date(row[date_col] if date_col < len(row) else None, int(published[:4]))
        if since is None:
            raise TaxParseError(f"{name} has a diesel effective date FHWA doesn't usually write: {eff!r}")
        if since > published:
            raise TaxParseError(f"{name} has a diesel effective date {since} after the table was made ({published})")
        effective[code] = since
        if value < DOLLARS_CUTOFF:
            value = _in_band(_cents(value * 100), name)
            dollars.append(code)
        else:
            value = _in_band(_cents(value), name)
        found[code] = value

    if unknown:
        raise TaxParseError(f"'{RATES_SHEET}' has rows this build doesn't know: {', '.join(sorted(unknown))}")
    missing = [s.code for s in states.states if s.code not in found]
    if missing:
        raise TaxParseError(f"'{RATES_SHEET}' is missing {len(missing)} of the 51: {', '.join(missing)}")
    if federal is None:
        raise TaxParseError(f"'{RATES_SHEET}' has no '{FEDERAL_LABEL}' row")

    text = footnotes(book)
    # The sheet writes DC short in the footnotes too.
    for short, long in NAME_ALIASES.items():
        if short in text and long not in text:
            text[long] = text.pop(short)

    # Hand written facts are only as good as the day they were checked. A new
    # reporting period means checking them again against the states.
    if (NOTES or OUT_OF_DATE) and reporting_period != NOTES_CHECKED_FOR:
        raise TaxParseError(
            f"the state notes and OUT_OF_DATE were checked against state sources for "
            f"{NOTES_CHECKED_FOR}, not {reporting_period}. Check each one again, then set "
            f"NOTES_CHECKED_FOR to {reporting_period}."
        )

    out_of_date: list[str] = []
    for code, (since, cents, _) in OUT_OF_DATE.items():
        if found.get(code) != cents or effective.get(code) != since:
            raise TaxParseError(
                f"FHWA now has {found.get(code)} cents effective {effective.get(code)} for {code}, not the "
                f"out of date {cents} effective {since}. Check it against the state and update OUT_OF_DATE."
            )
        out_of_date.append(code)

    notes: dict[str, str] = {}
    for s in states.states:
        name = IN_SENTENCE.get(s.name, s.name)
        got = text.get(s.name, "")
        parts: list[str] = []
        if s.code in no_rate:
            parts.append(NO_RATE_NOTE.format(name=name))
        if s.code in OUT_OF_DATE:
            parts.append(OUT_OF_DATE[s.code][2])
        if s.code in NOTES:
            note, anchor = NOTES[s.code]
            if _squash(anchor) not in _squash(got):
                raise TaxParseError(
                    f"the {s.name} note is written from \"{anchor}\", which is not in FHWA's "
                    f"{reporting_period} footnote any more. Check the state's own rules and rewrite the note."
                )
            parts.append(note)
        if parts:
            notes[s.code] = " ".join(parts)

    scope, anchor = SCOPE_NOTE
    if _squash(anchor) not in sheet_text(book, FOOTNOTES_SHEET):
        raise TaxParseError(
            f"the line about what the table counts is written from \"{anchor}\", which is not on "
            f"'{FOOTNOTES_SHEET}' any more. Reread FHWA's footnote (1) and rewrite SCOPE_NOTE."
        )

    return TaxTable(
        reporting_period=reporting_period,
        published=published,
        states={s.code: found[s.code] for s in states.states},
        federal=federal,
        notes=notes,
        scope=scope,
        effective={s.code: effective[s.code] for s in states.states},
        out_of_date=[s.code for s in states.states if s.code in out_of_date],
        dollars=dollars,
    )


def parse_workbook(body: bytes, states: StateTable, year: str | None = None) -> TaxTable:
    try:
        import openpyxl
    except ImportError as e:  # pragma: no cover - the lock file installs it
        raise TaxParseError(
            "openpyxl is needed to read MF-121T. Install scripts/requirements-dev.lock."
        ) from e
    if not body[:2] == b"PK":
        raise TaxParseError("the download is not a .xlsx file (no zip header). FHWA may have moved it.")
    try:
        book = openpyxl.load_workbook(io.BytesIO(body), data_only=True, read_only=False)
    except Exception as e:
        raise TaxParseError(f"openpyxl couldn't open the workbook: {type(e).__name__}: {e}") from e
    try:
        return parse_book(book, states, year)
    finally:
        book.close()


# ---------------------------------------------------------------- document


def build_doc(table: TaxTable, url: str, now: datetime) -> dict:
    return {
        "schema": SCHEMA_ID,
        "source": SOURCE,
        "source_url": url,
        "reporting_period": table.reporting_period,
        "published": table.published,
        "fetched_at": iso_utc(now),
        "federal_cpg": store.num(table.federal),
        "states": {code: (None if v is None else store.num(v)) for code, v in table.states.items()},
        "effective": dict(table.effective),
        "out_of_date": list(table.out_of_date),
        "notes": dict(table.notes),
        "scope": table.scope,
    }


def _content(doc: dict | None) -> dict | None:
    if doc is None:
        return None
    return {k: v for k, v in doc.items() if k != "fetched_at"}


def load(data_dir: Path, v: store.Validators | None = None) -> dict | None:
    path = Path(data_dir) / TAXES
    if not path.exists():
        return None
    doc = store.read_json(path)
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA_ID:
        return None
    (v or store.validators()).validate("state-diesel-tax", doc)
    return doc


def big_moves(on_disk: dict | None, table: TaxTable) -> list[str]:
    """Rates that moved more than BIG_MOVE_CPG against the file on disk.

    Only a number against a number counts. A state gaining or losing a rate
    shows up in the warnings instead.
    """
    if not isinstance(on_disk, dict):
        return []
    old_states = on_disk.get("states") if isinstance(on_disk.get("states"), dict) else {}
    pairs = [(code, old_states.get(code), new) for code, new in table.states.items()]
    pairs.append(("federal", on_disk.get("federal_cpg"), table.federal))
    out = []
    for code, old, new in pairs:
        if isinstance(old, (int, float)) and not isinstance(old, bool) and new is not None:
            if abs(new - store.dec(old)) > BIG_MOVE_CPG:
                out.append(f"{code} {store.dec(old).normalize()} to {new.normalize()}")
    return out


def write(
    data_dir: Path,
    table: TaxTable,
    url: str,
    now: datetime,
    v: store.Validators | None = None,
    allow_big_moves: bool = False,
) -> TaxResult:
    """Validate and write the file, unless the numbers on disk already match.

    fetched_at is left out of the comparison, so a rerun on the same workbook
    is a no op and data/ stays byte identical. A rate that jumps more than
    BIG_MOVE_CPG stops the run unless allow_big_moves says it was checked.
    """
    doc = build_doc(table, url, now)
    warnings = []
    if table.dollars:
        warnings.append(f"rates stored in dollars, multiplied by 100: {', '.join(table.dollars)}")
    missing = [code for code, value in table.states.items() if value is None]
    if missing:
        warnings.append(f"no per gallon diesel rate published for: {', '.join(missing)}")
    # The file on disk is only compared, never trusted, so it isn't validated
    # here. One written under an older schema must not block writing its
    # replacement. The new doc is validated by write_doc before it lands.
    path = Path(data_dir) / TAXES
    try:
        on_disk = store.read_json(path) if path.exists() else None
    except ValueError:  # not JSON at all, so it gets replaced
        on_disk = None
    if isinstance(on_disk, dict) and _content(doc) == _content(on_disk):
        return TaxResult("unchanged", changed=False, table=table, warnings=warnings)
    moves = big_moves(on_disk, table)
    if moves and not allow_big_moves:
        raise TaxParseError(
            f"these rates moved more than {BIG_MOVE_CPG} cents since the file on disk: {', '.join(moves)}. "
            "If FHWA really has them, check them against the states and rerun with --allow-big-moves."
        )
    if moves:
        warnings.append(f"big moves, allowed: {', '.join(moves)}")
    changed = store.write_doc("state-diesel-tax", Path(data_dir) / TAXES, doc, v)
    return TaxResult("ok", changed=changed, table=table, warnings=warnings)


def update(
    data_dir: Path,
    http: HttpClient,
    now: datetime,
    states: StateTable,
    year: str,
    v: store.Validators | None = None,
    allow_big_moves: bool = False,
) -> TaxResult:
    """Fetch MF-121T for one reporting period and write data/taxes/state_diesel_tax.json."""
    url = URL_TEMPLATE.format(year=year)
    accept = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*"
    try:
        resp = http.get(url, headers={"Accept": accept}, timeout=60)
    except NetworkError as e:
        return TaxResult("error", warnings=[f"fhwa network error: {e}"])
    if resp.status != 200:
        return TaxResult("error", warnings=[f"fhwa HTTP {resp.status} for {url}"])
    return write(data_dir, parse_workbook(resp.body, states, year), url, now, v, allow_big_moves)
