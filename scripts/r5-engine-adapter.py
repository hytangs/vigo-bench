#!/usr/bin/env python3
"""Small local R5/R5py adapter for the coordinate benchmark protocol.

R5 uses r5py TripPlanner; R5py adds DetailedItineraries over the same planner.
Both use an explicitly corrected r5py copy for earliest-candidate extraction
and native leg clocks. Both receive OSM and all GTFS ZIPs.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import sys
import time
from pathlib import Path

from r5_gtfs_compat import prepare_gtfs_paths_for_r5


def required_path(name: str) -> Path:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing {name}")
    return Path(value).expanduser().resolve()


workdir = required_path("VIGO_BENCH_WORKDIR")
os.environ.setdefault("XDG_CACHE_HOME", str(workdir / "r5py-cache"))
r5_jar = os.environ.get("VIGO_BENCH_R5_JAR", "").strip()
if r5_jar and "--r5-classpath" not in sys.argv:
    sys.argv.extend(["--r5-classpath", r5_jar])
r5py_source = os.environ.get("VIGO_BENCH_R5PY_SOURCE", "").strip()
if not r5py_source:
    raise RuntimeError("Set VIGO_BENCH_R5PY_SOURCE to a copy built by prepare-r5py-itineraries.py")
sys.path.insert(0, str(Path(r5py_source).resolve()))

import geopandas  # noqa: E402
import r5py  # noqa: E402
import shapely  # noqa: E402

from r5py.r5.trip_planner import TripPlanner  # noqa: E402
from r5py.r5.trip import Trip  # noqa: E402
from r5py._benchmark_itinerary_patch import PATCH, SUBOPTIMAL_MINUTES, UPSTREAM_VERSION  # noqa: E402
from com.conveyal.r5.profile import McRaptorSuboptimalPathProfileRouter  # noqa: E402

DOMINANCE_PATCH = str(getattr(McRaptorSuboptimalPathProfileRouter, 'VIGO_BENCH_DOMINANCE', 'upstream-list'))


def context() -> dict:
    return json.loads(required_path("VIGO_BENCH_CONTEXT").read_text(encoding="utf-8"))


def load_network():
    # A query-only replay can open a retained native graph without copying it
    # or invoking TransportNetwork's cache writer. Preparation always imports
    # the declared OSM and GTFS inputs through the normal path below.
    retained = os.environ.get("VIGO_BENCH_R5_NETWORK", "").strip()
    if retained and os.environ.get("VIGO_BENCH_PHASE") == "query":
        network_path = required_path("VIGO_BENCH_R5_NETWORK")
        if not network_path.is_file():
            raise RuntimeError(f"Retained R5 network not found: {network_path}")
        network = r5py.TransportNetwork.__new__(r5py.TransportNetwork)
        network._transport_network = network._load_pickled_transport_network(network_path)
        return network, {"retainedNetwork": str(network_path), "readOnly": True}
    osm = required_path("VIGO_BENCH_OSM_PBF")
    source_gtfs = [Path(value).expanduser().resolve() for value in json.loads(os.environ["VIGO_BENCH_GTFS_PATHS_JSON"])]
    gtfs, compatibility = prepare_gtfs_paths_for_r5(source_gtfs, workdir / "r5-compatible-gtfs")
    return r5py.TransportNetwork(osm, gtfs), compatibility


def departure(value: dict) -> dt.datetime:
    return dt.datetime.fromisoformat(f"{value['serviceDate']}T{value['time']}:00+00:00")


def options(settings):
    controls = settings["comparison"]
    walking = dt.timedelta(seconds=math.floor(settings["maxWalkKm"] * 3600 / controls["walkSpeedKph"]))
    # The installed itinerary wrapper uses these explicit street-router limits,
    # independently of RegionalTask.maxWalkTime (which only has minute precision).
    TripPlanner.MAX_ACCESS_TIME = walking
    TripPlanner.MAX_EGRESS_TIME = walking
    return dict(departure=departure(settings), departure_time_window=dt.timedelta(0),
                transport_modes=[r5py.TransportMode.TRANSIT], access_modes=[r5py.TransportMode.WALK],
                egress_modes=[r5py.TransportMode.WALK], max_time=dt.timedelta(minutes=controls["horizonMinutes"]),
                max_time_walking=walking, speed_walking=controls["walkSpeedKph"],
                max_public_transport_rides=controls["maxTransfers"] + 1)


def points(request, side):
    return geopandas.GeoDataFrame({"id": [request["id"]]},
        geometry=[shapely.Point(*request[side]["coordinate"])], crs="EPSG:4326")


def raw_r5_routes(network, request, settings):
    task = r5py.RegionalTask(network, origin=shapely.Point(*request["origin"]["coordinate"]),
                           **options(settings))
    task._regional_task.toLon, task._regional_task.toLat = request["destination"]["coordinate"]
    trips = TripPlanner(network, task).trips
    return [[dict(zip(Trip.COLUMNS, row)) for row in trip.as_table()] for trip in trips]


def r5py_routes(network, request, settings):
    table = r5py.DetailedItineraries(network, points(request, "origin"), points(request, "destination"),
                                   **options(settings))
    return [rows.to_dict("records") for _, rows in table.groupby("option")] if len(table) else []


def route_payload(routes, request, settings, engine):
    if not routes:
        return {"id": request["id"], "status": "blocked", "plan": {"status": "blocked"},
                "detail": "R5 returned no detailed transit itinerary."}
    # Absolute arrival includes the initial wait at the fixed departure time.
    def arrival(legs):
        return max(leg["departure_time"] + leg["travel_time"] for leg in legs)
    selected = min(routes, key=arrival)
    end = arrival(selected)
    if getattr(end, "tzinfo", None) is None:
        end = end.replace(tzinfo=dt.timezone.utc)
    def plain(value):
        if value is None:
            return None
        if hasattr(value, "__geo_interface__"):
            return value.__geo_interface__
        if isinstance(value, dt.timedelta):
            return value.total_seconds()
        if isinstance(value, dt.datetime):
            return value.isoformat()
        if hasattr(value, "name"):
            return value.name
        if isinstance(value, (int, float)):
            return value if math.isfinite(value) else None
        return str(value)
    legs = [{key: plain(value) for key, value in leg.items()} for leg in selected]
    rides = sum(leg["transport_mode"] != "WALK" for leg in legs)
    return {"id": request["id"], "status": "ready", "itinerary": {"legs": legs},
            "plan": {"status": "ready", "durationMinutes": (end - departure(settings)).total_seconds() / 60,
                     "transfers": max(0, rides - 1), "diagnostics": {"algorithm": engine + " McRAPTOR itinerary",
                     "walkingNetwork": "osm", "departureWindowSeconds": 0,
                     "suboptimalMinutes": SUBOPTIMAL_MINUTES, "r5pyVersion": UPSTREAM_VERSION,
                     "itineraryPatch": PATCH,
                     "dominancePatch": DOMINANCE_PATCH,
                     "runtimePatch": "explicit fixed-departure sample; native boarding slack remains 60 seconds",
                     "pathExtraction": "r5py TripPlanner" if engine == "R5" else "r5py DetailedItineraries"}}}


def network_summary(network, feed_count: int) -> dict:
    street = network.street_layer._street_layer
    transit = network.transit_layer._transit_layer
    return {
        "street": {
            "nodes": int(street.getVertexCount()),
            "edges": int(street.edgeStore.nEdges()),
            "source": "R5 compiled OSM street graph",
        },
        "transit": {
            "stops": int(transit.getStopCount()),
            "routes": int(transit.routes.size()),
            "tripPatterns": int(transit.tripPatterns.size()),
            "feeds": feed_count,
        },
    }


def main() -> None:
    import com.conveyal.r5.profile
    if not getattr(com.conveyal.r5.profile.McRaptorSuboptimalPathProfileRouter, 'VIGO_BENCH_FIXED_DEPARTURE', False):
        raise RuntimeError('Full fixed-departure itineraries require the explicit build-r5-fixed-departure.py JAR; the upstream sampler cannot handle this window.')
    if not hasattr(com.conveyal.r5.profile.McRaptorSuboptimalPathProfileRouter, 'createSuboptimalListSupplier'):
        raise RuntimeError('Rebuild the retained JAR with build-r5-fixed-departure.py to provide the native dominance-list factory.')
    settings = context()
    engine = os.environ.get("VIGO_BENCH_ENGINE", "R5")
    network, gtfs_compatibility = load_network()
    if os.environ.get("VIGO_BENCH_PHASE") == "prepare":
        print(json.dumps({"status": "ready", "engine": engine, "network": network_summary(network, len(json.loads(os.environ["VIGO_BENCH_GTFS_PATHS_JSON"]))), "gtfsCompatibility": gtfs_compatibility,
                          "r5pyVersion": UPSTREAM_VERSION, "itineraryPatch": PATCH,
                          "dominancePatch": DOMINANCE_PATCH,
                          "suboptimalMinutes": SUBOPTIMAL_MINUTES}, separators=(",", ":")), flush=True)
        return
    if os.environ.get("VIGO_BENCH_PHASE") != "query":
        raise RuntimeError("VIGO_BENCH_PHASE must be prepare or query")
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        started = time.perf_counter()
        try:
            routes = raw_r5_routes(network, request, settings) if engine == "R5" else r5py_routes(network, request, settings)
            payload = route_payload(routes, request, settings, engine)
            if isinstance(gtfs_compatibility, dict) and gtfs_compatibility.get("readOnly"):
                payload["networkSource"] = gtfs_compatibility
            payload["queryMs"] = (time.perf_counter() - started) * 1000
            print(json.dumps(payload, separators=(",", ":"), allow_nan=False), flush=True)
        except Exception as error:  # keep one protocol response per request
            print(json.dumps({"id": request.get("id"), "status": "error", "queryMs": (time.perf_counter() - started) * 1000, "error": str(error)}, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
