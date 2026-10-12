import fs from 'node:fs'

// A reserve for temporary preparation files, not an estimate of final City size.
export const PREPARATION_DISK_RESERVE = 5 * 1024 ** 3

export function checkPreparationSpace(directory) {
  const volume = fs.statfsSync(directory, { bigint: true })
  const availableBytes = volume.bavail * volume.bsize
  if (availableBytes < BigInt(PREPARATION_DISK_RESERVE)) {
    const freeGiB = (Number(availableBytes) / 1024 ** 3).toFixed(2)
    throw new Error(`Preparation needs at least 5 GiB free on the output volume; ${freeGiB} GiB is available. Retained evidence is unchanged. Free space before starting another build.`)
  }
  return Number(availableBytes)
}
