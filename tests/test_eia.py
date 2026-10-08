"""EIA workbook parsing, merging, conditional GET and the USDA fallback."""

from __future__ import annotations

import json
from datetime import date, timedelta
from decimal import Decimal

import pytest

import synth
from dailyfuel import eia, store
from dailyfuel.http import Response
from dailyfuel.states import EIA_KEYS

MONDAYS = [date(2026, 8, 24) + timedelta(days=7 * i) for i in range(4)]  # 8/24 to 9/14


# ---------------------------------------------------------------- parse_book


def test_column_mapping_uses_sourcekey_not_position():
    order = list(reversed(EIA_KEYS))  # R5XCA first, NUS last

    def value(period, key):
        return 3.0 + EIA_KEYS.index(key) * 0.25

    book = synth.eia_book(MONDAYS, order=order, value=value)
    wb = eia.parse_book(book)
    for key in EIA_KEYS:
        assert wb.weeks[-1]["values"][key] == 3.0 + EIA_KEYS.index(key) * 0.25
    assert list(wb.weeks[-1]["values"]) == list(EIA_KEYS)


def test_missing_sourcekey_is_rejected():
    keys = [f"EMD_EPD2D_PTE_{k}_DPG" for k in EIA_KEYS[:-1]] + ["EMD_EPD2D_PTE_NUS_DPG"]
    with pytest.raises(eia.EiaParseError, match="appears twice|not the expected"):
        eia.parse_book(synth.eia_book(MONDAYS, sourcekeys=keys))


def test_unexpected_sourcekey_is_rejected():
    keys = [f"EMD_EPD2D_PTE_{k}_DPG" for k in EIA_KEYS[:-1]] + ["EMM_EPMR_PTE_NUS_DPG"]
    with pytest.raises(eia.EiaParseError, match="unexpected Sourcekey"):
        eia.parse_book(synth.eia_book(MONDAYS, sourcekeys=keys))


def test_missing_data_sheet_is_rejected():
    with pytest.raises(eia.EiaParseError, match="Data 1"):
        eia.parse_book(synth.FakeBook({"Contents": [[None]]}))


def test_date_must_be_a_monday():
    periods = MONDAYS[:-1] + [date(2026, 9, 15)]  # a Tuesday
    with pytest.raises(eia.EiaParseError, match="not a Monday"):
        eia.parse_book(synth.eia_book(periods))


def test_blank_cells_become_null():
    def value(period, key):
        if period == MONDAYS[1] and key == "R40":
            return None
        if period == MONDAYS[1] and key == "SCA":
            return "   "
        return 5.5

    wb = eia.parse_book(synth.eia_book(MONDAYS, value=value))
    week = next(w for w in wb.weeks if w["period"] == MONDAYS[1].isoformat())
    assert week["values"]["R40"] is None
    assert week["values"]["SCA"] is None
    assert week["values"]["NUS"] == 5.5


def test_rows_before_2022_06_13_are_dropped():
    periods = [date(2022, 5, 30), date(2022, 6, 6), date(2022, 6, 13), date(2022, 6, 20)]

    def value(period, key):
        # Old rows can hold prices below the floor and still be fine, since they're dropped.
        return 1.106 if period < date(2022, 6, 13) else 5.0

    wb = eia.parse_book(synth.eia_book(periods, value=value))
    assert [w["period"] for w in wb.weeks] == ["2022-06-13", "2022-06-20"]


@pytest.mark.parametrize("bad", [1.499, 15.001, 0.0])
def test_value_out_of_range_is_rejected(bad):
    def value(period, key):
        return bad if (period == MONDAYS[-1] and key == "R20") else 5.0

    with pytest.raises(eia.EiaParseError, match="outside"):
        eia.parse_book(synth.eia_book(MONDAYS, value=value))


def test_text_value_is_rejected():
    def value(period, key):
        return "NA" if (period == MONDAYS[-1] and key == "R20") else 5.0

    with pytest.raises(eia.EiaParseError, match="non number"):
        eia.parse_book(synth.eia_book(MONDAYS, value=value))


