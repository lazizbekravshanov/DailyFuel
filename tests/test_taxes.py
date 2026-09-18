"""FHWA MF-121T parsing, the traps in FHWA's own sheet, and the write path.

Every workbook here is built by tests/synth.py with openpyxl. No test touches
the network; tests/conftest.py blocks sockets.
"""

from __future__ import annotations

import io
import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest

import synth
from dailyfuel import store, taxes
from dailyfuel.http import NetworkError, Response
from dailyfuel.paths import TAXES

URL = taxes.URL_TEMPLATE.format(year="2024")


def parse(body=None, states=None, year="2024", **kwargs):
    from dailyfuel.states import load_states

    return taxes.parse_workbook(
        synth.tax_workbook(**kwargs) if body is None else body,
        states or load_states(),
        year,
    )


# ---------------------------------------------------------------- shape


def test_all_51_states_are_present_and_nothing_else(states):
    table = parse(states=states)
    assert list(table.states) == [s.code for s in states.states]
    assert len(table.states) == 51


def test_rates_come_from_the_named_column_not_a_position(states):
    # Diesel moved to the front and gasoline to the back. A parser reading the
    # third rate/date pair would hand back gasoline's 22 for every state.
    moved = ["State", "DieselRate", "DieselEffDate", "GasoholRate", "GasoholEffDate",
             "LiquefiedRate", "LiquefiedEffDate", "GasolineRate", "GasolineEffDate"]
    table = parse(states=states, headers=moved)
    assert table.states == parse(states=states).states
    assert table.states["AL"] != Decimal("22")


def test_federal_rate_is_read_and_kept_out_of_the_states(states):
    table = parse(states=states, federal=24.4)
    assert table.federal == Decimal("24.400")
    assert "Federal Tax" not in table.states
    assert all(code in states.codes for code in table.states)


def test_reporting_period_and_published_date(states):
    table = parse(states=states)
    assert table.reporting_period == "2024"
    assert table.published == "2025-10-16"


def test_puerto_rico_is_ignored(states):
    rates = synth.tax_rates()
    rates["Puerto Rico"] = 4
    table = parse(states=states, rates=rates)
    assert len(table.states) == 51


def test_dc_is_read_under_its_short_name(states):
    rates = {("DC" if name == "District of Columbia" else name): v for name, v in synth.tax_rates().items()}
    table = parse(states=states, rates=rates)
    assert table.states["DC"] == parse(states=states).states["DC"]


# ---------------------------------------------------------------- the dollars trap


def test_massachusetts_and_utah_are_stored_in_dollars(states):
    table = parse(states=states)
    # The sheet holds 0.24 and 0.31 for these two and cents for everyone else.
    assert table.states["MA"] == Decimal("24.000")
    assert table.states["UT"] == Decimal("31.000")
    assert table.dollars == ["MA", "UT"]


def test_a_cents_rate_is_never_multiplied(states):
    table = parse(states=states)
    assert table.dollars == ["MA", "UT"]
    assert table.states["AL"] == Decimal(str(synth.tax_rates()["Alabama"])).quantize(Decimal("0.001"))


def test_a_dollars_cell_is_rounded_after_it_becomes_cents(states):
    # 0.0625 dollars is 6.25 cents. Rounding the dollars first would make it 6.3.
    rates = synth.tax_rates()
    rates["Massachusetts"] = 0.0625
    assert parse(states=states, rates=rates).states["MA"] == Decimal("6.250")


def test_a_dollars_rate_that_converts_out_of_band_is_rejected(states):
    rates = synth.tax_rates()
    rates["Ohio"] = 0.004  # 0.4 cents a gallon, which no state charges
    with pytest.raises(taxes.TaxParseError, match="outside"):
        parse(states=states, rates=rates)


# ---------------------------------------------------------------- the percentage trap


def test_sales_tax_percentages_are_never_read_as_rates(states):
    # MF121TP3 column 5 holds percentages like 4, 5, 6.25. If the rates sheet
    # is gone, the run fails rather than quietly taking them.
    with pytest.raises(taxes.TaxParseError, match="MF121TP1"):
        parse(states=states, rates_sheet="MF121TP9")


