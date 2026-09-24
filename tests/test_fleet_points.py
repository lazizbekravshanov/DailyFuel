"""Fleet points: the name rules, the sanitiser, dedupe, bounds, the boundaries, the state cross check, schema, idempotency and the leak test.

Everything here is synthetic: made up names and addresses, small square
states (as GeoJSON, TopoJSON and Census style KML) and CSVs written into
tmp_path. The seven border and coast points the coarse boundaries got wrong
are regression cases on squares drawn to put them on the same side of a
line as the real border. The committed data/map/fleet_points.json is
checked against its schema and for anything that looks like the CSV's text.
"""

from __future__ import annotations

import csv
import json
import os
import re
import zipfile
from pathlib import Path

import pytest

import import_fleet_points
from dailyfuel import fleetpoints, mapdata, store
from dailyfuel.paths import REPO_ROOT

# ---------------------------------------------------------------- synthetic geometry

DES_MOINES = (41.5868, -93.6250)
GRAND_FORKS = (47.9253, -97.0329)
WINNIPEG = (49.8951, -97.1384)
MOSCOW = (55.7558, 37.6173)

IA_RING = [(-96.64, 40.38), (-90.14, 40.38), (-90.14, 43.5), (-96.64, 43.5)]
ND_RING = [(-104.05, 45.94), (-96.55, 45.94), (-96.55, 49.0), (-104.05, 49.0)]

# One degree of latitude is about 111 km, so these are 10 m and 100 m steps.
M10 = 0.00009
M100 = 0.0009


def box(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def feature(name: str, *rings, multi: bool = False) -> dict:
    closed = [[list(p) for p in ring] + [list(ring[0])] for ring in rings]
    geometry = {"type": "MultiPolygon", "coordinates": [[r] for r in closed]} if multi else {"type": "Polygon", "coordinates": closed}
    return {"type": "Feature", "properties": {"name": name, "density": 1.0}, "geometry": geometry}


def _dot(i: int) -> list[tuple[float, float]]:
    lon = -170 + i * 0.01
    return [(lon, 70.0), (lon + 0.001, 70.0), (lon + 0.001, 70.001)]


def _other_state_rings(states, skip=("Iowa", "North Dakota")) -> dict[str, list[tuple[float, float]]]:
    """Every state but the ones drawn as a far away dot, so the boundaries are complete."""
    return {s.name: _dot(i) for i, s in enumerate(states.states) if s.name not in skip and s.code not in skip}


def two_state_geojson(states) -> dict:
    """Iowa and North Dakota as squares, every other state as a far away dot, Puerto Rico on top."""
    features = [feature("Iowa", IA_RING), feature("North Dakota", ND_RING), feature("Puerto Rico", [(-67, 18), (-65, 18), (-65, 19)])]
    for name, ring in _other_state_rings(states).items():
        features.append(feature(name, ring))
    return {"type": "FeatureCollection", "features": features}


def two_state_topology(states) -> dict:
    """The same states as an unquantized TopoJSON keyed by FIPS, the way us-atlas is."""
    fips = {s.name: s.fips for s in states.states}
    rings = {"Iowa": IA_RING, "North Dakota": ND_RING, **_other_state_rings(states)}
    arcs, geometries = [], []
    for name, ring in rings.items():
        geometries.append({"type": "Polygon", "id": fips[name], "properties": {"name": name}, "arcs": [[len(arcs)]]})
        arcs.append([list(p) for p in ring] + [list(ring[0])])
    geometries.append({"type": "Polygon", "id": "72", "properties": {"name": "Puerto Rico"}, "arcs": [[len(arcs)]]})
    arcs.append([[-67, 18], [-65, 18], [-65, 19], [-67, 18]])
    return {"type": "Topology", "objects": {"states": {"type": "GeometryCollection", "geometries": geometries}}, "arcs": arcs}


# Census style KML: one Placemark per state, its code in ExtendedData, one
# Polygon or a MultiGeometry of them, "lon,lat,alt" coordinates.

KML_NS = "http://www.opengis.net/kml/2.2"


def _coords(ring) -> str:
    return " ".join(f"{x},{y},0.0" for x, y in [*ring, ring[0]])


def kml_placemark(fields: dict, *polygons) -> str:
    """polygons: each a list of rings, the outer one first."""
    data = "".join(f'<SimpleData name="{k}">{v}</SimpleData>' for k, v in fields.items())
    polys = []
    for rings in polygons:
        inner = "".join(
            f"<innerBoundaryIs><LinearRing><coordinates>{_coords(r)}</coordinates></LinearRing></innerBoundaryIs>" for r in rings[1:]
        )
        polys.append(
            f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{_coords(rings[0])}</coordinates></LinearRing>"
            f"</outerBoundaryIs>{inner}</Polygon>"
        )
    geometry = polys[0] if len(polys) == 1 else f"<MultiGeometry>{''.join(polys)}</MultiGeometry>"
    return (
        f"<Placemark><name>state</name><ExtendedData><SchemaData schemaUrl=\"#s\">{data}</SchemaData></ExtendedData>"
        f"{geometry}</Placemark>"
    )


def kml_document(placemarks: list[str]) -> bytes:
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="{KML_NS}"><Document><Folder>'
        + "".join(placemarks)
        + "</Folder></Document></kml>"
    ).encode("utf-8")


def regression_polygons(coarse: bool = False) -> dict[str, list[list[list[tuple[float, float]]]]]:
    """Squares that put each regression point on the side of a line the real border puts it.

    The Mississippi between Vicksburg and Delta runs east of the I-20 pair,
    and between Memphis and West Memphis east of the three AR pins; Key
    Largo's pin is 400 m off the drawn coast; Aquidneck Island is its own
    polygon of Rhode Island, with a hole. coarse moves the rivers west,
    the coast 1.9 km out and drops the island, the way the old 89 KB file
    did.
    """
    if coarse:
        return {
            "LA": [[box(-91.20, 32.10, -91.00, 32.50)]],
            "MS": [[box(-91.00, 32.10, -90.60, 32.50)]],
            "AR": [[box(-90.40, 34.95, -90.15, 35.35)]],
            "TN": [[box(-90.15, 34.95, -89.80, 35.35)]],
            "FL": [[box(-80.80, 24.80, -80.60, 25.10)]],
            "RI": [[box(-71.80, 41.30, -71.40, 42.00)]],
            "MA": [[box(-71.40, 41.70, -70.90, 42.10)]],
        }
    return {
        "LA": [[box(-91.20, 32.10, -90.91, 32.50)]],
        "MS": [[box(-90.91, 32.10, -90.60, 32.50)]],
        "AR": [[box(-90.40, 34.95, -90.08, 35.35)]],
        "TN": [[box(-90.08, 34.95, -89.80, 35.35)]],
        "FL": [[box(-80.80, 24.80, -80.585, 25.10)]],
        "RI": [[box(-71.80, 41.30, -71.40, 42.00)], [box(-71.38, 41.45, -71.20, 41.65), box(-71.30, 41.55, -71.25, 41.60)]],
        "MA": [[box(-71.40, 41.70, -70.90, 42.10)]],
    }