def test_duplicate_period_is_rejected():
    with pytest.raises(eia.EiaParseError, match="appears twice"):
        eia.parse_book(synth.eia_book(MONDAYS + [MONDAYS[-1]]))


def test_newest_week_needs_a_us_price():
    def value(period, key):
        return None if (period == MONDAYS[-1] and key == "NUS") else 5.0

    with pytest.raises(eia.EiaParseError, match="no U.S. price"):
        eia.parse_book(synth.eia_book(MONDAYS, value=value))


def test_release_dates_from_contents():
    wb = eia.parse_book(synth.eia_book(MONDAYS, release="9/15/2026", next_release="9/23/2026"))
    assert (wb.release_date, wb.next_release_date) == ("2026-09-15", "2026-09-23")


def test_missing_release_dates_are_null():
    wb = eia.parse_book(synth.eia_book(MONDAYS, release=None, next_release=None))
    assert (wb.release_date, wb.next_release_date) == (None, None)


def test_price_rounds_half_up_not_half_even():
    # Reachable through the USDA mirror, which sends prices as strings.
    # Half even would give 5.632 here and 5.634 for the next one.
    assert eia._price("5.6325") == Decimal("5.633")
    assert eia._price("5.6335") == Decimal("5.634")
    assert eia._price("5.6324") == Decimal("5.632")


def test_synthetic_xls_file_through_xlrd():
    wb = eia.parse_workbook(synth.xls_body())
    assert wb.weeks[0]["period"] == "2022-06-13"
    assert wb.weeks[-1]["period"] == "2026-09-14"
    assert (wb.release_date, wb.next_release_date) == ("2026-09-15", "2026-09-22")
    blank = next(w for w in wb.weeks if w["period"] == "2023-01-02")
    assert blank["values"]["R40"] is None
    periods = [w["period"] for w in wb.weeks]
    assert periods == sorted(set(periods))
    assert all(date.fromisoformat(p).weekday() == 0 for p in periods)


def test_garbage_bytes_are_a_parse_error():
    with pytest.raises(eia.EiaParseError, match="xlrd"):
        eia.parse_workbook(b"<html>Service temporarily unavailable</html>")


# ---------------------------------------------------------------- merge


def test_revisions_replace_same_period_and_stay_sorted():
    old = [
        {"period": "2026-08-31", "values": {k: 5.0 for k in EIA_KEYS}},
        {"period": "2026-09-07", "values": {k: 5.1 for k in EIA_KEYS}},
    ]
    new = [
        {"period": "2026-09-14", "values": {k: 5.3 for k in EIA_KEYS}},
        {"period": "2026-09-07", "values": {k: 5.15 for k in EIA_KEYS}},
    ]
    merged = eia.merge_weeks(old, new)
    assert [w["period"] for w in merged] == ["2026-08-31", "2026-09-07", "2026-09-14"]
    assert merged[1]["values"]["NUS"] == 5.15


# ---------------------------------------------------------------- update: conditional GET


def _seed(tmp_path, now, fake_http, validators):
    fake_http.set(eia.XLS_URL, synth.xls_server())
    result = eia.update(tmp_path, fake_http, now, validators)
    assert result.status == "ok"
    return tmp_path / "eia" / "diesel_weekly.json"


