import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

export function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, filePath)
}

// Query evidence is still appended synchronously on every response. Only the
// dashboard checkpoint is coalesced; first/final/error/phase changes flush.
export function createProgressCheckpoint(filePath, { intervalMs = 250, now = () => performance.now(), write = writeJsonAtomic } = {}) {
  let lastAt = -Infinity, lastPhase = null, lastStatus = null, lastErrors = 0
  return value => {
    const at = now()
    if (value.phase === lastPhase && value.status === lastStatus && value.phase === 'query'
      && (value.counts?.errors ?? 0) === lastErrors
      && value.completed > 1 && value.completed < value.total && at - lastAt < intervalMs) return false
    write(filePath, value)
    lastAt = at
    lastPhase = value.phase
    lastStatus = value.status
    lastErrors = value.counts?.errors ?? 0
    return true
  }
}
