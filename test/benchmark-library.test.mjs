import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { createBenchmark, listBenchmarks, benchmarkResults, benchmarkOds, replayWorkload } from '../scripts/benchmark-library.mjs'
import { createDashboard } from '../scripts/benchmark-dashboard.mjs'
import { TIMING_CONTRACT } from '../scripts/run-benchmark.mjs'
import { comparisonSeries } from '../dashboard/comparison-chart.js'
import { readRoutes } from '../scripts/benchmark-data.mjs'

const config = { city: 'city', engines: ['VIGO'], randomCount: 1, nearStopCount: 0, stationPivotCount: 0 }
const csv = 'id,origin_lon,origin_lat,destination_lon,destination_lat,od_type\none,1,2,3,4,random\n'
function saveRun(root, id, {engine='VIGO', startedAt='2026-09-26T01:00:00Z', status='complete', benchmarkId, identity='shared-identity', partial=false}={}) {
  const cityDir=path.join(root,id,'city'), lane=path.join(cityDir,engine.toLowerCase())
  fs.mkdirSync(lane,{recursive:true})
  const recording={comparisonId:identity,od:{sha256:crypto.createHash('sha256').update(csv).digest('hex')}}
  const controls={repeatsPerPair:1,time:'08:00',maxWalkKm:1.2,cacheMode:'native',comparison:{maxTransfers:3,horizonMinutes:240}}
  fs.writeFileSync(path.join(cityDir,'od.csv'),csv)
  fs.writeFileSync(path.join(cityDir,'recording.json'),JSON.stringify(recording))
  fs.writeFileSync(path.join(cityDir,'context.json'),JSON.stringify({serviceDate:'2026-07-14',time:'08:00'}))
  fs.writeFileSync(path.join(lane,'queries.ndjson'),JSON.stringify({id:'one_run_1',odId:'one',repeat:1,status:'ready',endToEndMs:2,origin:{coordinate:[1,2]},destination:{coordinate:[3,4]},itinerary:{legs:[{mode:'walk',coordinates:[[1,2],[3,4]]}]}})+'\n')
  fs.writeFileSync(path.join(root,id,'run-manifest.json'),JSON.stringify({timingContract:TIMING_CONTRACT,startedAt,status,controls,cities:[{slug:'city',label:'City'}],engines:[engine]}))
  if(!partial) fs.writeFileSync(path.join(root,id,'summary.json'),JSON.stringify({timingContract:TIMING_CONTRACT,startedAt,controls,cities:[{citySlug:'city',city:'City',service:{date:'2026-07-14'},recording,engines:[{engine,status:'ready'}]}]}))
  if(benchmarkId) { fs.mkdirSync(path.join(root,'.dashboard-logs'),{recursive:true});fs.writeFileSync(path.join(root,'.dashboard-logs',`${id}.json`),JSON.stringify({benchmarkId,status})) }
}

test('benchmark definitions exist before execution and combine only matching workloads', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-library-'))
  try {
    const empty=createBenchmark(root,config,'Morning')
    assert.equal(benchmarkResults(root,empty.id).cities[0].engines.length,0)
    assert.equal(listBenchmarks(root)[0].pairCount,1)
    saveRun(root,'first'); saveRun(root,'second',{engine:'OTP',startedAt:'2026-09-26T02:00:00Z'})
    saveRun(root,'different',{identity:'different-controls',startedAt:'2026-09-26T03:00:00Z'})
    const group=listBenchmarks(root).find(row=>row.attempts.length===2)
    assert.ok(group)
    assert.deepEqual(benchmarkResults(root,group.id).cities[0].engines.map(row=>[row.engine,row.runId]),[['VIGO','first'],['OTP','second']])
    assert.deepEqual(benchmarkResults(root,group.id,'first').cities[0].engines.map(row=>row.engine),['VIGO'])
    assert.throws(()=>benchmarkResults(root,group.id,'different'),/does not belong/)
    const ods=await benchmarkOds(root,group.id)
    assert.deepEqual(Object.keys(ods.requests[0].engines),['VIGO','OTP'])
    assert.equal(ods.requests[0].engines.OTP.runId,'second')
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})

