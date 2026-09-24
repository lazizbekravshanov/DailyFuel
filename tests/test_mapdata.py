"""Map data: brand clustering, weigh station rules, the US filter, schemas, idempotency.

Everything here is synthetic: made up Overpass responses, a three state
topology with an exact Mexico line and 49th parallel, and a fake HTTP
client. tests/conftest.py blocks sockets. One test reads the real us-atlas
file when npm ci has put it in node_modules and skips otherwise.
"""

from __future__ import annotations

import ast
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from dailyfuel import mapdata, store
from dailyfuel.http import NetworkError, Response
from dailyfuel.paths import REPO_ROOT

# ---------------------------------------------------------------- synthetic geometry

# Winnipeg is 100 km north of the 49th parallel; Tijuana's centre is 2 km
# south of the California line, which runs straight from the Pacific at
# (32.5343, -117.12) to the Colorado river at (32.72, -114.72).
WINNIPEG = (49.8951, -97.1384)
GRAND_FORKS = (47.9253, -97.0329)
TIJUANA = (32.5149, -117.0382)
SAN_DIEGO = (32.7157, -117.1611)
DES_MOINES = (41.5868, -93.6250)

ND_RING = [(-104.05, 45.94), (-96.55, 45.94), (-96.55, 49.0), (-104.05, 49.0)]
CA_RING = [(-124.4, 42.0), (-114.1, 42.0), (-114.1, 35.0), (-114.72, 32.72), (-117.12, 32.5343), (-124.4, 32.5343)]
IA_RING = [(-96.64, 40.38), (-90.14, 40.38), (-90.14, 43.5), (-96.64, 43.5)]
STATE_RINGS = {"ND": ND_RING, "CA": CA_RING, "IA": IA_RING}
FIPS = {"ND": "38", "CA": "06", "IA": "19"}


def quantized_topology(polygons: dict[str, list[list[tuple[float, float]]]], obj: str = "states") -> dict:
    """A TopoJSON topology with a transform and delta encoded arcs, one arc per ring."""
    sx, sy = 1e-4, 1e-4
    tx, ty = -180.0, -90.0
    arcs = []
    geometries = []
    for gid, rings in polygons.items():
        arc_ids = []
        for ring in rings:
            closed = list(ring) + [ring[0]]
            q = [(round((x - tx) / sx), round((y - ty) / sy)) for x, y in closed]
            deltas = [list(q[0])] + [[q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]] for i in range(1, len(q))]
            arc_ids.append([len(arcs)])
            arcs.append(deltas)
        geometries.append({"type": "Polygon", "id": gid, "properties": {"name": gid}, "arcs": arc_ids})
    return {
        "type": "Topology",
        "transform": {"scale": [sx, sy], "translate": [tx, ty]},
        "objects": {obj: {"type": "GeometryCollection", "geometries": geometries}},
        "arcs": arcs,
    }


@pytest.fixture(scope="module")
def boundaries():
    topo = quantized_topology({FIPS[code]: [ring] for code, ring in STATE_RINGS.items()})
    rows = mapdata.decode_topology(topo, "states")
    by_fips = {v: k for k, v in FIPS.items()}
    return mapdata.Boundaries([(by_fips[str(gid)], poly) for _, gid, polys in rows for poly in polys])


@pytest.fixture(scope="module")
def outline():
    topo = quantized_topology({"nation": [ring for ring in STATE_RINGS.values()]}, obj="nation")
    return mapdata.Outline.from_topology(topo, "nation")


# ---------------------------------------------------------------- synthetic OSM


def el(kind: str, oid: int, lat: float, lon: float, **tags) -> dict:
    tags = {k.replace("__", ":"): v for k, v in tags.items()}
    if kind == "node":
        return {"type": "node", "id": oid, "lat": lat, "lon": lon, "tags": tags}
    return {"type": kind, "id": oid, "center": {"lat": lat, "lon": lon}, "tags": tags}


def overpass(elements: list[dict], base: str = "2026-09-20T01:32:50Z") -> dict:
    return {
        "version": 0.6,
        "generator": "Overpass API 0.7.62.11",
        "osm3s": {"timestamp_osm_base": base, "copyright": "ODbL"},
        "elements": elements,
    }


def offset(lat: float, lon: float, north_m: float = 0, east_m: float = 0) -> tuple[float, float]:
    import math

    return lat + north_m / 110_570, lon + east_m / (111_320 * math.cos(math.radians(lat)))


# ---------------------------------------------------------------- brands