def regression_kml(states, coarse: bool = False) -> bytes:
    """The regression squares plus every other state as a far away dot, and Puerto Rico.

    Tennessee is named by STATEFP alone and Mississippi by NAME alone, the
    fallbacks when STUSPS is missing.
    """
    drawn = regression_polygons(coarse)
    placemarks = []
    for i, s in enumerate(states.states):
        fields = {"STATEFP": s.fips, "STUSPS": s.code, "NAME": s.name}
        if s.code == "TN":
            fields = {"STATEFP": s.fips}
        elif s.code == "MS":
            fields = {"NAME": s.name}
        placemarks.append(kml_placemark(fields, *drawn.get(s.code, [[_dot(i)]])))
    placemarks.append(kml_placemark({"STATEFP": "72", "STUSPS": "PR", "NAME": "Puerto Rico"}, [box(-67, 18, -65, 19)]))
    return kml_document(placemarks)


# The seven pins the coarse boundaries got wrong: the Vicksburg I-20 pair
# (LA), three West Memphis pins (AR), Key Largo (FL) and Aquidneck Island
# (RI). Addresses are made up; only the state before the ZIP matters.
REGRESSION_POINTS = [
    ("EB weigh station", 32.32031, -90.94781, "LA"),
    ("WB weigh station", 32.31956, -90.94781, "LA"),
    ("weigh station", 35.14094, -90.10469, "AR"),
    ("ta", 35.15383, -90.13696, "AR"),
    ("speedco", 35.15405, -90.12939, "AR"),
    ("weigh station", 24.95481, -80.58106, "FL"),
    ("weigh station", 41.51081, -71.36569, "RI"),
]
MADE_UP_ZIPS = {"LA": "71000", "AR": "72000", "FL": "33000", "RI": "02800"}


def regression_rows() -> list[fleetpoints.Row]:
    return [
        row(i, name, lat, lon, address=f"1 Sample Rd, Sample Town, {st} {MADE_UP_ZIPS[st]}, \u0421\u0428\u0410")
        for i, (name, lat, lon, st) in enumerate(REGRESSION_POINTS, start=1)
    ]


@pytest.fixture(scope="module")
def boundaries(states):
    return fleetpoints.boundaries_from_geojson(two_state_geojson(states), states)


@pytest.fixture(scope="module")
def census_like(states):
    return fleetpoints.boundaries_from_kml(regression_kml(states), states)


@pytest.fixture(scope="module")
def map_validators():
    return mapdata.MapValidators()


def row(number: int, name: str, lat: float, lon: float, address: str = "Somewhere, IA, \u0421\u0428\u0410", notes: str = "") -> fleetpoints.Row:
    return fleetpoints.Row(number, name, address, lat, lon, notes)


def write_csv(path: Path, rows: list[dict]) -> Path:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fleetpoints.COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in fleetpoints.COLUMNS})
    return path


def shape(doc: dict) -> list[tuple]:
    return [(p["category"], p["direction"], p["state"], p["label"]) for p in doc["points"]]


def no_counts(**kw) -> dict:
    return {c: kw.get(c, 0) for c in fleetpoints.CATEGORIES}


# ---------------------------------------------------------------- the name rules


@pytest.mark.parametrize(
    "name, category, directions",
    [
        ("weight station", "weigh", (None,)),
        ("Weigh Station", "weigh", (None,)),
        ("  WB   weight station ", "weigh", ("WB",)),
        ("eb weigh station", "weigh", ("EB",)),
        ("NB and SB weight station", "weigh", ("NB", "SB")),
        ("truck scale", "weigh", (None,)),
        ("check point", "weigh", (None,)),
        ("checkpoint sb", "weigh", ("SB",)),
        ("westbound scales", "weigh", ("WB",)),
        ("dot inspection", "inspection", (None,)),
        ("DOT ins[ection", "inspection", (None,)),
        ("dot inspection and rest area", "inspection", (None,)),
        ("agricultural inspection station", "inspection", (None,)),
        ("inspection area", "inspection", (None,)),  # an inspection area is an inspection station
        ("inspection area nb", "inspection", ("NB",)),
        ("port of entry", "port_of_entry", (None,)),
        ("port entry", "port_of_entry", (None,)),
        ("sample udot port of entry", "port_of_entry", (None,)),
        ("POE eb", "port_of_entry", ("EB",)),
        ("ta", "ta", (None,)),
        ("TA", "ta", (None,)),
        ("ta truck stop", "ta", (None,)),
        ("petro", "petro", (None,)),
        ("Petro Tire Shop", "petro", (None,)),
        ("perto", "petro", (None,)),
        ("loves shop", "loves_shop", (None,)),
        ("Love's Shop", "loves_shop", (None,)),
        ("loves  shop", "loves_shop", (None,)),
        ("Love’s shop", "loves_shop", (None,)),
        ("speedco", "speedco", (None,)),
        ("SpeedCo", "speedco", (None,)),
        ("lubezone truck lube center (oil change)", "lubezone", (None,)),
        ("Lube Zone", "lubezone", (None,)),
        ("pro fleet oil change", "profleet", (None,)),
        ("profleet truck lube center", "profleet", (None,)),
        ("ProFleet lube", "profleet", (None,)),
    ],
)
def test_keep_rules(name, category, directions):
    d = fleetpoints.categorize(name)
    assert d.kept and d.category == category and d.directions == directions and d.reason is None


@pytest.mark.parametrize(
    "name, reason",
    [
        ("", "empty name"),
        ("   ", "empty name"),
        ("sample truck shop \u0440\u0443\u0441", "cyrillic text in name"),
        ("\u0448\u0438\u043d\u0430 \u0441\u0435\u0440\u0432\u0438\u0441 99$", "cyrillic text in name"),
        ("weight station \u0440\u0443\u0441\u0441\u043a\u0438\u0439", "cyrillic text in name"),  # a keep word never saves a Cyrillic name
        ("99 $ tire", "price in name"),
        ("tire for 99$", "price in name"),
        ("tire shop price for steer tire", "price in name"),
        ("weigh station 99$", "price in name"),  # nor a priced one
        ("sample mehanic any job 50 dollars", "price in name"),
        ("sample tires 555 123 4567", "phone style number in name"),
        ("call 5551234567 scale", "phone style number in name"),
        ("sample carriers inc", "company name"),
        ("example trucking inc", "company name"),
        ("sample holdings llc", "company name"),
        ("sample trucking 24 hrs", "company name"),
        ("tarp", "tarp"),
        ("tarps", "tarp"),
        ("yard", "yard"),
        ("toll road note i 90", "toll road note"),
        ("need to check with the driver about i 80", "driver note"),
        ("towing", "towing"),
        ("sample towing and recovery", "towing"),
        ("sample auto glass", "glass shop"),
        ("sample parking welding", "parking"),
        ("sample truck trailer repair, llc", "repair or tire shop"),
        ("tire scale house", "repair or tire shop"),  # scale with tire is a tire shop, not a weigh station
        ("sample tire 24 hour", "repair or tire shop"),
        ("sample fleet services", "repair or tire shop"),
        ("sample def electric mehanic", "repair or tire shop"),
        ("sample trailer", "repair or tire shop"),
        ("tarps sample \u0440\u0443\u0441\u0441\u043a\u0438\u0439", "cyrillic text in name"),
        ("sample engineering", fleetpoints.NO_RULE),
        ("oregon", fleetpoints.NO_RULE),
        ("sample place", fleetpoints.NO_RULE),
        ("public safety", fleetpoints.NO_RULE),
    ],
)
def test_drop_rules(name, reason):
    d = fleetpoints.categorize(name)
    assert not d.kept and d.category is None and d.directions == () and d.reason == reason


