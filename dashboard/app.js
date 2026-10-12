import { renderEngineChart, ENGINE_COLORS } from './comparison-chart.js';
const $ = (id) => document.getElementById(id);
const state = { catalog: null, run: null, runId: '', city: '', lane: null, observations: [], filtered: [], page: 0, queryVersion: 0, runVersion: 0, timer: null, polling: false, busy: false, selectedQueryId: null, map: null, mapQuery: null, mapRequestId: null, mapLane: null, mapVersion: 0 };
const PAGE_SIZE = 40;
Object.assign(state, { odRows: [], odPage: 0, odScope: '', odVersion: 0, reuseRun: null, attemptId: '', overlayVersion: 0, routeCache: new Map(), cityUpload: null });
const OD_PAGE_SIZE = 12;
const POPULATION_IDS = ['random', 'near-stop', 'station-pivot'];
const metrics = {
  endToEndMs: { key: 'endToEnd', label: 'Full query · E2E', note: 'Runner elapsed time from request encoding through parsing the returned response. Includes transport and adapter work.' },
  queryMs: { key: 'adapterDeclared', label: 'Adapter declared', note: 'Duration reported by the adapter. Its measurement boundary differs by engine; read the lane contract below.' },
  adapterOverheadMs: { key: 'adapterOverhead', label: 'Outside adapter', note: 'Per-query full elapsed time minus adapter-declared time. Includes runner serialization, transport, scheduling, and unmeasured adapter work; this is not pure IPC time.' },
  requestEncodeMs: { key: 'requestEncode', label: 'Request encoding', note: 'Runner time encoding the outgoing request. Available only when this phase was instrumented.' },
  responseDecodeMs: { key: 'responseDecode', label: 'Response decoding', note: 'Runner time parsing the returned response. Available only when this phase was instrumented.' },
  engineQueryMs: { key: 'engineQuery', label: 'Engine reported', note: 'Engine-reported internal timer. Availability and boundaries vary by engine; it is not assumed to be complete routing time.' },
};
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const validTiming = (value) => finite(value) && value >= 0;
export function formatNumber(value, digits = 1) {
  if (!finite(value)) return '—';
  const magnitude = Math.abs(value);
  const precision = magnitude > 0 && magnitude < 1 ? Math.min(6, Math.max(digits, Math.ceil(-Math.log10(magnitude)) + 1)) : digits;
  return value.toLocaleString(undefined, { maximumFractionDigits: precision });
}
const number = formatNumber;
const integer = (value) => number(value, 0);
const duration = (value) => finite(value) ? `${number(value)} ms` : 'Not recorded';

export function minuteClock(value) {
  if (!finite(value)) return '';
  const seconds = Math.round(value * 60), days = Math.floor(seconds / 86400);
  const within = ((seconds % 86400) + 86400) % 86400;
  const clock = [Math.floor(within / 3600), Math.floor(within / 60) % 60, within % 60].map(v => String(v).padStart(2, '0')).join(':');
  return clock + (days ? ` (${days > 0 ? '+' : ''}${days}d)` : '');
}
export function renderItineraryLegs(row) {
  const itinerary = row.itinerary ?? row.plan ?? row.result?.result ?? {};
  const legs = (itinerary.legs ?? []).flatMap(leg => Array.isArray(leg.maneuvers) ? leg.maneuvers : [leg]);
  return legs.map(leg => {
    const stops = leg.transit_info?.transit_stops ?? [];
    const name = leg.routeShortName ?? leg.routeName ?? leg.transit_info?.short_name ?? leg.routeId;
    const mode = leg.mode ?? leg.travel_mode ?? leg.type ?? 'Leg';
    const from = leg.fromName ?? leg.from?.name ?? leg.origin?.name ?? stops[0]?.name ?? leg.instruction ?? '';
    const to = leg.toName ?? leg.to?.name ?? leg.destination?.name ?? stops.at(-1)?.name ?? '';
    const start = leg.departureTime ?? leg.startTime ?? stops[0]?.departure_date_time ?? minuteClock(leg.startMinutes);
    const end = leg.arrivalTime ?? leg.endTime ?? stops.at(-1)?.arrival_date_time ?? minuteClock(leg.endMinutes);
    const minutes = leg.durationMinutes ?? (finite(leg.duration) ? leg.duration / 60 : finite(leg.time) ? leg.time / 60 : null);
    return `<div class="itinerary-leg"><strong>${html(mode)}${name ? ` · ${html(name)}` : ''}</strong><p>${html(from)}${to ? ` → ${html(to)}` : ''}</p><p>${html(start)}${end ? ` → ${html(end)}` : ''}${finite(minutes) ? ` · ${number(minutes)} min` : ''}</p></div>`;
  }).join('');
}
export function renderAccuracyRows(lanes) {
  return lanes.filter(lane => lane.accuracy).map(lane => {
    const a = lane.accuracy;
    return `<tr><td>${html(lane.engine)}<small class="engine-sub">${html(lane.evidenceSource)}</small></td><td>${integer(a.n)} / ${integer(a.requestedCohortN)}</td><td>${number(a.pearsonR, 6)}</td><td>${number(a.medianAbsoluteDifferenceMinutes, 4)}</td><td>${number(a.medianSignedDifferenceMinutes, 4)}</td><td>${integer(a.timingMatchedN)} / ${integer(a.residentTimingN)}</td></tr>`;
  }).join('');
}

const date = (value) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date not recorded';
const isActive = (run) => Boolean(run && ['running', 'stopping', 'starting'].includes(run.status));
const selectedCities = () => (state.run?.cities ?? []).filter((city) => !state.city || (city.citySlug ?? city.slug) === state.city);
const selectedLanes = () => selectedCities().flatMap((city) => (city.engines ?? []).map((lane) => ({ ...lane, city: lane.city ?? city.city, citySlug: lane.citySlug ?? city.citySlug })));
const engineName = (engine) => typeof engine === 'string' ? engine : engine.name ?? engine.engine;
const setText = (id, value) => { $(id).textContent = value; };
const setNotice = (id, message, error = false) => { $(id).hidden = !message; $(id).textContent = message ?? ''; $(id).classList.toggle('error-notice', error); };
const outcomeName = (value) => ({ ready: 'Ready', blocked: 'No itinerary', error: 'Query error' }[value] ?? value ?? 'Unreported');
const statusClass = (status) => ['ready', 'blocked', 'error'].includes(status) ? status : 'unsubmitted';

export function distribution(values) {
  const sorted = values.filter(validTiming).sort((a, b) => a - b);
  const quantile = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, p50Ms: quantile(.5), p95Ms: quantile(.95), p99Ms: quantile(.99), meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null };
}