def test_brand_of_uses_wikidata_first_then_one9_then_ambest():
    assert mapdata.brand_of({"brand": "Love's", "brand:wikidata": "Q1872496"}) == "loves"
    # A BP branded pump with Road Ranger's wikidata id is a Road Ranger.
    assert mapdata.brand_of({"brand": "BP", "brand:wikidata": "Q7339377"}) == "roadranger"
    assert mapdata.brand_of({"brand": "ONE9"}) == "one9"
    assert mapdata.brand_of({"brand": "One9"}) == "one9"
    assert mapdata.brand_of({"name": "Ambest Travel Center"}) == "ambest"
    assert mapdata.brand_of({"network": "AmBest"}) == "ambest"
    assert mapdata.brand_of({"brand": "Shell"}) is None
    for key, (name, qid) in mapdata.BRANDS.items():
        if qid:
            assert mapdata.brand_of({"brand:wikidata": qid}) == key


def test_cluster_sites_merges_same_brand_objects_within_300_m():
    lat, lon = GRAND_FORKS
    a = el("node", 1, lat, lon, amenity="fuel", brand="Love's", brand__wikidata="Q1872496")
    lat2, lon2 = offset(lat, lon, north_m=120)
    b = el("way", 2, lat2, lon2, amenity="fuel", brand="Love's", brand__wikidata="Q1872496", name="Love's Travel Stop")
    lat3, lon3 = offset(lat, lon, east_m=250)
    c = el("node", 3, lat3, lon3, amenity="fuel", brand="Love's", brand__wikidata="Q1872496")
    sites, counts = mapdata.cluster_sites([c, b, a])
    assert len(sites) == 1
    site = sites[0]
    assert site.brand == "loves"
    assert site.name == "Love's Travel Stop"
    assert sorted(site.osm) == ["n1", "n3", "w2"]
    assert abs(site.lat - lat) < 0.002 and abs(site.lon - lon) < 0.003
    assert counts == {"loves": 1, "unbranded": 0}


def test_cluster_sites_keeps_other_brands_and_far_objects_apart():
    lat, lon = GRAND_FORKS
    loves = el("node", 1, lat, lon, amenity="fuel", brand__wikidata="Q1872496")
    lat2, lon2 = offset(lat, lon, north_m=50)
    pilot = el("node", 2, lat2, lon2, amenity="fuel", brand__wikidata="Q64128179")
    lat3, lon3 = offset(lat, lon, north_m=400)
    loves_far = el("node", 3, lat3, lon3, amenity="fuel", brand__wikidata="Q1872496")
    sites, counts = mapdata.cluster_sites([loves, pilot, loves_far])
    assert sorted((s.brand, s.osm) for s in sites) == [("loves", ["n1"]), ("loves", ["n3"]), ("pilot", ["n2"])]
    assert counts == {"loves": 2, "pilot": 1, "unbranded": 0}
    assert all(s.name == mapdata.BRANDS[s.brand][0] for s in sites)


def test_cluster_sites_is_deterministic_whatever_the_input_order():
    lat, lon = GRAND_FORKS
    els = [
        el("node", i, *offset(lat, lon, north_m=140 * i), amenity="fuel", brand__wikidata="Q64128179")
        for i in range(6)
    ]
    forward, _ = mapdata.cluster_sites(els)
    backward, _ = mapdata.cluster_sites(list(reversed(els)))
    assert [(s.lat, s.lon, s.osm) for s in forward] == [(s.lat, s.lon, s.osm) for s in backward]


# ---------------------------------------------------------------- weigh station rules


def test_cat_scale_is_dropped_however_it_is_tagged():
    assert mapdata.classify({"amenity": "weighbridge", "brand": "CAT Scale", "name": "CAT Scale"}) == "cat_scale"
    assert mapdata.classify({"amenity": "weighbridge", "brand:wikidata": "Q111631907"}) == "cat_scale"
    # A CAT Scale with a truck stop operator and a weigh_station service tag.
    assert mapdata.classify({"service": "weigh_station", "highway": "service", "name": "Cat Scale"}) == "cat_scale"
    assert mapdata.classify({"amenity": "weighbridge", "operator": "Love's"}) != "cat_scale"


def test_border_stations_are_dropped():
    assert mapdata.classify({"barrier": "border_control", "name": "Port of Entry - Sumas"}) == "border"
    assert mapdata.classify({"office": "government", "name": "U.S. Customs and Border Protection - Porthill Port of Entry"}) == "border"
    assert mapdata.classify({"building": "yes", "name": "CBP Inspection Station (Trucks)"}) == "border"
    assert mapdata.classify({"building": "yes", "name": "US Port of Entry"}) == "border"
    # A state port of entry inland is not a border post.
    assert mapdata.classify({"office": "government", "name": "Raton Port of Entry", "operator": "New Mexico Department of Transportation"}) == "name"