def test_first_fetch_writes_file_and_stores_last_modified(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    doc = json.loads(path.read_text())
    assert doc["source"] == "eia_xls"
    assert doc["last_modified"] == synth.XLS_LAST_MODIFIED
    assert doc["fetched_at"] == "2026-09-17T12:17:03Z"
    assert doc["release_date"] == "2026-09-15"
    assert "If-Modified-Since" not in fake_http.calls[0][1]
    validators.validate("eia-diesel-weekly", doc)


def test_304_path_sends_if_modified_since_and_writes_nothing(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    before = path.read_bytes()
    fake_http.calls.clear()
    result = eia.update(tmp_path, fake_http, now + timedelta(hours=3), validators)
    assert result.status == "not_modified"
    assert result.changed is False
    assert result.newest_period == "2026-09-14"
    _, headers = fake_http.calls[0]
    assert headers["If-Modified-Since"] == synth.XLS_LAST_MODIFIED
    assert "If-None-Match" not in headers
    assert path.read_bytes() == before


def test_200_with_same_data_is_unchanged_and_bumps_nothing(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    before = path.read_bytes()
    fake_http.set(eia.XLS_URL, synth.xls_server(last_modified="Wed, 16 Sep 2026 09:00:00 GMT"))
    result = eia.update(tmp_path, fake_http, now + timedelta(hours=3), validators)
    assert result.status == "unchanged"
    assert path.read_bytes() == before


def test_revision_in_workbook_replaces_stored_week(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    doc = json.loads(path.read_text())
    doc["weeks"][-1]["values"]["NUS"] = 9.999  # pretend we stored an older, unrevised value
    doc["last_modified"] = "Mon, 14 Sep 2026 00:00:00 GMT"
    store.write_doc("eia-diesel-weekly", path, doc, validators)
    result = eia.update(tmp_path, fake_http, now + timedelta(days=1), validators)
    assert result.status == "ok"
    fresh = json.loads(path.read_text())
    assert fresh["weeks"][-1]["values"]["NUS"] != 9.999
    assert fresh["last_modified"] == synth.XLS_LAST_MODIFIED
    assert fresh["fetched_at"] == "2026-09-18T12:17:03Z"


# ---------------------------------------------------------------- fallback


def _usda_two_weeks():
    return synth.usda_rows({date(2026, 9, 14): synth.usda_values("6.20"), date(2026, 9, 7): synth.usda_values("5.90")})


@pytest.mark.parametrize(
    "xls",
    [
        Response.make(200, b"<html>not a workbook</html>", url=eia.XLS_URL),
        Response.make(500, b"", url=eia.XLS_URL),
        synth.network_error(),
    ],
    ids=["garbage-200", "500", "network"],
)
def test_xls_failure_falls_back_to_usda(tmp_path, now, fake_http, validators, xls):
    path = _seed(tmp_path, now, fake_http, validators)
    stored = json.loads(path.read_text())
    fake_http.set(eia.XLS_URL, xls)
    fake_http.set(eia.USDA_URL, synth.usda_response(_usda_two_weeks()))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=1), validators)
    assert result.status == "fallback"
    assert result.changed is True
    assert result.warnings and result.warnings[0].startswith("eia_xls")
    doc = json.loads(path.read_text())
    assert doc["source"] == "usda_socrata"
    assert doc["release_date"] == stored["release_date"]
    assert doc["next_release_date"] == stored["next_release_date"]
    assert doc["last_modified"] == stored["last_modified"]
    assert doc["weeks"][-1] == {"period": "2026-09-14", "values": {k: float(v) for k, v in synth.usda_values("6.20").items()}}
    assert doc["weeks"][-2]["period"] == "2026-09-07"
    assert len(doc["weeks"]) == len(stored["weeks"])  # only the 2 newest weeks were replaced
    assert doc["weeks"][:-2] == stored["weeks"][:-2]


def _mirror_of(doc, **changes):
    """USDA rows for the 2 newest stored weeks, with the U.S. price of the named weeks changed."""
    weeks = {}
    for w in doc["weeks"][-2:]:
        values = {k: repr(v) for k, v in w["values"].items()}
        if w["period"] in changes:
            values["NUS"] = changes[w["period"]]
        weeks[date.fromisoformat(w["period"])] = values
    return synth.usda_response(synth.usda_rows(weeks))


def test_fallback_that_only_revises_an_older_week_keeps_the_newest_weeks_source(tmp_path, now, fake_http, validators):
    """usda_socrata means the backup is carrying the newest week, and here it isn't."""
    path = _seed(tmp_path, now, fake_http, validators)
    stored = json.loads(path.read_text())
    fake_http.set(eia.XLS_URL, Response.make(200, b"<html>down for maintenance</html>", url=eia.XLS_URL))
    fake_http.set(eia.USDA_URL, _mirror_of(stored, **{"2026-09-07": "4.999"}))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=1), validators)
    assert (result.status, result.changed) == ("fallback", True)
    doc = json.loads(path.read_text())
    assert doc["weeks"][-2]["values"]["NUS"] == 4.999
    assert doc["weeks"][-1] == stored["weeks"][-1]
    assert (doc["source"], doc["source_url"]) == ("eia_xls", eia.XLS_URL)
    assert (doc["release_date"], doc["last_modified"]) == (stored["release_date"], stored["last_modified"])

    # The workbook hasn't changed, so the conditional GET still applies.
    fake_http.set(eia.XLS_URL, synth.xls_server())
    fake_http.calls.clear()
    assert eia.update(tmp_path, fake_http, now + timedelta(days=2), validators).status == "not_modified"
    assert fake_http.calls[0][1]["If-Modified-Since"] == synth.XLS_LAST_MODIFIED

    # Once the backup carries the newest week, a revision of the older one keeps it marked as the backup's.
    fake_http.set(eia.XLS_URL, synth.network_error())
    fake_http.set(eia.USDA_URL, _mirror_of(doc, **{"2026-09-14": "6.111"}))
    assert eia.update(tmp_path, fake_http, now + timedelta(days=3), validators).status == "fallback"
    doc = json.loads(path.read_text())
    fake_http.set(eia.USDA_URL, _mirror_of(doc, **{"2026-09-07": "5.111"}))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=3, hours=3), validators)
    assert (result.status, result.changed) == ("fallback", True)
    assert json.loads(path.read_text())["source"] == "usda_socrata"


