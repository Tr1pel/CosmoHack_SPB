import test from 'node:test';
import assert from 'node:assert/strict';
import { MockDataProvider, validateDataset } from '../dist/providers.js';
import { computePlan, HOUR, orbitPoint, validateRequest, overlap, nextStartUTC } from '../dist/domain.js';
import { zipFiles } from '../dist/export.js';
const request={mode:'current',historyMode:'archive',start:'2026-09-19T10:00:00Z',duration:4,shift:12,cutoff:'2024-05-10T09:00:00Z',lightConstraint:false};
const provider=new MockDataProvider();
test('API rejects incomplete datasets and respects disabled sources',async()=>{const d=await provider.load(request);assert.equal(validateDataset(d,['weather']).sources[0].enabled,false);assert.throws(()=>validateDataset({...d,sources:d.sources.slice(1)}));assert.throws(()=>validateDataset({...d,events:[{...d.events[0],end:NaN}]}));});
test('default scenario avoids both alerts with an equal-duration 14:00 alternative',async()=>{const {plan:p}=await provider.calculate(request);assert.equal(p.recommended.start,Date.parse('2026-09-19T14:00:00Z'));assert.equal(p.alternative.end-p.alternative.start,4*HOUR);assert.equal(p.original.warnings.length,2);assert.equal(p.recommended.warnings.length,0);assert.equal(p.improvement,true);});
test('disabled and stale sources never become safe missing events',async()=>{const {plan:p,data}=await provider.calculate(request,['conjunction']);assert.equal(p.recommended.status,'insufficient');assert.equal(p.improvement,false);assert(p.recommended.confidence<100);data.sources[0].status='stale';assert(computePlan(request,data).recommended.missing.includes('weather'));});
test('replay excludes publications after cutoff, including late versions of events',async()=>{const r={...request,mode:'history',historyMode:'replay',start:'2024-05-10T10:00:00Z',cutoff:'2024-05-10T07:30:00Z'};const data=await provider.load(r);data.events.push({...data.events[0],id:'future',publishedAt:'2024-05-10T08:15:00Z'});const p=computePlan(r,data);assert(!p.events.some(e=>e.sourceId==='conjunction'||e.id==='future'));assert(p.recommended.missing.includes('conjunction'));assert.equal(p.cutoff,r.cutoff);assert.equal(p.strictReproducibility,false);});
test('archive has access to late publications',async()=>{const r={...request,mode:'history',historyMode:'archive',start:'2024-05-10T10:00:00Z',cutoff:'2024-05-10T07:30:00Z'};const {plan:p}=await provider.calculate(r);assert(p.events.some(e=>e.sourceId==='conjunction'));assert.equal(p.cutoff,null);});
test('zero shift returns one window and no invented alternative',async()=>{const {plan:p}=await provider.calculate({...request,shift:0});assert.equal(p.candidates.length,1);assert.equal(p.alternative,null);assert.equal(p.improvement,false);});
test('no beneficial shift is reported honestly',async()=>{const {plan:p}=await provider.calculate({...request,start:'2026-09-19T14:00:00Z',shift:2});assert.equal(p.improvement,false);assert.equal(p.recommended.start,p.original.start);});
test('lighting score uses the same orbital samples as the map',async()=>{const {plan:p}=await provider.calculate({...request,lightConstraint:true});const w=p.original;const light=Array.from({length:240},(_,i)=>orbitPoint(w.start+i*60000,p.orbit.epoch)).filter(v=>v.sunlit).length;assert.equal(w.lightMinutes,light);const normal=(await provider.calculate(request)).plan.original;assert.equal(w.penalty,normal.penalty+(240-light)*1.2);});
test('partial coverage is penalized and visible',async()=>{const {plan:p}=await provider.calculate({...request,start:'2026-09-19T18:00:00Z',shift:0});assert.equal(p.original.gaps.length,1);assert.equal(p.original.status,'review');assert.equal(p.original.confidence,80);});
test('UTC crossing midnight preserves duration and shift bounds',async()=>{const r={...request,start:'2026-09-19T23:30:00Z',duration:8,shift:24};const {plan:p}=await provider.calculate(r);for(const w of p.candidates){assert.equal(w.end-w.start,8*HOUR);assert(w.start>=Date.parse(r.start)&&w.start<=Date.parse(r.start)+24*HOUR);}assert.equal(new Date(p.original.end).toISOString(),'2026-09-20T07:30:00.000Z');});
test('bounds and replay cutoff are validated',()=>{for(const change of [{duration:0},{duration:9},{shift:25},{shift:-1},{start:''},{duration:NaN},{mode:'history',historyMode:'replay',cutoff:'2027-01-01T00:00:00Z'}])assert.throws(()=>validateRequest({...request,...change}));assert.equal(overlap(0,10,10,20),0);});
test('export is a valid ZIP STORE archive with UTF-8 JSON intact',async()=>{const input={'calculation.json':JSON.stringify({demo:true,text:'Проверка'})};const zip=new Uint8Array(await zipFiles(input).arrayBuffer());const view=new DataView(zip.buffer);assert.equal(view.getUint32(0,true),0x04034b50);const length=view.getUint32(18,true),nameLength=view.getUint16(26,true);assert.equal(new TextDecoder().decode(zip.slice(30+nameLength,30+nameLength+length)),input['calculation.json']);assert.equal(view.getUint32(zip.length-22,true),0x06054b50);});
test('current mode plans forward: a time of day already gone means tomorrow',()=>{
 const now=Date.parse('2026-09-19T19:37:00Z');
 // The hour already running still counts as today; anything before it rolls over.
 assert.equal(nextStartUTC('19:00',now),'2026-09-19T19:00:00Z');
 assert.equal(nextStartUTC('19:30',now),'2026-09-19T19:30:00Z');
 assert.equal(nextStartUTC('20:00',now),'2026-09-19T20:00:00Z');
 assert.equal(nextStartUTC('01:00',now),'2026-09-20T01:00:00Z');
 assert.equal(nextStartUTC('18:59',now),'2026-09-20T18:59:00Z');
 // Midnight rollover must not produce an invalid date, and junk must not produce a start.
 assert.equal(nextStartUTC('00:30',Date.parse('2026-12-31T23:10:00Z')),'2027-01-01T00:30:00Z');
 for(const bad of ['','25:00','9:00',null,undefined])assert.equal(nextStartUTC(bad,now),'');
 // Whatever it returns must be a start validateRequest accepts.
 assert.doesNotThrow(()=>validateRequest({mode:'current',historyMode:'archive',start:nextStartUTC('01:00',now),duration:4,shift:12,cutoff:'2024-05-10T09:00:00Z',lightConstraint:false}));
});