def test_agricultural_and_vehicle_inspection_are_dropped():
    fdacs = {"building": "yes", "name": "Inspection Station", "operator": "Florida Department of Agriculture and Consumer Services"}
    assert mapdata.classify(fdacs) == "agricultural"
    assert mapdata.classify({"building": "yes", "name": "Cherry Growers Weigh Station"}) == "agricultural"
    assert mapdata.classify({"building": "yes", "name": "MVA Vehicle Emission Inspection Station"}) == "vehicle_inspection"
    assert mapdata.classify({"amenity": "vehicle_inspection", "name": "NJ MVC Kilmer Inspection Station"}) == "vehicle_inspection"
    assert mapdata.classify({"building": "yes", "name": "Strickland Brothers 10 Minute Oil Change and Inspection Station"}) == "vehicle_inspection"
    # A town's car inspection lane has nothing to say it weighs trucks.
    assert mapdata.classify({"amenity": "vehicle_inspection", "name": "Wayne Inspection Station"}) == "weak"
    # Virginia's DMV runs its weigh stations, so DMV alone is not a drop.
    virginia = {"building": "yes", "name": "Motor Carrier Service Center - Suffolk Weigh Station", "operator": "Virginia Department of Motor Vehicles"}
    assert mapdata.classify(virginia) == "name"


def test_state_stations_are_kept_by_tag_or_by_name():
    assert mapdata.classify({"highway": "service", "service": "weigh_station"}) == "tag"
    assert mapdata.classify({"highway": "motorway_link", "amenity": "weighbridge", "name": "CMV Inspection Station"}) == "tag"
    assert mapdata.classify({"amenity": "weighbridge", "operator": "FDOT", "building": "yes"}) == "tag"
    assert mapdata.classify({"amenity": "weighbridge", "highway": "service", "service": "weigh_station"}) == "tag"
    # A lane tagged for customers is still the state's lane when it is a weigh_station.
    assert mapdata.classify({"highway": "service", "service": "weigh_station", "access": "customers"}) == "tag"
    assert mapdata.classify({"amenity": "police", "name": "CSP Weigh Station: Fort Collins", "operator": "Colorado State Patrol"}) == "name"
    assert mapdata.classify({"amenity": "parking", "name": "Arizona Inspection Station"}) == "name"
    assert mapdata.classify({"landuse": "construction", "name": "Interstate 80 Westbound Truck Scales"}) == "name"
    assert mapdata.classify({"highway": "rest_area", "name": "Truck scales and rest area - I75 NB"}) == "name"
    assert mapdata.classify({"building": "yes", "name": "Idaho Port of Entry"}) == "name"


def test_roads_private_scales_and_closed_sites_are_dropped():
    assert mapdata.classify({"highway": "service", "name": "Scale House Road"}) == "road"
    assert mapdata.classify({"highway": "residential", "name": "Weigh Station Road"}) == "road"
    assert mapdata.classify({"highway": "motorway_junction", "name": "Weigh Station"}) == "road"
    assert mapdata.classify({"amenity": "weighbridge"}) == "private_scale"
    assert mapdata.classify({"amenity": "weighbridge", "operator": "Highway 99 Truckstop", "name": "Truck Scale"}) == "private"
    assert mapdata.classify({"amenity": "weighbridge", "access": "private", "operator": "Acme Quarry"}) == "private"
    assert mapdata.classify({"building": "industrial", "name": "Rusty's Weigh Scales & Service"}) == "private"
    assert mapdata.classify({"building": "yes", "name": "Harvey County Transfer Station and Landfill Weigh Station"}) == "private"
    assert mapdata.classify({"building": "yes", "name": "Scale House"}) == "weak"
    assert mapdata.classify({"building": "yes", "name": "Old Scale House"}) == "closed"
    assert mapdata.classify({"disused:amenity": "weighbridge", "name": "Weigh Station"}) == "closed"
    assert mapdata.classify({"traffic_sign": "yes", "name": "Weigh Station Open/Closed Sign"}) == "closed"
    assert mapdata.classify({"amenity": "marketplace", "name": "Scale House Market"}) == "not_a_station"


def test_weigh_candidates_dedupes_at_600_m_and_ranks_the_tagged_object_first():
    lat, lon = GRAND_FORKS
    lane = el("way", 10, lat, lon, highway="service", service="weigh_station")
    lat2, lon2 = offset(lat, lon, north_m=300)
    building = el("way", 11, lat2, lon2, building="yes", name="Grand Forks Weigh Station", operator="North Dakota Highway Patrol")
    lat3, lon3 = offset(lat, lon, north_m=900)
    other = el("node", 12, lat3, lon3, amenity="weigh_station", name="Weigh Station Northbound")
    cats = el("node", 13, lat, lon, amenity="weighbridge", brand="CAT Scale")
    responses = {"weighbridge": [cats], "tags": [lane, other], "names": [building, other]}
    cands, counts = mapdata.weigh_candidates(responses)
    assert len(cands) == 2
    first = next(c for c in cands if "w10" in c.osm)
    assert first.osm == ["w10", "w11"]  # the tagged lane leads, the named building folds in
    assert first.name == "Grand Forks Weigh Station"
    assert first.via == "tag" and first.gov is True
    second = next(c for c in cands if "n12" in c.osm)
    assert second.osm == ["n12"] and second.via == "tag" and second.gov is False
    assert counts["elements"] == 4  # the object in two result sets counts once
    assert counts["dropped_cat_scale"] == 1
    assert counts["candidates"] == 2