def test_values_come_off_the_rates_sheet_while_the_percentage_sheet_is_there(states):
    # The percentage sheet lists the first 12 states with values in the 4 to 6.5
    # range, which is a legal looking cents figure. Every parsed rate has to be
    # the one on the rates sheet.
    # The rates here are 5 to 7 so each one differs from the percentage beside it.
    rates = {name: 5 + (i % 5) * 0.5 for i, name in enumerate(synth.tax_rates())}
    rates["Ohio"] = 47
    rates["Utah"] = 0.31  # the out of date rows have to stay what FHWA really has
    rates["Minnesota"] = 28.5
    table = parse(states=states, rates=rates, sales_sheet=True)
    for s in states.states:
        expected = Decimal("31") if s.code == "UT" else Decimal(str(rates[s.name]))
        assert table.states[s.code] == expected.quantize(Decimal("0.001"))
    assert table.states["OH"] == Decimal("47.000")


# ---------------------------------------------------------------- no rate published


def test_zero_with_no_effective_date_is_not_a_rate(states):
    rates = synth.tax_rates()
    rates["District of Columbia"] = 0
    table = parse(states=states, rates=rates, eff={"District of Columbia": "-"})
    assert table.states["DC"] is None
    assert table.effective["DC"] is None
    assert "District of Columbia" in table.notes["DC"]
    # DC does tax diesel. The note says the table is silent, not that the tax is zero.
    assert "has no diesel rate" in table.notes["DC"]
    assert "doesn't mean there's no tax" in table.notes["DC"]


def test_zero_with_a_real_effective_date_is_an_error(states):
    rates = synth.tax_rates()
    rates["Ohio"] = 0
    with pytest.raises(taxes.TaxParseError, match="rate of 0 effective"):
        parse(states=states, rates=rates, eff={"Ohio": "07/01/19"})


# ---------------------------------------------------------------- a changed sheet


def test_a_missing_rates_sheet_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="isn't table MF-121T"):
        parse(states=states, rates_sheet="Sheet1")


def test_a_renamed_header_fails_loudly(states):
    headers = ["State", "GasolineRate", "GasolineEffDate", "DslRate", "DslEffDate",
               "LiquefiedRate", "LiquefiedEffDate", "GasoholRate", "GasoholEffDate"]
    with pytest.raises(taxes.TaxParseError, match="no header row"):
        parse(states=states, headers=headers)


def test_a_missing_state_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="missing 1 of the 51: OH"):
        parse(states=states, drop_rows=frozenset({"Ohio"}))


def test_a_state_name_this_build_doesnt_know_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="doesn't know: Guam"):
        parse(states=states, extra_rows=[["Guam", 22, "01/01/24", 25, "01/01/24"]])


def test_a_duplicate_state_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="appears twice"):
        parse(states=states, extra_rows=[["Ohio", 22, "01/01/24", 25, "01/01/24"]])


def test_a_missing_federal_row_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="no 'Federal Tax' row"):
        parse(states=states, federal=None)


def test_a_rate_under_five_cents_fails_loudly(states):
    # Alaska's 8 is the lowest real rate. A 4 is a sales tax percentage or a typo.
    rates = synth.tax_rates()
    rates["Ohio"] = 4
    with pytest.raises(taxes.TaxParseError, match="outside"):
        parse(states=states, rates=rates)


def test_a_rate_out_of_band_fails_loudly(states):
    rates = synth.tax_rates()
    rates["Ohio"] = 470  # dollars per gallon by mistake, or a column moved
    with pytest.raises(taxes.TaxParseError, match="outside"):
        parse(states=states, rates=rates)


def test_a_text_rate_fails_loudly(states):
    rates = synth.tax_rates()
    rates["Ohio"] = "see note"
    with pytest.raises(taxes.TaxParseError, match="not a number"):
        parse(states=states, rates=rates)


def test_a_missing_reporting_period_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="no value under 'CurrYear'"):
        parse(states=states, curr_year=None)


def test_a_reporting_period_that_is_not_the_one_asked_for_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="asked for 2025"):
        parse(states=states, year="2025")


def test_an_unreadable_published_date_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="CurrDate"):
        parse(states=states, curr_date="soon")


def test_a_body_that_is_not_an_xlsx_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="not a .xlsx"):
        parse(body=b"<html>404</html>", states=states)


# ---------------------------------------------------------------- footnotes


def test_notes_are_carried_for_the_states_that_need_them(states):
    table = parse(states=states)
    assert set(table.notes) == set(taxes.NOTES) | set(taxes.OUT_OF_DATE)
    assert "26,000 pounds" in table.notes["AZ"]