def test_service_chains_never_carry_a_direction():
    assert fleetpoints.categorize("ta nb").directions == (None,)
    assert fleetpoints.categorize("speedco wb").directions == (None,)


@pytest.mark.parametrize(
    "name, directions",
    [
        ("weight station", ()),
        ("WB weight station", ("WB",)),
        ("sb weigh station", ("SB",)),
        ("nb and sb weight station", ("NB", "SB")),
        ("nb/sb weight station", ("NB", "SB")),
        ("NB & SB scales", ("NB", "SB")),
        ("eb eb weight station", ("EB",)),
        ("eastbound weigh station", ("EB",)),
        ("Southbound and Northbound", ("SB", "NB")),
        ("webster scale", ()),  # wb inside a word is not a direction
        ("club scale", ()),
    ],
)
def test_parse_directions(name, directions):
    assert fleetpoints.parse_directions(name) == directions


# ---------------------------------------------------------------- the sanitiser


def test_labels_come_from_the_table_only():
    assert fleetpoints.label_for("weigh", "WB") == "Weigh station, westbound"
    assert fleetpoints.label_for("weigh", None) == "Weigh station"
    assert fleetpoints.label_for("inspection", "NB") == "Inspection station, northbound"
    assert fleetpoints.label_for("port_of_entry", "EB") == "Port of entry, eastbound"
    assert fleetpoints.label_for("loves_shop", None) == "Love's shop"
    assert fleetpoints.label_for("profleet", None) == "ProFleet lube"
    for category in fleetpoints.CATEGORIES:
        assert fleetpoints.label_for(category, None) == fleetpoints.LABELS[category]
    with pytest.raises(KeyError):
        fleetpoints.label_for("weigh", "XB")


def test_points_carry_nothing_from_the_name_address_or_notes(boundaries):
    rows = [
        row(1, "WB weight station SECRETNAME", *DES_MOINES, address="SECRETADDRESS, Des Moines, IA 50309", notes="SECRETNOTE"),
        row(2, "loves shop SECRETNAME", *GRAND_FORKS, address="SECRETADDRESS", notes="SECRETNOTE, ND 58201"),
    ]
    doc = fleetpoints.build(rows, boundaries, "2026-09-23").doc
    text = json.dumps(doc)
    assert "SECRET" not in text and "50309" not in text and "58201" not in text
    assert [p["label"] for p in doc["points"]] == ["Weigh station, westbound", "Love's shop"]
    for p in doc["points"]:
        assert set(p) == {"lat", "lon", "category", "direction", "state", "label"}
    for column in fleetpoints.COLUMNS:  # no CSV column is ever a key
        assert f'"{column}"' not in text and f'"{column.lower()}"' not in text


def test_the_document_names_no_owner_fleet_or_export_and_counts_only_categories(boundaries):
    doc = fleetpoints.build([row(1, "weight station", *DES_MOINES), row(2, "tarp", *DES_MOINES)], boundaries, "2026-09-23").doc
    assert doc["source"] == "Weigh station and truck service points compiled by DailyFuel"
    assert doc["attribution"] == "Weigh station and truck service points: DailyFuel"
    assert doc["counts"] == no_counts(weigh=1)  # nothing about how many rows the CSV had, dropped or folded
    for key in ("source", "attribution", "licence"):
        assert not re.search(r"fleet|owner|export|geofence", doc[key], re.I)
    schema = json.loads((REPO_ROOT / "schemas" / "map-fleet-points.schema.json").read_text(encoding="utf-8"))
    for key in ("title", "description"):
        assert not re.search(r"fleet|owner|export|geofence", schema[key], re.I)
    assert schema["properties"]["source"]["const"] == fleetpoints.SOURCE


# ---------------------------------------------------------------- build


def test_build_categorises_dedupes_and_sorts(boundaries):
    dm = DES_MOINES
    rows = [
        row(1, "loves shop", *dm),
        row(2, "weight station", *dm),
        row(3, "weight station", dm[0] + 0.0000004, dm[1]),  # the same pin after rounding
        row(4, "WB weight station", *dm),  # a direction the others at this spot do not say: the pin has none
        row(5, "EB weight station", dm[0] + 0.001, dm[1]),  # the other side of the road, 110 m away
        row(6, "nb and sb weight station", *GRAND_FORKS),  # both directions at one spot: one pin, no direction
        row(7, "tarp", *dm),
        row(8, "ta", *GRAND_FORKS),
        row(9, "ta", *GRAND_FORKS),
    ]
    built = fleetpoints.build(rows, boundaries, "2026-09-23")
    doc = built.doc
    assert doc["dedupe_m"] == fleetpoints.DEDUPE_M == 25
    assert doc["counts"] == no_counts(weigh=3, ta=1, loves_shop=1)
    assert built.stats == {"rows": 9, "dropped": 1, "duplicates": 4, "near_duplicates": 0, "no_state": 0, "checkable": 0}
    assert shape(doc) == [
        ("weigh", None, "IA", "Weigh station"),
        ("weigh", None, "ND", "Weigh station"),
        ("weigh", "EB", "IA", "Weigh station, eastbound"),
        ("ta", None, "ND", "TA"),
        ("loves_shop", None, "IA", "Love's shop"),
    ]
    assert doc["points"][0]["lat"] == 41.5868 and doc["points"][0]["lon"] == -93.625
    assert [(d.number, d.reason) for d in built.dropped] == [(7, "tarp")]
    assert built.dropped[0].name == "tarp" and built.dropped[0].address.startswith("Somewhere")


def test_pins_at_one_spot_fold_and_lose_a_direction_they_disagree_on(boundaries):
    dm = DES_MOINES

    def points(*names):
        doc = fleetpoints.build([row(i, n, *dm) for i, n in enumerate(names, start=1)], boundaries, "2026-09-23").doc
        return [(p["direction"], p["label"]) for p in doc["points"]]

    assert points("nb weight station", "nb weigh station") == [("NB", "Weigh station, northbound")]
    assert points("weight station", "weigh station") == [(None, "Weigh station")]
    assert points("sb weigh station", "nb weight station") == [(None, "Weigh station")]  # two directions: none
    assert points("weight station", "nb weight station") == [(None, "Weigh station")]  # a direction and none: none
    assert points("nb weight station", "weight station") == [(None, "Weigh station")]  # in either order
    assert points("nb and sb weight station") == [(None, "Weigh station")]
    assert points("POE eb", "port of entry wb") == [(None, "Port of entry")]
    assert points("weight station", "dot inspection") == [(None, "Weigh station"), (None, "Inspection station")]  # categories never fold


