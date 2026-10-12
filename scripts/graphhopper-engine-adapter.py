#!/usr/bin/env python3
"""GraphHopper public-transit adapter for the coordinate benchmark."""

from __future__ import annotations

from adapter_runtime import agency_timezone, ResidentHttpClient

HTTP = ResidentHttpClient()

import atexit
import datetime as dt
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


WORKDIR = Path(required("VIGO_BENCH_WORKDIR")).resolve()
OSM = Path(required("VIGO_BENCH_OSM_PBF")).resolve()
GTFS = [Path(value).resolve() for value in json.loads(required("VIGO_BENCH_GTFS_PATHS_JSON"))]
CONTEXT = json.loads(Path(required("VIGO_BENCH_CONTEXT")).read_text(encoding="utf-8"))
JAR = Path(required("VIGO_BENCH_GRAPHHOPPER_JAR")).resolve()


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def yaml_string(value: str | Path) -> str:
    return json.dumps(str(value))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def timezone_name() -> str:
    return agency_timezone(tuple(str(feed) for feed in GTFS)) or "UTC"


def departure_iso() -> str:
    local = dt.datetime.fromisoformat(f"{CONTEXT['serviceDate']}T{CONTEXT['time']}:00")
    try:
        return local.replace(tzinfo=ZoneInfo(timezone_name())).isoformat(timespec="seconds")
    except Exception:
        return local.replace(tzinfo=dt.timezone.utc).isoformat(timespec="seconds")


def write_config(port: int, admin_port: int) -> Path:
    if any("," in str(path) for path in GTFS):
        raise RuntimeError("GraphHopper cannot accept a comma in a GTFS path")
    graph = WORKDIR / "network" / "graphhopper"
    graph.parent.mkdir(parents=True, exist_ok=True)
    config = WORKDIR / "graphhopper.yml"
    content = "\n".join(
        [
            "graphhopper:",
            f"  datareader.file: {yaml_string(OSM)}",
            f"  gtfs.file: {yaml_string(','.join(str(path) for path in GTFS))}",
            f"  graph.location: {yaml_string(graph)}",
            "  profiles:",
            "    - name: foot",
            "      custom_model_files:",
            "        - foot.json",
            "  import.osm.ignored_highways: motorway,trunk",
            "  graph.encoded_values: foot_access, foot_average_speed, foot_priority, foot_road_access, hike_rating, mtb_rating, country, road_class, road_environment, ferry_speed",
            "  gtfs.trip_based: false",
            "server:",
            "  application_connectors:",
            "    - type: http",
            f"      port: {port}",
            "      bind_host: 127.0.0.1",
            "  admin_connectors:",
            "    - type: http",
            f"      port: {admin_port}",
            "      bind_host: 127.0.0.1",
            "",
        ]
    )
    config.write_text(content, encoding="utf-8")
    return config


