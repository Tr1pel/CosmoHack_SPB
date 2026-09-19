import test from 'node:test';
import assert from 'node:assert/strict';
import {pointAt,orbitMinutes,nearestMinute,orbitMarkers} from '../dist/orbit-map.js';

const start=Date.parse('2024-05-10T10:00:00Z');
const profile=minutes=>({stepSeconds:30,samples:Array.from({length:minutes*2+1},(_,i)=>({t:start+i*30000,lat:20,lon:i%360-180,sunlit:true}))});
const window={start,end:start+4*3600000};

test('24-hour map uses its own profile past the planning horizon, including the endpoint',()=>{
  const plan={demo:false,profile:profile(6*60),mapProfile:profile(24*60)};
  const minutes=orbitMinutes(plan,start,24);
  assert.equal(minutes.length,1441);
  assert.equal(minutes.at(-1),1440);
  assert.notEqual(pointAt(plan,start+24*3600000).lat,null);
  assert.equal(pointAt(plan,start+24*3600000+1).lat,null);
  assert.match(orbitMarkers(plan,window,start+24*3600000),/orbit-position/);
});

test('start and finish remain visible when the scrubbed position has no coordinates',()=>{
  const plan={demo:false,profile:profile(6*60)};
  const html=orbitMarkers(plan,window,start+24*3600000);
  assert.match(html,/orbit-start/);
  assert.match(html,/orbit-end/);
  assert.doesNotMatch(html,/orbit-position/);
});

test('scrubber clamps to existing coordinates for old API responses and skips gaps',()=>{
  const plan={demo:false,profile:profile(6*60)};
  plan.profile.samples[240].lat=null;
  const minutes=orbitMinutes(plan,start,24);
  assert.equal(minutes.at(-1),360);
  assert(!minutes.includes(120));
  assert.equal(nearestMinute(minutes,1440),360);
  assert.notEqual(pointAt(plan,start+nearestMinute(minutes,120)*60000).lat,null);
  assert.equal(nearestMinute(minutes,120,1),121);
  assert.equal(nearestMinute(minutes,120,-1),119);
  assert.equal(pointAt(plan,start-1).lat,null);
});

test('missing orbital data disables the scrubber without inventing a position',()=>{
  const plan={demo:false,profile:{stepSeconds:30,samples:[]}};
  assert.deepEqual(orbitMinutes(plan,start,24),[]);
  assert.equal(nearestMinute([],100),0);
  assert.equal(orbitMarkers(plan,window,start),'');
});