def test_pins_within_25_m_of_one_category_and_direction_fold(boundaries):
    dm = DES_MOINES
    rows = [
        row(1, "WB weight station", *dm),
        row(2, "WB weight station", dm[0] + M10, dm[1]),  # 10 m north: the same station
        row(3, "WB weight station", dm[0], dm[1] + M10),  # 7 m east: the same station
        row(4, "WB weight station", dm[0] + M100, dm[1]),  # 100 m north: another
        row(5, "EB weight station", dm[0] + M10, dm[1] + M10),  # the other direction stays its own pin
        row(6, "weight station", dm[0] + M10, dm[1] - M10),  # and so does an undirected one
        row(7, "ta", *dm),
        row(8, "ta", dm[0] + M10, dm[1]),
        row(9, "speedco", dm[0] + M10, dm[1]),
    ]
    built = fleetpoints.build(rows, boundaries, "2026-09-23")
    assert built.stats["duplicates"] == 0 and built.stats["near_duplicates"] == 3
    assert [(p["category"], p["direction"], p["lat"]) for p in built.doc["points"]] == [
        ("weigh", None, round(dm[0] + M10, 5)),
        ("weigh", "EB", round(dm[0] + M10, 5)),
        ("weigh", "WB", dm[0]),  # the first of the cluster in (lat, lon) order is the one kept
        ("weigh", "WB", round(dm[0] + M100, 5)),
        ("ta", None, dm[0]),
        ("speedco", None, round(dm[0] + M10, 5)),
    ]
    # The same rows in reverse fold the same way and keep the same pins.
    again = fleetpoints.build(rows[::-1], boundaries, "2026-09-23")
    assert store.dumps(again.doc) == store.dumps(built.doc)
    # The radius is the document's: a wider one folds the 100 m pin too.
    wide = fleetpoints.build(rows, boundaries, "2026-09-23", dedupe_m=150)
    assert wide.doc["dedupe_m"] == 150 and wide.stats["near_duplicates"] == 4


def test_pins_far_apart_all_stay(boundaries):
    # A long run of one category and direction, 100 m apart in a line: the
    # near dedupe looks back past each pin and must keep every one.
    rows = [row(i, "WB weight station", DES_MOINES[0] + i * M100, DES_MOINES[1]) for i in range(1, 41)]
    rows += [row(100 + i, "ta", DES_MOINES[0] + i * 0.1, DES_MOINES[1] + i * 0.01) for i in range(1, 11)]
    built = fleetpoints.build(rows, boundaries, "2026-09-23")
    assert built.doc["counts"] == no_counts(weigh=40, ta=10)
    assert built.stats["near_duplicates"] == 0 and len(built.doc["points"]) == 50


def test_build_is_deterministic_whatever_the_input_order(boundaries):
    rows = [
        row(1, "speedco", *GRAND_FORKS), row(2, "weight station", *DES_MOINES), row(3, "EB weight station", *DES_MOINES),
        row(4, "petro", *DES_MOINES), row(5, "SB weigh station", *GRAND_FORKS),
    ]
    a = fleetpoints.build(rows, boundaries, "2026-09-23").doc
    b = fleetpoints.build(rows[::-1], boundaries, "2026-09-23").doc
    assert store.dumps(a) == store.dumps(b)


def test_coordinates_are_rounded_to_five_decimals(boundaries):
    doc = fleetpoints.build([row(1, "ta", 41.58681234567, -93.62504999999)], boundaries, "2026-09-23").doc
    assert doc["points"][0]["lat"] == 41.58681 and doc["points"][0]["lon"] == -93.62505
    assert doc["points"][0]["lat"] == round(doc["points"][0]["lat"], mapdata.COORD_DECIMALS)


def test_us_bounds_and_the_state_test(boundaries):
    rows = [
        row(1, "weight station", *DES_MOINES),
        row(2, "weight station", *WINNIPEG),  # inside the bounds, in no state: kept with state null
        row(3, "weight station", *MOSCOW),  # outside the bounds: dropped
        row(4, "weight station", None, -93.0),  # no coordinate: dropped
    ]
    built = fleetpoints.build(rows, boundaries, "2026-09-23")
    assert [(p["state"], p["lat"]) for p in built.doc["points"]] == [("IA", 41.5868), (None, 49.8951)]
    assert built.stats["no_state"] == 1
    assert [(d.number, d.reason) for d in built.dropped] == [(3, "outside the US bounds"), (4, "bad coordinates")]
    assert fleetpoints.in_bounds(21.3, -157.8)  # Honolulu
    assert fleetpoints.in_bounds(64.8, -147.7)  # Fairbanks
    assert fleetpoints.in_bounds(19.4, -99.1)  # Mexico City is inside the box; only the state test tells it apart
    assert not fleetpoints.in_bounds(51.5, -0.1)  # London
    assert not fleetpoints.in_bounds(49.8951, 97.1384)  # a sign slip on Winnipeg's longitude


# ---------------------------------------------------------------- the state cross check


def test_state_hints_read_a_state_before_a_zip_and_nothing_else(boundaries):
    codes = boundaries.codes
    assert codes >= {"IA", "ND", "CA", "DC"} and len(codes) == 51
    assert fleetpoints.state_hints("Sample station, Sample Town, UT 84000, \u0421\u0428\u0410", codes) == {"UT"}
    assert fleetpoints.state_hints("1 Main St, Des Moines, IA 50309 Sample Township, IL 62000", codes) == {"IA", "IL"}
    assert fleetpoints.state_hints("Sample Rd, IA 50309-1234", codes) == {"IA"}
    assert fleetpoints.state_hints("WCHH+V2, \u0418\u043b\u043b\u0438\u043d\u043e\u0439\u0441, \u0421\u0428\u0410", codes) == frozenset()
    assert fleetpoints.state_hints("US 30, box 12345", codes) == frozenset()  # not a state
    assert fleetpoints.state_hints("PR 00901", codes) == frozenset()  # not one of the 51
    assert fleetpoints.state_hints("ia 50309, IA 5030, IA50309", codes) == frozenset()  # only the exact form
    assert fleetpoints.state_hints("", codes) == frozenset()


def test_the_assigned_state_is_checked_against_the_csv_zip(boundaries):
    dm, gf = DES_MOINES, GRAND_FORKS
    rows = [
        row(1, "weight station", *dm, address="Des Moines, IA 50309"),  # agrees
        row(2, "weight station", *gf, address="Across the river, MN 56560", notes="Grand Forks, ND 58201"),  # one hint agrees
        row(3, "ta", *gf, address="Moorhead, MN 56560"),  # disagrees alone
        row(4, "ta", gf[0] + M10, gf[1], address="Fargo, ND 58102"),  # folds into row 3 at 10 m, and its hint agrees
        row(5, "speedco", *WINNIPEG, address="Winnipeg, MB R3C 4T3", notes="near the ND 58225 line"),  # no state, hinted
        row(6, "petro", *dm),  # nothing to check
    ]
    built = fleetpoints.build(rows, boundaries, "2026-09-23")
    assert built.stats["checkable"] == 4
    # Rows 3 and 4 are one pin whose hints are MN and ND, and ND is one of them: no mismatch.
    assert built.mismatches == [fleetpoints.Mismatch((5,), WINNIPEG[0], WINNIPEG[1], None, ("ND",))]
    assert [p["state"] for p in built.doc["points"]] == ["IA", "ND", "ND", "IA", None]
    assert "MN" not in json.dumps(built.doc) and "56560" not in json.dumps(built.doc)


