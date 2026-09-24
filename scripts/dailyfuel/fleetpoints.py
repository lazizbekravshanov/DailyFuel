"""Fleet points: a hand built point list, reduced to public pins.

Not part of the scheduled job. scripts/import_fleet_points.py runs this by
hand on a CSV that never enters the repo (it has addresses, notes and
private places in it) and commits only data/map/fleet_points.json.

Every row is categorised from its Name alone, case and whitespace
insensitive. Weigh stations, inspection stations and ports of entry are
kept with a direction when the name carries one; the truck service chains
(TA, Petro, Love's shop, Speedco, LubeZone, ProFleet) are kept without one.
Everything else is dropped: repair and tire shops, towing, glass, parking,
tarp and yard pins, toll road and driver notes, company names, and any name
with a price, a phone style number or Cyrillic text in it, whatever else it
says.

Pins are then folded twice. Rows of one category at exactly the same
coordinates are one pin; when their directions differ (NB and SB, or NB and
none, or one "NB and SB" row) that pin has no direction and the plain
label. Then pins of one category and direction within DEDUPE_M of each
other are one pin, the first in (lat, lon) order kept.

The output carries lat, lon, category, direction, state and a label built
from the category and direction only. No field of the CSV is ever copied
into it: the label comes from a fixed table, the state from a point in
polygon test on the Census cartographic boundaries, and the schema's label
pattern refuses anything else. The Address and Notes columns are read for
one thing, a "XX 12345" state and ZIP that the importer's report checks the
assigned state against; they are never written anywhere.
"""

from __future__ import annotations

import csv
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from . import mapdata, store
from .states import StateTable

FLEET_POINTS = mapdata.MAP_DIR / "fleet_points.json"
KIND = "map-fleet-points"
SCHEMA = "dailyfuel/map-fleet-points/1"
SOURCE = "Weigh station and truck service points compiled by DailyFuel"
LICENCE = "CC BY 4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/"
ATTRIBUTION = "Weigh station and truck service points: DailyFuel"

COLUMNS = ("ID", "Address", "Name", "Latitude", "Longitude", "Radius", "Tags", "Notes", "Type")

CATEGORIES = ("weigh", "inspection", "port_of_entry", "ta", "petro", "loves_shop", "speedco", "lubezone", "profleet")
DIRECTED = frozenset({"weigh", "inspection", "port_of_entry"})
DIRECTIONS = ("EB", "WB", "NB", "SB")

LABELS = {
    "weigh": "Weigh station",
    "inspection": "Inspection station",
    "port_of_entry": "Port of entry",
    "ta": "TA",
    "petro": "Petro",
    "loves_shop": "Love's shop",
    "speedco": "Speedco",
    "lubezone": "LubeZone",
    "profleet": "ProFleet lube",
}
DIRECTION_WORDS = {"EB": "eastbound", "WB": "westbound", "NB": "northbound", "SB": "southbound"}

# Pins of one category and direction closer than this are the same place
# pinned twice (a geofence redrawn a few metres over), not two stations.
DEDUPE_M = 25

# A pin that misses every state polygon is tried again this far away. The
# Census coast line cuts off the odd causeway or pier (the Overseas Highway
# in the Keys); 1 km brings those back without reaching across a border.
STATE_TOLERANCE_KM = 1.0

# The 50 states plus DC, Alaska's Aleutians east of the antimeridian aside.
LAT_MIN, LAT_MAX = 18.0, 72.0
LON_MIN, LON_MAX = -180.0, -65.0

# ---------------------------------------------------------------- name rules

# Names that are never published, whatever else they say.
_CYRILLIC = re.compile(r"[\u0400-\u04ff]")
_PRICE = re.compile(r"\$|\b\d+\s*(?:usd|dollars?|bucks)\b|\bprice\b")
_PHONE = re.compile(r"\d{3}[\s.\-]\d{3,4}\b|\d{7,}")

# Keep rules, in the order they are tried. Any "inspection" is an
# inspection station, an "inspection area" included.
_PORT_OF_ENTRY = re.compile(r"port of entry|port entry|\bpoe\b")
_INSPECTION = re.compile(r"inspection|\bdot ins")
_WEIGH = re.compile(r"weigh|weight|check ?point")
_SCALE = re.compile(r"scale")
_TIRE = re.compile(r"tire|tyre")
_TA = re.compile(r"^ta(?: |$)")
_PETRO = re.compile(r"^(?:petro|perto)\b")
_LOVES_SHOP = re.compile(r"^love'?s shop\b")
_SPEEDCO = re.compile(r"\bspeedco\b")
_LUBEZONE = re.compile(r"\blube ?zone\b")
_PROFLEET = re.compile(r"\bpro ?fleet\b")

