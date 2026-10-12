#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { digest, fingerprint, inputIdentity, recordProvenance } from './benchmark-recording.mjs'
import { fairnessRecord, pairedComparison } from './benchmark-fairness.mjs'
import { percentile, timingDistribution, timingSummary, summarizeByOdType } from './benchmark-statistics.mjs'
import { createProgressCheckpoint, writeJsonAtomic } from './benchmark-evidence.mjs'
import { checkPreparationSpace } from './benchmark-storage.mjs'
import { vigoResponseParts } from './vigo-results.mjs'
import { checkVigoRuntime, resolveVigoKernel, vigoRouteRequest } from './vigo-runtime.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const BENCH_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const DEFAULT_INPUT_ROOT = path.join(BENCH_ROOT, 'input')
const DEFAULT_ENGINES = [
  'VIGO',
  'VIGO-py',
  'MOTIS',
  'ULTRA-OSM',
  'R5',
  'OTP',
  'Valhalla',
  'R5py',
  'GraphHopper',
]
const OD_MIX_KEYS = ['random', 'stop', 'spur']
const DEFAULT_OD_MIX = Object.freeze({ random: 0.6, stop: 0.2, spur: 0.2 })
const SPUR_PATTERNS = ['both', 'origin', 'destination']
const EARTH_RADIUS_METERS = 6_371_008.8
const OD_CSV_COLUMNS = [
  'id',
  'origin_lon',
  'origin_lat',
  'destination_lon',
  'destination_lat',
  'od_type',
  'spur_pattern',
  'origin_anchor_feed',
  'origin_anchor_stop_id',
  'origin_anchor_lon',
  'origin_anchor_lat',
  'origin_offset_m',
  'origin_bearing_deg',
  'destination_anchor_feed',
  'destination_anchor_stop_id',
  'destination_anchor_lon',
  'destination_anchor_lat',
  'destination_offset_m',
  'destination_bearing_deg',
]
const TRANSIT_FILES = {
  agencies: 'agency.txt',
  stops: 'stops.txt',
  routes: 'routes.txt',
  trips: 'trips.txt',
  stopTimes: 'stop_times.txt',
  shapes: 'shapes.txt',
  calendar: 'calendar.txt',
  calendarDates: 'calendar_dates.txt',
}
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024
const TIMING_CONTRACT = Object.freeze({
  version: 1,
  clock: 'runner monotonic performance.now(); durations in milliseconds',
  wallMs: 'legacy: immediately before request JSON serialization through receipt of a complete response line; includes waiting for adapter startup on the first request',
  endToEndMs: 'immediately before request JSON serialization through response JSON parsing, ID validation, and observation normalization; excludes evidence writes, progress updates, enrichment, and audits',
  requestEncodeMs: 'request JSON serialization including NDJSON newline construction',
  responseDecodeMs: 'response JSON parsing, ID validation, and observation normalization; includes failed parsing/validation attempts',
  queryMs: 'adapter-declared duration identified by adapterTimingSource; boundaries vary by adapter and are not universally engine-core compute',
  adapterOverheadMs: 'per-observation endToEndMs minus queryMs, only when both are finite, nonnegative, and queryMs <= endToEndMs; includes everything outside the adapter-declared boundary, including first-request startup wait',
  adapterOverheadDeltaMs: 'signed paired difference retained for diagnosis; negative differences are excluded from adapterOverheadMs and counted as invalid',
  process: 'spawn through process close and any forced process-group cleanup, including startup, all requests, inter-request evidence/progress work, and shutdown; excludes preparation and post-query enrichment/audits',
  groups: 'first is first query of every OD (legacy); processFirst is the first attempted request in a fresh process; subsequentDistinct is repeat=1 excluding processFirst; repeated is repeat>1',
  outcomes: 'legacy adapterDeclared and runnerWall exclude errors; new endToEnd/requestEncode/responseDecode/adapterOverhead include measured errors; byOutcome splits ready, blocked, and error',
})
const ENGINE_DEFINITIONS = new Map(DEFAULT_ENGINES.map((name) => [name, {
  kind: name === 'VIGO' ? 'vigo-cli'
    : name === 'VIGO-py' ? 'vigo-python'
    : name === 'R5' ? 'r5-raw'
      : name === 'R5py' ? 'r5py'
        : name === 'MOTIS' ? 'motis'
          : name === 'ULTRA-OSM' ? 'ultra-osm'
            : name === 'OTP' ? 'otp'
              : name === 'Valhalla' ? 'valhalla'
                : name === 'GraphHopper' ? 'graphhopper'
                  : 'external',
  inputContract: ['osm', 'gtfs'],
}]))

function fail(message) {
  throw new Error(message)
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseArguments(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const equals = token.indexOf('=')
    const name = token.slice(2, equals >= 0 ? equals : undefined)
    let value = equals >= 0 ? token.slice(equals + 1) : 'true'
    if (equals < 0 && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      value = argv[index + 1]
      index += 1
    }
    args.set(name, [...(args.get(name) ?? []), value])
  }
  return args
}

function lastArgument(args, name, fallback = '') {
  return args.get(name)?.at(-1) ?? fallback
}

function parsePositiveInteger(value, label, minimum = 1) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) fail(`--${label} must be an integer >= ${minimum}`)
  return number
}

function parseSeed(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) fail('--seed must be a non-negative safe integer')
  return number >>> 0
}

function parseOdMix(value) {
  const text = String(value ?? '').trim()
  if (!text) return { ...DEFAULT_OD_MIX }
  const aliases = new Map([
    ['random', 'random'],
    ['stop', 'stop'],
    ['stop-to-stop', 'stop'],
    ['stop_to_stop', 'stop'],
    ['spur', 'spur'],
    ['stop-spur', 'spur'],
    ['stop_spur', 'spur'],
    ['tilt', 'spur'],
    ['jitter', 'spur'],
    ['drift', 'spur'],
  ])
  const weights = Object.fromEntries(OD_MIX_KEYS.map((key) => [key, 0]))
  const seen = new Set()
  for (const entry of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = entry.match(/^([^=]+)=(.+)$/u)
    if (!match) fail('--od-mix must look like random=60,stop=20,spur=20')
    const key = aliases.get(match[1].trim().toLowerCase())
    if (!key) fail(`Unknown --od-mix category ${match[1].trim()}; choose random, stop, or spur`)
    if (seen.has(key)) fail(`Duplicate --od-mix category ${key}`)
    const weight = Number(match[2])
    if (!Number.isFinite(weight) || weight < 0) fail(`--od-mix weight for ${key} must be non-negative`)
    weights[key] = weight
    seen.add(key)
  }
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  if (!(total > 0)) fail('--od-mix must give positive weight to at least one category')
  return Object.fromEntries(OD_MIX_KEYS.map((key) => [key, weights[key] / total]))
}

function allocateOdCounts(count, mix) {
  const exact = OD_MIX_KEYS.map((key, order) => ({ key, order, value: count * mix[key] }))
  const counts = Object.fromEntries(exact.map(({ key, value }) => [key, Math.floor(value)]))
  const remaining = count - Object.values(counts).reduce((sum, value) => sum + value, 0)
  const ranked = [...exact].sort((left, right) => (right.value - Math.floor(right.value)) - (left.value - Math.floor(left.value)) || left.order - right.order)
  for (let index = 0; index < remaining; index += 1) counts[ranked[index].key] += 1
  return counts
}

function canonicalEngine(value, customNames = []) {
  const normalized = String(value).trim().toLowerCase().replaceAll('_', '-')
  const found = DEFAULT_ENGINES.find((engine) => engine.toLowerCase() === normalized)
  if (found) return found
  if (normalized === 'vahalla') return 'Valhalla'
  if (normalized === 'ultra') return 'ULTRA-OSM'
  if (normalized === 'graph-hopper') return 'GraphHopper'
  const custom = customNames.find((engine) => engine.toLowerCase() === normalized)
  if (custom) return custom
  fail(`Unknown engine ${value}; choose from ${[...DEFAULT_ENGINES, ...customNames].join(', ')}`)
}

function selectedEngines(args, config = { engines: {} }) {
  const customNames = Object.keys(config.engines ?? {})
  if (args.has('engine') && args.has('engines')) fail('Use either --engine or --engines, not both')
  if (args.has('engine')) {
    const values = args.get('engine') ?? []
    if (values.length !== 1 || values[0].includes(',')) fail('--engine accepts exactly one engine; use --engines for a list')
    return [canonicalEngine(values[0], customNames)]
  }
  const raw = lastArgument(args, 'engines', DEFAULT_ENGINES.join(','))
  const engines = raw.split(',').map((value) => canonicalEngine(value, customNames)).filter((engine, index, all) => all.indexOf(engine) === index)
  if (!engines.length) fail('At least one engine is required')
  return engines
}

function cityLabel(slug) {
  return slug.split(/[_-]+/u).filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ')
}

function isOsmFile(fileName) {
  return /(?:^|\.)pbf$/iu.test(fileName)
}

function isGtfsFile(fileName) {
  return /\.zip$/iu.test(fileName) && !/(?:\.osm)?\.pbf\.zip$/iu.test(fileName)
}

function discoverCities(inputRoot, requestedSlugs = []) {
  if (!fs.existsSync(inputRoot)) fail(`Input root not found: ${inputRoot}`)
  const requested = new Set(requestedSlugs.filter(Boolean))
  const allDirectories = fs.readdirSync(inputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
  const slugs = requested.size ? allDirectories.filter((slug) => requested.has(slug)) : allDirectories
  const missing = [...requested].filter((slug) => !allDirectories.includes(slug))
  if (missing.length) fail(`City folder(s) not found under ${inputRoot}: ${missing.join(', ')}`)
  if (!slugs.length) fail(`No city folders found under ${inputRoot}`)
  return slugs.map((slug) => {
    const directory = path.join(inputRoot, slug)
    const files = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
    const osmFiles = files.filter(isOsmFile)
    const gtfsFiles = files.filter(isGtfsFile)
    const inputErrors = []
    if (osmFiles.length !== 1) inputErrors.push(`expected exactly one OSM PBF, found ${osmFiles.length}`)
    if (!gtfsFiles.length) inputErrors.push('expected at least one GTFS ZIP')
    return {
      slug,
      label: cityLabel(slug),
      directory,
      osmPath: osmFiles.length === 1 ? path.join(directory, osmFiles[0]) : null,
      gtfsPaths: gtfsFiles.map((fileName) => path.join(directory, fileName)),
      inputErrors,
    }
  })
}

function csvRecordCount(text) {
  if (!text) return 0
  let rows = 0
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1
      else inQuotes = !inQuotes
    } else if (character === '\n' && !inQuotes) {
      rows += 1
    }
  }
  if (text.at(-1) !== '\n') rows += 1
  return Math.max(0, rows - 1)
}

function parseCsv(text) {
  const records = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (character === ',' && !inQuotes) {
      row.push(field)
      field = ''
    } else if (character === '\n' && !inQuotes) {
      row.push(field.replace(/\r$/u, ''))
      if (row.some((value) => value.length)) records.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/u, ''))
    if (row.some((value) => value.length)) records.push(row)
  }
  if (!records.length) return []
  const headers = records[0].map((value) => value.replace(/^\uFEFF/u, '').trim())
  return records.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

function readZipMember(zipPath, member) {
  const result = spawnSync('unzip', ['-p', zipPath, member], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error || result.status !== 0) return null
  return result.stdout
}

function countZipMember(zipPath, member) {
  return new Promise((resolve) => {
    const child = spawn('unzip', ['-p', zipPath, member], { stdio: ['ignore', 'pipe', 'ignore'] })
    let rows = 0
    let hasData = false
    let lastByte = 10
    let settled = false
    child.stdout.on('data', (chunk) => {
      hasData = true
      // GTFS structural tables are counted by physical record lines here;
      // service-calendar files are parsed separately for date selection.
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index]
        lastByte = byte
        if (byte === 10) rows += 1
      }
    })
    const finish = (code) => {
      if (settled) return
      settled = true
      if (code !== 0 || !hasData) {
        resolve(code === 0 ? 0 : null)
        return
      }
      resolve(Math.max(0, rows + (lastByte === 10 ? 0 : 1) - 1))
    }
    child.once('error', () => finish(1))
    child.once('close', (code) => finish(code))
  })
}

function parseDateValue(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{8}$/u.test(text)) return null
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
}

function csvLineFields(line) {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (character === ',' && !inQuotes) {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }
  fields.push(field.replace(/\r$/u, ''))
  return fields
}

function streamCalendarDateExceptions(zipPath, member) {
  return new Promise((resolve) => {
    const child = spawn('unzip', ['-p', zipPath, member], { stdio: ['ignore', 'pipe', 'ignore'] })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false })
    let headers = null
    let dateIndex = 1
    let exceptionIndex = 2
    let rows = 0
    const exceptions = new Map()
    let settled = false
    lines.on('line', (line) => {
      if (!headers) {
        headers = csvLineFields(line).map((value) => value.replace(/^\uFEFF/u, '').trim())
        dateIndex = headers.indexOf('date')
        exceptionIndex = headers.indexOf('exception_type')
        return
      }
      if (!line.trim()) return
      rows += 1
      const fields = csvLineFields(line)
      const date = parseDateValue(fields[dateIndex])
      if (!date) return
      const values = exceptions.get(date) ?? []
      values.push(String(fields[exceptionIndex] ?? '').trim() === '1')
      exceptions.set(date, values)
    })
    const finish = (code) => {
      if (settled) return
      settled = true
      lines.close()
      resolve(code === 0 ? { rows, exceptions } : null)
    }
    child.once('error', () => finish(1))
    child.once('close', (code) => finish(code))
  })
}