def test_a_real_disagreement_is_reported(boundaries):
    built = fleetpoints.build([row(1, "ta", *GRAND_FORKS, address="Moorhead, MN 56560")], boundaries, "2026-09-23")
    assert built.mismatches == [fleetpoints.Mismatch((1,), GRAND_FORKS[0], GRAND_FORKS[1], "ND", ("MN",))]
    lines = []
    import_fleet_points.report(built, Path("/nonexistent"), out=lines.append)
    assert any("1 of 1 points carry a state and ZIP in the CSV, 1 disagree" in line for line in lines)
    assert any(line.strip() == f"{GRAND_FORKS[0]},{GRAND_FORKS[1]} assigned ND, the CSV says MN (row 1)" for line in lines)
    assert "Moorhead" not in "\n".join(lines) and "56560" not in "\n".join(lines)


# ---------------------------------------------------------------- the seven border and coast points


def test_the_seven_border_and_coast_points_land_in_their_states(census_like):
    built = fleetpoints.build(regression_rows(), census_like, "2026-09-23")
    assert {(p["lat"], p["lon"]): p["state"] for p in built.doc["points"]} == {
        (lat, lon): st for _, lat, lon, st in REGRESSION_POINTS
    }
    assert built.stats["checkable"] == 7 and built.stats["no_state"] == 0 and built.mismatches == []


def test_the_1_km_tolerance_brings_a_causeway_pin_back_and_nothing_further(census_like):
    key_largo = (24.95481, -80.58106)
    assert census_like.state_of(*key_largo) is None  # 400 m off the drawn coast
    assert census_like.state_of(*key_largo, tolerance_km=fleetpoints.STATE_TOLERANCE_KM) == "FL"
    assert census_like.state_of(24.95481, -80.57, tolerance_km=fleetpoints.STATE_TOLERANCE_KM) is None  # 1.5 km out
    strict = fleetpoints.build(regression_rows(), census_like, "2026-09-23", tolerance_km=0)
    assert strict.stats["no_state"] == 1
    assert strict.mismatches == [fleetpoints.Mismatch((6,), *key_largo, None, ("FL",))]


def test_islands_are_polygons_of_their_own_and_holes_are_not_inside(census_like):
    assert census_like.state_of(41.51081, -71.36569) == "RI"  # Aquidneck, the second polygon of RI
    assert census_like.state_of(41.575, -71.275) is None  # the hole in it
    assert census_like.state_of(41.8, -71.6) == "RI"  # the mainland
    assert census_like.state_of(41.9, -71.1) == "MA"


def test_the_cross_check_catches_coarse_boundaries(states):
    coarse = fleetpoints.boundaries_from_kml(regression_kml(states, coarse=True), states)
    built = fleetpoints.build(regression_rows(), coarse, "2026-09-23")
    # The five wrong states and the two nulls the verifier found, one line each.
    assert sorted((m.rows, m.state, m.hints) for m in built.mismatches) == [
        ((1,), "MS", ("LA",)),
        ((2,), "MS", ("LA",)),
        ((3,), "TN", ("AR",)),
        ((4,), "TN", ("AR",)),
        ((5,), "TN", ("AR",)),
        ((6,), None, ("FL",)),
        ((7,), None, ("RI",)),
    ]
    assert built.stats["no_state"] == 2


@pytest.mark.skipif(not os.environ.get("DAILYFUEL_STATES_KML"), reason="set DAILYFUEL_STATES_KML to the Census cb_2023_us_state_500k .zip or .kml")
def test_the_real_census_file_puts_the_seven_points_right(states):
    real = fleetpoints.load_boundaries(os.environ["DAILYFUEL_STATES_KML"], states)
    assert len(real.codes) == 51
    for _, lat, lon, st in REGRESSION_POINTS:
        assert real.state_of(lat, lon, tolerance_km=fleetpoints.STATE_TOLERANCE_KM) == st, (lat, lon)


# ---------------------------------------------------------------- boundaries


def test_boundaries_from_kml_reads_census_style_placemarks(states, census_like):
    assert len(census_like.codes) == 51 and "PR" not in census_like.codes
    assert census_like.state_of(18.5, -66.0) is None  # Puerto Rico is not a state here
    assert census_like.state_of(32.3, -90.7) == "MS"  # named by NAME alone
    assert census_like.state_of(35.1, -89.9) == "TN"  # named by STATEFP alone
    # A KML without a namespace reads the same.
    plain = regression_kml(states).replace(f' xmlns="{KML_NS}"'.encode(), b"")
    assert fleetpoints.boundaries_from_kml(plain, states).state_of(32.32031, -90.94781) == "LA"


def test_boundaries_from_kml_refuses_a_missing_state_or_a_broken_file(states):
    doc = regression_kml(states).replace(b'<SimpleData name="STUSPS">LA</SimpleData>', b"")
    doc = doc.replace(b'<SimpleData name="NAME">Louisiana</SimpleData>', b"").replace(b'<SimpleData name="STATEFP">22</SimpleData>', b"")
    with pytest.raises(fleetpoints.FleetError, match="LA"):
        fleetpoints.boundaries_from_kml(doc, states)
    with pytest.raises(fleetpoints.FleetError, match="not KML"):
        fleetpoints.boundaries_from_kml(b"<kml><Document>", states)
    with pytest.raises(fleetpoints.FleetError, match="not a number"):
        fleetpoints.boundaries_from_kml(regression_kml(states).replace(b"-91.2,32.1,0.0", b"west,32.1,0.0"), states)


def test_load_boundaries_takes_the_census_zip_or_kml(tmp_path, states):
    kml = tmp_path / "cb_2023_us_state_500k.kml"
    kml.write_bytes(regression_kml(states))
    zipped = tmp_path / "cb_2023_us_state_500k.zip"
    with zipfile.ZipFile(zipped, "w") as z:
        z.write(kml, kml.name)
        z.writestr("cb_2023_us_state_500k.kml.iso.xml", "<metadata/>")
    for path in (kml, zipped):
        b = fleetpoints.load_boundaries(path, states)
        assert b.state_of(35.14094, -90.10469) == "AR" and len(b.codes) == 51
    empty = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("readme.txt", "no kml here")
    with pytest.raises(fleetpoints.FleetError, match="0 .kml files"):
        fleetpoints.load_boundaries(empty, states)
    fake = tmp_path / "fake.zip"
    fake.write_text("not a zip", encoding="utf-8")
    with pytest.raises(fleetpoints.FleetError, match="not a zip"):
        fleetpoints.load_boundaries(fake, states)
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    with pytest.raises(fleetpoints.FleetError, match="not KML"):
        fleetpoints.load_boundaries(broken, states)


def test_boundaries_from_geojson_reads_polygons_and_multipolygons_and_skips_territories(states):
    doc = two_state_geojson(states)
    # Make North Dakota a MultiPolygon of two halves.
    west = [(-104.05, 45.94), (-100.0, 45.94), (-100.0, 49.0), (-104.05, 49.0)]
    east = [(-100.0, 45.94), (-96.55, 45.94), (-96.55, 49.0), (-100.0, 49.0)]
    doc["features"] = [f for f in doc["features"] if f["properties"]["name"] != "North Dakota"]
    doc["features"].append(feature("North Dakota", west, east, multi=True))
    b = fleetpoints.boundaries_from_geojson(doc, states)
    assert b.state_of(*DES_MOINES) == "IA"
    assert b.state_of(*GRAND_FORKS) == "ND"
    assert b.state_of(47.0, -102.0) == "ND"
    assert b.state_of(*WINNIPEG) is None
    assert b.state_of(18.3, -66.0) is None  # Puerto Rico is not a state here