def test_near_border_drops_a_customs_port_but_not_a_state_patrol_station(outline):
    customs = mapdata.Candidate(32.55, -117.03, "Otay Mesa Port of Entry", "name", ["w1"])
    assert mapdata.near_border(customs, outline)
    patrol = mapdata.Candidate(32.55, -117.03, "Otay Mesa Port of Entry", "name", ["w1"], gov=True)
    assert not mapdata.near_border(patrol, outline)
    weigh = mapdata.Candidate(32.55, -117.03, "Otay Mesa Weigh Station", "name", ["w1"])
    assert not mapdata.near_border(weigh, outline)
    # A weigh lane that merged into the bridge's name is still the bridge.
    tagged = mapdata.Candidate(32.55, -117.03, "Otay Mesa Port of Entry", "tag", ["w1"])
    assert mapdata.near_border(tagged, outline)
    unnamed = mapdata.Candidate(32.55, -117.03, None, "tag", ["w1"])
    assert not mapdata.near_border(unnamed, outline)
    inland = mapdata.Candidate(47.0, -100.0, "Steele Port of Entry", "name", ["w2"])
    assert not mapdata.near_border(inland, outline)
    assert outline.distance_km(47.0, -100.0) > 100


# ---------------------------------------------------------------- the US filter


def test_decode_topology_handles_quantized_reversed_arcs_and_holes():
    outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    hole = [(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)]
    topo = quantized_topology({"x": [outer, hole]})
    # Reverse the hole arc with a negative index, as TopoJSON allows.
    topo["objects"]["states"]["geometries"][0]["arcs"][1] = [~1]
    rows = mapdata.decode_topology(topo, "states")
    assert len(rows) == 1
    props, gid, polys = rows[0]
    assert gid == "x" and props == {"name": "x"}
    assert len(polys) == 1 and len(polys[0]) == 2
    got_outer, got_hole = polys[0]
    assert [(round(x, 3), round(y, 3)) for x, y in got_outer] == outer
    # Reversed, starting from the same first vertex, closing vertex dropped.
    assert [(round(x, 3), round(y, 3)) for x, y in got_hole] == [hole[0]] + hole[1:][::-1]
    b = mapdata.Boundaries([("XX", polys[0])])
    assert b.state_of(2.0, 2.0) == "XX"
    assert b.state_of(5.0, 5.0) is None  # in the hole
    assert b.state_of(11.0, 5.0) is None
    with pytest.raises(mapdata.MapDataError):
        mapdata.decode_topology(topo, "nation")


def test_us_filter_drops_winnipeg_and_tijuana(boundaries):
    assert boundaries.state_of(*WINNIPEG) is None
    assert boundaries.state_of(*TIJUANA) is None
    assert boundaries.state_of(*GRAND_FORKS) == "ND"
    assert boundaries.state_of(*SAN_DIEGO) == "CA"
    assert boundaries.state_of(*DES_MOINES) == "IA"


def test_coast_tolerance_only_reaches_1_km_and_only_when_asked(boundaries):
    # 440 m south of the California line, which is at 32.5358 at this longitude.
    just_south = (32.5318, -117.1)
    assert boundaries.state_of(*just_south) is None
    assert boundaries.state_of(*just_south, mapdata.COAST_TOLERANCE_KM) == "CA"
    assert boundaries.state_of(*TIJUANA, mapdata.COAST_TOLERANCE_KM) is None
    assert boundaries.state_of(*WINNIPEG, mapdata.COAST_TOLERANCE_KM) is None


@pytest.mark.skipif(not mapdata.US_ATLAS_STATES.exists(), reason="us-atlas is not installed (npm ci)")
def test_us_filter_with_the_real_us_atlas_boundaries(states):
    b = mapdata.Boundaries.from_us_atlas(states)
    for lat, lon in (WINNIPEG, TIJUANA, (43.6532, -79.3832), (49.2827, -123.1207), (25.6866, -100.3161)):
        assert b.state_of(lat, lon) is None  # Winnipeg, Tijuana, Toronto, Vancouver, Monterrey
    assert b.state_of(*GRAND_FORKS) == "ND"
    assert b.state_of(*SAN_DIEGO) == "CA"
    assert b.state_of(41.8781, -87.6298) == "IL"
    assert b.state_of(61.2181, -149.9003) == "AK"
    assert b.state_of(21.3069, -157.8583) == "HI"
    assert b.state_of(38.8977, -77.0365) == "DC"
    assert b.state_of(18.4655, -66.1057) is None  # San Juan, Puerto Rico
    o = mapdata.Outline.from_us_atlas()
    assert o.distance_km(*TIJUANA) < 3
    assert o.distance_km(39.7392, -104.9903) > 500  # Denver