test('stopped runs replay the same OD bytes and controls without a final summary', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-restart-'))
  try {
    const definition=createBenchmark(root,config)
    saveRun(root,'stopped',{benchmarkId:definition.id,partial:true,status:'interrupted'})
    const group=listBenchmarks(root).find(row=>row.id===definition.id)
    assert.equal(group.attempts[0].status,'interrupted')
    const directory=replayWorkload(root,group)
    assert.equal(fs.readFileSync(path.join(directory,'city','od.csv'),'utf8'),csv)
    const snapshot=JSON.parse(fs.readFileSync(path.join(directory,'summary.json')))
    assert.equal(snapshot.controls.time,'08:00')
    assert.equal(snapshot.cities[0].service.date,'2026-07-14')
    assert.equal(fs.existsSync(path.join(root,'stopped','summary.json')),false)
    fs.appendFileSync(path.join(root,'stopped','city','od.csv'),'changed')
    assert.throws(()=>replayWorkload(root,group),/changed/)
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})

test('route endpoint returns native ready geometry and excludes blocked candidates',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-routes-'))
  try{
    saveRun(root,'routes')
    fs.appendFileSync(path.join(root,'routes','city','vigo','queries.ndjson'),JSON.stringify({id:'rejected',status:'blocked',rejectedItinerary:{legs:[{coordinates:[[1,2],[3,4]]}]}})+'\n')
    const result=await readRoutes(root,'routes','city/vigo')
    assert.equal(result.routes.length,1)
    assert.deepEqual(result.routes[0].geometry.segments[0].coordinates,[[1,2],[3,4]])
    assert.equal((await readRoutes(root,'routes','city/vigo','rejected')).routes.length,0)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('shared chart uses a paired routed cohort, preserves zero, and rejects invalid timing',()=>{
  const rows=[
    {odType:'random',engines:{VIGO:{status:'ready',endToEndMs:0},OTP:{status:'ready',endToEndMs:3}}},
    {odType:'random',engines:{VIGO:{status:'ready',endToEndMs:2},OTP:{status:'blocked',endToEndMs:1}}},
    {odType:'near_stop',engines:{VIGO:{status:'mismatch',endToEndMs:7},OTP:{status:'ready',endToEndMs:NaN}}},
  ]
  assert.deepEqual(comparisonSeries(rows,['VIGO','OTP']).map(row=>row.values),[[0],[3]])
  assert.deepEqual(comparisonSeries(rows,['VIGO','OTP'],{population:'all'}).map(row=>row.values),[[0,2],[1,3]])
  assert.deepEqual(comparisonSeries(rows,['VIGO','OTP'],{type:'near_stop'}).map(row=>row.values),[[],[]])
})

test('new city files are token protected, local, and never overwrite existing inputs',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-city-')), inputRoot=path.join(root,'inputs')
  const app=createDashboard({resultsRoot:path.join(root,'results'),inputRoot})
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening')
  const base=`http://127.0.0.1:${app.server.address().port}`
  try{
    const {token}=await(await fetch(`${base}/api/catalog`)).json()
    const headers={'X-Benchmark-Token':token}
    assert.equal((await fetch(`${base}/api/cities`,{method:'POST',body:JSON.stringify({name:'New City'})})).status,403)
    const city=await(await fetch(`${base}/api/cities`,{method:'POST',headers,body:JSON.stringify({name:'New City'})})).json()
    assert.equal(city.slug,'new-city')
    const upload=(name,body='fixture')=>fetch(`${base}/api/city-file?city=${city.slug}&name=${encodeURIComponent(name)}`,{method:'POST',headers,body})
    assert.equal((await upload('../outside.zip')).status,400)
    assert.equal((await upload('empty.zip','')).status,400)
    assert.equal((await upload('map.pbf')).status,201)
    assert.equal((await upload('map.pbf','changed')).status,400)
    assert.equal(fs.readFileSync(path.join(inputRoot,city.slug,'map.pbf'),'utf8'),'fixture')
    assert.equal((await upload('feed.zip')).status,201)
    const catalog=await(await fetch(`${base}/api/catalog`)).json()
    assert.deepEqual(catalog.cities[0].inputErrors,[])
    const created=await fetch(`${base}/api/benchmarks`,{method:'POST',headers,body:JSON.stringify({...config,city:city.slug,name:'Morning'})})
    assert.equal(created.status,201)
    assert.equal(app.activeRun,null)
    assert.equal((await(await fetch(`${base}/api/catalog`)).json()).benchmarks[0].label,'Morning')
  }finally{await new Promise(resolve=>app.server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
})
