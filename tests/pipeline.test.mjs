import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Cache} from '../pipeline/cache.mjs';
import {normalizeSeries,selectVersions,valueAt,coverageOf} from '../pipeline/quality.mjs';
import {goes,hp30,hp30Forecast,omm,nmdb,socrates,geoalert,parseCSV} from '../pipeline/adapters.mjs';
import {orbitProfile,accessibleFlux,accessibleFluxBound,cutoffRigidity,cutoffEnergy} from '../pipeline/orbit.mjs';
import {grun,earthFactor} from '../pipeline/meteor.mjs';
import {buildDataset} from '../pipeline/build.mjs';
import {validateV2,assessV2,compareVector} from '../dist/pipeline.js';
const rules=JSON.parse(await readFile(new URL('../data/rules.json',import.meta.url),'utf8'));
const t=Date.parse('2024-05-10T10:00:00Z'),iso=x=>new Date(x).toISOString();
const record=(extra={})=>({sourceId:'noaa.swpc',sourceVersion:'v1',seriesId:'p10',instrument:'g18/SGPS',measuredAt:iso(t),publishedAt:iso(t+60000),fetchedAt:iso(t+120000),provenance:'observation',quantity:'proton_integral_flux',energy:10,unit:'pfu',cadenceMinutes:1,maxAgeMinutes:15,interpolation:'linear',value:1,...extra});
const request={mode:'history',historyMode:'archive',start:iso(t),duration:1,shift:1,cutoff:iso(t),lightConstraint:false};
const snap=(raw,sourceId='noaa.swpc')=>({raw:typeof raw==='string'?raw:JSON.stringify(raw),sourceId,sourceVersion:'fixture',fetchedAt:iso(t+3600000)});
test('replay selects last known revision; no publication is not measurement time',()=>{
 const rows=[record(),record({value:10,publishedAt:iso(t+180000)}),record({seriesId:'unknown',publishedAt:null})];
 assert.deepEqual(selectVersions(rows,t+90000).map(r=>r.value),[1]);assert.equal(selectVersions(rows).length,2);
 assert.throws(()=>selectVersions([record({publishedAt:iso(t-1)})]));
});
test('invalid physics and quality flags remain explicit gaps; Hp30 is unbounded',()=>{
 const rows=[record({value:-99999}),record({measuredAt:iso(t+60000),publishedAt:null,value:20,q:'quality'}),record({quantity:'hp30',seriesId:'hp30',energy:null,value:13})];
 const series=normalizeSeries(rows);assert(series[0].samples.every(p=>p.v===null));assert.equal(series[1].samples[0].v,13);
 assert.equal(coverageOf(series[0],t,t+3600000).fraction,0);
});
test('satellite switching splits series and never interpolates across instruments',()=>{
 const series=normalizeSeries([record(),record({instrument:'g19/SGPS',measuredAt:iso(t+60000),publishedAt:null,value:100})]);
 assert.equal(series.length,2);assert.equal(valueAt(series[0],t+30000),null);
});
test('isolated spikes and inconsistent integral channels are rejected',()=>{
 const points=[1,1,100,1,1].map((value,i)=>record({measuredAt:iso(t+i*60000),publishedAt:null,value}));
 assert.equal(normalizeSeries(points)[0].samples[2].q,'spike');
 const series=normalizeSeries([record({value:1}),record({seriesId:'p100',energy:100,value:2})]);assert(series.every(s=>s.samples[0].q==='channel_order'));
});
test('gaps cover leading, trailing, and invalid samples across whole horizon',()=>{
 const s=normalizeSeries([record(),record({measuredAt:iso(t+60000),publishedAt:null,value:3})])[0];
 assert.equal(valueAt(s,t+30000),2);assert.equal(valueAt(s,t-1),null);assert.equal(valueAt(s,t+120000),null);
 const c=coverageOf(s,t-60000,t+180000);assert.equal(c.validSamples,3);assert.deepEqual(c.gaps,[{start:t-60000,end:t},{start:t+90000,end:t+180000}]);
});
test('real source shapes preserve instrument, completed intervals and publication times',()=>{
 const r=goes(snap([{time_tag:iso(t),satellite:18,flux:12,energy:'>=10 MeV'}]))[0];assert.equal(r.instrument,'g18/SGPS');assert.equal(r.publishedAt,null);
 const h=hp30(snap({datetime:[iso(t)],Hp30:[5]}))[0];assert.equal(Date.parse(h.measuredAt),t+1800000);
 assert.equal(geoalert(snap(':Issued: 2024 May 10 1230 UTC','noaa.ncei'))[0].publishedAt,'2024-05-10T12:30:00.000Z');
 assert.throws(()=>geoalert(snap('20240510GEOA.txt')));
 const monitors=nmdb(snap('  ROME OULU\n2024-05-10 10:00:00;120;90','nmdb'));assert.equal(monitors[0].instrument,'ROME');assert.equal(monitors[1].value,90);assert.equal(monitors[0].measuredAt,iso(t+3600000));
 assert.throws(()=>nmdb(snap('2024-05-10 10:00:00;120;90','nmdb')));
 assert.equal(parseCSV('a,b\n"x,y","a""b"\n')[0].b,'a"b');
 const rows=socrates(snap('NORAD_CAT_ID_1,NORAD_CAT_ID_2,TCA,TCA_RANGE\n25544,123,2024-05-10 12:00:00,0.8\n99,22,2024-05-10 13:00:00,0.1','celestrak.socrates'));assert.equal(rows.length,1);assert.equal(rows[0].objectId,25544);
});
const elements={NORAD_CAT_ID:25544,EPOCH:'2024-05-10T09:00:00',MEAN_MOTION:15.5,ECCENTRICITY:0.0005,INCLINATION:51.64,RA_OF_ASC_NODE:100,ARG_OF_PERICENTER:50,MEAN_ANOMALY:10,BSTAR:0.0001,MEAN_MOTION_DOT:0.0001,MEAN_MOTION_DDOT:0};
test('SGP4 propagates OMM; expired and future epochs never become synthetic orbits',()=>{
 const records=omm(snap([elements],'celestrak.gp')),profile=orbitProfile(records,t,t+3600000);
 assert.equal(profile.samples.length,121);assert(profile.samples.every(p=>p.alt>350&&p.alt<500&&Math.abs(p.lat)<52));assert(profile.samples.some(p=>p.sunlit));assert(profile.samples.some(p=>!p.sunlit));
 assert.equal(orbitProfile(records,t+86400000,t+86430000).samples[0].lat,null);
 assert.equal(orbitProfile(records,t-7200000,t-7190000).samples[0].lat,null);
});
test('accessible spectrum never extrapolates beyond measured energy',()=>{
 const c=[{energy:10,value:100},{energy:100,value:1}];assert(Math.abs(accessibleFlux(c,Math.sqrt(1000))-10)<1e-10);assert.equal(accessibleFlux(c,500),null);assert.equal(accessibleFlux([{energy:10,value:null}],10),null);
});
test('empty live dataset validates and never recommends shifting into missing data',async()=>{
 const d=validateV2(await buildDataset(request,[]));assert.equal(d.sources.length,11);const plan=assessV2(request,d);assert.equal(plan.outcome,'insufficient');assert.equal(plan.improvement,false);assert.equal(plan.recommended.confidence.level,'low');assert.equal(plan.original.factors.sep.value,null);
 const bad=structuredClone(d);bad.profile.samples[0].sep=NaN;assert.throws(()=>validateV2(bad));
 assert.equal(compareVector([0,1,100000],[1,0,0]),-1);
});
test('v2 ranks complete windows by vector and distinguishes ties and zero shift',async()=>{
 const d=await buildDataset(request,[]);
 for(const p of d.profile.samples)Object.assign(p,{lat:10,lon:20,alt:420,sunlit:true,saa:false,sep:p.t<t+3600000?2:0,trapped:0,gcr:1,meteor:0,ops:0});
 let plan=assessV2(request,d);assert.equal(plan.improvement,true);assert.equal(plan.recommended.start,t+3600000);
 for(const p of d.profile.samples)p.sep=0;
 plan=assessV2(request,d);assert.equal(plan.outcome,'insufficient');assert.equal(plan.improvement,false);
 plan=assessV2({...request,shift:0},d);assert.equal(plan.alternative,null);assert.equal(plan.outcome,'no_improvement');
});
test('replay excludes unknown-time orbit and observations while archive retains them',async()=>{
 const records=[...omm(snap([elements],'celestrak.gp')),record({publishedAt:null})];
 const archive=await buildDataset(request,records),replay=await buildDataset({...request,historyMode:'replay'},records);
 assert(archive.profile.samples.some(p=>p.lat!==null));assert(replay.profile.samples.every(p=>p.lat===null));assert.equal(replay.series.length,0);
});
test('cache deduplicates concurrent fetches, rate limits failures, and preserves raw payload',async()=>{
 const root=await mkdtemp(join(tmpdir(),'eva-pipeline-'));let calls=0;
 try{const c=new Cache(root,async()=>{calls++;return new Response('{"value":1}');});const [a,b]=await Promise.all([c.fetch('x','https://example.test',120),c.fetch('x','https://example.test',120)]);assert.equal(calls,1);assert.equal(a.raw,b.raw);await c.append([record()]);await c.append([record()]);assert.equal((await c.records()).length,1);
 const f=new Cache(root,async()=>{calls++;return new Response('',{status:503});});await assert.rejects(f.fetch('bad','https://example.test/bad',120));await assert.rejects(f.fetch('bad','https://example.test/bad',120));assert.equal(calls,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cutoff follows the reference Störmer and CARI-7A formulas',()=>{
 const rc=(lat,index=0)=>cutoffRigidity(lat,420,index,rules.cutoff)?.rc;
 // «Внешние опасности», §2.4: 12.8 GV at the ISS geomagnetic equator, ~0.8 GV at 60°, ~0.4 GV at 65°.
 assert(Math.abs(rc(0)-12.76)<0.01);assert(Math.abs(rc(60)-0.8)<0.01);assert(Math.abs(rc(65)-0.41)<0.01);
 const quiet=rc(50),storm=rc(50,5);assert(Math.abs(storm-0.5*quiet*(1+0.54*Math.exp(-quiet/2.9)))<1e-12);assert(storm<quiet);
 assert.equal(cutoffRigidity(50,420,null,rules.cutoff),null);
 // Table 3 of the reference: 10 MeV ↔ 0.137 GV, 30 MeV ↔ 0.239 GV, 100 MeV ↔ 0.445 GV.
 for(const [gv,mev] of [[0.137,10],[0.239,30],[0.445,100]])assert(Math.abs(cutoffEnergy(gv)-mev)/mev<0.02);
});
test('above the highest GOES channel the accessible flux is an upper bound, never extrapolated',()=>{
 const c=[{energy:10,value:100},{energy:100,value:1}];
 assert.deepEqual(accessibleFluxBound(c,500),{value:1,bound:true});
 const inside=accessibleFluxBound(c,Math.sqrt(1000));assert.equal(inside.bound,false);assert(Math.abs(inside.value-10)<1e-10);
 assert.equal(accessibleFluxBound([{energy:10,value:null}],10),null);
});
test('GFZ Hp30 forecast keeps the issue time apart from the validity interval',()=>{
 const raw={'Time (UTC)':{0:'10-05-2024 12:00',1:'10-05-2024 12:30'},minimum:{0:1,1:2},median:{0:2,1:3},maximum:{0:4,1:6}};
 const rows=hp30Forecast(snap(raw,'gfz.hp30.forecast'));
 assert.equal(rows.length,2);assert.equal(rows[1].measuredAt,'2024-05-10T12:00:00.000Z');assert.equal(rows[1].start,Date.parse('2024-05-10T12:30:00Z'));assert.equal(rows[1].value,6);assert.equal(rows[0].provenance,'external_forecast');
 assert.throws(()=>hp30Forecast(snap({'Time (UTC)':{0:'2024-05-10 12:00'},minimum:{0:1},median:{0:1},maximum:{0:1}},'gfz.hp30.forecast')));
});
test('current mode carries the last GOES spectrum forward only after its last sample',async()=>{
 const current={...request,mode:'current'},sampled=t+30*60000;
 const spectrum=[1,5,10,30,50,60,100,500].map((energy,i)=>record({seriesId:`goes.sgps.p${energy}`,energy,value:10/(i+1),publishedAt:null,measuredAt:iso(sampled)}));
 const orbit=omm(snap([elements],'celestrak.gp'));
 const modelRunner=async profile=>({samples:profile.samples.filter(p=>p.lat!==null).map(p=>({t:p.t,L:3,B:30000,magLat:55,ap8Min:0,ap8Max:0,ap8Floor:true})),model:'stub',version:'stub'});
 const d=await buildDataset(current,[...orbit,...spectrum],{modelRunner,generatedAt:iso(t+40*60000)}),at=x=>d.profile.samples.find(p=>p.t===x);
 assert.equal(at(t).sep,null);assert.equal(at(sampled).sepBasis,'observation');
 assert.equal(at(t+3600000).sepBasis,'persistence');assert.equal(at(t+3600000).sepObservedAt,sampled);
 // No geomagnetic index: only the unshielded bound J(>=30 MeV) remains.
 assert.equal(at(sampled).sep,2.5);assert.equal(at(sampled).sepBound,true);
 const history=await buildDataset(request,[...orbit,...spectrum],{modelRunner});
 assert(history.profile.samples.every(p=>p.sepBasis!=='persistence'));
});
test('context mechanisms never block a complete decision set',async()=>{
 const d=await buildDataset(request,[]);
 for(const p of d.profile.samples)Object.assign(p,{lat:10,lon:20,alt:420,sunlit:true,saa:false,sep:p.t<t+3600000?2:0,trapped:0,meteor:0,gcr:null,ops:null});
 const plan=assessV2(request,d);
 assert.equal(plan.outcome,'recommendation');assert.equal(plan.recommended.factors.gcr.status,'context');assert(plan.recommended.confidence.reasons.some(r=>r.code==='context'));
 const legacy=structuredClone(d);delete legacy.rules.decisionMechanisms;assert.equal(assessV2(request,legacy).outcome,'insufficient');
});
test('an empty successful response is fresh; sources outside the mode are not applicable',async()=>{
 const d=await buildDataset(request,[],{outcomes:[{id:'nasa.donki',ok:true,fetchedAt:iso(t),version:'v'}]}),source=id=>d.sources.find(s=>s.id===id);
 assert.equal(source('nasa.donki').status,'fresh');assert.equal(source('nasa.donki').version,'v');
 assert.equal(source('celestrak.gp').applicable,false);assert.equal(source('spacetrack.history').applicable,true);
});
test('meteor table is a dated upper bound below the threshold for the longest window',async()=>{
 // SPENVIS sanity: Grün F(>=1e-6 g) ≈ 1.49 m^-2 yr^-1 at 1 AU; Earth factor at 420 km ≈ 1.27.
 assert(Math.abs(grun(1e-6)*3.15576e7-1.488)<0.01);assert(Math.abs(earthFactor(420)-1.2725)<1e-3);
 const d=await buildDataset(request,[]);
 assert(d.profile.samples.every(p=>p.meteor!==null&&p.meteor*8*3600<rules.meteor.threshold.value));
 const meo=d.sources.find(s=>s.id==='nasa.meo');assert.equal(meo.status,'fresh');assert.equal(meo.replayEligible,true);
 const early=await buildDataset({...request,historyMode:'replay',cutoff:'2023-10-01T00:00:00Z'},[]);
 assert(early.profile.samples.every(p=>p.meteor===null));
});