export function filterObservations(observations, { outcome = 'valid', scope = 'all', odType = 'all', search = '' } = {}) {
  const needle = search.trim().toLowerCase();
  return observations.filter((observation) => {
    if (outcome === 'valid' && !['ready', 'blocked'].includes(observation.status)) return false;
    if (outcome !== 'valid' && outcome !== 'all' && observation.status !== outcome) return false;
    const processFirst = observation.processFirst ?? (finite(observation.requestIndex) ? observation.requestIndex === 1 : null);
    if (scope === 'processFirst' && processFirst !== true) return false;
    if (scope === 'subsequentDistinct' && (processFirst !== false || observation.repeat !== 1)) return false;
    if (scope === 'first' && observation.repeat !== 1) return false;
    if (scope === 'repeated' && !(observation.repeat > 1)) return false;
    if (odType !== 'all' && (observation.odType ?? 'unlabeled') !== odType) return false;
    return !needle || `${observation.id ?? ''} ${observation.odId ?? ''}`.toLowerCase().includes(needle);
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json', 'X-Benchmark-Token': state.catalog?.token ?? '' } : {}), ...options.headers } });
  const payload = await response.json().catch(() => ({ error: `Server returned HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? `HTTP ${response.status}`);
  return payload;
}

function currentFilters() {
  return { outcome: $('outcome-filter').value, scope: $('scope-filter').value, odType: $('od-filter').value, search: $('query-search').value };
}

function timingFor(lane, key) {
  if (lane.hot?.[key]) return lane.hot[key];
  // Older schemas use hot itself for adapter-declared timing only.
  if (key === 'adapterDeclared' && finite(lane.hot?.samples)) return lane.hot;
  return {};
}

function showCatalog() {
  const benchmarks = state.catalog.benchmarks ?? [];
  $('benchmark-select').innerHTML = benchmarks.length ? benchmarks.map(row => `<option value="${html(row.id)}">${html(row.label)}</option>`).join('') : '<option value="">No benchmarks yet</option>';
  if (benchmarks.some(row => row.id === state.runId)) $('benchmark-select').value = state.runId;
  const selectedCity = $('launch-city').value;
  $('launch-city').innerHTML = (state.catalog.cities ?? []).map(city => `<option value="${html(city.slug)}">${html(city.label ?? city.slug)}${city.inputErrors.length ? ' · needs files' : ''}</option>`).join('');
  if ((state.catalog.cities ?? []).some(city => city.slug === selectedCity)) $('launch-city').value = selectedCity;
  $('launch-engines').innerHTML = state.catalog.engines.map(engine => `<input type="checkbox" name="engines" value="${html(engine)}" checked>`).join('');
  const defaults = state.catalog.defaults ?? {};
  for (const [id, key] of [['launch-time','time'],['launch-walk','maxWalkKm'],['launch-transfers','maxTransfers'],['launch-horizon','horizonMinutes'],['launch-candidates','candidateLimit']]) if (!$(id).value) $(id).value = defaults[key];
  updateLaunchScope();
  renderActive();
}

async function refreshCatalog({ initial = false } = {}) {
  $('refresh').disabled = true;
  try {
    state.catalog = await api('/api/catalog');
    setText('connection', 'Local');
    $('connection').classList.remove('offline');
    showCatalog();
    const params = new URLSearchParams(location.search);
    const requested = initial ? params.get('benchmark') : state.runId;
    const groups = state.catalog.benchmarks ?? [];
    const next = groups.find(row => row.id === requested) ?? (initial ? groups.find(row => row.attempts.some(attempt => attempt.id === params.get('run'))) : null) ?? groups[0];
    if (next) await loadRun(next.id);
    else { state.run = null; state.runId = ''; $('empty').hidden = false; $('workspace').hidden = true; setText('run-meta', ''); }
    setText('updated-at', `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    schedulePoll();
  } catch (error) {
    setText('connection', 'Disconnected'); $('connection').classList.add('offline');
    setNotice('notice', error.message, true);
  } finally { $('refresh').disabled = false; }
}

async function loadRun(id, { quiet = false } = {}) {
  const version = ++state.runVersion;
  $('run-select').disabled = true;
  if (!quiet) setText('run-meta', 'Loading benchmark…');
  try {
    const run = await api(`/api/benchmark?id=${encodeURIComponent(id)}&attempt=${encodeURIComponent(state.attemptId)}`);
    if (version !== state.runVersion) return;
    const changed = state.run?.id !== id || state.runId !== id || state.loadedAttempt !== state.attemptId;
    state.loadedAttempt = state.attemptId;
    state.run = run;
    state.runId = id;
    $('benchmark-select').value = id;
    const attempts = run.benchmark.attempts;
    $('run-select').innerHTML = '<option value="">Latest per engine</option>' + attempts.map((entry, index) => `<option value="${html(entry.id)}">Run ${attempts.length - index} · ${html(entry.label ?? entry.engines.join(', '))} · ${html(entry.status.replaceAll('_', ' '))}</option>`).join('');
    $('run-select').value = state.attemptId;
    const url = new URL(location.href);
    url.searchParams.set('benchmark', id);
    url.searchParams.delete('run');
    history.replaceState(null, '', url);
    if (changed) { state.city = ''; state.lane = null; state.observations = []; state.odRows = []; state.odScope = ''; state.odVersion += 1; state.mapQuery = null; state.mapRequestId = null; state.mapLane = null; state.mapVersion += 1; state.overlayVersion += 1; setText('run-types', ''); }
    const cities = run.cities ?? [];
    $('city-select').innerHTML = '<option value="">All cities</option>' + cities.map((city) => `<option value="${html(city.citySlug ?? city.slug)}">${html(city.city ?? city.label)}</option>`).join('');
    if (!cities.some((city) => (city.citySlug ?? city.slug) === state.city)) state.city = '';
    $('city-select').value = state.city;
    $('empty').hidden = true;
    $('workspace').hidden = false;
    setNotice('notice', '');
    renderRun();
    const lanes = selectedLanes();
    const selected = lanes.find((lane) => lane.laneId === state.lane?.laneId) ?? lanes[0];
    if (selected) await loadLane(selected, { quiet });
    else {
      state.lane = null;
      state.odRows = [];
      state.mapQuery = null;
      state.mapRequestId = null;
      state.mapLane = null;
      state.map?.clearSelection();
      state.map?.setObservations([]);
      setText('map-title', 'Ready to run');
      setText('map-status', 'Run this benchmark to generate its ODs and routes.');
      renderComparisonChart();
      setText('map-route-note', ''); $('map-legend').innerHTML = '';
      renderMapControls();
      $('lane-content').hidden = true;
      setText('explorer-title', 'Waiting for engine results');
      setText('sample-count', 'No lanes yet');
    }
  } catch (error) {
    if (version === state.runVersion) { setNotice('notice', `Could not read this run. ${error.message}`, true); setText('run-meta', 'Run could not be loaded.'); }
  } finally { if (version === state.runVersion) $('run-select').disabled = false; }
}

function renderRun() {
  const run = state.run;
  const lanes = selectedLanes();
  const cities = selectedCities();
  const controls = run.controls ?? {};
  const total = (key) => lanes.reduce((sum, row) => sum + (row.counts?.[key] ?? 0), 0);
  setText('ready-count', integer(total('ready')));
  setText('blocked-count', integer(total('blocked')));
  $('blocked-count').title = 'Includes native no-itinerary outcomes and policy-rejected native candidates. See individual OD results.';
  setText('error-count', integer(total('errors')));
  setText('unsubmitted-count', lanes.some((lane) => finite(lane.unsubmittedQueries)) ? integer(lanes.reduce((sum, lane) => sum + (lane.unsubmittedQueries ?? 0), 0)) : '—');
  setText('run-title', run.benchmark?.label ?? cities[0]?.city ?? 'Benchmark');
  const serviceDates = [...new Set(cities.map((city) => city.service?.date).filter(Boolean))];
  setText('controls-summary', [finite(controls.requestedPairs) ? `${integer(controls.requestedPairs)} ODs / city` : null, finite(controls.repeatsPerPair) ? `${controls.repeatsPerPair}× / OD` : null, serviceDates.length === 1 ? serviceDates[0] : null, controls.time, finite(controls.maxWalkKm) ? `${controls.maxWalkKm} km walk` : null, controls.cacheMode ? `cache ${controls.cacheMode}` : null].filter(Boolean).join(' · ') || 'Controls not recorded in this summary.');
  const status = run.status ?? (run.completedAt ? 'retained' : 'incomplete');
  const statusLabel = ({ running: 'Running', stopping: 'Stopping', interrupted: 'Interrupted', untracked: 'Untracked process', complete: 'Complete', completed: 'Complete', retained: 'Complete', complete_with_issues: 'Complete with issues', failed: 'Failed', incomplete: 'Incomplete evidence' })[status] ?? status.replaceAll('_', ' ');
  setText('run-meta', `${run.benchmark?.attempts.length ?? 0} ${run.benchmark?.attempts.length === 1 ? 'run' : 'runs'} · ${state.attemptId ? statusLabel : 'Latest result for each engine'}`);
  setText('run-evidence', JSON.stringify({ id: state.runId, startedAt: run.startedAt, completedAt: run.completedAt, controls: run.controls, matrixCoverage: run.matrixCoverage, sources: lanes.map(lane => ({ engine: lane.engine, source: lane.evidenceSource, timing: lane.timingLabel, accuracy: lane.accuracy, measuredCommit: lane.measuredCommit })), service: cities.map((city) => ({ city: city.city, ...city.service })) }, null, 2));
  $('run-warnings').innerHTML = (run.warnings ?? []).map((warning) => `<li>${html(typeof warning === 'string' ? warning : JSON.stringify(warning))}</li>`).join('');
  if ($('journey-accuracy')) {
    $('journey-accuracy').hidden = !lanes.some(lane => lane.accuracy);
    $('accuracy-rows').innerHTML = renderAccuracyRows(lanes);
    const diagnosticAccuracy = lanes.some(lane => lane.accuracy?.accuracyVersion?.startsWith('diagnostic'));
    const cohortNote = diagnosticAccuracy
      ? 'Diagnostic survivors of the original NYC common cohort: 1,088 paired of 1,106 requested; 18 blocked requests remain explicit. No outlier exclusions. This variant is separate from the primary result and supplies no campaign timing.'
      : 'Registered primary accuracy cohorts; no outlier exclusions. Timing matched / resident counts use the separate historical latency cohort.';
    setText('accuracy-note', 'Final arrival minus requested departure, including every walk, wait, ride and transfer. Reference: VIGO ' + (controls.referenceVersion ?? 'version recorded per source') + ' ' + (controls.referenceCommit?.slice(0, 7) ?? '') + '. ' + cohortNote);
  }
  renderEngines();
  renderActive();
}

function renderEngines() {
  const key = $('comparison-metric').value;
  const field = Object.entries(metrics).find(([, metric]) => metric.key === key)?.[0];
  const lanes = selectedLanes();
  const available = (state.catalog.engines ?? []).map(engineName);
  const rows = selectedCities().flatMap((city) => {
    const cityLanes = lanes.filter((lane) => lane.citySlug === city.citySlug);
    const present = new Set(cityLanes.map((lane) => lane.engine));
    return [...cityLanes, ...available.filter((engine) => !present.has(engine)).map((engine) => ({ engine, city: city.city, missing: true }))];
  });
  $('engine-rows').innerHTML = rows.map((lane) => {
    const timing = timingFor(lane, key);
    const setup = lane.missing ? 'Not in this run' : lane.coldPrep?.status ?? lane.status ?? 'Unreported';
    const reason = lane.blockedReason ?? lane.errors?.[0] ?? '';
    const setupErrors = lane.setupErrors > 0 && lane.coldPrep?.status !== 'interrupted' ? ` · ${lane.setupErrors} setup error${lane.setupErrors > 1 ? 's' : ''}` : '';
    return `<tr class="${lane.missing ? 'absent' : ''} ${lane.laneId === state.lane?.laneId ? 'selected' : ''}"><td>${lane.missing ? `<span class="engine-name">${html(lane.engine)}</span>` : `<button class="engine-name" data-lane="${html(lane.laneId)}" aria-label="Inspect ${html(lane.engine)} in ${html(lane.city)}" aria-pressed="${lane.laneId === state.lane?.laneId}">${html(lane.engine)}</button>`}<span class="engine-sub" title="${html(reason)}">${!state.city && selectedCities().length > 1 ? `${html(lane.city)} · ` : ''}${lane.missing ? html(setup) : `Setup: ${html(setup)}${html(setupErrors)}${lane.timingLabel ? `<span class="engine-sub">${html(lane.timingLabel)}</span>` : ''}`}<span class="attempt-date">${lane.attemptAt ? html(date(lane.attemptAt)) : ''}</span></span></td>${['p50Ms', 'p95Ms', 'p99Ms'].map((metric) => `<td class="${finite(timing[metric]) ? 'latency' : 'missing'}">${number(timing[metric])}</td>`).join('')}<td>${integer(lane.counts?.ready)}</td><td>${integer(lane.counts?.blocked)}</td><td>${integer(lane.counts?.errors)}</td><td>${integer(lane.unsubmittedQueries)}</td><td>${number(finite(lane.coldPrep?.ms) ? lane.coldPrep.ms / 1000 : null)}</td><td>${number(lane.peakRss?.MiB)}</td><td>${number(lane.storage?.MiB)}</td></tr>`;
  }).join('') || '<tr><td colspan="11">Run engines to see results.</td></tr>';
  renderComparisonChart();
  const setupErrors = lanes.reduce((sum, lane) => sum + (lane.coldPrep?.status === 'interrupted' ? 0 : lane.setupErrors ?? 0), 0);
  setText('engine-note', `${lanes.length} ${lanes.length === 1 ? 'engine' : 'engines'} · ${setupErrors} setup errors. Build time, memory, and storage are measured separately. — means unavailable.`);
}

async function loadLane(lane, { quiet = false } = {}) {
  const version = ++state.queryVersion;
  const changed = state.lane?.laneId !== lane.laneId || state.lane?.runId !== lane.runId;
  const previousMapId = state.mapRequestId;
  state.lane = lane;
  if (changed) {
    state.overlayVersion += 1;
    state.mapVersion += 1;
    state.mapQuery = null;
    state.mapRequestId = null;
    state.mapLane = null;
    state.map?.clearSelection();
    state.map?.setObservations([], { city: lane.city, lane });
    renderMapControls();
    setText('map-status', 'Loading ODs…');
  }
  renderEngines();
  setText('explorer-title', `${lane.engine} / ${lane.city}`);
  setText('map-title', `${lane.city} / ${lane.engine}`);
  if (!quiet) { setText('sample-count', 'Loading observations…'); setNotice('lane-message', 'Reading query observations…'); $('lane-content').hidden = true; }
  try {
    await loadOdExplorer(lane);
    if (version !== state.queryVersion) return;
    await updateMap();
    const data = await api(`/api/queries?run=${encodeURIComponent(lane.runId ?? state.runId)}&lane=${encodeURIComponent(lane.laneId)}`);
    if (version !== state.queryVersion) return;
    state.observations = (data.observations ?? []).map((observation, index) => ({ ...observation, sequence: index + 1 }));
    const types = [...new Set(state.observations.map((row) => row.odType ?? 'unlabeled'))].sort();
    const oldType = $('od-filter').value;
    $('od-filter').innerHTML = '<option value="all">All OD types</option>' + types.map((type) => `<option value="${html(type)}">${html(type)}</option>`).join('');
    if (!changed && types.includes(oldType)) $('od-filter').value = oldType;
    if (changed) { state.page = 0; $('query-search').value = ''; }
    $('lane-content').hidden = false;
    const warnings = (data.warnings ?? []).map((value) => typeof value === 'string' ? value : JSON.stringify(value));
    if (!state.observations.length) warnings.unshift(lane.blockedReason ?? 'No responses yet. Check setup details below.');
    setNotice('lane-message', warnings.join(' '));
    renderLane();
    await updateMap();
    if (version !== state.queryVersion) return;
    if (changed || !state.mapQuery) {
      const query = state.odRows.find(row => row.id === previousMapId) ?? state.odRows[0] ?? state.observations[0];
      if (query) await selectMapQuery(query.id, lane);
    } else await updateRouteOverlay();
  } catch (error) {
    if (version !== state.queryVersion) return;
    state.observations = [];
    state.map?.setObservations(state.odRows, { city: lane.city, lane: state.odScope });
    if (state.odRows[0]) await selectMapQuery(state.odRows[0].id, lane);
    setNotice('lane-message', `Could not read observations. ${error.message}`, true);
    setText('sample-count', 'Unavailable');
    $('lane-content').hidden = true;
  }
}

export function filterOdRequests(rows, search = '', type = 'all') {
  const term = search.trim().toLowerCase();
  return rows.filter(row => (type === 'all' || row.odType === type) && (!term || `${row.odId ?? ''} ${row.id}`.toLowerCase().includes(term)));
}

function visibleOds() { return filterOdRequests(state.odRows, $('od-search').value, $('od-type-select').value); }
const populationName = type => ({ random: 'Random streets', near_stop: 'Near stops', station_pivot: 'Long offsets' })[type] ?? type ?? 'Saved OD';

async function loadOdExplorer(lane) {
  const key = `${state.runId}/${state.attemptId}/${lane.citySlug}`;
  const version = ++state.odVersion;
  if (key !== state.odScope) { state.odRows = []; state.odPage = 0; $('od-search').value = ''; $('od-type-select').value = 'all'; }
  state.odScope = key;
  const data = await api(`/api/benchmark/ods?id=${encodeURIComponent(state.runId)}&attempt=${encodeURIComponent(state.attemptId)}`);
  if (version !== state.odVersion || key !== `${state.runId}/${state.attemptId}/${state.lane?.citySlug}`) return;
  state.odRows = data.requests;
  renderComparisonChart();
  const counts = [...new Map(state.odRows.map(row => [row.odId ?? row.id, row])).values()].reduce((counts, row) => { const type = row.odType ?? 'unlabeled'; counts[type] = (counts[type] ?? 0) + 1; return counts; }, {});
  $('run-types').innerHTML = Object.entries(counts).map(([type, count]) => `<span>${html(populationName(type))}<b>${integer(count)}</b></span>`).join('');
  renderOdList();
}

function renderOdList() {
  const rows = visibleOds();
  state.odPage = Math.max(0, Math.min(state.odPage, Math.ceil(rows.length / OD_PAGE_SIZE) - 1));
  const start = state.odPage * OD_PAGE_SIZE;
  setText('od-count', `${integer(rows.length)} / ${integer(state.odRows.length)}`);
  $('od-list').innerHTML = rows.slice(start, start + OD_PAGE_SIZE).map(row => {
    const ready = Object.values(row.engines).filter(result => result.status === 'ready').length;
    return `<button class="od-item ${row.id === state.mapRequestId ? 'selected' : ''}" data-od="${html(row.id)}" aria-pressed="${row.id === state.mapRequestId}"><span>${html(row.odId ?? row.id)}</span><span class="od-item-meta">${html(populationName(row.odType))}${row.repeat > 1 ? ` · Repeat ${row.repeat}` : ''}<b>${ready} route${ready === 1 ? '' : 's'}</b></span></button>`;
  }).join('') || '<p class="od-empty">No matching ODs.</p>';
  setText('od-page-label', rows.length ? `${start + 1}–${Math.min(start + OD_PAGE_SIZE, rows.length)}` : '0 results');
  $('od-page-back').disabled = state.odPage === 0;
  $('od-page-next').disabled = start + OD_PAGE_SIZE >= rows.length;
  const index = rows.findIndex(row => row.id === state.mapRequestId);
  $('od-previous').disabled = index <= 0;
  $('od-next').disabled = index < 0 || index >= rows.length - 1;
}

function renderOdComparison() {
  const od = state.odRows.find(row => row.id === state.mapRequestId);
  setText('od-title', od ? od.odId ?? od.id : 'Choose an OD');
  const coordinate = value => value?.coordinate?.map(v => finite(v) ? v.toFixed(5) : '—').join(', ') ?? 'Not recorded';
  setText('od-coordinates', od ? `${coordinate(od.origin)} → ${coordinate(od.destination)}` : 'Browse the saved workload to begin.');
  const engines = (state.catalog?.engines ?? []).map(engineName);
  const lanes = selectedLanes().filter(lane => lane.citySlug === state.lane?.citySlug);
  $('od-engine-cards').innerHTML = engines.map(engine => {
    const row = od?.engines[engine], lane = lanes.find(lane => lane.engine === engine);
    const label = row?.outcomeReason === 'native_candidate_rejected' ? 'Policy rejected' : row ? ({ ready: 'Route found', blocked: 'No itinerary', error: 'Query error', mismatch: 'OD mismatch' })[row.status] ?? row.status : lane ? 'Not submitted' : 'Not run';
    return `<button class="od-engine ${state.mapLane?.engine === engine ? 'selected' : ''}" data-od-lane="${html(lane?.laneId ?? '')}" ${!row || row.status === 'mismatch' ? 'disabled' : ''} aria-pressed="${state.mapLane?.engine === engine}"><span class="od-engine-top"><strong>${html(engine)}</strong><span class="result-dot ${html(row?.status ?? 'missing')}"></span></span><span class="od-engine-status">${html(label)}</span><span class="od-engine-metric">${row ? duration(row.endToEndMs) : '—'}<small>${html(row?.timingLabel ?? 'full query')}</small></span><span class="od-engine-trip">${row?.status === 'ready' ? `${number(row.route?.durationMinutes)} min journey · ${integer(row.route?.transfers)} transfers` : row?.outcomeReason === 'native_candidate_rejected' ? 'Candidate rejected by routing limits' : ' '}</span></button>`;
  }).join('');
  const measured = od ? Object.keys(od.engines).length : 0;
  setText('od-comparison-note', `${measured} / ${engines.length} engines measured`);
  setText('od-missing-note', measured < engines.length ? 'Run the remaining engines to complete the comparison.' : 'Select an engine or overlay routes using the map menu.');
  $('compare-all-engines').disabled = !state.runId || isActive(state.catalog?.activeRun);
}

async function chooseOd(id) {
  const od = state.odRows.find(row => row.id === id);
  if (!od) return;
  const rows = visibleOds(), index = rows.findIndex(row => row.id === id);
  if (index >= 0) state.odPage = Math.floor(index / OD_PAGE_SIZE);
  const lane = selectedLanes().find(lane => lane.laneId === state.mapLane?.laneId) ?? state.lane;
  await selectMapQuery(id, lane);
}

async function updateMap() {
  if (!state.map) {
    try {
      const { createBenchmarkMap } = await import('./map.js');
      state.map = createBenchmarkMap($('benchmark-map'), { statusElement: $('map-status'), detailElement: $('map-detail'), onSelectObservation: (id) => chooseOd(id) });
    } catch (error) { setText('map-status', `Map unavailable: ${error.message}`); return; }
  }
  state.map.setObservations(state.odRows, { city: state.lane.city, lane: state.odScope });
  state.map.invalidateSize();
  renderMapControls();
}

function renderMapControls() {
  const lanes = selectedLanes().filter((lane) => lane.citySlug === state.lane?.citySlug);
  $('map-engine').innerHTML = lanes.map((lane) => `<option value="${html(lane.laneId)}">${html(lane.engine)}</option>`).join('');
  $('map-engine').value = state.mapLane?.laneId ?? state.lane?.laneId ?? '';
  $('map-engine').disabled = !state.mapRequestId;
  $('map-inspect').disabled = !state.mapQuery;
  $('map-fit-route').disabled = !state.mapQuery;
  setText('map-selection', state.mapRequestId ? `${state.mapRequestId} · ${state.mapLane?.engine ?? state.lane?.engine}${state.mapQuery ? ` · ${outcomeName(state.mapQuery.status)}` : ''}` : 'Select a point or an observation below to show its route.');
  renderOdList();
  renderOdComparison();
}

async function selectMapQuery(id, lane = state.lane) {
  const version = ++state.mapVersion;
  const runId = lane.runId ?? state.runId;
  const benchmarkId = state.runId;
  state.mapRequestId = id;
  state.mapQuery = null;
  state.mapLane = lane;
  state.map?.clearSelection();
  setText('map-title', lane.engine);
  renderMapControls();
  setText('map-detail', `Reading ${lane.engine} route for ${id}…`);
  try {
    if (state.odRows.find(row => row.id === id)?.engines[lane.engine]?.status === 'mismatch') throw new Error('Recorded coordinates differ from this OD.');
    const result = await api(`/api/query?run=${encodeURIComponent(runId)}&lane=${encodeURIComponent(lane.laneId)}&id=${encodeURIComponent(id)}`);
    if (version !== state.mapVersion || state.runId !== benchmarkId) return;
    state.mapQuery = result.observation ?? result;
    state.mapLane = lane;
    setText('map-title', lane.engine);
    state.map?.showObservation(state.mapQuery, { engine: lane.engine });
    await updateRouteOverlay();
    renderMapControls();
  } catch (error) {
    if (version !== state.mapVersion) return;
    state.map?.clearSelection();
    const od = state.odRows.find(row => row.id === id);
    if (od) state.map?.showObservation({ ...od, status: 'unsubmitted' }, { engine: lane.engine });
    setText('map-detail', `No route available for ${lane.engine}: ${error.message}`);
    $('map-inspect').disabled = true;
    await updateRouteOverlay();
  }
}

function renderLane() {
  if (!state.lane) return;
  const metric = $('metric-filter').value;
  const filters = currentFilters();
  state.filtered = filterObservations(state.observations, filters);
  const timed = state.filtered.filter((row) => validTiming(row[metric]));
  const stats = distribution(timed.map((row) => row[metric]));
  for (const [id, key] of [['latency-p50', 'p50Ms'], ['latency-p95', 'p95Ms'], ['latency-p99', 'p99Ms'], ['latency-mean', 'meanMs']]) setText(id, number(stats[key]));
  setText('sample-count', `${integer(state.filtered.length)} / ${integer(state.observations.length)} observations`);
  setText('metric-note', metrics[metric].note);
  setText('timing-count', `${integer(timed.length)} timed · ${integer(state.filtered.length - timed.length)} missing or invalid · ${$('outcome-filter').selectedOptions[0].text}`);
  renderChart(timed, metric);
  renderStartup(metric);
  const round = state.lane.round ?? {};
  $('process-stats').innerHTML = [
    ['Query process · includes startup & shutdown', duration(round.queryProcessMs)],
    ['Amortized process / request', duration(round.amortizedProcessMsPerRequest)],
    ['Process throughput · requests / s', number(round.processRequestsPerSecond)],
    ['Ready route throughput · routes / s', number(round.readyRoutesPerSecond)],
    ['Full lane elapsed · preparation & evidence', duration(state.lane.lifecycle?.elapsedMs)],
  ].map(([label, value]) => `<div class="pair-stat"><span>${html(label)}</span><strong>${html(value)}</strong></div>`).join('');
  setText('process-boundary', state.lane.lifecycle?.boundary ?? round.boundary ?? 'Lifecycle boundaries were not recorded in this historical summary. These totals are separate from per-query latency.');
  const contract = state.lane.timingContract ?? {};
  setText('boundary-text', contract.adapterBoundary ?? 'This historical lane does not include a measurement contract. Adapter-declared time must not be treated as full query time.');
  const limitations = [...(contract.limitations ?? []), ...(state.lane.blockedReason ? [state.lane.blockedReason] : [])];
  $('lane-details').innerHTML = `<p>Setup: ${html(state.lane.coldPrep?.status ?? state.lane.status ?? 'unreported')} · ${integer(state.lane.setupErrors)} recorded setup errors · ${integer(state.lane.unsubmittedQueries)} unsubmitted queries.</p>${contract.coreBoundary ? `<p>Engine timer: ${html(contract.coreBoundary)}</p>` : ''}<ul>${limitations.map((limitation) => `<li>${html(limitation)}</li>`).join('')}</ul><details><summary>Retained lane metadata</summary><pre>${html(JSON.stringify({ preparation: state.lane.preparation, cache: state.lane.hot?.cache, round: state.lane.round, lifecycle: state.lane.lifecycle, queryProcess: state.lane.queryProcess, timingContract: contract, networkSize: state.lane.networkSize, errors: state.lane.errors }, null, 2))}</pre></details>`;
  renderQueries();
  if (state.map) {
    state.map.setObservations(state.odRows, { city: state.lane.city, lane: state.odScope });
    state.map.invalidateSize();
  }
}

function renderStartup(metric) {
  const filters = { ...currentFilters(), scope: 'all' };
  // Preserve process sequence before applying outcome and OD filters.
  const groups = [['First process request', 'processFirst'], ['Subsequent distinct ODs · p50', 'subsequentDistinct'], ['First request per OD · p50', 'first'], ['Repeated ODs · p50', 'repeated']];
  $('startup-stats').innerHTML = groups.map(([label, scope]) => {
    const observations = filterObservations(state.observations, { ...filters, scope });
    const stats = distribution(observations.map((row) => row[metric]));
    return `<div class="pair-stat"><span>${label} <small>(${integer(stats.samples)})</small></span><strong>${duration(stats.p50Ms)}</strong></div>`;
  }).join('');
}

function renderChart(observations, metric) {
  $('download-chart').disabled = !observations.length;
  if (!observations.length) {
    $('chart').innerHTML = `<div class="chart-empty"><h3>${state.filtered.length ? 'This timer was not recorded.' : 'No observations match these filters.'}</h3><p>${state.filtered.length ? 'Choose a recorded timing layer to explore this run. Choose another timing layer.' : 'Adjust the outcome, request scope, OD type, or search filter.'}</p></div>`;
    return;
  }
  const width = 1080, height = 280, left = 58, right = 22, top = 20, bottom = 43;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const sequence = $('chart-filter').value === 'sequence';
  const logScale = $('log-scale').checked;
  const transform = (value) => logScale ? Math.log1p(value) : value;
  const inverse = (value) => logScale ? Math.expm1(value) : value;
  const values = observations.map((row) => row[metric]);
  const minimum = Math.min(0, ...values), maximum = Math.max(1, ...values);
  const sorted = [...observations].sort((a, b) => a[metric] - b[metric]);
  const maxSequence = Math.max(1, ...observations.map((row) => row.sequence));
  const xValue = (row) => sequence ? row.sequence : row[metric];
  const xMinimum = sequence ? 0 : minimum, xMaximum = sequence ? maxSequence : maximum;
  const x = (value) => left + (sequence ? value / xMaximum : (transform(value) - transform(xMinimum)) / (transform(xMaximum) - transform(xMinimum) || 1)) * plotWidth;
  const y = (value) => top + plotHeight * (1 - (sequence ? (transform(value) - transform(minimum)) / (transform(maximum) - transform(minimum)) : value / 100));
  const grid = Array.from({ length: 5 }, (_, i) => {
    const fraction = i / 4;
    const yValue = sequence ? inverse(transform(minimum) + fraction * (transform(maximum) - transform(minimum))) : fraction * 100;
    const tickX = sequence ? xMinimum + fraction * (xMaximum - xMinimum) : inverse(transform(xMinimum) + fraction * (transform(xMaximum) - transform(xMinimum)));
    return `<line class="grid" x1="${left}" y1="${y(yValue)}" x2="${width - right}" y2="${y(yValue)}"/><text x="${left - 10}" y="${y(yValue) + 4}" text-anchor="end">${number(yValue)}${sequence ? '' : '%'}</text><text x="${x(tickX)}" y="${height - 22}" text-anchor="middle">${number(tickX, sequence ? 0 : 1)}</text>`;
  }).join('');
  let drawing, caption;
  if (sequence) {
    const stride = Math.max(1, Math.ceil(observations.length / 650));
    const plotted = observations.filter((_, index) => index % stride === 0 || index === observations.length - 1);
    drawing = plotted.map((row) => `<circle cx="${x(xValue(row))}" cy="${y(row[metric])}" r="3" data-query="${html(row.id)}"><title>${html(row.id)} · ${html(outcomeName(row.status))} · ${number(row[metric])} ms</title></circle>`).join('');
    caption = `Request order is retained file order. ${plotted.length < observations.length ? `${integer(plotted.length)} evenly spaced points shown from ${integer(observations.length)} timed observations; statistics use all matching observations.` : 'All matching timed observations shown.'} Select a point or use the observation table for query details.`;
  } else {
    const stride = Math.max(1, Math.ceil(sorted.length / 500));
    const points = [[x(minimum), y(0)], ...sorted.flatMap((row, index) => index % stride === 0 || index === sorted.length - 1 ? [[x(row[metric]), y((index + 1) / sorted.length * 100)]] : [])];
    drawing = `<path class="curve" d="${points.map(([px, py], index) => `${index ? 'L' : 'M'} ${px} ${py}`).join(' ')}"/>`;
    caption = `${integer(sorted.length)} recorded timings. The curve shows the share of matching requests completed within a given duration. Quantiles use nearest rank; no latency is imputed.`;
  }
  caption += logScale ? ' Timing axis uses log(1 + milliseconds).' : ' Timing axis is linear.';
  $('chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description"><title id="chart-title">${html(metrics[metric].label)} ${sequence ? 'by request sequence' : 'cumulative distribution'}</title><desc id="chart-description">${html(caption)}</desc>${grid}${drawing}<text class="axis-title" x="${width / 2}" y="${height - 2}" text-anchor="middle">${sequence ? 'Request sequence' : `${html(metrics[metric].label)} · milliseconds`}</text><text class="axis-title" x="${left}" y="11">${sequence ? 'Milliseconds' : 'Cumulative share'}</text></svg><p class="chart-caption">${html(caption)}</p>`;
}

function downloadChart() {
  const chart = $('chart').querySelector('svg');
  if (!chart) return;
  const content = chart.cloneNode(true);
  content.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  content.setAttribute('width', '1080');
  content.setAttribute('height', '280');
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = 'text{font:11px sans-serif;fill:#666}.axis-title{fill:#171717}.grid{stroke:#e9e9e9;stroke-width:1}.curve{fill:none;stroke:#333;stroke-width:2}circle{fill:#333;opacity:.65}';
  content.prepend(style);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(content)], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.lane.engine}-${state.lane.citySlug}-${$('metric-filter').value}.svg`.replace(/[^a-zA-Z0-9._-]/g, '-');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderQueries() {
  const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const start = state.page * PAGE_SIZE;
  const rows = state.filtered.slice(start, start + PAGE_SIZE);
  $('query-rows').innerHTML = rows.map((row) => `<tr><td><button class="observation-button" data-query="${html(row.id)}">${html(row.id)}</button></td><td>${html(row.odType ?? 'Unlabeled')}</td><td><span class="outcome"><i class="dot ${statusClass(row.status)}"></i>${html(outcomeName(row.status))}</span></td><td>${integer(row.repeat)}</td><td>${number(row.endToEndMs)}</td><td>${number(row.queryMs)}</td><td>${number(row.adapterOverheadMs)}</td></tr>`).join('') || '<tr><td colspan="7">No observations match these filters.</td></tr>';
  setText('page-label', state.filtered.length ? `${integer(start + 1)}–${integer(Math.min(start + PAGE_SIZE, state.filtered.length))} of ${integer(state.filtered.length)}` : '0 observations');
  $('previous-page').disabled = state.page === 0;
  $('next-page').disabled = state.page >= pages - 1;
  $('download').disabled = state.filtered.length === 0;
}

async function showQuery(id, selectedLane = state.lane) {
  const requestedLane = selectedLane?.laneId;
  const activeLaneId = state.lane?.laneId;
  const requestedRun = state.runId;
  state.selectedQueryId = id;
  setText('query-title', id);
  setText('query-detail', 'Loading response…');
  $('query-dialog').showModal();
  try {
    const result = await api(`/api/query?run=${encodeURIComponent(selectedLane.runId ?? state.runId)}&lane=${encodeURIComponent(requestedLane)}&id=${encodeURIComponent(id)}`);
    if (state.selectedQueryId !== id || state.lane?.laneId !== activeLaneId || state.runId !== requestedRun) return;
    const row = result.observation ?? result;
    const lane = selectedLanes().find((entry) => entry.laneId === requestedLane) ?? state.lane;
    state.mapQuery = row;
    state.mapRequestId = row.id;
    state.mapLane = lane;
    state.map?.showObservation(row, { engine: lane.engine });
    renderMapControls();
    const route = row.route ?? row.response?.route ?? {};
    const legs = route.legs ?? route.itinerary?.legs ?? row.itinerary?.legs ?? [];
    $('query-detail').innerHTML = `<p class="detail-note">${html(lane.engine)} · ${html(outcomeName(row.status))} · ${html(row.odId ?? id)}${row.odType ? ` · ${html(row.odType)}` : ''} · repeat ${integer(row.repeat)}</p><button class="quiet" data-show-map>View on map</button><div class="detail-stats">${Object.entries(metrics).map(([field, metric]) => `<div class="pair-stat"><span>${html(metric.label)}</span><strong>${duration(row[field])}</strong></div>`).join('')}</div>${row.detail ? `<p class="detail-note">${html(typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail))}</p>` : ''}${renderItineraryLegs(row) ? `<h3>Itinerary</h3>${renderItineraryLegs(row)}` : '<p class="detail-note">The engine response is available below.</p>'}${row.timingLabel ? `<p class="detail-note">${html(row.timingLabel)}</p>` : ''}${finite(row.route?.durationMinutes) ? `<p class="detail-note">Final journey: ${number(row.route.durationMinutes)} min from requested departure, including initial waiting.</p>` : ''}<details class="provenance"><summary>Full response</summary><pre tabindex="0">${html(JSON.stringify(row, null, 2))}</pre></details>`;
  } catch (error) { setText('query-detail', `Could not read this observation. ${error.message}`); }
}

function locationLabel(value) {
  if (typeof value === 'string') return value;
  return value?.name ?? value?.stopName ?? value?.id ?? (value ? JSON.stringify(value) : 'Unreported');
}

export function splitPopulation(total, enabled = [true, true, true]) {
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('Benchmark size must be a positive integer');
  if (enabled.length !== 3 || !enabled.some(Boolean)) throw new Error('Choose at least one benchmark type');
  const count = enabled.filter(Boolean).length, share = Math.floor(total / count);
  let remainder = total % count;
  return enabled.map(active => active ? share + (remainder-- > 0 ? 1 : 0) : 0);
}

function resizePopulation() {
  const size = Number($('launch-size').value);
  const enabled = POPULATION_IDS.map(id => $(`type-${id}`).checked);
  if (Number.isSafeInteger(size) && size > 0) {
    const parts = enabled.some(Boolean) ? splitPopulation(size, enabled) : [0, 0, 0];
    parts.forEach((value, index) => { $(`launch-${POPULATION_IDS[index]}-count`).value = value; });
  }
  updateLaunchScope();
}

function updateLaunchScope() {
  const count = document.querySelectorAll('#launch-engines input:checked').length;
  const pairs = Number($('launch-random-count').value) + Number($('launch-near-stop-count').value) + Number($('launch-station-pivot-count').value);
  setText('launch-scope', `${integer(pairs)} ODs · choose engines when you run`);

  const selectedTypes = POPULATION_IDS.filter(id => Number($(`launch-${id}-count`).value) > 0);
  setText('launch-types-summary', selectedTypes.length ? selectedTypes.map(id => `${integer(Number($(`launch-${id}-count`).value))} ${populationName(id.replaceAll('-', '_')).toLowerCase()}`).join(' · ') : 'Choose at least one benchmark type with a positive count.');
  setText('launch-title', 'New benchmark');
  setText('launch-submit', 'Create benchmark');
  const city = state.catalog?.cities?.find((entry) => entry.slug === $('launch-city').value);
  const errors = city?.inputErrors ?? [];
  setNotice('launch-input-note', errors.length ? `Input readiness: ${errors.join(' · ')}` : '');
  $('launch-submit').disabled = state.busy || count === 0 || pairs < 1 || !city || errors.length > 0;
}

function openLaunch() {
  state.reuseRun = null;
  $('launch-form').querySelectorAll('input, select, [data-size]').forEach(input => { input.disabled = false; });
  setNotice('launch-reuse-note', '');
  setNotice('launch-error', '');
  updateLaunchScope();
  $('launch-dialog').showModal();
}

async function launch(event) {
  event.preventDefault();
  if (state.busy || !$('launch-form').reportValidity()) return;
  state.busy = true;
  updateLaunchScope();
  setNotice('launch-error', '');
  try {
    const payload = { city: $('launch-city').value, engines: [...document.querySelectorAll('#launch-engines input:checked')].map((input) => input.value), serviceDate: $('launch-date').value, time: $('launch-time').value, maxWalkKm: Number($('launch-walk').value), maxTransfers: Number($('launch-transfers').value), horizonMinutes: Number($('launch-horizon').value), candidateLimit: Number($('launch-candidates').value) };
    Object.assign(payload, { randomCount: Number($('launch-random-count').value), nearStopCount: Number($('launch-near-stop-count').value), stationPivotCount: Number($('launch-station-pivot-count').value), nearStopMinMeters: Number($('launch-near-stop-min-m').value), nearStopMaxMeters: Number($('launch-near-stop-max-m').value), stationPivotMinMeters: Number($('launch-station-pivot-min-m').value), stationPivotMaxMeters: Number($('launch-station-pivot-max-m').value) });
    payload.name = $('launch-name').value;
    payload.reuseRun = state.reuseRun;
    const result = await api('/api/benchmarks', { method: 'POST', body: JSON.stringify(payload) });
    $('launch-dialog').close();
    renderActive();
    const id = result.id;
    state.attemptId = '';
    if (id) state.runId = id;
    await refreshCatalog();
    if (id && state.runId !== id) await loadRun(id);
    schedulePoll();
  } catch (error) { setNotice('launch-error', error.message, true); }
  finally { state.busy = false; updateLaunchScope(); }
}

function renderActive() {
  const active = state.catalog?.activeRun;
  const running = isActive(active);
  $('active-panel').hidden = !running;
  $('stop-run').disabled = !running;
  $('open-run').disabled = running || !state.runId;
  if (!active) return;
  setText('active-title', active.status === 'stopping' ? 'Stopping…' : 'Running');
  setText('active-detail', `${active.config?.engines?.join(', ') ?? ''} · ${active.config?.city ?? ''}`);
  $('view-active').hidden = !active.benchmarkId || active.benchmarkId === state.runId;
}

function schedulePoll() {
  clearTimeout(state.timer);
  if (isActive(state.catalog?.activeRun)) state.timer = setTimeout(poll, 3000);
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    const activeId = state.catalog.activeRun.id;
    const data = await api(`/api/log?run=${encodeURIComponent(activeId)}`);
    setText('live-log', data.text ?? 'Waiting for output…');
    if (data.status) state.catalog.activeRun.status = data.status;
    if (state.runId === state.catalog.activeRun.benchmarkId) await loadRun(state.runId, { quiet: true });
    renderActive();
    if (!isActive(state.catalog.activeRun)) await refreshCatalog();
  } catch (error) { setNotice('notice', `Live update paused: ${error.message}. Saved results remain available.`, true); }
  finally { state.polling = false; schedulePoll(); }
}

async function stopRun() {
  const active = state.catalog?.activeRun;
  if (!active || !isActive(active)) return;
  $('stop-run').disabled = true;
  try {
    await api('/api/stop', { method: 'POST', body: JSON.stringify({ id: active.id }) });
    setText('active-title', 'Stopping…');
    await poll();
  } catch (error) { setNotice('notice', `Could not stop the run. ${error.message}`, true); }
  finally { renderActive(); }
}

function downloadCsv() {
  const fields = ['id', 'odId', 'odType', 'status', 'repeat', 'endToEndMs', 'wallMs', 'queryMs', 'adapterOverheadMs', 'requestEncodeMs', 'responseDecodeMs', 'engineQueryMs'];
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [fields.join(','), ...state.filtered.map((row) => fields.map((field) => cell(row[field])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.lane.engine}-${state.lane.citySlug}-observations.csv`.replace(/[^a-zA-Z0-9._-]/g, '-');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function boot() {
  $('od-list').addEventListener('click', event => { const button = event.target.closest('[data-od]'); if (button) chooseOd(button.dataset.od); });
  for (const id of ['od-search', 'od-type-select']) $(id).addEventListener(id === 'od-search' ? 'input' : 'change', () => { state.odPage = 0; renderOdList(); });
  $('od-page-back').addEventListener('click', () => { state.odPage -= 1; renderOdList(); });
  $('od-page-next').addEventListener('click', () => { state.odPage += 1; renderOdList(); });
  for (const [id, step] of [['od-previous', -1], ['od-next', 1]]) $(id).addEventListener('click', () => {
    const rows = visibleOds(), index = rows.findIndex(row => row.id === state.mapRequestId);
    if (rows[index + step]) chooseOd(rows[index + step].id);
  });
  $('od-engine-cards').addEventListener('click', event => {
    const button = event.target.closest('[data-od-lane]');
    const lane = button && selectedLanes().find(row => row.laneId === button.dataset.odLane);
    if (lane && state.mapRequestId) selectMapQuery(state.mapRequestId, lane);
  });
  $('compare-all-engines').addEventListener('click', openRun);
  $('refresh').addEventListener('click', () => refreshCatalog());
  $('benchmark-select').addEventListener('change', event => { state.attemptId = ''; loadRun(event.target.value); });
  $('run-select').addEventListener('change', event => { state.attemptId = event.target.value; loadRun($('benchmark-select').value); });
  $('city-select').addEventListener('change', async (event) => { state.city = event.target.value; renderRun(); const lanes = selectedLanes(); const lane = lanes.find((row) => row.laneId === state.lane?.laneId) ?? lanes[0]; if (lane) await loadLane(lane); });
  $('comparison-metric').addEventListener('change', () => { renderEngines(); renderComparisonChart(); });
  for (const id of ['comparison-type', 'comparison-population']) $(id).addEventListener('change', renderComparisonChart);
  $('map-view').addEventListener('change', updateRouteOverlay);
  $('engine-rows').addEventListener('click', (event) => { const button = event.target.closest('[data-lane]'); const lane = button && selectedLanes().find((entry) => entry.laneId === button.dataset.lane); if (lane) loadLane(lane); });
  for (const id of ['metric-filter', 'outcome-filter', 'scope-filter', 'od-filter', 'chart-filter']) $(id).addEventListener('change', () => { state.page = 0; renderLane(); });
  $('query-search').addEventListener('input', () => { state.page = 0; renderLane(); });
  $('previous-page').addEventListener('click', () => { state.page -= 1; renderQueries(); });
  $('next-page').addEventListener('click', () => { state.page += 1; renderQueries(); });
  for (const id of ['query-rows', 'chart']) $(id).addEventListener('click', (event) => { const target = event.target.closest('[data-query]'); if (target) { selectMapQuery(target.dataset.query); $('benchmark-map').scrollIntoView({ behavior: 'auto', block: 'center' }); } });
  $('download').addEventListener('click', downloadCsv);
  $('download-chart').addEventListener('click', downloadChart);
  $('log-scale').addEventListener('change', renderLane);
  $('map-fit').addEventListener('click', () => state.map?.fitBounds());
  $('map-fit-route').addEventListener('click', () => state.map?.fitRoute?.());
  $('map-inspect').addEventListener('click', () => { if (state.mapQuery) showQuery(state.mapQuery.id, state.mapLane); });
  $('map-engine').addEventListener('change', (event) => { const lane = selectedLanes().find((entry) => entry.laneId === event.target.value); if (lane && state.mapRequestId) selectMapQuery(state.mapRequestId, lane); });
  $('query-detail').addEventListener('click', (event) => { if (event.target.closest('[data-show-map]')) { $('query-dialog').close(); $('benchmark-map').scrollIntoView({ behavior: 'auto', block: 'center' }); state.map?.invalidateSize(); } });
  $('open-launch').addEventListener('click', () => openLaunch());
  $('empty-launch').addEventListener('click', () => openLaunch());
  $('open-run').addEventListener('click', openRun);
  $('run-form').addEventListener('submit', executeRun);
  $('run-engines').addEventListener('change', updateRunSelection);
  for (const [id, checked] of [['run-select-all',true],['run-select-none',false]]) $(id).addEventListener('click', () => { $('run-engines').querySelectorAll('input').forEach(input => { input.checked = checked; }); updateRunSelection(); });
  $('open-city').addEventListener('click', () => { setNotice('city-error', ''); $('city-dialog').showModal(); });
  $('city-form').addEventListener('submit', addCity);
  $('launch-size').addEventListener('input', resizePopulation);
  POPULATION_IDS.forEach(id => $(`type-${id}`).addEventListener('change', resizePopulation));
  document.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => { $('launch-size').value = button.dataset.size; resizePopulation(); }));
  ['launch-random-count', 'launch-near-stop-count', 'launch-station-pivot-count'].forEach(id => $(id).addEventListener('input', () => {
    POPULATION_IDS.forEach(type => { $(`type-${type}`).checked = Number($(`launch-${type}-count`).value) > 0; });
    $('launch-size').value = ['launch-random-count', 'launch-near-stop-count', 'launch-station-pivot-count'].reduce((total, key) => total + Number($(key).value), 0);
  }));
  $('launch-form').addEventListener('submit', launch);
  $('launch-form').addEventListener('input', updateLaunchScope);
  $('launch-engines').addEventListener('change', updateLaunchScope);
  $('launch-city').addEventListener('change', updateLaunchScope);
  $('stop-run').addEventListener('click', stopRun);
  $('view-active').addEventListener('click', () => { if (state.catalog.activeRun?.benchmarkId) { state.attemptId = ''; loadRun(state.catalog.activeRun.benchmarkId); }; });
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('query-dialog').addEventListener('close', () => { state.selectedQueryId = null; });
  refreshCatalog({ initial: true });
}

if (typeof document !== 'undefined') boot();

export function renderSensitivityRows(rows, engines, type = 'all') {
  const eligible = rows.filter(row => type === 'all' || row.odType === type);
  const common = engines.length >= 2 ? eligible.filter(row => engines.every(engine => row.engines[engine]?.status === 'ready')) : [];
  const commonIds = new Set(common.map(row => row.id));
  return engines.map(engine => {
    const submitted = eligible.filter(row => row.engines[engine] && row.engines[engine].status !== 'mismatch');
    const ready = submitted.filter(row => row.engines[engine].status === 'ready');
    const rejected = submitted.filter(row => row.engines[engine].outcomeReason === 'native_candidate_rejected').length;
    const median = selected => formatNumber(distribution(selected.map(row => row.engines[engine]?.endToEndMs)).p50Ms);
    return `<tr><td>${html(engine)}</td><td>${ready.length} / ${eligible.length}</td><td>${submitted.length}</td><td>${rejected}</td><td>${common.length}</td><td>${median(common)}</td><td>${median(submitted)}</td><td>${ready.filter(row => !commonIds.has(row.id)).length}</td></tr>`;
  }).join('') || '<tr><td colspan="8">Run engines to compare coverage and timing.</td></tr>';
}

function renderComparisonChart() {
  const metric = Object.entries(metrics).find(([, value]) => value.key === $('comparison-metric').value)?.[0] ?? 'endToEndMs';
  const engines = selectedLanes().map(lane => lane.engine);
  $('sensitivity-rows').innerHTML = renderSensitivityRows(state.odRows, engines, $('comparison-type').value);
  renderEngineChart($('engine-chart'), $('chart-legend'), state.odRows, engines, { metric, population: $('comparison-population').value, type: $('comparison-type').value });
  setText('comparison-note', $('comparison-population').value === 'common'
    ? `${metrics[metric].note} Chart uses the same ODs routed by every engine. Table includes the full workload.`
    : `${metrics[metric].note} Chart includes every recorded response and first-request startup.`);
}
function openRun() {
  if (!state.run?.benchmark) return;
  const benchmark = state.run.benchmark;
  setText('run-scope', `${benchmark.name || selectedCities()[0]?.city || benchmark.config.city} · ${benchmark.pairCount.toLocaleString()} ODs. Choose engines for this run.`);
  $('run-engines').innerHTML = state.catalog.engines.map(engine => `<label class="engine-choice"><input type="checkbox" value="${html(engine)}" checked><span>${html(engine)}</span></label>`).join('');
  setNotice('run-error', ''); updateRunSelection(); $('run-dialog').showModal();
}
function updateRunSelection() { $('run-submit').disabled = state.busy || !$('run-engines').querySelector('input:checked') || isActive(state.catalog?.activeRun); }
async function executeRun(event) {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true; updateRunSelection(); setNotice('run-error', '');
  try {
    const engines = [...$('run-engines').querySelectorAll('input:checked')].map(input => input.value);
    const active = await api('/api/run', { method: 'POST', body: JSON.stringify({ benchmarkId: state.runId, engines }) });
    state.catalog.activeRun = active; state.attemptId = ''; $('run-dialog').close();
    await refreshCatalog(); schedulePoll();
  } catch (error) { setNotice('run-error', error.message, true); }
  finally { state.busy = false; updateRunSelection(); renderActive(); }
}
async function addCity(event) {
  event.preventDefault();
  const files = [...$('city-files').files], name = $('city-name').value.trim();
  if (files.filter(file => /\.pbf$/i.test(file.name)).length !== 1 || !files.some(file => /\.zip$/i.test(file.name))) { setNotice('city-error', 'Choose one OSM PBF and at least one GTFS ZIP.', true); return; }
  if (new Set(files.map(file => file.name)).size !== files.length) { setNotice('city-error', 'File names must be unique.', true); return; }
  $('city-submit').disabled = true; setNotice('city-error', '');
  try {
    if (state.cityUpload?.name !== name) state.cityUpload = { name, city: await api('/api/cities', { method: 'POST', body: JSON.stringify({ name }) }), uploaded: new Set() };
    const upload = state.cityUpload;
    for (const file of files) {
      if (upload.uploaded.has(file.name)) continue;
      setText('city-progress', `Adding ${file.name} (${(file.size / 1024 ** 2).toFixed(1)} MB)…`);
      const response = await fetch(`/api/city-file?city=${encodeURIComponent(upload.city.slug)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Benchmark-Token': state.catalog.token }, body: file });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      upload.uploaded.add(file.name);
    }
    state.catalog = await api('/api/catalog'); showCatalog(); $('launch-city').value = upload.city.slug; updateLaunchScope();
    setText('city-progress', 'City ready.'); $('city-dialog').close(); state.cityUpload = null;
  } catch (error) { setNotice('city-error', error.message, true); }
  finally { $('city-submit').disabled = false; }
}
async function updateRouteOverlay() {
  const version = ++state.overlayVersion, mode = $('map-view').value;
  if (!state.map || !state.lane) return;
  if (mode === 'single') {
    state.map.clearRoutes(); $('map-legend').innerHTML = '';
    setText('map-title', (state.mapLane ?? state.lane).engine);
    if (state.mapQuery) state.map.showObservation(state.mapQuery, { engine: state.mapLane.engine });
    setText('map-route-note', state.mapQuery ? state.map.geometryNote() : 'Choose an OD.');
    return;
  }
  const lane = state.mapLane ?? state.lane;
  const lanes = mode.endsWith('all') ? selectedLanes() : [lane];
  setText('map-title', mode.endsWith('all') ? 'All engines' : lane.engine);
  const id = mode === 'od-all' ? state.mapRequestId : '';
  if (mode === 'od-all' && !id) return;
  setText('map-route-note', 'Loading routes…');
  const results = await Promise.allSettled(lanes.filter(lane => lane.evidenceAvailable).map(async lane => {
    const key = `${lane.runId}/${lane.laneId}/${id}`;
    let data = state.routeCache.get(key);
    if (!data || isActive(state.catalog.activeRun)) {
      data = await api(`/api/routes?run=${encodeURIComponent(lane.runId)}&lane=${encodeURIComponent(lane.laneId)}${id ? `&id=${encodeURIComponent(id)}` : ''}`);
      if (state.routeCache.size >= 20) state.routeCache.delete(state.routeCache.keys().next().value);
      state.routeCache.set(key, data);
    }
    return data.routes.filter(route => state.odRows.find(row => row.id === route.id)?.engines[lane.engine]?.status !== 'mismatch').map(route => ({ ...route, engine: lane.engine }));
  }));
  if (version !== state.overlayVersion) return;
  const routes = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  state.map.showRoutes(routes, { allOds: mode.startsWith('all') });
  const failed = results.filter(result => result.status === 'rejected').length;
  setText('map-route-note', `${state.map.geometryNote()}${failed ? ` ${failed} engine layers unavailable.` : ''}`);
  $('map-legend').innerHTML = lanes.map(lane => `<span><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="${ENGINE_COLORS[lane.engine] ?? '#666'}"/></svg>${html(lane.engine)}</span>`).join('');
}