def test_boundaries_from_geojson_refuses_a_missing_state(states):
    doc = two_state_geojson(states)
    doc["features"] = [f for f in doc["features"] if f["properties"]["name"] != "Iowa"]
    with pytest.raises(fleetpoints.FleetError, match="IA"):
        fleetpoints.boundaries_from_geojson(doc, states)
    with pytest.raises(fleetpoints.FleetError, match="FeatureCollection"):
        fleetpoints.boundaries_from_geojson({"type": "Feature"}, states)
    with pytest.raises(fleetpoints.FleetError, match="FeatureCollection"):
        fleetpoints.boundaries_from_geojson(["not", "a", "document"], states)


def test_load_boundaries_takes_a_us_atlas_topology_or_a_geojson(tmp_path, states):
    topo_path = tmp_path / "states-10m.json"
    topo_path.write_text(json.dumps(two_state_topology(states)), encoding="utf-8")
    geo_path = tmp_path / "states.geojson"
    geo_path.write_text(json.dumps(two_state_geojson(states)), encoding="utf-8")
    for path in (topo_path, geo_path):
        b = fleetpoints.load_boundaries(path, states)
        assert b.state_of(*DES_MOINES) == "IA" and b.state_of(*GRAND_FORKS) == "ND"
        assert b.state_of(*WINNIPEG) is None and b.state_of(18.3, -66.0) is None
        assert len(b.codes) == 51
    topo = two_state_topology(states)
    topo["objects"]["states"]["geometries"] = [g for g in topo["objects"]["states"]["geometries"] if g["id"] != "19"]
    topo_path.write_text(json.dumps(topo), encoding="utf-8")
    with pytest.raises(mapdata.MapDataError, match="IA"):
        fleetpoints.load_boundaries(topo_path, states)


def test_read_rows_keeps_notes_and_refuses_a_csv_with_the_wrong_columns(tmp_path):
    path = write_csv(tmp_path / "ok.csv", [{"Name": "ta", "Address": "A", "Notes": "N", "Latitude": "1", "Longitude": "2"}])
    assert fleetpoints.read_rows(path) == [fleetpoints.Row(1, "ta", "A", 1.0, 2.0, "N")]
    path = tmp_path / "bad.csv"
    path.write_text("Name,Lat,Lon\nta,1,2\n", encoding="utf-8")
    with pytest.raises(fleetpoints.FleetError, match="Latitude"):
        fleetpoints.read_rows(path)


# ---------------------------------------------------------------- schema, writing, idempotency


def test_built_document_matches_the_schema_and_a_rewrite_changes_nothing(tmp_path, boundaries, map_validators):
    rows = [row(1, "nb and sb weight station", *DES_MOINES), row(2, "loves shop", *GRAND_FORKS), row(3, "yard", *DES_MOINES)]
    doc = fleetpoints.build(rows, boundaries, "2026-09-23").doc
    assert map_validators.errors("map-fleet-points", doc) == []
    assert doc["counts"] == no_counts(weigh=1, loves_shop=1)
    assert fleetpoints.write(doc, tmp_path, map_validators) is True
    path = tmp_path / fleetpoints.FLEET_POINTS
    before = path.read_bytes()
    assert fleetpoints.write(doc, tmp_path, map_validators) is False
    assert path.read_bytes() == before
    assert store.read_json(path) == doc


def test_the_schema_refuses_a_leaked_label_a_bad_direction_or_the_csv_counts(boundaries, map_validators):
    doc = fleetpoints.build([row(1, "weight station", *DES_MOINES)], boundaries, "2026-09-23").doc
    bad = json.loads(json.dumps(doc))
    bad["points"][0]["label"] = "Weigh station, Sample Town UT"
    assert map_validators.errors("map-fleet-points", bad)
    bad = json.loads(json.dumps(doc))
    bad["points"][0]["direction"] = "XB"
    assert map_validators.errors("map-fleet-points", bad)
    bad = json.loads(json.dumps(doc))
    bad["points"][0]["name"] = "weight station"
    assert map_validators.errors("map-fleet-points", bad)
    bad = json.loads(json.dumps(doc))
    bad["points"][0]["state"] = "Utah"
    assert map_validators.errors("map-fleet-points", bad)
    for key in ("rows", "dropped", "duplicates", "points", "no_state"):
        bad = json.loads(json.dumps(doc))
        bad["counts"][key] = 1
        assert map_validators.errors("map-fleet-points", bad), key
    bad = json.loads(json.dumps(doc))
    del bad["counts"]["weigh"]
    assert map_validators.errors("map-fleet-points", bad)
    bad = json.loads(json.dumps(doc))
    bad["source"] = "Hand built fleet geofences provided by the DailyFuel owner"
    assert map_validators.errors("map-fleet-points", bad)
    bad = json.loads(json.dumps(doc))
    del bad["dedupe_m"]
    assert map_validators.errors("map-fleet-points", bad)


def test_write_refuses_an_invalid_document(tmp_path, boundaries, map_validators):
    doc = fleetpoints.build([row(1, "weight station", *DES_MOINES)], boundaries, "2026-09-23").doc
    doc["points"][0]["lat"] = 5.0
    with pytest.raises(store.SchemaError):
        fleetpoints.write(doc, tmp_path, map_validators)
    assert not (tmp_path / fleetpoints.FLEET_POINTS).exists()


def test_a_rerun_on_a_later_day_keeps_the_import_date(boundaries):
    rows = [row(1, "weight station", *DES_MOINES)]
    old = fleetpoints.build(rows, boundaries, "2026-09-23").doc
    new = fleetpoints.build(rows, boundaries, "2026-10-01").doc
    assert fleetpoints.keep_imported_date(new, old) == old
    changed = fleetpoints.build(rows + [row(2, "ta", *GRAND_FORKS)], boundaries, "2026-10-01").doc
    assert fleetpoints.keep_imported_date(changed, old)["imported"] == "2026-10-01"
    assert fleetpoints.keep_imported_date(new, None) == new


# ---------------------------------------------------------------- the tool, end to end, and the leak test

MARKER = "ZQXJMARKER"


def synthetic_csv(path: Path) -> Path:
    dm, gf = DES_MOINES, GRAND_FORKS
    return write_csv(path, [
        {"Address": f"{MARKER} Ave, Des Moines, IA 50309, \u0421\u0428\u0410", "Name": f"WB weight station {MARKER}", "Latitude": dm[0], "Longitude": dm[1],
         "Radius": 250, "Tags": MARKER, "Notes": f"{MARKER} note, Des Moines, IA 50309", "Type": "Normal Geofence"},
        {"Address": f"{MARKER} Rd, Grand Forks, ND 58201", "Name": "loves shop", "Latitude": gf[0], "Longitude": gf[1], "Radius": 250,
         "Notes": MARKER, "Type": "Yard"},
        {"Address": f"{MARKER} Rd", "Name": f"{MARKER} truck repair", "Latitude": gf[0], "Longitude": gf[1], "Radius": 250, "Type": "Risk Zone"},
        {"Address": f"{MARKER} Rd", "Name": "sample carriers inc", "Latitude": gf[0], "Longitude": gf[1] + 0.01, "Radius": 88482, "Type": "Yard"},
        {"Address": "", "Name": "nb and sb weigh station", "Latitude": gf[0] + 0.1, "Longitude": gf[1], "Radius": 250, "Type": "Normal Geofence"},
        {"Address": "", "Name": "weigh station", "Latitude": gf[0] + 0.1 + M10, "Longitude": gf[1], "Radius": 250, "Type": "Normal Geofence"},
    ])