def test_a_note_whose_footnote_is_gone_fails_loudly(states):
    footnotes = synth.tax_footnotes()
    del footnotes["Kentucky"]
    with pytest.raises(taxes.TaxParseError, match="Kentucky note is written from"):
        parse(states=states, footnotes=footnotes)


def test_a_note_whose_footnote_was_reworded_fails_loudly(states):
    footnotes = synth.tax_footnotes()
    footnotes["Arizona"] = ["The fuel tax on diesel is 27 cents per gallon for every vehicle."]
    with pytest.raises(taxes.TaxParseError, match="Arizona note is written from"):
        parse(states=states, footnotes=footnotes)


@pytest.mark.parametrize("code", ["IN", "VT", "NJ", "IL", "CT", "DE", "VA"])
def test_footnotes_found_wrong_or_unconfirmed_are_not_repeated(states, code):
    # Checked in September 2026 against the states: Indiana's motor carrier
    # surcharge is gone, Vermont has no 26 cent heavy rate, New Jersey's rate
    # already includes its gross receipts tax, Illinois' motor carrier extra is
    # 19.1 cents, not 6.5, Connecticut's rate already includes its gross
    # earnings part, and Virginia's 3.5 cents is now set by formula. Delaware's
    # 0.9 percent is covered by the scope line.
    assert code not in taxes.NOTES
    footnotes = synth.tax_footnotes()
    footnotes[states.by_code(code).name] = ["Motor carriers pay an additional 11 cents per gallon."]
    assert code not in parse(states=states, footnotes=footnotes).notes


def test_a_new_reporting_period_stops_until_the_notes_are_checked_again(states):
    with pytest.raises(taxes.TaxParseError, match="checked against state sources for 2024, not 2025"):
        parse(states=states, year="2025", curr_year="2025")


def test_a_new_reporting_period_passes_once_the_notes_are_checked(states, monkeypatch):
    monkeypatch.setattr(taxes, "NOTES_CHECKED_FOR", "2025")
    assert parse(states=states, year="2025", curr_year="2025").reporting_period == "2025"


def test_footnote_continuation_rows_are_joined(states):
    import openpyxl

    body = synth.tax_workbook(footnotes={"Ohio": ["first half", "second half"]})
    book = openpyxl.load_workbook(io.BytesIO(body), data_only=True)
    assert taxes.footnotes(book)["Ohio"] == "first half second half"


def test_a_page_break_inside_a_footnote_does_not_cut_it_short(states):
    # FHWA repeats its title and header rows partway down the footnotes sheet.
    # In 2024 that landed inside New Hampshire's footnote. The rows after the
    # break still belong to the same state.
    import openpyxl

    body = synth.tax_workbook(
        footnotes={"Ohio": ["first half", "second half"], "Utah": ["after"]},
        page_break_in="Ohio",
    )
    book = openpyxl.load_workbook(io.BytesIO(body), data_only=True)
    got = taxes.footnotes(book)
    assert got["Ohio"] == "first half second half"
    assert got["Utah"] == "after"
    assert not any("Footnotes B" in name or name == "State" for name in got)


def test_a_note_anchor_split_by_a_page_break_still_matches(states):
    # Arizona's anchor phrase is split over two rows by tax_footnotes().
    table = parse(states=states, page_break_in="Arizona")
    assert "26,000 pounds" in table.notes["AZ"]


def test_footnote_text_under_the_real_header_names_and_extra_rownum_column(states):
    # The real sheet has RowNum at both ends of each row. Only the first one
    # is read, and a row without a number is never a footnote line.
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = taxes.FOOTNOTES_SHEET
    ws.append([None, "RowNum", "State", "Date", "Comments", None, None, "RowNum"])
    ws.append([None, "1", "Ohio", "1/1/2002", "numbered line", None, None, "1"])
    ws.append([None, None, None, None, "unnumbered page furniture", None, None, None])
    ws.append(["", "2", None, "1/1/2002", "continued", None, "", "2"])
    got = taxes.footnotes(wb)
    assert got == {"Ohio": "numbered line continued"}


# ---------------------------------------------------------------- how old each rate is


def test_each_state_carries_its_effective_date(states):
    table = parse(states=states, eff={"Ohio": "07/01/19", "Kentucky": "10/01/24"})
    assert table.effective["OH"] == "2019-07-01"
    assert table.effective["KY"] == "2024-10-01"
    assert list(table.effective) == [s.code for s in states.states]


