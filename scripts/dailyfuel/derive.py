"""Builds latest.json, the snapshot the website renders.

All money math uses Decimal. Floats only appear at the very end, when a value
is handed to the JSON encoder.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from . import aaa, eia, store
from .paths import LATEST, iso_utc
from .states import StateTable

SCHEMA_ID = "dailyfuel/latest/1"

AAA_CHANGE_STEP = Decimal("0.0001")
EIA_CHANGE_STEP = Decimal("0.001")
PCT_STEP = Decimal("0.01")
LARGE_MOVE = Decimal("0.50")
EIA_DIVERGENCE = Decimal("1.00")

FLAG_ORDER = ("gap", "large_move", "eia_divergence", "no_eia_survey", "prev_missing")


def aaa_enabled(env) -> bool:
    return env.get("AAA_ENABLED") == "true"


def move(price, prev, step: Decimal) -> dict:
    """price, prev, change, change_pct, direction for one series."""
    cur = store.dec(price)
    if prev is None:
        return {"price": store.num(cur), "prev": None, "change": None, "change_pct": None, "direction": None}
    before = store.dec(prev)
    raw = cur - before
    if raw > 0:
        direction = "up"
    elif raw < 0:
        direction = "down"
    else:
        direction = "flat"
    change = raw.quantize(step, rounding=ROUND_HALF_UP)
    pct = (change / before * 100).quantize(PCT_STEP, rounding=ROUND_HALF_UP) if before != 0 else None
    return {
        "price": store.num(cur),
        "prev": store.num(before),
        "change": store.num(change),
        "change_pct": None if pct is None else store.num(pct),
        "direction": direction,
    }


def _eia_section(doc: dict | None) -> tuple[dict | None, dict | None, dict | None]:
    """Returns (eia block, newest values, previous values)."""
    if not doc or len(doc.get("weeks") or []) < 1:
        return None, None, None
    weeks = doc["weeks"]
    cur = weeks[-1]
    prev = weeks[-2] if len(weeks) >= 2 else None
    us_prev = prev["values"]["NUS"] if prev else None
    block = {
        "period": cur["period"],
        "prev_period": prev["period"] if prev else None,
        "release_date": doc.get("release_date"),
        "next_release_date": doc.get("next_release_date"),
        "us": move(cur["values"]["NUS"], us_prev, EIA_CHANGE_STEP),
    }
    return block, cur["values"], (prev["values"] if prev else None)


def build_latest(
    states: StateTable,
    eia_doc: dict | None,
    snapshots: list[dict],
    enabled: bool,
    generated_at: str,
) -> dict:
    """snapshots: AAA daily docs, any order. Only the newest two matter."""
    eia_block, eia_cur, eia_prev = _eia_section(eia_doc)

    ordered = sorted(snapshots, key=lambda d: d["as_of"])
    mode = "aaa+eia" if enabled and ordered else "eia_only"
    cur_snap = ordered[-1] if mode == "aaa+eia" else None
    prev_snap = None
    if cur_snap is not None:
        earlier = [d for d in ordered if d["as_of"] < cur_snap["as_of"]]
        prev_snap = earlier[-1] if earlier else None

    aaa_block = None
    gap_days = None
    if cur_snap is not None:
        if prev_snap is not None:
            gap_days = (date.fromisoformat(cur_snap["as_of"]) - date.fromisoformat(prev_snap["as_of"])).days
        nat = cur_snap.get("national")
        aaa_block = {
            "as_of": cur_snap["as_of"],
            "prev_as_of": prev_snap["as_of"] if prev_snap else None,
            "gap_days": gap_days,
            "national": None if nat is None else move(nat["current"], nat["yesterday"], AAA_CHANGE_STEP),
        }

    rows = []
    for st in states.states:
        flags = set()
        eia_move = None
        if st.eia_series is None:
            flags.add("no_eia_survey")
        elif eia_cur is not None and eia_cur.get(st.eia_series) is not None:
            before = eia_prev.get(st.eia_series) if eia_prev else None
            eia_move = move(eia_cur[st.eia_series], before, EIA_CHANGE_STEP)

        aaa_move = None
        if cur_snap is not None:
            price = cur_snap["diesel"][st.code]
            before = prev_snap["diesel"].get(st.code) if prev_snap else None
            aaa_move = move(price, before, AAA_CHANGE_STEP)
            if before is None:
                flags.add("prev_missing")
            else:
                if gap_days is not None and gap_days > 1:
                    flags.add("gap")
                if abs(store.dec(price) - store.dec(before)) >= LARGE_MOVE:
                    flags.add("large_move")
            if eia_move is not None and abs(store.dec(price) - store.dec(eia_move["price"])) > EIA_DIVERGENCE:
                flags.add("eia_divergence")

        rows.append(
            {
                "code": st.code,
                "fips": st.fips,
                "name": st.name,
                "padd": st.padd,
                "eia_series": st.eia_series,
                "aaa": aaa_move,
                "eia": eia_move,
                "flags": [f for f in FLAG_ORDER if f in flags],
            }
        )

    return {
        "schema": SCHEMA_ID,
        "generated_at": generated_at,
        "mode": mode,
        "aaa": aaa_block,
        "eia": eia_block,
        "states": rows,
    }


def load_aaa_snapshots(data_dir: Path, limit: int = 2) -> list[dict]:
    dates = aaa.snapshot_dates(data_dir)
    return [aaa.load_snapshot(data_dir, d) for d in dates[-limit:]]


def rebuild(
    data_dir: Path,
    states: StateTable,
    enabled: bool,
    now: datetime,
    v: store.Validators | None = None,
) -> tuple[bool, dict]:
    """Rebuild latest.json. Writes (and bumps generated_at) only when the content changed."""
    data_dir = Path(data_dir)
    path = data_dir / LATEST
    eia_doc = eia.load(data_dir)
    snapshots = load_aaa_snapshots(data_dir) if enabled else []

    existing_text = store.read_text(path)
    existing_generated = None
    if existing_text is not None:
        try:
            existing_generated = store.read_json(path).get("generated_at")
        except ValueError:
            existing_generated = None

    if existing_generated:
        candidate = build_latest(states, eia_doc, snapshots, enabled, existing_generated)
        try:
            # Only a sanity check on a document that exists to be compared and
            # thrown away. A stored timestamp the schema rejects must not block
            # the rebuild two lines below that would replace it.
            (v or store.validators()).validate("latest", candidate)
        except store.SchemaError:
            existing_generated = None
        else:
            if store.dumps(candidate) == existing_text:
                return False, candidate

    doc = build_latest(states, eia_doc, snapshots, enabled, iso_utc(now))
    changed = store.write_doc("latest", path, doc, v)
    return changed, doc
