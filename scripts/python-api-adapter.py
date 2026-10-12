#!/usr/bin/env python3
"""Benchmark VIGO 0.5's public Python API through complete Result serialization."""
import json
import os
from pathlib import Path
import re
import sys
import time

def route_options(request, context):
    allowed = {"id", "kind", "origin", "destination", "mode", "time", "serviceDate", "timePreference",
        "maxWalkKm", "maxTransfers", "horizonMinutes", "requireTransitRide", "disableCache",
        "objective", "waypoints", "departureWindowMinutes"}
    unknown = set(request) - allowed
    if unknown:
        raise ValueError(f"Unsupported Python benchmark request fields: {', '.join(sorted(unknown))}")
    if request.get("kind", "route") != "route":
        raise ValueError("The coordinate benchmark requires kind: route")
    if context.get("routingPreference", "fastest") != "fastest":
        raise ValueError("VIGO 0.5 requires the earliest_arrival objective")
    controls = context["comparison"]
    preference = request.get("timePreference", "depart_at")
    if preference not in {"depart", "depart_at", "arrive", "arrive_by"}:
        raise ValueError("timePreference must be depart_at or arrive_by")
    options = {
        "mode": request.get("mode", "transit"),
        "service_date": request.get("serviceDate", context["serviceDate"]),
        "max_walk_km": request.get("maxWalkKm", context["maxWalkKm"]),
        "max_transfers": request.get("maxTransfers", controls["maxTransfers"]),
        "horizon_minutes": request.get("horizonMinutes", controls["horizonMinutes"]),
        "require_transit_ride": request.get("requireTransitRide", controls.get("requireTransitRide", True)),
        "disable_cache": request.get("disableCache", False),
        "objective": request.get("objective", "earliest_arrival"),
        "waypoints": request.get("waypoints", ()),
        "departure_window_minutes": request.get("departureWindowMinutes", 0),
    }
    options["arrive_by" if preference in {"arrive", "arrive_by"} else "depart_at"] = request.get("time", context["time"])
    return options


def main():
    source = Path(os.environ.get("VIGO_BENCH_PYTHON_SOURCE", Path(__file__).resolve().parents[2] / "vigo-py")).resolve()
    sys.path.insert(0, str(source))
    import vigo

    if not re.fullmatch(r"0\.5\.\d+(?:[-+].*)?", vigo.__version__):
        raise RuntimeError("This adapter requires VIGO-py 0.5; select the current wrapper source")
    # Pin Node as well as the CLI, so PATH cannot select another engine host.
    command = os.environ.get("VIGO_BENCH_VIGO_COMMAND_JSON")
    runtime = json.loads(command) if command else os.environ["VIGO_BENCH_VIGO_CLI"]
    network = Path(os.environ["VIGO_BENCH_NETWORK_DIR"])
    context = json.loads(Path(os.environ["VIGO_BENCH_CONTEXT"]).read_text())
    if context.get("routingPreference", "fastest") != "fastest":
        raise ValueError("VIGO 0.5 requires the earliest_arrival objective")
    if os.environ["VIGO_BENCH_PHASE"] == "prepare":
        with vigo.build(network, gtfs=json.loads(os.environ["VIGO_BENCH_GTFS_PATHS_JSON"]),
                        osm=os.environ["VIGO_BENCH_OSM_PBF"], street_modes="walk", runtime=runtime, timeout=1800) as city:
            payload = city.details
            street, transit = payload.get("streetStore", {}), payload.get("routingStore", {})
            payload["network"] = {
                "street": {"nodes": street.get("nodeCount"), "edges": street.get("edgeCount")},
                "transit": {key: transit.get(source) for key, source in
                            [("stops", "stopCount"), ("routes", "routeCount"),
                             ("trips", "tripCount"), ("connections", "connectionCount")]}}
            payload["pythonRuntime"] = {"wrapperVersion": vigo.__version__, "source": str(Path(vigo.__file__).resolve()),
                "engineVersion": city.runtime.product_version, "command": list(city.runtime.command)}
            print(json.dumps(payload), flush=True)
        return
    with vigo.open(network, runtime=runtime) as city:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                    raise ValueError("Each request needs a string id")
                options = route_options(request, context)
                # Parsing stays inside caller wall time, outside this API timer.
                started = time.perf_counter()
                result = city.route(request["origin"], request["destination"], **options)
                encoded = result.to_json(indent=None)
                elapsed = (time.perf_counter() - started) * 1000
                timing = {**result.timing, "pythonApiAndSerializationMs": elapsed}
                prefix = json.dumps({"id": request["id"], "timing": timing, "queryMs": elapsed})
                sys.stdout.write(prefix[:-1] + ',"result":' + encoded + '}\n')
                sys.stdout.flush()
            except Exception as error:
                print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                    "status": "error", "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