def test_the_tool_builds_from_a_csv_and_nothing_from_it_leaks(tmp_path, states, capsys):
    csv_path = synthetic_csv(tmp_path / "geofences.csv")
    geo = tmp_path / "states.geojson"
    geo.write_text(json.dumps(two_state_geojson(states)), encoding="utf-8")
    data = tmp_path / "data"
    report = tmp_path / "report" / "dropped.csv"
    argv = ["--csv", str(csv_path), "--boundaries", str(geo), "--data-dir", str(data), "--dropped-report", str(report),
            "--imported", "2026-09-23"]
    assert import_fleet_points.main(argv) == 0
    out = capsys.readouterr().out
    assert "fleet points: 3 points from 6 rows" in out and "rewritten" in out
    assert "dropped 2 rows, 1 pins at the coordinates of another, 1 within 25 m of another, 0 points in no state" in out
    assert "state cross check: 2 of 3 points carry a state and ZIP in the CSV, 0 disagree" in out
    assert MARKER not in out and "50309" not in out

    path = data / fleetpoints.FLEET_POINTS
    text = path.read_text(encoding="utf-8")
    assert MARKER not in text
    assert not re.search(r"[\u0400-\u04ff]", text)
    assert "88482" not in text and "Normal Geofence" not in text and "Risk Zone" not in text and "50309" not in text
    doc = json.loads(text)
    assert doc["imported"] == "2026-09-23"
    assert doc["counts"] == no_counts(weigh=2, loves_shop=1)
    assert [p["label"] for p in doc["points"]] == ["Weigh station", "Weigh station, westbound", "Love's shop"]
    # Only the JSON went under the data dir; the CSV stayed where it was.
    assert [p.relative_to(data).as_posix() for p in data.rglob("*") if p.is_file()] == ["map/fleet_points.json"]

    # The dropped report is for the owner: it names the rows and why.
    with open(report, newline="", encoding="utf-8") as f:
        dropped = list(csv.DictReader(f))
    assert [(d["row"], d["reason"]) for d in dropped] == [("3", "repair or tire shop"), ("4", "company name")]
    assert dropped[0]["name"] == f"{MARKER} truck repair"

    # A rerun, even dated later, changes nothing.
    before = path.read_bytes()
    assert import_fleet_points.main(argv[:-2] + ["--imported", "2026-12-31"]) == 0
    assert "unchanged" in capsys.readouterr().out
    assert path.read_bytes() == before


def test_the_tool_reads_the_census_zip_and_reports_a_clean_cross_check(tmp_path, states, capsys):
    zipped = tmp_path / "cb_2023_us_state_500k.zip"
    with zipfile.ZipFile(zipped, "w") as z:
        z.writestr("cb_2023_us_state_500k.kml", regression_kml(states))
    csv_path = write_csv(tmp_path / "geofences.csv", [
        {"Name": name, "Address": f"1 Sample Rd, {st} {MADE_UP_ZIPS[st]}", "Latitude": lat, "Longitude": lon}
        for name, lat, lon, st in REGRESSION_POINTS
    ])
    data = tmp_path / "data"
    argv = ["--csv", str(csv_path), "--boundaries", str(zipped), "--data-dir", str(data), "--imported", "2026-09-23"]
    assert import_fleet_points.main(argv) == 0
    out = capsys.readouterr().out
    assert "0 points in no state" in out
    assert "state cross check: 7 of 7 points carry a state and ZIP in the CSV, 0 disagree" in out
    doc = store.read_json(data / fleetpoints.FLEET_POINTS)
    assert sorted(p["state"] for p in doc["points"]) == ["AR", "AR", "AR", "FL", "LA", "LA", "RI"]
    assert doc["counts"] == no_counts(weigh=5, ta=1, speedco=1)


def test_the_tool_prints_every_disagreement(tmp_path, states, capsys):
    kml = tmp_path / "coarse.kml"
    kml.write_bytes(regression_kml(states, coarse=True))
    csv_path = write_csv(tmp_path / "geofences.csv", [
        {"Name": name, "Address": f"1 Sample Rd, {st} {MADE_UP_ZIPS[st]}", "Latitude": lat, "Longitude": lon}
        for name, lat, lon, st in REGRESSION_POINTS
    ])
    argv = ["--csv", str(csv_path), "--boundaries", str(kml), "--data-dir", str(tmp_path / "data"), "--imported", "2026-09-23"]
    assert import_fleet_points.main(argv) == 0
    out = capsys.readouterr().out
    assert "state cross check: 7 of 7 points carry a state and ZIP in the CSV, 7 disagree" in out
    assert "32.32031,-90.94781 assigned MS, the CSV says LA (row 1)" in out
    assert "41.51081,-71.36569 assigned none, the CSV says RI (row 7)" in out
    assert "Sample Rd" not in out and "71000" not in out


def test_the_tool_takes_a_us_atlas_topology(tmp_path, states, capsys):
    csv_path = synthetic_csv(tmp_path / "geofences.csv")
    topo = tmp_path / "states-10m.json"
    topo.write_text(json.dumps(two_state_topology(states)), encoding="utf-8")
    data = tmp_path / "data"
    assert import_fleet_points.main(["--csv", str(csv_path), "--boundaries", str(topo), "--data-dir", str(data), "--imported", "2026-09-23"]) == 0
    assert "0 points in no state" in capsys.readouterr().out
    doc = store.read_json(data / fleetpoints.FLEET_POINTS)
    assert [p["state"] for p in doc["points"]] == ["ND", "IA", "ND"]


def test_the_tool_refuses_a_dropped_report_inside_the_repo(tmp_path, states, capsys):
    csv_path = synthetic_csv(tmp_path / "geofences.csv")
    geo = tmp_path / "states.geojson"
    geo.write_text(json.dumps(two_state_geojson(states)), encoding="utf-8")
    argv = ["--csv", str(csv_path), "--boundaries", str(geo), "--data-dir", str(tmp_path / "data"),
            "--dropped-report", str(REPO_ROOT / "data" / "map" / "dropped.csv")]
    assert import_fleet_points.main(argv) == 2
    assert "outside the repo" in capsys.readouterr().err
    assert not (tmp_path / "data").exists()
    assert not (REPO_ROOT / "data" / "map" / "dropped.csv").exists()


def fake_worktree(tmp_path: Path) -> tuple[Path, Path]:
    """A main checkout and a linked worktree elsewhere, laid out the way git does it."""
    main = tmp_path / "main"
    gitdir = main / ".git" / "worktrees" / "wt"
    gitdir.mkdir(parents=True)
    (gitdir / "commondir").write_text("../..\n", encoding="utf-8")
    wt = tmp_path / "elsewhere" / "wt"
    wt.mkdir(parents=True)
    (wt / ".git").write_text(f"gitdir: {gitdir}\n", encoding="utf-8")
    return main, wt


