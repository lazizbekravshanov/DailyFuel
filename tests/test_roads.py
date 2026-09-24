"""Map base data: NHFN paging and merging, simplification, the US filter, places, state outlines.

Synthetic inputs throughout (a fake feature service, small KML and GeoNames
zips, a three state table), plus checks on the committed files under
data/map/. tests/conftest.py blocks sockets.
"""

from __future__ import annotations

import ast
import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from dailyfuel import roads, store
from dailyfuel.http import NetworkError, Response
from dailyfuel.paths import DATA_DIR, REPO_ROOT
from dailyfuel.states import StateTable, load_states

NOW = datetime(2026, 9, 24, 22, 30, tzinfo=timezone.utc)

# The California line runs straight from the Pacific at (32.5343, -117.12) to
# the Colorado river at (32.72, -114.72); Tijuana's centre is 2 km south of
# it. New York's north shore stops at 43.3 on Lake Ontario; Toronto is 40 km
# across the lake.
CA_RING = [(-124.4, 42.0), (-114.1, 42.0), (-114.1, 35.0), (-114.72, 32.72), (-117.12, 32.5343), (-124.4, 32.5343)]
NY_RING = [(-79.76, 42.0), (-73.35, 42.0), (-73.35, 45.0), (-74.7, 45.0), (-76.3, 44.2), (-79.0, 43.3), (-79.76, 43.3)]
# Nevada shares California's east edge with a few metres of wiggle, drawn in
# the same vertices, as the Census file does for neighbours.
SHARED = [(-120.0, 42.0), (-120.0, 41.5), (-120.004, 41.0), (-120.0, 40.5), (-120.003, 40.0), (-120.0, 39.0),
          (-117.3, 37.0), (-114.63, 35.0)]
CA_WEST = [(-124.4, 42.0)] + SHARED + [(-114.72, 32.72), (-117.12, 32.5343), (-124.4, 32.5343)]
NV_RING = SHARED[::-1] + [(-114.04, 42.0)]
# Alaska with one Aleutian island east of the antimeridian.
AK_MAIN = [(-168.0, 54.0), (-141.0, 54.0), (-141.0, 70.0), (-168.0, 70.0)]
AK_ATTU = [(172.4, 52.8), (173.3, 52.8), (173.3, 53.1), (172.4, 53.1)]
AK_SPECK = [(-150.0, 59.0), (-149.99, 59.0), (-149.99, 59.01)]
PR_RING = [(-67.3, 17.9), (-65.6, 17.9), (-65.6, 18.5), (-67.3, 18.5)]

TIJUANA = [(-117.0382, 32.5149), (-117.02, 32.508), (-117.00, 32.50)]
TORONTO = [(-79.40, 43.64), (-79.38, 43.645), (-79.35, 43.66)]
SAN_DIEGO_I5 = [(-117.16, 32.72), (-117.12, 32.62), (-117.05, 32.56)]


def table(*codes: str) -> StateTable:
    full = load_states()
    return StateTable(tuple(s for s in full.states if s.code in codes), full.benchmarks, full.aggregates)


