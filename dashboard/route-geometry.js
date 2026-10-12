// Normalize retained route geometry only. Coordinates are always [longitude,
// latitude]; missing legs are never replaced by lines between their endpoints.
// Native schemas are traced in scripts/audit-itineraries.py and the adapters.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const point = (value) => Array.isArray(value) && value.length >= 2
  && finite(value[0]) && finite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
  ? [value[0], value[1]] : null;

function location(value) {
  if (!value || typeof value !== 'object') return null;
  return point(value) ?? point(value.coordinate) ?? point(value.coordinates)
    ?? point([value.lon ?? value.lng ?? value.longitude, value.lat ?? value.latitude]);
}

function travelMode(leg) {
  const mode = String(leg.travel_mode ?? leg.transport_mode ?? leg.mode ?? leg.travelMode ?? leg.type ?? '').toLowerCase();
  if (['walk', 'walking', 'pedestrian', 'foot', 'access_walk', 'egress_walk', 'transfer'].includes(mode)) return 'walk';
  if (['ride', 'transit', 'pt', 'bus', 'rail', 'train', 'tram', 'subway', 'metro', 'ferry', 'trolleybus', 'gondola', 'cable_car', 'funicular', 'monorail'].includes(mode)) return 'transit';
  return 'other';
}

function legLabel(leg, mode) {
  const route = leg.routeShortName ?? leg.routeName ?? leg.route?.shortName ?? leg.transit_info?.short_name
    ?? leg.route_id ?? leg.routeId ?? leg.route?.gtfsId;
  return `${mode === 'walk' ? 'Walk' : mode === 'transit' ? 'Transit' : 'Route'}${typeof route === 'string' && route ? ` · ${route}` : ''}`;
}

// MOTIS declares precision (currently 6); OTP uses 5. Valhalla shape uses 6.
// Arithmetic instead of bitwise shifts avoids signed 32-bit overflow.
function decodePolyline(encoded, precision) {
  if (typeof encoded !== 'string' || !Number.isInteger(precision) || precision < 0 || precision > 7) return null;
  let index = 0, latitude = 0, longitude = 0;
  const coordinates = [];
  const number = () => {
    let result = 0, multiplier = 1;
    for (let group = 0; group < 10; group += 1) {
      if (index >= encoded.length) return null;
      const value = encoded.charCodeAt(index++) - 63;
      if (value < 0 || value > 63) return null;
      result += (value % 32) * multiplier;
      if (!Number.isSafeInteger(result)) return null;
      if (value < 32) return result % 2 ? -Math.floor(result / 2) - 1 : result / 2;
      multiplier *= 32;
    }
    return null;
  };
  while (index < encoded.length) {
    const lat = number(), lon = number();
    if (lat === null || lon === null) return null;
    latitude += lat; longitude += lon;
    const coordinate = point([longitude / 10 ** precision, latitude / 10 ** precision]);
    if (!coordinate) return null;
    coordinates.push(coordinate);
  }
  return coordinates;
}

function wktLines(text) {
  // WKT from historical Shapely output is longitude/latitude. Explicitly reject
  // projected SRIDs, rather than treating plausible small values as degrees.
  const srid = text.match(/^SRID=(\d+);\s*/i);
  if (srid && srid[1] !== '4326') return null;
  const value = srid ? text.slice(srid[0].length) : text;
  if (/^(?:MULTI)?LINESTRING(?:\s+Z|\s+M|\s+ZM)?\s+EMPTY$/i.test(value)) return [];
  const match = value.match(/^(LINESTRING|MULTILINESTRING)(?:\s+(?:ZM|Z|M))?\s*\(([\s\S]*)\)$/i);
  if (!match) return null;
  const parse = (line) => line.split(',').map(pair => {
    const tokens = pair.trim().split(/\s+/);
    if (tokens.length < 2 || tokens.some(token => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token))) return null;
    return point(tokens.map(Number));
  });
  if (match[1].toUpperCase() === 'LINESTRING') return [parse(match[2])];
  if (!/^\s*\([^()]*\)(?:\s*,\s*\([^()]*\))*\s*$/.test(match[2])) return null;
  return [...match[2].matchAll(/\(([^()]*)\)/g)].map(part => parse(part[1]));
}

