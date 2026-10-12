// Pure outcome and timing aggregation, shared by every engine lane.
function percentile(values, probability) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1))]
}

function timingDistribution(observations, field, includeErrors = false) {
  const values = []
  let eligible = 0, missing = 0, invalid = 0, sum = 0
  for (const observation of observations) {
    if (!includeErrors && observation.status === 'error') continue
    eligible += 1
    const value = observation[field]
    if (!Number.isFinite(value)) missing += 1
    else if (value < 0) invalid += 1
    else { values.push(value); sum += value }
  }
  values.sort((left, right) => left - right)
  const quantile = probability => values.length ? values[Math.max(0, Math.ceil(probability * values.length) - 1)] : null
  return {
    samples: values.length, eligible, missing, invalid,
    coverage: eligible ? values.length / eligible : null,
    p50Ms: quantile(0.5), p95Ms: quantile(0.95), p99Ms: quantile(0.99),
    minMs: values.length ? values[0] : null,
    maxMs: values.length ? values[values.length - 1] : null,
    sumMs: values.length ? sum : null,
    meanMs: values.length ? sum / values.length : null,
  }
}

function measuredTimingGroup(observations, includeErrors = false) {
  const overheadValidity = observations.reduce((counts, observation) => {
    const status = observation.adapterOverheadStatus ?? 'unreported'
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, { valid: 0, missing_adapter_timing: 0, invalid_adapter_timing: 0, adapter_exceeds_end_to_end: 0, unreported: 0 })
  const overhead = timingDistribution(observations, 'adapterOverheadMs', true)
  const invalidOverhead = overheadValidity.invalid_adapter_timing + overheadValidity.adapter_exceeds_end_to_end
  return {
    observations: observations.length,
    adapterDeclared: timingDistribution(observations, 'queryMs', includeErrors),
    engineQuery: timingDistribution(observations, 'engineQueryMs', includeErrors),
    runnerWall: timingDistribution(observations, 'wallMs', includeErrors),
    endToEnd: timingDistribution(observations, 'endToEndMs', true),
    requestEncode: timingDistribution(observations, 'requestEncodeMs', true),
    responseDecode: timingDistribution(observations, 'responseDecodeMs', true),
    adapterOverhead: { ...overhead, missing: Math.max(0, overhead.missing - invalidOverhead), invalid: overhead.invalid + invalidOverhead, validity: overheadValidity },
    cache: cacheSummary(observations),
  }
}

function cacheSummary(observations) {
  return observations.reduce((summary, observation) => {
    if (observation.status === 'error') return summary
    if (observation.resultCachePolicy === 'disabled') summary.disabled += 1
    else if (observation.cacheHit === true) summary.hits += 1
    else if (observation.cacheHit === false) summary.misses += 1
    else summary.unreported += 1
    return summary
  }, { hits: 0, misses: 0, disabled: 0, unreported: 0 })
}

function timingSummary(observations, queryRequestById) {
  const firstObservations = observations.filter((observation) => queryRequestById.get(observation.id)?.repeat === 1)
  const repeatedObservations = observations.filter((observation) => queryRequestById.get(observation.id)?.repeat > 1)
  const adapterDeclared = timingDistribution(observations, 'queryMs')
  const runnerWall = timingDistribution(observations, 'wallMs')
  const repeatedAdapter = timingDistribution(repeatedObservations, 'queryMs')
  const processFirstObservations = observations.filter((observation) => observation.processFirst === true || observation.requestIndex === 1)
  const subsequentDistinctObservations = firstObservations.filter((observation) => observation.processFirst === false || observation.requestIndex > 1)
  return {
    ...adapterDeclared,
    ...measuredTimingGroup(observations),
    warmSamples: repeatedAdapter.samples,
    meanWarmQueryMs: repeatedAdapter.meanMs,
    adapterDeclared,
    runnerWall,
    first: measuredTimingGroup(firstObservations),
    repeated: measuredTimingGroup(repeatedObservations),
    processFirst: measuredTimingGroup(processFirstObservations),
    subsequentDistinct: measuredTimingGroup(subsequentDistinctObservations),
    byOutcome: Object.fromEntries(['ready', 'blocked', 'error'].map((status) => [status, measuredTimingGroup(observations.filter((observation) => observation.status === status), true)])),
    cache: cacheSummary(observations),
  }
}

function summarizeByOdType(observations, queryRequestById) {
  const groups = new Map()
  for (const observation of observations) {
    const type = observation.odType ?? 'unlabeled'
    if (!groups.has(type)) groups.set(type, [])
    groups.get(type).push(observation)
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, values]) => {
    const counts = values.reduce((result, observation) => {
      if (observation.status === 'error') result.errors += 1
      else result[observation.status] += 1
      return result
    }, { ready: 0, blocked: 0, errors: 0 })
    return [type, {
      pairs: new Set(values.map((observation) => observation.odId)).size,
      observations: values.length,
      counts,
      hot: timingSummary(values, queryRequestById),
    }]
  }))
}


export { percentile, timingDistribution, timingSummary, summarizeByOdType }
