export const PROVENANCE = ['observation', 'external_forecast', 'own_computation', 'model', 'synthetic'];
const bounds = {proton_integral_flux:[0,1e6], proton_differential_flux:[0,1e6], hp30:[0,Infinity], kp:[0,9], neutron_rate:[0,1e5], rc:[0,20]};
export const ms = x => typeof x === 'number' ? x : Date.parse(x);
export const iso = x => new Date(x).toISOString();
export function validateMeteorTable(table){
  if(!Array.isArray(table.records))throw new Error('Meteor table must contain records');
  for(const r of table.records){
    if(!Number.isFinite(ms(r.start))||!Number.isFinite(ms(r.end))||ms(r.end)<=ms(r.start)||
      !Number.isFinite(ms(r.publishedAt))||!r.sourceVersion||!/^https:\/\//.test(r.sourceUrl)||
      !Number.isFinite(r.massThresholdG)||r.massThresholdG<=0||!Number.isFinite(r.fluxM2Second)||r.fluxM2Second<0)
      throw new Error('Meteor records need absolute flux, mass threshold, interval and a dated source');
  }return table;
}
export function validateRecord(r) {
  const utc=x=>typeof x==='string'&&x.endsWith('Z')&&Number.isFinite(ms(x));
  if (!r || !r.sourceId || !r.seriesId || !r.instrument || !r.sourceVersion || !PROVENANCE.includes(r.provenance) ||
      !utc(r.measuredAt) || !utc(r.fetchedAt) ||
      (r.publishedAt !== null && (!utc(r.publishedAt) || ms(r.measuredAt)>ms(r.publishedAt))))
    throw new Error('Invalid record identity, provenance or chronology');
  return r;
}
// Unknown publication times never acquire fetchedAt as an invented publication date.
export function selectVersions(records, cutoff = Infinity) {
  const chosen = new Map();
  for (const r of records) {
    validateRecord(r);
    if (cutoff !== Infinity && (r.publishedAt === null || ms(r.publishedAt)>cutoff)) continue;
    const key = JSON.stringify([r.sourceId,r.seriesId,r.instrument,r.recordId ?? r.measuredAt]);
    const prev=chosen.get(key), rank=x=>ms(x.publishedAt ?? x.fetchedAt);
    if (!prev || rank(r)>rank(prev) || (rank(r)===rank(prev)&&(ms(r.fetchedAt)>ms(prev.fetchedAt)||(ms(r.fetchedAt)===ms(prev.fetchedAt)&&(r.adapterVersion??0)>(prev.adapterVersion??0))))) chosen.set(key,r);
  }
  return [...chosen.values()];
}
export function normalizeSeries(records, cutoff=Infinity) {
  const groups=new Map();
  for (const r of selectVersions(records,cutoff)) {
    if (!bounds[r.quantity]) continue;
    const id=`${r.seriesId}.${r.instrument.replace(/[^\w-]/g,'_')}`;
    if (!groups.has(id)) groups.set(id,{id,sourceId:r.sourceId,instrument:r.instrument,quantity:r.quantity,energy:r.energy??null,unit:r.unit,provenance:r.provenance,cadenceMinutes:r.cadenceMinutes,maxAgeMinutes:r.maxAgeMinutes,interpolation:r.interpolation??'step',samples:[]});
    const [lo,hi]=bounds[r.quantity];
    let q=r.q??'ok', v=r.value;
    if (typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi) {q='fill';v=null;}
    if (q!=='ok') v=null;
    groups.get(id).samples.push({t:ms(r.measuredAt),v,q,publishedAt:r.publishedAt,fetchedAt:r.fetchedAt,sourceVersion:r.sourceVersion});
  }
  const series=[...groups.values()];
  for (const s of series) {
    s.samples.sort((a,b)=>a.t-b.t);
    // Flag only an isolated spike, never replace it with a fabricated measurement.
    const original=s.samples.map(p=>({...p}));
    for(let i=2;i<original.length-2;i++) {
      const p=original[i], neighbors=original.slice(i-2,i+3);
      if(neighbors.some(x=>x.q!=='ok') || neighbors[4].t-neighbors[0].t>4.1*s.cadenceMinutes*60000) continue;
      const sorted=neighbors.map(x=>x.v).sort((a,b)=>a-b), median=sorted[2];
      if(p.v>Math.max(median*10,median+1) && original[i-1].v<=median*2+0.01 && original[i+1].v<=median*2+0.01) Object.assign(s.samples[i],{v:null,q:'spike'});
    }
  }
  const channels=new Map();
  for(const s of series.filter(s=>s.quantity==='proton_integral_flux')) for(const p of s.samples){
    const key=`${s.sourceId}/${s.instrument}/${p.t}`;
    if(!channels.has(key)) channels.set(key,[]);
    channels.get(key).push({energy:s.energy,p});
  }
  for(const group of channels.values()) {
    group.sort((a,b)=>a.energy-b.energy);
    const bad=new Set();
    for(let i=1;i<group.length;i++) if(group[i-1].p.q==='ok'&&group[i].p.q==='ok'&&group[i-1].p.v<group[i].p.v) {bad.add(group[i-1].p);bad.add(group[i].p);}
    for(const p of bad) Object.assign(p,{v:null,q:'channel_order'});
  }
  return series;
}
export function valueAt(s,t) {
  let lo=0,hi=s.samples.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(s.samples[mid].t<=t)lo=mid+1;else hi=mid;}
  const a=s.samples[lo-1],b=s.samples[lo];
  if(!a||a.q!=='ok'||t-a.t>s.maxAgeMinutes*60000) return null;
  if(t===a.t||s.interpolation==='step')return a.v;
  if(!b||b.q!=='ok'||b.t-a.t>s.maxAgeMinutes*60000)return null;
  return a.v+(b.v-a.v)*(t-a.t)/(b.t-a.t);
}
export function coverageOf(series,start,end,step=30000) {
  let valid=0,total=0,open=null;const gaps=[];
  for(let t=start;t<end;t+=step){total++;if(valueAt(series,t)!==null){valid++;if(open!==null){gaps.push({start:open,end:t});open=null;}}else if(open===null)open=t;}
  if(open!==null)gaps.push({start:open,end});
  return {validSamples:valid,expectedSamples:total,fraction:total?valid/total:0,gaps};
}