function geometryLines(value, precision = 5, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(?:SRID=|LINESTRING|MULTILINESTRING)/i.test(text)) return wktLines(text);
    if (text.startsWith('{')) {
      // A valid encoded polyline can also begin with "{".
      try { return geometryLines(JSON.parse(text), precision, depth + 1); } catch { /* try polyline */ }
    }
    const decoded = decodePolyline(value, precision);
    return decoded ? [decoded] : null;
  }
  if (Array.isArray(value)) return [value];
  if (typeof value !== 'object') return null;
  if (value.type === 'Feature') return geometryLines(value.geometry, precision, depth + 1);
  if (value.type === 'FeatureCollection' || value.type === 'GeometryCollection') {
    const children = value.features ?? value.geometries;
    if (!Array.isArray(children)) return null;
    const parts = children.map(child => geometryLines(child, precision, depth + 1));
    return parts.some(part => part === null) ? null : parts.flat();
  }
  if (value.type === 'LineString') return Array.isArray(value.coordinates) ? [value.coordinates] : null;
  if (value.type === 'MultiLineString') return Array.isArray(value.coordinates) && value.coordinates.every(Array.isArray) ? value.coordinates : null;
  if (value.type) return null;
  if (typeof value.points === 'string') return geometryLines(value.points, value.precision ?? precision, depth + 1);
  if (Array.isArray(value.coordinates)) return [value.coordinates];
  return null;
}