_DIRECTION_TOKEN = re.compile(r"\b(eb|wb|nb|sb)\b|\b(east|west|north|south)bound\b")

# Drop reasons for what the keep rules did not take, in the order they are
# tried. They only name the reason for the owner's report; nothing here is
# needed to keep a row out.
_DROP_RULES = (
    ("tarp", re.compile(r"\btarps?\b")),
    ("yard", re.compile(r"\byard\b")),
    ("toll road note", re.compile(r"\btoll\b")),
    ("driver note", re.compile(r"\bdrivers?\b|need to check|might be|prohibit|will come")),
    ("towing", re.compile(r"\btow(?:ing)?\b|recovery")),
    ("glass shop", re.compile(r"\bglass\b")),
    ("parking", re.compile(r"\bparking\b")),
    (
        "repair or tire shop",
        re.compile(
            r"tire|tyre|repair|diesel|trailer|\btrucks?\b|service|parts|welding|retread|mechan|mechin|mehanic|"
            r"body shop|\bsemi\b|fleet|lube|oil change|wheel|alignment"
        ),
    ),
    ("company name", re.compile(r"\bcarriers?\b|\btrucking\b|\binc\b|\bllc\b")),
)
NO_RULE = "no rule matched"

# A state and ZIP as the CSV writes them in Address and Notes, "UT 84083".
_STATE_ZIP = re.compile(r"\b([A-Z]{2}) \d{5}\b")


def normalize_name(name: str) -> str:
    """Lower case, single spaces, plain apostrophes."""
    return " ".join((name or "").replace("’", "'").split()).lower()


def parse_directions(name: str) -> tuple[str, ...]:
    """The direction tokens of a name, in order, once each. Empty when there are none.

    EB, WB, NB and SB as words, and eastbound, westbound, northbound,
    southbound. "NB and SB" comes back as ("NB", "SB"); build folds that
    into one pin with no direction.
    """
    out: list[str] = []
    for token, word in _DIRECTION_TOKEN.findall(normalize_name(name)):
        code = token.upper() if token else word[0].upper() + "B"
        if code not in out:
            out.append(code)
    return tuple(out)


@dataclass(frozen=True)
class Decision:
    """What a Name means: a category with its directions, or a drop reason."""

    category: str | None
    directions: tuple[str | None, ...] = (None,)
    reason: str | None = None

    @property
    def kept(self) -> bool:
        return self.category is not None


def _drop(reason: str) -> Decision:
    return Decision(None, (), reason)


def categorize(name: str) -> Decision:
    """Categorise one Name. Case and whitespace insensitive, nothing else is looked at."""
    n = normalize_name(name)
    if not n:
        return _drop("empty name")
    if _CYRILLIC.search(n):
        return _drop("cyrillic text in name")
    if _PRICE.search(n):
        return _drop("price in name")
    if _PHONE.search(n):
        return _drop("phone style number in name")

    category = None
    if _PORT_OF_ENTRY.search(n):
        category = "port_of_entry"
    elif _INSPECTION.search(n):
        category = "inspection"
    elif _WEIGH.search(n) or (_SCALE.search(n) and not _TIRE.search(n)):
        category = "weigh"
    elif _TA.search(n):
        category = "ta"
    elif _PETRO.search(n):
        category = "petro"
    elif _LOVES_SHOP.search(n):
        category = "loves_shop"
    elif _SPEEDCO.search(n):
        category = "speedco"
    elif _LUBEZONE.search(n):
        category = "lubezone"
    elif _PROFLEET.search(n):
        category = "profleet"

    if category is None:
        for reason, rule in _DROP_RULES:
            if rule.search(n):
                return _drop(reason)
        return _drop(NO_RULE)
    if category in DIRECTED:
        return Decision(category, parse_directions(n) or (None,))
    return Decision(category)


def label_for(category: str, direction: str | None) -> str:
    """The published label, from the fixed table only."""
    label = LABELS[category]
    if direction is None:
        return label
    return f"{label}, {DIRECTION_WORDS[direction]}"


