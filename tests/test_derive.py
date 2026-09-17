"""latest.json derivation: Decimal math, flags, mode selection, schema validity."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from dailyfuel import aaa, derive, store
from dailyfuel.states import EIA_KEYS

GEN = "2026-09-17T12:17:03Z"


def eia_doc(cur=None, prev=None):
    cur = cur or {}
    prev = prev or {}
    return {
        "schema": "dailyfuel/eia-diesel-weekly/1",
        "source": "eia_xls",
        "source_url": "https://www.eia.gov/petroleum/gasdiesel/xls/psw18vwall.xls",
        "fetched_at": GEN,
        "last_modified": "Tue, 15 Sep 2026 22:28:31 GMT",
        "release_date": "2026-09-15",
        "next_release_date": "2026-09-22",
        "weeks": [
            {"period": "2026-09-07", "values": {k: prev.get(k, 5.967) for k in EIA_KEYS}},
            {"period": "2026-09-14", "values": {k: cur.get(k, 6.285) for k in EIA_KEYS}},
        ],
    }


def snapshot(as_of, prices=None, default=6.0, national=None):
    prices = prices or {}
    codes = sorted(aaa_codes())
    return {
        "schema": "dailyfuel/aaa-daily/1",
        "as_of": as_of,
        "as_of_raw": "9/17/26",
        "fetched_at": GEN,
        "origin": "synthetic",
        "source_url": aaa.ALL_STATES_URL,
        "national": national,
        "diesel": {c: prices.get(c, default) for c in codes},
    }


def aaa_codes():
    from dailyfuel.states import load_states

    return load_states().codes


def row(doc, code):
    return next(r for r in doc["states"] if r["code"] == code)


def test_decimal_math_not_float(states, validators):
    snaps = [snapshot("2026-09-16", {"OH": 6.1}), snapshot("2026-09-17", {"OH": 6.5471})]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    validators.validate("latest", doc)
    oh = row(doc, "OH")["aaa"]
    assert 6.5471 - 6.1 != 0.4471  # binary float would get this wrong
    assert oh == {"price": 6.5471, "prev": 6.1, "change": 0.4471, "change_pct": 7.33, "direction": "up"}


def test_eia_change_rounds_to_3_decimals(states, validators):
    doc = derive.build_latest(states, eia_doc({"NUS": 6.285, "R20": 6.25}, {"NUS": 5.967, "R20": 5.946}), [], False, GEN)
    validators.validate("latest", doc)
    assert doc["eia"]["us"] == {"price": 6.285, "prev": 5.967, "change": 0.318, "change_pct": 5.33, "direction": "up"}
    assert row(doc, "OH")["eia"] == {"price": 6.25, "prev": 5.946, "change": 0.304, "change_pct": 5.11, "direction": "up"}
    assert doc["eia"]["period"] == "2026-09-14"
    assert doc["eia"]["prev_period"] == "2026-09-07"
    assert doc["eia"]["next_release_date"] == "2026-09-22"


def test_direction_up_down_flat(states):
    snaps = [
        snapshot("2026-09-16", {"OH": 6.0000, "TX": 6.0000, "CA": 6.0000}),
        snapshot("2026-09-17", {"OH": 6.0001, "TX": 5.9999, "CA": 6.0000}),
    ]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    assert row(doc, "OH")["aaa"]["direction"] == "up"
    assert row(doc, "TX")["aaa"]["direction"] == "down"
    assert row(doc, "CA")["aaa"]["direction"] == "flat"
    assert row(doc, "CA")["aaa"]["change"] == 0.0
    assert row(doc, "TX")["aaa"]["change"] == -0.0001


def test_prev_missing(states, validators):
    doc = derive.build_latest(states, eia_doc(), [snapshot("2026-09-17")], True, GEN)
    validators.validate("latest", doc)
    assert doc["mode"] == "aaa+eia"
    assert doc["aaa"]["prev_as_of"] is None
    assert doc["aaa"]["gap_days"] is None
    for r in doc["states"]:
        assert r["aaa"]["prev"] is None and r["aaa"]["change"] is None
        assert r["aaa"]["change_pct"] is None and r["aaa"]["direction"] is None
        assert "prev_missing" in r["flags"]


def test_gap_days_and_gap_flag(states, validators):
    snaps = [snapshot("2026-09-14", default=6.0), snapshot("2026-09-17", default=6.01)]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    validators.validate("latest", doc)
    assert doc["aaa"]["gap_days"] == 3
    assert doc["aaa"]["prev_as_of"] == "2026-09-14"
    assert all("gap" in r["flags"] for r in doc["states"])


def test_consecutive_days_have_no_gap_flag(states):
    snaps = [snapshot("2026-09-16", default=6.0), snapshot("2026-09-17", default=6.01)]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    assert doc["aaa"]["gap_days"] == 1
    assert not any("gap" in r["flags"] for r in doc["states"])


def test_prev_is_newest_snapshot_before_current(states):
    snaps = [snapshot("2026-09-17", default=6.3), snapshot("2026-09-10", default=5.0), snapshot("2026-09-15", default=6.1)]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    assert doc["aaa"]["prev_as_of"] == "2026-09-15"
    assert row(doc, "OH")["aaa"]["prev"] == 6.1


def test_ak_hi_flags_in_both_modes(states, validators):
    for enabled, snaps in ((False, []), (True, [snapshot("2026-09-16"), snapshot("2026-09-17", default=6.1)])):
        doc = derive.build_latest(states, eia_doc(), snaps, enabled, GEN)
        validators.validate("latest", doc)
        for code in ("AK", "HI"):
            r = row(doc, code)
            assert r["eia"] is None
            assert r["eia_series"] is None
            assert "no_eia_survey" in r["flags"]
        assert "no_eia_survey" not in row(doc, "OH")["flags"]


def test_mode_selection(states, validators):
    snaps = [snapshot("2026-09-17")]
    on = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    on_empty = derive.build_latest(states, eia_doc(), [], True, GEN)
    off = derive.build_latest(states, eia_doc(), snaps, False, GEN)
    assert on["mode"] == "aaa+eia" and on["aaa"] is not None
    for doc in (on_empty, off):
        validators.validate("latest", doc)
        assert doc["mode"] == "eia_only"
        assert doc["aaa"] is None
        assert all(r["aaa"] is None for r in doc["states"])
        assert all(r["flags"] in ([], ["no_eia_survey"]) for r in doc["states"])


def test_aaa_enabled_is_exactly_true():
    assert derive.aaa_enabled({"AAA_ENABLED": "true"})
    for value in (None, "", "false", "TRUE", "True", "1", "yes", " true"):
        env = {} if value is None else {"AAA_ENABLED": value}
        assert not derive.aaa_enabled(env)


def test_large_move_at_50_cents(states):
    snaps = [
        snapshot("2026-09-16", {"OH": 6.0, "TX": 6.0, "CA": 6.0}),
        snapshot("2026-09-17", {"OH": 6.5, "TX": 5.4999, "CA": 6.4999}),
    ]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    assert "large_move" in row(doc, "OH")["flags"]
    assert "large_move" in row(doc, "TX")["flags"]
    assert "large_move" not in row(doc, "CA")["flags"]


def test_eia_divergence_over_one_dollar(states):
    cur = {"R20": 6.0, "R30": 6.0, "SCA": 6.0}
    snaps = [
        snapshot("2026-09-16", default=6.0),
        snapshot("2026-09-17", {"OH": 7.0, "TX": 7.0001, "CA": 4.9999}, default=6.01),
    ]
    doc = derive.build_latest(states, eia_doc(cur), snaps, True, GEN)
    assert "eia_divergence" not in row(doc, "OH")["flags"]  # exactly $1.00
    assert "eia_divergence" in row(doc, "TX")["flags"]
    assert "eia_divergence" in row(doc, "CA")["flags"]


def test_national_uses_aaa_current_minus_yesterday(states, validators):
    snaps = [snapshot("2026-09-14"), snapshot("2026-09-17", default=6.1, national={"current": 6.123, "yesterday": 6.101})]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    validators.validate("latest", doc)
    assert doc["aaa"]["national"] == {"price": 6.123, "prev": 6.101, "change": 0.022, "change_pct": 0.36, "direction": "up"}


def test_null_national(states, validators):
    doc = derive.build_latest(states, eia_doc(), [snapshot("2026-09-17")], True, GEN)
    validators.validate("latest", doc)
    assert doc["aaa"]["national"] is None


def test_states_follow_states_json_order_and_flag_order(states):
    snaps = [snapshot("2026-09-14", {"AK": 6.0}), snapshot("2026-09-17", {"AK": 7.5}, default=6.01)]
    doc = derive.build_latest(states, eia_doc(), snaps, True, GEN)
    assert [r["code"] for r in doc["states"]] == [s.code for s in states.states]
    assert row(doc, "AK")["flags"] == ["gap", "large_move", "no_eia_survey"]


def test_rebuild_writes_once_and_keeps_generated_at(tmp_path, states, validators, now):
    store.write_doc("eia-diesel-weekly", tmp_path / "eia" / "diesel_weekly.json", eia_doc(), validators)
    changed, doc = derive.rebuild(tmp_path, states, False, now, validators)
    assert changed
    first = (tmp_path / "latest.json").read_bytes()
    changed, _ = derive.rebuild(tmp_path, states, False, now + timedelta(hours=5), validators)
    assert not changed
    assert (tmp_path / "latest.json").read_bytes() == first
    assert json.loads(first)["generated_at"] == "2026-09-17T12:17:03Z"


def test_rebuild_switches_mode_when_aaa_turns_off(tmp_path, states, validators, now):
    store.write_doc("eia-diesel-weekly", tmp_path / "eia" / "diesel_weekly.json", eia_doc(), validators)
    store.write_doc("aaa-daily", tmp_path / "aaa" / "daily" / "2026-09-17.json", snapshot("2026-09-17"), validators)
    _, on = derive.rebuild(tmp_path, states, True, now, validators)
    assert on["mode"] == "aaa+eia"
    changed, off = derive.rebuild(tmp_path, states, False, now + timedelta(hours=1), validators)
    assert changed and off["mode"] == "eia_only"
    assert off["generated_at"] == "2026-09-17T13:17:03Z"


def test_invalid_latest_is_never_written(tmp_path, states, validators, now, monkeypatch):
    store.write_doc("eia-diesel-weekly", tmp_path / "eia" / "diesel_weekly.json", eia_doc(), validators)
    real = derive.build_latest

    def broken(*args, **kwargs):
        doc = real(*args, **kwargs)
        doc["mode"] = "aaa_only"
        return doc

    monkeypatch.setattr(derive, "build_latest", broken)
    with pytest.raises(store.SchemaError):
        derive.rebuild(tmp_path, states, False, now, validators)
    assert not (tmp_path / "latest.json").exists()


def test_move_compares_exact_decimals():
    from decimal import Decimal

    tiny = derive.move(Decimal("6.00000000000000001"), Decimal("6"), derive.AAA_CHANGE_STEP)
    assert tiny["direction"] == "up"  # float math would call this flat
    assert tiny["change"] == 0.0
    half = derive.move(Decimal("6.00005"), Decimal("6"), derive.AAA_CHANGE_STEP)
    assert half["change"] == 0.0001  # half up, not banker's rounding
