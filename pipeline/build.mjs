import {readFile} from 'node:fs/promises';
import {SOURCES,goes,hp30,omm,nmdb,socrates,donki,geoalert,nmdbURL} from './adapters.mjs';
import {normalizeSeries,selectVersions,valueAt,coverageOf,validateMeteorTable,ms,iso} from './quality.mjs';
import {orbitProfile,magneticProfile,accessibleFlux} from './orbit.mjs';
import {validateRequest,HOUR} from '../dist/domain.js';
export const FACTORS=[{id:'sep',name:'Солнечные протоны'},{id:'trapped',name:'Захваченные частицы'},{id:'gcr',name:'Галактический фон'},{id:'meteor',name:'Метеорная обстановка'},{id:'ops',name:'Эксплуатационный контекст'}];
const rules=JSON.parse(await readFile(new URL('../data/rules.json',import.meta.url),'utf8'));
const meteorTable=validateMeteorTable(JSON.parse(await readFile(new URL('../data/meteor-showers.json',import.meta.url),'utf8')));
export async function collect(cache,request,disabled=[]){
  const start=ms(request.start),end=start+(request.duration+request.shift)*HOUR;
  const jobs=[];const add=(id,url,adapter,ttl)=>{if(!disabled.includes(id))jobs.push({id,url,adapter,ttl});};
  if(request.mode==='current'){
    for(const [id,adapter,ttl] of [['noaa.swpc',goes,5],['celestrak.gp',omm,120],['celestrak.socrates',socrates,480]])add(id,SOURCES.find(s=>s.id===id).url,adapter,ttl);
  }
  add('gfz.hp30',`https://kp.gfz.de/app/json/?start=${iso(start-2*HOUR).slice(0,19)}Z&end=${iso(end).slice(0,19)}Z&index=Hp30`,hp30,30);
  add('nmdb',nmdbURL(start-2*HOUR,end),nmdb,60);
  add('nasa.donki',`https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/notifications?startDate=${iso(start-86400000).slice(0,10)}&endDate=${iso(end).slice(0,10)}&type=all`,donki,60);
  if(request.mode==='history')for(let day=Math.floor(start/86400000)*86400000;day<end;day+=86400000){const d=iso(day).slice(0,10);add('noaa.ncei',`${SOURCES.find(s=>s.id==='noaa.ncei').url}${d.slice(0,4)}/${d.slice(5,7)}/${d.replaceAll('-','')}GEOA.txt`,geoalert,1440);}
  const outcomes=await Promise.all(jobs.map(async j=>{try{const snapshot=await cache.fetch(j.id,j.url,j.ttl);const records=j.adapter(snapshot);await cache.append(records);return {id:j.id,ok:true,fetchedAt:snapshot.fetchedAt,version:snapshot.sourceVersion};}catch(e){return {id:j.id,ok:false,error:e.message};}}));
  return outcomes;
}
export async function buildDataset(request,records,{disabled=[],outcomes=[],python,modelRunner=magneticProfile,generatedAt=iso(Date.now())}={}) {
  validateRequest(request);
  const start=ms(request.start),end=start+(request.duration+request.shift)*HOUR,replay=request.mode==='history'&&request.historyMode==='replay';
  const cutoff=replay?ms(request.cutoff):request.mode==='current'?ms(generatedAt):Infinity;
  // Current data with unknown publication is allowed; future measurements are not.
  const input=records.filter(r=>!disabled.includes(r.sourceId)&&
    // Keep a two-day lookback for orbital epochs, interpolation and context;
    // unrelated cached years must not appear as fresh sources for this horizon.
    (ms(r.measuredAt)>=start-2*86400000&&ms(r.measuredAt)<=end+HOUR)&&
    (request.mode!=='current'||(ms(r.measuredAt)<=ms(generatedAt)&&(r.publishedAt===null||ms(r.publishedAt)<=ms(generatedAt)))));
  const visible=selectVersions(input,replay?cutoff:Infinity);
  const series=normalizeSeries(visible),profile=orbitProfile(visible,start,end);
  const magnetic=disabled.includes('model.irbem')?{samples:[],error:'Модель отключена'}:await modelRunner(profile,python);
  const magneticByTime=new Map(magnetic.samples.map(p=>[p.t,p]));
  const hp=series.find(s=>s.quantity==='hp30'),protons=series.filter(s=>s.quantity==='proton_integral_flux');
  for(const p of profile.samples){
    const m=magneticByTime.get(p.t);Object.assign(p,{hp30:hp?valueAt(hp,p.t):null,L:null,B:null,magLat:null,rc:null,ec:null,saa:null,sep:null,trapped:null,gcr:null,meteor:null});
    if(m&&p.lat!==null){p.L=m.L;p.B=m.B;p.magLat=m.magLat??null;p.ap8Min=m.ap8Min;p.ap8Max=m.ap8Max;p.saa=Number.isFinite(m.B)&&Number.isFinite(m.L)?m.B<rules.saa.maxBNt&&m.L<rules.saa.maxL:null;
      if(Number.isFinite(m.ap8Max)&&Number.isFinite(m.ap8Min)&&m.ap8Max>=0&&m.ap8Min>=0)p.trapped=Math.max(m.ap8Min,m.ap8Max);
      if(Number.isFinite(m.L)&&m.L>0&&p.hp30!==null&&p.hp30<5){p.rc=Math.min(20,rules.cutoff.coefficientGV/(m.L*m.L));p.ec=Math.hypot(1000*p.rc,938.272)-938.272;
        const instruments=[...new Set(protons.map(s=>s.instrument))];const values=instruments.map(instrument=>accessibleFlux(protons.filter(s=>s.instrument===instrument).map(s=>({energy:s.energy,value:valueAt(s,p.t)})),Math.max(p.ec,rules.suitEnergyMeV))).filter(v=>v!==null);
        // Conflicting simultaneous instruments do not become an averaged measurement.
        if(values.length===1)p.sep=values[0];
      }
    }
    // NMDB is exposed as independent ground context, not mislabeled as local GCR flux.
    p.neutronRates=Object.fromEntries(series.filter(s=>s.quantity==='neutron_rate').map(s=>[s.instrument,valueAt(s,p.t)]));
    const meteor=meteorTable.records.filter(r=>!disabled.includes('nasa.meo')&&ms(r.start)<=p.t&&p.t<ms(r.end)&&(!replay||(r.publishedAt&&ms(r.publishedAt)<=cutoff)));
    if(meteor.length===1&&Number.isFinite(meteor[0].fluxM2Second)&&meteor[0].fluxM2Second>=0)p.meteor=meteor[0].fluxM2Second*rules.suitAreaM2;
  }
  const sources=SOURCES.map(s=>{
    const rows=visible.filter(r=>r.sourceId===s.id),result=outcomes.filter(o=>o.id===s.id),last=rows.reduce((a,r)=>!a||ms(r.fetchedAt)>ms(a)?r.fetchedAt:a,null);
    const publication=rows.map(r=>r.publishedAt).filter(Boolean).sort().at(-1)??null;
    let status=rows.length?'fresh':'unavailable',detail=s.detail;
    const ageLimit={'noaa.swpc':15,'gfz.hp30':60,'nmdb':120,'celestrak.gp':1440,'celestrak.socrates':480}[s.id];
    const latestMeasured=rows.reduce((n,r)=>Math.max(n,ms(r.measuredAt)),-Infinity);
    const ageMinutes=Number.isFinite(latestMeasured)?Math.max(0,(ms(generatedAt)-latestMeasured)/60000):null;
    if(request.mode==='current'&&ageLimit&&ageMinutes!==null&&ageMinutes>ageLimit)status='stale';
    if(result.some(o=>!o.ok)){status=rows.length?'stale':'unavailable';detail+='; '+result.filter(o=>!o.ok).map(o=>o.error).join('; ');}
    if(s.id==='model.irbem'){status=magnetic.samples.length?'fresh':'unavailable';detail=magnetic.error??magnetic.model;}
    if(s.id==='nasa.meo')status=profile.samples.some(p=>p.meteor!==null)?'fresh':'unavailable';
    return {...s,status,ageMinutes,enabled:!disabled.includes(s.id),publishedAt:publication,lastSuccess:last??result.find(o=>o.ok)?.fetchedAt??null,version:rows.at(-1)?.sourceVersion??(s.id==='model.irbem'?magnetic.version:null)??'unavailable',provenance:s.id.startsWith('model.')||s.factors.includes('orbit')?'model':s.id==='celestrak.socrates'||s.id==='nasa.meo'?'external_forecast':'observation',replayEligible:rows.some(r=>r.publishedAt!==null),detail};
  });
  const coverage=Object.fromEntries(series.map(s=>[s.id,coverageOf(s,start,end)]));
  const gaps=Object.entries(coverage).flatMap(([id,c])=>c.gaps.map(g=>({...g,seriesId:id,sourceId:series.find(s=>s.id===id).sourceId,publishedAt:null,reason:'Нет валидного отсчёта в пределах допустимого возраста'})));
  for(const [factor,sourceId,key] of [['sep','noaa.swpc','sep'],['trapped','model.irbem','trapped'],['gcr','nmdb','gcr'],['meteor','nasa.meo','meteor'],['ops','celestrak.socrates','ops'],['orbit','celestrak.gp','lat']]){
    let open=null;
    for(const point of profile.samples.filter(p=>p.t<end)){
      if(!Number.isFinite(point[key])){if(open===null)open=point.t;}
      else if(open!==null){gaps.push({factor,sourceId,start:open,end:point.t,publishedAt:null,reason:'Нет полной оценки механизма / траектории'});open=null;}
    }
    if(open!==null)gaps.push({factor,sourceId,start:open,end,publishedAt:null,reason:'Нет полной оценки механизма / траектории'});
  }
  // SOCRATES is a top-N sample: even a successful empty response cannot prove full coverage.
  const events=visible.filter(r=>r.quantity==='conjunction'&&r.objectId===25544&&Number.isFinite(r.start)&&Number.isFinite(r.end)&&Number.isFinite(r.value)&&r.start<end&&r.end>start).map((r,i)=>({id:`ops-${i}`,title:'Сближение со станцией',type:'TCA',factor:'ops',sourceId:r.sourceId,objectId:25544,start:r.start,end:r.end,tca:r.tca,measuredAt:r.measuredAt,publishedAt:r.publishedAt,value:r.value,unit:r.unit,provenance:r.provenance,origin:'Внешний прогноз',version:r.sourceVersion,rule:'OPS-01: TCA ± 30 минут; возможен манёвр станции',limitation:'SOCRATES top-N не является полным экраном сближений'}));
  return {schemaVersion:2,demo:false,generatedAt,sources,series,profile,factors:FACTORS,events,gaps,coverage,rules,orbit:{epoch:profile.epoch,model:profile.propagator,format:'OMM',objectId:25544},context:visible.filter(r=>['notification','bulletin'].includes(r.quantity)),limitations:[
    'Исследовательские прокси, не расчёт дозы и не допуск к ВКД.',rules.cutoff.limitation,
    'GOES не экстраполируется за последний измеренный энергетический канал. Наблюдения не являются прогнозом будущего окна.',
    'AP-8 — климатологическая модель; граница ЮАА исследовательская.',
    'NMDB показан как наземный контекст; модель ГКЛ вдоль орбиты не калибрована.',
    'SOCRATES top-N не доказывает отсутствие сближений. Метеорные потоки требуют проверенной таблицы NASA MEO.',
    ...(magnetic.error?[magnetic.error]:[])
  ]};
}