function buildServiceModel(sourceText) {
  const calendar = parseCsv(sourceText.calendar ?? '')
  const calendarDates = sourceText.calendarDates instanceof Map ? sourceText.calendarDates : parseCsv(sourceText.calendarDates ?? '')
  const ranges = calendar.map((row) => ({
    start: parseDateValue(row.start_date),
    end: parseDateValue(row.end_date),
    weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => row[day] === '1'),
  })).filter((row) => row.start && row.end)
  const exceptions = new Map()
  if (calendarDates instanceof Map) {
    for (const [date, values] of calendarDates) exceptions.set(date, values)
  } else {
    for (const row of calendarDates) {
      const date = parseDateValue(row.date)
      if (!date) continue
      exceptions.set(date, [...(exceptions.get(date) ?? []), row.exception_type === '1'])
    }
  }
  const starts = ranges.map((row) => Date.parse(`${row.start}T00:00:00Z`)).filter(Number.isFinite)
  const ends = ranges.map((row) => Date.parse(`${row.end}T00:00:00Z`)).filter(Number.isFinite)
  const exceptionDates = [...exceptions.keys()].map((date) => Date.parse(`${date}T00:00:00Z`)).filter(Number.isFinite)
  const minOrdinal = starts.length ? Math.min(...starts) : exceptionDates.length ? Math.min(...exceptionDates) : null
  const maxOrdinal = ends.length ? Math.max(...ends) : exceptionDates.length ? Math.max(...exceptionDates) : null
  return {
    minOrdinal,
    maxOrdinal,
    hasService(date) {
      const ordinal = Date.parse(`${date}T00:00:00Z`)
      const exceptionValues = exceptions.get(date)
      if (exceptionValues?.some(Boolean)) return true
      if (exceptionValues?.length && exceptionValues.every((value) => !value)) return false
      const day = new Date(ordinal).getUTCDay()
      const mondayIndex = day === 0 ? 6 : day - 1
      return ranges.some((range) => ordinal >= Date.parse(`${range.start}T00:00:00Z`)
        && ordinal <= Date.parse(`${range.end}T00:00:00Z`)
        && range.weekdays[mondayIndex])
    },
  }
}

async function readFeedStats(gtfsPaths) {
  const feeds = await Promise.all(gtfsPaths.map(async (zipPath) => {
    const counts = {}
    const sourceText = {}
    for (const [key, member] of Object.entries(TRANSIT_FILES)) {
      if (key === 'calendar') {
        const text = readZipMember(zipPath, member)
        counts[key] = text === null ? null : csvRecordCount(text)
        if (text !== null) sourceText[key] = text
      } else if (key === 'calendarDates') {
        const summary = await streamCalendarDateExceptions(zipPath, member)
        counts[key] = summary?.rows ?? null
        if (summary) sourceText[key] = summary.exceptions
      } else {
        counts[key] = await countZipMember(zipPath, member)
      }
    }
    return { path: zipPath, file: path.basename(zipPath), bytes: fs.statSync(zipPath).size, counts, service: buildServiceModel(sourceText) }
  }))
  const totals = Object.fromEntries(Object.keys(TRANSIT_FILES).map((key) => [key, 0]))
  for (const feed of feeds) for (const key of Object.keys(totals)) if (feed.counts[key] !== null) totals[key] += feed.counts[key]
  return { feeds, totals }
}

function extractGtfsStops(text, feed) {
  const sourceRows = parseCsv(text)
  const eligible = []
  for (const row of sourceRows) {
    const locationType = String(row.location_type ?? '').trim()
    if (locationType && locationType !== '0') continue
    const stopId = String(row.stop_id ?? '').trim()
    const lon = String(row.stop_lon ?? '').trim() ? finiteNumber(row.stop_lon) : null
    const lat = String(row.stop_lat ?? '').trim() ? finiteNumber(row.stop_lat) : null
    if (!stopId || lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
    eligible.push({
      feed,
      stopId,
      stopName: String(row.stop_name ?? ''),
      coordinate: [lon, lat],
    })
  }
  return { sourceRows: sourceRows.length, eligible }
}

function readGtfsStops(gtfsPaths) {
  const unique = new Map()
  let sourceRows = 0
  let eligibleRows = 0
  for (const gtfsPath of gtfsPaths) {
    const text = readZipMember(gtfsPath, TRANSIT_FILES.stops)
    if (text === null) fail(`GTFS stops.txt could not be read from ${gtfsPath}`)
    const extracted = extractGtfsStops(text, path.basename(gtfsPath))
    sourceRows += extracted.sourceRows
    eligibleRows += extracted.eligible.length
    for (const stop of extracted.eligible) {
      const coordinateKey = `${stop.coordinate[0].toFixed(7)},${stop.coordinate[1].toFixed(7)}`
      if (!unique.has(coordinateKey)) unique.set(coordinateKey, stop)
    }
  }
  return { stops: [...unique.values()], sourceRows, eligibleRows, duplicateCoordinates: eligibleRows - unique.size }
}

function inferServiceDate(feedStats, requestedDate) {
  if (requestedDate) return { date: requestedDate, source: 'cli' }
  const models = feedStats.feeds.map((feed) => feed.service)
  if (!models.length || models.some((model) => model.minOrdinal === null || model.maxOrdinal === null)) return { date: null, source: 'unavailable' }
  const start = Math.max(...models.map((model) => model.minOrdinal))
  const end = Math.min(...models.map((model) => model.maxOrdinal))
  for (let ordinal = start; ordinal <= end; ordinal += 86_400_000) {
    const date = new Date(ordinal).toISOString().slice(0, 10)
    if (models.every((model) => model.hasService(date))) return { date, source: 'first-common-service-date' }
  }
  return { date: null, source: 'no-common-service-date' }
}

function inferServiceDay(date, requestedDay) {
  if (requestedDay) return { day: requestedDay, source: 'cli' }
  if (!date) return { day: null, source: 'unavailable' }
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return { day: day === 0 ? 'sunday' : day === 6 ? 'saturday' : 'weekday', source: 'service-date' }
}

function csvEscape(value) {
  const text = String(value)
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function parseOdRows(text) {
  return parseCsv(text).map((row, index) => {
    const id = String(row.id || `od_${index + 1}`)
    const numeric = (value) => String(value ?? '').trim() ? finiteNumber(value) : null
    const originLon = numeric(row.origin_lon ?? row.originLng ?? row.from_lon)
    const originLat = numeric(row.origin_lat ?? row.from_lat)
    const destinationLon = numeric(row.destination_lon ?? row.destinationLng ?? row.to_lon)
    const destinationLat = numeric(row.destination_lat ?? row.to_lat)
    if ([originLon, originLat, destinationLon, destinationLat].some((value) => value === null)) fail(`OD row ${id} does not contain numeric coordinates`)
    const anchor = (prefix) => {
      const feed = String(row[`${prefix}_anchor_feed`] ?? '').trim()
      const stopId = String(row[`${prefix}_anchor_stop_id`] ?? '').trim()
      const lon = numeric(row[`${prefix}_anchor_lon`])
      const lat = numeric(row[`${prefix}_anchor_lat`])
      return feed || stopId || (lon !== null && lat !== null) ? { feed, stopId, coordinate: lon !== null && lat !== null ? [lon, lat] : null } : null
    }
    return {
      id,
      origin: { coordinate: [originLon, originLat] },
      destination: { coordinate: [destinationLon, destinationLat] },
      originLon,
      originLat,
      destinationLon,
      destinationLat,
      odType: String(row.od_type ?? '').trim() || null,
      spurPattern: String(row.spur_pattern ?? '').trim() || null,
      originAnchor: anchor('origin'),
      destinationAnchor: anchor('destination'),
      originOffsetMeters: numeric(row.origin_offset_m),
      originBearingDegrees: numeric(row.origin_bearing_deg),
      destinationOffsetMeters: numeric(row.destination_offset_m),
      destinationBearingDegrees: numeric(row.destination_bearing_deg),
    }
  })
}

function serializeOdRows(rows) {
  const values = (row) => [
    row.id,
    row.originLon,
    row.originLat,
    row.destinationLon,
    row.destinationLat,
    row.odType ?? '',
    row.spurPattern ?? '',
    row.originAnchor?.feed ?? '',
    row.originAnchor?.stopId ?? '',
    row.originAnchor?.coordinate?.[0] ?? '',
    row.originAnchor?.coordinate?.[1] ?? '',
    row.originOffsetMeters ?? '',
    row.originBearingDegrees ?? '',
    row.destinationAnchor?.feed ?? '',
    row.destinationAnchor?.stopId ?? '',
    row.destinationAnchor?.coordinate?.[0] ?? '',
    row.destinationAnchor?.coordinate?.[1] ?? '',
    row.destinationOffsetMeters ?? '',
    row.destinationBearingDegrees ?? '',
  ]
  return [OD_CSV_COLUMNS.join(','), ...rows.map((row) => values(row).map(csvEscape).join(',')), ''].join('\n')
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function shuffle(values, random) {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
  }
  return shuffled
}

function haversineDistanceMeters(left, right) {
  const toRadians = Math.PI / 180
  const lat1 = left[1] * toRadians
  const lat2 = right[1] * toRadians
  const deltaLat = (right[1] - left[1]) * toRadians
  const deltaLon = (right[0] - left[0]) * toRadians
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)))
}

function destinationPoint(coordinate, distanceMeters, bearingDegrees) {
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS
  const bearing = bearingDegrees * Math.PI / 180
  const latitude = coordinate[1] * Math.PI / 180
  const longitude = coordinate[0] * Math.PI / 180
  const destinationLatitude = Math.asin(Math.sin(latitude) * Math.cos(angularDistance) + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing))
  const destinationLongitude = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude), Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude))
  const lon = ((destinationLongitude * 180 / Math.PI + 540) % 360) - 180
  return [lon, destinationLatitude * 180 / Math.PI]
}

function sampleStopPair(stops, random) {
  if (stops.length < 2) fail('At least two unique GTFS stop coordinates are required for stop-based OD sampling')
  const originIndex = Math.floor(random() * stops.length)
  let destinationIndex = Math.floor(random() * (stops.length - 1))
  if (destinationIndex >= originIndex) destinationIndex += 1
  return [stops[originIndex], stops[destinationIndex]]
}

function driftStop(stop, minimumMeters, maximumMeters, random) {
  const distanceMeters = minimumMeters + random() * (maximumMeters - minimumMeters)
  const bearingDegrees = random() * 360
  return {
    coordinate: destinationPoint(stop.coordinate, distanceMeters, bearingDegrees),
    distanceMeters,
    bearingDegrees,
  }
}

function measuredInvocation(command, measureRss = true) {
  const timePath = '/usr/bin/time'
  if (!measureRss || !fs.existsSync(timePath)) return { command: command[0], args: command.slice(1) }
  return { command: timePath, args: [process.platform === 'darwin' ? '-l' : '-v', ...command] }
}

export function parseMaxRss(stderr) {
  const mac = stderr.match(/maximum resident set size:\s*([\d,]+)/iu)
  if (mac) return Number(mac[1].replaceAll(',', ''))
  const macTrailing = stderr.match(/([\d,]+)[ \t]+maximum resident set size/iu)
  if (macTrailing) return Number(macTrailing[1].replaceAll(',', ''))
  const linux = stderr.match(/maximum resident set size \(kbytes\):\s*([\d,]+)/iu)
  if (linux) return Number(linux[1].replaceAll(',', '')) * 1024
  return null
}

function captureOutput(stream, filePath) {
  const descriptor = filePath ? fs.openSync(filePath, 'w') : null
  let tail = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    if (descriptor !== null) fs.writeSync(descriptor, chunk)
    // /usr/bin/time writes RSS at process exit. Keep that trailer even when
    // native logs exceed the in-memory limit; the disk log remains complete.
    tail = (tail + chunk).slice(-MAX_CAPTURE_BYTES)
  })
  return () => {
    if (descriptor !== null) fs.closeSync(descriptor)
    return tail
  }
}

async function runSimpleCommand(command, options = {}) {
  const invocation = measuredInvocation(command, options.measureRss !== false)
  const started = performance.now()
  const grouped = process.platform !== 'win32'
  const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env: options.env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] })
  const readStdout = captureOutput(child.stdout, options.stdoutPath)
  const readStderr = captureOutput(child.stderr, options.stderrPath)
  let interruptionSignal = null, cleanup = null
  const signalChild = signal => {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const interrupt = signal => {
    if (interruptionSignal) return
    interruptionSignal = signal
    signalChild('SIGTERM')
    cleanup = new Promise(resolve => setTimeout(() => { signalChild('SIGKILL'); resolve() }, 500))
  }
  const handlers = ['SIGINT', 'SIGTERM'].map(signal => [signal, () => interrupt(signal)])
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    const result = await new Promise(resolve => {
      let settled = false
      child.once('error', error => { if (!settled) { settled = true; resolve({ error }) } })
      child.once('close', (code, signal) => { if (!settled) { settled = true; resolve({ code, signal }) } })
    })
    if (cleanup) await cleanup
    const stdout = readStdout(), stderr = readStderr()
    return { ...result, command, stdout, stderr, elapsedMs: performance.now() - started, maxRssBytes: parseMaxRss(stderr), interruptionSignal }
  } finally { for (const [signal, handler] of handlers) process.off(signal, handler) }
}

function parseJsonOutput(stdout) {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]) } catch { /* adapter progress */ }
    }
  }
  return null
}

