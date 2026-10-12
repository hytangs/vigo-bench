"""Keep protocol/setup failures distinct from valid native no-itinerary replies."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock, patch


SCRIPTS = Path(__file__).parents[1] / "scripts"
REQUEST = {"id": "q1", "origin": {"coordinate": [-77, 38]},
           "destination": {"coordinate": [-77.1, 38.1]}}


class AdapterOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        context = Path(self.temporary.name) / "context.json"
        context.write_text(json.dumps({"serviceDate": "2025-06-29", "time": "08:00", "maxWalkKm": 1.2}))
        environment = dict(VIGO_BENCH_WORKDIR=self.temporary.name,
                           VIGO_BENCH_OSM_PBF="unused.pbf", VIGO_BENCH_GTFS_PATHS_JSON="[]",
                           VIGO_BENCH_CONTEXT=str(context), VIGO_BENCH_GRAPHHOPPER_JAR="unused.jar")
        self.environment = patch.dict(os.environ, environment)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def load(self, name):
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
        adapter = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", [str(SCRIPTS), *sys.path]):
            spec.loader.exec_module(adapter)
        return adapter

    def test_native_query_errors_retain_id_and_allow_next_query(self):
        adapter = self.load("native-engine-adapter")
        process = Mock()
        process.poll.return_value = None
        route = Mock(side_effect=[RuntimeError("HTTP 500: unavailable"), {"id": "q2", "status": "blocked"}])
        requests = "\n".join(json.dumps({**REQUEST, "id": id}) for id in ["q1", "q2"])
        with patch.object(adapter.sys, "stdin", io.StringIO(requests)), patch.object(adapter, "emit") as emit:
            adapter.serve_requests(route, process)
        first, second = [call.args[0] for call in emit.call_args_list]
        self.assertEqual((first["id"], first["status"]), ("q1", "error"))
        self.assertIn("HTTP 500", first["error"])
        self.assertGreaterEqual(first["queryMs"], 0)
        self.assertEqual(second, {"id": "q2", "status": "blocked"})

    def test_dead_native_server_ends_after_one_failed_request(self):
        adapter = self.load("native-engine-adapter")
        process = Mock(returncode=137)
        process.poll.return_value = 137
        route = Mock(side_effect=ConnectionResetError("server stopped"))
        requests = json.dumps(REQUEST) + "\n" + json.dumps({**REQUEST, "id": "q2"})
        with patch.object(adapter.sys, "stdin", io.StringIO(requests)), patch.object(adapter, "emit") as emit:
            with self.assertRaisesRegex(RuntimeError, "exited with code 137"):
                adapter.serve_requests(route, process)
        self.assertEqual(route.call_count, 1)
        self.assertEqual(emit.call_args.args[0]["status"], "error")

    def test_motis_requires_a_valid_itinerary_container(self):
        adapter = self.load("native-engine-adapter")
        for payload in [{}, [], {"itineraries": None}, {"itineraries": [None]}]:
            with self.subTest(payload=payload), patch.object(adapter, "http_json", return_value=payload):
                with self.assertRaisesRegex(RuntimeError, "MOTIS response"):
                    adapter.motis_query(REQUEST, "http://unused")
        with patch.object(adapter, "http_json", return_value={"itineraries": []}):
            self.assertEqual(adapter.motis_query(REQUEST, "http://unused")["status"], "blocked")

    def test_motis_rejects_impossible_walk_even_with_minute_precision(self):
        adapter = self.load("native-engine-adapter")
        itinerary = {"transfers": 0, "legs": [
            {"mode": "WALK", "distance": 346, "startTime": "2026-07-14T08:01:00Z", "endTime": "2026-07-14T08:03:00Z"},
            {"mode": "BUS"}]}
        self.assertEqual(adapter.motis_policy_violations(itinerary, 30), ['walk_faster_than_common_speed'])
        itinerary['legs'][0]['distance'] = 230
        self.assertEqual(adapter.motis_policy_violations(itinerary, 30), [])

    def test_motis_point_query_selects_earliest_policy_passing_alternative(self):
        adapter = self.load("native-engine-adapter")
        rejected = {"endTime": "2025-06-29T08:20:00+00:00", "transfers": 0, "legs": [
            {"mode": "WALK", "distance": 1000, "startTime": "2025-06-29T08:00:00+00:00", "endTime": "2025-06-29T08:01:00+00:00"},
            {"mode": "BUS"}]}
        valid = {"endTime": "2025-06-29T08:30:00+00:00", "transfers": 0, "legs": [{"mode": "BUS"}]}
        slower = {**valid, "endTime": "2025-06-29T08:40:00+00:00"}
        with patch.object(adapter, "local_departure", return_value="2025-06-29T08:00:00+00:00"), \
             patch.object(adapter, "http_json", return_value={"itineraries": [slower, rejected, valid]}) as http:
            result = adapter.motis_query(REQUEST, "http://unused")
        query = urllib.parse.parse_qs(urllib.parse.urlparse(http.call_args.args[0]).query)
        self.assertEqual(query['timetableView'], ['false'])
        self.assertEqual(query['arriveBy'], ['false'])
        self.assertEqual(http.call_count, 1)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['itinerary'], valid)
        self.assertEqual(result['plan']['durationMinutes'], 30)
        diagnostics = result['plan']['diagnostics']
        self.assertEqual(diagnostics['selectedNativeIndex'], 2)
        self.assertEqual(diagnostics['policyPassingCandidateCount'], 2)
        self.assertEqual(diagnostics['nativeCandidateRejections'][0]['nativeIndex'], 1)

    def test_motis_does_not_accept_unresolved_walking_placeholders(self):
        adapter = self.load("native-engine-adapter")
        base = {"mode": "WALK", "distance": 0, "startTime": "2025-06-29T08:00:00Z", "endTime": "2025-06-29T08:01:00Z"}
        for walk in [{**base, "distance": None}, {**base, "cancelled": True},
                     {**base, "from": {"cancelled": True}}, {**base, "to": {"cancelled": True}}]:
            with self.subTest(walk=walk):
                self.assertIn('walk_path_unresolved', adapter.motis_policy_violations(
                    {"transfers": 0, "legs": [walk, {"mode": "BUS"}]}, 30))
        self.assertEqual(adapter.motis_policy_violations(
            {"transfers": 0, "legs": [base, {"mode": "BUS"}]}, 30), [])

    def test_motis_all_rejected_is_not_a_no_path_proof(self):
        adapter = self.load("native-engine-adapter")
        itinerary = {"endTime": "2025-06-29T08:20:00+00:00", "transfers": 0,
                     "legs": [{"mode": "WALK", "cancelled": True}, {"mode": "BUS"}]}
        with patch.object(adapter, "local_departure", return_value="2025-06-29T08:00:00+00:00"), \
             patch.object(adapter, "http_json", return_value={"itineraries": [itinerary]}):
            result = adapter.motis_query(REQUEST, "http://unused")
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['rejectedItinerary'], itinerary)
        self.assertEqual(result['plan']['diagnostics']['outcomeReason'], 'native_candidate_rejected')
        self.assertFalse(result['plan']['diagnostics']['unreachabilityProven'])
        self.assertEqual(result['plan']['diagnostics']['policyPassingCandidateCount'], 0)

    def test_motis_arrival_order_uses_instants_and_duration_includes_initial_wait(self):
        adapter = self.load("native-engine-adapter")
        later = {"endTime": "2025-06-29T08:30:00-04:00", "transfers": 0, "legs": [{"mode": "BUS"}]}
        earlier = {"startTime": "2025-06-29T12:15:00Z", "endTime": "2025-06-29T12:20:00Z", "transfers": 0, "legs": [{"mode": "BUS"}]}
        with patch.object(adapter, "local_departure", return_value="2025-06-29T08:00:00-04:00"), \
             patch.object(adapter, "http_json", return_value={"itineraries": [later, earlier]}):
            result = adapter.motis_query(REQUEST, "http://unused")
        self.assertEqual(result['itinerary'], earlier)
        self.assertEqual(result['plan']['durationMinutes'], 20)

    def test_motis_dynamic_port_matches_readiness_and_query_without_mutating_retained_data(self):
        adapter = self.load("native-engine-adapter")
        data = Path(self.temporary.name) / "data"
        data.mkdir()
        original = 'timetable:\n  first_day: 2025-06-29\nserver:\n  host: "0.0.0.0"\n  port: 8080\n  n_threads: 3\nlogging:\n  log_level: error\n'
        (data / "config.yml").write_text(original)
        (data / "graph.bin").write_bytes(b"retained graph")
        child = Mock()
        child.poll.return_value = None
        launched = []
        def launch(command, **kwargs):
            view = Path(command[command.index("-d") + 1])
            launched.append(view)
            self.assertNotEqual(view, data)
            config = (view / "config.yml").read_text()
            self.assertIn('  host: "127.0.0.1"', config)
            self.assertIn('  port: 43125', config)
            self.assertIn('  n_threads: 3', config)
            self.assertIn('logging:\n  log_level: error', config)
            self.assertNotIn('8080', config)
            self.assertEqual((view / "graph.bin").resolve(), (data / "graph.bin").resolve())
            return child
        with patch.dict(os.environ, {"VIGO_BENCH_MOTIS_BINARY": "/unused/motis"}), \
             patch.object(adapter, "free_port", return_value=43125), \
             patch.object(adapter.subprocess, "Popen", side_effect=launch), \
             patch.object(adapter, "wait_http") as ready, \
             patch.object(adapter, "motis_query", return_value={"id": "q1", "status": "blocked"}) as route, \
             patch.object(adapter, "stop_process") as stop, \
             patch.object(adapter, "emit"), \
             patch.object(adapter.sys, "stdin", io.StringIO(json.dumps(REQUEST))):
            adapter.query_motis()
        ready.assert_called_once_with("http://127.0.0.1:43125/api/v1/health", child)
        route.assert_called_once_with(REQUEST, "http://127.0.0.1:43125")
        stop.assert_called_once_with(child)
        self.assertEqual((data / "config.yml").read_text(), original)
        self.assertEqual((data / "graph.bin").read_bytes(), b"retained graph")
        self.assertFalse(launched[0].exists())

    def test_motis_generated_config_without_server_gains_only_binding(self):
        adapter = self.load("native-engine-adapter")
        self.assertEqual(adapter.motis_server_config("street_routing: true\n", 43126),
                         'street_routing: true\nserver:\n  host: "127.0.0.1"\n  port: 43126\n')

    def test_otp_requires_edges_but_empty_edges_are_valid_blocked(self):
        adapter = self.load("native-engine-adapter")
        for payload in [{}, [], {"data": None}, {"data": {"planConnection": {"edges": [None]}}}]:
            with self.subTest(payload=payload), patch.object(adapter, "http_json", return_value=payload):
                with self.assertRaisesRegex(RuntimeError, "OTP"):
                    adapter.otp_query(REQUEST, "http://unused")
        with patch.object(adapter, "http_json", return_value={"data": {"planConnection": {"edges": []}}}):
            self.assertEqual(adapter.otp_query(REQUEST, "http://unused")["status"], "blocked")

    def test_candidate_limit_validation_and_native_parameters(self):
        adapter = self.load('native-engine-adapter')
        adapter.CONTEXT['comparison'] = {'maxTransfers': 3, 'horizonMinutes': 240, 'walkSpeedKph': 4.8, 'candidateLimit': 5}
        with patch.object(adapter, 'http_json', return_value={'itineraries': []}) as http:
            adapter.motis_query(REQUEST, 'http://unused')
        params = urllib.parse.parse_qs(urllib.parse.urlparse(http.call_args.args[0]).query)
        self.assertEqual(params['numItineraries'], ['5'])
        for invalid in [0, 21, True, 2.5, '5']:
            adapter.CONTEXT['comparison']['candidateLimit'] = invalid
            with self.assertRaises(ValueError):
                adapter.motis_query(REQUEST, 'http://unused')

    def test_otp_selects_later_compliant_candidate_and_retains_rejection(self):
        adapter = self.load('native-engine-adapter')
        adapter.CONTEXT['comparison'] = {'maxTransfers': 1, 'horizonMinutes': 240, 'walkSpeedKph': 4.8, 'candidateLimit': 5}
        bad = {'end': '2025-06-29T08:05:00+00:00', 'numberOfTransfers': 2, 'legs': [{'mode': 'BUS'}]}
        good = {'end': '2025-06-29T08:10:00+00:00', 'numberOfTransfers': 1, 'legs': [{'mode': 'BUS'}]}
        with patch.object(adapter, 'local_departure', return_value='2025-06-29T08:00:00+00:00'), \
             patch.object(adapter, 'http_json', return_value={'data': {'planConnection': {'edges': [{'node': bad}, {'node': good}]}}}) as http:
            result = adapter.otp_query(REQUEST, 'http://unused')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['itinerary'], good)
        self.assertIn('first: 5', http.call_args.kwargs['body']['query'])
        diagnostics = result['plan']['diagnostics']
        self.assertEqual(diagnostics['selectedNativeIndex'], 1)
        self.assertEqual(diagnostics['nativeCandidateRejections'][0]['policyViolations'], ['transfer_cap_exceeded'])

    def test_graphhopper_selects_compliant_alternative(self):
        adapter = self.load('graphhopper-engine-adapter')
        adapter.CONTEXT['comparison'] = {'candidateLimit': 5, 'maxTransfers': 1}
        bad = {'time': 1000, 'legs': [{'type': 'walk', 'distance': 1}]}
        good = {'time': 2000, 'legs': [{'type': 'pt', 'trip_id': 'fixture'}], 'transfers': 0}
        row = self.graphhopper_query(adapter, [{'paths': [bad, good]}])[0]
        self.assertEqual(row['status'], 'ready')
        self.assertEqual(row['itinerary'], good)
        self.assertEqual(row['plan']['diagnostics']['selectedNativeIndex'], 1)
        params = urllib.parse.parse_qs(urllib.parse.urlparse(adapter.route_url('http://unused', REQUEST)).query)
        self.assertEqual(params['pt.limit_solutions'], ['5'])

    def test_valhalla_protocol_errors_differ_from_native_no_path(self):
        adapter = self.load("native-engine-adapter")
        actor = Mock()
        with patch.object(adapter, "native_stdout", side_effect=lambda call: call()):
            for payload in [{}, {"trip": {"summary": {"time": float("nan")}}}]:
                actor.route.return_value = payload
                with self.subTest(payload=payload), self.assertRaisesRegex(RuntimeError, "Valhalla response"):
                    adapter.valhalla_query(REQUEST, actor)
            actor.route.side_effect = RuntimeError("No path could be found")
            self.assertEqual(adapter.valhalla_query(REQUEST, actor)["status"], "blocked")

    def test_otp_rejects_transit_beyond_requested_horizon(self):
        adapter = self.load("native-engine-adapter")
        itinerary = {"end": "2025-06-29T13:00:00+00:00", "legs": [{"mode": "BUS"}]}
        with patch.object(adapter, "local_departure", return_value="2025-06-29T08:00:00+00:00"), \
             patch.object(adapter, "http_json", return_value={"data": {"planConnection": {"edges": [{"node": itinerary}]}}}):
            result = adapter.otp_query(REQUEST, 'http://unused')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['rejectedItinerary'], itinerary)

    def test_valhalla_rejects_out_of_contract_candidates_and_retains_evidence(self):
        adapter = self.load("native-engine-adapter")
        actor = Mock()
        walk = lambda km: {"travel_mode": "pedestrian", "length": km}
        ride = {"travel_mode": "transit", "length": 5}
        cases = [([walk(.1)], 100, ["transit_required"]),
                 ([walk(1.3), ride, walk(.1)], 1500, ["access_walk_budget_exceeded"]),
                 ([walk(.1), ride, walk(1.3)], 1500, ["egress_walk_budget_exceeded"]),
                 ([walk(.1), *[ride] * 5, walk(.1)], 1500, ["transfer_cap_exceeded"]),
                 ([walk(.1), ride, walk(.1)], 14401, ["horizon_exceeded"]),
                 ([walk(1.2), ride, walk(1.2)], 1500, [])]
        for maneuvers, duration, violations in cases:
            trip = {"summary": {"time": duration}, "legs": [{"maneuvers": maneuvers}]}
            actor.route.return_value = {"trip": trip}
            with self.subTest(violations=violations), patch.object(adapter, "native_stdout", side_effect=lambda call: call()):
                result = adapter.valhalla_query(REQUEST, actor)
            self.assertEqual(result["status"], "blocked" if violations else "ready")
            if violations:
                self.assertEqual(result["rejectedItinerary"], trip)
                self.assertEqual(result["plan"]["diagnostics"]["policyViolations"], violations)
                self.assertFalse(result["plan"]["diagnostics"]["unreachabilityProven"])

    def graphhopper_query(self, adapter, replies):
        server = Mock(base_url="http://unused")
        server.process.poll.return_value = None
        requests = "\n".join(json.dumps({**REQUEST, "id": f"q{i}"}) for i in range(len(replies)))
        responses = [reply if isinstance(reply, Exception) else io.BytesIO(json.dumps(reply).encode()) for reply in replies]
        with patch.object(adapter, "GraphHopperProcess", return_value=server), \
             patch.object(adapter.sys, "stdin", io.StringIO(requests)), \
             patch.object(adapter.HTTP, "open", side_effect=responses), \
             patch.object(adapter, "emit") as emit:
            adapter.query()
        server.close.assert_called_once()
        return [call.args[0] for call in emit.call_args_list]

    def test_graphhopper_errors_do_not_become_blocked_when_paths_are_missing(self):
        adapter = self.load("graphhopper-engine-adapter")
        cases = [
            (200, {}, "error"),
            (200, [], "error"),
            (200, {"paths": []}, "blocked"),
            (200, {"message": "Unsupported profile", "paths": []}, "error"),
            (400, {"message": "Connection not found"}, "blocked"),
            (400, {"message": "Unsupported profile"}, "error"),
            (500, {"message": "Connection not found"}, "error"),
            (503, {}, "error"),
        ]
        for code, payload, expected in cases:
            reply = payload if code == 200 else urllib.error.HTTPError(
                "http://unused", code, "failure", {}, io.BytesIO(json.dumps(payload).encode()))
            with self.subTest(code=code, payload=payload):
                observation = self.graphhopper_query(adapter, [reply])[0]
                self.assertEqual(observation["status"], expected)

    def test_graphhopper_recovers_after_request_failure(self):
        adapter = self.load("graphhopper-engine-adapter")
        observations = self.graphhopper_query(adapter, [ConnectionResetError("reset"), {"paths": []}])
        self.assertEqual([row["status"] for row in observations], ["error", "blocked"])
        self.assertEqual([row["id"] for row in observations], ["q0", "q1"])

    def test_graphhopper_sends_common_walk_speed_and_budget(self):
        adapter = self.load("graphhopper-engine-adapter")
        params = urllib.parse.parse_qs(urllib.parse.urlparse(adapter.route_url('http://unused', REQUEST)).query)
        self.assertEqual(params['pt.walk_speed'], ['4.8'])
        self.assertEqual(params['pt.limit_street_time'], ['PT900S'])

    def test_graphhopper_rejects_walk_only_and_retains_candidate(self):
        adapter = self.load("graphhopper-engine-adapter")
        candidate = {"time": 1000, "legs": [{"type": "walk", "distance": 1}]}
        row = self.graphhopper_query(adapter, [{"paths": [candidate]}])[0]
        self.assertEqual(row['status'], 'blocked')
        self.assertEqual(row['rejectedItinerary'], candidate)
        self.assertEqual(row['plan']['diagnostics']['policyViolations'], ['transit_required'])

    def test_graphhopper_invalid_numeric_duration_is_a_protocol_error(self):
        adapter = self.load("graphhopper-engine-adapter")
        for duration in [float("nan"), -1, True]:
            with self.subTest(duration=duration):
                observation = self.graphhopper_query(adapter, [{"paths": [{"time": duration}]}])[0]
                self.assertEqual(observation["status"], "error")


if __name__ == "__main__":
    unittest.main()
