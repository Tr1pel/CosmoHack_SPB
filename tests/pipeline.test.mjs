import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Cache} from '../pipeline/cache.mjs';
import {normalizeSeries,selectVersions,valueAt,coverageOf} from '../pipeline/quality.mjs';
import {goes,hp30,hp30Forecast,swpcProbabilities,swpcAlerts,omm,nmdb,socrates,geoalert,parseCSV} from '../pipeline/adapters.mjs';
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
test('map orbit covers 24 hours after the last candidate without extending mechanism calculations',async()=>{
 const records=omm(snap([elements,{...elements,EPOCH:'2024-05-11T08:00:00'}],'spacetrack.history'));
 let modelSamples=0;
 const d=await buildDataset(request,records,{modelRunner:async profile=>{modelSamples=profile.samples.length;return {samples:[],error:'Test fixture'};}});
 assert.equal(d.profile.samples.at(-1).t,t+2*3600000);
 assert.equal(modelSamples,d.profile.samples.length);
 assert.equal(d.mapProfile.samples.at(-1).t,t+25*3600000);
 assert.notEqual(d.mapProfile.samples.at(-1).lat,null);
 assert.deepEqual(d.profile.samples.map(p=>[p.t,p.lat,p.lon,p.sunlit]),d.mapProfile.samples.slice(0,d.profile.samples.length).map(p=>[p.t,p.lat,p.lon,p.sunlit]));
 assert.equal(assessV2(request,validateV2(d)).mapProfile,d.mapProfile);
 const bad=structuredClone(d);bad.mapProfile.samples[0].lon=NaN;assert.throws(()=>validateV2(bad));
 const replay=await buildDataset({...request,historyMode:'replay'},records);
 assert(replay.mapProfile.samples.every(p=>p.lat===null));
 const disabled=await buildDataset(request,records,{disabled:['spacetrack.history']});
 assert(disabled.mapProfile.samples.every(p=>p.lat===null));
});
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
 const d=validateV2(await buildDataset(request,[]));assert.equal(d.sources.length,14);const plan=assessV2(request,d);assert.equal(plan.outcome,'insufficient');assert.equal(plan.improvement,false);assert.equal(plan.recommended.confidence.level,'low');assert.equal(plan.original.factors.sep.value,null);
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
test('SOCRATES ignores vehicles docked to the station',()=>{
 const csv='NORAD_CAT_ID_1,NORAD_CAT_ID_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED\n25544,100057,2024-05-10 12:00:00,0.006,0.000\n25544,123,2024-05-10 13:00:00,0.8,11.2';
 const rows=socrates(snap(csv,'celestrak.socrates'));assert.equal(rows.length,1);assert.equal(rows[0].payload.NORAD_CAT_ID_2,'123');
});
test('GCR proxy follows the cutoff; SOCRATES coverage spans only its screened days',async()=>{
 const current={...request,mode:'current'},screened=t+30*60000;
 const conjunction=socrates({...snap('NORAD_CAT_ID_1,NORAD_CAT_ID_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED\n25544,123,2024-05-10 11:00:00,0.8,11.2','celestrak.socrates'),fetchedAt:iso(screened)});
 const index=hp30(snap({datetime:[iso(t-1800000),iso(t)],Hp30:[2,2]},'gfz.hp30'));
 const modelRunner=async profile=>({samples:profile.samples.filter(p=>p.lat!==null).map(p=>({t:p.t,L:3,B:30000,magLat:55,ap8Min:0,ap8Max:0,ap8Floor:true})),model:'stub',version:'stub'});
 const d=await buildDataset(current,[...omm(snap([elements],'celestrak.gp')),...conjunction,...index],{modelRunner,generatedAt:iso(t+40*60000),outcomes:[{id:'celestrak.socrates',ok:true,fetchedAt:iso(screened)}]});
 const at=x=>d.profile.samples.find(p=>p.t===x),rc=cutoffRigidity(55,at(t).alt,2,rules.cutoff).rc;
 assert(Math.abs(at(t).gcr-(1+rc/rules.gcr.r0GV)**-rules.gcr.gamma)<1e-12);
 assert.equal(at(t).ops,null);assert.equal(at(t+3600000).ops,1);assert.equal(at(t+7200000).ops,0);
});
test('good windows come first; without them the two best are still shown',async()=>{
 const d=await buildDataset({...request,shift:2},[]);
 const fill=(sep,trapped)=>{for(const p of d.profile.samples)Object.assign(p,{lat:10,lon:20,alt:420,sunlit:true,saa:false,sep:sep(p.t),trapped:trapped(p.t),meteor:0,gcr:0.1,ops:null});};
 fill(x=>0.1,x=>x<t+3600000?500:0);
 let plan=assessV2({...request,shift:2},d);
 assert(plan.goodCount>0);assert.equal(plan.recommended.status,'acceptable');assert(plan.best.every(id=>plan.candidates.find(w=>w.id===id).status==='acceptable'));
 assert.equal(plan.recommended.factors.gcr.status,'context');
 fill(x=>2,x=>0);
 plan=assessV2({...request,shift:2},d);
 assert.equal(plan.goodCount,0);assert.equal(plan.best.length,2);assert.deepEqual(plan.candidates.map(w=>w.position).sort(),[1,2,3]);
});
test('cache parses each immutable record file once',async()=>{
 const root=await mkdtemp(join(tmpdir(),'eva-cache-'));
 try{const c=new Cache(root);await c.append([record()]);let reads=0;const read=c.read.bind(c);c.read=(...a)=>{reads++;return read(...a);};
  assert.equal((await c.records()).length,1);assert.equal((await c.records()).length,1);assert.equal(reads,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('confidence scores each criterion 0-4 and takes the weakest; a measured window reaches high',async()=>{
 const d=await buildDataset(request,[]);
 const fill=extra=>{for(const p of d.profile.samples)Object.assign(p,{lat:10,lon:20,alt:420,sunlit:true,saa:false,sep:0.1,trapped:0,meteor:0,gcr:0.1,ops:0,cutoff:'quiet',sepBasis:'observation',sepBound:false,...extra});};
 const at=id=>assessV2(request,d).original.confidence.criteria.find(c=>c.id===id).score;
 fill();
 const w=assessV2(request,d).original;
 assert.equal(w.confidence.score,4);assert.equal(w.confidence.level,'high');
 assert.equal(w.confidence.score,Math.min(...w.confidence.criteria.map(c=>c.score)));
 // A storm puts the cutoff model outside its quiet-dipole regime; an upper bound is only a caveat.
 fill({cutoff:'storm'});assert.equal(at('model'),2);assert.equal(assessV2(request,d).original.confidence.level,'medium');
 fill({sepBound:true});assert.equal(at('model'),3);assert.equal(assessV2(request,d).original.confidence.level,'high');
 // Missing coverage of a decision mechanism is 0 regardless of every other criterion.
 fill({trapped:null});assert.equal(at('coverage'),0);assert.equal(assessV2(request,d).original.confidence.level,'low');
});
test('the persistence baseline never scores above 2, and without a SWPC issue it scores 0',async()=>{
 const current={...request,mode:'current'};
 const d=await buildDataset(current,[],{generatedAt:iso(t)});
 for(const p of d.profile.samples)Object.assign(p,{lat:10,lon:20,alt:420,sunlit:true,saa:false,sep:0.1,trapped:0,meteor:0,gcr:0.1,ops:0,cutoff:'quiet',sepBasis:'persistence',sepObservedAt:t,sepBound:false,sepEventProbability:1});
 const basis=()=>assessV2(current,d).original.confidence.criteria.find(c=>c.id==='forecast').score;
 assert.equal(basis(),2);
 for(const p of d.profile.samples)p.sepEventProbability=40;assert.equal(basis(),1);
 for(const p of d.profile.samples)p.sepEventProbability=null;assert.equal(basis(),0);
});
test('SWPC probabilities map day 1-3 onto whole UTC days and stay undated',()=>{
 const rows=swpcProbabilities(snap([{date:'2024-05-10T00:00:00','10mev_protons_1_day':1,'10mev_protons_2_day':15,'10mev_protons_3_day':null,polar_cap_absorption:'green'}],'noaa.swpc.probabilities'));
 assert.equal(rows.length,2);
 assert.equal(rows[0].start,Date.parse('2024-05-10T00:00:00Z'));assert.equal(rows[0].end,Date.parse('2024-05-11T00:00:00Z'));
 assert.equal(rows[1].value,15);assert.equal(rows[1].start,Date.parse('2024-05-11T00:00:00Z'));
 // The product states no issue time, so it must never become a replay source.
 assert.equal(rows[0].publishedAt,null);assert.equal(rows[0].quantity,'sep_event_probability');
 assert.throws(()=>swpcProbabilities(snap([{date:'2024-05-10T00:00:00'}],'noaa.swpc.probabilities')));
});
test('SWPC alerts keep issue time apart from validity and split protons from the rest',()=>{
 const warning='Space Weather Message Code: WARPX1\r\nSerial Number: 631\r\nIssue Time: 2024 May 10 1620 UTC\r\n\r\nWARNING: Proton 10MeV Integral Flux above 10pfu expected\r\nValid From: 2024 May 10 1620 UTC\r\nValid To: 2024 May 11 0200 UTC';
 const hundred='Space Weather Message Code: WARPC0\r\nSerial Number: 123\r\nIssue Time: 2024 May 10 1630 UTC\r\nValid From: 2024 May 10 1630 UTC\r\nNow Valid Until: 2024 May 11 0000 UTC';
 const summary='Space Weather Message Code: SUMPX1\r\nSerial Number: 134\r\nSUMMARY: Proton Event 10MeV Integral Flux exceeded 10pfu\r\nBegin Time: 2024 May 10 1615 UTC\r\nEnd Time: 2024 May 10 2135 UTC';
 const rows=swpcAlerts(snap([
   {product_id:'P11W',issue_datetime:'2024-05-10 16:20:40.413',message:warning},
   {product_id:'P20W',issue_datetime:'2024-05-10 16:30:00.000',message:hundred},
   {product_id:'P11S',issue_datetime:'2024-05-11 11:55:17.633',message:summary},
   {product_id:'K04W',issue_datetime:'2024-05-10 12:00:00.000',message:'Space Weather Message Code: WATA20\r\nGeomagnetic K-index of 4'}],'noaa.swpc.alerts'));
 const warn=rows.filter(r=>r.quantity==='sep_warning');
 assert.equal(warn.length,3);assert.equal(rows.filter(r=>r.quantity==='bulletin').length,1);
 assert.equal(warn[0].publishedAt,'2024-05-10T16:20:40.413Z');
 assert.equal(warn[0].start,Date.parse('2024-05-10T16:20:00Z'));assert.equal(warn[0].end,Date.parse('2024-05-11T02:00:00Z'));
 assert.equal(warn[0].value,10);assert.equal(warn[1].value,100);
 // A summary describes an event already over and must not suppress a later baseline.
 assert.equal(warn[2].payload.summary,true);assert.equal(warn[0].payload.summary,false);
});
test('partial forecast coverage leaves the confirmed part; a live warning removes confirmation',async()=>{
 const current={...request,mode:'current'};
 const d=await buildDataset(current,[],{generatedAt:iso(t)});
 const fill=extra=>{for(const p of d.profile.samples)Object.assign(p,{lat:10,lon:20,alt:420,sunlit:true,saa:false,sep:0.1,trapped:0,meteor:0,gcr:0.1,ops:0,cutoff:'quiet',sepBasis:'persistence',sepObservedAt:t,sepBound:false,sepEventProbability:1,sepWarning:false,...extra});};
 const basis=()=>assessV2(current,d).original.confidence.criteria.find(c=>c.id==='forecast');
 fill();assert.equal(basis().score,2);
 // The horizon ends inside the window: the covered part still counts, so 1 rather than 0.
 fill();for(const p of d.profile.samples)if(p.t>=t+1800000)p.sepEventProbability=null;
 assert.equal(basis().score,1);assert.match(basis().detail,/хвост окна выходит за горизонт/);
 fill({sepWarning:true});assert.equal(basis().score,1);assert.match(basis().detail,/предупреждение SWPC/);
 fill({sepEventProbability:null});assert.equal(basis().score,0);
});
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const swpcTime=x=>{const d=new Date(x),p2=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()} ${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}${p2(d.getUTCMinutes())} UTC`;};
test('a warning issued before the lookback still counts while its validity covers the window',async()=>{
 const current={...request,mode:'current'},issued=t-6*86400000;
 const alert=swpcAlerts({...snap([{product_id:'P11W',issue_datetime:iso(issued).replace('T',' ').replace('Z',''),
   message:`Space Weather Message Code: WARPX1\r\nSerial Number: 900\r\nValid From: ${swpcTime(issued)}\r\nNow Valid Until: ${swpcTime(t+3600000)}`}],'noaa.swpc.alerts'),fetchedAt:iso(t)});
 assert.equal(alert[0].quantity,'sep_warning');assert.equal(alert[0].end,t+3600000);
 const outcomes=[{id:'noaa.swpc.alerts',ok:true,fetchedAt:iso(t),version:'v'}];
 const d=await buildDataset(current,alert,{generatedAt:iso(t),outcomes});
 const at=x=>d.profile.samples.find(p=>p.t===x);
 assert.equal(at(t).sepWarning,true);assert.equal(at(t+5400000).sepWarning,false);
 // Without the feed the answer is unknown, not "quiet".
 const blind=await buildDataset(current,[],{generatedAt:iso(t)});
 assert.equal(blind.profile.samples[0].sepWarning,null);
});
