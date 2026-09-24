"""Map base data: the freight road network, the state outlines and the place list.

Not part of the scheduled job. scripts/update_map_roads.py runs this by hand
and commits the outputs under data/map/, so a slow feature service never
breaks a deploy. Three files come out, one per source so each carries its
own licence:

  roads_nhfn.json  the National Highway Freight Network (NTAD, public domain):
                   the service's polylines merged by route sign where they
                   touch, simplified with Douglas Peucker, and written as
                   quantized, delta encoded integer arrays
  states.json      the 50 states plus DC as simplified GeoJSON from the Census
                   Bureau's 2023 cartographic boundary file at 1:20,000,000
                   (public domain), in true positions for a Web Mercator map,
                   no insets
  places.json      the 1,500 most populous US places plus every state
                   capital from GeoNames cities5000 (CC BY 4.0), for the
                   corridor tool's A and B picker

Everything is built from a cache directory of raw downloads. --live refreshes
that cache: the Census zip, the GeoNames zip, and the NHFN feature service one
page at a time with a 30 s timeout each. Road segments outside the 50 states
plus DC (Puerto Rico, anything in Canada or Mexico) are dropped by a point in
polygon test against the unsimplified Census outlines, never by a bounding box.

This module deliberately does not import mapdata: tests/test_mapdata.py holds
every module but mapdata.py to "never import the map code", so the two map
tools share nothing but the cache layout and the fetched.json sidecar.

The STAA National Network is not built. staa_estimate() (the tool's
--staa-estimate) sizes it without downloading it: on 2026-09-24 the layer
held 478,999 records, 453,529 of them on the network (NN = 1), 3.5 times the
NHFN's length. Built like roads_nhfn.json that is 88 KB gzip if its routes
merged as well as the interstates do, and 140 KB scaled from a 2,000 record
sample: against a 45 KB roads budget, so it waits for phase 2.
"""

from __future__ import annotations

import gzip
import io
import json
import math
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from xml.etree import ElementTree

from jsonschema import Draft202012Validator

from . import store
from .http import HttpClient, NetworkError
from .paths import REPO_ROOT, SCHEMAS_DIR
from .states import StateTable

# ---------------------------------------------------------------- locations

MAP_DIR = Path("map")
ROADS_NHFN = MAP_DIR / "roads_nhfn.json"
STATES = MAP_DIR / "states.json"
PLACES = MAP_DIR / "places.json"

# The same cache directory as scripts/update_map_data.py; the file names
# don't overlap and fetched.json is merged, never replaced.
DEFAULT_CACHE_DIR = REPO_ROOT / "tmp" / "map-cache"
FETCHED_FILE = "fetched.json"

SCHEMA_FILES = {
    "map-roads": "map-roads.schema.json",
    "map-places": "map-places.schema.json",
    "map-states": "map-states.schema.json",
}

# Raw downloads inside the cache directory. The NHFN pages sit next to the
# layer file, which is written last, so a fetch that stopped halfway leaves
# no layer file and the build refuses the cache.
CACHE_FILES = {
    "census": "census20m/cb_2023_us_state_20m.zip",
    "geonames": "geonames/cities5000.zip",
    "nhfn_layer": "nhfn/layer.json",
}
NHFN_PAGE_FILE = "nhfn/page_{:04d}.json"
NHFN_RUN_FILE = "nhfn/run.json"
_NHFN_PAGE_RE = re.compile(r"^page_(\d{4})\.json$")

# ---------------------------------------------------------------- sources

USER_AGENT = "DailyFuel map data tool (+https://github.com/lazizbekravshanov/DailyFuel)"
TIMEOUT = 30
# Seconds to wait before each retry of a request.
RETRY_AFTER = (5, 15)

_NTAD = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/"
NHFN_LAYER_URL = _NTAD + "NTAD_National_Highway_Freight_Network/FeatureServer/0"
NHFN_PAGE = 1000
NHFN_PRECISION = 4
NHFN_FIELDS = "SIGN1,NHFN_CODE,ST_NAME"
NHFN = {
    "source": "NTAD National Highway Freight Network, U.S. DOT BTS (Federal Highway Administration data)",
    "source_url": NHFN_LAYER_URL,
    "licence": "Public domain, a work of the United States government, available for unrestricted public use",
    "attribution": "Roads: NTAD National Highway Freight Network, U.S. DOT BTS, public domain",
}
# What NHFN_CODE means. The layer has no domain for the field; the values
# were read off the data: 1 is on every PHFS route, interstate or not (S78
# and U63 carry it), 2 only on interstates such as I359 and I759 that the
# description lists as "Other Interstate portions not on the PHFS". Critical
# rural and urban freight corridors are "not included in GIS data base".
NHFN_CODES = {
    "1": "Primary Highway Freight System",
    "2": "Interstate not on the Primary Highway Freight System",
}
_VERSION_RE = re.compile(r"NHFN Version (\d{4}\.\d{2}\.\d{2})")
_COMPILED_RE = re.compile(r"compiled on ([A-Z][a-z]+ \d{1,2}, \d{4})")

STAA_LAYER_URL = _NTAD + "NTAD_National_Network/FeatureServer/0"
STAA_SAMPLE = 2000
# NN = 1 marks a segment of the STAA National Network; the layer also holds
# other roads with NN = 0.
STAA_WHERE = "NN = 1"

CENSUS_URL = "https://www2.census.gov/geo/tiger/GENZ2023/kml/cb_2023_us_state_20m.zip"
CENSUS_MEMBER = "cb_2023_us_state_20m.kml"
CENSUS_TIMEOUT = 60
CENSUS = {
    "source": "U.S. Census Bureau, 2023 cartographic boundary file, states, 1:20,000,000 (cb_2023_us_state_20m)",
    "source_url": CENSUS_URL,
    "licence": "Public domain, a work of the United States government",
    "attribution": "State outlines: U.S. Census Bureau, public domain",
}
_KML = "{http://www.opengis.net/kml/2.2}"
_OUTER = f"{_KML}outerBoundaryIs/{_KML}LinearRing/{_KML}coordinates"
_INNER = f"{_KML}innerBoundaryIs/{_KML}LinearRing/{_KML}coordinates"

GEONAMES_URL = "https://download.geonames.org/export/dump/cities5000.zip"
GEONAMES_MEMBER = "cities5000.txt"
GEONAMES_TIMEOUT = 60
GEONAMES = {
    "source": "GeoNames cities5000, places with a population of 5,000 or more",
    "source_url": GEONAMES_URL,
    "licence": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    "licence_url": "https://creativecommons.org/licenses/by/4.0/",
    "attribution": "Place names: GeoNames, CC BY 4.0",
    "attribution_url": "https://www.geonames.org",
}

# ---------------------------------------------------------------- tuning

