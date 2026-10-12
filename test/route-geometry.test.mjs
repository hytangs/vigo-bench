import assert from 'node:assert/strict';
import test from 'node:test';
import { observationGeometry } from '../dashboard/route-geometry.js';

// Synthetic coordinates only; no private benchmark inputs are embedded here.
const a = [-70, 40], b = [-70.001, 40.002], c = [-70.004, 40.005];
const encode = (points, precision) => {
  let lat = 0, lon = 0;
  const integer = (value) => {
    let shifted = value < 0 ? -value * 2 - 1 : value * 2, text = '';
    while (shifted >= 32) { text += String.fromCharCode((shifted % 32) + 95); shifted = Math.floor(shifted / 32); }
    return text + String.fromCharCode(shifted + 63);
  };
  return points.map(([x, y]) => {
    const nextLat = Math.round(y * 10 ** precision), nextLon = Math.round(x * 10 ** precision);
    const result = integer(nextLat - lat) + integer(nextLon - lon);
    lat = nextLat; lon = nextLon;
    return result;
  }).join('');
};
const observation = (legs, rest = {}) => ({ origin: { coordinate: a }, destination: { coordinate: c }, itinerary: { legs, ...rest } });

test('VIGO and VIGO-py keep walk and ride coordinates in longitude-latitude order', () => {
  for (const engine of ['VIGO', 'VIGO-py']) {
    const result = observationGeometry({ ...observation([
      { type: 'walk', coordinates: [a, b] }, { type: 'ride', routeShortName: '12', coordinates: [b, c], geometrySource: 'shape' },
    ]), engine });
    assert.deepEqual(result.segments.map(segment => segment.mode), ['walk', 'transit']);
    assert.deepEqual(result.segments[0].coordinates, [a, b]);
    assert.match(result.segments[1].label, /12/);
    assert.deepEqual([result.origin, result.destination], [a, c]);
    assert.deepEqual(result.warnings, []);
  }
});

test('MOTIS obeys explicit polyline6 while OTP defaults to polyline5', () => {
  for (const precision of [5, 6]) {
    const legGeometry = { points: encode([a, b, c], precision), ...(precision === 6 ? { precision } : {}) };
    const result = observationGeometry(observation([{ mode: 'BUS', route: { shortName: '8' }, legGeometry }]));
    assert.deepEqual(result.segments[0].coordinates, [a, b, c]);
    assert.equal(result.segments[0].mode, 'transit');
  }
});

test('well-known polyline vector decodes without coordinate swapping', () => {
  const result = observationGeometry(observation([{ mode: 'WALK', legGeometry: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }]));
  assert.deepEqual(result.segments[0].coordinates, [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
});

test('valid polylines beginning with a brace are not mistaken for JSON', () => {
  const coordinates = [[-70, 40.000014], b];
  const points = encode(coordinates, 6);
  assert.equal(points[0], '{');
  const result = observationGeometry(observation([{ mode: 'BUS', legGeometry: { points, precision: 6 } }]));
  assert.deepEqual(result.segments[0].coordinates, coordinates);
});

test('R5 and R5py GeoJSON multipart records remain separate', () => {
  for (const engine of ['R5', 'R5py']) {
    const result = observationGeometry({ engine, ...observation([{ transport_mode: 'RAIL', route_id: 'R', geometry: {
      type: 'MultiLineString', coordinates: [[a, b], [[-60, 30], [-61, 31]]],
    } }]) });
    assert.equal(result.segments.length, 2);
    assert.deepEqual(result.segments[0].coordinates, [a, b]);
    assert.deepEqual(result.segments[1].coordinates, [[-60, 30], [-61, 31]]);
    assert.equal(result.segments[0].mode, 'transit');
  }
});

test('historical WKT supports LineString, multipart and Z without joining parts', () => {
  const result = observationGeometry(observation([
    { transport_mode: 'WALK', geometry: 'LINESTRING Z (-70 40 3, -70.001 40.002 4)' },
    { transport_mode: 'BUS', geometry: 'SRID=4326;MULTILINESTRING ((-70 40, -70.001 40.002), (-60 30, -61 31))' },
  ]));
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments[0].coordinates, [a, b]);
  assert.deepEqual(result.segments[2].coordinates, [[-60, 30], [-61, 31]]);
  assert.equal(observationGeometry(observation([{ geometry: 'SRID=3857;LINESTRING (1 2, 3 4)' }])).segments.length, 0);
});

test('GraphHopper leg GeoJSON takes priority over whole-route points', () => {
  const result = observationGeometry(observation([
    { type: 'walk', geometry: { type: 'LineString', coordinates: [a, b] } },
    { type: 'pt', route_id: 'G', geometry: { type: 'LineString', coordinates: [b, c] } },
  ], { points: { type: 'LineString', coordinates: [a, b, c] } }));
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments.map(segment => segment.mode), ['walk', 'transit']);
});

test('whole-route GraphHopper fallback retains shape with unknown mode', () => {
  const result = observationGeometry(observation([], { points: { type: 'LineString', coordinates: [a, b, c] } }));
  assert.deepEqual(result.segments[0].coordinates, [a, b, c]);
  assert.equal(result.segments[0].mode, 'other');
  assert.ok(result.warnings.some(warning => warning.includes('whole-route')));
});