class GraphHopperProcess:
    def __init__(self) -> None:
        with zipfile.ZipFile(JAR) as archive:
            if 'vigo-bench-walk-speed-v1.java.txt' not in archive.namelist():
                raise RuntimeError('GraphHopper requires the walking-speed compatibility JAR; run setup:expanded-engines -- --engines GraphHopper')
        self.port = free_port()
        self.admin_port = free_port()
        self.config = write_config(self.port, self.admin_port)
        self.log_path = WORKDIR / f"graphhopper-{os.environ.get('VIGO_BENCH_PHASE', 'run')}.log"
        self.log = self.log_path.open("w", encoding="utf-8")
        # Upper heap limit proven by the seven-feed NYC import. -Xms stays small.
        self.heap_gb = int(os.environ.get("VIGO_GRAPHHOPPER_HEAP_GB", "10"))
        if self.heap_gb <= 0:
            raise ValueError("VIGO_GRAPHHOPPER_HEAP_GB must be positive")
        self.process = subprocess.Popen(
            [
                os.environ.get("JAVA", "java"),
                "-Xms256m",
                f"-Xmx{self.heap_gb}G",
                "-XX:+UseG1GC",
                "-jar",
                str(JAR),
                "server",
                str(self.config),
            ],
            cwd=WORKDIR,
            stdout=self.log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        atexit.register(self.close)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def log_tail(self, limit: int = 8000) -> str:
        self.log.flush()
        text = self.log_path.read_text(encoding="utf-8", errors="replace")
        return text[-limit:]

    def wait_ready(self) -> dict[str, Any]:
        deadline = time.monotonic() + float(os.environ.get("VIGO_GRAPHHOPPER_STARTUP_SECONDS", "1800"))
        while time.monotonic() < deadline:
            code = self.process.poll()
            if code is not None:
                raise RuntimeError(f"GraphHopper exited with {code}:\n{self.log_tail()}")
            try:
                with urllib.request.urlopen(f"{self.base_url}/info", timeout=2) as response:
                    if response.status == 200:
                        return json.loads(response.read())
            except (urllib.error.URLError, ConnectionError, TimeoutError, json.JSONDecodeError):
                time.sleep(0.1)
        raise RuntimeError(f"GraphHopper did not become ready (exit {self.process.poll()}):\n{self.log_tail()}")

    def close(self) -> None:
        process = getattr(self, "process", None)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        log = getattr(self, "log", None)
        if log is not None and not log.closed:
            log.close()


def prepare() -> None:
    server = GraphHopperProcess()
    try:
        info = server.wait_ready()
        (WORKDIR / "graphhopper-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
        emit(
            {
                "status": "ready",
                "engine": "GraphHopper",
                "network": {
                    "street": {
                        "source": "GraphHopper imported OSM foot graph; native vertex and edge totals are not exposed by /info",
                    },
                    "transit": {
                        "feeds": len(GTFS),
                        "source": "all GTFS ZIPs loaded into GraphHopper's time-expanded transit graph",
                    },
                },
                "native": {
                    "version": info.get("version"),
                    "buildDate": info.get("build_date"),
                    "profiles": info.get("profiles"),
                    "algorithm": "GraphHopper public-transit multi-criteria label setting",
                    "tripBasedPreprocessing": False,
                    "heapLimitGiB": server.heap_gb,
                },
            }
        )
    finally:
        server.close()


def error_text(payload: dict[str, Any]) -> str:
    hints = payload.get("hints") if isinstance(payload.get("hints"), list) else []
    details = [str(payload.get("message", ""))]
    for hint in hints:
        if isinstance(hint, dict):
            details.extend([str(hint.get("message", "")), str(hint.get("details", ""))])
    return " ".join(value for value in details if value).strip()


def is_blocked_error(message: str) -> bool:
    return bool(
        re.search(
            r"connection.*not found|no (?:route|path)|not connected|cannot find point|point.*outside|not found close to point",
            message,
            flags=re.IGNORECASE,
        )
    )


def route_url(base_url: str, request: dict[str, Any]) -> str:
    origin_lon, origin_lat = request["origin"]["coordinate"]
    destination_lon, destination_lat = request["destination"]["coordinate"]
    walk_speed = CONTEXT.get('comparison', {}).get('walkSpeedKph', 4.8)
    max_walk_seconds = math.floor(float(CONTEXT["maxWalkKm"]) * 3600 / walk_speed)
    query = urllib.parse.urlencode(
        [
            ("point", f"{origin_lat},{origin_lon}"),
            ("point", f"{destination_lat},{destination_lon}"),
            ("profile", "pt"),
            ("pt.earliest_departure_time", departure_iso()),
            ("pt.profile", "false"),
            ("pt.walk_speed", str(walk_speed)),
            ("pt.limit_solutions", "1"),
            ("pt.limit_trip_time", f"PT{CONTEXT.get('comparison', {}).get('horizonMinutes', 240)}M"),
            ("pt.limit_street_time", f"PT{max_walk_seconds}S"),
            ("points_encoded", "false"),
        ]
    )
    return f"{base_url}/route?{query}"


def query() -> None:
    server = GraphHopperProcess()
    try:
        server.wait_ready()
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            started = time.perf_counter()
            try:
                http_error_status = None
                try:
                    with HTTP.open(route_url(server.base_url, request)) as response:
                        payload = json.loads(response.read())
                except urllib.error.HTTPError as error:
                    http_error_status = error.code
                    payload = json.loads(error.read() or b"{}")
                elapsed_ms = (time.perf_counter() - started) * 1000
                if not isinstance(payload, dict):
                    raise RuntimeError("GraphHopper returned a non-object response")
                message = error_text(payload)
                paths = payload.get("paths")
                if http_error_status or message or not isinstance(paths, list) or not paths:
                    if not message:
                        message = (f"GraphHopper returned HTTP {http_error_status}." if http_error_status
                                   else "GraphHopper returned no path." if paths == []
                                   else "GraphHopper response omitted a valid paths array.")
                    status = "error"
                    if http_error_status is None and paths == [] and not error_text(payload):
                        status = "blocked"
                    elif (http_error_status is None or 400 <= http_error_status < 500) and is_blocked_error(message):
                        status = "blocked"
                    emit(
                        {
                            "id": request.get("id"),
                            "status": status,
                            "queryMs": elapsed_ms,
                            "detail" if status == "blocked" else "error": message,
                            "plan": {
                                "status": status,
                                "diagnostics": {
                                    "algorithm": "GraphHopper public transit",
                                    "walkingNetwork": "osm",
                                    "tripBasedPreprocessing": False,
                                },
                            },
                        }
                    )
                    if server.process.poll() is not None:
                        break
                    continue
                path = paths[0]
                legs = path.get("legs") if isinstance(path.get("legs"), list) else []
                transit_legs = sum(
                    1
                    for leg in legs
                    if isinstance(leg, dict)
                    and str(leg.get("type", "")).lower() not in {"walk", "foot"}
                    and (leg.get("route_id") is not None or leg.get("trip_id") is not None)
                )
                duration_ms = path.get("time")
                if isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or not math.isfinite(duration_ms) or duration_ms < 0:
                    raise RuntimeError("GraphHopper path omitted numeric time")
                engine_ms = payload.get("info", {}).get("took") if isinstance(payload.get("info"), dict) else None
                violations = []
                if not legs:
                    raise RuntimeError("GraphHopper path omitted legs")
                if not transit_legs:
                    violations.append("transit_required")
                if path.get("transfers", max(0, transit_legs - 1)) > CONTEXT.get('comparison', {}).get('maxTransfers', 3):
                    violations.append("transfer_cap_exceeded")
                if duration_ms > CONTEXT.get('comparison', {}).get('horizonMinutes', 240) * 60000:
                    violations.append("horizon_exceeded")
                if violations:
                    emit({"id": request.get("id"), "status": "blocked", "queryMs": elapsed_ms,
                          "timing": {"engineQueryMs": engine_ms}, "rejectedItinerary": path,
                          "detail": "GraphHopper native candidate violates requested controls; alternatives were not searched.",
                          "plan": {"status": "blocked", "diagnostics": {"algorithm": "GraphHopper public transit", "walkingNetwork": "osm",
                              "outcomeReason": "native_candidate_rejected", "policyViolations": violations, "unreachabilityProven": False}}})
                    continue
                emit(
                    {
                        "id": request.get("id"),
                        "status": "ready",
                        "queryMs": elapsed_ms,
                        "timing": {"engineQueryMs": engine_ms},
                        "itinerary": path,
                        "plan": {
                            "status": "ready",
                            "durationMinutes": float(duration_ms) / 60_000,
                            "transfers": path.get("transfers", max(0, transit_legs - 1)),
                            "diagnostics": {
                                "algorithm": "GraphHopper public transit",
                                "walkingNetwork": "osm",
                                "transitLegs": transit_legs,
                                "tripBasedPreprocessing": False,
                            },
                        },
                    }
                )
            except Exception as error:
                emit(
                    {
                        "id": request.get("id"),
                        "status": "error",
                        "queryMs": (time.perf_counter() - started) * 1000,
                        "error": str(error),
                    }
                )
                if server.process.poll() is not None:
                    break
        if server.process.poll() is not None:
            raise RuntimeError(f"GraphHopper server exited with code {server.process.returncode}")
    finally:
        server.close()


def main() -> None:
    if not JAR.exists():
        raise RuntimeError(f"GraphHopper JAR is missing: {JAR}")
    phase = os.environ.get("VIGO_BENCH_PHASE", "")
    if phase == "prepare":
        prepare()
    elif phase == "query":
        query()
    else:
        raise RuntimeError("VIGO_BENCH_PHASE must be prepare or query")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
