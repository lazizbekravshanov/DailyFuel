"""Builds tests/fixtures/blank_cell/, two small data folders where EIA left one
region's cell blank: newest/ has the Rocky Mountain cell (R40) blank in the
newest week, older/ has it blank in the week before.

The data job's check before commit (dailyfuel.health.build_problems) and the
site's own build check (src/lib/data.ts) both read these same files, in
tests/test_store_health_fixtures.py and src/lib/data.test.ts, so the two are
tested on identical input. The pytest side also rebuilds the folders and fails
if the pipeline would now write something different. Regenerate with:

    .venv/bin/python tests/fixtures/build_blank_cell.py

All prices are invented by a formula.
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from dailyfuel import derive, eia, store  # noqa: E402
from dailyfuel.paths import EIA_WEEKLY, LATEST  # noqa: E402
from dailyfuel.states import EIA_KEYS, load_states  # noqa: E402

OUT = Path(__file__).resolve().parent / "blank_cell"
PERIODS = ["2026-09-21", "2026-09-28", "2026-10-05"]
BLANK_KEY = "R40"
# folder name: the week whose BLANK_KEY cell is blank
CASES = {"newest": PERIODS[-1], "older": PERIODS[-2]}
GENERATED_AT = "2026-10-06T18:23:02Z"


def weekly_doc(blank_period: str) -> dict:
    weeks = []
    for i, period in enumerate(PERIODS):
        values = {}
        for j, key in enumerate(EIA_KEYS):
            price = Decimal("5.600") + Decimal(i) * Decimal("0.031") + Decimal(j) * Decimal("0.070")
            values[key] = None if (period == blank_period and key == BLANK_KEY) else store.num(price)
        weeks.append({"period": period, "values": values})
    return {
        "schema": eia.SCHEMA_ID,
        "source": "eia_xls",
        "source_url": eia.XLS_URL,
        "fetched_at": GENERATED_AT,
        "last_modified": "Tue, 06 Oct 2026 13:27:36 GMT",
        "release_date": "2026-10-06",
        "next_release_date": "2026-10-14",
        "weeks": weeks,
    }


def build(out: Path = OUT, v: store.Validators | None = None) -> None:
    states = load_states()
    for name, blank in CASES.items():
        doc = weekly_doc(blank)
        store.write_doc("eia-diesel-weekly", out / name / EIA_WEEKLY, doc, v)
        latest = derive.build_latest(states, doc, [], False, GENERATED_AT)
        store.write_doc("latest", out / name / LATEST, latest, v)


if __name__ == "__main__":
    build()
    print(f"wrote {OUT}")
