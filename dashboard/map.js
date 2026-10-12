import { observationGeometry } from './route-geometry.js';
import { ENGINE_COLORS } from './comparison-chart.js';

const COLORS = { origin: '#35664c', destination: '#d75327', transit: '#245bc4', walk: '#8a5cba', other: '#536572' };

function coordinate(value) {
  if (Array.isArray(value?.coordinate)) value = value.coordinate;
  if (!Array.isArray(value)) value = [value?.longitude ?? value?.lon ?? value?.lng, value?.latitude ?? value?.lat];
  if (value.length < 2 || !value.slice(0, 2).every((number) => typeof number === 'number' && Number.isFinite(number))) return null;
  return Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 ? value.slice(0, 2) : null;
}

const latLng = ([longitude, latitude]) => [latitude, longitude];
const labelNode = (value) => { const node = document.createElement('span'); node.textContent = String(value); return node; };
const contextKey = ({ city, lane } = {}) => [typeof city === 'string' ? city : city?.citySlug ?? city?.slug ?? city?.city,
  typeof lane === 'string' ? lane : lane?.laneId ?? lane?.engine].join('/');

export function createBenchmarkMap(container, { statusElement, detailElement, onSelectObservation } = {}) {
  const setStatus = (text) => { if (statusElement) statusElement.textContent = text; };
  const setDetail = (text) => { if (detailElement) detailElement.textContent = text; };
  const L = globalThis.L;
  if (!L) {
    setStatus('The map library could not load. Query evidence remains available below.');
    return { setObservations() {}, showObservation() {}, showRoutes() {}, clearRoutes() {}, geometryNote: () => 'Map unavailable', clearSelection() {}, invalidateSize() {}, fitBounds() {}, fitRoute() {} };
  }

  container.setAttribute('aria-label', 'Benchmark origins, destinations, and selected retained itinerary');
  const map = L.map(container, { preferCanvas: true, zoomControl: false, scrollWheelZoom: true }).setView([20, 0], 2);
  L.control.zoom({ position: 'topright' }).addTo(map);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  }).addTo(map);
  const renderer = L.canvas({ padding: .2 });
  const origins = L.layerGroup().addTo(map);
  const destinations = L.layerGroup().addTo(map);
  const selection = L.layerGroup().addTo(map);
  const routesLayer = L.layerGroup().addTo(map);
  let routeNote = '';
  L.control.layers({}, { 'Origins · green': origins, 'Destinations · orange': destinations }, { position: 'topright', collapsed: true }).addTo(map);

  let points = [];
  let selectedPoints = [];
  let laneKey = null;
  let selected = null;
  let summary = 'Choose an engine to see its benchmark locations.';
  let tilesFailed = false;
  let revision = '';

  const status = () => setStatus(`${summary}${tilesFailed ? ' Basemap tiles are unavailable; retained coordinates and route geometry still display.' : ''}`);
  tiles.on('tileerror', () => { tilesFailed = true; status(); });
  tiles.on('tileload', () => { if (tilesFailed) { tilesFailed = false; status(); } });

  function fit(values = selectedPoints.length ? selectedPoints : points) {
    if (!values.length) return;
    const bounds = L.latLngBounds(values.map(latLng));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15, animate: false });
  }

  function select(id) {
    if (!onSelectObservation) return;
    try {
      const result = onSelectObservation(id);
      if (result?.catch) result.catch((error) => setDetail(`Could not read this itinerary: ${error.message}`));
    } catch (error) { setDetail(`Could not read this itinerary: ${error.message}`); }
  }

  function endpoint(point, kind, observation) {
    return L.circleMarker(latLng(point), { renderer, radius: 3, stroke: false, fillColor: COLORS[kind], fillOpacity: .52 })
      .bindTooltip(labelNode(`${observation.id ?? 'Request'} · ${kind}`), { direction: 'top' })
      .on('click', () => select(observation.id));
  }

  function clearSelection() {
    routesLayer.clearLayers();
    selection.clearLayers();
    selected = null;
    selectedPoints = [];
    setDetail('Select an origin or destination to inspect the saved itinerary. Layer controls toggle origins and destinations.');
    status();
  }

  function setObservations(observations = [], context = {}) {
    const key = contextKey(context);
    const changed = key !== laneKey;
    const nextRevision = `${key}:${observations.length}:${observations.map((row) => `${row.id}:${coordinate(row.origin)?.join(',') ?? ''}:${coordinate(row.destination)?.join(',') ?? ''}`).join('|')}`;
    if (nextRevision === revision) return;
    revision = nextRevision;
    laneKey = key;
    if (changed) clearSelection();
    origins.clearLayers();
    destinations.clearLayers();
    points = [];
    let mappedRequests = 0;
    let incompleteRequests = 0;
    for (const observation of observations) {
      const origin = coordinate(observation.origin);
      const destination = coordinate(observation.destination);
      if (origin || destination) mappedRequests += 1;
      if (!origin || !destination) incompleteRequests += 1;
      if (origin) { points.push(origin); endpoint(origin, 'origin', observation).addTo(origins); }
      if (destination) { points.push(destination); endpoint(destination, 'destination', observation).addTo(destinations); }
    }
    summary = `${mappedRequests.toLocaleString()} of ${observations.length.toLocaleString()} requests mapped · green origins · orange destinations.`;
    if (incompleteRequests) summary += ` ${incompleteRequests.toLocaleString()} request(s) lack one or both saved endpoint coordinates.`;
    status();
    if (!selected) {
      setDetail(points.length ? 'Select an endpoint to load the saved itinerary. OD points are request coordinates; they are not snapped stops or route geometry.'
        : 'This lane has no saved endpoint coordinates. Select a query below to inspect any native route geometry.');
    }
    if (changed || (!selected && points.length && map.getZoom() <= 2)) fit(points);
  }

  function showObservation(observation, { engine } = {}) {
    routesLayer.clearLayers();
    selection.clearLayers();
    selectedPoints = [];
    selected = observation;
    const geometry = observationGeometry(observation);
    const warnings = [...(geometry.warnings ?? [])];
    let segments = 0;
    let skippedSegments = 0;
    let coarseSegments = 0;
    for (const segment of geometry.segments ?? []) {
      const coordinates = segment.coordinates?.map(coordinate) ?? [];
      // A bad vertex breaks the evidence chain. Never connect across missing
      // points, bridge legs, or fabricate a straight origin-to-destination line.
      if (coordinates.length < 2 || coordinates.some((point) => !point)) { skippedSegments += 1; continue; }
      const mode = ['walk', 'transit'].includes(segment.mode) ? segment.mode : 'other';
      const coarse = segment.geometryQuality === 'coarse';
      L.polyline(coordinates.map(latLng), {
        color: COLORS[mode], weight: coarse ? 3 : mode === 'walk' ? 4 : 5, opacity: coarse ? .75 : .93,
        dashArray: coarse ? '2 7' : mode === 'walk' ? '7 7' : undefined, lineCap: 'round', lineJoin: 'round',
      }).bindTooltip(labelNode(`${segment.label || 'Retained segment'} · ${mode}${coarse ? ' · coarse geometry' : ''}`)).addTo(selection);
      selectedPoints.push(...coordinates);
      segments += 1;
      if (coarse) coarseSegments += 1;
    }
    for (const [kind, source] of [['origin', geometry.origin ?? observation.origin], ['destination', geometry.destination ?? observation.destination]]) {
      const point = coordinate(source);
      if (!point) continue;
      L.circleMarker(latLng(point), { radius: 7, color: '#ffffff', weight: 2.5, fillColor: COLORS[kind], fillOpacity: 1 })
        .bindTooltip(labelNode(`${kind === 'origin' ? 'Origin' : 'Destination'} · ${observation.id ?? 'Selected request'}`)).addTo(selection);
      selectedPoints.push(point);
    }
    if (skippedSegments) warnings.push(`${skippedSegments} invalid geometry segment(s) omitted.`);
    if (coarseSegments) warnings.push(`${coarseSegments} coarse segment(s) are dotted; these are not detailed street or track alignments.`);
    const outcome = { ready: 'Ready itinerary', blocked: 'No itinerary', error: 'Query error' }[observation.status] ?? 'Outcome unreported';
    const title = [engine, observation.id, outcome].filter(Boolean).join(' · ');
    const line = segments ? `${segments} retained route segment(s) · transit solid blue · walking dashed purple.`
      : 'No native route geometry was retained. Only available endpoint coordinates are shown.';
    setDetail([title, line, ...warnings].join(' '));
    routeNote = warnings.length ? warnings.join(' ') : `${engine ?? ''} · native route geometry`;
    fit();
    status();
  }

  function showRoutes(routes, { allOds = false } = {}) {
    routesLayer.clearLayers(); selection.clearLayers(); selectedPoints = [];
    let coarse = 0, drawn = 0;
    const warnings = new Set();
    for (const route of routes) {
      const geometry = route.geometry;
      let hasGeometry = false;
      for (const segment of geometry.segments ?? []) {
        const coords = segment.coordinates.map(coordinate);
        if (coords.length < 2 || coords.some(value => !value)) continue;
        const simplified = segment.geometryQuality === 'coarse';
        if (simplified) coarse += 1;
        L.polyline(coords.map(latLng), { renderer, color: ENGINE_COLORS[route.engine] ?? COLORS.other,
          weight: allOds ? 2 : 4, opacity: allOds ? .4 : .8,
          dashArray: simplified ? '2 7' : segment.mode === 'walk' ? '7 7' : undefined,
        }).bindTooltip(labelNode(`${route.engine} · ${route.odId ?? route.id} · ${segment.label}`)).on('click', () => select(route.id)).addTo(routesLayer);
        selectedPoints.push(...coords); hasGeometry = true;
      }
      if (hasGeometry) drawn += 1;
      for (const warning of geometry.warnings ?? []) warnings.add(warning);
    }
    routeNote = `${drawn} routes displayed.${coarse ? ' Dotted segments are coarse; dashed segments are walking.' : ' Dashed segments are walking.'}`;
    setDetail([...warnings].join(' '));
    fit(); status();
  }

  status();
  clearSelection();
  return { setObservations, showObservation, showRoutes, clearRoutes: () => routesLayer.clearLayers(), geometryNote: () => routeNote, clearSelection, invalidateSize: () => map.invalidateSize({ pan: false }), fitBounds: () => fit(points), fitRoute: () => fit(selectedPoints) };
}