function normalizeObservation(request, payload, wallMs) {
  const { result, plan, publicResult, timing } = vigoResponseParts(payload)
  const declaredStatus = payload?.status === 'error' ? 'error' : plan?.status ?? result?.status ?? payload?.status
  const status = ['blocked', 'not_found'].includes(declaredStatus)
    ? 'blocked'
    : declaredStatus === 'ready' || declaredStatus === 'ok'
      ? 'ready'
      : payload?.error || declaredStatus === 'error' ? 'error' : 'error'
  // The benchmark's complete-duration ceiling is distinct from a router's
  // timetable horizon. Preserve an over-limit candidate as rejected evidence.
  const completeLimit = finiteNumber(request.maxJourneyDurationMinutes)
  const duration = finiteNumber(plan?.durationMinutes)
  const durationRejected = status === 'ready' && completeLimit !== null && duration !== null
    && duration > completeLimit + 1e-6
  const declaredTiming = [
    ['payload.queryMs', payload?.queryMs],
    ['timing.queryMs', timing.queryMs],
    ['timing.computeMs', timing.computeMs],
    ['timing.totalMs', timing.totalMs],
    ['timing.routeMs', timing.routeMs],
    ['timing.requestMs', timing.requestMs],
    ['meta.computeUs / 1000', publicResult?.meta?.computeUs == null ? null : publicResult.meta.computeUs / 1000],
  ].map(([source, value]) => ({ source, value: finiteNumber(value) }))
    .find((candidate) => candidate.value !== null)
  const searchStats = plan?.diagnostics?.searchStats && typeof plan.diagnostics.searchStats === 'object'
    ? plan.diagnostics.searchStats
    : {}
  return {
    id: request.id,
    status: durationRejected ? 'blocked' : status,
    outcomeReason: durationRejected ? 'native_candidate_rejected' : plan?.diagnostics?.outcomeReason ?? null,
    ...(durationRejected ? { policyViolations: ['complete_duration_exceeded'], nativeStatus: status } : {}),
    queryMs: declaredTiming?.value ?? null,
    adapterTimingSource: declaredTiming?.source ?? null,
    wallMs,
    timing,
    productVersion: publicResult?.meta?.engineVersion ?? result?.productVersion ?? payload?.productVersion ?? null,
    ...(publicResult ? { resultSchema: publicResult.schema, resultMeta: publicResult.meta ?? null,
      warnings: publicResult.warnings ?? [], computeScope: publicResult.meta?.computeScope ?? null } : {}),
    engineQueryMs: finiteNumber(searchStats.engineQueryMs) ?? finiteNumber(timing.engineQueryMs),
    cacheHit: typeof searchStats.cacheHit === 'boolean' ? searchStats.cacheHit : null,
    resultCachePolicy: typeof searchStats.resultCachePolicy === 'string' ? searchStats.resultCachePolicy : null,
    nativeStreetPathCacheHits: finiteNumber(searchStats.nativeStreetPathCacheHits),
    nativeStreetPathCacheMisses: finiteNumber(searchStats.nativeStreetPathCacheMisses),
    nativeStreetPathCacheDisabled: typeof searchStats.nativeStreetPathCacheDisabled === 'boolean' ? searchStats.nativeStreetPathCacheDisabled : null,
    detail: payload?.error?.message ?? payload?.error ?? plan?.detail ?? payload?.detail ?? null,
    itinerary: durationRejected ? null : payload?.itinerary ?? plan,
    ...(durationRejected ? { rejectedItinerary: payload?.itinerary ?? plan }
      : payload?.rejectedItinerary ? { rejectedItinerary: payload.rejectedItinerary } : {}),
    failure: plan?.diagnostics?.failureCode ?? payload?.failure ?? null,
    route: plan ? {
      travelMode: plan.travelMode ?? null,
      status: durationRejected ? 'blocked' : plan.status ?? null,
      durationMinutes: finiteNumber(plan.durationMinutes),
      transfers: finiteNumber(plan.transfers),
      algorithm: plan.diagnostics?.algorithm ?? null,
      walkingNetwork: plan.diagnostics?.walkingNetwork ?? null,
    } : null,
  }
}

async function runNdjsonCommand(command, requests, options = {}) {
  const invocation = measuredInvocation(command, options.measureRss !== false)
  const started = performance.now()
  const timeoutMs = options.queryTimeoutMs ?? 0
  const grouped = process.platform !== 'win32'
  const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env: options.env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] })
  const readStderr = captureOutput(child.stderr, options.stderrPath)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false })
  const iterator = lines[Symbol.asyncIterator]()
  const closePromise = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, elapsedMs: performance.now() - started })))
  let spawnError = null
  child.once('error', (error) => { spawnError = error })
  let stdinError = null
  child.stdin.on('error', (error) => { stdinError = error })
  let killTimer = null
  let stopping = false
  let terminationGrace = null
  let resolveTerminationGrace = null
  let interruptionSignal = null
  const stopProcess = () => {
    if (stopping) return
    stopping = true
    const signal = (name) => {
      try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    signal('SIGTERM')
    terminationGrace = new Promise((resolve) => { resolveTerminationGrace = resolve })
    // Keep the grace timer referenced: a wrapper may close while a server child
    // with redirected stdio still belongs to the process group we created.
    killTimer = setTimeout(() => { signal('SIGKILL'); resolveTerminationGrace() }, 500)
  }
  const interrupt = (signal) => { interruptionSignal ??= signal; stopProcess() }
  const signalHandlers = grouped ? ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => interrupt(signal)]) : []
  for (const [signal, handler] of signalHandlers) process.on(signal, handler)
  try {
  const withinDeadline = async (operation, milliseconds, message) => {
    if (!timeoutMs) return operation
    let timer
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'QUERY_TIMEOUT' })), Math.max(1, milliseconds))
      })])
    } finally { clearTimeout(timer) }
  }
  const observations = []
  const evidence = options.observationsPath ? fs.openSync(options.observationsPath, 'w') : null
  const record = (observation) => {
    if (options.decorateObservation) observation = options.decorateObservation(observation)
    observations.push(observation)
    if (evidence !== null) fs.writeSync(evidence, `${JSON.stringify(observation)}\n`)
    options.onProgress?.({ completed: observations.length, total: requests.length, observation })
  }
  let firstRequestStartedMs = null
  let timedOut = false
  for (const [requestIndex, request] of requests.entries()) {
    if (interruptionSignal || spawnError || stdinError || child.stdin.destroyed || child.exitCode !== null) {
      break
    }
    const requestStarted = performance.now()
    if (firstRequestStartedMs === null) firstRequestStartedMs = requestStarted - started
    let requestEncodeMs = null
    let responseDecodeMs = null
    let wallMs = null
    let responseBytes = null
    let requestBytes = null
    let observation
    let endToEndMs = null
    let stopAfterRequest = false
    try {
      const encodeStarted = performance.now()
      const encoded = `${JSON.stringify(options.encodeRequest ? options.encodeRequest(request) : request)}\n`
      requestEncodeMs = performance.now() - encodeStarted
      requestBytes = Buffer.byteLength(encoded)
      const deadline = requestStarted + timeoutMs
      if (!child.stdin.write(encoded)) await withinDeadline(once(child.stdin, 'drain'), deadline - performance.now(), `query ${request.id} exceeded ${timeoutMs} ms while writing`)
      const next = await withinDeadline(iterator.next(), deadline - performance.now(), `query ${request.id} exceeded ${timeoutMs} ms awaiting response`)
      wallMs = performance.now() - requestStarted
      if (next.done) {
        observation = { id: request.id, status: 'error', queryMs: null, wallMs, error: `query process ended without a response for ${request.id}` }
        stopAfterRequest = true
      } else {
        const decodeStarted = performance.now()
        try {
          const payload = JSON.parse(next.value)
          const responseId = payload?.id ?? payload?.meta?.requestId
          if (responseId !== request.id) throw new Error(`response ID ${responseId} does not match ${request.id}`)
          observation = normalizeObservation(request, payload, wallMs)
        } catch (error) {
          observation = { id: request.id, status: 'error', queryMs: null, wallMs, error: `invalid adapter JSON for ${request.id}: ${error.message}`, raw: next.value.slice(0, 400) }
        }
        responseDecodeMs = performance.now() - decodeStarted
        endToEndMs = performance.now() - requestStarted
        // Count decoded response-line bytes; readline has removed the delimiter.
        responseBytes = Buffer.byteLength(next.value)
      }
    } catch (error) {
      observation = { id: request.id, status: 'error', queryMs: null, wallMs: wallMs ?? performance.now() - requestStarted, error: error instanceof Error ? error.message : String(error) }
      stopAfterRequest = true
      if (error.code === 'QUERY_TIMEOUT') { timedOut = true; observation.timedOut = true; stopProcess() }
    }
    endToEndMs ??= performance.now() - requestStarted
    const queryMs = observation.queryMs
    const adapterOverheadDeltaMs = Number.isFinite(queryMs) ? endToEndMs - queryMs : null
    const adapterOverheadStatus = !Number.isFinite(queryMs) ? 'missing_adapter_timing'
      : queryMs < 0 ? 'invalid_adapter_timing'
        : adapterOverheadDeltaMs < 0 ? 'adapter_exceeds_end_to_end' : 'valid'
    record({ ...observation, endToEndMs, requestEncodeMs, responseDecodeMs,
      adapterOverheadMs: adapterOverheadStatus === 'valid' ? adapterOverheadDeltaMs : null,
      adapterOverheadDeltaMs, adapterOverheadStatus, requestBytes, responseBytes,
      requestIndex: requestIndex + 1, processFirst: requestIndex === 0 })
    if (observations.length === 1 || observations.length % 250 === 0 || observations.length === requests.length) {
      process.stderr.write(`[${new Date().toISOString()}] ${options.label ?? 'query'} ${observations.length}/${requests.length}\n`)
    }
    if (stopAfterRequest) break
  }
  child.stdin.end()
  let processResult
  try { processResult = timedOut ? await closePromise : await withinDeadline(closePromise, timeoutMs, `query process did not close within ${timeoutMs} ms after final request`) }
  catch (error) { timedOut = true; stopProcess(); processResult = await closePromise }
  if (stopping && grouped && child.pid) {
    let groupExists = true
    try { process.kill(-child.pid, 0) } catch (error) { if (error.code === 'ESRCH') groupExists = false; else throw error }
    if (groupExists) {
      await terminationGrace
      processResult.directProcessMs = processResult.elapsedMs
      processResult.elapsedMs = performance.now() - started
    } else { clearTimeout(killTimer); resolveTerminationGrace?.() }
  } else { clearTimeout(killTimer); resolveTerminationGrace?.() }
  lines.close()
  if (evidence !== null) fs.closeSync(evidence)
  const stderr = readStderr()
  const result = { observations, process: { ...processResult, command, stderr, error: spawnError?.message ?? stdinError?.message ?? null, timedOut, firstRequestStartedMs, maxRssBytes: parseMaxRss(stderr) } }
  if (interruptionSignal) throw Object.assign(new Error(`Benchmark interrupted by ${interruptionSignal}`), { code: 'BENCHMARK_INTERRUPTED', signal: interruptionSignal, ...result })
  return result
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }
}

function streamOsmCoordinates(filtered, count, seed) {
  return new Promise((resolve, reject) => {
    const exportConfig = path.join(BENCH_ROOT, 'osmium-coordinate-export.json')
    if (!fs.existsSync(exportConfig)) {
      reject(new Error(`OSM coordinate export configuration is missing: ${exportConfig}`))
      return
    }
    const child = spawn('osmium', ['export', filtered, '--config', exportConfig, '-f', 'geojson', '-o', '-', '--geometry-types=linestring', '--no-progress'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096) })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false })
    const candidates = []
    const random = mulberry32(seed)
    let validCoordinateCount = 0
    let segmentCount = 0
    let settled = false
    const consumeLine = (rawLine) => {
      const line = rawLine.trim()
      if (!line.startsWith('{') || line.startsWith('{"type":"FeatureCollection"')) return
      const coordinateMatch = line.match(/"coordinates":(\[\[.*\]\])\}\s*,\s*"properties":/u)
      if (!coordinateMatch) return
      let coordinates
      try {
        coordinates = JSON.parse(coordinateMatch[1])
      } catch {
        return
      }
      segmentCount += Math.max(0, coordinates.length - 1)
      for (const point of coordinates) {
        const lon = finiteNumber(point?.[0])
        const lat = finiteNumber(point?.[1])
        if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
        validCoordinateCount += 1
        if (candidates.length < count * 2) candidates.push([lon, lat])
        else {
          const offset = Math.floor(random() * validCoordinateCount)
          if (offset < candidates.length) candidates[offset] = [lon, lat]
        }
      }
    }
    lines.on('line', consumeLine)
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      lines.close()
      if (code !== 0) {
        reject(new Error(`OSM highway export failed with ${signal ?? code}: ${stderr.trim()}`))
        return
      }
      resolve({ candidates, validCoordinateCount, segmentCount })
    }
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.once('close', finish)
  })
}

function coordinateRow(origin, destination, metadata = {}) {
  return {
    id: null,
    origin: { coordinate: origin },
    destination: { coordinate: destination },
    originLon: origin[0],
    originLat: origin[1],
    destinationLon: destination[0],
    destinationLat: destination[1],
    ...metadata,
  }
}

function stopAnchor(stop) {
  return { feed: stop.feed, stopId: stop.stopId, coordinate: [...stop.coordinate] }
}

function stopPairRow(originStop, destinationStop) {
  return coordinateRow(originStop.coordinate, destinationStop.coordinate, {
    odType: 'stop_to_stop',
    spurPattern: null,
    originAnchor: stopAnchor(originStop),
    destinationAnchor: stopAnchor(destinationStop),
    originOffsetMeters: 0,
    originBearingDegrees: null,
    destinationOffsetMeters: 0,
    destinationBearingDegrees: null,
  })
}

function stopSpurRow(originStop, destinationStop, pattern, minimumMeters, maximumMeters, random) {
  const moveOrigin = pattern === 'origin' || pattern === 'both'
  const moveDestination = pattern === 'destination' || pattern === 'both'
  const origin = moveOrigin ? driftStop(originStop, minimumMeters, maximumMeters, random) : { coordinate: originStop.coordinate, distanceMeters: 0, bearingDegrees: null }
  const destination = moveDestination ? driftStop(destinationStop, minimumMeters, maximumMeters, random) : { coordinate: destinationStop.coordinate, distanceMeters: 0, bearingDegrees: null }
  return coordinateRow(origin.coordinate, destination.coordinate, {
    odType: 'stop_spur',
    spurPattern: pattern,
    originAnchor: stopAnchor(originStop),
    destinationAnchor: stopAnchor(destinationStop),
    originOffsetMeters: origin.distanceMeters,
    originBearingDegrees: origin.bearingDegrees,
    destinationOffsetMeters: destination.distanceMeters,
    destinationBearingDegrees: destination.bearingDegrees,
  })
}

function coordinatePairKey(row) {
  return [row.originLon, row.originLat, row.destinationLon, row.destinationLat]
    .map((value) => Number(value).toPrecision(15))
    .join(',')
}

function stopCoordinateKey(stop) {
  return stop.coordinate.map((value) => Number(value).toPrecision(15)).join(',')
}