export function observationGeometry(observation) {
  const source = observation && typeof observation === 'object' ? observation : {};
  const candidate = source.itinerary ?? source.plan ?? source.result?.result ?? source.result?.plan ?? {};
  const itinerary = Array.isArray(candidate) ? { legs: candidate } : candidate && typeof candidate === 'object' ? candidate : {};
  const legs = Array.isArray(itinerary.legs) ? itinerary.legs : [];
  const locations = Array.isArray(itinerary.locations) ? itinerary.locations : [];
  const warnings = new Set();
  const segments = [];
  const first = legs[0] ?? {}, last = legs.at(-1) ?? {};
  const origin = location(source.origin) ?? location(source.query?.origin) ?? location(itinerary.origin)
    ?? location(locations.find(item => item?.original_index === 0) ?? locations[0]) ?? location(first.from);
  const destination = location(source.destination) ?? location(source.query?.destination) ?? location(itinerary.destination)
    ?? location(locations.at(-1)) ?? location(last.to);
  if ((!location(source.origin) && !location(source.query?.origin) && !location(itinerary.origin) && origin)
    || (!location(source.destination) && !location(source.query?.destination) && !location(itinerary.destination) && destination)) {
    warnings.add('Endpoint markers use native itinerary locations because original query coordinates were not retained.');
  }

  const add = (lines, leg, provenance, legIndex) => {
    if (lines === null) { warnings.add('Some retained geometry is malformed or unsupported and was omitted.'); return 0; }
    const mode = travelMode(leg);
    // Pinned GraphHopper TripFromLabel constructs PT geometry from stop points.
    // Verify that shape against the retained stops rather than assuming every
    // future/custom GraphHopper runtime uses the same geometry representation.
    const stops = Array.isArray(leg.stops) ? leg.stops.map(stop => location(stop?.geometry)) : [];
    const graphHopperStopSequence = leg.type === 'pt' && lines.length === 1 && stops.length >= 2
      && lines[0].length === stops.length && stops.every((stop, index) => {
        const coordinate = point(lines[0][index]);
        return stop && coordinate && Math.abs(stop[0] - coordinate[0]) < 1e-7 && Math.abs(stop[1] - coordinate[1]) < 1e-7;
      });
    const stopChords = mode === 'transit' && (/stop[_ -]?(?:chord|sequence)|straight|fallback/i.test(String(leg.geometrySource ?? ''))
      || /stop chords/i.test(String(itinerary.transitGeometry ?? '')) || graphHopperStopSequence);
    const contractedWalk = mode === 'walk' && /contracted/i.test(String(itinerary.walkingGeometry ?? leg.geometrySource ?? ''));
    const coarse = stopChords || contractedWalk;
    if (stopChords) warnings.add('Transit uses straight stop-to-stop lines.');
    if (contractedWalk) warnings.add('Walking uses a simplified OSM graph; curves are not retained.');
    let count = 0;
    for (const line of lines) {
      let contiguous = [];
      const flush = () => {
        if (contiguous.length >= 2) {
          segments.push({ coordinates: contiguous, mode, label: legLabel(leg, mode) + (stopChords ? ' (stop chords)' : contractedWalk ? ' (simplified path)' : ''),
            source: provenance, legIndex, geometryQuality: coarse ? 'coarse' : 'native' });
          count += 1;
        }
        contiguous = [];
      };
      for (const raw of line) {
        const coordinate = point(raw);
        if (!coordinate) {
          flush();
          warnings.add('Invalid coordinates were omitted; gaps are not connected.');
        } else contiguous.push(coordinate);
      }
      flush();
    }
    return count;
  };

  let missingLegs = 0;
  legs.forEach((leg, legIndex) => {
    if (!leg || typeof leg !== 'object') { missingLegs += 1; return; }
    // Valhalla's one shape contains walking and transit. Native maneuver indexes
    // locate each mode on that shape; never construct geometry from stop pairs.
    if (typeof leg.shape === 'string' && Array.isArray(leg.maneuvers)) {
      if (leg.maneuvers.some(maneuver => maneuver.transit_info?.transit_stops?.some(stop => stop.assumed_schedule))) warnings.add('Valhalla marks transit stop times as assumed schedules.');
      const shape = decodePolyline(leg.shape, 6);
      if (!shape) { add(null, leg, 'Valhalla polyline6', legIndex); return; }
      const covered = new Uint8Array(Math.max(0, shape.length - 1));
      for (const maneuver of leg.maneuvers) {
        const begin = maneuver?.begin_shape_index, end = maneuver?.end_shape_index;
        if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end < begin || end >= shape.length) {
          warnings.add('Some native maneuver indexes are invalid; their mode could not be assigned.');
          continue;
        }
        if (end === begin) continue;
        add([shape.slice(begin, end + 1)], maneuver, 'Valhalla polyline6 maneuver', legIndex);
        covered.fill(1, begin, end);
      }
      let start = -1;
      for (let index = 0; index <= covered.length; index += 1) {
        if (index < covered.length && !covered[index]) { if (start < 0) start = index; }
        else if (start >= 0) {
          add([shape.slice(start, index + 1)], {}, 'Valhalla polyline6 (mode unavailable)', legIndex);
          warnings.add('Part of the native route shape has no retained transport-mode assignment.');
          start = -1;
        }
      }
      return;
    }
    const alternatives = [
      ['coordinates', leg.coordinates, 5], ['geometry', leg.geometry, 5],
      ['legGeometry', leg.legGeometry, leg.legGeometry?.precision ?? 5],
      ['shape', leg.shape, 6], ['points', leg.points, 5],
    ];
    let count = 0;
    for (const [name, value, precision] of alternatives) {
      if (value == null) continue;
      count = add(geometryLines(value, precision), leg, name, legIndex);
      if (count) break;
    }
    if (!count && !/^(wait|waiting)$/i.test(String(leg.type ?? leg.mode ?? ''))) missingLegs += 1;
  });
  if (!segments.length) {
    // GraphHopper can retain a complete path.points without individual leg
    // shapes. Its mixed mode is unknown here; do not label the whole line walk.
    const value = itinerary.points ?? itinerary.geometry ?? itinerary.coordinates;
    if (value != null && add(geometryLines(value), {}, 'native whole-route geometry', null)) {
      warnings.add('Only whole-route geometry is available; transport modes are not assigned to its segments.');
    }
  }
  if (missingLegs) warnings.add(`${missingLegs} itinerary leg${missingLegs === 1 ? '' : 's'} had no usable retained geometry.`);
  if (!segments.length) warnings.add('No retained route geometry is available. Endpoint markers do not imply a route.');
  return { segments, origin, destination, warnings: [...warnings] };
}