def test_workbook_is_fetched_whole_while_the_backup_has_the_newest_week(tmp_path, now, fake_http, validators):
    """A 304 would leave the backup's copy in place and the file marked as the backup's."""
    path = _seed(tmp_path, now, fake_http, validators)
    workbook = json.loads(path.read_text())
    fake_http.set(eia.XLS_URL, Response.make(200, b"<html>down for maintenance</html>", url=eia.XLS_URL))
    fake_http.set(eia.USDA_URL, synth.usda_response(_usda_two_weeks()))
    assert eia.update(tmp_path, fake_http, now + timedelta(hours=3), validators).status == "fallback"
    assert json.loads(path.read_text())["source"] == "usda_socrata"

    # Same workbook, same Last-Modified: it would have answered 304.
    fake_http.set(eia.XLS_URL, synth.xls_server())
    fake_http.calls.clear()
    result = eia.update(tmp_path, fake_http, now + timedelta(hours=6), validators)
    assert "If-Modified-Since" not in fake_http.calls[0][1]
    assert (result.status, result.changed) == ("ok", True)
    doc = json.loads(path.read_text())
    assert (doc["source"], doc["weeks"], doc["release_date"]) == ("eia_xls", workbook["weeks"], "2026-09-15")
    assert doc["last_modified"] == synth.XLS_LAST_MODIFIED

    # Back on the workbook, the conditional GET is too.
    fake_http.calls.clear()
    assert eia.update(tmp_path, fake_http, now + timedelta(hours=9), validators).status == "not_modified"
    assert fake_http.calls[0][1]["If-Modified-Since"] == synth.XLS_LAST_MODIFIED


def test_fallback_that_moves_the_week_forward_clears_the_release_dates(tmp_path, now, fake_http, validators):
    """The stored dates are the 9/14 week's. Kept with the 9/21 week, the footer would say it came out 9/15."""
    path = _seed(tmp_path, now, fake_http, validators)
    stored = json.loads(path.read_text())
    assert (stored["release_date"], stored["next_release_date"]) == ("2026-09-15", "2026-09-22")
    rows = synth.usda_rows({date(2026, 9, 21): synth.usda_values("6.30"), date(2026, 9, 14): synth.usda_values("6.20")})
    fake_http.set(eia.XLS_URL, Response.make(200, b"<html>down for maintenance</html>", url=eia.XLS_URL))
    fake_http.set(eia.USDA_URL, synth.usda_response(rows))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=5), validators)
    assert (result.status, result.changed, result.newest_period) == ("fallback", True, "2026-09-21")
    doc = json.loads(path.read_text())
    assert doc["weeks"][-1]["period"] == "2026-09-21"
    assert (doc["release_date"], doc["next_release_date"]) == (None, None)
    assert doc["last_modified"] == stored["last_modified"]
    cleared = "eia_release_date_cleared: the USDA mirror moved the newest week to 2026-09-21"
    assert any(w.startswith(cleared) for w in result.warnings)


