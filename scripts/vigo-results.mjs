// Adapt current public results to the benchmark's retained, minute-based view.
// Keep identifiers and quality evidence; never synthesize missing paths.
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const minutes = value => finite(value) === null ? null : value / 60
const identifier = value => typeof value === 'string' ? value
  : typeof value?.id === 'string' ? `${value.feed ? `${value.feed}\u001f` : ''}${value.id}` : null
const clock = value => {
  const match = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(value ?? '')
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 60 : null
}

export function publicRoutePlan(result) {
  if (result?.schema !== 'vigo.route.v1') return null
  if (result.status === 'error') return null
  if (result.status === 'not_found') return { status: 'blocked', detail: result.reason?.message,
    diagnostics: { failureCode: result.reason?.code }, travelMode: result.mode }
  const journey = result.journey
  if (result.status !== 'ok' || !journey || !Array.isArray(journey.legs)
    || finite(journey.durationSeconds) === null || journey.durationSeconds < 0) {
    throw new Error('Invalid VIGO route result: an ok response requires a timed journey')
  }
  return { status: 'ready', travelMode: result.mode, durationMinutes: minutes(journey.durationSeconds),
    departMinutes: clock(journey.departureTime), arriveMinutes: clock(journey.arrivalTime),
    transfers: finite(journey.transfers), walkMinutes: minutes(journey.walkingSeconds),
    waitMinutes: minutes(journey.waitingSeconds), rideMinutes: minutes(journey.ridingSeconds),
    clockDate: journey.clockDate,
    legs: journey.legs.map(({ geometry, ...leg }) => ({ ...leg, type: leg.type === 'transit' ? 'ride' : leg.type,
      startMinutes: clock(leg.departureTime), endMinutes: clock(leg.arrivalTime),
      durationMinutes: minutes(leg.durationSeconds), fromStopId: identifier(leg.from?.stop),
      toStopId: identifier(leg.to?.stop), tripId: identifier(leg.trip), routeId: identifier(leg.route?.id),
      routeShortName: leg.route?.name, serviceId: identifier(leg.service),
      ...(geometry?.type === 'LineString' ? { coordinates: geometry.coordinates } : geometry ? { geometry } : {}),
    })),
  }
}

export function vigoResponseParts(payload) {
  const publicResult = payload?.schema === 'vigo.route.v1' ? payload
    : payload?.result?.schema === 'vigo.route.v1' ? payload.result : null
  const detailed = publicResult?.trace ?? payload?.trace ?? payload
  const result = detailed?.result?.kind === 'route' ? detailed.result : detailed
  const plan = result?.plan ?? (result?.kind === 'route' ? result.result : null)
    ?? (result?.runtime === 'rust' && ['ready', 'blocked'].includes(result.status) ? result : null)
    ?? (publicResult ? publicRoutePlan(publicResult) : null)
  return { result, plan, publicResult,
    // Python's measured wrapper timer is outside its nested detailed Result.
    timing: { ...(result?.timing ?? {}), ...(detailed?.timing ?? {}), ...(payload?.timing ?? {}) },
  }
}