def state_hints(text: str, codes: frozenset[str]) -> frozenset[str]:
    """The state codes written before a ZIP in text ("UT 84083"), restricted to codes."""
    return frozenset(code for code in _STATE_ZIP.findall(text or "") if code in codes)


# ---------------------------------------------------------------- the CSV


class FleetError(ValueError):
    """The CSV or the boundaries are not what this import expects. Nothing was written."""


@dataclass(frozen=True)
class Row:
    number: int  # 1 based data row number, the header not counted
    name: str
    address: str
    lat: float | None
    lon: float | None
    notes: str = ""


def read_rows(path: Path | str) -> list[Row]:
    """Read the point list CSV. Only Name, Address, Notes and the coordinates are kept in memory."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = tuple(reader.fieldnames or ())
        missing = [c for c in COLUMNS if c not in fields]
        if missing:
            raise FleetError(f"{path} is missing the columns {', '.join(missing)}; expected {', '.join(COLUMNS)}")
        rows = []
        for i, r in enumerate(reader, start=1):
            rows.append(
                Row(
                    i,
                    r.get("Name") or "",
                    r.get("Address") or "",
                    _float(r.get("Latitude")),
                    _float(r.get("Longitude")),
                    r.get("Notes") or "",
                )
            )
    return rows


def _float(value) -> float | None:
    try:
        x = float((value or "").strip())
    except ValueError:
        return None
    return x if x == x else None  # NaN


def in_bounds(lat: float, lon: float) -> bool:
    return LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX


# ---------------------------------------------------------------- boundaries


def _open_ring(ring) -> list[tuple[float, float]]:
    pts = [(float(x), float(y)) for x, y, *_ in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def _require_all(polygons, states: StateTable) -> mapdata.Boundaries:
    found = {code for code, _ in polygons}
    missing = sorted(s.code for s in states.states if s.code not in found)
    if missing:
        raise FleetError(f"the boundaries are missing {', '.join(missing)}")
    return mapdata.Boundaries(polygons)


def boundaries_from_kml(data: bytes, states: StateTable) -> mapdata.Boundaries:
    """State polygons from the Census cartographic boundary KML (cb_2023_us_state_500k.kml).

    Each Placemark names its state in ExtendedData (STUSPS, else STATEFP,
    else NAME) and holds one Polygon or a MultiGeometry of them, each an
    outer ring and any inner rings as "lon,lat,alt" tuples. Territories are
    skipped. Every one of the 50 states plus DC must be there.
    """
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise FleetError(f"the boundaries file is not KML: {e}") from None
    ns = root.tag[: root.tag.index("}") + 1] if root.tag.startswith("{") else ""
    codes = {s.code for s in states.states}
    by_fips = {s.fips: s.code for s in states.states}
    by_name = {s.name.lower(): s.code for s in states.states}
    polygons = []
    for placemark in root.iter(f"{ns}Placemark"):
        fields = {el.get("name"): (el.text or "").strip() for el in placemark.iter(f"{ns}SimpleData")}
        code = fields.get("STUSPS")
        if code not in codes:
            code = by_fips.get(fields.get("STATEFP", "")) or by_name.get(fields.get("NAME", "").lower())
        if code is None:
            continue  # Puerto Rico and the other territories
        for polygon in placemark.iter(f"{ns}Polygon"):
            outer = polygon.find(f"{ns}outerBoundaryIs/{ns}LinearRing/{ns}coordinates")
            if outer is None or not (outer.text or "").strip():
                continue
            rings = [_kml_ring(outer.text)]
            for inner in polygon.findall(f"{ns}innerBoundaryIs/{ns}LinearRing/{ns}coordinates"):
                rings.append(_kml_ring(inner.text or ""))
            polygons.append((code, [r for r in rings if len(r) >= 3]))
    return _require_all([(c, p) for c, p in polygons if p], states)


def _kml_ring(text: str) -> list[tuple[float, float]]:
    try:
        return _open_ring(tuple(float(v) for v in token.split(",")) for token in text.split())
    except ValueError as e:
        raise FleetError(f"a KML coordinate is not a number: {e}") from None


def boundaries_from_geojson(doc: dict, states: StateTable) -> mapdata.Boundaries:
    """State polygons from a GeoJSON FeatureCollection whose features carry a state name.

    Features named after territories (Puerto Rico) are skipped. Every one of
    the 50 states plus DC must be there.
    """
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection":
        raise FleetError("the boundaries file is not a GeoJSON FeatureCollection")
    by_name = {s.name.lower(): s.code for s in states.states}
    polygons = []
    for feature in doc.get("features", []):
        props = feature.get("properties") or {}
        code = by_name.get(str(props.get("name") or props.get("NAME") or "").lower())
        if code is None:
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "Polygon":
            polys = [geometry["coordinates"]]
        elif geometry.get("type") == "MultiPolygon":
            polys = geometry["coordinates"]
        else:
            continue
        for poly in polys:
            polygons.append((code, [_open_ring(ring) for ring in poly]))
    return _require_all(polygons, states)


def load_boundaries(path: Path | str, states: StateTable) -> mapdata.Boundaries:
    """State polygons from any boundaries file the tool accepts.

    The one to use is the Census cartographic boundary file,
    cb_2023_us_state_500k, as the .kml or the .zip it comes in: it keeps
    the river borders (Vicksburg, West Memphis) on the right bank and the
    islands (the Keys, Aquidneck). A us-atlas TopoJSON keyed by FIPS or a
    GeoJSON FeatureCollection keyed by state name also work; the report's
    state cross check says when one is too coarse.
    """
    path = Path(path)
    suffix = path.suffix.lower()
    try:
        if suffix == ".zip":
            with zipfile.ZipFile(path) as z:
                kmls = [n for n in z.namelist() if n.lower().endswith(".kml")]
                if len(kmls) != 1:
                    raise FleetError(f"{path} holds {len(kmls)} .kml files; expected one")
                return boundaries_from_kml(z.read(kmls[0]), states)
        if suffix == ".kml":
            return boundaries_from_kml(path.read_bytes(), states)
        doc = store.read_json(path)
    except zipfile.BadZipFile as e:
        raise FleetError(f"{path} is not a zip file: {e}") from None
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise FleetError(f"{path} is not KML, a zip of it, or JSON: {e}") from None
    if isinstance(doc, dict) and doc.get("type") == "Topology":
        return mapdata.Boundaries.from_topology(doc, states)
    return boundaries_from_geojson(doc, states)


# ---------------------------------------------------------------- build


@dataclass(frozen=True)
class Dropped:
    number: int
    name: str
    address: str
    reason: str


@dataclass(frozen=True)
class Mismatch:
    """A pin whose assigned state is not the one the CSV's Address or Notes wrote before a ZIP."""

    rows: tuple[int, ...]
    lat: float
    lon: float
    state: str | None
    hints: tuple[str, ...]


