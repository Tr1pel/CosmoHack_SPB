import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {magneticProfile} from '../pipeline/orbit.mjs';
const python=process.env.PIPELINE_PYTHON;
const point=(t,lat=-25,lon=-45)=>({samples:[{t,lat,lon,alt:420}]});
// Reference values from the public scalar SpacePy get_AEP8 wrapper, same point, per bundled IGRF.
const reference={13:{ap8Min:1913.7896570829114,ap8Max:880.397904372454},14:{ap8Min:1946.7881212043221,ap8Max:903.9808586381707}};
test('real IRBEM batch returns IGRF and AP8 for historical SAA coordinates',{skip:!python},async()=>{
 const start=Date.parse('2024-05-10T10:00:00Z');
 const profile={samples:Array.from({length:121},(_,i)=>({t:start+i*30000,lat:-25,lon:-45,alt:420}))};
 const result=await magneticProfile(profile,python);assert.equal(result.error,undefined);assert.equal(result.samples.length,121);
 for(const p of result.samples){assert(p.B>15000&&p.B<25000);assert(p.L>1&&p.L<2);assert(p.ap8Min>0);assert(p.ap8Max>0);assert.equal(p.ap8Floor,false);assert(Number.isFinite(p.magLat));}
 const expected=reference[result.igrf];assert(expected,`no reference for IGRF-${result.igrf}`);
 assert(Math.abs(result.samples[0].ap8Min-expected.ap8Min)<1e-5);
 assert(Math.abs(result.samples[0].ap8Max-expected.ap8Max)<1e-5);
});
test('IRBEM never silently clamps dates beyond coefficient validity',{skip:!python},async()=>{
 const {igrf}=await magneticProfile(point(Date.parse('2024-05-10T10:00:00Z')),python),limit=1960+5*igrf;
 const result=await magneticProfile(point(Date.UTC(limit,0,1)),python);
 assert.equal(result.samples.length,0);assert.match(result.error,new RegExp(String(limit)));
});
test('IGRF-14 build covers current dates',{skip:!python},async t=>{
 const result=await magneticProfile(point(Date.parse('2026-09-19T10:00:00Z')),python);
 if(result.igrf<14)return t.skip('SpacePy with IGRF-13 only; install requirements-server.txt');
 assert.equal(result.error,undefined);assert(result.samples[0].B>15000&&result.samples[0].B<25000);
});
test('AP-8 below the model floor is zero flux, not an unknown',{skip:!python},async()=>{
 // Northern mid-latitude at ISS altitude: B/B0 far inside the loss cone.
 const result=await magneticProfile(point(Date.parse('2024-05-10T10:00:00Z'),45,30),python);
 const [p]=result.samples;assert.equal(p.ap8Min,0);assert.equal(p.ap8Max,0);assert.equal(p.ap8Floor,true);
});
test('GOES history reconstruction integrates a power-law spectrum exactly',{skip:!python},()=>{
 const result=spawnSync(python,[fileURLToPath(new URL('../pipeline/goes_history.py',import.meta.url)),'--selftest'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"selftest": "ok"/);
});