def kml_zip(placemarks: list[tuple[str, str, str, list[list[list[tuple[float, float]]]]]]) -> bytes:
    """A Census style KML in a zip: (fips, code, name, polygons), each polygon a list of open rings."""
    parts = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>']
    for fips, code, name, polygons in placemarks:
        parts.append("<Placemark><ExtendedData><SchemaData schemaUrl='#s'>")
        for key, value in (("STATEFP", fips), ("STUSPS", code), ("NAME", name)):
            parts.append(f'<SimpleData name="{key}">{value}</SimpleData>')
        parts.append("</SchemaData></ExtendedData><MultiGeometry>")
        for rings in polygons:
            parts.append("<Polygon>")
            for i, ring in enumerate(rings):
                coords = " ".join(f"{x},{y}" for x, y in ring + [ring[0]])
                tag = "outerBoundaryIs" if i == 0 else "innerBoundaryIs"
                parts.append(f"<{tag}><LinearRing><coordinates>{coords}</coordinates></LinearRing></{tag}>")
            parts.append("</Polygon>")
        parts.append("</MultiGeometry></Placemark>")
    parts.append("</Folder></Document></kml>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(roads.CENSUS_MEMBER, "\n".join(parts))
    return buf.getvalue()


THREE = [
    ("06", "CA", "California", [[CA_RING]]),
    ("36", "NY", "New York", [[NY_RING]]),
    ("02", "AK", "Alaska", [[AK_MAIN], [AK_ATTU], [AK_SPECK]]),
    ("72", "PR", "Puerto Rico", [[PR_RING]]),
]


def geonames_row(gid, name, lat, lon, code, country, admin1, pop, modified="2026-09-01") -> str:
    cols = [str(gid), name, name, "", str(lat), str(lon), "P", code, country, "", admin1, "", "", "",
            str(pop), "", "10", "America/New_York", modified]
    assert len(cols) == 19
    return "\t".join(cols)


def geonames_zip(rows: list[str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(roads.GEONAMES_MEMBER, "\n".join(rows) + "\n")
    return buf.getvalue()


def feature(sign, code, state, *paths) -> dict:
    return {"attributes": {"SIGN1": sign, "NHFN_CODE": code, "ST_NAME": state},
            "geometry": {"paths": [[list(p) for p in path] for path in paths]}}


def layer_doc(count: int) -> dict:
    return {
        "name": "National Highway Freight Network (NHFN)",
        "description": "&lt;p&gt;The NHFN dataset was compiled on January 27, 2023 from the FHWA.&lt;/p&gt;",
        "copyrightText": "The NHFN Version 2023.02.08 database, or any portion thereof, can be freely distributed.",
        "editingInfo": {"dataLastEditDate": 1778690797800},
        "currentVersion": 11.5,
        "count": count,
    }


class RecordingHttp:
    """Serves canned bodies: an exact URL first, else the longest matching prefix. Records every call."""

    def __init__(self, bodies: dict[str, list]):
        self.bodies = {k: list(v) for k, v in bodies.items()}
        self.calls: list[tuple[str, dict, float]] = []

    def get(self, url, headers=None, timeout=30):
        self.calls.append((url, dict(headers or {}), timeout))
        key = url if url in self.bodies else max((k for k in self.bodies if url.startswith(k)), key=len, default=None)
        if key is None:
            raise AssertionError(f"unexpected url {url}")
        queue = self.bodies[key]
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item


def ok(doc) -> Response:
    return Response.make(200, json.dumps(doc))


def nhfn_http(features: list[dict], page_size: int, count: int | None = None) -> RecordingHttp:
    count = len(features) if count is None else count
    bodies = {
        roads.NHFN_LAYER_URL + "?f=json": [ok({k: v for k, v in layer_doc(count).items() if k != "count"})],
        roads.count_url(roads.NHFN_LAYER_URL): [ok({"count": count})],
    }
    for i in range(0, max(len(features), 1), page_size):
        page = features[i:i + page_size]
        bodies[roads.nhfn_query_url(i, page_size)] = [ok({"features": page, "exceededTransferLimit": len(page) == page_size})]
    return RecordingHttp(bodies)


# ---------------------------------------------------------------- encoding and simplification


def test_delta_encoding_round_trips_on_the_grid():
    pts = [(-122.4194, 37.7749), (-121.8863, 37.3382), (-121.8863, 37.3382), (-119.7871, 36.7378)]
    q = roads.quantize(pts, 2)
    assert q == [(-12242, 3777), (-12189, 3734), (-11979, 3674)]  # the repeated vertex is gone
    enc = roads.delta_encode(q)
    assert enc == [-12242, 3777, 53, -43, 210, -60]
    assert roads.delta_decode(enc, 2) == [(-122.42, 37.77), (-121.89, 37.34), (-119.79, 36.74)]


def test_simplify_keeps_both_ends_and_the_corners_and_handles_a_closed_ring():
    line = [(x / 100, 0.0) for x in range(0, 101)] + [(1.0, y / 100) for y in range(1, 101)]
    assert roads.simplify(line, 0.01) == [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
    ring = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]
    assert roads.simplify(ring, 0.1) == ring
    with pytest.raises(ValueError):
        roads.simplify(line, 0)


def test_a_border_two_states_share_is_simplified_once_and_still_meets():
    ca, nv = roads.simplify_rings([CA_WEST, NV_RING], 0.01)
    border_ca, border_nv = set(ca) & set(SHARED), set(nv) & set(SHARED)
    # the 400 m wiggles are under the tolerance, so both rings drop them, identically
    assert border_ca == border_nv == {(-120.0, 42.0), (-120.0, 39.0), (-114.63, 35.0)}
    assert ca[0] == ca[-1] and nv[0] == nv[-1]


def test_split_arcs_stores_a_shared_border_once():
    arcs, refs = roads.split_arcs([CA_WEST, NV_RING])
    shared = [i for i, arc in enumerate(arcs) if set(arc) == set(SHARED)]
    assert len(shared) == 1
    assert sum(1 for ring in refs for aid, _ in ring if aid == shared[0]) == 2


# ---------------------------------------------------------------- NHFN paging and merging


def test_fetch_pages_one_request_at_a_time_and_merges_every_page(tmp_path, sleeps):
    feats = [feature(f"I{n}", 1, "California", [(-120 + n, 36.0), (-119.5 + n, 36.1)]) for n in range(5)]
    http = nhfn_http(feats, page_size=2)
    logs = []
    assert roads.fetch_nhfn(tmp_path, http, NOW, sleeps, logs.append, page_size=2) == 5
    urls = [u for u, _, _ in http.calls]
    assert urls[:2] == [roads.NHFN_LAYER_URL + "?f=json", roads.count_url(roads.NHFN_LAYER_URL)]
    assert urls[2:] == [roads.nhfn_query_url(0, 2), roads.nhfn_query_url(2, 2), roads.nhfn_query_url(4, 2)]
    for url, headers, timeout in http.calls:
        assert timeout == roads.TIMEOUT == 30
        assert "github.com/lazizbekravshanov/DailyFuel" in headers["User-Agent"]
    assert "outSR=4326" in urls[2] and "geometryPrecision=4" in urls[2] and "resultOffset=2" in urls[3]
    assert sum(line.startswith("NHFN page") for line in logs) == 3  # one progress line per page
    layer, segments, n = roads.load_nhfn_pages(tmp_path)
    assert n == 5 and [s.sign for s in segments] == ["I0", "I1", "I2", "I3", "I4"]
    assert layer["count"] == 5
    assert json.loads((tmp_path / roads.FETCHED_FILE).read_text()) == {roads.CACHE_FILES["nhfn_layer"]: "2026-09-24"}
    assert sleeps.calls == []


def test_a_resumed_fetch_keeps_pages_of_the_same_run_and_refetches_the_rest(tmp_path, sleeps):
    feats = [feature("I5", 1, "California", [(-120 + n, 36.0), (-119.5 + n, 36.1)]) for n in range(5)]
    http = nhfn_http(feats, page_size=2)
    http.bodies[roads.nhfn_query_url(4, 2)] = [NetworkError("timed out")]
    with pytest.raises(roads.RoadsError, match="page 3 of 3"):
        roads.fetch_nhfn(tmp_path, http, NOW, sleeps, lambda *_: None, page_size=2)
    assert sleeps.calls == [5, 15]  # two retries, then give up
    assert not (tmp_path / roads.CACHE_FILES["nhfn_layer"]).exists()  # so a build refuses the half cache
    with pytest.raises(roads.RoadsError, match="missing"):
        roads.load_nhfn_pages(tmp_path)

    http = nhfn_http(feats, page_size=2)
    roads.fetch_nhfn(tmp_path, http, NOW, sleeps, lambda *_: None, page_size=2, resume=True)
    fetched = [u for u, _, _ in http.calls if "resultOffset" in u]
    assert fetched == [roads.nhfn_query_url(4, 2)]
    assert roads.load_nhfn_pages(tmp_path)[2] == 5


def test_a_fetch_with_the_wrong_feature_count_builds_nothing_and_old_pages_go(tmp_path, sleeps):
    (tmp_path / "nhfn").mkdir()
    (tmp_path / "nhfn" / "page_0007.json").write_text("{}")
    feats = [feature("I5", 1, "California", [(-120.0, 36.0), (-119.5, 36.1)])]
    http = nhfn_http(feats, page_size=2, count=2)
    with pytest.raises(roads.RoadsError, match="1 features, expected 2"):
        roads.fetch_nhfn(tmp_path, http, NOW, sleeps, lambda *_: None, page_size=2)
    assert not (tmp_path / "nhfn" / "page_0007.json").exists()
    assert not (tmp_path / roads.CACHE_FILES["nhfn_layer"]).exists()


def test_fetch_live_checks_each_zip_before_it_replaces_the_cached_one(tmp_path, sleeps):
    square = [(-100.0, 40.0), (-99.0, 40.0), (-99.0, 41.0), (-100.0, 41.0)]
    census = kml_zip([(f"{i:02d}", "XX", f"State {i}", [[square]]) for i in range(1, 53)])
    towns = [geonames_row(i, f"Town {i}", 40.0, -100.0, "PPL", "US", "NE", 5000 + i) for i in range(1000)]
    http = RecordingHttp({roads.CENSUS_URL: [Response.make(200, census)],
                          roads.GEONAMES_URL: [Response.make(200, geonames_zip(towns))]})
    logs = []
    assert roads.fetch_live(tmp_path, http, NOW, sleeps, logs.append, sources=("geonames", "census")) == ["census", "geonames"]
    assert [u for u, _, _ in http.calls] == [roads.CENSUS_URL, roads.GEONAMES_URL]
    assert (tmp_path / roads.CACHE_FILES["census"]).read_bytes() == census
    dates = json.loads((tmp_path / roads.FETCHED_FILE).read_text())
    assert dates == {roads.CACHE_FILES["census"]: "2026-09-24", roads.CACHE_FILES["geonames"]: "2026-09-24"}
    assert len(logs) == 2

    short = kml_zip(THREE)
    http = RecordingHttp({roads.CENSUS_URL: [Response.make(200, short)],
                          roads.GEONAMES_URL: [Response.make(200, geonames_zip(towns[:10]))]})
    later = datetime(2026, 10, 1, tzinfo=timezone.utc)
    with pytest.raises(roads.RoadsError, match="fewer than 51"):
        roads.fetch_census(tmp_path, http, later, sleeps, logs.append)
    with pytest.raises(roads.RoadsError, match="only 10 US rows"):
        roads.fetch_geonames(tmp_path, http, later, sleeps, logs.append)
    assert (tmp_path / roads.CACHE_FILES["census"]).read_bytes() == census  # the old download stays
    assert json.loads((tmp_path / roads.FETCHED_FILE).read_text()) == dates


def test_signs_lose_spaces_and_control_characters():
    doc = {"features": [feature("U90  A", 1, " Puerto  Rico ", [(0, 0), (1, 1)]), feature("\x08", 1, None, [(0, 0), (1, 1)]),
                        feature(" ", 2, "Ohio", [(0, 0), (1, 1)], [(2, 2)])]}
    segs = roads.nhfn_segments(doc, "page")
    assert [(s.sign, s.code, s.state) for s in segs] == [("U90A", 1, "Puerto Rico"), (None, 1, None), (None, 2, "Ohio")]
    with pytest.raises(roads.RoadsError, match="NHFN_CODE 3"):
        roads.nhfn_segments({"features": [feature("I5", 3, "Ohio", [(0, 0), (1, 1)])]}, "page")


def test_segments_of_one_sign_merge_where_they_touch_in_either_direction():
    seg = roads.Segment
    a = seg("I80", 1, "Iowa", [(0.0, 0.0), (1.0, 0.0)])
    b = seg("I80", 1, "Iowa", [(2.0, 0.0), (1.0, 0.0)])  # drawn the other way
    c = seg("I80", 1, "Iowa", [(-1.0, 0.0), (0.0, 0.0)])
    d = seg("I35", 1, "Iowa", [(1.0, 0.0), (1.0, 1.0)])  # touches, but another route
    e = seg("I80", 2, "Iowa", [(2.0, 0.0), (3.0, 0.0)])  # same sign, other NHFN code
    lines = roads.chain_segments([a, b, c, d, e])
    by = {(ln.sign, ln.code): ln for ln in lines}
    assert len(lines) == 3
    assert by[("I80", 1)].pts == [(-1.0, 0.0), (0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
    assert by[("I80", 1)].segments == 3
    assert by[("I35", 1)].pts == d.pts and by[("I80", 2)].pts == e.pts
    # the same input in another order gives the same lines
    again = roads.chain_segments([e, d, c, b, a])
    assert [(ln.sign, ln.code, ln.pts) for ln in again] == [(ln.sign, ln.code, ln.pts) for ln in lines]


def test_simplification_keeps_every_route_sign():
    seg = roads.Segment
    segments = [seg(f"I{n}", 1, "Texas", [(-100 + n * 0.1 + i * 0.001, 30.0 + (i % 7) * 0.0004) for i in range(400)])
                for n in range(40)]
    # three spurs far shorter than the 0.01 degree grid: two share a sign with a long line, one does not
    segments += [seg("I40", 1, "Texas", [(-97.0, 31.0), (-97.0005, 31.0002)]),
                 seg("I5", 1, "Texas", [(-97.1, 31.0), (-97.1003, 31.0001)]),
                 seg("S999", 1, "Texas", [(-97.2, 31.0), (-97.2001, 31.0001), (-97.2002, 31.0)])]
    lines = roads.chain_segments(segments)
    rows, counts = roads.encode_lines(lines, roads.ROADS_TOLERANCE, roads.ROADS_PRECISION)
    assert {r[0] for r in rows} == {s.sign for s in segments}
    spur = [r for r in rows if r[0] == "S999"]
    assert len(spur) == 1 and len(spur[0][2]) == 4  # kept as its two ends, one grid step apart
    assert counts["points"] == sum(len(r[2]) // 2 for r in rows)
    for sign, code, pts in rows:
        assert len(pts) % 2 == 0 and len(pts) >= 4
        decoded = roads.delta_decode(pts, roads.ROADS_PRECISION)
        assert all(-180 < x < -60 and 17 < y < 72 for x, y in decoded)


# ---------------------------------------------------------------- the US filter


@pytest.fixture(scope="module")
def synthetic_polygons():
    rows = roads.read_census_kml(kml_zip(THREE))
    return roads.state_polygons(rows, table("CA", "NY", "AK"))


def test_the_us_filter_drops_a_toronto_and_a_tijuana_segment(synthetic_polygons):
    p = synthetic_polygons
    assert roads.segment_in_us(SAN_DIEGO_I5, p, "CA")
    assert not roads.segment_in_us(TIJUANA, p, None)
    assert not roads.segment_in_us(TORONTO, p, None)
    # Toronto is 40 km out, past the bridge tolerance, whatever the source says
    assert not roads.segment_in_us(TORONTO, p, "NY")
    # a territory the table doesn't hold is out
    assert not roads.segment_in_us([(-66.1, 18.4), (-66.0, 18.45)], p, "PR")


def test_a_bridge_off_the_generalised_coast_is_kept_only_for_the_state_it_names(synthetic_polygons):
    # 3 km off California's straight Pacific edge at 32.5343, the whole path outside it
    bridge = [(-118.0, 32.51), (-118.02, 32.508), (-118.04, 32.51)]
    assert roads.segment_in_us(bridge, synthetic_polygons, "CA")
    assert not roads.segment_in_us(bridge, synthetic_polygons, "NY")
    assert not roads.segment_in_us(bridge, synthetic_polygons, None)


def test_the_committed_outlines_drop_toronto_and_tijuana_and_keep_border_interstates():
    doc = store.read_json(DATA_DIR / roads.STATES)
    polys = roads.StatePolygons([
        (f["properties"]["code"], [[tuple(p) for p in ring[:-1]] for ring in poly])
        for f in doc["features"] for poly in f["geometry"]["coordinates"]
    ])
    rows = {"features": [
        feature("I5", 1, "California", SAN_DIEGO_I5),
        feature("I90", 1, "Illinois", [(-87.75, 41.88), (-87.70, 41.90), (-87.65, 41.88)]),
        feature("I29", 1, "North Dakota", [(-97.22, 48.95), (-97.23, 48.99)]),  # to the Pembina crossing
        feature("MEX1", 1, "Baja California", TIJUANA),
        feature("QEW", 1, "Ontario", TORONTO),
        feature(" ", 1, None, TIJUANA),
    ]}
    code_of = {st.name: st.code for st in load_states().states}
    kept = [s.sign for s in roads.nhfn_segments(rows, "sample") if roads.segment_in_us(s.pts, polys, code_of.get(s.state or ""))]
    assert kept == ["I5", "I90", "I29"]


# ---------------------------------------------------------------- state outlines


def test_census_kml_reads_every_placemark_and_keeps_the_50_states_plus_dc_only():
    rows = roads.read_census_kml(kml_zip(THREE))
    assert [r.code for r in rows] == ["CA", "NY", "AK", "PR"]
    assert rows[2].polygons[1][0][0] == (172.4, 52.8)
    assert len(rows[0].polygons[0][0]) == len(CA_RING)  # the closing point is dropped
    feats, counts = roads.states_geojson(rows, table("CA", "NY", "AK"), tolerance=0.01, precision=2, min_area=0.003)
    assert [f["id"] for f in feats] == ["02", "06", "36"]  # FIPS order, no Puerto Rico
    assert counts == {"features": 3, "polygons": 4, "points": 21, "dropped_islands": 1}
    ak = feats[0]["geometry"]["coordinates"]
    assert len(ak) == 2  # the speck of an island is gone, the main polygon and Attu stay
    attu = ak[1][0]
    assert all(-187.7 < x < -186.6 for x, _ in attu)  # moved 360 degrees west, next to the rest of Alaska
    for f in feats:
        for poly in f["geometry"]["coordinates"]:
            for ring in poly:
                assert ring[0] == ring[-1] and len(ring) >= 4
    with pytest.raises(roads.RoadsError, match="missing TX"):
        roads.states_geojson(rows, table("CA", "TX"))


def test_census_state_codes_must_match_the_state_table():
    bad = kml_zip([("06", "NV", "Nevada", [[CA_RING]])])
    with pytest.raises(roads.RoadsError, match="FIPS 06 is NV"):
        roads.states_geojson(roads.read_census_kml(bad), table("CA"))
    with pytest.raises(roads.RoadsError, match="not a zip"):
        roads.read_census_kml(b"not a zip")


# ---------------------------------------------------------------- places


def test_places_are_the_top_n_plus_every_capital_and_nothing_else():
    rows = [geonames_row(i, f"Town {i}", 34.0 + i / 100, -118.0, "PPL", "US", "CA", 100_000 - i) for i in range(30)]
    rows += [
        geonames_row(900, "Sacramento", 38.58, -121.49, "PPLA", "US", "CA", 5_000),
        geonames_row(901, "Albany", 42.65, -73.76, "PPLA", "US", "NY", 6_000),
        geonames_row(902, "Juneau", 58.30, -134.42, "PPLA", "US", "AK", 7_000),
        geonames_row(903, "Brooklyn Heights", 40.70, -73.99, "PPLX", "US", "NY", 900_000),  # a section: out
        geonames_row(904, "Toronto", 43.70, -79.42, "PPLA", "CA", "08", 2_600_000),  # not the US: out
        geonames_row(905, "San Juan", 18.47, -66.11, "PPLA", "US", "PR", 400_000),  # no territories
        geonames_row(906, "Ghost Town", 35.0, -117.0, "PPL", "US", "CA", 0),  # no population: out
    ]
    places, counts = roads.places_from_geonames(roads.read_geonames(geonames_zip(rows)), table("CA", "NY", "AK"), top=10)
    names = [p.name for p in places]
    assert names[:10] == [f"Town {i}" for i in range(10)]
    assert names[10:] == ["Juneau", "Albany", "Sacramento"]  # capitals below the cut, largest first
    assert counts == {"us_rows": 36, "eligible": 33, "places": 13, "top": 10, "capitals_added": 3, "capitals": 3}
    no_ak = [r for r in rows if "Juneau" not in r]
    with pytest.raises(roads.RoadsError, match="no capital .* for AK"):
        roads.places_from_geonames(roads.read_geonames(geonames_zip(no_ak)), table("CA", "NY", "AK"), top=10)


def test_place_columns_group_by_state_and_decode_back():
    rows = [geonames_row(1, "Buffalo", 42.8864, -78.8784, "PPL", "US", "NY", 278_000),
            geonames_row(2, "Albany", 42.6526, -73.7562, "PPLA", "US", "NY", 99_000),
            geonames_row(3, "Anchorage", 61.2181, -149.9003, "PPL", "US", "AK", 291_000),
            geonames_row(4, "Juneau", 58.3019, -134.4197, "PPLA", "US", "AK", 32_000)]
    places, _ = roads.places_from_geonames(roads.read_geonames(geonames_zip(rows)), table("NY", "AK"))
    cols = roads.places_columns(places)
    assert cols["name"] == ["Anchorage", "Juneau", "Buffalo", "Albany"]
    assert cols["lat"][:2] == [6122, 5830 - 6122]
    assert roads.decode_places(cols, 2) == [("Anchorage", "AK", 61.22, -149.9), ("Juneau", "AK", 58.3, -134.42),
                                            ("Buffalo", "NY", 42.89, -78.88), ("Albany", "NY", 42.65, -73.76)]


# ---------------------------------------------------------------- the whole build


def write_cache(root: Path) -> Path:
    (root / "census20m").mkdir(parents=True)
    (root / roads.CACHE_FILES["census"]).write_bytes(kml_zip(THREE))
    (root / "geonames").mkdir()
    rows = [geonames_row(1, "Los Angeles", 34.05, -118.24, "PPL", "US", "CA", 3_800_000),
            geonames_row(2, "Sacramento", 38.58, -121.49, "PPLA", "US", "CA", 520_000),
            geonames_row(3, "Albany", 42.65, -73.76, "PPLA", "US", "NY", 99_000),
            geonames_row(4, "Juneau", 58.30, -134.42, "PPLA", "US", "AK", 32_000)]
    (root / roads.CACHE_FILES["geonames"]).write_bytes(geonames_zip(rows))
    feats = [
        feature("I5", 1, "California", [(-121.5, 38.6), (-121.3, 38.0)]),
        feature("I5", 1, "California", [(-120.0, 36.5), (-121.3, 38.0)]),
        feature("I90", 1, "New York", [(-78.9, 42.9), (-76.1, 43.05)]),
        feature("IPRI1", 1, "Puerto Rico", [(-66.1, 18.4), (-66.0, 18.45)]),
        feature(" ", 1, "Baja California", TIJUANA),
    ]
    (root / "nhfn").mkdir()
    (root / roads.NHFN_PAGE_FILE.format(0)).write_text(json.dumps({"features": feats[:3]}))
    (root / roads.NHFN_PAGE_FILE.format(1)).write_text(json.dumps({"features": feats[3:]}))
    (root / roads.CACHE_FILES["nhfn_layer"]).write_text(json.dumps(layer_doc(5)))
    (root / roads.FETCHED_FILE).write_text(json.dumps({rel: "2026-09-24" for rel in roads.CACHE_FILES.values()}))
    return root


@pytest.fixture(scope="module")
def validators():
    return roads.RoadValidators()


def _three_states(node):
    """A schema with every 51 (features, capitals, places) lowered to 3, for a three state table."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if v == 51 and k in ("const", "minItems", "maxItems", "minimum", "maximum"):
                v = 3
            out[k] = _three_states(v)
        return out
    if isinstance(node, list):
        return [_three_states(v) for v in node]
    return node


@pytest.fixture
def three_state_validators(tmp_path):
    schemas = tmp_path / "schemas"
    schemas.mkdir()
    for filename in roads.SCHEMA_FILES.values():
        schema = _three_states(store.read_json(REPO_ROOT / "schemas" / filename))
        (schemas / filename).write_text(json.dumps(schema))
    return roads.RoadValidators(schemas)


def test_build_writes_three_valid_files_and_a_rerun_changes_nothing(tmp_path, three_state_validators):
    v = three_state_validators
    cache = write_cache(tmp_path / "cache")
    data = tmp_path / "data"
    states = table("CA", "NY", "AK")
    result = roads.build(cache, data, states, v)
    assert result.changed == {"map/states.json": True, "map/roads_nhfn.json": True, "map/places.json": True}
    for kind, rel in (("map-states", roads.STATES), ("map-roads", roads.ROADS_NHFN), ("map-places", roads.PLACES)):
        assert v.errors(kind, store.read_json(data / rel)) == []
    road = store.read_json(data / roads.ROADS_NHFN)
    assert [(r[0], r[1]) for r in road["lines"]] == [("I5", 1), ("I90", 1)]  # the two I5 pieces are one line
    assert road["dropped_outside_us"] == {"Baja California": 1, "Puerto Rico": 1}
    assert road["version"] == "2023.02.08" and road["compiled"] == "2023-01-27" and road["fetched"] == "2026-09-24"
    assert road["data_edited"] == "2026-05-13"
    before = {p: p.read_bytes() for p in (data / "map").iterdir()}
    again = roads.build(cache, data, states, v)
    assert all(changed is False for changed in again.changed.values())
    assert {p: p.read_bytes() for p in (data / "map").iterdir()} == before


def test_a_document_that_fails_its_schema_writes_nothing(tmp_path, validators):
    doc = store.read_json(DATA_DIR / roads.ROADS_NHFN)
    doc["lines"][0][0] = "I 5"
    with pytest.raises(store.SchemaError, match="map-roads"):
        roads.write_doc("map-roads", tmp_path / "roads.json", doc, validators)
    assert not (tmp_path / "roads.json").exists()


# ---------------------------------------------------------------- the committed files


@pytest.fixture(scope="module")
def committed():
    return {kind: (DATA_DIR / rel).read_bytes() for kind, rel in
            (("map-roads", roads.ROADS_NHFN), ("map-states", roads.STATES), ("map-places", roads.PLACES))}


def test_the_committed_files_match_their_schemas(committed, validators):
    for kind, body in committed.items():
        assert validators.errors(kind, json.loads(body)) == [], kind


def test_the_committed_files_fit_the_map_budget(committed):
    # gzip -9 bytes: roads under 45 KB, state outlines under 30 KB, places under 15 KB
    assert roads.gzip_size(committed["map-roads"]) < 45 * 1024
    assert roads.gzip_size(committed["map-states"]) < 30 * 1024
    assert roads.gzip_size(committed["map-places"]) < 15 * 1024


def test_the_committed_roads_carry_their_signs_and_stay_in_the_us(committed):
    doc = json.loads(committed["map-roads"])
    signs = {r[0] for r in doc["lines"] if r[0]}
    assert doc["counts"]["signs"] == len(signs) and doc["counts"]["lines"] == len(doc["lines"])
    for route in ("I5", "I10", "I15", "I35", "I40", "I70", "I75", "I80", "I90", "I94", "I95", "H1"):
        assert route in signs or f"I{route}" in signs or route == "H1" and "IH1" in signs, route
    assert doc["attribution"].endswith("NTAD National Highway Freight Network, U.S. DOT BTS, public domain")
    assert "Puerto Rico" in doc["dropped_outside_us"]
    points = 0
    for sign, code, pts in doc["lines"]:
        decoded = roads.delta_decode(pts, doc["precision"])
        points += len(decoded)
        for x, y in decoded:
            assert -180 <= x <= -66 and 18.5 <= y <= 71.5  # the 50 states plus DC, no Puerto Rico
    assert points == doc["counts"]["points"]


def test_the_committed_outlines_are_51_states_in_true_positions(committed):
    doc = json.loads(committed["map-states"])
    fips = {s.fips: s.code for s in load_states().states}
    assert {f["id"]: f["properties"]["code"] for f in doc["features"]} == fips
    by_code = {f["properties"]["code"]: f["geometry"]["coordinates"] for f in doc["features"]}
    hawaii = [p for poly in by_code["HI"] for ring in poly for p in ring]
    assert all(-161 < x < -154 and 18.5 < y < 22.5 for x, y in hawaii)  # where Hawaii is, not an inset
    alaska = [p for poly in by_code["AK"] for ring in poly for p in ring]
    assert min(x for x, _ in alaska) < -180 and max(x for x, _ in alaska) < -129 and max(y for _, y in alaska) > 71


def test_the_committed_places_hold_every_state_and_the_largest_cities(committed):
    doc = json.loads(committed["map-places"])
    rows = roads.decode_places(doc["places"], doc["precision"])
    assert len(rows) == doc["counts"]["places"] <= roads.PLACES_TOP + 51
    assert {state for _, state, _, _ in rows} == set(load_states().codes)
    names = {(name, state) for name, state, _, _ in rows}
    for place in (("New York City", "NY"), ("Chicago", "IL"), ("Laredo", "TX"), ("Pierre", "SD"), ("Montpelier", "VT"),
                  ("Washington", "DC"), ("Honolulu", "HI"), ("Anchorage", "AK")):
        assert place in names, place
    for name, state, lat, lon in rows:
        assert 18.5 < lat < 71.5 and -180 < lon < -66, name


# ---------------------------------------------------------------- isolation from the scheduled job


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
            names.update(f"{node.module}.{alias.name}" for alias in node.names)
    return names


def test_the_scheduled_job_never_imports_the_road_tool_and_the_tool_never_imports_mapdata():
    scripts = REPO_ROOT / "scripts"
    job = [scripts / "update_data.py", scripts / "health.py"] + [
        p for p in (scripts / "dailyfuel").glob("*.py") if p.name not in ("mapdata.py", "roads.py")
    ]
    for path in job:
        names = _imports(path)
        assert not any(n.split(".")[-1] in ("roads", "update_map_roads") for n in names), path.name
    workflow = (REPO_ROOT / ".github" / "workflows" / "update-data.yml").read_text(encoding="utf-8")
    assert "update_map_roads" not in workflow and "roads" not in workflow
    # tests/test_mapdata.py holds every module but mapdata.py to never importing mapdata
    names = _imports(scripts / "dailyfuel" / "roads.py") | _imports(scripts / "update_map_roads.py")
    assert not any("mapdata" in n for n in names)
    assert not any(n.split(".")[-1] in ("pipeline", "eia", "aaa", "derive") for n in names)