# Douglas Peucker tolerance in degrees for the roads. 0.01 is about 1 km,
# half a pixel at zoom 6; the national view lives at zoom 3 to 5.
ROADS_TOLERANCE = 0.01
# Output grid for the roads, 10^-2 degrees, the same order as the tolerance:
# a vertex moves at most 0.007 degrees, and the file is 30% smaller than on
# a 10^-3 grid (measured 24.0 KB against 35.0 KB gzip at this tolerance).
ROADS_PRECISION = 2
# Before Douglas Peucker, drop every vertex within this share of the
# tolerance of the last kept one: the source has a vertex every 10 m or so.
_RADIAL_SHARE = 0.5

STATES_TOLERANCE = 0.02
STATES_PRECISION = 2
# Islands smaller than this (square degrees, about 25 km2 in the lower 48)
# are dropped, except a state's largest polygon.
STATES_MIN_AREA = 0.003

PLACES_TOP = 1500
# 10^-2 degrees is about 1 km, plenty for picking the end of a 25 mile wide
# corridor. Columns, grouped by state and delta encoded, keep the file under
# 15 KB gzip; rows sorted by population were 18.2 KB.
PLACES_PRECISION = 2
# GeoNames feature codes that are a place in their own right. Sections of a
# place (PPLX: Hollywood, Harlem), abandoned, destroyed and historical ones
# are left out, so the picker lists cities, not neighbourhoods.
PLACE_CODES = frozenset({"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLA5", "PPLC", "PPLS", "PPLL", "PPLF", "PPLG"})
# PPLA is the seat of a first order division (a state capital); PPLC is
# the national capital, Washington, which stands for DC.
CAPITAL_CODES = frozenset({"PPLA", "PPLC"})

# The 1:20,000,000 coast cuts off a few bridges: the middle of the Sunshine
# Skyway is 4 km from it, the Bay Bridge 2.5 km, the Mackinac Bridge 0.5 km.
# A path with no vertex inside a state is kept only when its ends and middle
# are within this distance of the state its own ST_NAME gives; see
# segment_in_us. Tijuana's centre is 3 km from the generalised line, so the
# state name check is what keeps a Mexican path out, not the distance.
COAST_TOLERANCE_KM = 5.0

Point = tuple[float, float]


class RoadsError(ValueError):
    """A download or cache file is not what this build expects. Nothing was written."""


# ---------------------------------------------------------------- schemas


class RoadValidators:
    def __init__(self, schemas_dir: Path | str = SCHEMAS_DIR):
        self._validators = {}
        checker = store._format_checker()
        for kind, filename in SCHEMA_FILES.items():
            schema = store.read_json(Path(schemas_dir) / filename)
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


# One element per line under the big array, so git diffs stay readable and
# the file on disk stays close to its compact size.
ROW_KEYS = {"map-roads": "lines", "map-places": "places", "map-states": "features"}


