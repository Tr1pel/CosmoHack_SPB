import test from 'node:test';
import assert from 'node:assert/strict';
import {magneticProfile} from '../pipeline/orbit.mjs';
const python=process.env.PIPELINE_PYTHON;
test('real IRBEM batch returns IGRF and AP8 for historical SAA coordinates',{skip:!python},async()=>{
 const start=Date.parse('2024-05-10T10:00:00Z');
 const profile={samples:Array.from({length:121},(_,i)=>({t:start+i*30000,lat:-25,lon:-45,alt:420}))};
 const result=await magneticProfile(profile,python);assert.equal(result.error,undefined);assert.equal(result.samples.length,121);
 for(const p of result.samples){assert(p.B>15000&&p.B<25000);assert(p.L>1&&p.L<2);assert(p.ap8Min>0);assert(p.ap8Max>0);assert(Number.isFinite(p.magLat));}
 // Reference values from the public scalar SpacePy get_AEP8 wrapper, same point.
 assert(Math.abs(result.samples[0].ap8Min-1913.7896570829114)<1e-5);
 assert(Math.abs(result.samples[0].ap8Max-880.397904372454)<1e-5);
});
test('IRBEM never silently clamps dates beyond coefficient validity',{skip:!python},async()=>{
 const result=await magneticProfile({samples:[{t:Date.parse('2026-09-19T10:00:00Z'),lat:-25,lon:-45,alt:420}]},python);
 assert.equal(result.samples.length,0);assert.match(result.error,/2025/);
});