test('GraphHopper transit shapes matching retained stop sequences are coarse', () => {
  const result = observationGeometry(observation([{ type: 'pt', geometry: { type: 'LineString', coordinates: [a, b, c] },
    stops: [a, b, c].map(coordinates => ({ geometry: { type: 'Point', coordinates } })),
  }]));
  assert.equal(result.segments[0].geometryQuality, 'coarse');
  assert.match(result.segments[0].label, /stop chords/);
});

test('Valhalla decodes polyline6 and applies native maneuver shape indexes', () => {
  const result = observationGeometry(observation([{ shape: encode([a, b, c], 6), maneuvers: [
    { begin_shape_index: 0, end_shape_index: 1, travel_mode: 'pedestrian' },
    { begin_shape_index: 1, end_shape_index: 2, travel_mode: 'transit', transit_info: { short_name: 'V' } },
  ] }]));
  assert.deepEqual(result.segments.map(segment => segment.mode), ['walk', 'transit']);
  assert.deepEqual(result.segments.map(segment => segment.coordinates), [[a, b], [b, c]]);
  assert.match(result.segments[1].label, /V/);
});

test('Valhalla uncovered edges remain native geometry with unknown mode', () => {
  const result = observationGeometry(observation([{ shape: encode([a, b, c], 6), maneuvers: [
    { begin_shape_index: 0, end_shape_index: 1, travel_mode: 'pedestrian' },
    { begin_shape_index: 1, end_shape_index: 200, travel_mode: 'transit' },
  ] }]));
  assert.deepEqual(result.segments.map(segment => segment.mode), ['walk', 'other']);
  assert.deepEqual(result.segments[1].coordinates, [b, c]);
  assert.ok(result.warnings.some(warning => warning.includes('invalid')));
});

test('ULTRA and VIGO stop-chord metadata is visibly coarse', () => {
  const ultra = observationGeometry(observation([{ mode: 'ride', coordinates: [a, c] }], { transitGeometry: 'stop chords' }));
  const vigo = observationGeometry(observation([{ type: 'ride', coordinates: [a, c], geometrySource: 'stop_sequence' }]));
  for (const result of [ultra, vigo]) {
    assert.equal(result.segments[0].geometryQuality, 'coarse');
    assert.match(result.segments[0].label, /stop chords/);
    assert.ok(result.warnings.some(warning => warning.includes('stop-to-stop')));
  }
});

test('invalid coordinates split retained lines rather than bridging gaps', () => {
  const result = observationGeometry(observation([{ type: 'walk', coordinates: [a, b, [null, 1], b, c, [181, 0], [0, 91], ['1', 2], [Infinity, 1]] }]));
  assert.deepEqual(result.segments.map(segment => segment.coordinates), [[a, b], [b, c]]);
  assert.ok(result.warnings.some(warning => warning.includes('gaps are not connected')));
});

test('missing geometry never creates straight lines between requested endpoints', () => {
  const result = observationGeometry(observation([{ mode: 'BUS', from: { lon: a[0], lat: a[1] }, to: { lon: c[0], lat: c[1] } }]));
  assert.deepEqual(result.segments, []);
  assert.deepEqual([result.origin, result.destination], [a, c]);
  assert.ok(result.warnings.some(warning => warning.includes('do not imply a route')));
});

test('malformed encoded geometry and unsupported geometry fail without throwing', () => {
  for (const geometry of ['_', '~'.repeat(80), { type: 'Polygon', coordinates: [[a, b, c, a]] }, { points: '??', precision: -1 }]) {
    assert.equal(observationGeometry(observation([{ geometry }])).segments.length, 0);
  }
  assert.deepEqual(observationGeometry(null).segments, []);
  assert.deepEqual(observationGeometry({ itinerary: { locations: {}, legs: [null] } }).segments, []);
});

test('native endpoint fallback is explicit and does not infer query points from shapes', () => {
  const result = observationGeometry({ itinerary: { locations: [{ lon: a[0], lat: a[1], original_index: 0 }, { lon: c[0], lat: c[1], original_index: 1 }] } });
  assert.deepEqual([result.origin, result.destination], [a, c]);
  assert.ok(result.warnings.some(warning => warning.includes('native itinerary locations')));
  const shapeOnly = observationGeometry({ itinerary: { legs: [{ coordinates: [a, c] }] } });
  assert.equal(shapeOnly.origin, null);
  assert.equal(shapeOnly.destination, null);
});


test('ULTRA contracted walking paths stay visibly simplified', () => {
  const result = observationGeometry(observation([{ mode: 'walk', coordinates: [a, b, c] }], { walkingGeometry: 'contracted OSM graph' }));
  assert.equal(result.segments[0].geometryQuality, 'coarse');
  assert.match(result.segments[0].label, /simplified path/);
  assert.ok(result.warnings.some(warning => warning.includes('simplified OSM')));
});

test('Valhalla assumed transit schedules remain visible with correct shape geometry', () => {
  const result = observationGeometry(observation([{ shape: encode([a, b], 6), maneuvers: [
    { begin_shape_index: 0, end_shape_index: 1, travel_mode: 'transit', transit_info: { transit_stops: [{ assumed_schedule: true }] } },
  ] }]));
  assert.deepEqual(result.segments[0].coordinates, [a, b]);
  assert.ok(result.warnings.some(warning => warning.includes('assumed schedules')));
});
