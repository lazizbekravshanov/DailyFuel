"""Map data: truck stop chains and weigh stations from open sources.

Not part of the scheduled job. scripts/update_map_data.py runs this by hand
and commits the outputs under data/map/, so a slow or failing Overpass run
never breaks a deploy. Five files come out, one per source so each carries
its own licence and the ODbL share alike duty stays on the OpenStreetMap
files only:

  stations.json    branded truck stops from OpenStreetMap (ODbL), one row per
                   site after clustering the OSM objects of a brand within
                   CLUSTER_M of each other
  weigh_osm.json   weigh and inspection station candidates from OpenStreetMap
                   (ODbL): the weighbridge and weigh_station tags plus a name
                   search, minus CAT Scale, border crossings, agricultural and
                   vehicle inspection sites, deduped at DEDUPE_M
  weigh_ntad.json  the weigh station rows of BTS NTAD Truck Stop Parking
                   (public domain, compiled 2019)
  weigh_ia.json    Iowa DOT weigh scales (CC BY 4.0)
  coverage.json    how complete the OSM layers are, measured, for the legend

Everything is built from a cache directory of raw responses. --live refreshes
that cache (Overpass queries one at a time, 240 s each, with a User-Agent
that names the repo) and then builds from it. Points outside the 50 states
plus DC are dropped by a point in polygon test against us-atlas boundaries,
never by a bounding box alone, because Overpass, geoAlbersUsa and a bbox all
let Winnipeg and Tijuana through.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from jsonschema import Draft202012Validator

from . import store
from .http import HttpClient, NetworkError
from .paths import REPO_ROOT, SCHEMAS_DIR
from .states import StateTable, load_states

# ---------------------------------------------------------------- locations

MAP_DIR = Path("map")
STATIONS = MAP_DIR / "stations.json"
WEIGH_OSM = MAP_DIR / "weigh_osm.json"
WEIGH_NTAD = MAP_DIR / "weigh_ntad.json"
WEIGH_IA = MAP_DIR / "weigh_ia.json"
COVERAGE = MAP_DIR / "coverage.json"

DEFAULT_CACHE_DIR = REPO_ROOT / "tmp" / "map-cache"
US_ATLAS_STATES = REPO_ROOT / "node_modules" / "us-atlas" / "states-10m.json"
US_ATLAS_NATION = REPO_ROOT / "node_modules" / "us-atlas" / "nation-10m.json"

SCHEMA_FILES = {
    "map-stations": "map-stations.schema.json",
    "map-weigh-osm": "map-weigh-osm.schema.json",
    "map-weigh-ntad": "map-weigh-ntad.schema.json",
    "map-weigh-ia": "map-weigh-ia.schema.json",
    "map-coverage": "map-coverage.schema.json",
    "map-fleet-points": "map-fleet-points.schema.json",  # written by fleetpoints, not by build()
}

# Raw responses inside the cache directory, plus a sidecar that records the
# day each one was fetched so a rebuild from the cache is reproducible.
CACHE_FILES = {
    "brands": "overpass/brands_all_centers.json",
    "weighbridge": "overpass/weighbridge_us_tags.json",
    "tags": "overpass/alt_tags_us.json",
    "names": "overpass/weigh_name_us.json",
    "ntad": "ntad/truck_stop_parking_weigh.json",
    "ia": "state_layers/IA.geojson",
}
FETCHED_FILE = "fetched.json"

# ---------------------------------------------------------------- sources

USER_AGENT = "DailyFuel map data tool (+https://github.com/lazizbekravshanov/DailyFuel)"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT = 240
# Seconds between two Overpass queries. The public instance asks for one query
# at a time from a client and a pause between heavy ones.
OVERPASS_PAUSE = 10
OVERPASS_RETRY_AFTER = 60

_US_AREA = 'area["ISO3166-1"="US"]["admin_level"="2"]->.us;'
_HEAD = f"[out:json][timeout:{OVERPASS_TIMEOUT}];{_US_AREA}"

BRAND_QUERY = (
    _HEAD
    + '(nwr(area.us)[amenity=fuel]["brand:wikidata"~"^(Q1872496|Q64128179|Q64130592|Q7835892|Q64051305|Q7339377)$"];'
    + 'nwr(area.us)[amenity=fuel][brand~"^(ONE9|One9)$"];'
    + 'nwr(area.us)[amenity=fuel][~"^(name|brand|operator|network)$"~"ambest",i];);out center tags;'
)
WEIGH_QUERIES = {
    "weighbridge": _HEAD + "nwr(area.us)[amenity=weighbridge];out tags center;",
    "tags": (
        _HEAD
        + "(nwr(area.us)[service=weigh_station];nwr(area.us)[amenity=weigh_station];"
        + "nwr(area.us)[amenity=weight_station];nwr(area.us)[man_made=weigh_station];);out tags center;"
    ),
    "names": (
        _HEAD
        + '(nwr(area.us)[name~"[Ww]eigh [Ss]tation|[Pp]ort of [Ee]ntry|[Ss]cale [Hh]ouse|[Ii]nspection [Ss]tation|'
        + '[Ww]eigh [Ss]cale|[Tt]ruck [Ss]cale|[Ww]eight [Ss]tation"];'
        + 'nwr(area.us)[amenity~"^(weigh_station|weight_station)$"];nwr(area.us)[man_made=weigh_station];'
        + 'nwr(area.us)[highway~"weigh"];);out tags center;'
    ),
}

OSM = {
    "source": "OpenStreetMap, fetched through the Overpass API",
    "source_url": "https://www.openstreetmap.org",
    "licence": "Open Database License (ODbL) 1.0",
    "licence_url": "https://opendatacommons.org/licenses/odbl/1-0/",
    "attribution": "© OpenStreetMap contributors",
    "attribution_url": "https://www.openstreetmap.org/copyright",
}

NTAD_LAYER_URL = (
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Truck_Stop_Parking/FeatureServer/0"
)
NTAD_WHERE = "UPPER(nhs_rest_stop) LIKE '%WEIGH%' OR UPPER(nhs_rest_stop) LIKE '%SCALE%'"
NTAD_QUERY_URL = NTAD_LAYER_URL + "/query?" + urlencode(
    {"where": NTAD_WHERE, "outFields": "*", "orderByFields": "OBJECTID", "resultRecordCount": 2000, "f": "json"}
)
NTAD = {
    "source": "Bureau of Transportation Statistics, National Transportation Atlas Database, Truck Stop Parking",
    "source_url": NTAD_LAYER_URL,
    "licence": "Public domain, a work of the United States government",
    "licence_note": (
        "This NTAD dataset is a work of the United States government as defined in 17 U.S.C. § 101 and as "
        "such are not protected by any U.S. copyrights. This work is available for unrestricted public use."
    ),
    "attribution": "Weigh station rows from the Truck Stop Parking dataset, FHWA and BTS (NTAD), compiled 2019",
    # From the layer description: "compiled on April 09, 2019 from the Federal Highway Administration".
    "compiled": "2019-04-09",
    "filter": "rows whose nhs_rest_stop name contains weigh or scale",
}
NTAD_NAME = re.compile(r"weigh|scale", re.I)

IA_LAYER_URL = "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Weigh_Scale_View/FeatureServer/0"
IA_QUERY_URL = IA_LAYER_URL + "/query?" + urlencode({"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson"})
IA = {
    "source": "Iowa Department of Transportation, Weigh Scale",
    "source_url": IA_LAYER_URL,
    "licence": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    "licence_url": "https://creativecommons.org/licenses/by/4.0/",
    "terms_url": "https://iowadot.gov/policies_and_statements/terms-of-use#gis",
    "attribution": "Weigh scales: Iowa Department of Transportation, CC BY 4.0",
}

# ---------------------------------------------------------------- brands

# key: display name, Wikidata brand id. Keys are what the map page filters on.
BRANDS: dict[str, tuple[str, str | None]] = {
    "loves": ("Love's", "Q1872496"),
    "pilot": ("Pilot", "Q64128179"),
    "flyingj": ("Flying J", "Q64130592"),
    "ta": ("TA", "Q7835892"),
    "petro": ("Petro", "Q64051305"),
    "one9": ("ONE9", None),
    "roadranger": ("Road Ranger", "Q7339377"),
}
_WIKIDATA_TO_BRAND = {qid: key for key, (_, qid) in BRANDS.items() if qid}
_ONE9 = re.compile(r"^(ONE9|One9)$")
_AMBEST = re.compile(r"ambest", re.I)
# AmBest is a network of independents. OSM knows 3 of its 661 members, so the
# layer is not shipped; the count is reported so the gap stays visible.
DROPPED_BRANDS = ("ambest",)

CLUSTER_M = 300
DEDUPE_M = 600
COORD_DECIMALS = 5
EARTH_RADIUS_M = 6_371_000.0

# ---------------------------------------------------------------- weigh station rules

# What makes an OSM object a weigh station rather than any scale, in the
# order the rules run. Every rule is a regular expression over the name,
# operator and brand, or a tag test. The drops come first so a CAT Scale at a
# Love's never survives on the strength of a "Truck Scale" name.
_CAT_SCALE = re.compile(r"cat scale", re.I)
_CAT_SCALE_WIKIDATA = "Q111631907"
_BORDER = re.compile(
    r"\bborder\b|customs|\bCBP\b|immigration|\bU\.?S\.? (port of entry|inspection station)|\bUS port\b|"
    r"international|pedestrian|passenger vehicle|commercial cargo|\bcrossing\b|(?<!new )mexico\b|"
    r"baja california|\bcanada\b|ontario|british columbia",
    re.I,
)
_AGRICULTURAL = re.compile(
    r"agricultur|\bag\b|\bUSDA\b|department of agriculture|plant (inspection|protection)|produce|growers?\b|"
    r"livestock|brand inspection|bug station",
    re.I,
)
# Safety, emissions and DMV style inspection. Only drops when nothing in the
# text says weigh station, because Virginia's DMV runs its weigh stations.
_VEHICLE_INSPECTION = re.compile(
    r"emission|emmision|smog|safety inspection|vehicular inspection|vehicle inspection|oil change|auto repair|"
    r"\btire|state inspection|\bDMV\b|\bMVA\b|\bMVC\b|\bVIN\b|department of motor vehicles|"
    r"motor vehicle inspection|importing",
    re.I,
)
_ENFORCEMENT_WORDS = re.compile(
    r"weigh|scale|motor carrier|\bCMV\b|commercial vehicle|port of entry|\bPOE\b", re.I
)
_CLOSED = re.compile(r"\b(closed|abandoned|former|old|demolished|proposed|future)\b", re.I)
_CLOSED_KEYS = ("disused", "abandoned", "demolished", "was:", "removed", "end_date")
_PRIVATE = re.compile(
    r"landfill|transfer station|waste|recycl|scrap|salvage|quarry|\bmine\b|mining|grain|elevator|\bfeed\b|"
    r"\bmill\b|lumber|gravel|\bsand\b|cement|asphalt|concrete|co-?op\b|farm|dairy|sugar|cotton|threshermen|"
    r"tractor pull|\bfair\b|brewery|historic|museum|public scales?|truck ?stop|travel center|plaza|\bauto\b|"
    r"['’]s\b|& service|railroad|railhead|rail yard|marine|harbor|terminal|sheet mill",
    re.I,
)
# Access values that say the scale is for a business's own customers.
_NOT_PUBLIC_ACCESS = frozenset({"private", "customers", "permit", "no"})
_GOVERNMENT = re.compile(
    r"\bDOT\b|\bD\.O\.T\.?\b|department of transport|transportation cabinet|highway patrol|state patrol|"
    r"state police|state trooper|public safety|\bDPS\b|motor carrier|\bCHP\b|\bKYTC\b|\b[A-Z]{1,3}DOT\b|"
    r"\bITD\b|\bMDT\b|\bOSHP\b|\bNSP\b|\bstate of\b|commonwealth of|department of revenue|"
    r"department of motor vehicles|\bDMV\b|highway administration|\bpolice\b|\bpatrol\b",
    re.I,
)
# Names that mean enforcement on their own.
_STATION_NAME = re.compile(
    r"weigh[ -]?station|weight station|weigh[ -]?scales?|weigh[ -]in[ -]motion|\bWIM\b|state scale|"
    r"port of entry|\bPOE\b|motor carrier|\bCMV\b|commercial vehicle",
    re.I,
)
# "Inspection station" is also what New Jersey calls its car inspection
# lanes, so it needs a public operator or a truck word beside it.
_INSPECTION_NAME = re.compile(r"inspection (station|facility|building)", re.I)
_TRUCK_WORDS = re.compile(r"\btruck|weigh|scale|\bCMV\b|commercial|\bDOT\b|patrol|police|\bDPS\b", re.I)
# "Arizona Inspection Station" is the state's; "Wayne Inspection Station" is a town's car lane.
_STATE_NAME = re.compile(r"\b(" + "|".join(re.escape(s.name) for s in load_states().states) + r")\b", re.I)
# Names that mean a scale, which is enforcement only with a public operator
# or a highway in the name ("Interstate 80 Westbound Truck Scales").
_SCALE_NAME = re.compile(r"scale house|truck scales?|\bDOT scale|\bscales?\b", re.I)
_HIGHWAY_WORDS = re.compile(
    r"\bI-? ?\d+\b|interstate|\bhighway\b|\bUS-? ?\d+\b|\bSR-? ?\d+\b|northbound|southbound|eastbound|"
    r"westbound|\b[NSEW]B\b",
    re.I,
)
_ROAD_NAME = re.compile(r"\b(road|rd|lane|ln|drive|dr|street|st|way|access|exit|ramp)\.?$", re.I)
_NOT_A_STATION_KEYS = ("railway", "public_transport", "traffic_sign", "shop", "craft", "tourism", "leisure",
                       "natural", "place", "military", "healthcare", "route", "end_date")
_STATION_AMENITY = frozenset(
    "weighbridge weigh_station weight_station vehicle_inspection police parking public_building townhall".split()
)
_WEIGH_AMENITY = frozenset({"weighbridge", "weigh_station", "weight_station"})
# A "port of entry" this close to the national outline with no weigh tag is
# a customs post. State ports of entry sit well inland (the nearest, Anthony
# in New Mexico, is about 25 km from Mexico).
BORDER_KM = 10.0
_BORDER_NAME = re.compile(r"port of entry|\bPOE\b|inspection (station|facility)|crossing", re.I)
# Overpass already bounds the OSM results to the US admin area, so an OSM
# point that misses the us-atlas polygons by this much is a coast drawn
# coarsely (the Anchorage weigh station sits on a tidal flat), not Mexico.
# NTAD and Iowa rows get no tolerance.
COAST_TOLERANCE_KM = 1.0

# Spot check of the OSM weigh layer against state DOT layers kept in the cache
# under state_layers/. Only the ratio is published. Each entry: file, and the
# property test that keeps a row (None keeps all), written as (field, test,
# value) so coverage.json can print it.
SPOT_CHECK_KM = 1.5
SPOT_CHECK_LAYERS: dict[str, tuple[str, tuple[str, str, str] | None]] = {
    "AK": ("AK.geojson", None),
    "AZ": ("AZ.geojson", ("Active", "equals", "YES")),
    "CA": ("CA.geojson", None),
    "CO": ("CO.geojson", ("Port_Name", "excludes", "Future")),
    "FL": ("FL.geojson", ("Facility_T", "excludes", "Rest Area")),
    "IA": ("IA.geojson", None),
    "IL": ("IL.geojson", None),
    "LA": ("LA.geojson", ("StationType", "startswith", "Station")),
    "MD": ("MD_2009.geojson", None),
    "MT": ("MT.geojson", ("TYPE", "contains", "Staff")),
    "NC": ("NC.geojson", ("Type", "startswith", "Phys")),
    "OK": ("OK.geojson", ("FAC_STATUS", "startswith", "IN OPERATION")),
    "WI": ("WI.geojson", None),
}

# Chain coverage was measured once against the chains' own locators, whose
# terms forbid keeping copies, so those lists are not in the repo and this
# cannot be recomputed here. Each row: brand keys, OSM sites at the time,
# official site count, official sites with an OSM site within 500 m (None
# where only the two counts were compared), where the official count came
# from. Re-measure when the OSM base moves far from CHAIN_COVERAGE_OSM_BASE.
CHAIN_COVERAGE_MEASURED = "2026-09-21"
CHAIN_COVERAGE_OSM_BASE = "2026-09-20T01:32:50Z"
CHAIN_MATCH_M = 500
CHAIN_COVERAGE: tuple[tuple[tuple[str, ...], int, int | None, int | None, str], ...] = (
    (("loves",), 480, 680, 479, "Love's store list on loves.com"),
    (("pilot", "flyingj"), 459, 817, None, "Pilot Flying J US store pages, pilotflyingj.com sitemap"),
    (("ta",), 72, 272, 69, "TA and TA Express site list on ta-petro.com"),
    (("petro",), 58, 77, 30, "Petro site list on ta-petro.com"),
    (("roadranger",), 32, 55, 29, "Road Ranger locator on roadrangerusa.com"),
    (("one9",), 30, None, None, "no public count found"),
)
FHWA_REFERENCE = {
    "count": 680,
    "year": 2009,
    "text": "approximately 680 weigh stations are in operation in the United States",
    "source": "FHWA, Concept of Operations for Virtual Weigh Station, section 2, 2009",
    "source_url": "https://ops.fhwa.dot.gov/publications/fhwahop09051/sec02.htm",
}


class MapDataError(ValueError):
    """A response or cache file is not what this build expects. Nothing was written."""


# ---------------------------------------------------------------- schemas


class MapValidators:
    def __init__(self, schemas_dir: Path | str = SCHEMAS_DIR):
        self._validators = {}
        checker = store._format_checker()
        for kind, filename in SCHEMA_FILES.items():
            with open(Path(schemas_dir) / filename, encoding="utf-8") as f:
                schema = json.load(f)
            Draft202012Validator.check_schema(schema)
            self._validators[kind] = Draft202012Validator(schema, format_checker=checker)

    def errors(self, kind: str, doc) -> list[str]:
        out = []
        for err in sorted(self._validators[kind].iter_errors(doc), key=lambda e: list(e.absolute_path)):
            where = "/".join(str(p) for p in err.absolute_path) or "(root)"
            out.append(f"{where}: {err.message}")
        return out

    def validate(self, kind: str, doc) -> None:
        errs = self.errors(kind, doc)
        if errs:
            shown = "; ".join(errs[:5])
            more = f" (and {len(errs) - 5} more)" if len(errs) > 5 else ""
            raise store.SchemaError(f"{kind} failed schema validation: {shown}{more}")


def write_doc(kind: str, path: Path | str, doc, v: MapValidators) -> bool:
    """Validate then write. Raises SchemaError (and writes nothing) on a bad document."""
    v.validate(kind, doc)
    text = store.dumps(doc)
    if json.loads(text) != json.loads(json.dumps(doc)):
        raise store.SchemaError(f"{kind} did not round trip through JSON")
    return store.write_text_if_changed(path, text)


# ---------------------------------------------------------------- geometry


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def round_coord(x: float) -> float:
    return store.num(round(x, COORD_DECIMALS))


def decode_topology(topo: dict, obj: str) -> list[tuple[dict, str | None, list[list[list[tuple[float, float]]]]]]:
    """Decode one TopoJSON object into (properties, id, polygons) rows.

    A polygon is a list of rings, the first the outer, the rest holes; a ring
    is a list of (lon, lat). Arcs are delta encoded and quantized when the
    topology carries a transform, and a negative arc index means that arc
    reversed. Consecutive arcs of a ring share their end point, which is
    dropped so a ring never repeats a vertex.
    """
    if topo.get("type") != "Topology" or obj not in topo.get("objects", {}):
        raise MapDataError(f"not a TopoJSON topology with an object called {obj!r}")
    transform = topo.get("transform")
    arcs: list[list[tuple[float, float]]] = []
    for arc in topo["arcs"]:
        pts = []
        if transform:
            sx, sy = transform["scale"]
            tx, ty = transform["translate"]
            x = y = 0
            for dx, dy in arc:
                x += dx
                y += dy
                pts.append((x * sx + tx, y * sy + ty))
        else:
            pts = [(float(x), float(y)) for x, y in arc]
        arcs.append(pts)

    def ring(indexes) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for i in indexes:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            if out and out[-1] == pts[0]:
                pts = pts[1:]
            out.extend(pts)
        if len(out) > 1 and out[0] == out[-1]:
            out.pop()
        return out

    rows = []
    geometries = topo["objects"][obj]
    items = geometries["geometries"] if geometries.get("type") == "GeometryCollection" else [geometries]
    for g in items:
        if g["type"] == "Polygon":
            polys = [[ring(r) for r in g["arcs"]]]
        elif g["type"] == "MultiPolygon":
            polys = [[ring(r) for r in poly] for poly in g["arcs"]]
        else:
            continue
        rows.append((g.get("properties") or {}, g.get("id"), polys))
    return rows


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x:
                inside = not inside
        j = i
    return inside


def _bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


class Boundaries:
    """The 50 states plus DC as polygons, for a real point in polygon test."""

    def __init__(self, polygons: list[tuple[str, list[list[tuple[float, float]]]]]):
        # (code, polygon, bbox of its outer ring)
        self._polys = [(code, poly, _bbox(poly[0])) for code, poly in polygons if poly and poly[0]]

    @property
    def codes(self) -> frozenset[str]:
        """The state codes these polygons cover."""
        return frozenset(code for code, _, _ in self._polys)

    @classmethod
    def from_topology(cls, topo: dict, states: StateTable, obj: str = "states") -> "Boundaries":
        by_fips = {s.fips: s.code for s in states.states}
        polygons = []
        for _, gid, polys in decode_topology(topo, obj):
            code = by_fips.get(str(gid))
            if code is None:
                continue  # Puerto Rico and the other territories
            for poly in polys:
                polygons.append((code, poly))
        found = {code for code, _ in polygons}
        missing = sorted(s.code for s in states.states if s.code not in found)
        if missing:
            raise MapDataError(f"the boundaries are missing {', '.join(missing)}")
        return cls(polygons)

    @classmethod
    def from_us_atlas(cls, states: StateTable, path: Path | str = US_ATLAS_STATES) -> "Boundaries":
        path = Path(path)
        if not path.exists():
            raise MapDataError(f"{path} is missing. Run npm ci first; us-atlas is a package of the site.")
        return cls.from_topology(store.read_json(path), states)

    def _state_at(self, lat: float, lon: float) -> str | None:
        for code, poly, (x0, y0, x1, y1) in self._polys:
            if not (x0 <= lon <= x1 and y0 <= lat <= y1):
                continue
            if point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, hole) for hole in poly[1:]):
                return code
        return None

    def state_of(self, lat: float, lon: float, tolerance_km: float = 0.0) -> str | None:
        """The state a point lies in, or None outside the 50 states plus DC.

        With tolerance_km, a point that misses is tried again tolerance_km
        away in eight directions, and the first state found wins. That is
        for sources already bounded to the US by a precise boundary (an
        Overpass area query), where the only way to fall out is the 10 m
        generalisation of the coast cutting off a pier or a tidal flat.
        Everything else gets the strict test.
        """
        code = self._state_at(lat, lon)
        if code is not None or tolerance_km <= 0:
            return code
        dlat = tolerance_km / 110.57
        dlon = tolerance_km / (111.32 * max(math.cos(math.radians(lat)), 0.05))
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            code = self._state_at(lat + dy * dlat, lon + dx * dlon)
            if code is not None:
                return code
        return None


class Outline:
    """Rings of the national outline, for distance to the border or coast."""

    _CELL = 1.0  # degrees

    def __init__(self, rings: list[list[tuple[float, float]]]):
        self._segments: list[tuple[float, float, float, float]] = []
        self._grid: dict[tuple[int, int], list[int]] = {}
        for ring in rings:
            n = len(ring)
            for i in range(n):
                (x1, y1), (x2, y2) = ring[i], ring[(i + 1) % n]
                idx = len(self._segments)
                self._segments.append((x1, y1, x2, y2))
                for cx in range(int(math.floor(min(x1, x2))), int(math.floor(max(x1, x2))) + 1):
                    for cy in range(int(math.floor(min(y1, y2))), int(math.floor(max(y1, y2))) + 1):
                        self._grid.setdefault((cx, cy), []).append(idx)

    @classmethod
    def from_topology(cls, topo: dict, obj: str = "nation") -> "Outline":
        rings = []
        for _, _, polys in decode_topology(topo, obj):
            for poly in polys:
                rings.extend(poly)
        return cls(rings)

    @classmethod
    def from_us_atlas(cls, path: Path | str = US_ATLAS_NATION) -> "Outline":
        path = Path(path)
        if not path.exists():
            raise MapDataError(f"{path} is missing. Run npm ci first; us-atlas is a package of the site.")
        return cls.from_topology(store.read_json(path))

    def distance_km(self, lat: float, lon: float) -> float:
        """Distance to the nearest outline segment within the surrounding degree cells, else infinity."""
        kx = 111.32 * math.cos(math.radians(lat))
        ky = 110.57
        best = math.inf
        cx, cy = int(math.floor(lon)), int(math.floor(lat))
        seen: set[int] = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for idx in self._grid.get((cx + dx, cy + dy), ()):
                    if idx in seen:
                        continue
                    seen.add(idx)
                    x1, y1, x2, y2 = self._segments[idx]
                    ax, ay = (x1 - lon) * kx, (y1 - lat) * ky
                    bx, by = (x2 - lon) * kx, (y2 - lat) * ky
                    vx, vy = bx - ax, by - ay
                    denom = vx * vx + vy * vy
                    t = 0.0 if denom == 0 else max(0.0, min(1.0, -(ax * vx + ay * vy) / denom))
                    px, py = ax + t * vx, ay + t * vy
                    d = math.hypot(px, py)
                    if d < best:
                        best = d
        return best


# ---------------------------------------------------------------- Overpass elements


def _position(e: dict) -> tuple[float, float] | None:
    if "lat" in e and "lon" in e:
        return float(e["lat"]), float(e["lon"])
    c = e.get("center")
    if c and "lat" in c and "lon" in c:
        return float(c["lat"]), float(c["lon"])
    return None


def osm_ref(e: dict) -> str:
    """Short OSM id like n123, w456, r789."""
    return f"{e['type'][0]}{e['id']}"


_TYPE_ORDER = {"way": 0, "node": 1, "relation": 2}


def load_overpass(doc, what: str) -> tuple[list[dict], str]:
    """Elements and the OSM base timestamp of one Overpass JSON response."""
    if not isinstance(doc, dict) or not isinstance(doc.get("elements"), list):
        raise MapDataError(f"the {what} response is not an Overpass JSON document")
    remark = doc.get("remark")
    if remark and re.search(r"error|timed? ?out|runtime|too busy", str(remark), re.I):
        raise MapDataError(f"Overpass returned a remark for {what}: {remark}")
    osm3s = doc.get("osm3s") or {}
    base = osm3s.get("timestamp_osm_base")
    if not isinstance(base, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", base):
        raise MapDataError(f"the {what} response has no osm3s.timestamp_osm_base")
    elements = []
    for e in doc["elements"]:
        if not isinstance(e, dict) or e.get("type") not in _TYPE_ORDER or not isinstance(e.get("id"), int):
            raise MapDataError(f"the {what} response has an element this build doesn't know: {e!r}"[:200])
        if _position(e) is None:
            continue  # no coordinates, nothing to map
        e = dict(e)
        e["tags"] = dict(e.get("tags") or {})
        elements.append(e)
    return elements, base


def _sort_key(e: dict):
    lat, lon = _position(e)
    return (lat, lon, _TYPE_ORDER[e["type"]], e["id"])


# ---------------------------------------------------------------- stations


def brand_of(tags: dict) -> str | None:
    """Brand key for a fuel object, in the order the Overpass query matched it."""
    key = _WIKIDATA_TO_BRAND.get(tags.get("brand:wikidata", ""))
    if key:
        return key
    if _ONE9.match(tags.get("brand", "")):
        return "one9"
    for k in ("name", "brand", "operator", "network"):
        if _AMBEST.search(tags.get(k, "")):
            return "ambest"
    return None


@dataclass
class Site:
    lat: float
    lon: float
    brand: str
    name: str
    osm: list[str]


def cluster_sites(elements: list[dict], radius_m: float = CLUSTER_M) -> tuple[list[Site], dict[str, int]]:
    """One site per group of same brand objects within radius_m of each other.

    Greedy in a fixed order (brand, lat, lon, type, id), so the same input
    always gives the same sites. An object joins the first cluster of its
    brand whose anchor is within radius_m, else starts one. The site sits at
    the mean of its members and takes the first non empty name.
    """
    by_brand: dict[str, list[dict]] = {}
    unbranded = 0
    for e in elements:
        key = brand_of(e["tags"])
        if key is None:
            unbranded += 1
            continue
        by_brand.setdefault(key, []).append(e)

    sites: list[Site] = []
    for brand in sorted(by_brand):
        clusters: list[list[dict]] = []
        for e in sorted(by_brand[brand], key=_sort_key):
            lat, lon = _position(e)
            for members in clusters:
                alat, alon = _position(members[0])
                if abs(alat - lat) < 0.01 and haversine_m(alat, alon, lat, lon) <= radius_m:
                    members.append(e)
                    break
            else:
                clusters.append([e])
        display = BRANDS.get(brand, (brand, None))[0]
        for members in clusters:
            lat = sum(_position(m)[0] for m in members) / len(members)
            lon = sum(_position(m)[1] for m in members) / len(members)
            name = next((m["tags"]["name"].strip() for m in members if m["tags"].get("name", "").strip()), display)
            sites.append(Site(round_coord(lat), round_coord(lon), brand, name, [osm_ref(m) for m in members]))
    counts = {brand: sum(1 for s in sites if s.brand == brand) for brand in by_brand}
    counts["unbranded"] = unbranded
    return sites, counts


# ---------------------------------------------------------------- weigh stations


def _text(tags: dict) -> str:
    return " ".join(tags.get(k, "") for k in ("name", "operator", "operator:short", "brand"))


def has_weigh_tag(tags: dict) -> bool:
    return (
        tags.get("amenity") in _WEIGH_AMENITY
        or tags.get("service") == "weigh_station"
        or tags.get("man_made") == "weigh_station"
    )


def is_government(tags: dict) -> bool:
    return bool(_GOVERNMENT.search(_text(tags)))


def classify(tags: dict) -> str:
    """Why an object is or is not a weigh station candidate.

    Returns "tag" (kept, it carries a weigh station tag), "name" (kept on its
    name and operator), or the reason it was dropped.
    """
    name = tags.get("name", "")
    text = _text(tags)
    weigh_tag = has_weigh_tag(tags)
    gov = is_government(tags)
    if _CAT_SCALE.search(text) or tags.get("brand:wikidata") == _CAT_SCALE_WIKIDATA:
        return "cat_scale"
    if tags.get("barrier") == "border_control" or _BORDER.search(text):
        return "border"
    if _AGRICULTURAL.search(text):
        return "agricultural"
    if _VEHICLE_INSPECTION.search(text) and not _ENFORCEMENT_WORDS.search(text):
        return "vehicle_inspection"
    if _CLOSED.search(name) or any(k.startswith(_CLOSED_KEYS) for k in tags):
        return "closed"
    highway = tags.get("highway")
    if highway and not weigh_tag and highway not in ("rest_area", "services"):
        return "road"  # a road named after the station, or its driveway
    if _ROAD_NAME.search(name) and not weigh_tag:
        return "road"
    if any(k in tags for k in _NOT_A_STATION_KEYS) or tags.get("type") == "route":
        return "not_a_station"
    if "amenity" in tags and tags["amenity"] not in _STATION_AMENITY:
        return "not_a_station"
    station_tag = tags.get("service") == "weigh_station" or tags.get("man_made") == "weigh_station"
    if not gov and (_PRIVATE.search(text) or (tags.get("access") in _NOT_PUBLIC_ACCESS and not station_tag)):
        return "private"
    if weigh_tag:
        only_weighbridge = tags.get("amenity") == "weighbridge" and not station_tag
        if only_weighbridge and not (gov or _STATION_NAME.search(name)):
            return "private_scale"  # any scale is a weighbridge; most are at truck stops
        return "tag"
    if _STATION_NAME.search(name):
        return "name"
    if _INSPECTION_NAME.search(name) and (gov or _TRUCK_WORDS.search(text) or _STATE_NAME.search(name)):
        return "name"
    if _SCALE_NAME.search(name) and (gov or _HIGHWAY_WORDS.search(name)):
        return "name"
    return "weak"


@dataclass
class Candidate:
    lat: float
    lon: float
    name: str | None
    via: str
    osm: list[str]
    # A public operator (state DOT, patrol, police) among the members.
    gov: bool = False
    state: str | None = None


def _priority(e: dict):
    tags = e["tags"]
    return (
        0 if has_weigh_tag(tags) else 1,
        0 if is_government(tags) else 1,
        0 if tags.get("name", "").strip() else 1,
        _TYPE_ORDER[e["type"]],
        e["id"],
    )


def weigh_candidates(
    responses: dict[str, list[dict]], radius_m: float = DEDUPE_M
) -> tuple[list[Candidate], dict[str, int]]:
    """Filter the three Overpass result sets and dedupe them at radius_m.

    An object in more than one set counts once. After the rules in classify,
    objects are ranked (weigh tag, public operator, named, way before node,
    id) and each one is kept unless a higher ranked keeper lies within
    radius_m, which folds the scale lane, the building and the node of one
    station into one candidate carrying all their ids.
    """
    seen: dict[tuple[str, int], dict] = {}
    for name in ("weighbridge", "tags", "names"):
        for e in responses.get(name, []):
            seen.setdefault((e["type"], e["id"]), e)
    reasons: dict[str, int] = {}
    keep: list[dict] = []
    for e in seen.values():
        why = classify(e["tags"])
        reasons[why] = reasons.get(why, 0) + 1
        if why in ("tag", "name"):
            keep.append(e)
    keep.sort(key=_priority)
    groups: list[list[dict]] = []
    for e in keep:
        lat, lon = _position(e)
        for members in groups:
            alat, alon = _position(members[0])
            if abs(alat - lat) < 0.02 and haversine_m(alat, alon, lat, lon) <= radius_m:
                members.append(e)
                break
        else:
            groups.append([e])
    out = []
    for members in groups:
        head = members[0]
        lat, lon = _position(head)
        name = next((m["tags"]["name"].strip() for m in members if m["tags"].get("name", "").strip()), None)
        via = "tag" if any(has_weigh_tag(m["tags"]) for m in members) else "name"
        gov = any(is_government(m["tags"]) for m in members)
        out.append(Candidate(round_coord(lat), round_coord(lon), name, via, [osm_ref(m) for m in members], gov))
    out.sort(key=lambda c: (c.lat, c.lon))
    counts = {"elements": len(seen), "kept": len(keep), "candidates": len(out)}
    counts.update({f"dropped_{k}": n for k, n in sorted(reasons.items()) if k not in ("tag", "name")})
    return out, counts


def near_border(c: Candidate, outline: Outline) -> bool:
    """A customs style port of entry: named like one, no state operator, close to the outline.

    The outline includes the coast, so a state patrol station by the sea
    (Bow Hill on I-5) is exempt through its operator, and anything with a
    weigh word in its name is exempt as well. A weigh lane that folded into
    an international bridge's name is still the bridge.
    """
    if c.gov or not c.name or not _BORDER_NAME.search(c.name):
        return False
    if re.search(r"weigh|scale", c.name, re.I):
        return False
    return outline.distance_km(c.lat, c.lon) <= BORDER_KM


# ---------------------------------------------------------------- NTAD and Iowa


def _clean(value) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s if s and s.upper() not in ("NA", "N/A", "NULL", "NONE") else None


def ntad_sites(doc) -> list[dict]:
    if not isinstance(doc, dict) or not isinstance(doc.get("features"), list):
        raise MapDataError("the NTAD response is not an ArcGIS feature set")
    if doc.get("exceededTransferLimit"):
        raise MapDataError("the NTAD response was cut short (exceededTransferLimit)")
    out = []
    for f in doc["features"]:
        a = f.get("attributes") or {}
        name = _clean(a.get("nhs_rest_stop"))
        if not name or not NTAD_NAME.search(name):
            continue  # the query asked for weigh or scale rows, but check anyway
        try:
            lat, lon = float(a["latitude"]), float(a["longitude"])
        except (KeyError, TypeError, ValueError):
            g = f.get("geometry") or {}
            if "x" not in g or "y" not in g:
                continue
            lat, lon = float(g["y"]), float(g["x"])
        spots = a.get("number_of_spots")
        if not isinstance(a.get("OBJECTID"), int):
            raise MapDataError(f"an NTAD row has no OBJECTID: {name!r}")
        out.append(
            {
                "lat": round_coord(lat),
                "lon": round_coord(lon),
                "name": name,
                "state": _clean(a.get("state")),
                "route": _clean(a.get("highway_route")),
                "milepost": _clean(a.get("mile_post")),
                "spots": int(spots) if isinstance(spots, (int, float)) and not isinstance(spots, bool) else None,
                "id": a["OBJECTID"],
            }
        )
    out.sort(key=lambda r: (r["state"] or "", r["lat"], r["lon"], r["id"]))
    return out


def iowa_sites(doc) -> tuple[list[dict], str | None]:
    """Sites and the newest EDITED_DATE among them (a date, from epoch ms)."""
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection" or not isinstance(doc.get("features"), list):
        raise MapDataError("the Iowa response is not a GeoJSON FeatureCollection")
    out = []
    newest = None
    for f in doc["features"]:
        p = f.get("properties") or {}
        g = f.get("geometry") or {}
        coords = g.get("coordinates") if g.get("type") == "Point" else None
        if coords and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])
        elif p.get("LATITUDE") is not None and p.get("LONGITUDE") is not None:
            lat, lon = float(p["LATITUDE"]), float(p["LONGITUDE"])
        else:
            continue
        edited = p.get("EDITED_DATE")
        if isinstance(edited, (int, float)) and not isinstance(edited, bool):
            day = datetime.fromtimestamp(edited / 1000, timezone.utc).date().isoformat()
            newest = day if newest is None or day > newest else newest
        if not isinstance(p.get("OBJECTID"), int):
            raise MapDataError("an Iowa row has no OBJECTID; is state_layers/IA.geojson the Weigh_Scale_View layer?")
        out.append(
            {
                "lat": round_coord(lat),
                "lon": round_coord(lon),
                "name": _clean(p.get("REST_AREAS")) or _clean(p.get("ADDRESS")) or "Weigh scale",
                "route": _clean(p.get("ROUTE")),
                "direction": _clean(p.get("TRAVEL_DIRECTION")),
                "city": _clean(p.get("NEAREST_CITY")),
                "id": p["OBJECTID"],
            }
        )
    out.sort(key=lambda r: (r["lat"], r["lon"], r["id"]))
    return out, newest


# ---------------------------------------------------------------- coverage


def layer_points(doc, test: tuple[str, str, str] | None) -> list[tuple[float, float]]:
    """Points of a state DOT GeoJSON layer that pass its property test."""
    if not isinstance(doc, dict) or not isinstance(doc.get("features"), list):
        raise MapDataError("a state layer is not a GeoJSON FeatureCollection")
    out = []
    for f in doc["features"]:
        p = f.get("properties") or {}
        if test is not None:
            fld, how, value = test
            actual = str(p.get(fld))
            ok = {
                "equals": actual.upper() == value.upper(),
                "excludes": value.lower() not in actual.lower(),
                "startswith": actual.lower().startswith(value.lower()),
                "contains": value.lower() in actual.lower(),
            }[how]
            if not ok:
                continue
        g = f.get("geometry") or {}
        coords = g.get("coordinates")
        while coords and isinstance(coords[0], list):
            coords = coords[0]
        if coords and len(coords) >= 2 and isinstance(coords[0], (int, float)):
            lon, lat = float(coords[0]), float(coords[1])
        else:
            lat = next((p[k] for k in ("Lat", "LATITUDE", "Latitude", "lat", "Y_LAT") if p.get(k) is not None), None)
            lon = next(
                (p[k] for k in ("long", "LONGITUDE", "Longitude", "long_", "Lon", "X_LONG") if p.get(k) is not None),
                None,
            )
            if lat is None or lon is None:
                continue
            lat, lon = float(lat), float(lon)
        out.append((lat, lon))
    return out


def spot_check(
    candidates: list[Candidate], layers: dict[str, list[tuple[float, float]]], km: float = SPOT_CHECK_KM
) -> dict[str, dict[str, int]]:
    """Per state: official points, and how many have a candidate within km."""
    out = {}
    for code in sorted(layers):
        pts = layers[code]
        matched = 0
        for lat, lon in pts:
            if any(abs(c.lat - lat) < 0.05 and haversine_m(lat, lon, c.lat, c.lon) <= km * 1000 for c in candidates):
                matched += 1
        out[code] = {"official": len(pts), "matched": matched}
    return out


# ---------------------------------------------------------------- cache


def fetched_dates(cache_dir: Path) -> dict[str, str]:
    path = Path(cache_dir) / FETCHED_FILE
    if not path.exists():
        return {}
    doc = store.read_json(path)
    if not isinstance(doc, dict):
        raise MapDataError(f"{path} is not an object of file names to dates")
    return {k: str(v) for k, v in doc.items()}


def fetched_date(cache_dir: Path, rel: str) -> str:
    """The day a cached response was fetched: the sidecar, else the file's mtime in UTC."""
    day = fetched_dates(cache_dir).get(rel)
    if day:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise MapDataError(f"{FETCHED_FILE} has a date that isn't YYYY-MM-DD for {rel}: {day!r}")
        return day
    path = Path(cache_dir) / rel
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).date().isoformat()