def test_repo_roots_include_the_main_checkout_of_a_worktree(tmp_path):
    main, wt = fake_worktree(tmp_path)
    assert import_fleet_points.repo_roots(wt) == (wt.resolve(), main.resolve())
    assert import_fleet_points.repo_roots(main) == (main.resolve(),)
    assert import_fleet_points.repo_roots(tmp_path / "nowhere") == ((tmp_path / "nowhere").resolve(),)
    roots = import_fleet_points.repo_roots(wt)
    assert import_fleet_points._inside_repo(wt / "data" / "map" / "dropped.csv", roots)
    assert import_fleet_points._inside_repo(main / "data" / "map" / "dropped.csv", roots)
    assert not import_fleet_points._inside_repo(tmp_path / "elsewhere" / "dropped.csv", roots)
    # Without a commondir file the worktrees parent leads to the same place.
    (main / ".git" / "worktrees" / "wt" / "commondir").unlink()
    assert import_fleet_points.repo_roots(wt) == (wt.resolve(), main.resolve())
    # A .git file that points somewhere else entirely adds nothing.
    (wt / ".git").write_text(f"gitdir: {tmp_path / 'other' / 'repo.git'}\n", encoding="utf-8")
    assert import_fleet_points.repo_roots(wt) == (wt.resolve(),)
    # This checkout itself: its own root always, and never a tmp dir.
    assert REPO_ROOT.resolve() in import_fleet_points.repo_roots()
    assert not import_fleet_points._inside_repo(tmp_path / "dropped.csv")


def test_this_checkout_guards_its_main_checkout_when_it_is_a_worktree():
    roots = import_fleet_points.repo_roots()
    if (REPO_ROOT / ".git").is_file():  # a linked worktree, as the map branches are built in
        assert len(roots) == 2 and roots[0] == REPO_ROOT.resolve()
        assert import_fleet_points._inside_repo(roots[1] / "data" / "map" / "dropped.csv")
        assert (roots[1] / ".git").is_dir()
    else:
        assert roots == (REPO_ROOT.resolve(),)


def test_the_tool_run_from_a_worktree_refuses_a_report_under_the_main_checkout(tmp_path, states, capsys, monkeypatch):
    main, wt = fake_worktree(tmp_path)
    monkeypatch.setattr(import_fleet_points, "REPO_ROOT", wt)
    csv_path = synthetic_csv(tmp_path / "geofences.csv")
    geo = tmp_path / "states.geojson"
    geo.write_text(json.dumps(two_state_geojson(states)), encoding="utf-8")
    argv = ["--csv", str(csv_path), "--boundaries", str(geo), "--data-dir", str(tmp_path / "data"), "--dropped-report"]
    assert import_fleet_points.main(argv + [str(main / "data" / "map" / "dropped.csv")]) == 2
    assert "outside the repo" in capsys.readouterr().err
    assert import_fleet_points.main(argv + [str(wt / "dropped.csv")]) == 2
    assert "outside the repo" in capsys.readouterr().err
    assert not (tmp_path / "data").exists()
    assert not (main / "data").exists()
    assert import_fleet_points.main(argv + [str(tmp_path / "report" / "dropped.csv")]) == 0
    assert (tmp_path / "report" / "dropped.csv").exists()


def test_the_tool_writes_nothing_on_a_bad_csv(tmp_path, states, capsys):
    bad = tmp_path / "bad.csv"
    bad.write_text("Name,Lat,Lon\nta,1,2\n", encoding="utf-8")
    geo = tmp_path / "states.geojson"
    geo.write_text(json.dumps(two_state_geojson(states)), encoding="utf-8")
    assert import_fleet_points.main(["--csv", str(bad), "--boundaries", str(geo), "--data-dir", str(tmp_path / "data")]) == 1
    assert "nothing written" in capsys.readouterr().err
    assert not (tmp_path / "data").exists()


def test_overlap_counts_both_ways():
    dm = DES_MOINES
    a = [dm, (dm[0] + 0.5, dm[1])]
    b = [(dm[0] + 0.001, dm[1]), (dm[0] + 0.001, dm[1] + 0.001), GRAND_FORKS]
    assert fleetpoints.overlap(a, b, 1500.0) == (1, 2)
    assert fleetpoints.overlap([], b, 1500.0) == (0, 0)


# ---------------------------------------------------------------- the committed file


def test_committed_fleet_points_match_the_schema_and_carry_no_csv_text(map_validators):
    path = REPO_ROOT / "data" / fleetpoints.FLEET_POINTS
    assert path.exists(), "data/map/fleet_points.json is not committed; run scripts/import_fleet_points.py"
    text = path.read_text(encoding="utf-8")
    doc = json.loads(text)
    assert map_validators.errors("map-fleet-points", doc) == []
    assert text == store.dumps(doc)  # the committed bytes are the tool's bytes
    assert doc["source"] == fleetpoints.SOURCE and doc["dedupe_m"] == fleetpoints.DEDUPE_M
    assert len(doc["points"]) > 0
    assert doc["counts"] == {c: sum(1 for p in doc["points"] if p["category"] == c) for c in fleetpoints.CATEGORIES}
    assert not re.search(r"[\u0400-\u04ff]", text)
    assert "$" not in text
    # Nothing names an owner, a fleet or an export, the schema id and the ProFleet label and key aside.
    vocabulary = text.replace(f'"{fleetpoints.SCHEMA}"', "").replace("ProFleet lube", "").replace('"profleet"', "")
    assert not re.search(r"fleet|owner|export|geofence", vocabulary, re.I)
    assert not re.search(r"(?<![\d.])\d{5}(?![\d.])", text)  # no ZIP, no radius: nothing five digits long outside a coordinate
    labels = {fleetpoints.label_for(c, d) for c in fleetpoints.CATEGORIES for d in (None, *fleetpoints.DIRECTIONS)}
    assert {p["label"] for p in doc["points"]} <= labels
    assert all(p["direction"] is None for p in doc["points"] if p["category"] not in fleetpoints.DIRECTED)
    spots = {(p["category"], p["lat"], p["lon"]) for p in doc["points"]}
    assert len(spots) == len(doc["points"])  # one pin per category and spot
    assert doc["points"] == sorted(
        doc["points"], key=lambda p: (fleetpoints.CATEGORIES.index(p["category"]), p["direction"] or "", p["lat"], p["lon"])
    )
    for p in doc["points"]:
        assert p["lat"] == round(p["lat"], mapdata.COORD_DECIMALS) and p["lon"] == round(p["lon"], mapdata.COORD_DECIMALS)
    # No two pins of one category and direction within dedupe_m of each other.
    dlat = doc["dedupe_m"] / 110_570 * 1.05
    for i, p in enumerate(doc["points"]):
        for q in doc["points"][i + 1:]:
            if (q["category"], q["direction"]) != (p["category"], p["direction"]):
                break
            if q["lat"] - p["lat"] > dlat:
                break
            assert mapdata.haversine_m(p["lat"], p["lon"], q["lat"], q["lon"]) > doc["dedupe_m"], (p, q)
    # The seven border and coast pins are in their states.
    by_spot = {(p["lat"], p["lon"]): p["state"] for p in doc["points"]}
    for _, lat, lon, st in REGRESSION_POINTS:
        assert by_spot.get((lat, lon)) == st, (lat, lon)
    # The CSV itself never came along.
    assert not list((REPO_ROOT / "data").rglob("*.csv"))