def test_workbook_without_release_date_for_a_new_week_clears_the_stored_one(
    tmp_path, now, fake_http, validators, monkeypatch
):
    path = _seed(tmp_path, now, fake_http, validators)
    book = synth.eia_book(MONDAYS + [date(2026, 9, 21)], release=None, next_release=None)
    monkeypatch.setattr(eia, "parse_workbook", lambda body: eia.parse_book(book))
    fake_http.set(eia.XLS_URL, synth.xls_server(last_modified="Tue, 22 Sep 2026 15:00:00 GMT"))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=5), validators)
    assert result.status == "ok"
    doc = json.loads(path.read_text())
    assert doc["weeks"][-1]["period"] == "2026-09-21"
    assert (doc["release_date"], doc["next_release_date"]) == (None, None)
    assert not any("keeping" in w for w in result.warnings)
    assert any(w.startswith("eia_release_date_cleared: the workbook gave no release date") for w in result.warnings)


def test_workbook_behind_the_stored_week_lends_it_no_release_date(tmp_path, now, fake_http, validators, monkeypatch):
    """The backup already has 9/21. A workbook that stops at 9/14 dates the 9/14 week, not this one."""
    path = _seed(tmp_path, now, fake_http, validators)
    rows = synth.usda_rows({date(2026, 9, 21): synth.usda_values("6.30"), date(2026, 9, 14): synth.usda_values("6.20")})
    fake_http.set(eia.XLS_URL, synth.network_error())
    fake_http.set(eia.USDA_URL, synth.usda_response(rows))
    assert eia.update(tmp_path, fake_http, now + timedelta(days=5), validators).status == "fallback"

    fake_http.set(eia.XLS_URL, synth.xls_server(last_modified="Tue, 22 Sep 2026 15:00:00 GMT"))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=5, hours=3), validators)
    assert result.status == "ok"
    doc = json.loads(path.read_text())
    assert doc["source"] == "eia_xls"
    assert doc["weeks"][-1]["period"] == "2026-09-21"
    assert (doc["release_date"], doc["next_release_date"]) == (None, None)

    # Once the workbook has the week too, its dates are the week's dates.
    book = synth.eia_book(MONDAYS + [date(2026, 9, 21)], release="9/22/2026", next_release="9/29/2026")
    monkeypatch.setattr(eia, "parse_workbook", lambda body: eia.parse_book(book))
    fake_http.set(eia.XLS_URL, synth.xls_server(last_modified="Tue, 22 Sep 2026 18:00:00 GMT"))
    assert eia.update(tmp_path, fake_http, now + timedelta(days=5, hours=6), validators).status == "ok"
    doc = json.loads(path.read_text())
    assert (doc["release_date"], doc["next_release_date"]) == ("2026-09-22", "2026-09-29")


def test_fallback_on_empty_store(tmp_path, now, fake_http, validators):
    fake_http.set(eia.XLS_URL, Response.make(404, b"", url=eia.XLS_URL))
    fake_http.set(eia.USDA_URL, synth.usda_response(_usda_two_weeks()))
    result = eia.update(tmp_path, fake_http, now, validators)
    assert result.status == "fallback"
    doc = json.loads((tmp_path / "eia" / "diesel_weekly.json").read_text())
    assert [w["period"] for w in doc["weeks"]] == ["2026-09-07", "2026-09-14"]
    assert doc["release_date"] is None