def _cache_path(cache_dir: Path, rel: str) -> Path:
    path = Path(cache_dir) / rel
    if not path.exists():
        raise MapDataError(f"{path} is missing. Run scripts/update_map_data.py --live to fetch it.")
    return path


def _overpass(http: HttpClient, query: str, what: str, sleep, log) -> dict:
    url = OVERPASS_URL + "?" + urlencode({"data": query})
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    for attempt in (1, 2):
        try:
            resp = http.get(url, headers=headers, timeout=OVERPASS_TIMEOUT + 60)
        except NetworkError as e:
            if attempt == 2:
                raise MapDataError(f"Overpass {what}: {e}") from e
            log(f"Overpass {what}: {e}; one retry in {OVERPASS_RETRY_AFTER} s")
            sleep(OVERPASS_RETRY_AFTER)
            continue
        if resp.status in (429, 504) and attempt == 1:
            log(f"Overpass {what}: HTTP {resp.status}; one retry in {OVERPASS_RETRY_AFTER} s")
            sleep(OVERPASS_RETRY_AFTER)
            continue
        if resp.status != 200:
            raise MapDataError(f"Overpass {what}: HTTP {resp.status}")
        try:
            doc = json.loads(resp.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as e:
            raise MapDataError(f"Overpass {what}: response is not JSON ({e})") from e
        load_overpass(doc, what)  # raises on a remark or a bad shape
        return doc
    raise MapDataError(f"Overpass {what}: gave up")  # pragma: no cover


def _arcgis(http: HttpClient, url: str, what: str) -> dict:
    try:
        resp = http.get(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout=120)
    except NetworkError as e:
        raise MapDataError(f"{what}: {e}") from e
    if resp.status != 200:
        raise MapDataError(f"{what}: HTTP {resp.status}")
    try:
        doc = json.loads(resp.body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise MapDataError(f"{what}: response is not JSON ({e})") from e
    if isinstance(doc, dict) and "error" in doc:
        raise MapDataError(f"{what}: ArcGIS error {doc['error']}")
    return doc


def fetch_live(cache_dir: Path, http: HttpClient, now: datetime, sleep, log=print) -> list[str]:
    """Refresh the cache: four Overpass queries one after another, then NTAD and Iowa.

    Each response is checked before it lands, so a busy Overpass leaves the
    old cached answer in place. Returns the cache files written.
    """
    cache_dir = Path(cache_dir)
    today = now.astimezone(timezone.utc).date().isoformat()
    dates = fetched_dates(cache_dir)
    written = []
    queries = [("brands", BRAND_QUERY)] + list(WEIGH_QUERIES.items())
    for i, (name, query) in enumerate(queries):
        if i:
            sleep(OVERPASS_PAUSE)
        log(f"Overpass {name}: one query, {OVERPASS_TIMEOUT} s timeout")
        doc = _overpass(http, query, name, sleep, log)
        rel = CACHE_FILES[name]
        store.write_text_if_changed(cache_dir / rel, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        dates[rel] = today
        written.append(rel)
        log(f"Overpass {name}: {len(doc['elements'])} elements, osm base {doc['osm3s']['timestamp_osm_base']}")
    for name, url, check in (
        ("ntad", NTAD_QUERY_URL, ntad_sites),
        ("ia", IA_QUERY_URL, lambda d: iowa_sites(d)[0]),
    ):
        doc = _arcgis(http, url, name)
        rows = check(doc)
        if not rows:
            raise MapDataError(f"{name}: the response has no usable rows, nothing written")
        rel = CACHE_FILES[name]
        store.write_text_if_changed(cache_dir / rel, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        dates[rel] = today
        written.append(rel)
        log(f"{name}: {len(rows)} rows")
    store.write_text_if_changed(cache_dir / FETCHED_FILE, store.dumps(dict(sorted(dates.items()))))
    return written


# ---------------------------------------------------------------- build


@dataclass
class MapResult:
    changed: dict[str, bool] = field(default_factory=dict)
    counts: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _share(matched: int | None, total: int | None) -> float | None:
    if matched is None or not total:
        return None
    return store.num(round(matched / total, 3))


def build(
    cache_dir: Path,
    data_dir: Path,
    states: StateTable,
    boundaries: Boundaries,
    outline: Outline,
    v: MapValidators | None = None,
) -> MapResult:
    """Build the five files under data_dir/map from the cache. Deterministic and idempotent."""
    cache_dir, data_dir = Path(cache_dir), Path(data_dir)
    v = v or MapValidators()
    result = MapResult()
    warn = result.warnings.append

    # stations
    rel = CACHE_FILES["brands"]
    elements, brand_base = load_overpass(store.read_json(_cache_path(cache_dir, rel)), "brands")
    sites, counts = cluster_sites(elements)
    outside = 0
    kept_sites = []
    for s in sites:
        if s.brand in DROPPED_BRANDS:
            continue
        if boundaries.state_of(s.lat, s.lon, COAST_TOLERANCE_KM) is None:
            outside += 1
            continue
        kept_sites.append(s)
    brand_counts = {key: sum(1 for s in kept_sites if s.brand == key) for key in BRANDS}
    stations_doc = {
        "schema": "dailyfuel/map-stations/1",
        **OSM,
        "query": BRAND_QUERY,
        "osm_base": brand_base,
        "fetched": fetched_date(cache_dir, rel),
        "cluster_m": CLUSTER_M,
        "brands": {key: {"name": name, "wikidata": qid, "sites": brand_counts[key]} for key, (name, qid) in BRANDS.items()},
        "counts": {
            "elements": len(elements),
            "sites": len(kept_sites),
            "dropped_ambest": counts.get("ambest", 0),
            "dropped_outside_us": outside,
        },
        "sites": [
            {"lat": s.lat, "lon": s.lon, "brand": s.brand, "name": s.name, "osm": s.osm}
            for s in sorted(kept_sites, key=lambda s: (s.brand, s.lat, s.lon))
        ],
    }
    if counts.get("unbranded"):
        warn(f"{counts['unbranded']} fuel objects matched the query but no brand rule; check brand_of")
    result.counts["stations"] = dict(stations_doc["counts"], **{f"brand_{k}": n for k, n in brand_counts.items()})

    # weigh stations from OSM
    responses = {}
    bases = {}
    for name in ("weighbridge", "tags", "names"):
        responses[name], bases[name] = load_overpass(store.read_json(_cache_path(cache_dir, CACHE_FILES[name])), name)
    candidates, wcounts = weigh_candidates(responses)
    kept_c: list[Candidate] = []
    border = outside_w = 0
    for c in candidates:
        code = boundaries.state_of(c.lat, c.lon, COAST_TOLERANCE_KM)
        if code is None:
            outside_w += 1
            continue
        if near_border(c, outline):
            border += 1
            continue
        c.state = code
        kept_c.append(c)
    wcounts["dropped_border_outline"] = border
    wcounts["dropped_outside_us"] = outside_w
    wcounts["sites"] = len(kept_c)
    wcounts["via_tag"] = sum(1 for c in kept_c if c.via == "tag")
    wcounts["via_name"] = sum(1 for c in kept_c if c.via == "name")
    wcounts["states"] = len({c.state for c in kept_c})
    weigh_osm_doc = {
        "schema": "dailyfuel/map-weigh-osm/1",
        **OSM,
        "queries": dict(WEIGH_QUERIES),
        "osm_base": min(bases.values()),
        "fetched": min(fetched_date(cache_dir, CACHE_FILES[n]) for n in ("weighbridge", "tags", "names")),
        "dedupe_m": DEDUPE_M,
        "note": (
            "Candidates, not a complete list. Weigh and inspection stations in OpenStreetMap, minus CAT Scale and "
            "other truck stop scales, border crossings, agricultural and vehicle inspection sites. Coverage is "
            "measured in coverage.json."
        ),
        "counts": {k: wcounts[k] for k in sorted(wcounts)},
        "sites": [
            {"lat": c.lat, "lon": c.lon, "name": c.name, "state": c.state, "via": c.via, "osm": c.osm} for c in kept_c
        ],
    }
    result.counts["weigh_osm"] = dict(weigh_osm_doc["counts"])

    # NTAD
    rel = CACHE_FILES["ntad"]
    ntad_rows = ntad_sites(store.read_json(_cache_path(cache_dir, rel)))
    ntad_kept, ntad_outside = [], 0
    for r in ntad_rows:
        if boundaries.state_of(r["lat"], r["lon"]) is None:
            ntad_outside += 1
            continue
        ntad_kept.append(r)
    weigh_ntad_doc = {
        "schema": "dailyfuel/map-weigh-ntad/1",
        **NTAD,
        "query_url": NTAD_QUERY_URL,
        "fetched": fetched_date(cache_dir, rel),
        "counts": {"rows": len(ntad_rows), "sites": len(ntad_kept), "dropped_outside_us": ntad_outside},
        "sites": ntad_kept,
    }
    result.counts["weigh_ntad"] = dict(weigh_ntad_doc["counts"])

    # Iowa
    rel = CACHE_FILES["ia"]
    ia_rows, ia_edited = iowa_sites(store.read_json(_cache_path(cache_dir, rel)))
    ia_kept, ia_outside = [], 0
    for r in ia_rows:
        if boundaries.state_of(r["lat"], r["lon"]) != "IA":
            ia_outside += 1
            continue
        ia_kept.append(r)
    weigh_ia_doc = {
        "schema": "dailyfuel/map-weigh-ia/1",
        **IA,
        "query_url": IA_QUERY_URL,
        "records_edited": ia_edited,
        "fetched": fetched_date(cache_dir, rel),
        "counts": {"rows": len(ia_rows), "sites": len(ia_kept), "dropped_outside_iowa": ia_outside},
        "sites": ia_kept,
    }
    result.counts["weigh_ia"] = dict(weigh_ia_doc["counts"])

    # coverage
    layers = {}
    layer_dates = []
    missing = []
    for code, (filename, test) in SPOT_CHECK_LAYERS.items():
        rel = f"state_layers/{filename}"
        path = cache_dir / rel
        if not path.exists():
            missing.append(rel)
            continue
        layers[code] = layer_points(store.read_json(path), test)
        layer_dates.append(fetched_date(cache_dir, rel))
    if missing:
        raise MapDataError(
            "the spot check needs these state layers in the cache (they are not fetched by --live): "
            + ", ".join(missing)
        )
    per_state = spot_check(kept_c, layers)
    official = sum(r["official"] for r in per_state.values())
    matched = sum(r["matched"] for r in per_state.values())
    if brand_base != CHAIN_COVERAGE_OSM_BASE:
        warn(
            f"chain coverage was measured against OSM base {CHAIN_COVERAGE_OSM_BASE}, the stations are from "
            f"{brand_base}; re-measure against the chains' locators when you can"
        )
    chains = []
    for brands, osm_then, official_n, matched_n, source in CHAIN_COVERAGE:
        chains.append(
            {
                "brands": list(brands),
                "osm_sites": sum(brand_counts[b] for b in brands),
                "osm_sites_measured": osm_then,
                "official_sites": official_n,
                "matched": matched_n,
                "share": _share(matched_n if matched_n is not None else osm_then, official_n),
                "method": "official sites with an OSM site within 500 m" if matched_n is not None
                else ("OSM sites over the official count" if official_n else "no official count"),
                "official_source": source,
            }
        )
    coverage_doc = {
        "schema": "dailyfuel/map-coverage/1",
        "note": (
            "How much of the real world the OpenStreetMap layers hold, so the map legend can say so. Chain "
            "names are used only to identify locations; DailyFuel is not affiliated with or endorsed by any chain."
        ),
        "chains": {
            "measured": CHAIN_COVERAGE_MEASURED,
            "measured_osm_base": CHAIN_COVERAGE_OSM_BASE,
            "match_m": CHAIN_MATCH_M,
            "note": (
                "Measured once against each chain's own locator. Their terms forbid keeping copies, so the "
                "lists are not in this repo and these figures are not recomputed by the build."
            ),
            "rows": chains,
        },
        "weigh": {
            "measured": max(layer_dates),
            "osm_base": weigh_osm_doc["osm_base"],
            "match_km": SPOT_CHECK_KM,
            "official": official,
            "matched": matched,
            "share": _share(matched, official),
            "states": {
                code: {
                    **per_state[code],
                    "layer_filter": (
                        None if SPOT_CHECK_LAYERS[code][1] is None else " ".join(SPOT_CHECK_LAYERS[code][1])
                    ),
                }
                for code in per_state
            },
            "note": (
                "Official points from state DOT layers with an OSM candidate within match_km. The layers are "
                "only used for this count; several carry no reuse licence."
            ),
            "reference": dict(FHWA_REFERENCE),
        },
    }
    result.counts["coverage"] = {
        "weigh_official": official,
        "weigh_matched": matched,
        "weigh_share": coverage_doc["weigh"]["share"],
        "weigh_states": len(per_state),
    }

    for kind, rel_path, doc in (
        ("map-stations", STATIONS, stations_doc),
        ("map-weigh-osm", WEIGH_OSM, weigh_osm_doc),
        ("map-weigh-ntad", WEIGH_NTAD, weigh_ntad_doc),
        ("map-weigh-ia", WEIGH_IA, weigh_ia_doc),
        ("map-coverage", COVERAGE, coverage_doc),
    ):
        v.validate(kind, doc)  # all five must pass before any one is written
    for kind, rel_path, doc in (
        ("map-stations", STATIONS, stations_doc),
        ("map-weigh-osm", WEIGH_OSM, weigh_osm_doc),
        ("map-weigh-ntad", WEIGH_NTAD, weigh_ntad_doc),
        ("map-weigh-ia", WEIGH_IA, weigh_ia_doc),
        ("map-coverage", COVERAGE, coverage_doc),
    ):
        result.changed[str(rel_path)] = write_doc(kind, data_dir / rel_path, doc, v)
    return result