# ---------------------------------------------------------------- NTAD and Iowa rows


def ntad_feature(oid: int, name: str, lat: float, lon: float, state="FL", route="I-75N", spots=33) -> dict:
    return {
        "attributes": {
            "OBJECTID": oid, "state_number": "12", "nhs_rest_stop": name, "highway_route": route,
            "mile_post": "158", "municipality": "NA", "county": "Charlotte", "state": state,
            "latitude": lat, "longitude": lon, "number_of_spots": spots,
        },
        "geometry": {"x": lon, "y": lat},
    }


def ntad_doc(features: list[dict]) -> dict:
    return {"objectIdFieldName": "OBJECTID", "geometryType": "esriGeometryPoint", "features": features}


def iowa_feature(oid: int, lat, lon, name="Salix - Southbound", edited=1550843857000) -> dict:
    return {
        "type": "Feature",
        "id": oid,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "OBJECTID": oid, "REST_AREAS": name, "ROUTE": "I 29", "TRAVEL_DIRECTION": "SB",
            "FACILITY_TYPE": "Scale Building", "NEAREST_CITY": "Salix", "ADDRESS": "I-29 S Of Sioux City",
            "LATITUDE": None, "LONGITUDE": None, "EDITED_DATE": edited,
        },
    }


def iowa_doc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def test_ntad_sites_keeps_weigh_rows_with_their_fields():
    doc = ntad_doc([
        ntad_feature(212, "Weigh Station", 26.879157, -81.985993),
        ntad_feature(1, "Grand Bay Welcome Center", 30.477238, -88.393032),  # not a weigh row
        ntad_feature(204, "Plantation Key - Weight Station / Comfort Station", 24.9546, -80.5813, route="SR5/US1"),
    ])
    rows = mapdata.ntad_sites(doc)
    assert [r["id"] for r in rows] == [204, 212]
    assert rows[1] == {"lat": 26.87916, "lon": -81.98599, "name": "Weigh Station", "state": "FL", "route": "I-75N",
                       "milepost": "158", "spots": 33, "id": 212}
    with pytest.raises(mapdata.MapDataError):
        mapdata.ntad_sites({"features": [], "exceededTransferLimit": True})


def test_iowa_sites_use_the_geometry_when_the_lat_lon_fields_are_empty():
    doc = iowa_doc([
        iowa_feature(40906, 42.2902809, -96.28757226),
        iowa_feature(40916, 40.7684828, -91.562933, name=None, edited=None),
    ])
    rows, edited = mapdata.iowa_sites(doc)
    assert [r["id"] for r in rows] == [40916, 40906]
    assert rows[1]["name"] == "Salix - Southbound" and rows[1]["route"] == "I 29" and rows[1]["direction"] == "SB"
    assert rows[0]["name"] == "I-29 S Of Sioux City"  # falls back to the address
    assert edited == "2019-02-22"


# ---------------------------------------------------------------- the whole build


