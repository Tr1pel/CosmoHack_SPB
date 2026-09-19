import {json2satrec,propagate,gstime,eciToGeodetic,degreesLat,degreesLong,sunPos,jday} from 'satellite.js';
import {shadowFraction} from 'satellite.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ms} from './quality.mjs';
// How long one element set may be propagated. Measured against the NASA OEM precise ephemeris
// (EME2000) on 19.09.2026: the discrepancy stays flat at 28-30 km mean out to 120 h from epoch —
// that is the constant EME2000/TEME frame offset, not propagation drift — and only past 120 h does
// it grow (270 km mean). The limit therefore bounds staleness, not accuracy, and the reference
// warns that elements age faster during a storm, so the window age is reported in the confidence.
export const DEFAULT_PROPAGATION_HOURS=24;
export function orbitProfile(records,start,end,stepSeconds=30,maxPropagationHours=DEFAULT_PROPAGATION_HOURS) {
  const candidates=records.filter(r=>r.quantity==='omm').sort((a,b)=>ms(b.measuredAt)-ms(a.measuredAt));
  const limit=maxPropagationHours*3600000;
  const satrecs=new Map(),samples=[];let selected=null;
  for(let t=start;t<=end;t+=stepSeconds*1000){
    const record=candidates.find(r=>ms(r.measuredAt)<=t&&t-ms(r.measuredAt)<=limit);
    const point={t,lat:null,lon:null,alt:null,sunlit:null,orbitSourceId:null,epoch:null};
    if(record){try{
      if(!satrecs.has(record))satrecs.set(record,json2satrec(record.payload));
      const date=new Date(t),pv=propagate(satrecs.get(record),date);
      if(pv?.position){const geo=eciToGeodetic(pv.position,gstime(date));if([geo.latitude,geo.longitude,geo.height].every(Number.isFinite)){
        Object.assign(point,{lat:degreesLat(geo.latitude),lon:degreesLong(geo.longitude),alt:geo.height,sunlit:shadowFraction(sunPos(jday(date)).rsun,pv.position)<0.5,orbitSourceId:record.sourceId,epoch:ms(record.measuredAt)});selected??=record;
      }}
    }catch{/* A failed propagation remains a gap. */}}
    samples.push(point);
  }
  return {stepSeconds,propagator:'sgp4/satellite.js',objectId:25544,orbitSourceId:selected?.sourceId??null,epoch:selected?ms(selected.measuredAt):null,samples};
}
export async function magneticProfile(profile,python=process.env.PIPELINE_PYTHON){
  if(!python)return {samples:[],error:'PIPELINE_PYTHON не задан: IGRF / AP-8 недоступны'};
  const input=profile.samples.filter(p=>p.lat!==null);
  if(!input.length)return {samples:[],error:'Нет орбиты для IGRF / AP-8'};
  return new Promise(resolve=>{
    let child;
    try{child=spawn(python,[fileURLToPath(new URL('./irbem.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:90000});}
    catch(e){resolve({samples:[],error:e.message});return;}
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err=(err+b).slice(-3000));
    child.on('error',e=>resolve({samples:[],error:e.message}));child.stdin.on('error',()=>{});
    child.on('close',code=>{try{if(code!==0)throw new Error(err.trim().split(/\r?\n/).at(-1)||`IRBEM exit ${code}`);resolve(JSON.parse(out));}catch(e){resolve({samples:[],error:e.message});}});
    child.stdin.end(JSON.stringify(input));
  });
}
// No extrapolation beyond measured GOES energies, and never mix satellites.
export function accessibleFlux(channels,energy){
  const sorted=channels.filter(c=>Number.isFinite(c.value)).sort((a,b)=>a.energy-b.energy);
  const exact=sorted.find(c=>c.energy===energy);if(exact)return exact.value;
  for(let i=1;i<sorted.length;i++){const a=sorted[i-1],b=sorted[i];if(a.energy<energy&&energy<b.energy&&a.value>=b.value){
    if(a.value<=0||b.value<=0)return null;
    return Math.exp(Math.log(a.value)+(Math.log(b.value)-Math.log(a.value))*Math.log(energy/a.energy)/Math.log(b.energy/a.energy));
  }}return null;
}
// Above the highest valid channel the integral flux cannot exceed that channel's value
// (J(>=E) never grows with E): an upper bound, not an extrapolated spectrum.
export function accessibleFluxBound(channels,energy){
  const top=channels.filter(c=>Number.isFinite(c.value)).sort((a,b)=>a.energy-b.energy).at(-1);
  if(!top)return null;
  if(energy>top.energy)return {value:top.value,bound:true};
  const value=accessibleFlux(channels,energy);
  return value===null?null:{value,bound:false};
}
export const PROTON_REST_MEV=938.272;
// Vertical Störmer cutoff, centred dipole: Rc = C·cos⁴λm/(r/R_E)² GV. At Kp >= 5 (Hp30 is its
// half-hour analogue) the CARI-7A weakening Rc,storm = 0.5·Rc·(1 + 0.54·e^(−Rc/2.9)) applies.
// Reference: «Внешние опасности и как их измеряют», §2.4 and appendix Б.
export function cutoffRigidity(magLatDeg,altKm,index,c){
  if(![magLatDeg,altKm,index].every(Number.isFinite))return null;
  const r=(c.earthRadiusKm+altKm)/c.earthRadiusKm,quiet=c.coefficientGV*Math.cos(magLatDeg*Math.PI/180)**4/(r*r);
  if(index<c.storm.indexThreshold)return {rc:quiet,storm:false};
  return {rc:c.storm.scale*quiet*(1+c.storm.amplitude*Math.exp(-quiet/c.storm.rhoGV)),storm:true};
}
// Proton kinetic energy (MeV) for a rigidity in GV: pc = 1000·R MeV.
export const cutoffEnergy=rcGV=>Math.hypot(1000*rcGV,PROTON_REST_MEV)-PROTON_REST_MEV;
