#!/usr/bin/env python3
"""Check returned walking geometry against the original OSM highway corridors.

This is an independent geometric check, not a topological/legal path oracle.
Three-metre buffers accommodate coordinate rounding. Snap connectors, barriers,
conditional access and unmapped station paths require separate interpretation.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

import pyproj
from shapely.geometry import LineString, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

spec = importlib.util.spec_from_file_location('itineraries', Path(__file__).with_name('audit-itineraries.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    summary = json.loads((args.run / 'summary.json').read_text())
    for city in summary['cities']:
        directory = args.run / city['citySlug']
        context = json.loads((directory / 'context.json').read_text())
        schedule = audit.Schedule(context['gtfs'], context['serviceDate'])
        first = next(iter(schedule.stops.values()))
        crs = f"+proj=aeqd +lat_0={first['stop_lat']} +lon_0={first['stop_lon']} +datum=WGS84 +units=m"
        project = pyproj.Transformer.from_crs('EPSG:4326', crs, always_xy=True).transform
        roads, restricted = [], []
        with tempfile.TemporaryDirectory(prefix='osm-walk-audit-') as temporary:
            export = Path(temporary) / 'roads.geojsonseq'
            subprocess.run(['osmium', 'export', context['osm'], '--geometry-types=linestring', '-f', 'geojsonseq', '-o', str(export)], check=True)
            for line in export.open():
                feature = json.loads(line.lstrip('\x1e'))
                tags = feature['properties']
                if 'highway' not in tags:
                    continue
                explicit_foot = tags.get('foot') in {'yes', 'designated', 'permissive'}
                denied = tags.get('foot') in {'no', 'private'} or (
                    not explicit_foot and (tags.get('access') in {'no', 'private'} or tags['highway'] in {'motorway', 'motorway_link'}))
                corridor = transform(project, shape(feature['geometry'])).buffer(3)
                (restricted if denied else roads).append(corridor)
        trees = [STRtree(roads), STRtree(restricted)]
        totals = []
        for engine in city['engines']:
            source = directory / engine['engine'].lower() / 'queries.ndjson'
            if not source.exists():
                continue
            counts, results = Counter(), []
            for line in source.open():
                row = json.loads(line)
                if row['status'] != 'ready':
                    continue
                unmatched = restricted_length = total = 0.0
                missing = 0
                for leg in audit.normalize(engine['engine'], row['itinerary'], schedule):
                    if leg['mode'] != 'walk':
                        continue
                    if len(leg['coordinates']) < 2:
                        missing += 1
                        continue
                    geometry = transform(project, LineString(leg['coordinates']))
                    total += geometry.length
                    allowed = trees[0].query(geometry, predicate='intersects')
                    uncovered = geometry.difference(unary_union([roads[int(i)] for i in allowed]))
                    denied = trees[1].query(uncovered, predicate='intersects')
                    restricted_length += uncovered.intersection(unary_union([restricted[int(i)] for i in denied])).length
                    unmatched += uncovered.length
                status = 'corridor_match' if unmatched <= 5 and not missing else 'review_needed'
                counts[status] += 1
                results.append(dict(id=row['id'], odId=row['odId'], status=status, walkingGeometryMeters=total,
                                    outsidePublicCorridorMeters=unmatched, nearRestrictedWaysMeters=restricted_length,
                                    missingWalkingGeometries=missing))
            (source.parent / 'osm-quality.ndjson').write_text(''.join(json.dumps(r) + '\n' for r in results))
            totals.append(dict(engine=engine['engine'], counts=dict(counts)))
        (directory / 'osm-quality-summary.json').write_text(json.dumps({'method': __doc__, 'engines': totals}, indent=2) + '\n')
        print(json.dumps(totals))


if __name__ == '__main__':
    main()
