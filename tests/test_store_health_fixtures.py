"""Store helpers, the health check, and the synthetic fixture generator."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

import synth
from dailyfuel import eia, health, pipeline, store
from dailyfuel.states import EIA_KEYS

ROOT = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------- store


def weekly_doc(n=3):
    start = date(2026, 8, 31)
    return {
        "schema": "dailyfuel/eia-diesel-weekly/1",
        "source": "eia_xls",
        "source_url": eia.XLS_URL,
        "fetched_at": "2026-09-17T12:17:03Z",
        "last_modified": None,
        "release_date": None,
        "next_release_date": None,
        "weeks": [
            {"period": (start + timedelta(days=7 * i)).isoformat(), "values": {k: 5.5 + i / 10 for k in EIA_KEYS}}
            for i in range(n)
        ],
    }


def test_eia_weekly_dump_round_trips_and_is_one_line_per_week():
    doc = weekly_doc()
    text = store.dumps_eia_weekly(doc)
    assert json.loads(text) == doc
    lines = text.splitlines()
    assert sum(1 for ln in lines if '"period"' in ln) == 3
    assert text.endswith("]\n}\n")


def test_invalid_doc_is_not_written_and_old_file_survives(tmp_path, validators):
    path = tmp_path / "eia" / "diesel_weekly.json"
    store.write_doc("eia-diesel-weekly", path, weekly_doc(), validators)
    before = path.read_bytes()
    bad = weekly_doc()
    bad["weeks"][0]["values"]["NUS"] = 20.0
    with pytest.raises(store.SchemaError):
        store.write_doc("eia-diesel-weekly", path, bad, validators)
    assert path.read_bytes() == before
    assert [p.name for p in path.parent.iterdir()] == ["diesel_weekly.json"]


def test_write_skips_identical_content(tmp_path, validators):
    path = tmp_path / "x.json"
    assert store.write_doc("eia-diesel-weekly", path, weekly_doc(), validators) is True
    assert store.write_doc("eia-diesel-weekly", path, weekly_doc(), validators) is False


@pytest.mark.parametrize("value", ["2026-09-17", "2026-09-17 12:00:00", "yesterday", "2026-13-01T00:00:00Z"])
def test_date_time_format_is_enforced(validators, value):
    doc = weekly_doc()
    doc["fetched_at"] = value
    assert validators.errors("eia-diesel-weekly", doc)


def test_date_format_is_enforced(validators):
    doc = weekly_doc()
    doc["weeks"][0]["period"] = "2026-02-30"
    assert validators.errors("eia-diesel-weekly", doc)


def test_num_and_dec():
    from decimal import Decimal

    assert store.num(Decimal("-0.0000")) == 0.0
    assert json.dumps(store.num(Decimal("-0.0000"))) == "0.0"
    assert store.num(Decimal("6.5471")) == 6.5471
    assert store.dec(6.5471) == Decimal("6.5471")
    assert store.dec(0.1) + store.dec(0.2) == Decimal("0.3")


# ---------------------------------------------------------------- health


NOW = datetime(2026, 9, 17, 12, 17, tzinfo=timezone.utc)


def seed_eia(data_dir, newest: date, validators):
    doc = weekly_doc(2)
    doc["weeks"][0]["period"] = (newest - timedelta(days=7)).isoformat()
    doc["weeks"][1]["period"] = newest.isoformat()
    store.write_doc("eia-diesel-weekly", data_dir / "eia" / "diesel_weekly.json", doc, validators)


def seed_aaa(data_dir, as_of: date):
    folder = data_dir / "aaa" / "daily"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{as_of.isoformat()}.json").write_text("{}")


GOOD = {"aaa": "skipped", "eia": "not_modified", "warnings": []}


def test_health_ok(tmp_path, validators):
    seed_eia(tmp_path, date(2026, 9, 14), validators)
    assert health.problems(GOOD, tmp_path, {}, NOW) == []


@pytest.mark.parametrize("aaa_status", ["blocked", "invalid", "error"])
def test_health_fails_on_bad_aaa_status(tmp_path, validators, aaa_status):
    seed_eia(tmp_path, date(2026, 9, 14), validators)
    assert health.problems(dict(GOOD, aaa=aaa_status), tmp_path, {}, NOW)


@pytest.mark.parametrize("aaa_status", ["ok", "noop", "skipped"])
def test_health_passes_good_aaa_status(tmp_path, validators, aaa_status):
    seed_eia(tmp_path, date(2026, 9, 14), validators)
    assert health.problems(dict(GOOD, aaa=aaa_status), tmp_path, {}, NOW) == []


def test_health_fails_on_eia_error(tmp_path, validators):
    seed_eia(tmp_path, date(2026, 9, 14), validators)
    assert health.problems(dict(GOOD, eia="error"), tmp_path, {}, NOW) == ["EIA status is error"]


def test_health_eia_staleness_boundary(tmp_path, validators):
    seed_eia(tmp_path, date(2026, 9, 7), validators)  # exactly 10 days before 9/17
    assert health.problems(GOOD, tmp_path, {}, NOW) == []
    seed_eia(tmp_path, date(2026, 9, 6), validators)  # 11 days, not a Monday but fine for this check
    assert health.problems(GOOD, tmp_path, {}, NOW) == ["newest EIA week is 2026-09-06, 11 days old"]


def test_health_aaa_staleness_only_when_enabled(tmp_path, validators):
    seed_eia(tmp_path, date(2026, 9, 14), validators)
    seed_aaa(tmp_path, date(2026, 9, 15))
    on = {"AAA_ENABLED": "true"}
    assert health.problems(GOOD, tmp_path, on, NOW) == ["newest AAA snapshot is 2026-09-15, 2 days old"]
    assert health.problems(GOOD, tmp_path, {}, NOW) == []
    seed_aaa(tmp_path, date(2026, 9, 16))
    assert health.problems(GOOD, tmp_path, on, NOW) == []


def test_health_uses_new_york_date(tmp_path, validators):
    seed_eia(tmp_path, date(2026, 9, 14), validators)
    seed_aaa(tmp_path, date(2026, 9, 16))
    # 02:00 UTC on 9/18 is still 9/17 in New York.
    late = datetime(2026, 9, 18, 2, 0, tzinfo=timezone.utc)
    assert health.problems(GOOD, tmp_path, {"AAA_ENABLED": "true"}, late) == []


def test_health_missing_status_or_data(tmp_path):
    found = health.problems(None, tmp_path, {}, NOW)
    assert any("run_status.json is missing" in p for p in found)
    assert any("no EIA weekly data" in p for p in found)


def test_health_cli(tmp_path, validators, capsys):
    import health as health_cli

    seed_eia(tmp_path / "data", date(2026, 9, 14), validators)
    status = tmp_path / "run_status.json"
    status.write_text(json.dumps(GOOD))
    args = ["--data-dir", str(tmp_path / "data"), "--status", str(status)]
    assert health_cli.main(args, env={}, now=NOW) == 0
    status.write_text(json.dumps(dict(GOOD, aaa="blocked")))
    assert health_cli.main(args, env={}, now=NOW) == 1
    assert "AAA status is blocked" in capsys.readouterr().out
    rt = tmp_path / "rt"
    rt.mkdir()
    (rt / "run_status.json").write_text(json.dumps(GOOD))
    assert health_cli.main(["--data-dir", str(tmp_path / "data")], env={"RUNNER_TEMP": str(rt)}, now=NOW) == 0


# ---------------------------------------------------------------- make_fixtures


def eia_file(tmp_path, validators) -> Path:
    wb = eia.parse_workbook(synth.xls_body())
    doc = weekly_doc()
    doc["weeks"] = wb.weeks
    doc["release_date"], doc["next_release_date"] = wb.release_date, wb.next_release_date
    path = tmp_path / "eia_src.json"
    store.write_doc("eia-diesel-weekly", path, doc, validators)
    return path


def hashes(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}


def test_make_fixtures_writes_valid_synthetic_aaa_mode_data(tmp_path, validators, capsys):
    import make_fixtures

    out = tmp_path / "fixture-data"
    src = eia_file(tmp_path, validators)
    assert make_fixtures.main([str(out), "--eia", str(src)]) == 0

    daily = sorted((out / "aaa" / "daily").glob("*.json"))
    assert len(daily) >= 95
    dates = [date.fromisoformat(p.stem) for p in daily]
    gaps = [(a, b) for a, b in zip(dates, dates[1:]) if (b - a).days != 1]
    assert gaps == [(date(2026, 9, 15), date(2026, 9, 17))]
    run = 1
    best = 1
    for a, b in zip(dates, dates[1:]):
        run = run + 1 if (b - a).days == 1 else 1
        best = max(best, run)
    assert best >= 95

    for p in daily:
        doc = json.loads(p.read_text())
        validators.validate("aaa-daily", doc)
        assert doc["origin"] == "synthetic"
        assert doc["as_of"] == p.stem
    eia_doc = json.loads((out / "eia" / "diesel_weekly.json").read_text())
    validators.validate("eia-diesel-weekly", eia_doc)
    latest = json.loads((out / "latest.json").read_text())
    validators.validate("latest", latest)
    assert latest["mode"] == "aaa+eia"
    assert latest["aaa"]["gap_days"] == 2

    flags = {f for r in latest["states"] for f in r["flags"]}
    assert {"gap", "large_move", "eia_divergence", "no_eia_survey"} <= flags
    assert sum("large_move" in r["flags"] for r in latest["states"]) == 1
    directions = {r["aaa"]["direction"] for r in latest["states"]}
    assert directions == {"up", "down", "flat"}
    nulls = [p for p in daily if json.loads(p.read_text())["national"] is None]
    assert len(nulls) == 1

    # Deterministic: same inputs, same bytes.
    first = hashes(out)
    assert make_fixtures.main([str(out), "--eia", str(src)]) == 0
    assert hashes(out) == first


def test_make_fixtures_single_day_gives_prev_missing(tmp_path, validators):
    import make_fixtures

    out = tmp_path / "one"
    assert make_fixtures.main([str(out), "--eia", str(eia_file(tmp_path, validators)), "--days", "1"]) == 0
    latest = json.loads((out / "latest.json").read_text())
    assert len(list((out / "aaa" / "daily").glob("*.json"))) == 1
    assert all("prev_missing" in r["flags"] for r in latest["states"])


def test_make_fixtures_refuses_real_data_dir(tmp_path, validators):
    import make_fixtures

    with pytest.raises(SystemExit, match="refusing"):
        make_fixtures.main([str(ROOT / "data"), "--eia", str(eia_file(tmp_path, validators))])
    with pytest.raises(SystemExit, match="refusing"):
        make_fixtures.main([str(ROOT / "data" / "sub"), "--eia", str(eia_file(tmp_path, validators))])
