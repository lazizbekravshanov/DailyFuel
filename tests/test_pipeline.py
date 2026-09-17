"""The whole job: the AAA switch, an end to end AAA run, idempotency, outputs."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

import synth
from dailyfuel import aaa, eia, pipeline
from dailyfuel.http import AaaDisabledError, RequestsClient, is_aaa_host


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def eia_only_http() -> synth.FakeHttp:
    return synth.FakeHttp().set(eia.XLS_URL, synth.xls_server())


def aaa_http(day: int = 0, as_of: date = date(2026, 9, 17), national=("6.123", "6.101")) -> synth.FakeHttp:
    http = eia_only_http()
    http.set(aaa.ALL_STATES_URL, synth.html_response(synth.all_states_html(synth.diesel_prices(day), as_of=as_of)))
    http.set(aaa.HOMEPAGE_URL, synth.html_response(synth.homepage_html(*national, as_of=as_of), url=aaa.HOMEPAGE_URL))
    return http


def run(tmp_path, env, http, sleeps, now, states, validators):
    data = tmp_path / "data"
    full_env = {"RUNNER_TEMP": str(tmp_path / "runner")}
    full_env.update(env)
    result = pipeline.run(data_dir=data, env=full_env, http=http, sleep=sleeps, now=now, states=states, validators=validators)
    pipeline.write_outputs(result, full_env)
    return result, data


# ---------------------------------------------------------------- the AAA switch


@pytest.mark.parametrize("value", [None, "false", "", "TRUE", "True", "1", "yes"])
def test_aaa_switch_off_means_zero_aaa_requests(tmp_path, sleeps, now, states, validators, value):
    env = {} if value is None else {"AAA_ENABLED": value}
    env["FORCE_AAA"] = "true"  # forcing must not matter while the switch is off
    http = eia_only_http()
    # If anything did try AAA, the fake would record it before failing.
    http.set(aaa.ALL_STATES_URL, synth.html_response(synth.all_states_html()))
    http.set(aaa.HOMEPAGE_URL, synth.html_response(synth.homepage_html()))
    result, data = run(tmp_path, env, http, sleeps, now, states, validators)
    assert [u for u in http.urls() if is_aaa_host(u)] == []
    assert http.urls() == [eia.XLS_URL]
    assert result.aaa.status == "skipped"
    latest = json.loads((data / "latest.json").read_text())
    assert latest["mode"] == "eia_only"
    assert not (data / "aaa" / "daily").exists()
    assert sleeps.calls == []


def test_default_client_is_built_with_aaa_blocked(tmp_path, now, states, validators, monkeypatch):
    built = []

    class Recorder(synth.FakeHttp):
        def __init__(self, allow_aaa=False):
            super().__init__()
            built.append(allow_aaa)
            self.set(eia.XLS_URL, synth.xls_server())

    import dailyfuel.http

    monkeypatch.setattr(dailyfuel.http, "RequestsClient", Recorder)
    pipeline.run(data_dir=tmp_path / "off", env={}, now=now, states=states, validators=validators)
    pipeline.run(data_dir=tmp_path / "false", env={"AAA_ENABLED": "false"}, now=now, states=states, validators=validators)
    assert built == [False, False]


def test_requests_client_refuses_aaa_hosts_when_off():
    class Session:
        calls = []

        def get(self, *a, **k):  # pragma: no cover, must never be reached
            self.calls.append(a)
            raise AssertionError("session.get should not run")

    session = Session()
    client = RequestsClient(allow_aaa=False, session=session)
    for url in (aaa.ALL_STATES_URL, aaa.HOMEPAGE_URL, "https://AAA.com/x", "https://www.aaa.com."):
        with pytest.raises(AaaDisabledError):
            client.get(url)
    assert session.calls == []


def test_requests_client_refuses_redirect_to_aaa():
    class FakeResp:
        is_redirect = True
        headers = {"Location": "https://gasprices.aaa.com/"}

    with pytest.raises(AaaDisabledError):
        RequestsClient(allow_aaa=False, session=object())._check_redirect(FakeResp())


def test_is_aaa_host():
    assert is_aaa_host("https://gasprices.aaa.com/state-gas-price-averages/")
    assert is_aaa_host("http://aaa.com")
    assert not is_aaa_host("https://www.eia.gov/petroleum/gasdiesel/xls/psw18vwall.xls")
    assert not is_aaa_host("https://notaaa.com/")
    assert not is_aaa_host("https://aaa.com.example.org/")


def test_sockets_are_blocked_in_tests():
    import socket

    from conftest import NetworkBlocked

    with pytest.raises(NetworkBlocked):
        socket.create_connection(("127.0.0.1", 9))
    with pytest.raises(NetworkBlocked):
        socket.getaddrinfo("www.eia.gov", 443)


# ---------------------------------------------------------------- end to end with AAA on


def test_end_to_end_aaa_on(tmp_path, sleeps, now, states, validators):
    http = aaa_http()
    result, data = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now, states, validators)

    assert result.status() == {"aaa": "ok", "eia": "ok", "warnings": ["prev_missing: no earlier AAA snapshot"]}
    assert http.urls() == [aaa.ALL_STATES_URL, aaa.HOMEPAGE_URL, eia.XLS_URL]
    assert sleeps.calls == [15]

    snap_path = data / "aaa" / "daily" / "2026-09-17.json"
    snap = json.loads(snap_path.read_text())
    validators.validate("aaa-daily", snap)
    assert snap["origin"] == "live"
    assert snap["as_of_raw"] == "9/17/26"
    assert snap["national"] == {"current": 6.123, "yesterday": 6.101}
    assert len(snap["diesel"]) == 51

    latest = json.loads((data / "latest.json").read_text())
    validators.validate("latest", latest)
    assert latest["mode"] == "aaa+eia"
    assert latest["aaa"]["as_of"] == "2026-09-17"
    assert latest["aaa"]["national"]["change"] == 0.022
    assert all("prev_missing" in r["flags"] for r in latest["states"])

    status = json.loads((tmp_path / "runner" / "run_status.json").read_text())
    assert status == result.status()
    assert result.commit_message == "data: AAA 2026-09-17; EIA 2026-09-14"

    # Next day: a new page with different prices gives real day over day moves.
    next_now = now + timedelta(days=1)
    http2 = aaa_http(day=1, as_of=date(2026, 9, 18), national=("6.140", "6.123"))
    result2, _ = run(tmp_path, {"AAA_ENABLED": "true"}, http2, sleeps, next_now, states, validators)
    assert result2.aaa.status == "ok"
    assert result2.eia.status == "not_modified"
    assert result2.commit_message == "data: AAA 2026-09-18"
    latest2 = json.loads((data / "latest.json").read_text())
    assert latest2["aaa"]["prev_as_of"] == "2026-09-17"
    assert latest2["aaa"]["gap_days"] == 1
    moved = [r for r in latest2["states"] if r["aaa"]["direction"] != "flat"]
    assert moved
    assert not any("prev_missing" in r["flags"] for r in latest2["states"])


def test_github_output_and_step_summary(tmp_path, sleeps, now, states, validators):
    out = tmp_path / "gh_output"
    summary = tmp_path / "gh_summary.md"
    out.write_text("existing=1\n")
    env = {"AAA_ENABLED": "true", "GITHUB_OUTPUT": str(out), "GITHUB_STEP_SUMMARY": str(summary)}
    run(tmp_path, env, aaa_http(), sleeps, now, states, validators)
    assert out.read_text() == "existing=1\ncommit_message=data: AAA 2026-09-17; EIA 2026-09-14\n"
    text = summary.read_text()
    assert "| AAA | ok |" in text and "| EIA | ok |" in text
    assert "prev_missing" in text
    for dash in ("—", "–", " - "):
        assert dash not in text


def test_local_status_file_goes_to_repo_root_without_runner_temp():
    assert pipeline.status_path({}) == Path(__file__).resolve().parents[1] / "run_status.json"
    assert pipeline.status_path({"RUNNER_TEMP": "/tmp/rt"}) == Path("/tmp/rt/run_status.json")


def test_eia_only_commit_message(tmp_path, sleeps, now, states, validators):
    result, _ = run(tmp_path, {}, eia_only_http(), sleeps, now, states, validators)
    assert result.commit_message == "data: EIA 2026-09-14"


# ---------------------------------------------------------------- idempotency


@pytest.mark.parametrize("env", [{}, {"AAA_ENABLED": "true"}, {"AAA_ENABLED": "true", "FORCE_AAA": "true"}])
def test_second_run_on_same_inputs_changes_nothing(tmp_path, sleeps, now, states, validators, env):
    run(tmp_path, env, aaa_http(), sleeps, now, states, validators)
    before = tree_hashes(tmp_path / "data")
    result, _ = run(tmp_path, env, aaa_http(), sleeps, now + timedelta(hours=3), states, validators)
    assert tree_hashes(tmp_path / "data") == before
    assert result.eia.status == "not_modified"
    assert result.latest_changed is False
    assert result.commit_message == "data: no changes"
    if env.get("FORCE_AAA") == "true":
        assert result.aaa.status == "noop"
    elif env:
        assert result.aaa.status == "skipped"


def test_idempotent_when_server_ignores_if_modified_since(tmp_path, sleeps, now, states, validators):
    run(tmp_path, {}, eia_only_http(), sleeps, now, states, validators)
    before = tree_hashes(tmp_path / "data")
    http = synth.FakeHttp().set(eia.XLS_URL, synth.xls_server(last_modified="Thu, 17 Sep 2026 15:00:00 GMT"))
    result, _ = run(tmp_path, {}, http, sleeps, now + timedelta(hours=3), states, validators)
    assert result.eia.status == "unchanged"
    assert tree_hashes(tmp_path / "data") == before


# ---------------------------------------------------------------- failure paths


def test_blocked_aaa_writes_nothing_but_eia_still_runs(tmp_path, sleeps, now, states, validators):
    http = eia_only_http().set(aaa.ALL_STATES_URL, synth.html_response("Forbidden", status=403))
    result, data = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now, states, validators)
    assert result.aaa.status == "blocked"
    assert result.eia.status == "ok"
    assert http.urls().count(aaa.ALL_STATES_URL) == 1
    assert aaa.HOMEPAGE_URL not in http.urls()
    assert not (data / "aaa" / "daily").exists()
    assert json.loads((data / "latest.json").read_text())["mode"] == "eia_only"


def test_invalid_page_writes_nothing(tmp_path, sleeps, now, states, validators):
    prices = synth.diesel_prices()
    del prices["WY"]
    http = eia_only_http().set(aaa.ALL_STATES_URL, synth.html_response(synth.all_states_html(prices)))
    result, data = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now, states, validators)
    assert result.aaa.status == "invalid"
    assert not (data / "aaa" / "daily").exists()


def test_homepage_failure_keeps_state_data(tmp_path, sleeps, now, states, validators):
    http = aaa_http().set(aaa.HOMEPAGE_URL, synth.html_response("Too many", status=429, url=aaa.HOMEPAGE_URL))
    result, data = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now, states, validators)
    assert result.aaa.status == "ok"
    assert any(w.startswith("national blocked") for w in result.warnings)
    snap = json.loads((data / "aaa" / "daily" / "2026-09-17.json").read_text())
    assert snap["national"] is None
    assert len(snap["diesel"]) == 51


def test_homepage_date_mismatch_gives_null_national(tmp_path, sleeps, now, states, validators):
    http = aaa_http()
    http.set(aaa.HOMEPAGE_URL, synth.html_response(synth.homepage_html(as_of=date(2026, 9, 16)), url=aaa.HOMEPAGE_URL))
    result, data = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now, states, validators)
    assert result.aaa.status == "ok"
    assert any("doesn't match" in w for w in result.warnings)
    assert json.loads((data / "aaa" / "daily" / "2026-09-17.json").read_text())["national"] is None


def test_noop_when_aaa_has_not_published(tmp_path, sleeps, now, states, validators):
    run(tmp_path, {"AAA_ENABLED": "true"}, aaa_http(), sleeps, now - timedelta(days=1), states, validators)
    # A day later AAA still shows the same date.
    before = tree_hashes(tmp_path / "data")
    http = aaa_http(day=1)
    result, _ = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now + timedelta(days=1), states, validators)
    assert result.aaa.status == "noop"
    assert aaa.HOMEPAGE_URL not in http.urls()
    assert tree_hashes(tmp_path / "data") == before


def test_divergence_warning(tmp_path, sleeps, now, states, validators):
    prices = synth.diesel_prices()
    prices["CA"] = synth.diesel_prices()["CA"] + 5  # far above the synthetic SCA price
    http = aaa_http().set(aaa.ALL_STATES_URL, synth.html_response(synth.all_states_html(prices)))
    result, _ = run(tmp_path, {"AAA_ENABLED": "true"}, http, sleeps, now, states, validators)
    assert any(w.startswith("eia_divergence: CA") for w in result.warnings)


# ---------------------------------------------------------------- CLI wiring


def test_update_data_cli(tmp_path, monkeypatch, capsys):
    import update_data

    import dailyfuel.http

    class Client(synth.FakeHttp):
        def __init__(self, allow_aaa=False):
            super().__init__()
            assert allow_aaa is False
            self.set(eia.XLS_URL, synth.xls_server())

    monkeypatch.setattr(dailyfuel.http, "RequestsClient", Client)
    for key in ("AAA_ENABLED", "FORCE_AAA", "GITHUB_STEP_SUMMARY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path / "rt"))
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "out"))
    assert update_data.main(["--data-dir", str(tmp_path / "data")]) == 0
    assert json.loads((tmp_path / "rt" / "run_status.json").read_text())["eia"] == "ok"
    assert (tmp_path / "out").read_text().startswith("commit_message=data: EIA ")
    assert (tmp_path / "data" / "latest.json").exists()