def test_a_two_digit_year_from_the_nineties_is_the_nineties(states):
    # FHWA writes Louisiana's rate as effective 01/01/90, not 2090.
    table = parse(states=states, eff={"Louisiana": "01/01/90", "Colorado": "01/01/93"})
    assert table.effective["LA"] == "1990-01-01"
    assert table.effective["CO"] == "1993-01-01"


def test_a_real_date_cell_is_read_too(states):
    table = parse(states=states, eff={"Ohio": datetime(2019, 7, 1)})
    assert table.effective["OH"] == "2019-07-01"


def test_an_unreadable_effective_date_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="Ohio has a diesel effective date"):
        parse(states=states, eff={"Ohio": "soon"})


def test_an_effective_date_after_the_table_was_made_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="after the table was made"):
        parse(states=states, eff={"Ohio": "01/01/2026"})


def test_a_variable_rate_footnote_adds_no_note(states):
    # FHWA says Maine and Wisconsin are "variable, adjusted annually", but both
    # stopped indexing years ago. Every panel says rates may have changed, so
    # no state gets a note on the footnote's word alone.
    footnotes = synth.tax_footnotes()
    footnotes["Wisconsin"] = ["Rates are variable, adjusted annually."]
    footnotes["Nebraska"] = ["Rates are variable, adjusted quarterly."]
    table = parse(states=states, footnotes=footnotes)
    assert "WI" not in table.notes and "NE" not in table.notes


# ---------------------------------------------------------------- rates FHWA has wrong


def test_utah_is_marked_out_of_date(states):
    table = parse(states=states)
    assert table.out_of_date == ["MN", "UT"]
    assert table.states["UT"] == Decimal("31.000")  # still FHWA's number, not ours
    assert table.effective["UT"] == "2021-01-01"
    assert "out of date" in table.notes["UT"]
    assert "Utah State Tax Commission" in table.notes["UT"]
    assert table.states["MN"] == Decimal("28.500")
    assert table.effective["MN"] == "2012-07-01"
    assert "Minnesota Department of Revenue" in table.notes["MN"]


def test_a_new_fhwa_rate_for_an_out_of_date_state_fails_loudly(states):
    # FHWA caught up. Someone has to check it and take Utah off the list.
    rates = synth.tax_rates()
    rates["Utah"] = 36.5
    with pytest.raises(taxes.TaxParseError, match="not the out of date 31 effective 2021-01-01"):
        parse(states=states, rates=rates, eff={"Utah": "01/01/24"})


def test_a_new_effective_date_alone_also_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="Check it against the state"):
        parse(states=states, eff={"Utah": "01/01/22"})


# ---------------------------------------------------------------- what the table counts


def test_the_scope_line_is_carried(states):
    table = parse(states=states)
    assert table.scope == taxes.SCOPE_NOTE[0]
    assert "by the gallon" in table.scope
    # Florida's counties add 7 cents on diesel, so the line has to say so.
    assert "local fuel taxes" in table.scope
    # New Jersey's and Connecticut's rates include their petroleum taxes, so
    # FHWA's "taxes on all petroleum products are omitted" isn't repeated.
    assert "petroleum" not in table.scope


def test_a_scope_line_whose_footnote_is_gone_fails_loudly(states):
    with pytest.raises(taxes.TaxParseError, match="footnote \\(1\\)"):
        parse(states=states, scope_line="(1) This table shows motor-fuel tax rates in effect as of January 1.")


def test_no_site_copy_uses_a_dash_as_punctuation():
    # PROMPT section 6.5. These strings end up on state pages.
    notes = [note for note, _ in taxes.NOTES.values()] + [note for _, _, note in taxes.OUT_OF_DATE.values()]
    for text in (*notes, taxes.NO_RATE_NOTE, taxes.SCOPE_NOTE[0]):
        assert "—" not in text and "–" not in text and " - " not in text, text


# ---------------------------------------------------------------- document and write


def test_document_matches_its_schema(states, validators, now):
    doc = taxes.build_doc(parse(states=states), URL, now)
    validators.validate("state-diesel-tax", doc)
    assert doc["schema"] == taxes.SCHEMA_ID
    assert doc["fetched_at"] == "2026-09-17T12:17:03Z"
    assert doc["federal_cpg"] == 24.4
    assert doc["scope"] == taxes.SCOPE_NOTE[0]
    assert doc["out_of_date"] == ["MN", "UT"]
    assert doc["effective"]["UT"] == "2021-01-01"


