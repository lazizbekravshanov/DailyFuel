"""The scheduled data job. scripts/update_data.py is a thin wrapper around run()."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Mapping

from . import aaa, derive, eia, store
from .http import HttpClient
from .paths import DATA_DIR, REPO_ROOT, today_et, utc_now
from .states import StateTable, load_states


@dataclass
class RunResult:
    aaa: aaa.AaaResult
    eia: eia.EiaResult
    latest_changed: bool
    warnings: list[str] = field(default_factory=list)
    commit_message: str = ""

    def status(self) -> dict:
        return {"aaa": self.aaa.status, "eia": self.eia.status, "warnings": self.warnings}


def status_path(env: Mapping[str, str]) -> Path:
    runner_temp = env.get("RUNNER_TEMP")
    if runner_temp:
        return Path(runner_temp) / "run_status.json"
    return REPO_ROOT / "run_status.json"


def should_fetch_aaa(env: Mapping[str, str], latest_aaa, today) -> bool:
    if env.get("AAA_ENABLED") != "true":
        return False
    return latest_aaa is None or latest_aaa < today or env.get("FORCE_AAA") == "true"


def commit_message(result: RunResult) -> str:
    parts = []
    if result.aaa.changed and result.aaa.as_of:
        parts.append(f"AAA {result.aaa.as_of}")
    if result.eia.changed and result.eia.newest_period:
        parts.append(f"EIA {result.eia.newest_period}")
    if parts:
        return "data: " + "; ".join(parts)
    if result.latest_changed:
        return "data: rebuild latest.json"
    return "data: no changes"


def step_summary(result: RunResult, enabled: bool) -> str:
    aaa_detail = {
        "ok": f"new snapshot for {result.aaa.as_of}",
        "noop": f"AAA hasn't published past {result.aaa.as_of} yet",
        "skipped": "switched off" if not enabled else "already have today's snapshot",
        "blocked": "AAA blocked the request, nothing written",
        "invalid": "the page didn't pass checks, nothing written",
        "error": "couldn't reach AAA, nothing written",
    }.get(result.aaa.status, "")
    eia_detail = {
        "ok": f"new data, newest week {result.eia.newest_period}",
        "not_modified": f"workbook not modified, newest week {result.eia.newest_period}",
        "unchanged": f"workbook fetched, same data, newest week {result.eia.newest_period}",
        "fallback": f"used the USDA mirror, newest week {result.eia.newest_period}",
        "error": "workbook and USDA mirror both failed, nothing written",
    }.get(result.eia.status, "")
    lines = [
        "### DailyFuel data update",
        "",
        "| Source | Status | Detail |",
        "|---|---|---|",
        f"| AAA | {result.aaa.status} | {aaa_detail} |",
        f"| EIA | {result.eia.status} | {eia_detail} |",
        "",
        f"latest.json {'rebuilt' if result.latest_changed else 'unchanged'}. Commit message: `{result.commit_message}`",
        "",
    ]
    if result.warnings:
        lines.append("Warnings:")
        lines.append("")
        lines.extend(f"* {w}" for w in result.warnings)
    else:
        lines.append("No warnings.")
    return "\n".join(lines) + "\n"


def run(
    data_dir: Path | str = DATA_DIR,
    env: Mapping[str, str] | None = None,
    http: HttpClient | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: datetime | None = None,
    states: StateTable | None = None,
    validators: store.Validators | None = None,
) -> RunResult:
    import os

    env = dict(os.environ if env is None else env)
    data_dir = Path(data_dir)
    now = now or utc_now()
    today = today_et(now)
    states = states or load_states()
    v = validators or store.validators()
    enabled = derive.aaa_enabled(env)

    if http is None:
        from .http import RequestsClient

        http = RequestsClient(allow_aaa=enabled)

    # 1. AAA
    dates = aaa.snapshot_dates(data_dir)
    latest_aaa = dates[-1] if dates else None
    if should_fetch_aaa(env, latest_aaa, today):
        aaa_result = aaa.update(data_dir, http, sleep, now, today, states.codes, v)
    else:
        aaa_result = aaa.AaaResult("skipped", as_of=latest_aaa.isoformat() if latest_aaa else None)

    # 2. EIA
    eia_result = eia.update(data_dir, http, now, v)

    # 3. latest.json. Rebuilt from the stored inputs, written only when its content changes.
    latest_changed, latest = derive.rebuild(data_dir, states, enabled, now, v)

    warnings = list(aaa_result.warnings) + list(eia_result.warnings)
    if aaa_result.status == "ok":
        for row in latest["states"]:
            if "eia_divergence" in row["flags"] and row["aaa"] and row["eia"]:
                diff = store.dec(row["aaa"]["price"]) - store.dec(row["eia"]["price"])
                warnings.append(f"eia_divergence: {row['code']} AAA minus EIA {diff:+.4f}")

    result = RunResult(aaa=aaa_result, eia=eia_result, latest_changed=latest_changed, warnings=warnings)
    result.commit_message = commit_message(result)
    return result


def write_outputs(result: RunResult, env: Mapping[str, str]) -> Path:
    """Status file, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY."""
    path = status_path(env)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result.status(), indent=2) + "\n", encoding="utf-8")

    out = env.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"commit_message={result.commit_message}\n")

    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(step_summary(result, derive.aaa_enabled(env)))
    return path
