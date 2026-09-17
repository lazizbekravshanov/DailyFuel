"""DailyFuel data pipeline.

Modules:
    paths    where the repo, schemas, states file and data live
    states   loads src/data/states.json
    http     injectable HTTP layer (tests never touch the network)
    store    deterministic JSON writing with schema validation
    eia      EIA weekly workbook, with the USDA mirror as a fallback
    aaa      AAA daily state averages (only runs when AAA_ENABLED is "true")
    derive   builds data/latest.json
    pipeline the job itself, used by scripts/update_data.py
    health   the checks used by scripts/health.py
"""

__all__ = ["paths", "states", "http", "store", "eia", "aaa", "derive", "pipeline", "health"]