def test_document_keeps_states_json_order(states, now):
    doc = taxes.build_doc(parse(states=states), URL, now)
    assert list(doc["states"]) == [s.code for s in states.states]


def test_write_then_write_again_changes_nothing(tmp_path, states, validators, now):
    table = parse(states=states)
    first = taxes.write(tmp_path, table, URL, now, validators)
    assert first.status == "ok" and first.changed
    before = (tmp_path / TAXES).read_bytes()

    later = datetime(2026, 12, 25, 9, 0, 0, tzinfo=timezone.utc)
    second = taxes.write(tmp_path, parse(states=states), URL, later, validators)
    assert second.status == "unchanged" and not second.changed
    assert (tmp_path / TAXES).read_bytes() == before


def test_a_file_from_an_older_schema_is_replaced_not_a_crash(tmp_path, states, validators, now):
    # Comparing against what's on disk must not validate it. Otherwise a schema
    # change would leave the tool unable to write the file that fixes it.
    taxes.write(tmp_path, parse(states=states), URL, now, validators)
    path = tmp_path / TAXES
    old = json.loads(path.read_text())
    del old["scope"]
    path.write_text(json.dumps(old))
    result = taxes.write(tmp_path, parse(states=states), URL, now, validators)
    assert result.status == "ok" and result.changed
    validators.validate("state-diesel-tax", json.loads(path.read_text()))


def test_a_new_rate_rewrites_the_file(tmp_path, states, validators, now):
    taxes.write(tmp_path, parse(states=states), URL, now, validators)
    rates = synth.tax_rates()
    rates["Ohio"] = float(Decimal(str(rates["Ohio"])) + Decimal("1.5"))
    result = taxes.write(tmp_path, parse(states=states, rates=rates), URL, now, validators)
    assert result.status == "ok" and result.changed
    assert json.loads((tmp_path / TAXES).read_text())["states"]["OH"] == rates["Ohio"]


def test_a_big_move_against_the_file_on_disk_stops_the_run(tmp_path, states, validators, now):
    # Massachusetts read as 6.25 cents instead of 24 passes the band but not this.
    taxes.write(tmp_path, parse(states=states), URL, now, validators)
    before = (tmp_path / TAXES).read_bytes()
    rates = synth.tax_rates()
    rates["Massachusetts"] = 0.0625
    with pytest.raises(taxes.TaxParseError, match="MA 24 to 6.25"):
        taxes.write(tmp_path, parse(states=states, rates=rates), URL, now, validators)
    assert (tmp_path / TAXES).read_bytes() == before


def test_a_checked_big_move_is_written_when_allowed(tmp_path, states, validators, now):
    taxes.write(tmp_path, parse(states=states), URL, now, validators)
    rates = synth.tax_rates()
    rates["Ohio"] = float(Decimal(str(rates["Ohio"])) + 25)
    result = taxes.write(tmp_path, parse(states=states, rates=rates), URL, now, validators, allow_big_moves=True)
    assert result.changed
    assert any("big moves, allowed: OH" in w for w in result.warnings)


def test_a_small_move_needs_no_permission(tmp_path, states, validators, now):
    taxes.write(tmp_path, parse(states=states), URL, now, validators)
    rates = synth.tax_rates()
    rates["Ohio"] = float(Decimal(str(rates["Ohio"])) + Decimal("2.5"))
    assert taxes.write(tmp_path, parse(states=states, rates=rates), URL, now, validators).changed


def test_warnings_name_the_dollars_states_and_the_missing_rates(tmp_path, states, validators, now):
    rates = synth.tax_rates()
    rates["District of Columbia"] = 0
    result = taxes.write(tmp_path, parse(states=states, rates=rates, eff={"District of Columbia": "-"}),
                         URL, now, validators)
    assert any("MA, UT" in w for w in result.warnings)
    assert any("DC" in w for w in result.warnings)


# ---------------------------------------------------------------- fetch