def test_usda_region_mapping_assertion(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    before = path.read_bytes()
    newest = synth.usda_values("6.20")
    del newest["R40"]
    rows = synth.usda_rows({date(2026, 9, 14): newest, date(2026, 9, 7): synth.usda_values("5.90")})
    fake_http.set(eia.XLS_URL, Response.make(200, b"junk", url=eia.XLS_URL))
    fake_http.set(eia.USDA_URL, synth.usda_response(rows))
    result = eia.update(tmp_path, fake_http, now, validators)
    assert result.status == "error"
    assert any("missing ['R40']" in w for w in result.warnings)
    assert path.read_bytes() == before


def test_usda_unknown_region_name_is_error():
    rows = synth.usda_rows({date(2026, 9, 14): synth.usda_values("6.20")})
    rows.append(dict(rows[0], region="Rocky Mountain"))
    with pytest.raises(eia.EiaParseError, match="don't map"):
        eia.parse_usda(rows)


def test_usda_maps_all_11_regions():
    weeks = eia.parse_usda(_usda_two_weeks())
    assert [w["period"] for w in weeks] == ["2026-09-07", "2026-09-14"]
    assert set(weeks[-1]["values"]) == set(EIA_KEYS)
    assert set(eia.USDA_REGIONS.values()) == set(EIA_KEYS)


def test_usda_only_newest_two_weeks_merge():
    rows = synth.usda_rows(
        {
            date(2026, 9, 14): synth.usda_values("6.20"),
            date(2026, 9, 7): synth.usda_values("5.90"),
            date(2026, 8, 31): synth.usda_values("5.70"),
        }
    )
    assert [w["period"] for w in eia.parse_usda(rows)] == ["2026-09-07", "2026-09-14"]


def test_both_sources_fail_is_error(tmp_path, now, fake_http, validators):
    fake_http.set(eia.XLS_URL, synth.network_error())
    fake_http.set(eia.USDA_URL, Response.make(503, b"", url=eia.USDA_URL))
    result = eia.update(tmp_path, fake_http, now, validators)
    assert result.status == "error"
    assert not (tmp_path / "eia" / "diesel_weekly.json").exists()


def test_weekly_file_has_one_week_per_line(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    lines = path.read_text().splitlines()
    week_lines = [ln for ln in lines if ln.strip().startswith('{"period"')]
    doc = json.loads(path.read_text())
    assert len(week_lines) == len(doc["weeks"])
    for ln, week in zip(week_lines, doc["weeks"]):
        assert json.loads(ln.strip().rstrip(",")) == week


# ---------------------------------------------------------------- damaged inputs


def test_release_dates_survive_a_contents_sheet_that_stops_parsing(tmp_path, now, fake_http, validators, monkeypatch):
    """A renamed sheet or a reworded label must not blank the dated EIA acknowledgment."""
    path = _seed(tmp_path, now, fake_http, validators)
    before = path.read_bytes()
    assert json.loads(before)["release_date"] == "2026-09-15"

    real = eia.parse_workbook

    def blind(body):
        wb = real(body)
        wb.release_date = None
        wb.next_release_date = None
        return wb

    monkeypatch.setattr(eia, "parse_workbook", blind)
    fake_http.set(eia.XLS_URL, synth.xls_server(last_modified="Wed, 23 Sep 2026 09:00:00 GMT"))
    result = eia.update(tmp_path, fake_http, now + timedelta(days=1), validators)

    doc = json.loads(path.read_text())
    assert doc["release_date"] == "2026-09-15"
    assert doc["next_release_date"] == "2026-09-22"
    assert path.read_bytes() == before, "carrying the dates forward must not churn the file"
    assert result.status == "unchanged"
    assert any("eia_release_date_missing" in w for w in result.warnings)
    assert any("eia_next_release_date_missing" in w for w in result.warnings)


def test_damaged_stored_json_raises_instead_of_looking_empty(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    before = path.read_bytes()
    path.write_text(before.decode()[:400])
    with pytest.raises(eia.EiaDataError, match="not valid JSON"):
        eia.load(tmp_path, validators)
    assert path.read_bytes() == before[:400], "a damaged file is left alone, never refetched over"


def test_stored_json_that_fails_its_schema_raises(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    doc = json.loads(path.read_text())
    doc["weeks"] = doc["weeks"][:1]  # the schema needs 2
    path.write_text(json.dumps(doc))
    with pytest.raises(eia.EiaDataError, match="schema"):
        eia.load(tmp_path, validators)


def test_a_file_from_another_schema_version_reads_as_no_stored_data(tmp_path, now, fake_http, validators):
    path = _seed(tmp_path, now, fake_http, validators)
    doc = json.loads(path.read_text())
    doc["schema"] = "dailyfuel/eia-diesel-weekly/2"
    path.write_text(json.dumps(doc))
    assert eia.load(tmp_path, validators) is None