function buildStationPivotRows(stops, count, seed, minimumMeters, maximumMeters, existingRows = [], odType = 'station_pivot') {
  if (!count) return []
  if (stops.length < 2) fail('At least two unique GTFS stop coordinates are required for station-pivot OD sampling')
  if (count > stops.length * (stops.length - 1)) fail(`Station-pivot sampling requested ${count} ordered stop pairs, but only ${stops.length * (stops.length - 1)} distinct pairs are available`)
  const random = mulberry32(seed ^ 0xA4093822)
  const usedIds = new Set(existingRows.map(row => row.id))
  const usedAnchorPairs = new Set(existingRows.filter(row => row.odType === odType && row.originAnchor?.coordinate && row.destinationAnchor?.coordinate).map(row => `${row.originAnchor.coordinate.map(value => Number(value).toPrecision(15)).join(',')}>${row.destinationAnchor.coordinate.map(value => Number(value).toPrecision(15)).join(',')}`))
  const usedCoordinatePairs = new Set(existingRows.map(coordinatePairKey))
  const rows = []
  const width = Math.max(4, String(count).length)
  const maximumAttempts = Math.max(10_000, count * 200)
  let attempts = 0
  while (rows.length < count && attempts < maximumAttempts) {
    attempts += 1
    const [originStop, destinationStop] = sampleStopPair(stops, random)
    const anchorPair = `${stopCoordinateKey(originStop)}>${stopCoordinateKey(destinationStop)}`
    if (usedAnchorPairs.has(anchorPair)) continue
    const row = stopSpurRow(originStop, destinationStop, 'both', minimumMeters, maximumMeters, random)
    let serial = rows.length + 1
    while (usedIds.has(`${odType}_${String(serial).padStart(width, '0')}`)) serial += 1
    row.id = `${odType}_${String(serial).padStart(width, '0')}`
    usedIds.add(row.id)
    row.odType = odType
    const pair = coordinatePairKey(row)
    if (usedCoordinatePairs.has(pair)) continue
    usedAnchorPairs.add(anchorPair)
    usedCoordinatePairs.add(pair)
    rows.push(row)
  }
  if (rows.length !== count) fail(`Station-pivot sampling produced ${rows.length} of ${count} requested pairs after ${attempts} attempts`)
  return rows
}

