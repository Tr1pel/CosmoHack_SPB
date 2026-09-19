import {orbitPoint} from './domain.js';

const missing=()=>({lat:null,lon:null,sunlit:null});
const valid=p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lon);

export function pointAt(plan,t){
  if(plan.demo)return orbitPoint(t,plan.orbit.epoch);
  const profile=plan.mapProfile??plan.profile,samples=profile?.samples??[],step=profile?.stepSeconds*1000;
  if(!samples.length||!Number.isFinite(t)||t<samples[0].t||t>samples.at(-1).t||!(step>0))return missing();
  const point=samples[Math.floor((t-samples[0].t)/step)];
  return valid(point)?point:missing();
}

export function orbitAvailable(plan){
  return plan.demo?Boolean(plan.sources.find(s=>s.id==='orbit')?.eligible):(plan.mapProfile??plan.profile)?.samples.some(valid)??false;
}

// Keep the scrubber on known coordinates, including profiles with internal gaps.
export function orbitMinutes(plan,start,hours){
  if(!orbitAvailable(plan))return [];
  const minutes=[];
  for(let minute=0;minute<=hours*60;minute++)if(valid(pointAt(plan,start+minute*60000)))minutes.push(minute);
  return minutes;
}

export function nearestMinute(minutes,requested,direction=0){
  if(direction>0)return minutes.find(minute=>minute>=requested)??minutes.at(-1)??0;
  if(direction<0)return minutes.findLast(minute=>minute<=requested)??minutes[0]??0;
  return minutes.reduce((best,minute)=>Math.abs(minute-requested)<Math.abs(best-requested)?minute:best,minutes[0]??0);
}

export function orbitMarkers(plan,window,t){
  if(!orbitAvailable(plan))return '';
  const x=lon=>(lon+180)/360*700,y=lat=>(90-lat)/180*340;
  const marker=(at,label,color,kind)=>{
    const p=pointAt(plan,at);
    if(!valid(p))return '';
    const right=p.lon>150;
    return `<g class="orbit-marker ${kind}"><circle cx="${x(p.lon)}" cy="${y(p.lat)}" r="5" fill="${color}" stroke="#192a42" stroke-width="2"/><text x="${x(p.lon)+(right?-9:9)}" y="${y(p.lat)-9}" text-anchor="${right?'end':'start'}" fill="#edf3fb" font-size="12" font-family="sans-serif">${label}</text></g>`;
  };
  const p=pointAt(plan,t);
  // Endpoints belong to the selected EVA window and never depend on the scrubber.
  return marker(window.start,'СТАРТ','#74a6e8','orbit-start')+marker(window.end,'ФИНИШ','#e7a976','orbit-end')+(valid(p)?`<g class="orbit-position"><circle cx="${x(p.lon)}" cy="${y(p.lat)}" r="10" fill="#72a9ed33"/><circle cx="${x(p.lon)}" cy="${y(p.lat)}" r="4" fill="white"/></g>`:'');
}
