"""AAA parsing, block detection and validation, all on synthetic pages."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

import synth
from dailyfuel import aaa
from dailyfuel.http import Response

TODAY = date(2026, 9, 17)
CODES = frozenset(synth.CODES)


# ---------------------------------------------------------------- all states page


def test_happy_path_parses_51_rows_and_date():
    page = aaa.parse_all_states(synth.all_states_html())
    assert len(page.diesel) == 51
    assert set(page.diesel) == CODES
    assert page.as_of == date(2026, 9, 17)
    assert page.as_of_raw == "9/17/26"
    assert page.diesel == synth.diesel_prices()
    assert all(isinstance(v, Decimal) for v in page.diesel.values())


def test_trailing_spaces_and_nbsp_are_stripped():
    html = synth.all_states_html(diesel_cell=lambda code, v: f"  ${v}     \n  ")
    page = aaa.parse_all_states(html)
    assert page.diesel["AK"] == synth.diesel_prices()["AK"]


def test_two_to_four_decimal_prices_accepted():
    prices = synth.diesel_prices()
    prices["AL"] = "6.25"
    prices["AK"] = "6.255"
    page = aaa.parse_all_states(synth.all_states_html(prices))
    assert page.diesel["AL"] == Decimal("6.25")
    assert page.diesel["AK"] == Decimal("6.255")


def test_missing_row_parses_but_fails_validation():
    prices = synth.diesel_prices()
    del prices["WY"]
    page = aaa.parse_all_states(synth.all_states_html(prices))
    assert len(page.diesel) == 50
    with pytest.raises(aaa.Invalid, match="expected 51 rows"):
        aaa.validate(page, CODES, TODAY, None, None)


def test_duplicate_code_is_invalid():
    prices = synth.diesel_prices()
    order = sorted(prices)
    order[1] = order[0]  # AK twice, AL missing
    with pytest.raises(aaa.Invalid, match="duplicate code AK"):
        aaa.parse_all_states(synth.all_states_html(prices, order=order))


def test_missing_dollar_sign_is_invalid():
    html = synth.all_states_html(diesel_cell=lambda code, v: f"{v}" if code == "OH" else f"${v}")
    with pytest.raises(aaa.Invalid, match="bad row"):
        aaa.parse_all_states(html)


def test_blank_diesel_cell_is_invalid():
    html = synth.all_states_html(diesel_cell=lambda code, v: "" if code == "TX" else f"${v}")
    with pytest.raises(aaa.Invalid, match="bad row"):
        aaa.parse_all_states(html)


def test_badge_dates_disagree_is_invalid():
    html = synth.all_states_html(as_of=date(2026, 9, 17), mobile_as_of=date(2026, 9, 16))
    with pytest.raises(aaa.Invalid, match="one 'Price as of' date"):
        aaa.parse_all_states(html)


def test_no_badge_is_invalid():
    html = synth.all_states_html().replace("Price as of", "Updated")
    with pytest.raises(aaa.Invalid):
        aaa.parse_all_states(html)


def test_no_sortable_table_is_invalid():
    html = synth.all_states_html().replace('id="sortable"', 'id="other"')
    with pytest.raises(aaa.Invalid, match="no table#sortable"):
        aaa.parse_all_states(html)


def test_headers_without_diesel_are_invalid():
    html = synth.all_states_html(headers=("State", "Regular", "Mid-Grade", "Premium", "Fuel"))
    with pytest.raises(aaa.Invalid, match="headers"):
        aaa.parse_all_states(html)


def test_unknown_code_fails_validation():
    prices = synth.diesel_prices()
    prices["XX"] = prices.pop("WY")
    page = aaa.parse_all_states(synth.all_states_html(prices))
    with pytest.raises(aaa.Invalid, match="unknown codes"):
        aaa.validate(page, CODES, TODAY, None, None)


@pytest.mark.parametrize("bad", ["1.4999", "15.0001", "99.00"])
def test_value_out_of_range_fails_validation(bad):
    prices = synth.diesel_prices()
    prices["CA"] = bad
    page = aaa.parse_all_states(synth.all_states_html(prices))
    with pytest.raises(aaa.Invalid, match="outside"):
        aaa.validate(page, CODES, TODAY, None, None)


# ---------------------------------------------------------------- homepage


def test_homepage_finds_diesel_by_header_with_e85():
    nat = aaa.parse_homepage(synth.homepage_html("6.123", "6.101"))
    assert nat.current == Decimal("6.123")
    assert nat.yesterday == Decimal("6.101")
    assert nat.as_of == date(2026, 9, 17)


def test_homepage_diesel_column_not_by_position():
    html = synth.homepage_html("7.001", "6.990", columns=("E85", "Diesel", "Regular", "Premium", "Mid-Grade"))
    nat = aaa.parse_homepage(html)
    assert (nat.current, nat.yesterday) == (Decimal("7.001"), Decimal("6.990"))


def test_homepage_without_diesel_column_is_invalid():
    html = synth.homepage_html(columns=("Regular", "Mid-Grade", "Premium", "E85"))
    with pytest.raises(aaa.Invalid, match="headers"):
        aaa.parse_homepage(html)


def test_homepage_missing_yesterday_row_is_invalid():
    html = synth.homepage_html().replace("Yesterday Avg.", "Some Other Avg.")
    with pytest.raises(aaa.Invalid, match="found rows"):
        aaa.parse_homepage(html)


# ---------------------------------------------------------------- fetch and block detection


def test_gzipped_body_is_decoded(fake_http, sleeps):
    fake_http.add(aaa.ALL_STATES_URL, synth.html_response(synth.gz(synth.all_states_html())))
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "ok"
    assert len(aaa.parse_all_states(got.html).diesel) == 51


def test_request_headers(fake_http, sleeps):
    fake_http.add(aaa.ALL_STATES_URL, synth.html_response(synth.all_states_html()))
    aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    _, headers = fake_http.calls[0]
    assert headers["User-Agent"] == "Mozilla/5.0 (compatible; DailyFuel/1.0; +https://github.com/lazizbekravshanov/DailyFuel)"
    assert headers["Accept"] == "text/html"
    assert headers["Accept-Language"] == "en-US,en;q=0.8"


def test_challenge_platform_on_normal_page_is_not_blocked(fake_http, sleeps):
    extra = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'
    html = synth.all_states_html(extra_body=extra)
    fake_http.add(aaa.ALL_STATES_URL, synth.html_response(html))
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "ok"
    assert len(aaa.parse_all_states(got.html).diesel) == 51


@pytest.mark.parametrize(
    "response",
    [
        synth.html_response("<html><title>Just a moment...</title></html>", status=200),
        synth.html_response("<html><title>Just a moment...</title></html>", status=403),
        synth.html_response("<html><script>window._cf_chl_opt={}</script><div id='cf-chl-widget'></div></html>"),
        synth.html_response("Forbidden", status=403),
        synth.html_response("Too many requests", status=429),
        synth.html_response("Service unavailable", status=503),
        synth.html_response(synth.all_states_html(), status=200, headers={"cf-mitigated": "challenge"}),
    ],
    ids=["just-a-moment-200", "just-a-moment-403", "cf-chl", "403", "429", "503", "cf-mitigated"],
)
def test_blocked_responses_are_not_retried(fake_http, sleeps, response):
    fake_http.add(aaa.ALL_STATES_URL, response)
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "blocked"
    assert len(fake_http.calls) == 1
    assert sleeps.calls == []


def test_network_error_retries_once_after_30s(fake_http, sleeps):
    fake_http.add(aaa.ALL_STATES_URL, synth.network_error(), synth.html_response(synth.all_states_html()))
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "ok"
    assert sleeps.calls == [30]
    assert len(fake_http.calls) == 2


def test_network_error_twice_is_error(fake_http, sleeps):
    fake_http.add(aaa.ALL_STATES_URL, synth.network_error(), synth.network_error())
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "error"
    assert len(fake_http.calls) == 2


@pytest.mark.parametrize("status", [500, 502, 504])
def test_other_5xx_retries_once_then_error(fake_http, sleeps, status):
    fake_http.add(aaa.ALL_STATES_URL, synth.html_response("oops", status=status))
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "error"
    assert len(fake_http.calls) == 2
    assert sleeps.calls == [30]


def test_5xx_then_ok(fake_http, sleeps):
    fake_http.add(aaa.ALL_STATES_URL, synth.html_response("oops", status=502), synth.html_response(synth.all_states_html()))
    assert aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps).status == "ok"


def test_404_is_error_without_retry(fake_http, sleeps):
    fake_http.add(aaa.ALL_STATES_URL, synth.html_response("not found", status=404))
    got = aaa.fetch(fake_http, aaa.ALL_STATES_URL, sleeps)
    assert got.status == "error"
    assert len(fake_http.calls) == 1


def test_block_reason_ignores_cdn_cgi():
    resp = Response.make(200, b"")
    assert aaa.block_reason(resp, "<a href='/cdn-cgi/l/email-protection'>x</a> challenge-platform") is None


# ---------------------------------------------------------------- validation


def _page(day: int = 0, as_of: date = TODAY, prices=None):
    return aaa.parse_all_states(synth.all_states_html(prices if prices is not None else synth.diesel_prices(day), as_of=as_of))


def test_first_snapshot_warns_prev_missing():
    status, warnings = aaa.validate(_page(), CODES, TODAY, None, None)
    assert status == "ok"
    assert warnings == ["prev_missing: no earlier AAA snapshot"]


def test_noop_on_same_date():
    prev = synth.diesel_prices(1)
    status, warnings = aaa.validate(_page(), CODES, TODAY, TODAY, prev)
    assert (status, warnings) == ("noop", [])


def test_stale_date_is_invalid():
    with pytest.raises(aaa.Invalid, match="older than stored"):
        aaa.validate(_page(as_of=date(2026, 9, 15)), CODES, TODAY, date(2026, 9, 16), synth.diesel_prices(1))


def test_future_date_is_invalid():
    with pytest.raises(aaa.Invalid, match="is after"):
        aaa.validate(_page(as_of=date(2026, 9, 19)), CODES, TODAY, None, None)


def test_tomorrow_is_allowed():
    status, _ = aaa.validate(_page(as_of=date(2026, 9, 18)), CODES, TODAY, None, None)
    assert status == "ok"


def test_unchanged_values_with_new_date_is_invalid():
    prices = synth.diesel_prices()
    with pytest.raises(aaa.Invalid, match="all 51 values equal"):
        aaa.validate(_page(prices=prices), CODES, TODAY, date(2026, 9, 16), dict(prices))


def test_one_changed_value_is_enough():
    prices = synth.diesel_prices()
    prev = dict(prices)
    prev["OH"] = prev["OH"] - Decimal("0.0001")
    status, warnings = aaa.validate(_page(prices=prices), CODES, TODAY, date(2026, 9, 16), prev)
    assert status == "ok"
    assert warnings == []


def test_large_move_warns_at_50_cents():
    prices = synth.diesel_prices()
    prev = synth.diesel_prices(1)
    for code in prices:
        prev[code] = prices[code] - Decimal("0.0100")
    prev["OH"] = prices["OH"] - Decimal("0.5000")
    prev["TX"] = prices["TX"] + Decimal("0.6200")
    prev["CA"] = prices["CA"] - Decimal("0.4999")
    status, warnings = aaa.validate(_page(prices=prices), CODES, TODAY, date(2026, 9, 16), prev)
    assert status == "ok"
    assert warnings == ["large_move: OH +0.5000", "large_move: TX -0.6200"]


def test_gap_warns_when_more_than_one_day():
    status, warnings = aaa.validate(_page(), CODES, TODAY, date(2026, 9, 14), synth.diesel_prices(1))
    assert status == "ok"
    assert warnings == ["gap: 3 days since 2026-09-14"]


def test_no_gap_warning_for_consecutive_days():
    _, warnings = aaa.validate(_page(), CODES, TODAY, date(2026, 9, 16), synth.diesel_prices(1))
    assert warnings == []


def test_snapshot_rounds_to_4_decimals_and_sorts_codes():
    prices = synth.diesel_prices()
    page = aaa.AllStates(as_of=TODAY, as_of_raw="9/17/26", diesel=prices)
    nat = aaa.National(as_of=TODAY, current=Decimal("6.12345"), yesterday=Decimal("6.1"))
    doc = aaa.build_snapshot(page, "2026-09-17T12:17:03Z", "live", nat)
    assert list(doc["diesel"]) == sorted(prices)
    assert doc["national"] == {"current": 6.1235, "yesterday": 6.1}
    assert doc["source_url"] == "https://gasprices.aaa.com/state-gas-price-averages/"