def write_cache(cache_dir: Path, brands=None, weigh=None, ntad=None, iowa=None, layers=None) -> Path:
    gf = GRAND_FORKS
    if brands is None:
        brands = [
            el("node", 1, *gf, amenity="fuel", brand="Love's", brand__wikidata="Q1872496", name="Love's"),
            el("way", 2, *offset(*gf, north_m=100), amenity="fuel", brand="Love's", brand__wikidata="Q1872496"),
            el("node", 3, *SAN_DIEGO, amenity="fuel", brand="Pilot", brand__wikidata="Q64128179"),
            el("node", 4, *DES_MOINES, amenity="fuel", brand="AmBest", name="AmBest"),
            el("node", 5, *TIJUANA, amenity="fuel", brand="Love's", brand__wikidata="Q1872496"),
        ]
    if weigh is None:
        weigh = {
            "weighbridge": [
                el("node", 20, *offset(*gf, east_m=5000), amenity="weighbridge", operator="North Dakota Highway Patrol"),
                el("node", 21, *gf, amenity="weighbridge", brand="CAT Scale"),
            ],
            "tags": [el("way", 22, *offset(*gf, east_m=5100), highway="service", service="weigh_station")],
            "names": [
                el("way", 23, *offset(*SAN_DIEGO, north_m=20000), building="yes", name="Weigh Station", operator="CHP"),
                el("way", 24, *WINNIPEG, building="yes", name="Weigh Station"),
                el("way", 25, 32.55, -117.03, building="yes", name="Otay Mesa Port of Entry"),
                el("way", 26, *DES_MOINES, building="yes", name="Iowa DOT Weigh Station"),
            ],
        }
    if ntad is None:
        ntad = ntad_doc([ntad_feature(212, "Weigh Station", *offset(*gf, east_m=5000), state="ND", route="I-29N")])
    if iowa is None:
        iowa = iowa_doc([iowa_feature(40906, *DES_MOINES)])
    for name, body in (("brands", overpass(brands)),) + tuple((k, overpass(v)) for k, v in weigh.items()):
        path = cache_dir / mapdata.CACHE_FILES[name]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body), encoding="utf-8")
    (cache_dir / mapdata.CACHE_FILES["ntad"]).parent.mkdir(parents=True, exist_ok=True)
    (cache_dir / mapdata.CACHE_FILES["ntad"]).write_text(json.dumps(ntad), encoding="utf-8")
    (cache_dir / mapdata.CACHE_FILES["ia"]).parent.mkdir(parents=True, exist_ok=True)
    (cache_dir / mapdata.CACHE_FILES["ia"]).write_text(json.dumps(iowa), encoding="utf-8")
    if layers is None:
        layers = {}
    for code, (filename, _) in mapdata.SPOT_CHECK_LAYERS.items():
        if code == "IA":
            continue  # the Iowa DOT layer written above doubles as Iowa's check layer
        features = layers.get(code, [])
        fc = {"type": "FeatureCollection", "features": features}
        (cache_dir / "state_layers" / filename).write_text(json.dumps(fc), encoding="utf-8")
    dates = {rel: "2026-09-19" for rel in mapdata.CACHE_FILES.values()}
    dates.update({f"state_layers/{fn}": "2026-09-19" for fn, _ in mapdata.SPOT_CHECK_LAYERS.values()})
    dates[mapdata.CACHE_FILES["ntad"]] = "2026-09-23"
    (cache_dir / mapdata.FETCHED_FILE).write_text(json.dumps(dates), encoding="utf-8")
    return cache_dir


def layer_feature(lat, lon, **props) -> dict:
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props}


@pytest.fixture(scope="module")
def map_validators():
    return mapdata.MapValidators()


def test_build_writes_five_valid_files_and_a_rerun_changes_nothing(tmp_path, states, boundaries, outline, map_validators):
    cache = write_cache(tmp_path / "cache")
    data = tmp_path / "data"
    result = mapdata.build(cache, data, states, boundaries, outline, map_validators)
    assert result.changed == {
        "map/stations.json": True, "map/weigh_osm.json": True, "map/weigh_ntad.json": True,
        "map/weigh_ia.json": True, "map/coverage.json": True,
    }
    docs = {}
    for kind, rel in (("map-stations", mapdata.STATIONS), ("map-weigh-osm", mapdata.WEIGH_OSM),
                      ("map-weigh-ntad", mapdata.WEIGH_NTAD), ("map-weigh-ia", mapdata.WEIGH_IA),
                      ("map-coverage", mapdata.COVERAGE)):
        docs[kind] = store.read_json(data / rel)
        assert map_validators.errors(kind, docs[kind]) == []
    before = {p: p.read_bytes() for p in (data / "map").iterdir()}
    again = mapdata.build(cache, data, states, boundaries, outline, map_validators)
    assert all(changed is False for changed in again.changed.values())
    assert {p: p.read_bytes() for p in (data / "map").iterdir()} == before

    st = docs["map-stations"]
    assert st["fetched"] == "2026-09-19" and st["osm_base"] == "2026-09-20T01:32:50Z"
    assert st["attribution"] == "© OpenStreetMap contributors" and "ODbL" in st["licence"]
    assert st["counts"] == {"elements": 5, "sites": 2, "dropped_ambest": 1, "dropped_outside_us": 1}
    assert [(s["brand"], s["osm"]) for s in st["sites"]] == [("loves", ["n1", "w2"]), ("pilot", ["n3"])]
    assert st["brands"]["loves"]["sites"] == 1 and st["brands"]["one9"]["sites"] == 0

    w = docs["map-weigh-osm"]
    assert w["counts"]["dropped_cat_scale"] == 1
    assert w["counts"]["dropped_outside_us"] == 1  # Winnipeg
    assert w["counts"]["dropped_border_outline"] == 1  # Otay Mesa
    # The patrol's weighbridge node outranks the unnamed lane (public operator first).
    assert [(s["state"], s["via"], s["osm"]) for s in w["sites"]] == [
        ("CA", "name", ["w23"]), ("IA", "name", ["w26"]), ("ND", "tag", ["n20", "w22"]),
    ]
    assert docs["map-weigh-ntad"]["counts"] == {"rows": 1, "sites": 1, "dropped_outside_us": 0}
    assert docs["map-weigh-ntad"]["fetched"] == "2026-09-23" and docs["map-weigh-ntad"]["compiled"] == "2019-04-09"
    assert docs["map-weigh-ia"]["counts"] == {"rows": 1, "sites": 1, "dropped_outside_iowa": 0}
    assert docs["map-weigh-ia"]["licence"].endswith("(CC BY 4.0)")
    cv = docs["map-coverage"]
    # Iowa's layer is both the Iowa source and a check layer: its one row is matched by w26.
    assert cv["weigh"]["official"] == 1 and cv["weigh"]["matched"] == 1 and cv["weigh"]["share"] == 1.0
    assert all(cv["weigh"]["states"][code]["official"] == 0 for code in cv["weigh"]["states"] if code != "IA")
    assert {r["brands"][0]: r["osm_sites"] for r in cv["chains"]["rows"]}["loves"] == 1
    assert cv["chains"]["rows"][0]["share"] == 0.704
    assert cv["weigh"]["reference"]["count"] == 680


