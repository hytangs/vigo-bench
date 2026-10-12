#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { comparisonObservation } from './benchmark-sensitivity.mjs'
import { pairedComparison } from './benchmark-fairness.mjs'
import { timingDistribution } from './benchmark-statistics.mjs'

export async function reportSensitivity(directory) {
  const root = fs.realpathSync(directory), sources = []
  const read = relative => {
    const file = fs.realpathSync(path.resolve(root, relative))
    if (!file.startsWith(root + path.sep)) throw new Error('Evidence path escapes the run directory')
    const bytes = fs.readFileSync(file)
    sources.push({ path: path.relative(root, file), sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    return bytes.toString('utf8')
  }
  const summary = JSON.parse(read('summary.json'))
  if (!Array.isArray(summary.cities)) throw new Error('Expected a complete run summary containing cities')
  const cities = []
  for (const city of summary.cities) {
    const lanes = []
    for (const engine of city.engines) {
      const detail = city.detailFiles?.find(item => item.engine === engine.engine)
      const rows = new Map()
      if (detail && fs.existsSync(path.resolve(root, detail.file))) {
        const file = fs.realpathSync(path.resolve(root, detail.file))
        if (!file.startsWith(root + path.sep)) throw new Error('Evidence path escapes the run directory')
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(file)
        stream.on('data', bytes => hash.update(bytes))
        try {
          for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
            if (!line.trim()) continue
            const row = JSON.parse(line)
            if (!row.id || rows.has(row.id)) throw new Error(`Missing or duplicate request ID in ${detail.file}`)
            rows.set(row.id, comparisonObservation({ ...row, engine: engine.engine }))
          }
        } finally { stream.destroy() }
        sources.push({ path: path.relative(root, file), sha256: hash.digest('hex') })
      } else if (engine.round?.complete && engine.status === 'ready') throw new Error(`Missing query evidence for completed lane ${engine.engine}`)
      const requestedCount = city.od?.timedQueries ?? summary.controls?.timedQueriesPerEngineCity
      if (!Number.isSafeInteger(requestedCount) || requestedCount < rows.size) throw new Error('Invalid or missing requested query count')
      lanes.push({ engine: engine.engine, complete: engine.round?.complete === true && engine.status === 'ready' && rows.size === requestedCount,
        counts: engine.counts, setupErrors: engine.setupErrors, requestedCount, rows })
    }
    cities.push({ city: city.citySlug, comparison: pairedComparison(lanes, timingDistribution) })
  }
  return { schemaVersion: 'vigo.benchmark.sensitivity-report.v1', controls: summary.controls, sources, cities }
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [run, output, ...extra] = process.argv.slice(2)
    if (!run || !output || extra.length) throw new Error('Usage: node scripts/report-sensitivity.mjs RUN NEW_OUTPUT.json (outside RUN)')
    const root = fs.realpathSync(run), destination = path.resolve(output)
    const parent = fs.realpathSync(path.dirname(destination))
    if (parent === root || parent.startsWith(root + path.sep)) throw new Error('Write derived analysis outside the retained run')
    fs.writeFileSync(destination, JSON.stringify(await reportSensitivity(run), null, 2) + '\n', { flag: 'wx' })
    console.log(destination)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
