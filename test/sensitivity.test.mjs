import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { comparisonObservation } from '../scripts/benchmark-sensitivity.mjs'
import { pairedComparison, fairnessRecord } from '../scripts/benchmark-fairness.mjs'
import { timingDistribution } from '../scripts/benchmark-statistics.mjs'
import { validateLaunch } from '../scripts/benchmark-dashboard.mjs'
import { defaultStudy, validateStudy, studyArguments, studyIdentity } from '../scripts/benchmark-study.mjs'
import { normalizeObservation } from '../scripts/run-benchmark.mjs'
import { reportSensitivity } from '../scripts/report-sensitivity.mjs'
const lane = (engine, rows, complete = true) => ({ engine, rows: new Map(rows.map(row => [row.id, row])), complete, requestedCount: 3 })
test('selection sensitivity retains hard excluded routes, failures, and missing data', () => {
  const a = lane('A', [{id:'a',status:'ready',endToEndMs:10,odType:'random',route:{transfers:0,durationMinutes:20},responseBytes:500},
    {id:'b',status:'ready',endToEndMs:1000,odType:'near_stop'}, {id:'c',status:'error',endToEndMs:null}])
  const b = lane('B', [{id:'a',status:'ready',endToEndMs:20},{id:'b',status:'blocked',endToEndMs:1,outcomeReason:'native_candidate_rejected'},{id:'c',status:'error',endToEndMs:2}])
  const s = pairedComparison([a,b], timingDistribution).sensitivity
  assert.equal(s.engines.A.excludedReadyCount,1)
  assert.equal(s.engines.A.excludedReady.p50Ms,1000)
  assert.equal(s.engines.A.allSubmitted.missing,1)
  assert.equal(s.engines.A.readyCoverage,2/3)
  assert.equal(s.engines.B.outcomeReasons.native_candidate_rejected,1)
  assert.equal(s.engines.A.byTransfers.unreported.observations,1)
  assert.equal(s.ratios[0].commonReady,.5)
  assert.equal(s.ratios[0].allSubmitted,5)
  b.complete=false; b.rows.delete('c')
  const partial=pairedComparison([a,b],timingDistribution).sensitivity
  assert.equal(partial.engines.B.unsubmitted,1)
  assert.equal(partial.ratios[0].allSubmitted,null)
})
test('candidate budget is validated, forwarded, and part of the study identity', () => {
  const base=defaultStudy(), changed=validateStudy({...base,candidateLimit:5})
  assert.notEqual(studyIdentity(base),studyIdentity(changed))
  const args=studyArguments(changed,{inputRoot:'/inputs',city:'test'})
  assert.equal(args[args.indexOf('--candidate-limit')+1],'5')
  for(const n of [0,21,1.5,true,'5']) assert.throws(()=>validateStudy({...base,candidateLimit:n}))
  const record=fairnessRecord(['R5','Valhalla','MOTIS'],'native',changed)
  assert.equal(record.engines.MOTIS.candidatePolicy.requestedLimit,5)
  assert.equal(record.engines.Valhalla.candidatePolicy.requestedLimit,null)
  assert.equal(record.engines.R5.boardingPolicy.nativeSlackSeconds,60)
})
test('normalization retains returned-candidate diagnostics', () => {
  const row=normalizeObservation({id:'a'},{status:'ready',itinerary:{legs:[]},plan:{status:'ready',diagnostics:{selectedNativeIndex:1,nativeCandidateCount:2,policyPassingCandidateCount:1}}},2)
  assert.equal(row.candidateSelection.selectedNativeIndex,1)
  assert.equal(row.candidateSelection.nativeCandidateCount,2)
})
test('offline report hashes evidence, refuses duplicates and never overwrites retained files', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-sensitivity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.writeFileSync(path.join(root,'queries.ndjson'),JSON.stringify({id:'a',status:'ready',endToEndMs:1})+'\n')
  const summary={controls:{timedQueriesPerEngineCity:1},cities:[{citySlug:'fixture',engines:[{engine:'A',status:'ready',round:{complete:true}}],detailFiles:[{engine:'A',file:'queries.ndjson'}]}]}
  fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary))
  const result=await reportSensitivity(root)
  assert.equal(result.cities[0].comparison.sensitivity.engines.A.submitted,1)
  assert.equal(result.sources.length,2)
  const before=fs.readFileSync(path.join(root,'summary.json'),'utf8')
  const call=spawnSync(process.execPath,['scripts/report-sensitivity.mjs',root,path.join(root,'summary.json')],{encoding:'utf8'})
  assert.equal(call.status,1);assert.equal(fs.readFileSync(path.join(root,'summary.json'),'utf8'),before)
  const output=path.join(os.tmpdir(),path.basename(root)+'-report.json');t.after(()=>fs.rmSync(output,{force:true}))
  const success=spawnSync(process.execPath,['scripts/report-sensitivity.mjs',root,output],{encoding:'utf8'})
  assert.equal(success.status,0,success.stderr)
  assert.equal(JSON.parse(fs.readFileSync(output)).sources[1].sha256,result.sources[1].sha256)
  assert.equal(spawnSync(process.execPath,['scripts/report-sensitivity.mjs',root,output]).status,1)
  fs.appendFileSync(path.join(root,'queries.ndjson'),JSON.stringify({id:'a',status:'ready'})+'\n')
  await assert.rejects(()=>reportSensitivity(root),/duplicate/)
})

test('comparison state is compact and geometry presence is never claimed as correctness', () => {
  const row=comparisonObservation({id:'a',engine:'ULTRA-OSM',status:'ready',itinerary:{legs:[{coordinates:[[0,0],[1,1]]}]},route:{transfers:0,durationMinutes:1}})
  assert.equal(row.geometryRepresentation,'simplified-declared')
  assert.equal(row.itinerary,undefined)
  assert.equal(comparisonObservation({status:'ready',itinerary:{legs:[{legGeometry:{points:'encoded'}}]}}).geometryRepresentation,'all-legs-have-geometry-unverified')
})

test('dashboard retains and validates candidate-budget controls', () => {
  const cities=[{slug:'fixture',inputErrors:[]}]
  const config=validateLaunch({city:'fixture',engines:['MOTIS'],candidateLimit:5},cities)
  assert.equal(config.candidateLimit,5)
  assert.throws(()=>validateLaunch({city:'fixture',engines:['MOTIS'],candidateLimit:21},cities))
})
