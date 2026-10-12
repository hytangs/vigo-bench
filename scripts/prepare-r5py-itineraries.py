#!/usr/bin/env python3
"""Prepare a local r5py 1.0.7 copy for single earliest-arrival itineraries.

Preserves the installed package. The written source diff is part of benchmark
provenance; R5's native routing and transfer model are unchanged.
"""
import argparse
import difflib
import importlib.metadata
import importlib.util
from pathlib import Path
import shutil


def corrected_source(source):
    replacements = [
        ("suboptimal_minutes = max(self.request._regional_task.suboptimalMinutes, 0)",
         "request._regional_task.suboptimalMinutes = 0\n"
         "            suboptimal_minutes = 0  # Single earliest-arrival benchmark; no extra path-diversity window."),
        ("for state in list(states)  # some departure times yield no results",
         "for state in ([min(states, key=lambda candidate: int(candidate.time))] if states else [])"),
        ("\n                                + ONE_MINUTE\n", "\n"),
        ("\n                                    + ONE_MINUTE\n", "\n"),
        ("\n                                    + ONE_MINUTE  # the slack added above\n", "\n"),
        ("                    # R5 sometimes reports the same path more than once, skip duplicates",
         "                    # Waiting is the gap between the reconstructed leg clocks.\n"
         "                    previous_arrival = self.request.departure\n"
         "                    for leg in trip.legs:\n"
         "                        leg.wait_time = leg.departure_time - previous_arrival\n"
         "                        previous_arrival = leg.departure_time + leg.travel_time\n\n"
         "                    # R5 sometimes reports the same path more than once, skip duplicates"),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise RuntimeError(f"Pinned r5py source does not match the correction: {old!r}")
        source = source.replace(old, new)
    original = '''        EQUIDISTANT_CRS = GoodEnoughEquidistantCrs(self.transport_network.extent)
        self._crs_transformer_function = pyproj.Transformer.from_crs(
            R5_CRS,
            EQUIDISTANT_CRS,
            always_xy=True,
        ).transform'''
    replacement = '''        if not hasattr(self.transport_network, "_itinerary_crs_transformer"):
            crs = GoodEnoughEquidistantCrs(self.transport_network.extent)
            self.transport_network._itinerary_crs_transformer = pyproj.Transformer.from_crs(
                R5_CRS, crs, always_xy=True,
            ).transform
        self._crs_transformer_function = self.transport_network._itinerary_crs_transformer'''
    assert source.count(original) == 1
    source = source.replace(original, replacement)
    source = source.replace('class TripPlanner:', '''class _DeferredStreetLeg:
    """Use the native state cost; reconstruct only a selected endpoint leg."""

    def __init__(self, planner, state, mode, leg_type):
        self.planner, self.state, self.mode, self.leg_type = planner, state, mode, leg_type
        self.travel_time = datetime.timedelta(seconds=state.getDurationSeconds())

    def __lt__(self, other):
        return self.travel_time < other.travel_time

    def materialize(self):
        segment = self.planner._street_segment_from_router_state(self.state, self.mode)
        return self.leg_type(self.mode, segment)


class TripPlanner:''')
    for direction, leg_type in [('access', 'AccessLeg'), ('egress', 'EgressLeg')]:
        original = f'''                street_segment = self._street_segment_from_router_state(
                    router_state,
                    transport_mode,
                )
                {direction}_paths[transport_mode][stop] = {leg_type}(
                    transport_mode, street_segment
                )'''
        replacement = f'''                {direction}_paths[transport_mode][stop] = _DeferredStreetLeg(
                    self, router_state, transport_mode, {leg_type}
                )'''
        assert source.count(original) == 1
        source = source.replace(original, replacement)
        original = f'''                                        for transport_mode in self._transit_{direction}_paths.keys()
                                    ]
                                )'''
        assert source.count(original) == 1
        source = source.replace(original, original[:-1] + ').materialize()')
    start = source.index('                # McRapterSuboptimalPathProfileRouter needs this simple callback,')
    end = source.index('                transit_router = (', start)
    source = source[:start] + source[end:]
    source = source.replace('                        list_supplier_callback,',
        '                        com.conveyal.r5.profile.McRaptorSuboptimalPathProfileRouter.createSuboptimalListSupplier(suboptimal_minutes),')
    start = source.index('    def _transit_transfer_path(self, from_stop, to_stop):')
    source = source[:start] + '    def _transit_transfer_path(self, from_stop, to_stop):\n        """Reconstruct the vertex/distance transfer used by native McRAPTOR."""\n        layer = self.transport_network.transit_layer._transit_layer\n        source_vertex = int(layer.streetVertexForStop.get(from_stop))\n        target_vertex = int(layer.streetVertexForStop.get(to_stop))\n        transfers = layer.transfersForStop.get(from_stop)\n        distance = next(\n            int(transfers.get(i + 1)) for i in range(0, transfers.size(), 2)\n            if int(transfers.get(i)) == to_stop\n        )\n        router = com.conveyal.r5.streets.StreetRouter(self.transport_network.street_layer)\n        router.quantityToMinimize = com.conveyal.r5.streets.StreetRouter.State.RoutingVariable.DISTANCE_MILLIMETERS\n        router.distanceLimitMeters = com.conveyal.r5.transit.TransitLayer.TRANSFER_DISTANCE_LIMIT_METERS\n        router.setOrigin(source_vertex)\n        router.toVertex = target_vertex\n        router.route()\n        state = router.getStateAtVertex(target_vertex)\n        if state is None or int(state.distance) != distance:\n            raise RuntimeError("Transfer geometry does not match the native transfer distance")\n        segment = self._street_segment_from_router_state(state, TransportMode.WALK)\n        leg = TransferLeg(TransportMode.WALK, segment)\n        # McRAPTOR divides the compiled millimetre distance by requested speed,\n        # rather than using the street router\'s separately accumulated duration.\n        leg.travel_time = datetime.timedelta(\n            seconds=int(distance / (float(self.request._regional_task.walkSpeed) * 1000))\n        )\n        return leg\n'
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if importlib.metadata.version('r5py') != '1.0.7':
        parser.error('This source correction is reviewed against r5py 1.0.7.')
    if args.output.exists():
        parser.error('Use a fresh output directory; existing source is preserved.')
    package = Path(importlib.util.find_spec('r5py').origin).parent
    before = (package / 'r5/trip_planner.py').read_text()
    after = corrected_source(before)
    compile(after, 'trip_planner.py', 'exec')
    shutil.copytree(package, args.output / 'r5py', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    (args.output / 'r5py/r5/trip_planner.py').write_text(after)
    (args.output / 'r5py/_benchmark_itinerary_patch.py').write_text(
        "UPSTREAM_VERSION = '1.0.7'\n"
        "PATCH = 'earliest-native-transfer-itineraries-v5'\n"
        "SUBOPTIMAL_MINUTES = 0\n")
    diff = ''.join(difflib.unified_diff(
        before.splitlines(True), after.splitlines(True),
        fromfile='r5py-1.0.7/r5/trip_planner.py', tofile='r5py-corrected/r5/trip_planner.py'))
    path = Path('r5/detailed_itineraries.py')
    before = (package/path).read_text()
    assert before.count('n_jobs=self.NUM_THREADS,') == 1
    after = before.replace('n_jobs=self.NUM_THREADS,', 'n_jobs=min(self.NUM_THREADS, max(1, len(self.od_pairs))),')
    (args.output/'r5py'/path).write_text(after)
    diff += ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
        fromfile=f'r5py-1.0.7/{path}', tofile=f'r5py-corrected/{path}'))
    (args.output / 'itinerary.patch').write_text(diff)
    print(args.output.resolve())


if __name__ == '__main__':
    main()