async function sampleOsmCoordinatePairs(osmPath, count, seed) {
  if (!count) return { rows: [], stats: { candidateCoordinates: 0, sourceSegments: 0, sampledCoordinates: 0 } }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bench-osm-'))
  const filtered = path.join(temporary, 'highways.osm.pbf')
  try {
    const filteredResult = await runSimpleCommand(['osmium', 'tags-filter', osmPath, 'w/highway', '-o', filtered, '--no-progress'], { measureRss: false })
    if (filteredResult.code !== 0) fail(`OSM highway extraction failed: ${filteredResult.stderr.trim() || filteredResult.error?.message || 'unknown error'}`)
    const streamed = await streamOsmCoordinates(filtered, count, seed)
    const needed = count * 2
    if (streamed.candidates.length < needed) fail(`OSM street graph exposes ${streamed.candidates.length} coordinates; ${needed} are required for ${count} O-D pairs`)
    const rows = []
    for (let index = 0; index < count; index += 1) {
      rows.push(coordinateRow(streamed.candidates[index * 2], streamed.candidates[index * 2 + 1], { odType: 'random' }))
    }
    return { rows, stats: { candidateCoordinates: streamed.validCoordinateCount, sourceSegments: streamed.segmentCount, sampledCoordinates: needed } }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function countOdTypes(rows) {
  return rows.reduce((counts, row) => {
    const type = row.odType ?? 'unlabeled'
    counts[type] = (counts[type] ?? 0) + 1
    return counts
  }, {})
}

async function sampleMixedCoordinates(osmPath, gtfsPaths, count, seed, outputDirectory, sampling) {
  const counts = allocateOdCounts(count, sampling.mix)
  const osm = await sampleOsmCoordinatePairs(osmPath, counts.random, seed)
  const stopPopulation = counts.stop || counts.spur ? readGtfsStops(gtfsPaths) : { stops: [], sourceRows: 0, eligibleRows: 0, duplicateCoordinates: 0 }
  if ((counts.stop || counts.spur) && stopPopulation.stops.length < 2) fail(`Mixed OD sampling needs at least two unique platform/stop coordinates; found ${stopPopulation.stops.length}`)

  const pools = { random: osm.rows, stop: [], spur: [] }
  const stopRandom = mulberry32(seed ^ 0x9E3779B9)
  for (let index = 0; index < counts.stop; index += 1) {
    const [originStop, destinationStop] = sampleStopPair(stopPopulation.stops, stopRandom)
    pools.stop.push(stopPairRow(originStop, destinationStop))
  }
  const spurRandom = mulberry32(seed ^ 0x243F6A88)
  for (let index = 0; index < counts.spur; index += 1) {
    const [originStop, destinationStop] = sampleStopPair(stopPopulation.stops, spurRandom)
    const pattern = SPUR_PATTERNS[index % SPUR_PATTERNS.length]
    pools.spur.push(stopSpurRow(originStop, destinationStop, pattern, sampling.spurMinMeters, sampling.spurMaxMeters, spurRandom))
  }

  const typeSequence = shuffle(OD_MIX_KEYS.flatMap((key) => Array.from({ length: counts[key] }, () => key)), mulberry32(seed ^ 0xB7E15162))
  const offsets = Object.fromEntries(OD_MIX_KEYS.map((key) => [key, 0]))
  const width = String(count).length
  const rows = typeSequence.map((type, index) => {
    const row = pools[type][offsets[type]]
    offsets[type] += 1
    row.id = `od_${String(index + 1).padStart(width, '0')}`
    return row
  })
  const odPath = path.join(outputDirectory, 'od.csv')
  fs.writeFileSync(odPath, serializeOdRows(rows))
  const spurPatternCounts = pools.spur.reduce((result, row) => { result[row.spurPattern] += 1; return result }, Object.fromEntries(SPUR_PATTERNS.map((pattern) => [pattern, 0])))
  return {
    odPath,
    rows,
    stats: {
      method: 'deterministic mixed OD sampling: full-OSM highway-coordinate reservoir, exact GTFS stop pairs, and geodesic stop spurs',
      source: osmPath,
      gtfsSources: gtfsPaths,
      seed,
      requestedPairs: count,
      mix: sampling.mix,
      typeCounts: countOdTypes(rows),
      candidateCoordinates: osm.stats.candidateCoordinates,
      sourceSegments: osm.stats.sourceSegments,
      sampledStreetCoordinates: osm.stats.sampledCoordinates,
      sampledCoordinates: count * 2,
      stopPopulation: {
        sourceRows: stopPopulation.sourceRows,
        eligiblePlatformOrStopRows: stopPopulation.eligibleRows,
        uniqueCoordinates: stopPopulation.stops.length,
        duplicateCoordinates: stopPopulation.duplicateCoordinates,
      },
      spur: { minimumMeters: sampling.spurMinMeters, maximumMeters: sampling.spurMaxMeters, patternCounts: spurPatternCounts },
    },
  }
}

// Counts describe generated rows, or additions when extending a saved corpus.
function workloadConfig(args, { extending = false, supplied = false } = {}) {
  const countFlags = ['random-count', 'near-stop-count', 'station-pivot-count']
  const generationFlags = [...countFlags, 'near-stop-min-m', 'near-stop-max-m', 'station-pivot-min-m', 'station-pivot-max-m']
  if (supplied && generationFlags.some(key => args.has(key))) fail('Sampling flags cannot be combined with --reuse-run or --od-file; use --base-od-run to append groups')
  if (['od-mix', 'spur-min-m', 'spur-max-m'].some(key => args.has(key))) fail('Use --random-count, --near-stop-count, --station-pivot-count and their offset ranges instead of legacy mixed-sampling flags')
  const custom = countFlags.some(key => args.has(key))
  const counts = {
    random: parsePositiveInteger(lastArgument(args, 'random-count', extending ? '0' : '1000'), 'random-count', 0),
    near_stop: parsePositiveInteger(lastArgument(args, 'near-stop-count', '0'), 'near-stop-count', 0),
    station_pivot: parsePositiveInteger(lastArgument(args, 'station-pivot-count', extending && custom ? '0' : '1000'), 'station-pivot-count', 0),
  }
  if (extending && counts.random) fail('--base-od-run preserves its street population; --random-count must be 0')
  const ranges = {}
  for (const [type, flag, min, max] of [['near_stop', 'near-stop', 0, 400], ['station_pivot', 'station-pivot', 800, 1200]]) {
    const minimumMeters = finiteNumber(lastArgument(args, `${flag}-min-m`, String(min)))
    const maximumMeters = finiteNumber(lastArgument(args, `${flag}-max-m`, String(max)))
    if (minimumMeters === null || maximumMeters === null || minimumMeters < 0 || maximumMeters < minimumMeters) fail(`Invalid --${flag} offset range: require 0 <= min <= max`)
    ranges[type] = { minimumMeters, maximumMeters }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!supplied && (!Number.isSafeInteger(total) || total <= 0)) fail('At least one OD group must have a positive safe-integer count')
  return { counts, ranges, total }
}

function validateOdPopulation(rows, count) {
  if (rows.length !== count) fail(`OD population has ${rows.length} rows; expected ${count}`)
  const ids = new Set()
  for (const row of rows) {
    if (!['random', 'near_stop', 'station_pivot'].includes(row.odType)) fail(`Unsupported OD type: ${row.odType}`)
    if (!row.id || ids.has(row.id)) fail(`Missing or duplicate OD ID: ${row.id}`)
    ids.add(row.id)
  }
}

function appendWorkload(baseRows, stops, seed, workload) {
  let rows = [...baseRows]
  // Keep the historical random + long-offset sequence and random stream intact.
  for (const type of ['station_pivot', 'near_stop']) {
    const range = workload.ranges[type]
    rows = rows.concat(buildStationPivotRows(stops, workload.counts[type], type === 'near_stop' ? seed ^ 0x6A09E667 : seed,
      range.minimumMeters, range.maximumMeters, rows, type))
  }
  return rows
}

async function generateWorkload(city, seed, outputDirectory, workload, baseOdFile = null, provenance = {}) {
  let baseRows
  let sourceStats = {}
  if (baseOdFile) {
    baseRows = parseOdRows(fs.readFileSync(baseOdFile, 'utf8'))
    validateOdPopulation(baseRows, baseRows.length)
    fs.copyFileSync(baseOdFile, path.join(outputDirectory, 'od-source.csv'))
  } else if (workload.counts.random) {
    const random = await sampleMixedCoordinates(city.osmPath, city.gtfsPaths, workload.counts.random, seed, outputDirectory,
      { mix: { random: 1, stop: 0, spur: 0 }, spurMinMeters: 0, spurMaxMeters: 0 })
    baseRows = random.rows
    sourceStats = Object.fromEntries(['source', 'gtfsSources', 'candidateCoordinates', 'sourceSegments', 'sampledStreetCoordinates'].map(key => [key, random.stats[key]]))
    fs.copyFileSync(random.odPath, path.join(outputDirectory, 'random-od.csv'))
  } else baseRows = []
  const stopPopulation = workload.counts.near_stop || workload.counts.station_pivot ? readGtfsStops(city.gtfsPaths) : { stops: [] }
  const rows = appendWorkload(baseRows, stopPopulation.stops, seed, workload)
  validateOdPopulation(rows, baseRows.length + workload.counts.near_stop + workload.counts.station_pivot)
  const odPath = path.join(outputDirectory, 'od.csv')
  fs.writeFileSync(odPath, serializeOdRows(rows))
  return { odPath, rows, stats: { ...sourceStats, method: 'configurable street and stop-offset populations', seed,
    requestedPairs: rows.length, typeCounts: countOdTypes(rows), sampledCoordinates: rows.length * 2,
    generation: workload, stopPopulation: { ...stopPopulation, stops: undefined },
    ...(baseOdFile ? { base: { source: baseOdFile, preservedPairs: baseRows.length, ...provenance } } : {}) } }
}

function loadOdOverride(odFile, count, outputDirectory, provenance = {}) {
  const rows = parseOdRows(fs.readFileSync(odFile, 'utf8'))
  if (rows.length < count) fail(`OD file ${odFile} contains ${rows.length} rows; ${count} are required`)
  const selected = rows.slice(0, count)
  fs.copyFileSync(odFile, path.join(outputDirectory, 'od-source.csv'))
  const odPath = path.join(outputDirectory, 'od.csv')
  fs.writeFileSync(odPath, serializeOdRows(selected))
  return {
    odPath,
    rows: selected,
    stats: {
      method: provenance.method ?? 'provided OD CSV; deterministic source prefix',
      source: odFile,
      requestedPairs: count,
      sourceRows: rows.length,
      typeCounts: countOdTypes(selected),
      sampledCoordinates: count * 2,
      ...(provenance.reuseRun ? { reuseRun: provenance.reuseRun } : {}),
    },
  }
}

function loadReuseRun(value) {
  const runDirectory = path.resolve(value)
  const summaryPath = path.join(runDirectory, 'summary.json')
  if (!fs.existsSync(summaryPath)) fail(`Reusable benchmark summary not found: ${summaryPath}`)
  let summary
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  } catch (error) {
    fail(`Could not read reusable benchmark summary ${summaryPath}: ${error.message}`)
  }
  const cities = new Map((Array.isArray(summary.cities) ? summary.cities : [])
    .filter((city) => city && typeof city.citySlug === 'string')
    .map((city) => [city.citySlug, city]))
  return { directory: runDirectory, summaryPath, summary, cities }
}

function reuseOdFile(reuseRun, citySlug) {
  const city = reuseRun.cities.get(citySlug)
  if (!city) fail(`Reusable benchmark ${reuseRun.directory} has no city ${citySlug}`)
  const colocated = path.join(reuseRun.directory, citySlug, 'od.csv')
  if (fs.existsSync(colocated)) return colocated
  const recorded = typeof city.od?.path === 'string' ? path.resolve(city.od.path) : null
  if (recorded && fs.existsSync(recorded)) return recorded
  fail(`Reusable O-D CSV not found for ${citySlug}; expected ${colocated}`)
}

function odFileRowCount(odFile) {
  const rows = parseOdRows(fs.readFileSync(odFile, 'utf8'))
  if (!rows.length) fail(`OD file ${odFile} does not contain any rows`)
  return rows.length
}

function reusedPairCount(reuseRun, cities) {
  const recorded = Number(reuseRun.summary.controls?.requestedPairs)
  const sourceCounts = cities.map((city) => odFileRowCount(reuseOdFile(reuseRun, city.slug)))
  if (Number.isInteger(recorded) && recorded > 0) {
    const tooShort = cities.find((city, index) => sourceCounts[index] < recorded)
    if (tooShort) fail(`Reusable O-D CSV for ${tooShort.slug} has fewer than the recorded ${recorded} pairs`)
    return recorded
  }
  if (new Set(sourceCounts).size !== 1) fail('Reusable city O-D files have different row counts; specify --count')
  return sourceCounts[0]
}

function queryRequests(odRows, repeats, cacheMode = 'enabled') {
  return odRows.flatMap((od) => Array.from({ length: repeats }, (_, index) => ({
    id: `${od.id}_run_${index + 1}`,
    odId: od.id,
    repeat: index + 1,
    origin: od.origin,
    destination: od.destination,
    disableCache: cacheMode === 'disabled',
  })))
}

function recursiveSize(directory) {
  if (!directory || !fs.existsSync(directory)) return 0
  const stat = fs.lstatSync(directory)
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 0
  return fs.readdirSync(directory).reduce((total, name) => total + recursiveSize(path.join(directory, name)), 0)
}

function mib(bytes) {
  return bytes === null || bytes === undefined ? null : Number((bytes / 1024 / 1024).toFixed(3))
}

function commonNetworkSize(feedStats, odStats) {
  return {
    street: { nodes: null, edges: null, osmSourceCoordinateOccurrences: odStats.candidateCoordinates ?? null, osmSourceSegments: odStats.sourceSegments ?? null, source: 'engine-specific prepared street counts required; OSM geometry counts are retained separately' },
    transit: { stops: feedStats.totals.stops, routes: feedStats.totals.routes, trips: feedStats.totals.trips, stopTimes: feedStats.totals.stopTimes, connections: null, feeds: feedStats.feeds.length },
  }
}

function vigoNetworkSize(summary, commonSize) {
  const street = summary?.streetStore ?? {}
  const transit = summary?.routingStore ?? {}
  return {
    ...commonSize,
    street: { ...commonSize.street, nodes: finiteNumber(street.nodeCount) ?? commonSize.street.nodes, edges: finiteNumber(street.edgeCount) ?? commonSize.street.edges, source: 'VIGO compiled OSM street store' },
    transit: { ...commonSize.transit, stops: finiteNumber(transit.stopCount) ?? commonSize.transit.stops, routes: finiteNumber(transit.routeCount) ?? commonSize.transit.routes, trips: finiteNumber(transit.tripCount) ?? commonSize.transit.trips, connections: finiteNumber(transit.connectionCount) ?? commonSize.transit.connections },
  }
}

function preparedNetworkSize(payload, commonSize) {
  const network = payload?.network ?? payload?.networkSize
  if (!network || typeof network !== 'object') return commonSize
  return { ...commonSize, ...network, street: { ...commonSize.street, ...(network.street ?? {}) }, transit: { ...commonSize.transit, ...(network.transit ?? {}) } }
}

function resolveVigoCli(args) {
  const configured = lastArgument(args, 'vigo-cli', process.env.VIGO_CLI ?? '')
  const candidates = configured ? [path.resolve(configured)] : [path.join(BENCH_ROOT, '..', 'vigo', 'public', 'vigo.mjs')]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function resolveR5Jar(args) {
  const configured = lastArgument(args, 'r5-jar', process.env.R5_JAR ?? process.env.R5PY_R5_JAR ?? '')
  return configured ? path.resolve(configured) : path.join(BENCH_ROOT, '.engine-tools', 'r5', 'r5-v7.4-r5py-itineraries.jar')
}

function r5Command(context, options, phase, engine) {
  const source = options.r5pySource ?? process.env.VIGO_BENCH_R5PY_SOURCE ?? path.join(BENCH_ROOT, '.engine-tools', 'r5', 'r5py-earliest')
  const required = [options.r5Jar, path.join(source, 'r5py', '_benchmark_itinerary_patch.py')]
  const missing = required.find((candidate) => !fs.existsSync(candidate))
  const env = { ...commonEnvironment(context, phase, engine), VIGO_BENCH_R5_JAR: options.r5Jar,
    VIGO_BENCH_R5PY_SOURCE: source, XDG_CACHE_HOME: path.join(context.workdir, 'r5py-cache') }
  // Retained-graph replay belongs to direct diagnostics; formal runs open
  // the network built by their own preparation phase.
  delete env.VIGO_BENCH_R5_NETWORK
  return {
    command: [options.python, options.r5Adapter],
    env,
    reason: missing ? `R5 runtime artifact is missing: ${missing}. Run npm run setup:expanded-engines -- --engines R5.` : null,
  }
}

function loadEngineConfig(args) {
  const explicit = lastArgument(args, 'engine-config', '')
  const configPath = explicit ? path.resolve(explicit) : path.join(BENCH_ROOT, 'engine-config.json')
  if (!fs.existsSync(configPath)) return { path: null, engines: {} }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  return { path: configPath, engines: parsed.engines ?? parsed }
}

function configForEngine(config, engine) {
  return config.engines[engine] ?? config.engines[engine.toLowerCase()] ?? null
}

function normalizeConfiguredCommand(value) {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length) return value
  if (typeof value === 'string' && value.trim()) return value.trim().split(/\s+/u)
  return null
}

function externalCommand(config, engine, phase) {
  const spec = configForEngine(config, engine)
  if (!spec || typeof spec !== 'object') return { spec: null, command: null, reason: 'adapter command not configured' }
  const loads = new Set(Array.isArray(spec.loads) ? spec.loads.map((value) => String(value).toLowerCase()) : [])
  if (!loads.has('osm') || !loads.has('gtfs')) return { spec, command: null, reason: 'adapter must declare loads including osm and gtfs' }
  const command = normalizeConfiguredCommand(spec[phase] ?? spec.command)
  return command ? { spec, command, reason: null } : { spec, command: null, reason: `adapter ${phase} command not configured` }
}

function commonEnvironment(context, phase, engine) {
  return {
    ...process.env,
    VIGO_BENCH_PHASE: phase,
    VIGO_BENCH_ENGINE: engine,
    VIGO_BENCH_CONTEXT: context.contextPath,
    VIGO_BENCH_CITY: context.city.slug,
    VIGO_BENCH_OSM_PBF: context.city.osmPath ?? '',
    VIGO_BENCH_GTFS_PATHS_JSON: JSON.stringify(context.city.gtfsPaths),
    VIGO_BENCH_GTFS_COUNT: String(context.city.gtfsPaths.length),
    VIGO_BENCH_OD_CSV: context.od.odPath,
    VIGO_BENCH_WORKDIR: context.workdir,
    VIGO_BENCH_NETWORK_DIR: path.join(context.workdir, 'network'),
    VIGO_BENCH_SERVICE_DATE: context.serviceDate ?? '',
    VIGO_BENCH_SERVICE_DAY: context.serviceDay ?? '',
    VIGO_BENCH_TIME: context.time,
    VIGO_BENCH_ROUTING_PREFERENCE: context.routingPreference,
    VIGO_BENCH_MAX_WALK_KM: String(context.maxWalkKm),
    VIGO_BENCH_COMPARISON: JSON.stringify(context.comparison ?? {}),
  }
}

function vigoEnvironment(context, phase, engine, options) {
  return { ...commonEnvironment(context, phase, engine),
    VIGO_BENCH_VIGO_CLI: options.vigoCli,
    VIGO_BENCH_VIGO_COMMAND_JSON: JSON.stringify([process.execPath, options.vigoCli]),
    VIGO_BENCH_PYTHON_SOURCE: options.vigoPythonSource ?? process.env.VIGO_BENCH_PYTHON_SOURCE ?? path.resolve(BENCH_ROOT, '../vigo-py'),
    ...(options.vigoKernel ? { VIGO_NATIVE_ROUTING_KERNEL: options.vigoKernel } : {}),
  }
}

function prepareCommand(engine, context, options) {
  const kind = ENGINE_DEFINITIONS.get(engine).kind
  if (['vigo-python', 'vigo-cli'].includes(kind) && context.routingPreference !== 'fastest') {
    return { command: null, env: null, reason: 'VIGO 0.5 requires earliest_arrival; select --routing-preference fastest for this benchmark.' }
  }
  if (kind === 'vigo-python') return { command: [options.python, path.join(BENCH_ROOT, 'scripts', 'python-api-adapter.py')],
    env: vigoEnvironment(context, 'prepare', engine, options), reason: null }
  if (kind === 'vigo-cli') {
    const command = [process.execPath, options.vigoCli, 'build', '--street-modes=walk', `--osm=${context.city.osmPath}`, `--output=${path.join(context.workdir, 'network')}`]
    for (const gtfsPath of context.city.gtfsPaths) command.push(`--gtfs=${gtfsPath}`)
    return { command, env: vigoEnvironment(context, 'prepare', engine, options), reason: null }
  }
  if (kind === 'r5-raw' || kind === 'r5py') return r5Command(context, options, 'prepare', engine)
  if (kind === 'motis' || kind === 'otp' || kind === 'valhalla') {
    const executable = kind === 'motis' ? options.motisBinary : kind === 'otp' ? options.otpJar : options.valhallaPython
    const command = kind === 'valhalla' ? [options.valhallaPython, options.nativeAdapter] : [options.python, options.nativeAdapter]
    const env = {
      ...commonEnvironment(context, 'prepare', engine),
      VIGO_BENCH_MOTIS_BINARY: options.motisBinary,
      VIGO_BENCH_MOTIS_ROOT: path.dirname(options.motisBinary),
      VIGO_BENCH_OTP_JAR: options.otpJar,
      VIGO_BENCH_VALHALLA_PYTHON: options.valhallaPython,
      VIGO_BENCH_VALHALLA_TIMEZONES: options.valhallaTimezones,
    }
    return { command, env, reason: fs.existsSync(executable) ? null : `${engine} runtime is missing: ${executable}` }
  }
  if (kind === 'ultra-osm') {
    const required = [options.ultraNetwork, options.ultraBinary, options.ultraKernel, options.ultraAddGraph, options.ultraCheckout, options.vigoCli]
    const missing = required.find((candidate) => !fs.existsSync(candidate))
    return {
      command: [process.execPath, options.ultraAdapter],
      env: {
        ...commonEnvironment(context, 'prepare', engine),
        VIGO_BENCH_VIGO_CLI: options.vigoCli,
        VIGO_BENCH_ULTRA_NETWORK: options.ultraNetwork,
        VIGO_BENCH_ULTRA: options.ultraBinary,
        VIGO_BENCH_ULTRA_KERNEL: options.ultraKernel,
        VIGO_BENCH_ULTRA_ADD_GRAPH: options.ultraAddGraph,
        VIGO_BENCH_ULTRA_CHECKOUT: options.ultraCheckout,
      },
      reason: missing ? `ULTRA-OSM runtime artifact is missing: ${missing}` : null,
    }
  }
  if (kind === 'graphhopper') {
    const required = [options.graphhopperAdapter, options.graphhopperJar]
    const missing = required.find((candidate) => !fs.existsSync(candidate))
    return {
      command: [options.python, options.graphhopperAdapter],
      env: { ...commonEnvironment(context, 'prepare', engine), VIGO_BENCH_GRAPHHOPPER_JAR: options.graphhopperJar },
      reason: missing ? `GraphHopper runtime artifact is missing: ${missing}` : null,
    }
  }
  const configured = externalCommand(options.engineConfig, engine, 'prepare')
  return { command: configured.command, env: commonEnvironment(context, 'prepare', engine), reason: configured.reason }
}

function queryCommand(engine, context, options, preparedPayload) {
  const kind = ENGINE_DEFINITIONS.get(engine).kind
  if (['vigo-cli', 'vigo-python'].includes(kind) && (preparedPayload?.schemaVersion !== 'vigo.city.v1'
    || !/^0\.5\.\d+(?:$|[-+])/u.test(preparedPayload?.productVersion ?? ''))) {
    return { command: null, env: null, reason: 'VIGO requires a current City built with Engine 0.5 (vigo.city.v1); rebuild with the selected runtime.' }
  }
  if (kind === 'vigo-python') return { command: [options.python, path.join(BENCH_ROOT, 'scripts', 'python-api-adapter.py')],
    env: vigoEnvironment(context, 'query', engine, options), reason: null }
  if (kind === 'vigo-cli') {
    const output = options.vigoCapabilities?.output?.streamFormats?.includes('detailed') ? '--stream-output=detailed' : '--diagnostics=trace'
    return { command: [process.execPath, options.vigoCli, 'stream', output, `--city=${path.join(context.workdir, 'network')}`], env: vigoEnvironment(context, 'query', engine, options), reason: null }
  }
  if (kind === 'r5-raw' || kind === 'r5py') return r5Command(context, options, 'query', engine)
  if (kind === 'motis' || kind === 'otp' || kind === 'valhalla') {
    const executable = kind === 'motis' ? options.motisBinary : kind === 'otp' ? options.otpJar : options.valhallaPython
    const command = kind === 'valhalla' ? [options.valhallaPython, options.nativeAdapter] : [options.python, options.nativeAdapter]
    const env = {
      ...commonEnvironment(context, 'query', engine),
      VIGO_BENCH_MOTIS_BINARY: options.motisBinary,
      VIGO_BENCH_MOTIS_ROOT: path.dirname(options.motisBinary),
      VIGO_BENCH_OTP_JAR: options.otpJar,
      VIGO_BENCH_VALHALLA_PYTHON: options.valhallaPython,
      VIGO_BENCH_VALHALLA_TIMEZONES: options.valhallaTimezones,
    }
    return { command, env, reason: fs.existsSync(executable) ? null : `${engine} runtime is missing: ${executable}` }
  }
  if (kind === 'ultra-osm') {
    const required = [options.ultraNetwork, options.ultraBinary, options.ultraKernel, options.ultraAddGraph, options.ultraCheckout, options.vigoCli]
    const missing = required.find((candidate) => !fs.existsSync(candidate))
    return {
      command: [process.execPath, options.ultraAdapter],
      env: {
        ...commonEnvironment(context, 'query', engine),
        VIGO_BENCH_VIGO_CLI: options.vigoCli,
        VIGO_BENCH_ULTRA_NETWORK: options.ultraNetwork,
        VIGO_BENCH_ULTRA: options.ultraBinary,
        VIGO_BENCH_ULTRA_KERNEL: options.ultraKernel,
        VIGO_BENCH_ULTRA_ADD_GRAPH: options.ultraAddGraph,
        VIGO_BENCH_ULTRA_CHECKOUT: options.ultraCheckout,
      },
      reason: missing ? `ULTRA-OSM runtime artifact is missing: ${missing}` : null,
    }
  }
  if (kind === 'graphhopper') {
    const required = [options.graphhopperAdapter, options.graphhopperJar]
    const missing = required.find((candidate) => !fs.existsSync(candidate))
    return {
      command: [options.python, options.graphhopperAdapter],
      env: { ...commonEnvironment(context, 'query', engine), VIGO_BENCH_GRAPHHOPPER_JAR: options.graphhopperJar },
      reason: missing ? `GraphHopper runtime artifact is missing: ${missing}` : null,
    }
  }
  const configured = externalCommand(options.engineConfig, engine, 'query')
  return { command: configured.command, env: commonEnvironment(context, 'query', engine), reason: configured.reason }
}

function emptyEngineRow(context, engine, status, reason) {
  const gtfsPaths = context.city.gtfsPaths ?? []
  return {
    city: context.city.label,
    citySlug: context.city.slug,
    engine,
    feed: gtfsPaths.map((filePath) => path.basename(filePath)).join(' + '),
    feeds: gtfsPaths.map((filePath) => path.basename(filePath)),
    inputContract: ['OSM street graph', 'all GTFS ZIPs in city folder'],
    status,
    timingContract: TIMING_CONTRACT,
    blockedReason: reason ?? null,
    coldPrep: { status, ms: null },
    coldPrepRss: { bytes: null, MiB: null },
    hotQueryRss: { bytes: null, MiB: null },
    peakRss: { bytes: null, MiB: null },
    storage: { bytes: null, MiB: null },
    hot: timingSummary([], new Map()),
    byOdType: {},
    meanWarmQueryMs: null,
    counts: { ready: 0, blocked: 0, errors: 0 },
    setupErrors: 0,
    unsubmittedQueries: context.requests?.length ?? 0,
    networkSize: context.commonNetworkSize ?? null,
    errors: [],
  }
}

async function runEngine(context, engine, options) {
  const engineStarted = performance.now()
  const workdir = path.join(context.cityDirectory, engine.toLowerCase().replaceAll(/[^a-z0-9]+/giu, '-'))
  context.workdir = workdir
  fs.mkdirSync(workdir, { recursive: true })
  const row = emptyEngineRow(context, engine, 'blocked', null)
  row.workdir = workdir
  const progressCounts = { ready: 0, blocked: 0, errors: 0 }
  const checkpoint = createProgressCheckpoint(path.join(workdir, 'progress.json'))
  const progress = (phase, completed = 0, status = 'running') => checkpoint({
    phase, engine, city: context.city.slug, completed, total: context.requests.length, updatedAt: new Date().toISOString(), status,
    counts: progressCounts, submittedQueries: completed, unsubmittedQueries: context.requests.length - completed,
    coldPrep: phase === 'prepare' ? { status: 'running', ms: null } : row.coldPrep,
    coldPrepRss: row.coldPrepRss, peakRss: row.peakRss, setupErrors: row.setupErrors,
  })
  const finish = (observations = []) => {
    row.lifecycle = {
      elapsedMs: performance.now() - engineStarted,
      preparationMs: row.coldPrep.ms,
      queryProcessMs: row.round?.queryProcessMs ?? null,
      boundary: 'engine lane entry through final summary preparation; includes setup, querying, evidence/progress writes, and post-query aggregation; excludes final summary write',
    }
    writeJsonAtomic(path.join(workdir, 'summary.json'), row)
    progress(row.status === 'error' ? 'error' : 'complete', observations.length, row.status)
    return { row, observations }
  }
  progress('prepare')
  const prep = prepareCommand(engine, context, options)
  if (prep.reason) {
    row.blockedReason = prep.reason
    row.unsubmittedQueries = context.requests.length
    row.adapter = { configured: false, kind: ENGINE_DEFINITIONS.get(engine).kind, inputContract: ENGINE_DEFINITIONS.get(engine).inputContract }
    return finish()
  }
  row.adapter = { configured: true, kind: ENGINE_DEFINITIONS.get(engine).kind, inputContract: ENGINE_DEFINITIONS.get(engine).inputContract }
  try { checkPreparationSpace(workdir) }
  catch (error) {
    row.status = 'error'
    row.setupErrors = 1
    row.unsubmittedQueries = context.requests.length
    row.coldPrep = { status: 'error', ms: null }
    row.errors.push(error.message)
    return finish()
  }
  if (['VIGO', 'VIGO-py'].includes(engine)) {
    const started = performance.now()
    try {
      row.runtime = { capabilities: checkVigoRuntime(options.vigoCli, options.vigoKernel),
        command: [process.execPath, options.vigoCli], kernel: options.vigoKernel ?? null,
        checkMs: performance.now() - started }
    } catch (error) {
      row.status = 'error'
      row.setupErrors = 1
      row.unsubmittedQueries = context.requests.length
      row.coldPrep = { status: 'not_run', ms: null }
      row.errors.push(error.message)
      return finish()
    }
  }
  process.stderr.write(`[${new Date().toISOString()}] ${context.city.slug}/${engine} building fresh network\n`)
  const prepResult = await runSimpleCommand(prep.command, { cwd: workdir, env: prep.env,
    stdoutPath: path.join(workdir, 'prepare.stdout'), stderrPath: path.join(workdir, 'prepare.stderr') })
  if (prepResult.interruptionSignal) {
    row.status = 'error'
    row.setupErrors = 1
    row.unsubmittedQueries = context.requests.length
    row.errors.push(`Preparation interrupted by ${prepResult.interruptionSignal}`)
    row.coldPrep = { status: 'interrupted', ms: prepResult.elapsedMs, command: prepResult.command }
    row.coldPrepRss = { bytes: prepResult.maxRssBytes, MiB: mib(prepResult.maxRssBytes) }
    finish()
    throw Object.assign(new Error(row.errors[0]), { code: 'BENCHMARK_INTERRUPTED' })
  }
  const prepPayload = parseJsonOutput(prepResult.stdout)
  row.coldPrep = { status: prepResult.code === 0 && !prepResult.error ? 'ready' : 'error', ms: Number(prepResult.elapsedMs.toFixed(3)), command: prepResult.command }
  row.coldPrepRss = { bytes: prepResult.maxRssBytes, MiB: mib(prepResult.maxRssBytes) }
  if (prepResult.code !== 0 || prepResult.error) {
    row.status = 'error'
    row.errors = [prepResult.error?.message ?? prepResult.stderr.trim() ?? `prepare exited with ${prepResult.code ?? 'unknown error'}`]
    row.setupErrors = 1
    const bytes = recursiveSize(workdir)
    row.storage = { bytes, MiB: mib(bytes) }
    row.peakRss = row.coldPrepRss
    return finish()
  }
  row.status = 'ready'
  row.blockedReason = null
  row.preparation = prepPayload
  row.networkSize = ENGINE_DEFINITIONS.get(engine).kind === 'vigo-cli' ? vigoNetworkSize(prepPayload, context.commonNetworkSize) : preparedNetworkSize(prepPayload, context.commonNetworkSize)
  const street = row.networkSize.street
  const missingStreet = [street.nodes, street.edges].some((value) => value !== null && value !== undefined && !(value > 0))
    || ((street.nodes == null || street.edges == null) && street.source === context.commonNetworkSize.street.source)
  if (missingStreet || !(row.networkSize.transit.stops > 0 && row.networkSize.transit.trips > 0)) {
    row.status = 'error'
    row.setupErrors = 1
    row.unsubmittedQueries = context.requests.length
    row.errors.push('Preparation must build OSM streets and GTFS transit. Unexposed counts must have explicit import evidence.')
    const bytes = recursiveSize(workdir)
    row.storage = { bytes, MiB: mib(bytes) }
    row.peakRss = row.coldPrepRss
    return finish()
  }
  row.requiredInputs = { osm: context.city.osmPath, gtfs: context.city.gtfsPaths, preparationLog: 'prepare.stdout + prepare.stderr' }
  const query = queryCommand(engine, context, { ...options, vigoCapabilities: row.runtime?.capabilities }, prepPayload)
  if (query.reason) {
    row.status = 'error'
    row.setupErrors = 1
    row.errors.push(query.reason)
    row.unsubmittedQueries = context.requests.length
    return finish()
  }
  const requestById = new Map(context.requests.map((request) => [request.id, request]))
  const odById = new Map(context.od.rows.map((od) => [od.id, od]))
  const decorateObservation = (observation) => {
    const request = requestById.get(observation.id)
    const od = odById.get(request?.odId)
    return {
      ...observation,
      city: context.city.slug,
      engine,
      odId: request?.odId ?? null,
      odType: od?.odType ?? 'unlabeled',
      spurPattern: od?.spurPattern ?? null,
      originOffsetMeters: od?.originOffsetMeters ?? null,
      destinationOffsetMeters: od?.destinationOffsetMeters ?? null,
      repeat: request?.repeat ?? null,
      origin: request?.origin ?? null,
      destination: request?.destination ?? null,
    }
  }
  progress('query')
  process.stderr.write(`[${new Date().toISOString()}] ${context.city.slug}/${engine} routing ${context.requests.length} requests\n`)
  let queryResult
  try {
  queryResult = await runNdjsonCommand(query.command, context.requests, { cwd: workdir, env: query.env, label: `${context.city.slug}/${engine}`,
    ...(['VIGO', 'VIGO-py'].includes(engine) ? { encodeRequest: request => vigoRouteRequest(request, context) } : {}),
    queryTimeoutMs: options.queryTimeoutMs, decorateObservation,
    onProgress: ({ completed, observation }) => {
      progressCounts[observation.status === 'error' ? 'errors' : observation.status] += 1
      progress('query', completed)
    },
    stderrPath: path.join(workdir, 'query.stderr'), observationsPath: path.join(workdir, 'queries.ndjson') })
  } catch (error) {
    if (error.code === 'BENCHMARK_INTERRUPTED') {
      row.status = 'error'
      row.errors.push(error.message)
      row.counts = { ...progressCounts }
      row.unsubmittedQueries = context.requests.length - error.observations.length
      row.hot = timingSummary(error.observations, requestById)
      row.queryProcess = { status: 'interrupted', elapsedMs: error.process.elapsedMs, signal: error.signal }
      finish(error.observations)
    }
    throw error
  }
  const observations = queryResult.observations
  const counts = observations.reduce((result, observation) => { result[observation.status] += 1; return result }, { ready: 0, blocked: 0, error: 0 })
  row.counts = { ready: counts.ready, blocked: counts.blocked, errors: counts.error }
  const rejectedCandidates = observations.filter(observation => observation.status === 'blocked' && observation.outcomeReason === 'native_candidate_rejected').length
  row.blockedBreakdown = { nativeNoItinerary: counts.blocked - rejectedCandidates, nativeCandidateRejected: rejectedCandidates }
  row.unsubmittedQueries = context.requests.length - observations.length
  row.hot = timingSummary(observations, requestById)
  const allWall = timingDistribution(observations, 'wallMs', true)
  const allDeclared = timingDistribution(observations, 'queryMs', true)
  const endToEndSum = row.hot.endToEnd.sumMs
  row.round = {
    submittedRequests: observations.length,
    observations: observations.length,
    repeatsPerPair: options.repeats,
    queryProcessMs: queryResult.process.elapsedMs,
    runnerWallSumMs: allWall.sumMs,
    adapterComputeSumMs: allDeclared.sumMs,
    adapterDeclaredSumMs: allDeclared.sumMs,
    adapterDeclaredSamples: allDeclared.samples,
    adapterDeclaredCoverage: allDeclared.coverage,
    endToEndSumMs: endToEndSum,
    adapterOverheadSumMs: row.hot.adapterOverhead.sumMs,
    adapterOverheadSamples: row.hot.adapterOverhead.samples,
    firstRequestStartedMs: queryResult.process.firstRequestStartedMs,
    outsideRequestMs: endToEndSum === null ? null : queryResult.process.elapsedMs - endToEndSum,
    amortizedProcessMsPerRequest: observations.length ? queryResult.process.elapsedMs / observations.length : null,
    processRequestsPerSecond: observations.length && queryResult.process.elapsedMs > 0 ? observations.length * 1000 / queryResult.process.elapsedMs : null,
    readyRoutesPerSecond: observations.length && queryResult.process.elapsedMs > 0 ? counts.ready * 1000 / queryResult.process.elapsedMs : null,
    endToEndCoverage: row.hot.endToEnd.coverage,
    preparationAndQueryMs: prepResult.elapsedMs + queryResult.process.elapsedMs,
    amortizedPreparationAndQueryMsPerRequest: observations.length ? (prepResult.elapsedMs + queryResult.process.elapsedMs) / observations.length : null,
    complete: observations.length === context.requests.length && queryResult.process.code === 0 && !queryResult.process.timedOut,
    runtimeOpenMs: observations[0]?.timing?.openMs ?? null,
    boundary: TIMING_CONTRACT.process,
  }
  if (['vigo-cli', 'vigo-python'].includes(ENGINE_DEFINITIONS.get(engine).kind)) {
    const ready = observations.filter(row => row.status === 'ready')
    row.streetCache = {
      requestedDisabled: options.cacheMode === 'disabled',
      readyAcknowledgedDisabled: ready.filter(row => row.nativeStreetPathCacheDisabled === true).length,
      readyUnacknowledged: ready.filter(row => row.nativeStreetPathCacheDisabled !== true).length,
      hits: observations.reduce((sum, row) => sum + (row.nativeStreetPathCacheHits ?? 0), 0),
    }
    if (row.streetCache.requestedDisabled && (row.streetCache.readyUnacknowledged || row.streetCache.hits)) {
      row.errors.push('Requested disabled street caches were not acknowledged on all ready routes or reported hits.')
    }
    row.executionContract = {
      citySchema: prepPayload.schemaVersion,
      productVersion: prepPayload.productVersion,
      pythonRuntime: prepPayload.pythonRuntime ?? null,
      objective: 'earliest_arrival',
      transport: engine === 'VIGO' ? (query.command.includes('--stream-output=detailed') ? 'resident stream CLI with lossless detailed evidence, no duplicate public projection' : 'public stream CLI with explicit route queries and trace evidence') : 'public Python City.route and Result.to_json through the resident runtime',
      resultCache: 'absent; street-cache acknowledgement is recorded separately',
      preparedNetworkReused: false,
    }
  }
  row.byOdType = summarizeByOdType(observations, requestById)
  row.meanWarmQueryMs = row.hot.meanWarmQueryMs
  row.hotQueryRss = { bytes: queryResult.process.maxRssBytes, MiB: mib(queryResult.process.maxRssBytes) }
  const rssValues = [prepResult.maxRssBytes, queryResult.process.maxRssBytes].filter(Number.isFinite)
  const peak = rssValues.length ? Math.max(...rssValues) : null
  row.peakRss = { bytes: peak, MiB: mib(peak) }
  const bytes = recursiveSize(workdir)
  row.storage = { bytes, MiB: mib(bytes) }
  row.queryProcess = { status: queryResult.process.code === 0 && !queryResult.process.timedOut ? 'complete' : 'error', elapsedMs: Number(queryResult.process.elapsedMs.toFixed(3)), exitCode: queryResult.process.code, signal: queryResult.process.signal, timedOut: queryResult.process.timedOut, error: queryResult.process.error, stderr: queryResult.process.stderr.trim() || null }
  if (counts.error) row.errors.push(`${counts.error} query response(s) returned an error`)
  if (row.unsubmittedQueries) row.errors.push(`${row.unsubmittedQueries} query request(s) were not submitted`)
  if (queryResult.process.code !== 0) row.errors.push(`query process exited with ${queryResult.process.code ?? queryResult.process.signal ?? 'unknown error'}`)
  if (queryResult.process.timedOut) row.errors.push(`query process exceeded the configured ${options.queryTimeoutMs} ms deadline`)
  if (row.errors.length) row.status = 'error'
  return finish(observations)
}

function contextForCity(city, cityDirectory, od, feedStats, serviceDate, serviceDay, options) {
  const context = { comparison: options.comparison, city, cityDirectory, od, feedStats, serviceDate, serviceDay, time: options.time, routingPreference: options.routingPreference, maxWalkKm: options.maxWalkKm, cacheMode: options.cacheMode, commonNetworkSize: commonNetworkSize(feedStats, od.stats), requests: queryRequests(od.rows, options.repeats, options.cacheMode), contextPath: path.join(cityDirectory, 'context.json') }
  fs.writeFileSync(context.contextPath, `${JSON.stringify({ comparison: options.comparison, schemaVersion: 'vigo.coordinate-benchmark.context.v3', city: { slug: city.slug, label: city.label }, osm: city.osmPath, gtfs: city.gtfsPaths, od: od.stats, serviceDate, serviceDay, time: options.time, routingPreference: options.routingPreference, maxWalkKm: options.maxWalkKm, cacheMode: options.cacheMode, repeats: options.repeats, queryCount: context.requests.length }, null, 2)}\n`)
  return context
}

function outputRunDirectory(base, explicit) {
  if (explicit) {
    const directory = path.resolve(explicit)
    if (fs.existsSync(directory) && (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length)) fail(`Run directory must be new or empty; refusing to overwrite retained evidence: ${directory}`)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-').replace(/Z$/u, '')
  const directory = path.join(path.resolve(base), `run-${stamp}-${process.pid}`)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function usage() {
  return [
    'VIGO coordinate benchmark',
    '',
    'Usage:',
    '  npm run bench -- [options]',
    '',
    'Options:',
    '  --check                 Validate inputs and runtime prerequisites without building',
    '  --generate-only         Save ODs, controls and input identity without running engines',
    '  --input-root PATH       City folders containing one .pbf and one or more .zip files',
    '  --cities a,b            Restrict the run to city-folder slugs',
    '  --engine NAME           Run exactly one engine',
    '  --engine-order VALUE    seeded (default) or listed; executed order is retained',
    '  --engines a,b           Run an engine list (default: all engines)',
    "  --reuse-run PATH        Reuse each selected city's OD and controls from a prior run",
    "  --base-od-run PATH       Preserve a prior OD set and append stop-offset groups",
    '  --station-pivot-count N Long-offset pairs (default: 1000; extension custom: 0)',
    '  --station-pivot-min-m N Minimum offset from each stop anchor (default: 800)',
    '  --station-pivot-max-m N Maximum offset from each stop anchor (default: 1200)',
    '  --random-count N        Street pairs (default: 1000; extension: 0)',
    '  --near-stop-count N     Near-stop pairs (default: 0)',
    '  --near-stop-min-m N     Minimum near-stop offset (default: 0)',
    '  --near-stop-max-m N     Maximum near-stop offset (default: 400)',
    '  --count N               Optional total check; supplied CSV prefix length',
    '  --repeats N             Exactly 1: one full-itinerary query per OD',
    '  --cache-mode VALUE      native, enabled or disabled (default: reused value or native)',
    '  --seed N                Sampling seed (default: reused value or 20260816)',
    '  --service-date DATE     Exact YYYY-MM-DD; otherwise reused or inferred from GTFS',
    '  --service-day VALUE     weekday, saturday, or sunday; otherwise reused or derived',
    '  --time HH:MM            Fixed departure time (default: reused value or 08:00)',
    '  --routing-preference V  balanced or fastest (default: reused value or fastest; VIGO requires fastest)',
    '  --max-transfers N       Maximum vehicle changes (default: 3)',
    '  --horizon MIN           Requested complete-journey horizon (default: 240)',
    '  --max-walk KM           Coordinate access budget (default: reused value or 1.2)',
    '  --output-dir PATH       Parent for timestamped results (default: results)',
    '  --run-dir PATH          Write this run to an explicit directory',
    '  --query-timeout-ms N    Per-request and shutdown deadline; 0 disables (default: 0)',
    '  --od-file PATH          Use one explicit OD CSV; count defaults to all rows',
    '  --vigo-cli PATH         Current VIGO public/vigo.mjs',
    '  --vigo-kernel PATH      Native addon for that CLI (otherwise resolved beside it)',
    '  --vigo-python-source PATH  Current vigo-py checkout (default: sibling vigo-py)',
    '  --python PATH           Python executable (default: python3)',
    '  --r5-jar PATH           R5/R5py runtime JAR',
    '  --r5py-source PATH      Corrected r5py source directory',
    '  --motis-binary PATH     MOTIS executable',
    '  --otp-jar PATH          OTP shaded JAR',
    '  --valhalla-python PATH  Python interpreter with native Valhalla',
    '  --valhalla-timezones PATH  Valhalla timezones.sqlite',
    '  --ultra-checkout PATH   ULTRA source checkout',
    '  --ultra-network PATH    ULTRA Network executable',
    '  --ultra-binary PATH     ULTRA preprocessing executable',
    '  --ultra-kernel PATH     ULTRA coordinate query executable',
    '  --ultra-add-graph PATH  ULTRA OSM graph merger executable',
    '  --graphhopper-jar PATH  GraphHopper web JAR',
    '  --engine-config PATH    JSON adapter map for external engines',
    '',
    'Custom adapter protocol:',
    '  A configured command runs with VIGO_BENCH_PHASE=prepare and then query. It must',
    '  declare loads: ["osm", "gtfs"]. Prepare prints one JSON object; query reads one',
    '  JSON request per stdin line and prints one JSON response per line.',
    '',
  ].join('\n')
}

export { workloadConfig, appendWorkload, generateWorkload, validateOdPopulation, DEFAULT_ENGINES, DEFAULT_OD_MIX, ENGINE_DEFINITIONS, TIMING_CONTRACT, allocateOdCounts, buildServiceModel, buildStationPivotRows, commonNetworkSize, destinationPoint, discoverCities, extractGtfsStops, haversineDistanceMeters, inferServiceDate, inferServiceDay, loadReuseRun, normalizeObservation, outputRunDirectory, parseArguments, parseCsv, parseOdMix, parseOdRows, percentile, prepareCommand, queryCommand, queryRequests, readGtfsStops, reusedPairCount, reuseOdFile, runEngine, runNdjsonCommand, sampleMixedCoordinates, selectedEngines, serializeOdRows, summarizeByOdType, timingSummary }

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.has('help')) { process.stdout.write(usage()); return }
  const inputRoot = path.resolve(lastArgument(args, 'input-root', DEFAULT_INPUT_ROOT))
  const requestedSlugs = lastArgument(args, 'cities', '').split(',').map((value) => value.trim()).filter(Boolean)
  const cities = discoverCities(inputRoot, requestedSlugs)
  const odFileArgument = lastArgument(args, 'od-file', '')
  const reuseRunArgument = lastArgument(args, 'reuse-run', '')
  const baseOdRunArgument = lastArgument(args, 'base-od-run', '')
  if ([odFileArgument, reuseRunArgument, baseOdRunArgument].filter(Boolean).length > 1) fail('Use only one of --od-file, --reuse-run, or --base-od-run')
  if (args.has('count') && baseOdRunArgument) fail('--count cannot be combined with --base-od-run; the total is the base rows plus the added group counts')
  const explicitOdFile = odFileArgument ? path.resolve(odFileArgument) : null
  if (explicitOdFile && !fs.existsSync(explicitOdFile)) fail(`OD file not found: ${explicitOdFile}`)
  const reuseRun = reuseRunArgument ? loadReuseRun(reuseRunArgument) : null
  const baseOdRun = baseOdRunArgument ? loadReuseRun(baseOdRunArgument) : null
  const controlRun = reuseRun ?? baseOdRun
  const reusedControls = controlRun?.summary.controls ?? {}
  const workload = workloadConfig(args, { extending: Boolean(baseOdRun), supplied: Boolean(reuseRun || explicitOdFile) })
  const basePairCount = baseOdRun ? reusedPairCount(baseOdRun, cities) : 0
  const defaultCount = baseOdRun ? basePairCount + workload.total : reuseRun ? reusedPairCount(reuseRun, cities) : explicitOdFile ? odFileRowCount(explicitOdFile) : workload.total
  const count = parsePositiveInteger(lastArgument(args, 'count', String(defaultCount)), 'count')
  if (!reuseRun && !explicitOdFile && count !== defaultCount) fail('--count must equal the sum of the group counts; customize --random-count, --near-stop-count and --station-pivot-count')
  const repeats = parsePositiveInteger(lastArgument(args, 'repeats', '1'), 'repeats')
  const queryTimeoutMs = parsePositiveInteger(lastArgument(args, 'query-timeout-ms', '0'), 'query-timeout-ms', 0)
  if (queryTimeoutMs > 2_147_483_647) fail('--query-timeout-ms must be <= 2147483647')
  if (repeats !== 1) fail('The coordinate itinerary benchmark requires one query per pair.')
  const cacheMode = lastArgument(args, 'cache-mode', String(reusedControls.cacheMode ?? 'native'))
  if (!['native', 'enabled', 'disabled'].includes(cacheMode)) fail('--cache-mode must be native, enabled or disabled')
  const seed = parseSeed(lastArgument(args, 'seed', String(reusedControls.seed ?? 20260816)))
  const time = lastArgument(args, 'time', String(reusedControls.time ?? '08:00'))
  if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(time)) fail('--time must be HH:MM')
  const routingPreference = lastArgument(args, 'routing-preference', String(reusedControls.routingPreference ?? 'fastest'))
  if (!['balanced', 'fastest'].includes(routingPreference)) fail('--routing-preference must be balanced or fastest')
  const maxWalkKm = finiteNumber(lastArgument(args, 'max-walk', String(reusedControls.maxWalkKm ?? 1.2)))
  if (maxWalkKm === null || maxWalkKm <= 0) fail('--max-walk must be a positive number')
  const maxTransfers = parsePositiveInteger(lastArgument(args, 'max-transfers', String(reusedControls.comparison?.maxTransfers ?? 3)), 'max-transfers', 0)
  const horizonMinutes = parsePositiveInteger(lastArgument(args, 'horizon', String(reusedControls.comparison?.horizonMinutes ?? 240)), 'horizon')
  const walkSpeedKph = 4.8
  if (maxTransfers > 31 || horizonMinutes > 2880) fail('max-transfers must be <=31 and horizon <=2880 minutes')
  const comparison = { requireTransitRide: true, maxTransfers, horizonMinutes, walkSpeedKph, transferSlackSeconds: 0, output: 'itinerary', endpointAccess: 'OSM', departureWindowSeconds: 0 }
  const engineConfig = loadEngineConfig(args)
  const engineOrder = lastArgument(args, 'engine-order', 'seeded')
  if (!['seeded', 'listed'].includes(engineOrder)) fail('--engine-order must be seeded or listed')
  const selected = args.has('generate-only') ? [] : selectedEngines(args, engineConfig)
  const engines = engineOrder === 'seeded' ? shuffle(selected, mulberry32(seed ^ 0x3C6EF372)) : selected
  for (const engine of engines) {
    if (!ENGINE_DEFINITIONS.has(engine)) ENGINE_DEFINITIONS.set(engine, { kind: 'external', inputContract: ['osm', 'gtfs'] })
  }
  const vigoCli = resolveVigoCli(args)
  const options = {
    time,
    routingPreference,
    maxWalkKm,
    repeats,
    queryTimeoutMs,
    cacheMode,
    comparison,
    vigoCli,
    vigoKernel: resolveVigoKernel(vigoCli, lastArgument(args, 'vigo-kernel', process.env.VIGO_NATIVE_ROUTING_KERNEL ?? '')),
    vigoPythonSource: path.resolve(lastArgument(args, 'vigo-python-source', process.env.VIGO_BENCH_PYTHON_SOURCE ?? path.resolve(BENCH_ROOT, '../vigo-py'))),
    python: lastArgument(args, 'python', process.env.PYTHON ?? 'python3'),
    nativeAdapter: path.join(BENCH_ROOT, 'scripts', 'native-engine-adapter.py'),
    r5Adapter: path.join(BENCH_ROOT, 'scripts', 'r5-engine-adapter.py'),
    ultraAdapter: path.join(BENCH_ROOT, 'scripts', 'ultra-engine-adapter.mjs'),
    r5Jar: resolveR5Jar(args),
    r5pySource: path.resolve(lastArgument(args, 'r5py-source', process.env.VIGO_BENCH_R5PY_SOURCE ?? path.join(BENCH_ROOT, '.engine-tools', 'r5', 'r5py-earliest'))),
    motisBinary: path.resolve(lastArgument(args, 'motis-binary', process.env.MOTIS_BINARY ?? path.join(BENCH_ROOT, '.engine-tools', 'motis', 'motis'))),
    otpJar: path.resolve(lastArgument(args, 'otp-jar', process.env.OTP_JAR ?? path.join(BENCH_ROOT, '.engine-tools', 'otp', 'otp-shaded.jar'))),
    valhallaPython: path.resolve(lastArgument(args, 'valhalla-python', process.env.VALHALLA_PYTHON ?? path.join(BENCH_ROOT, '.engine-tools', 'valhalla-venv', 'bin', 'python'))),
    valhallaTimezones: path.resolve(lastArgument(args, 'valhalla-timezones', process.env.VALHALLA_TIMEZONES ?? path.join(BENCH_ROOT, '.engine-tools', 'valhalla-resources', 'timezones.sqlite'))),
    ultraCheckout: path.resolve(lastArgument(args, 'ultra-checkout', process.env.ULTRA_CHECKOUT ?? path.join(BENCH_ROOT, '.engine-tools', 'ultra'))),
    ultraNetwork: path.resolve(lastArgument(args, 'ultra-network', process.env.ULTRA_NETWORK ?? path.join(BENCH_ROOT, '.engine-tools', 'ultra', 'cmake-build-release2', 'Network-directed'))),
    ultraBinary: path.resolve(lastArgument(args, 'ultra-binary', process.env.ULTRA_BINARY ?? path.join(BENCH_ROOT, '.engine-tools', 'ultra', 'cmake-build-release2', 'ULTRA'))),
    ultraKernel: path.resolve(lastArgument(args, 'ultra-kernel', process.env.ULTRA_KERNEL ?? path.join(BENCH_ROOT, '.engine-tools', 'ultra', 'cmake-build-release2', 'ULTRA-OSM-Kernel'))),
    ultraAddGraph: path.resolve(lastArgument(args, 'ultra-add-graph', process.env.ULTRA_ADD_GRAPH ?? path.join(BENCH_ROOT, '.engine-tools', 'ultra', 'cmake-build-release2', 'ULTRA-OSM-AddGraph'))),
    graphhopperAdapter: path.join(BENCH_ROOT, 'scripts', 'graphhopper-engine-adapter.py'),
    graphhopperJar: path.resolve(lastArgument(args, 'graphhopper-jar', process.env.GRAPHHOPPER_JAR ?? path.join(BENCH_ROOT, '.engine-tools', 'graphhopper', 'graphhopper-walk-speed.jar'))),
    engineConfig,
  }
  if (args.has('check')) {
    const checks = []
    const executableChecks = new Map()
    const commandReady = command => {
      if (executableChecks.has(command)) return executableChecks.get(command)
      const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000 })
      const ready = !result.error && result.status === 0
      executableChecks.set(command, ready)
      return ready
    }
    for (const city of cities) {
      const issues = [...city.inputErrors]
      for (const executable of ['unzip', ...(reuseRun || explicitOdFile ? [] : ['osmium'])]) {
        // unzip uses -v rather than --version.
        const result = spawnSync(executable, [executable === 'unzip' ? '-v' : '--version'], { encoding: 'utf8', timeout: 10000 })
        if (result.error || result.status !== 0) issues.push(`Missing executable: ${executable}`)
      }
      const context = { city, workdir: path.join(city.directory, '.preflight'), contextPath: '', od: { odPath: '' }, routingPreference, maxWalkKm, time }
      const runtime = engines.map(engine => {
        const prep = prepareCommand(engine, context, options)
        const reasons = prep.reason ? [prep.reason] : []
        if (prep.command && !commandReady(prep.command[0])) reasons.push(`Interpreter unavailable: ${prep.command[0]}`)
        if (['VIGO', 'VIGO-py'].includes(engine)) {
          try { checkVigoRuntime(vigoCli, options.vigoKernel) } catch (error) { reasons.push(error.message) }
        }
        if (engine === 'VIGO-py' && !fs.existsSync(path.join(options.vigoPythonSource, 'vigo', '__init__.py'))) {
          reasons.push(`VIGO-py source missing: ${options.vigoPythonSource}`)
        }
        if (['OTP', 'GraphHopper', 'R5', 'R5py'].includes(engine) && !commandReady('java')) reasons.push('Java unavailable')
        return { engine, ready: !reasons.length, reasons }
      })
      if (!city.inputErrors.length) {
        try { const feeds = await readFeedStats(city.gtfsPaths); inferServiceDate(feeds, lastArgument(args, 'service-date', '')) }
        catch (error) { issues.push(error.message) }
      }
      checks.push({ city: city.slug, issues, runtimes: runtime })
    }
    const ready = checks.every(city => !city.issues.length && city.runtimes.every(runtime => runtime.ready))
    process.stdout.write(JSON.stringify({ ready, checks, limitation: 'Checks files, interpreters and feed metadata; does not prove native imports or routing success.' }, null, 2) + '\n')
    if (!ready) process.exitCode = 1
    return
  }
  const outputDirectory = outputRunDirectory(lastArgument(args, 'output-dir', path.join(BENCH_ROOT, 'results')), lastArgument(args, 'run-dir', ''))
  const runStartedAt = new Date().toISOString()
  const runStarted = performance.now()
  const cityResults = []
  const manifest = {
    schemaVersion: 'vigo.coordinate-benchmark.run.v1',
    status: 'running', phase: 'inputs', startedAt: runStartedAt, updatedAt: runStartedAt,
    outputDirectory, engines, engineOrder, cities: cities.map(({ slug, label }) => ({ slug, label })),
    controls: { comparison, seed, requestedPairs: count, repeatsPerPair: repeats, cacheMode, timedQueriesPerEngineCity: count * repeats, odGeneration: reuseRun || explicitOdFile ? null : { ...workload, basePairs: basePairCount }, time, routingPreference, maxWalkKm, queryTimeoutMs, noTimeout: queryTimeoutMs === 0 },
    timingContract: TIMING_CONTRACT,
    completedEngineCities: 0, totalEngineCities: engines.length * cities.length,
    errors: [],
  }
  const updateManifest = (update) => {
    Object.assign(manifest, update, { updatedAt: new Date().toISOString() })
    writeJsonAtomic(path.join(outputDirectory, 'run-manifest.json'), manifest)
  }
  updateManifest({})
  try {
  const fairness = fairnessRecord(engines, cacheMode)
  writeJsonAtomic(path.join(outputDirectory, 'fairness.json'), fairness)
  const provenance = await recordProvenance(BENCH_ROOT, outputDirectory, options, engines)
  updateManifest({ provenance, fairness: 'fairness.json', mode: args.has('generate-only') ? 'workload-only' : 'benchmark' })
  for (const city of cities) {
    updateManifest({ phase: 'inputs', currentCity: city.slug, currentEngine: null })
    process.stderr.write(`[${new Date().toISOString()}] ${city.slug} preparing benchmark inputs\n`)
    const cityDirectory = path.join(outputDirectory, city.slug)
    fs.mkdirSync(cityDirectory, { recursive: true })
    if (city.inputErrors.length) {
      const rows = engines.map((engine) => {
        const row = emptyEngineRow({ city, cityDirectory, commonNetworkSize: null }, engine, 'blocked', city.inputErrors.join('; '))
        row.unsubmittedQueries = count * repeats
        row.workdir = path.join(cityDirectory, engine.toLowerCase().replaceAll(/[^a-z0-9]+/giu, '-'))
        fs.mkdirSync(row.workdir, { recursive: true })
        writeJsonAtomic(path.join(row.workdir, 'summary.json'), row)
        writeJsonAtomic(path.join(row.workdir, 'progress.json'), { phase: 'complete', city: city.slug, engine, completed: 0, total: count * repeats, status: 'blocked', updatedAt: new Date().toISOString() })
        return row
      })
      const cityResult = { city: city.label, citySlug: city.slug, status: 'blocked', inputErrors: city.inputErrors, inputs: { osm: city.osmPath, gtfs: city.gtfsPaths }, engines: rows }
      cityResults.push(cityResult)
      writeJsonAtomic(path.join(cityDirectory, 'summary.json'), cityResult)
      updateManifest({ completedEngineCities: manifest.completedEngineCities + engines.length, errors: [...manifest.errors, { city: city.slug, errors: city.inputErrors }] })
      continue
    }
    const identity = await inputIdentity(city)
    const feedStats = await readFeedStats(city.gtfsPaths)
    const reusedCity = controlRun?.cities.get(city.slug)
    const requestedServiceDate = lastArgument(args, 'service-date', '')
    const requestedServiceDay = lastArgument(args, 'service-day', '')
    const serviceDateInfo = requestedServiceDate
      ? inferServiceDate(feedStats, requestedServiceDate)
      : reusedCity?.service?.date
        ? { date: reusedCity.service.date, source: 'reused-run' }
        : inferServiceDate(feedStats, '')
    const serviceDayInfo = requestedServiceDay
      ? inferServiceDay(serviceDateInfo.date, requestedServiceDay)
      : !requestedServiceDate && reusedCity?.service?.day
        ? { day: reusedCity.service.day, source: 'reused-run' }
        : inferServiceDay(serviceDateInfo.date, '')
    const baseOdFile = baseOdRun ? reuseOdFile(baseOdRun, city.slug) : null
    const reusedOdFile = reuseRun ? reuseOdFile(reuseRun, city.slug) : null
    const sourceOdFile = explicitOdFile ?? reusedOdFile
    const od = sourceOdFile
      ? loadOdOverride(sourceOdFile, count, cityDirectory, reuseRun ? { method: 'reused benchmark OD CSV; deterministic source prefix', reuseRun: reuseRun.directory } : {})
      : await generateWorkload(city, seed, cityDirectory, workload, baseOdFile, { run: baseOdRun?.directory ?? null })
    validateOdPopulation(od.rows, count)
    if (reuseRun && reusedCity?.recording) {
      if (reusedCity.recording.inputs.digest !== identity.digest) fail(`Input contents changed for ${city.slug}; generate a new workload instead of silently reusing it`)
      const sourceIdentity = await fingerprint(sourceOdFile)
      if (sourceIdentity.sha256 !== reusedCity.recording.od.sha256) fail(`Saved OD CSV changed for ${city.slug}`)
    }
    const recording = { inputs: identity, od: await fingerprint(od.odPath),
      controls: { comparison, time, serviceDate: serviceDateInfo.date, maxWalkKm, cacheMode, routingPreference, repeats } }
    recording.comparisonId = digest([identity.digest, recording.od.sha256, recording.controls])
    writeJsonAtomic(path.join(cityDirectory, 'recording.json'), recording)

    const context = contextForCity(city, cityDirectory, od, feedStats, serviceDateInfo.date, serviceDayInfo.day, options)
    for (const request of context.requests) Object.assign(request, { requireTransitRide: true, maxTransfers, horizonMinutes, maxJourneyDurationMinutes: horizonMinutes })
    const engineRows = []
    const pairedLanes = []
    const detailFiles = []
    for (const engine of engines) {
      updateManifest({ phase: 'engine', currentEngine: engine })
      const result = await runEngine(context, engine, options)
      engineRows.push(result.row)
      pairedLanes.push({ engine, complete: result.row.round?.complete === true && result.row.status === 'ready', counts: result.row.counts,
        rows: new Map(result.observations.map(row => [row.id, { status: row.status, endToEndMs: row.endToEndMs }])) })
      detailFiles.push({ engine, file: path.relative(outputDirectory, path.join(result.row.workdir, 'queries.ndjson')) })
      updateManifest({ completedEngineCities: manifest.completedEngineCities + 1,
        errors: result.row.errors.length || result.row.blockedReason ? [...manifest.errors, { city: city.slug, engine, status: result.row.status, errors: result.row.errors, blockedReason: result.row.blockedReason }] : manifest.errors })
    }
    if (!args.has('generate-only')) writeJsonAtomic(path.join(cityDirectory, 'comparison.json'), pairedComparison(pairedLanes, timingDistribution))
    const cityResult = { city: city.label, citySlug: city.slug, recording, status: args.has('generate-only') ? 'workload-ready' : engineRows.some((row) => row.status === 'ready') ? 'complete' : 'blocked', inputs: { osm: city.osmPath, gtfs: city.gtfsPaths, feed: city.gtfsPaths.map((filePath) => path.basename(filePath)).join(' + ') }, service: { date: serviceDateInfo.date, dateSource: serviceDateInfo.source, day: serviceDayInfo.day, daySource: serviceDayInfo.source, time }, od: { ...od.stats, path: od.odPath, repeats, cacheMode, timedQueries: count * repeats }, networkSize: context.commonNetworkSize, feedStats: feedStats.feeds.map(({ service, ...feed }) => feed), engines: engineRows, detailFiles }
    writeJsonAtomic(path.join(cityDirectory, 'summary.json'), cityResult)
    cityResults.push(cityResult)
    if (typeof globalThis.gc === 'function') globalThis.gc()
  }
  const summary = { schemaVersion: 'vigo.coordinate-benchmark.v3', benchmark: 'coordinate origin-destination routing', runMode: args.has('generate-only') ? 'workload-only' : baseOdRun ? 'extended-od' : reuseRun ? 'incremental-engine-rerun' : explicitOdFile ? 'provided-od' : 'sampled-od', startedAt: runStartedAt, completedAt: new Date().toISOString(), elapsedMs: Number((performance.now() - runStarted).toFixed(3)), controls: { comparison, seed, requestedPairs: count, repeatsPerPair: repeats, cacheMode, timedQueriesPerEngineCity: count * repeats, odGeneration: reuseRun || explicitOdFile ? null : { ...workload, basePairs: basePairCount }, time, routingPreference, maxWalkKm, noTimeout: true }, inputs: { root: inputRoot, odFile: explicitOdFile, reuseRun: reuseRun?.directory ?? null, baseOdRun: baseOdRun?.directory ?? null }, engines, adapterConfig: options.engineConfig.path, cities: cityResults, tableColumns: ['City', 'engine', 'Feed', 'Cold prep ms', 'cold prep RSS MiB', 'Peak RSS MiB', 'Storage MiB', 'Runner wall first p50 ms', 'Runner wall first p95 ms', 'Runner wall repeated p50 ms', 'Runner wall repeated p95 ms', 'Adapter-declared first p50 ms', 'Ready', 'blocked', 'errors'] }
  summary.engineOrder = engineOrder
  summary.timingContract = TIMING_CONTRACT
  summary.controls.queryTimeoutMs = queryTimeoutMs
  summary.controls.noTimeout = queryTimeoutMs === 0
  writeJsonAtomic(path.join(outputDirectory, 'summary.json'), summary)
  updateManifest({ status: manifest.errors.length ? 'complete_with_issues' : 'complete', phase: 'complete', currentCity: null, currentEngine: null, completedAt: summary.completedAt, elapsedMs: summary.elapsedMs })
  process.stdout.write(`${JSON.stringify({ outputDirectory, schemaVersion: summary.schemaVersion, cities: cityResults.map((city) => ({ city: city.city, status: city.status })) }, null, 2)}\n`)
  } catch (error) {
    updateManifest({ status: error.code === 'BENCHMARK_INTERRUPTED' ? 'interrupted' : 'error', phase: 'error', completedAt: new Date().toISOString(), errors: [...manifest.errors, { message: error instanceof Error ? error.message : String(error) }] })
    throw error
  }
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