@dataclass
class Build:
    doc: dict
    dropped: list[Dropped]
    # For the tool's report only, never published: rows read, rows dropped,
    # pins folded at identical coordinates, pins folded within DEDUPE_M,
    # points in no state, and how many points carried a state and ZIP to
    # check against.
    stats: dict = field(default_factory=dict)
    mismatches: list[Mismatch] = field(default_factory=list)


@dataclass
class _Place:
    category: str
    lat: float
    lon: float
    directions: set[str | None] = field(default_factory=set)
    hints: set[str] = field(default_factory=set)
    rows: list[int] = field(default_factory=list)

    @property
    def direction(self) -> str | None:
        """The direction when every row at this spot says the same one; otherwise none."""
        return next(iter(self.directions)) if len(self.directions) == 1 else None


def _point(lat: float, lon: float, category: str, direction: str | None, state: str | None) -> dict:
    return {
        "lat": lat,
        "lon": lon,
        "category": category,
        "direction": direction,
        "state": state,
        "label": label_for(category, direction),
    }


def _sort_key(p) -> tuple:
    return (CATEGORIES.index(p.category), p.direction or "", p.lat, p.lon)


def build(
    rows: list[Row],
    boundaries: mapdata.Boundaries,
    imported: str,
    dedupe_m: int = DEDUPE_M,
    tolerance_km: float = STATE_TOLERANCE_KM,
) -> Build:
    """Categorise, sanitise, dedupe and sort. Deterministic for a given input, in any order."""
    dropped: list[Dropped] = []
    places: dict[tuple[str, float, float], _Place] = {}
    candidates = 0
    codes = boundaries.codes
    for r in rows:
        d = categorize(r.name)
        if not d.kept:
            dropped.append(Dropped(r.number, r.name, r.address, d.reason or NO_RULE))
            continue
        if r.lat is None or r.lon is None:
            dropped.append(Dropped(r.number, r.name, r.address, "bad coordinates"))
            continue
        if not in_bounds(r.lat, r.lon):
            dropped.append(Dropped(r.number, r.name, r.address, "outside the US bounds"))
            continue
        lat, lon = mapdata.round_coord(r.lat), mapdata.round_coord(r.lon)
        key = (d.category, lat, lon)
        place = places.get(key)
        if place is None:
            place = places[key] = _Place(d.category, lat, lon)
        candidates += len(d.directions)
        place.directions.update(d.directions)
        place.hints |= state_hints(f"{r.address} {r.notes}", codes)
        place.rows.append(r.number)
    duplicates = candidates - len(places)

    # Near dedupe: within one category and direction, a pin within dedupe_m
    # of one already kept folds into it. Sorted first, so the kept pin of a
    # cluster is its first in (lat, lon) order whatever the input order.
    kept: list[_Place] = []
    tails: dict[tuple[str, str | None], list[_Place]] = {}
    dlat = dedupe_m / 110_570 * 1.05
    near = 0
    for place in sorted(places.values(), key=_sort_key):
        group = tails.setdefault((place.category, place.direction), [])
        match = None
        for other in reversed(group):  # kept pins of this group, nearest in latitude first
            if place.lat - other.lat > dlat:
                break  # every earlier one is further south still
            if mapdata.haversine_m(other.lat, other.lon, place.lat, place.lon) <= dedupe_m:
                match = other
                break
        if match is None:
            group.append(place)
            kept.append(place)
        else:
            match.hints |= place.hints
            match.rows.extend(place.rows)
            near += 1

    points: list[dict] = []
    mismatches: list[Mismatch] = []
    no_state = checkable = 0
    for place in kept:
        state = boundaries.state_of(place.lat, place.lon, tolerance_km=tolerance_km)
        if state is None:
            no_state += 1
        if place.hints:
            checkable += 1
            if state not in place.hints:
                mismatches.append(
                    Mismatch(tuple(sorted(place.rows)), place.lat, place.lon, state, tuple(sorted(place.hints)))
                )
        points.append(_point(place.lat, place.lon, place.category, place.direction, state))

    doc = {
        "schema": SCHEMA,
        "source": SOURCE,
        "licence": LICENCE,
        "licence_url": LICENCE_URL,
        "attribution": ATTRIBUTION,
        "imported": imported,
        "dedupe_m": dedupe_m,
        "counts": {c: sum(1 for p in points if p["category"] == c) for c in CATEGORIES},
        "points": points,
    }
    stats = {
        "rows": len(rows),
        "dropped": len(dropped),
        "duplicates": duplicates,
        "near_duplicates": near,
        "no_state": no_state,
        "checkable": checkable,
    }
    return Build(doc, dropped, stats, mismatches)