def test_update_fetches_fhwa_and_writes(tmp_path, states, validators, now, fake_http):
    fake_http.add(URL, synth.tax_response())
    result = taxes.update(tmp_path, fake_http, now, states, "2024", validators)
    assert result.status == "ok" and result.changed
    assert fake_http.urls() == [URL]
    assert "fhwa.dot.gov" in fake_http.urls()[0]
    validators.validate("state-diesel-tax", json.loads((tmp_path / TAXES).read_text()))


def test_update_never_touches_aaa(tmp_path, states, validators, now, fake_http):
    fake_http.add(URL, synth.tax_response())
    taxes.update(tmp_path, fake_http, now, states, "2024", validators)
    assert not any("aaa" in url.lower() for url in fake_http.urls())


def test_update_reports_a_bad_status(tmp_path, states, validators, now, fake_http):
    fake_http.add(URL, Response.make(404, b"", url=URL))
    result = taxes.update(tmp_path, fake_http, now, states, "2024", validators)
    assert result.status == "error"
    assert "HTTP 404" in result.warnings[0]
    assert not (tmp_path / TAXES).exists()


def test_update_reports_a_network_error(tmp_path, states, validators, now, fake_http):
    fake_http.add(URL, NetworkError("connection reset"))
    result = taxes.update(tmp_path, fake_http, now, states, "2024", validators)
    assert result.status == "error"
    assert not (tmp_path / TAXES).exists()


def test_update_asks_for_the_year_it_was_given(tmp_path, states, validators, now, fake_http, monkeypatch):
    monkeypatch.setattr(taxes, "NOTES_CHECKED_FOR", "2025")
    url = taxes.URL_TEMPLATE.format(year="2025")
    fake_http.add(url, synth.tax_response(synth.tax_workbook(curr_year="2025"), year="2025"))
    result = taxes.update(tmp_path, fake_http, now, states, "2025", validators)
    assert result.status == "ok"
    assert fake_http.urls() == [url]
    assert json.loads((tmp_path / TAXES).read_text())["reporting_period"] == "2025"


def test_load_reads_back_what_update_wrote(tmp_path, states, validators, now, fake_http):
    fake_http.add(URL, synth.tax_response())
    taxes.update(tmp_path, fake_http, now, states, "2024", validators)
    doc = taxes.load(tmp_path, validators)
    assert doc is not None and len(doc["states"]) == 51


def test_load_on_an_empty_folder_is_none(tmp_path, validators):
    assert taxes.load(tmp_path, validators) is None


# ---------------------------------------------------------------- the committed file


def test_committed_tax_file_is_valid_and_matches_fhwa(validators, states):
    from dailyfuel.paths import DATA_DIR

    path = DATA_DIR / TAXES
    if not path.exists():
        pytest.skip("data/taxes/state_diesel_tax.json has not been fetched yet")
    doc = store.read_json(path)
    validators.validate("state-diesel-tax", doc)
    assert doc["federal_cpg"] == 24.4
    assert doc["reporting_period"] == "2024"
    assert list(doc["states"]) == [s.code for s in states.states]
    # Spot checks against FHWA's published table.
    assert doc["states"]["AK"] == 8.0
    assert doc["states"]["AZ"] == 26.0
    assert doc["states"]["AL"] == 30.0
    assert doc["states"]["IN"] == 59.0
    assert doc["states"]["PA"] == 74.1
    # The two the sheet stores in dollars.
    assert doc["states"]["MA"] == 24.0
    assert doc["states"]["UT"] == 31.0
    # FHWA publishes no per gallon diesel rate for DC, and the file says so
    # without claiming DC has no tax.
    assert doc["states"]["DC"] is None
    assert doc["effective"]["DC"] is None
    assert "has no diesel rate" in doc["notes"]["DC"]
    # FHWA's Utah row is its January 2021 rate, stored in dollars.
    assert doc["out_of_date"] == ["MN", "UT"]
    assert doc["effective"]["UT"] == "2021-01-01"
    # Effective dates as FHWA has them, including a two digit 1990.
    assert doc["effective"]["KY"] == "2024-10-01"
    assert doc["effective"]["LA"] == "1990-01-01"
    assert doc["effective"]["WI"] == "2006-04-01"
    # Only notes checked against the states, plus DC and Utah.
    assert set(doc["notes"]) == {"AZ", "DC", "KY", "MN", "OR", "UT"}
    assert doc["scope"] == taxes.SCOPE_NOTE[0]
    for code, note in doc["notes"].items():
        assert "—" not in note and "–" not in note and " - " not in note, code
