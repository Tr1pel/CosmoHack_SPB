import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Cache} from '../pipeline/cache.mjs';
import {normalizeSeries,selectVersions,valueAt,coverageOf} from '../pipeline/quality.mjs';
import {goes,hp30,omm,nmdb,socrates,geoalert,parseCSV} from '../pipeline/adapters.mjs';
import {orbitProfile,accessibleFlux} from '../pipeline/orbit.mjs';
import {buildDataset} from '../pipeline/build.mjs';
import {validateV2,assessV2,compareVector} from '../dist/pipeline.js';
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
 const d=validateV2(await buildDataset(request,[]));assert.equal(d.sources.length,10);const plan=assessV2(request,d);assert.equal(plan.outcome,'insufficient');assert.equal(plan.improvement,false);assert.equal(plan.recommended.confidence.level,'low');assert.equal(plan.original.factors.sep.value,null);
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