def dumps_rows(doc: dict, key: str) -> str:
    """Indented JSON, except under key: a list gets one compact row per line, an object one compact
    column per line."""
    lines = ["{"]
    keys = list(doc.keys())
    for i, k in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        if k == key:
            rows = doc[k]
            items = list(rows.items()) if isinstance(rows, dict) else [(None, r) for r in rows]
            lines.append(f"  {json.dumps(k)}: " + ("{" if isinstance(rows, dict) else "["))
            for j, (name, row) in enumerate(items):
                rcomma = "," if j < len(items) - 1 else ""
                label = "" if name is None else f"{json.dumps(name)}: "
                lines.append("    " + label + json.dumps(row, ensure_ascii=False, separators=(",", ":")) + rcomma)
            lines.append("  " + ("}" if isinstance(rows, dict) else "]") + comma)
        else:
            body = json.dumps(doc[k], ensure_ascii=False, indent=2).replace("\n", "\n  ")
            lines.append(f"  {json.dumps(k)}: {body}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def write_doc(kind: str, path: Path | str, doc, v: RoadValidators) -> bool:
    """Validate then write. Raises SchemaError (and writes nothing) on a bad document."""
    v.validate(kind, doc)
    text = dumps_rows(doc, ROW_KEYS[kind])
    if json.loads(text) != json.loads(json.dumps(doc)):
        raise store.SchemaError(f"{kind} did not round trip through JSON")
    return store.write_text_if_changed(path, text)


def gzip_size(text: str | bytes) -> int:
    data = text.encode("utf-8") if isinstance(text, str) else text
    return len(gzip.compress(data, compresslevel=9, mtime=0))


# ---------------------------------------------------------------- geometry


def simplify(pts: list[Point], tolerance: float) -> list[Point]:
    """Douglas Peucker, iterative so a 60,000 vertex interstate never hits the recursion limit.

    Keeps both ends. A radial pass first drops every vertex within half the
    tolerance of the last kept one, which is most of them: the source has a
    vertex every 10 m or so. A closed ring (first point equal to the last)
    works too; its first split is at the vertex farthest from the start.
    """
    if tolerance <= 0:
        raise ValueError("tolerance must be positive")
    if len(pts) < 3:
        return list(pts)
    r2 = (tolerance * _RADIAL_SHARE) ** 2
    thinned = [pts[0]]
    for p in pts[1:-1]:
        q = thinned[-1]
        if (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 >= r2:
            thinned.append(p)
    thinned.append(pts[-1])
    pts = thinned
    n = len(pts)
    if n < 3:
        return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    t2 = tolerance * tolerance
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        x1, y1 = pts[i]
        x2, y2 = pts[j]
        dx, dy = x2 - x1, y2 - y1
        d2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for k in range(i + 1, j):
            x, y = pts[k]
            if d2 == 0:
                dist2 = (x - x1) ** 2 + (y - y1) ** 2
            else:
                t = ((x - x1) * dx + (y - y1) * dy) / d2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                dist2 = (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2
            if dist2 > best:
                best, idx = dist2, k
        if best > t2:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


def quantize(pts: list[Point], precision: int) -> list[tuple[int, int]]:
    """Integer coordinates in units of 10^-precision degrees, consecutive duplicates dropped."""
    scale = 10**precision
    out: list[tuple[int, int]] = []
    for x, y in pts:
        q = (int(round(x * scale)), int(round(y * scale)))
        if not out or out[-1] != q:
            out.append(q)
    return out


def delta_encode(q: list[tuple[int, int]]) -> list[int]:
    """[x0, y0, dx1, dy1, ...]: each pair is added to the one before it."""
    out: list[int] = []
    px = py = 0
    for x, y in q:
        out.append(x - px)
        out.append(y - py)
        px, py = x, y
    return out


def delta_decode(pts: list[int], precision: int) -> list[Point]:
    scale = 10**precision
    out = []
    x = y = 0
    for i in range(0, len(pts), 2):
        x += pts[i]
        y += pts[i + 1]
        out.append((x / scale, y / scale))
    return out


def ring_area(ring: list[Point]) -> float:
    """Unsigned shoelace area in square degrees. The ring may or may not repeat its first point."""
    n = len(ring)
    s = 0.0
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def point_in_ring(lon: float, lat: float, ring: list[Point]) -> bool:
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


class StatePolygons:
    """The 50 states plus DC as polygons, for a real point in polygon test."""

    def __init__(self, polygons: list[tuple[str, list[list[Point]]]]):
        self._polys = []
        for code, poly in polygons:
            if not poly or len(poly[0]) < 3:
                continue
            xs = [p[0] for p in poly[0]]
            ys = [p[1] for p in poly[0]]
            self._polys.append((code, poly, (min(xs), min(ys), max(xs), max(ys))))
        self._codes = frozenset(code for code, _, _ in self._polys)

    @property
    def codes(self) -> frozenset[str]:
        return self._codes

    def state_at(self, lat: float, lon: float) -> str | None:
        for code, poly, (x0, y0, x1, y1) in self._polys:
            if not (x0 <= lon <= x1 and y0 <= lat <= y1):
                continue
            if point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, hole) for hole in poly[1:]):
                return code
        return None

    def near(self, lat: float, lon: float, code: str, tolerance_km: float) -> bool:
        """True when the point, or one of eight points tolerance_km away, lies in the state with this code."""
        dlat = tolerance_km / 110.57
        dlon = tolerance_km / (111.32 * max(math.cos(math.radians(lat)), 0.05))
        probes = ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
        return any(self.state_at(lat + dy * dlat, lon + dx * dlon) == code for dy, dx in probes)


# ---------------------------------------------------------------- shared borders


def _vkey(p: Point) -> tuple[int, int]:
    return (int(round(p[0] * 1e7)), int(round(p[1] * 1e7)))


def split_arcs(rings: list[list[Point]]) -> tuple[list[list[Point]], list[list[tuple[int, bool]]]]:
    """Cut open rings (no repeated first point) into arcs that neighbours share.

    A vertex is a junction when it has different neighbours in different
    rings (where a border meets the coast, or three states meet), the rule
    TopoJSON uses. Each ring is cut at its junctions; a ring with none (an
    island) becomes one closed arc starting at its lowest vertex. An arc and
    its reverse are the same arc, stored once. Returns the arcs and, per
    ring, the (arc index, reversed) list that rebuilds it.
    """
    neighbours: dict[tuple[int, int], set] = {}
    all_keys = []
    for ring in rings:
        keys = [_vkey(p) for p in ring]
        all_keys.append(keys)
        n = len(keys)
        for i in range(n):
            a, b = keys[i - 1], keys[(i + 1) % n]
            neighbours.setdefault(keys[i], set()).add((a, b) if a <= b else (b, a))
    junction = {k for k, pairs in neighbours.items() if len(pairs) > 1}
    arcs: list[list[Point]] = []
    index: dict[tuple, int] = {}
    refs: list[list[tuple[int, bool]]] = []
    for ring, keys in zip(rings, all_keys):
        n = len(keys)
        cuts = [i for i in range(n) if keys[i] in junction]
        if not cuts:
            start = min(range(n), key=lambda i: keys[i])
            pieces = [list(range(start, n)) + list(range(0, start)) + [start]]
        else:
            pieces = []
            for c, a in enumerate(cuts):
                b = cuts[(c + 1) % len(cuts)]
                pieces.append(list(range(a, b + 1)) if b > a else list(range(a, n)) + list(range(0, b + 1)))
        ring_refs = []
        for idx in pieces:
            kt = tuple(keys[i] for i in idx)
            rk = kt[::-1]
            rev = rk < kt
            canon = rk if rev else kt
            aid = index.get(canon)
            if aid is None:
                aid = len(arcs)
                index[canon] = aid
                pts = [ring[i] for i in idx]
                arcs.append(pts[::-1] if rev else pts)
            ring_refs.append((aid, rev))
        refs.append(ring_refs)
    return arcs, refs


def simplify_rings(rings: list[list[Point]], tolerance: float) -> list[list[Point]]:
    """Simplify open rings so a border two rings share is simplified once and stays shared.

    Returns closed rings (first point repeated at the end).
    """
    arcs, refs = split_arcs(rings)
    simple = [simplify(arc, tolerance) for arc in arcs]
    out = []
    for ring_refs in refs:
        ring: list[Point] = []
        for aid, rev in ring_refs:
            pts = simple[aid][::-1] if rev else simple[aid]
            ring.extend(pts[1:] if ring else pts)
        out.append(ring)
    return out


# ---------------------------------------------------------------- states


@dataclass
class CensusState:
    fips: str
    code: str
    name: str
    polygons: list[list[list[Point]]]  # polygon, ring, (lon, lat); rings open


def _kml_ring(text: str | None, what: str) -> list[Point]:
    pts: list[Point] = []
    for tok in (text or "").split():
        parts = tok.split(",")
        try:
            pts.append((float(parts[0]), float(parts[1])))
        except (IndexError, ValueError) as e:
            raise RoadsError(f"{what} has a coordinate that is not lon,lat: {tok!r}") from e
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        raise RoadsError(f"{what} has a ring with fewer than 3 points")
    return pts


def read_census_kml(zip_bytes: bytes) -> list[CensusState]:
    """Every placemark of the Census state KML inside the zip, territories included."""
    try:
        z = zipfile.ZipFile(io.BytesIO(zip_bytes))
        root = ElementTree.fromstring(z.read(CENSUS_MEMBER))
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as e:
        raise RoadsError(f"the Census download is not a zip with a readable {CENSUS_MEMBER}: {e}") from e
    out = []
    for pm in root.iter(_KML + "Placemark"):
        data = {sd.get("name"): (sd.text or "").strip() for sd in pm.iter(_KML + "SimpleData")}
        fips, code, name = data.get("STATEFP"), data.get("STUSPS"), data.get("NAME")
        if not (fips and code and name):
            raise RoadsError("a Census placemark has no STATEFP, STUSPS or NAME")
        polygons = []
        for poly in pm.iter(_KML + "Polygon"):
            rings = [_kml_ring(c.text, code) for c in poly.findall(_OUTER)]
            if len(rings) != 1:
                raise RoadsError(f"{code} has a polygon with {len(rings)} outer rings")
            rings += [_kml_ring(c.text, code) for c in poly.findall(_INNER)]
            polygons.append(rings)
        if not polygons:
            raise RoadsError(f"{code} has no polygon")
        out.append(CensusState(fips, code, name, polygons))
    if not out:
        raise RoadsError(f"{CENSUS_MEMBER} has no placemarks")
    return out


def _states_only(rows: list[CensusState], states: StateTable) -> list[CensusState]:
    """The 50 states plus DC in FIPS order, checked against src/data/states.json."""
    by_fips = {s.fips: s for s in states.states}
    kept = []
    for r in rows:
        st = by_fips.get(r.fips)
        if st is None:
            continue  # Puerto Rico and the other territories
        if st.code != r.code:
            raise RoadsError(f"Census FIPS {r.fips} is {r.code}, states.json says {st.code}")
        kept.append(r)
    missing = sorted(s.code for s in states.states if s.fips not in {r.fips for r in kept})
    if missing:
        raise RoadsError(f"the Census file is missing {', '.join(missing)}")
    return sorted(kept, key=lambda r: r.fips)


def state_polygons(rows: list[CensusState], states: StateTable) -> StatePolygons:
    """Unsimplified outlines of the 50 states plus DC, for the road filter."""
    return StatePolygons([(r.code, poly) for r in _states_only(rows, states) for poly in r.polygons])


def _shift_west(poly: list[list[Point]]) -> list[list[Point]]:
    """Move a polygon that lies wholly east of the antimeridian 360 degrees west, next to Alaska."""
    if all(x > 0 for ring in poly for x, _ in ring):
        return [[(x - 360.0, y) for x, y in ring] for ring in poly]
    return poly


def states_geojson(
    rows: list[CensusState],
    states: StateTable,
    tolerance: float = STATES_TOLERANCE,
    precision: int = STATES_PRECISION,
    min_area: float = STATES_MIN_AREA,
) -> tuple[list[dict], dict[str, int]]:
    """GeoJSON features for the 50 states plus DC, borders simplified once so neighbours still meet."""
    kept_rows = _states_only(rows, states)
    flat: list[list[Point]] = []
    where: list[tuple[int, int, int]] = []  # (row, polygon, ring) of each flat ring
    for ri, r in enumerate(kept_rows):
        for pi, poly in enumerate(r.polygons):
            for gi, ring in enumerate(_shift_west(poly)):
                flat.append(ring)
                where.append((ri, pi, gi))
    simple = simplify_rings(flat, tolerance)
    scale = 10**precision
    rebuilt: dict[tuple[int, int], dict[int, list[Point]]] = {}
    for (ri, pi, gi), ring in zip(where, simple):
        q = quantize(ring, precision)
        if len(q) > 1 and q[0] == q[-1]:
            q.pop()
        pts = [(x / scale, y / scale) for x, y in q]
        if len(pts) >= 3 and ring_area(pts) > 0:
            rebuilt.setdefault((ri, pi), {})[gi] = pts
    features = []
    polygons = points = dropped = 0
    for ri, r in enumerate(kept_rows):
        kept: list[tuple[float, list[list[Point]]]] = []
        for pi in range(len(r.polygons)):
            rings = rebuilt.get((ri, pi), {})
            if 0 not in rings:
                dropped += 1  # the outer ring collapsed: an island under a pixel
                continue
            poly = [rings[0]] + [rings[g] for g in sorted(rings) if g != 0]
            kept.append((ring_area(poly[0]), poly))
        if not kept:
            raise RoadsError(f"{r.code} has no polygon left after simplifying; lower the tolerance")
        kept.sort(key=lambda item: (-item[0], item[1][0][0]))
        coords = []
        for i, (area, poly) in enumerate(kept):
            if i > 0 and area < min_area:
                dropped += 1
                continue
            polygons += 1
            points += sum(len(ring) for ring in poly)
            coords.append([[[store.num(x), store.num(y)] for x, y in ring + [ring[0]]] for ring in poly])
        features.append(
            {
                "type": "Feature",
                "id": r.fips,
                "properties": {"code": r.code, "name": r.name},
                "geometry": {"type": "MultiPolygon", "coordinates": coords},
            }
        )
    return features, {"features": len(features), "polygons": polygons, "points": points, "dropped_islands": dropped}


# ---------------------------------------------------------------- NHFN


@dataclass
class Segment:
    sign: str | None
    code: int
    state: str | None
    pts: list[Point]


@dataclass
class Line:
    sign: str | None
    code: int
    pts: list[Point]
    segments: int = 1


def nhfn_query_url(offset: int, count: int = NHFN_PAGE) -> str:
    return NHFN_LAYER_URL + "/query?" + urlencode(
        {
            "where": "1=1",
            "outFields": NHFN_FIELDS,
            "outSR": 4326,
            "geometryPrecision": NHFN_PRECISION,
            "orderByFields": "OBJECTID",
            "resultOffset": offset,
            "resultRecordCount": count,
            "f": "json",
        }
    )


def count_url(layer_url: str, where: str = "1=1") -> str:
    return layer_url + "/query?" + urlencode({"where": where, "returnCountOnly": "true", "f": "json"})


_SIGN_JUNK = re.compile(r"[\s\x00-\x1f\x7f]+")


def _sign(value) -> str | None:
    """SIGN1 without whitespace or control characters ("U90  A" is U90A, a lone backspace is no sign)."""
    s = _SIGN_JUNK.sub("", str(value)) if value is not None else ""
    return s or None


def _name(value) -> str | None:
    """ST_NAME with its spaces tidied: "Puerto Rico", "District of Columbia"."""
    s = " ".join(_SIGN_JUNK.split(str(value))).strip() if value is not None else ""
    return s or None


def nhfn_segments(doc, what: str) -> list[Segment]:
    """One segment per path of every feature in one page of the feature service."""
    if not isinstance(doc, dict) or not isinstance(doc.get("features"), list):
        raise RoadsError(f"{what} is not an ArcGIS feature set")
    out = []
    for f in doc["features"]:
        a = f.get("attributes") or {}
        g = f.get("geometry") or {}
        paths = g.get("paths")
        if not isinstance(paths, list):
            raise RoadsError(f"{what} has a feature without polyline paths")
        code = a.get("NHFN_CODE")
        if isinstance(code, bool) or not isinstance(code, int) or str(code) not in NHFN_CODES:
            raise RoadsError(f"{what} has a feature with NHFN_CODE {code!r}, which this build doesn't know")
        for path in paths:
            pts = []
            for p in path:
                if not isinstance(p, list) or len(p) < 2:
                    raise RoadsError(f"{what} has a vertex that is not [x, y]")
                pts.append((float(p[0]), float(p[1])))
            if len(pts) < 2:
                continue
            out.append(Segment(_sign(a.get("SIGN1")), code, _name(a.get("ST_NAME")), pts))
    return out


def segment_in_us(pts: list[Point], polygons: StatePolygons, state: str | None,
                  tolerance_km: float = COAST_TOLERANCE_KM) -> bool:
    """In the 50 states plus DC.

    state is the postal code the source's own ST_NAME gives, or None. A path
    is kept when any of its vertices (up to 65, evenly spaced, both ends
    included) lies inside a state. Otherwise it is kept only as a bridge
    the generalised coast cut off: its ends and middle all within
    tolerance_km of the state it says it is in. Puerto Rico, Toronto and a
    Tijuana path have no vertex inside a state and name no state, so they
    are dropped.
    """
    n = len(pts)
    step = max(1, n // 64)
    for i in list(range(0, n, step)) + [n - 1]:
        x, y = pts[i]
        if polygons.state_at(y, x) is not None:
            return True
    if state is None or state not in polygons.codes:
        return False
    return all(polygons.near(p[1], p[0], state, tolerance_km) for p in (pts[0], pts[n // 2], pts[-1]))


def _key(p: Point) -> tuple[int, int]:
    return (int(round(p[0] * 10**NHFN_PRECISION)), int(round(p[1] * 10**NHFN_PRECISION)))


def chain_segments(segments: list[Segment]) -> list[Line]:
    """Merge segments of one route sign and code into longer lines where their ends touch.

    Greedy and deterministic: segments are taken in a fixed order, each
    unvisited one starts a line, and the line grows from its tail and then
    its head while an unvisited segment of the same sign shares the end
    vertex. At a junction of three the lowest ordered neighbour wins; the
    others start their own lines. Only the drawing depends on this, and the
    same input always gives the same lines.
    """
    groups: dict[tuple[str, int], list[Segment]] = {}
    for s in segments:
        groups.setdefault((s.sign or "", s.code), []).append(s)
    lines: list[Line] = []
    for gkey in sorted(groups):
        segs = sorted(groups[gkey], key=lambda s: (s.pts[0], s.pts[-1], len(s.pts), s.pts))
        ends: dict[tuple[int, int], list[int]] = {}
        for i, s in enumerate(segs):
            ends.setdefault(_key(s.pts[0]), []).append(i)
            ends.setdefault(_key(s.pts[-1]), []).append(i)
        visited = [False] * len(segs)

        def take(at: tuple[int, int]) -> list[Point] | None:
            for j in ends.get(at, ()):
                if visited[j]:
                    continue
                visited[j] = True
                pts = segs[j].pts
                return pts if _key(pts[0]) == at else pts[::-1]
            return None

        for i, s in enumerate(segs):
            if visited[i]:
                continue
            visited[i] = True
            tail = list(s.pts)
            count = 1
            while (nxt := take(_key(tail[-1]))) is not None:
                tail.extend(nxt[1:])
                count += 1
            head: list[Point] = []
            while (prv := take(_key(head[0] if head else tail[0]))) is not None:
                head = prv[::-1][:-1] + head
                count += 1
            lines.append(Line(gkey[0] or None, gkey[1], head + tail, count))
    return lines


def encode_lines(lines: list[Line], tolerance: float, precision: int) -> tuple[list[list], dict[str, int]]:
    """Simplify, quantize and delta encode into [sign, code, pts] rows.

    A line that collapses to one grid point is dropped, unless it is the
    last of its sign: then it keeps its two ends, so no route sign ever
    disappears from the file.
    """
    rows = []
    before = after = 0
    collapsed: dict[str | None, list[Line]] = {}
    signs_kept: set[str | None] = set()
    for line in lines:
        before += len(line.pts)
        q = quantize(simplify(line.pts, tolerance), precision)
        if len(q) < 2:
            collapsed.setdefault(line.sign, []).append(line)
            continue
        signs_kept.add(line.sign)
        after += len(q)
        rows.append([line.sign, line.code, delta_encode(q)])
    for sign, group in collapsed.items():
        if sign in signs_kept:
            continue
        longest = max(group, key=lambda ln: (math.dist(ln.pts[0], ln.pts[-1]), ln.pts[0]))
        scale = 10**precision
        a = (int(round(longest.pts[0][0] * scale)), int(round(longest.pts[0][1] * scale)))
        b = (int(round(longest.pts[-1][0] * scale)), int(round(longest.pts[-1][1] * scale)))
        if a == b:
            b = (a[0] + 1, a[1])  # one grid step, so the route still has a place on the map
        after += 2
        rows.append([longest.sign, longest.code, delta_encode([a, b])])
    rows.sort(key=lambda r: (r[0] or "", r[1], r[2][0], r[2][1], len(r[2]), r[2]))
    return rows, {"points_before_simplify": before, "points": after}


def nhfn_version(layer: dict) -> tuple[str | None, str | None]:
    """The dataset version and compile date from the layer's copyright and description text."""
    m = _VERSION_RE.search(str(layer.get("copyrightText") or ""))
    version = m.group(1) if m else None
    desc = re.sub(r"<[^>]+>", " ", str(layer.get("description") or "").replace("&lt;", "<").replace("&gt;", ">"))
    m = _COMPILED_RE.search(desc)
    compiled = None
    if m:
        try:
            compiled = datetime.strptime(m.group(1), "%B %d, %Y").date().isoformat()
        except ValueError:
            compiled = None
    return version, compiled


def _epoch_day(ms) -> str | None:
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat()


def load_nhfn_pages(cache_dir: Path) -> tuple[dict, list[Segment], int]:
    """The layer file, every segment of every cached page in order, and the feature count."""
    cache_dir = Path(cache_dir)
    layer_path = cache_dir / CACHE_FILES["nhfn_layer"]
    if not layer_path.exists():
        raise RoadsError(f"{layer_path} is missing. Run scripts/update_map_roads.py --live to fetch the NHFN.")
    layer = store.read_json(layer_path)
    if not isinstance(layer, dict) or isinstance(layer.get("count"), bool) or not isinstance(layer.get("count"), int):
        raise RoadsError(f"{layer_path} has no feature count; run --live again")
    pages = sorted((int(m.group(1)), p) for p in layer_path.parent.iterdir() if (m := _NHFN_PAGE_RE.match(p.name)))
    if [i for i, _ in pages] != list(range(len(pages))):
        raise RoadsError("the NHFN page files in the cache are not a run from page 0; run --live again")
    segments: list[Segment] = []
    features = 0
    for i, path in pages:
        doc = store.read_json(path)
        features += len(doc.get("features") or [])
        segments.extend(nhfn_segments(doc, f"NHFN page {i}"))
    if features != layer["count"]:
        raise RoadsError(
            f"the cache holds {features} NHFN features, the service reported {layer['count']}; run --live again"
        )
    return layer, segments, features


# ---------------------------------------------------------------- places


@dataclass
class Place:
    name: str
    state: str
    lat: float
    lon: float
    population: int
    capital: bool
    modified: str


def read_geonames(zip_bytes: bytes) -> list[list[str]]:
    """The tab separated rows of cities5000.txt inside the zip."""
    try:
        z = zipfile.ZipFile(io.BytesIO(zip_bytes))
        text = z.read(GEONAMES_MEMBER).decode("utf-8")
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError) as e:
        raise RoadsError(f"the GeoNames download is not a zip with {GEONAMES_MEMBER}: {e}") from e
    rows = [line.split("\t") for line in text.splitlines() if line]
    if not rows or any(len(r) != 19 for r in rows):
        raise RoadsError(f"{GEONAMES_MEMBER} does not have 19 columns per row")
    return rows


def places_from_geonames(
    rows: list[list[str]], states: StateTable, top: int = PLACES_TOP
) -> tuple[list[Place], dict[str, int]]:
    """The top places by population plus every state capital, largest first.

    Columns per the GeoNames readme: 1 name, 4 latitude, 5 longitude, 7
    feature code, 8 country code, 10 admin1 code (the state), 14
    population, 18 modification date.
    """
    codes = states.codes
    us = eligible = 0
    candidates: list[Place] = []
    for r in rows:
        if r[8] != "US":
            continue
        us += 1
        if r[10] not in codes or r[7] not in PLACE_CODES:
            continue
        try:
            pop = int(r[14] or 0)
            lat, lon = float(r[4]), float(r[5])
        except ValueError:
            continue
        if pop <= 0:
            continue
        eligible += 1
        candidates.append(Place(r[1].strip(), r[10], lat, lon, pop, r[7] in CAPITAL_CODES, r[18]))
    candidates.sort(key=lambda p: (-p.population, p.name, p.state, p.lat, p.lon))
    kept = candidates[:top] + [p for p in candidates[top:] if p.capital]
    kept.sort(key=lambda p: (-p.population, p.name, p.state, p.lat, p.lon))
    capital_states = {p.state for p in kept if p.capital}
    missing = sorted(codes - capital_states)
    if missing:
        raise RoadsError(f"GeoNames has no capital (PPLA or PPLC) for {', '.join(missing)}")
    counts = {
        "us_rows": us,
        "eligible": eligible,
        "places": len(kept),
        "top": min(top, len(candidates)),
        "capitals_added": len(kept) - min(top, len(candidates)),
        "capitals": sum(1 for p in kept if p.capital),
    }
    return kept, counts


# ---------------------------------------------------------------- fetching


def fetched_dates(cache_dir: Path) -> dict[str, str]:
    path = Path(cache_dir) / FETCHED_FILE
    if not path.exists():
        return {}
    doc = store.read_json(path)
    if not isinstance(doc, dict):
        raise RoadsError(f"{path} is not an object of file names to dates")
    return {k: str(v) for k, v in doc.items()}


def fetched_date(cache_dir: Path, rel: str) -> str:
    """The day a cached download was fetched: the sidecar, else the file's mtime in UTC."""
    day = fetched_dates(cache_dir).get(rel)
    if day:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise RoadsError(f"{FETCHED_FILE} has a date that isn't YYYY-MM-DD for {rel}: {day!r}")
        return day
    return datetime.fromtimestamp((Path(cache_dir) / rel).stat().st_mtime, timezone.utc).date().isoformat()


def _record_fetched(cache_dir: Path, rel: str, now: datetime) -> None:
    dates = fetched_dates(cache_dir)
    dates[rel] = now.astimezone(timezone.utc).date().isoformat()
    store.write_text_if_changed(Path(cache_dir) / FETCHED_FILE, store.dumps(dict(sorted(dates.items()))))


def _get(http: HttpClient, url: str, what: str, timeout: float, sleep, log, accept: str = "application/json"):
    """GET with up to two retries. A cold ArcGIS query can take longer than the timeout once and
    then answer from its own cache, so a timeout is worth a second and third try."""
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    attempts = len(RETRY_AFTER) + 1
    for attempt in range(1, attempts + 1):
        try:
            resp = http.get(url, headers=headers, timeout=timeout)
        except NetworkError as e:
            if attempt == attempts:
                raise RoadsError(f"{what}: {e}") from e
            wait = RETRY_AFTER[attempt - 1]
            log(f"{what}: {e}; retry {attempt} of {attempts - 1} in {wait} s")
            sleep(wait)
            continue
        if resp.status in (429, 500, 502, 503, 504) and attempt < attempts:
            wait = RETRY_AFTER[attempt - 1]
            log(f"{what}: HTTP {resp.status}; retry {attempt} of {attempts - 1} in {wait} s")
            sleep(wait)
            continue
        if resp.status != 200:
            raise RoadsError(f"{what}: HTTP {resp.status}")
        return resp
    raise RoadsError(f"{what}: gave up")  # pragma: no cover


def _get_json(http: HttpClient, url: str, what: str, timeout: float, sleep, log) -> dict:
    resp = _get(http, url, what, timeout, sleep, log)
    try:
        doc = json.loads(resp.body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise RoadsError(f"{what}: response is not JSON ({e})") from e
    if not isinstance(doc, dict):
        raise RoadsError(f"{what}: response is not a JSON object")
    if "error" in doc:
        raise RoadsError(f"{what}: ArcGIS error {doc['error']}")
    return doc


def _count(doc: dict, what: str) -> int:
    count = doc.get("count")
    if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
        raise RoadsError(f"{what}: the service answered {count!r}")
    return count


def _run_stamp(layer: dict, count: int, page_size: int) -> dict:
    """What a set of cached pages depends on. Pages cached under the same stamp can be reused."""
    return {
        "count": count,
        "data_edited": (layer.get("editingInfo") or {}).get("dataLastEditDate"),
        "page_size": page_size,
        "query_url": nhfn_query_url(0, page_size),
    }


def fetch_nhfn(cache_dir: Path, http: HttpClient, now: datetime, sleep, log=print,
               page_size: int = NHFN_PAGE, resume: bool = False) -> int:
    """Page through the NHFN one request at a time. Returns the feature count.

    Each page lands as it arrives and the layer file last, so a run that
    stops halfway leaves a cache the build refuses. With resume, pages
    already cached by a run with the same stamp (count, the service's data
    edit time, page size and query) are kept, so a run that stopped on a
    timeout picks up where it left off. Pages left over from a longer
    earlier run are removed.
    """
    cache_dir = Path(cache_dir)
    layer = _get_json(http, NHFN_LAYER_URL + "?f=json", "NHFN layer", TIMEOUT, sleep, log)
    count = _count(_get_json(http, count_url(NHFN_LAYER_URL), "NHFN count", TIMEOUT, sleep, log), "NHFN count")
    pages = math.ceil(count / page_size)
    log(f"NHFN: {count:,} features, {pages} pages of {page_size}, {TIMEOUT} s timeout each")
    layer_path = cache_dir / CACHE_FILES["nhfn_layer"]
    run_path = cache_dir / NHFN_RUN_FILE
    layer_path.parent.mkdir(parents=True, exist_ok=True)
    if layer_path.exists():
        layer_path.unlink()  # the pages may change now; no layer file means no build until they are all in
    stamp = _run_stamp(layer, count, page_size)
    same_run = resume and run_path.exists() and store.read_json(run_path) == stamp
    if not same_run:
        for p in layer_path.parent.iterdir():
            if _NHFN_PAGE_RE.match(p.name):
                p.unlink()
    store.write_text_if_changed(run_path, store.dumps(stamp))
    got = 0
    for i in range(pages):
        what = f"NHFN page {i + 1} of {pages}"
        path = cache_dir / NHFN_PAGE_FILE.format(i)
        expected = min(page_size, count - i * page_size)
        if same_run and path.exists():
            doc = store.read_json(path)
            if isinstance(doc, dict) and len(doc.get("features") or []) == expected:
                segments = nhfn_segments(doc, what)
                got += expected
                log(f"{what}: {expected} features, {len(segments)} paths, kept from the cache")
                continue
        doc = _get_json(http, nhfn_query_url(i * page_size, page_size), what, TIMEOUT, sleep, log)
        segments = nhfn_segments(doc, what)
        n = len(doc["features"])
        if n != expected:
            raise RoadsError(f"{what}: {n} features, expected {expected}; nothing built")
        got += n
        body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        store.write_text_if_changed(path, body)
        log(f"{what}: {n} features, {len(segments)} paths, {len(body) / 1e6:.1f} MB")
    if got != count:
        raise RoadsError(f"NHFN: the pages hold {got} features, the service reported {count}; nothing built")
    for p in layer_path.parent.iterdir():
        m = _NHFN_PAGE_RE.match(p.name)
        if m and int(m.group(1)) >= pages:
            p.unlink()
    keep = {k: layer.get(k) for k in ("name", "description", "copyrightText", "editingInfo", "currentVersion")}
    keep["count"] = count
    keep["query_url"] = nhfn_query_url(0, page_size)
    store.write_text_if_changed(layer_path, store.dumps(keep))
    _record_fetched(cache_dir, CACHE_FILES["nhfn_layer"], now)
    return count


def _fetch_zip(cache_dir: Path, key: str, url: str, what: str, timeout: float, check,
               http: HttpClient, now: datetime, sleep, log) -> bytes:
    """One zip download, checked before it replaces the cached copy."""
    rel = CACHE_FILES[key]
    resp = _get(http, url, what, timeout, sleep, log, accept="application/zip")
    check(resp.body)  # raises before anything is written
    path = Path(cache_dir) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != resp.body:
        path.write_bytes(resp.body)
    _record_fetched(cache_dir, rel, now)
    log(f"{what}: {len(resp.body) / 1e6:.2f} MB")
    return resp.body


def fetch_census(cache_dir: Path, http: HttpClient, now: datetime, sleep, log=print) -> None:
    def check(body: bytes) -> None:
        if len(read_census_kml(body)) < 51:
            raise RoadsError("the Census file has fewer than 51 placemarks, nothing written")

    _fetch_zip(cache_dir, "census", CENSUS_URL, "Census states 20m", CENSUS_TIMEOUT, check, http, now, sleep, log)


def fetch_geonames(cache_dir: Path, http: HttpClient, now: datetime, sleep, log=print) -> None:
    def check(body: bytes) -> None:
        us = sum(1 for r in read_geonames(body) if r[8] == "US")
        if us < 1000:
            raise RoadsError(f"GeoNames cities5000: only {us} US rows, nothing written")

    _fetch_zip(cache_dir, "geonames", GEONAMES_URL, "GeoNames cities5000", GEONAMES_TIMEOUT, check,
               http, now, sleep, log)


SOURCES = ("census", "geonames", "nhfn")


def fetch_live(cache_dir: Path, http: HttpClient, now: datetime, sleep, log=print, sources=SOURCES,
               resume: bool = False) -> list[str]:
    """Refresh the cache, one source at a time. Returns the sources fetched."""
    cache_dir = Path(cache_dir)
    done = []
    for name in SOURCES:
        if name not in sources:
            continue
        if name == "census":
            fetch_census(cache_dir, http, now, sleep, log)
        elif name == "geonames":
            fetch_geonames(cache_dir, http, now, sleep, log)
        else:
            fetch_nhfn(cache_dir, http, now, sleep, log, resume=resume)
        done.append(name)
    return done


def _stats_url(layer_url: str, where: str) -> str:
    stats = [{"statisticType": "sum", "onStatisticField": "Shape__Length", "outStatisticFieldName": "len"},
             {"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "n"}]
    out = json.dumps(stats, separators=(",", ":"))
    return layer_url + "/query?" + urlencode({"where": where, "outStatistics": out, "f": "json"})


def _stats(http: HttpClient, layer_url: str, where: str, what: str, sleep, log) -> tuple[int, float]:
    doc = _get_json(http, _stats_url(layer_url, where), what, TIMEOUT, sleep, log)
    try:
        attrs = doc["features"][0]["attributes"]
        return int(attrs["n"]), float(attrs["len"])
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise RoadsError(f"{what}: no statistics in the answer") from e


def staa_estimate(http: HttpClient, sleep, roads_gzip: int, log=print,
                  tolerance: float = ROADS_TOLERANCE, precision: int = ROADS_PRECISION) -> dict:
    """Size a national STAA file without downloading it. Writes nothing.

    Two estimates, both scaled by length from the service's own statistics
    (the summed Shape__Length of every NN = 1 record). From the NHFN: the
    built roads file's gzip bytes per unit of NHFN length. That is the low
    end, since it assumes STAA routes merge into lines as long as the
    interstates do. From a sample: 2,000 NN = 1 records in OBJECTID order,
    merged, simplified and delta encoded exactly like the roads file. That
    is the high end, since a sample's lines stop where the sample does.
    """
    total = _count(_get_json(http, count_url(STAA_LAYER_URL), "STAA count", TIMEOUT, sleep, log), "STAA count")
    nn, nn_len = _stats(http, STAA_LAYER_URL, STAA_WHERE, "STAA length", sleep, log)
    nhfn_n, nhfn_len = _stats(http, NHFN_LAYER_URL, "1=1", "NHFN length", sleep, log)
    url = STAA_LAYER_URL + "/query?" + urlencode(
        {"where": STAA_WHERE, "outFields": "SIGN1,STFIPS,Shape__Length", "outSR": 4326,
         "geometryPrecision": NHFN_PRECISION, "orderByFields": "OBJECTID", "resultOffset": 0,
         "resultRecordCount": STAA_SAMPLE, "f": "json"}
    )
    doc = _get_json(http, url, "STAA sample", TIMEOUT, sleep, log)
    feats = doc.get("features") or []
    segs = []
    sample_len = 0.0
    sample_states = set()
    for f in feats:
        a = f.get("attributes") or {}
        sample_len += float(a.get("Shape__Length") or 0)
        sample_states.add(a.get("STFIPS"))
        for path in (f.get("geometry") or {}).get("paths") or []:
            pts = [(float(p[0]), float(p[1])) for p in path]
            if len(pts) >= 2:
                segs.append(Segment(_sign(a.get("SIGN1")), 1, None, pts))
    lines = chain_segments(segs)
    rows, _ = encode_lines(lines, tolerance, precision)
    sample_gz = gzip_size(json.dumps(rows, separators=(",", ":")))
    return {
        "records": total,
        "staa_records": nn,
        "staa_length": nn_len,
        "nhfn_records": nhfn_n,
        "nhfn_length": nhfn_len,
        "roads_gzip": roads_gzip,
        "by_nhfn_gzip": int(roads_gzip * nn_len / nhfn_len) if nhfn_len else None,
        "sample_records": len(feats),
        "sample_states": len(sample_states),
        "sample_lines": len(rows),
        "sample_length": sample_len,
        "sample_gzip": sample_gz,
        "by_sample_gzip": int(sample_gz * nn_len / sample_len) if sample_len else None,
        "tolerance_deg": tolerance,
        "precision": precision,
    }


# ---------------------------------------------------------------- build


@dataclass
class RoadsResult:
    changed: dict[str, bool] = field(default_factory=dict)
    counts: dict = field(default_factory=dict)


def _read_cache(cache_dir: Path, key: str) -> bytes:
    path = Path(cache_dir) / CACHE_FILES[key]
    if not path.exists():
        raise RoadsError(f"{path} is missing. Run scripts/update_map_roads.py --live to fetch it.")
    return path.read_bytes()


def build_states_doc(cache_dir: Path, rows: list[CensusState], states: StateTable, tolerance: float) -> dict:
    features, counts = states_geojson(rows, states, tolerance)
    return {
        "type": "FeatureCollection",
        "schema": "dailyfuel/map-states/1",
        **CENSUS,
        "fetched": fetched_date(cache_dir, CACHE_FILES["census"]),
        "tolerance_deg": tolerance,
        "precision": STATES_PRECISION,
        "min_area_deg2": STATES_MIN_AREA,
        "note": (
            "Coordinates are lon, lat. Every border two states share is simplified once, so neighbours still "
            "meet. Islands under min_area_deg2 are dropped, but never a state's largest polygon. The Aleutian "
            "islands west of the antimeridian are moved 360 degrees west, so they draw next to the rest of "
            "Alaska on a Web Mercator map with no world copies."
        ),
        "counts": counts,
        "features": features,
    }


def build_roads_doc(cache_dir: Path, polygons: StatePolygons, states: StateTable, tolerance: float,
                    precision: int, log) -> dict:
    layer, segments, feature_count = load_nhfn_pages(cache_dir)
    log(f"roads: {feature_count:,} features, {len(segments):,} paths loaded")
    code_of = {st.name: st.code for st in states.states}
    kept: list[Segment] = []
    outside: dict[str, int] = {}
    for i, s in enumerate(segments):
        if segment_in_us(s.pts, polygons, code_of.get(s.state or "")):
            kept.append(s)
        else:
            where = s.state or "unknown"
            outside[where] = outside.get(where, 0) + 1
        if (i + 1) % 2000 == 0:
            log(f"roads: US filter {i + 1:,} of {len(segments):,}")
    lines = chain_segments(kept)
    log(f"roads: {len(kept):,} paths in the US, {len(lines):,} lines after merging by sign")
    rows, pcounts = encode_lines(lines, tolerance, precision)
    version, compiled = nhfn_version(layer)
    signs = {r[0] for r in rows if r[0]}
    editing = layer.get("editingInfo") or {}
    return {
        "schema": "dailyfuel/map-roads/1",
        **NHFN,
        "licence_note": str(layer.get("copyrightText") or "").strip() or NHFN["licence"],
        "version": version,
        "compiled": compiled,
        "data_edited": _epoch_day(editing.get("dataLastEditDate")),
        "fetched": fetched_date(cache_dir, CACHE_FILES["nhfn_layer"]),
        "query_url": nhfn_query_url(0),
        "codes": dict(NHFN_CODES),
        "signs": (
            "SIGN1 from the source with spaces and control characters taken out: I for interstate, U for US "
            "route, S for state route, C for county route, then the number and any suffix (I35E, U9W). Null "
            "where the source has none."
        ),
        "fields": ["sign", "code", "pts"],
        "precision": precision,
        "tolerance_deg": tolerance,
        "encoding": (
            "pts is [x0, y0, dx1, dy1, ...] in units of 10^-precision degrees, lon then lat. Add each pair to "
            "the vertex before it to get the next one."
        ),
        "counts": {
            "features": feature_count,
            "paths": len(segments),
            "dropped_outside_us": sum(outside.values()),
            "lines": len(rows),
            "signs": len(signs),
            "points_before_simplify": pcounts["points_before_simplify"],
            "points": pcounts["points"],
        },
        "dropped_outside_us": dict(sorted(outside.items())),
        "lines": rows,
    }


def places_columns(places: list[Place], precision: int = PLACES_PRECISION) -> dict[str, list]:
    """Name, state, lat and lon columns: grouped by state, largest first within one, coordinates delta encoded."""
    order = sorted(places, key=lambda p: (p.state, -p.population, p.name, p.lat, p.lon))
    scale = 10**precision
    lat = [int(round(p.lat * scale)) for p in order]
    lon = [int(round(p.lon * scale)) for p in order]
    return {
        "name": [p.name for p in order],
        "state": [p.state for p in order],
        "lat": [v - (lat[i - 1] if i else 0) for i, v in enumerate(lat)],
        "lon": [v - (lon[i - 1] if i else 0) for i, v in enumerate(lon)],
    }


def decode_places(columns: dict[str, list], precision: int) -> list[tuple[str, str, float, float]]:
    """(name, state, lat, lon) rows back from places_columns."""
    scale = 10**precision
    out = []
    lat = lon = 0
    for name, state, dlat, dlon in zip(columns["name"], columns["state"], columns["lat"], columns["lon"]):
        lat += dlat
        lon += dlon
        out.append((name, state, lat / scale, lon / scale))
    return out


def build_places_doc(cache_dir: Path, states: StateTable) -> dict:
    places, counts = places_from_geonames(read_geonames(_read_cache(cache_dir, "geonames")), states)
    return {
        "schema": "dailyfuel/map-places/1",
        **GEONAMES,
        "fetched": fetched_date(cache_dir, CACHE_FILES["geonames"]),
        "modified": max((p.modified for p in places), default=None),
        "rule": (
            "Places in the 50 states plus DC with a population, GeoNames feature codes "
            f"{', '.join(sorted(PLACE_CODES))} "
            f"(not sections of a place such as Harlem): the {PLACES_TOP:,} largest by population plus every state "
            "capital, with Washington for DC."
        ),
        "top": PLACES_TOP,
        "fields": ["name", "state", "lat", "lon"],
        "precision": PLACES_PRECISION,
        "encoding": (
            "places holds one column per field, one entry per place. Places are grouped by state in postal code "
            "order, largest first within a state. lat and lon are integers in units of 10^-precision degrees, "
            "delta encoded: add each entry to the value before it, starting from 0."
        ),
        "counts": counts,
        "places": places_columns(places),
    }


def build(
    cache_dir: Path,
    data_dir: Path,
    states: StateTable,
    v: RoadValidators | None = None,
    roads_tolerance: float = ROADS_TOLERANCE,
    roads_precision: int = ROADS_PRECISION,
    states_tolerance: float = STATES_TOLERANCE,
    log=lambda *_: None,
) -> RoadsResult:
    """Build the three files under data_dir/map from the cache. Deterministic and idempotent."""
    cache_dir, data_dir = Path(cache_dir), Path(data_dir)
    v = v or RoadValidators()
    result = RoadsResult()

    census = read_census_kml(_read_cache(cache_dir, "census"))
    polygons = state_polygons(census, states)
    states_doc = build_states_doc(cache_dir, census, states, states_tolerance)
    result.counts["states"] = dict(states_doc["counts"])
    log("states: {features} features, {polygons} polygons, {points} points".format(**states_doc["counts"]))

    roads_doc = build_roads_doc(cache_dir, polygons, states, roads_tolerance, roads_precision, log)
    result.counts["roads"] = dict(roads_doc["counts"], dropped_by_state=roads_doc["dropped_outside_us"])

    places_doc = build_places_doc(cache_dir, states)
    result.counts["places"] = dict(places_doc["counts"])

    docs = (
        ("map-states", STATES, states_doc),
        ("map-roads", ROADS_NHFN, roads_doc),
        ("map-places", PLACES, places_doc),
    )
    for kind, _, doc in docs:
        v.validate(kind, doc)  # all three must pass before any one is written
    for kind, rel, doc in docs:
        result.changed[str(rel)] = write_doc(kind, data_dir / rel, doc, v)
    return result