def keep_imported_date(doc: dict, existing: dict | None) -> dict:
    """The new document, dated as before when only the import date moved.

    A rerun on the same CSV a week later then rewrites nothing, which is what
    the other map files do with their cached fetch dates.
    """
    if not isinstance(existing, dict) or "imported" not in existing:
        return doc
    if dict(doc, imported=existing["imported"]) == existing:
        return dict(doc, imported=existing["imported"])
    return doc


def write(doc: dict, data_dir: Path | str, v: mapdata.MapValidators | None = None) -> bool:
    """Validate against the schema, then write data_dir/map/fleet_points.json. False when unchanged."""
    v = v or mapdata.MapValidators()
    return mapdata.write_doc(KIND, Path(data_dir) / FLEET_POINTS, doc, v)


def write_dropped_report(dropped: list[Dropped], path: Path | str) -> None:
    """The dropped rows with their reason, for the owner. Never goes in the repo."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["row", "reason", "name", "address"])
        for d in sorted(dropped, key=lambda d: d.number):
            w.writerow([d.number, d.reason, d.name, d.address])


# ---------------------------------------------------------------- report helpers


def overlap(a: list[tuple[float, float]], b: list[tuple[float, float]], radius_m: float) -> tuple[int, int]:
    """(points of a within radius_m of some point of b, points of b within radius_m of some point of a)."""

    def near(p, others) -> bool:
        lat, lon = p
        dlat = radius_m / 110_570 * 1.05
        for olat, olon in others:
            if abs(olat - lat) <= dlat and mapdata.haversine_m(lat, lon, olat, olon) <= radius_m:
                return True
        return False

    return sum(1 for p in a if near(p, b)), sum(1 for p in b if near(p, a))