def test_build_measures_the_spot_check_against_the_state_layers(tmp_path, states, boundaries, outline, map_validators):
    # state_layers/IA.geojson is also the Iowa source, so the check layers here are IL and AZ.
    gf = GRAND_FORKS
    layers = {
        "IL": [layer_feature(*DES_MOINES), layer_feature(*offset(*DES_MOINES, north_m=30000))],
        "AZ": [layer_feature(*gf, Active="YES"), layer_feature(*gf, Active="NO")],
    }
    cache = write_cache(tmp_path / "cache", layers=layers)
    mapdata.build(cache, tmp_path / "data", states, boundaries, outline, map_validators)
    cv = store.read_json(tmp_path / "data" / mapdata.COVERAGE)
    assert cv["weigh"]["states"]["IL"] == {"official": 2, "matched": 1, "layer_filter": None}
    # The inactive Arizona row is filtered out; the active one is 5 km from the weigh station.
    assert cv["weigh"]["states"]["AZ"] == {"official": 1, "matched": 0, "layer_filter": "Active equals YES"}
    # Iowa's own layer is the Iowa source: one row, matched by the OSM candidate at Des Moines.
    assert cv["weigh"]["states"]["IA"] == {"official": 1, "matched": 1, "layer_filter": None}
    assert cv["weigh"]["official"] == 4 and cv["weigh"]["matched"] == 2 and cv["weigh"]["share"] == 0.5
    assert cv["weigh"]["measured"] == "2026-09-19"


def test_build_refuses_a_cache_with_a_missing_file(tmp_path, states, boundaries, outline, map_validators):
    cache = write_cache(tmp_path / "cache")
    (cache / mapdata.CACHE_FILES["ntad"]).unlink()
    with pytest.raises(mapdata.MapDataError, match="--live"):
        mapdata.build(cache, tmp_path / "data", states, boundaries, outline, map_validators)
    assert not (tmp_path / "data").exists()


def test_build_refuses_an_overpass_error_remark(tmp_path, states, boundaries, outline, map_validators):
    cache = write_cache(tmp_path / "cache")
    body = overpass([])
    body["remark"] = "runtime error: Query timed out in \"query\" at line 1 after 240 seconds."
    (cache / mapdata.CACHE_FILES["brands"]).write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(mapdata.MapDataError, match="remark"):
        mapdata.build(cache, tmp_path / "data", states, boundaries, outline, map_validators)


def test_committed_map_files_match_their_schemas(map_validators):
    for kind, rel in (("map-stations", mapdata.STATIONS), ("map-weigh-osm", mapdata.WEIGH_OSM),
                      ("map-weigh-ntad", mapdata.WEIGH_NTAD), ("map-weigh-ia", mapdata.WEIGH_IA),
                      ("map-coverage", mapdata.COVERAGE)):
        path = REPO_ROOT / "data" / rel
        assert path.exists(), f"{rel} is not committed; run scripts/update_map_data.py"
        doc = store.read_json(path)
        assert map_validators.errors(kind, doc) == []
        assert path.read_text(encoding="utf-8") == store.dumps(doc)  # the committed bytes are the tool's bytes
    stations = store.read_json(REPO_ROOT / "data" / mapdata.STATIONS)
    assert set(stations["brands"]) == set(mapdata.BRANDS)
    assert "ambest" not in {s["brand"] for s in stations["sites"]}
    assert all(s["brand"] in mapdata.BRANDS for s in stations["sites"])
    weigh = store.read_json(REPO_ROOT / "data" / mapdata.WEIGH_OSM)
    assert not any("cat scale" in (s["name"] or "").lower() for s in weigh["sites"])
    assert weigh["counts"]["sites"] == len(weigh["sites"])


