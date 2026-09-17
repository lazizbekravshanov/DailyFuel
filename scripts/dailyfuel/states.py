"""Loads the state mapping in src/data/states.json."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .paths import STATES_PATH

EIA_KEYS = ("NUS", "R10", "R1X", "R1Y", "R1Z", "R20", "R30", "R40", "R50", "SCA", "R5XCA")


@dataclass(frozen=True)
class State:
    code: str
    name: str
    fips: str
    padd: str
    eia_series: str | None


@dataclass(frozen=True)
class StateTable:
    states: tuple[State, ...]
    benchmarks: dict
    aggregates: dict

    @property
    def codes(self) -> frozenset[str]:
        return frozenset(s.code for s in self.states)

    def by_code(self, code: str) -> State:
        for s in self.states:
            if s.code == code:
                return s
        raise KeyError(code)


class StatesError(ValueError):
    pass


def load_states(path: Path | str = STATES_PATH) -> StateTable:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    benchmarks = raw.get("benchmarks") or {}
    aggregates = raw.get("aggregates") or {}
    states = []
    seen = set()
    for item in raw["states"]:
        code = item["code"]
        if code in seen:
            raise StatesError(f"duplicate state code {code}")
        seen.add(code)
        series = item.get("eia_series")
        if series is not None and series not in benchmarks:
            raise StatesError(f"{code} has unknown eia_series {series}")
        states.append(
            State(
                code=code,
                name=item["name"],
                fips=item["fips"],
                padd=item["padd"],
                eia_series=series,
            )
        )
    if len(states) != 51:
        raise StatesError(f"expected 51 states, found {len(states)}")
    for key in list(benchmarks) + list(aggregates):
        if key not in EIA_KEYS:
            raise StatesError(f"unknown EIA key {key}")
    return StateTable(states=tuple(states), benchmarks=benchmarks, aggregates=aggregates)