# ---------------------------------------------------------------- live fetching


class RecordingHttp:
    """Serves canned bodies by URL prefix and records every call in order."""

    def __init__(self, bodies: dict[str, list[Response]]):
        self.bodies = {k: list(v) for k, v in bodies.items()}
        self.calls: list[tuple[str, dict, float]] = []

    def get(self, url, headers=None, timeout=30):
        self.calls.append((url, dict(headers or {}), timeout))
        for prefix, queue in self.bodies.items():
            if url.startswith(prefix):
                item = queue.pop(0) if len(queue) > 1 else queue[0]
                if isinstance(item, Exception):
                    raise item
                return item
        raise AssertionError(f"unexpected url {url}")


def test_fetch_live_runs_one_overpass_query_at_a_time_with_a_pause_and_names_the_repo(tmp_path, sleeps):
    gf = GRAND_FORKS
    brands = overpass([el("node", 1, *gf, amenity="fuel", brand__wikidata="Q1872496")])
    empty = overpass([])
    http = RecordingHttp({
        mapdata.OVERPASS_URL: [Response.make(200, json.dumps(brands)), Response.make(200, json.dumps(empty))],
        mapdata.NTAD_LAYER_URL: [Response.make(200, json.dumps(ntad_doc([ntad_feature(212, "Weigh Station", *gf)])))],
        mapdata.IA_LAYER_URL: [Response.make(200, json.dumps(iowa_doc([iowa_feature(40906, *DES_MOINES)])))],
    })
    now = datetime(2026, 9, 23, 14, 0, tzinfo=timezone.utc)
    written = mapdata.fetch_live(tmp_path, http, now, sleeps, log=lambda *_: None)
    urls = [u for u, _, _ in http.calls]
    assert [u.startswith(mapdata.OVERPASS_URL) for u in urls] == [True, True, True, True, False, False]
    # One query at a time: a pause between each pair of Overpass calls, none before the first.
    assert sleeps.calls == [mapdata.OVERPASS_PAUSE] * 3
    for url, headers, timeout in http.calls[:4]:
        assert "timeout%3A240" in url or "timeout:240" in url
        assert headers["User-Agent"] == mapdata.USER_AGENT
        assert "github.com/lazizbekravshanov/DailyFuel" in headers["User-Agent"]
        assert timeout >= mapdata.OVERPASS_TIMEOUT
    assert set(written) == set(mapdata.CACHE_FILES.values())
    assert json.loads((tmp_path / mapdata.CACHE_FILES["brands"]).read_text())["elements"][0]["id"] == 1
    dates = json.loads((tmp_path / mapdata.FETCHED_FILE).read_text())
    assert dates == {rel: "2026-09-23" for rel in mapdata.CACHE_FILES.values()}


def test_fetch_live_retries_a_busy_overpass_once_and_keeps_the_old_cache_on_failure(tmp_path, sleeps):
    cache = write_cache(tmp_path)
    before = (cache / mapdata.CACHE_FILES["brands"]).read_bytes()
    http = RecordingHttp({mapdata.OVERPASS_URL: [Response.make(504, "busy"), NetworkError("boom")]})
    now = datetime(2026, 9, 23, 14, 0, tzinfo=timezone.utc)
    with pytest.raises(mapdata.MapDataError, match="brands"):
        mapdata.fetch_live(cache, http, now, sleeps, log=lambda *_: None)
    assert len(http.calls) == 2
    assert sleeps.calls == [mapdata.OVERPASS_RETRY_AFTER]
    assert (cache / mapdata.CACHE_FILES["brands"]).read_bytes() == before


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


def test_the_scheduled_job_never_imports_the_map_data_code():
    scripts = REPO_ROOT / "scripts"
    map_code = ("mapdata", "update_map_data", "fleetpoints", "import_fleet_points")
    job = [scripts / "update_data.py", scripts / "health.py"] + [
        p for p in (scripts / "dailyfuel").glob("*.py") if p.name not in ("mapdata.py", "fleetpoints.py")
    ]
    for path in job:
        names = _imports(path)
        assert not any(m in n for n in names for m in map_code), f"{path.name} imports the map data code"
    workflow = (REPO_ROOT / ".github" / "workflows" / "update-data.yml").read_text(encoding="utf-8")
    assert not any(m in workflow for m in map_code)
    # And the map tools never touch the pipeline's data files.
    names = set()
    for rel in ("update_map_data.py", "import_fleet_points.py", "dailyfuel/mapdata.py", "dailyfuel/fleetpoints.py"):
        names |= _imports(scripts / rel)
    assert not any(n.split(".")[-1] in ("pipeline", "eia", "aaa", "derive") for n in names)
