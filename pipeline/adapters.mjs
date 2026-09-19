import {iso,ms} from './quality.mjs';
export const SOURCES=[
  {id:'noaa.swpc',name:'GOES SGPS',url:'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json',cadenceMinutes:1,factors:['sep'],detail:'Интегральные протоны; публикация неизвестна'},
  {id:'gfz.hp30',name:'GFZ Hp30',url:'https://kp.gfz.de/app/json/',cadenceMinutes:30,factors:['sep'],detail:'Hp30; смешанные ревизии, без времени публикации'},
  {id:'celestrak.gp',name:'CelesTrak GP',url:'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json',cadenceMinutes:120,factors:['orbit'],detail:'NORAD 25544; EPOCH не является публикацией'},
  {id:'spacetrack.history',name:'Space-Track GP history',url:'https://www.space-track.org/',cadenceMinutes:480,factors:['orbit'],detail:'Однократный локальный импорт OMM с CREATION_DATE'},
  {id:'nmdb',name:'NMDB OULU / ROME',url:'https://www.nmdb.eu/nest/draw_graph.php',cadenceMinutes:60,factors:['gcr'],detail:'Нейтронные мониторы; фон на Земле, не поток у МКС'},
  {id:'celestrak.socrates',name:'SOCRATES',url:'https://celestrak.org/SOCRATES/sort-minRange.csv',cadenceMinutes:480,factors:['ops'],detail:'Top-N сближения станции, неполный экран'},
  {id:'nasa.donki',name:'NASA DONKI',url:'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/notifications',cadenceMinutes:60,factors:[],detail:'Датированные уведомления для сверки'},
  {id:'noaa.ncei',name:'NCEI GEOALERT',url:'https://www.ngdc.noaa.gov/stp/space-weather/swpc-products/daily_reports/geoalerts/',cadenceMinutes:1440,factors:[],detail:'Оригинальные архивные выпуски; дата выпуска из текста'},
  {id:'model.irbem',name:'IGRF / IRBEM / AP-8',url:'https://spacepy.github.io/autosummary/spacepy.irbempy.html',cadenceMinutes:0.5,factors:['sep','trapped'],detail:'Локальная модель; требуется Python со SpacePy'},
  {id:'nasa.meo',name:'NASA MEO',url:'https://ntrs.nasa.gov/',cadenceMinutes:1440,factors:['meteor'],detail:'Версионированная таблица потока; требуется проверенный импорт'}
];
const dateUTC=s=>iso(/(?:Z|[+-]\d\d:\d\d)$/.test(s)?s:s.replace(' ','T')+'Z');
function record(snapshot,fields){return {sourceId:snapshot.sourceId,sourceVersion:snapshot.sourceVersion,adapterVersion:2,fetchedAt:snapshot.fetchedAt,publishedAt:null,provenance:'observation',...fields};}
export function goes(snapshot){return JSON.parse(snapshot.raw).map(r=>{
  const energy=Number(r.energy?.match(/[\d.]+/)?.[0]);if(!energy||!r.satellite)throw new Error('GOES energy or satellite missing');
  return record(snapshot,{seriesId:`goes.sgps.p${energy}`,instrument:`g${r.satellite}/SGPS`,satellite:String(r.satellite),measuredAt:dateUTC(r.time_tag),quantity:'proton_integral_flux',energy,unit:'pfu',value:r.flux,q:r.quality_flag!=null&&Number(r.quality_flag)!==0?'quality':'ok',cadenceMinutes:1,maxAgeMinutes:15,interpolation:'linear',payload:r});
});}
export function hp30(snapshot){const data=JSON.parse(snapshot.raw);if(!Array.isArray(data.datetime)||data.datetime.length!==data.Hp30?.length)throw new Error('GFZ arrays mismatch');return data.datetime.map((t,i)=>record(snapshot,{seriesId:'gfz.hp30',instrument:'GFZ/Hp30',measuredAt:iso(ms(dateUTC(t))+30*60000),quantity:'hp30',unit:'index',value:data.Hp30[i],cadenceMinutes:30,maxAgeMinutes:60,payload:{intervalStart:t,meta:data.meta}}));}
export function omm(snapshot){const rows=JSON.parse(snapshot.raw);if(!Array.isArray(rows))throw new Error('Expected OMM array');return rows.filter(r=>Number(r.NORAD_CAT_ID)===25544).map(r=>record(snapshot,{seriesId:'iss.omm',instrument:'NORAD/25544',recordId:r.EPOCH,measuredAt:dateUTC(r.EPOCH),publishedAt:r.CREATION_DATE?dateUTC(r.CREATION_DATE):null,provenance:'model',quantity:'omm',objectId:25544,payload:r}));}
export function nmdb(snapshot){
  const records=[];let stations=null;
  for(const line of snapshot.raw.split(/\r?\n/)){
    const header=line.trim().split(/\s+/);
    if(header.length===2&&header.every(s=>['OULU','ROME'].includes(s))&&new Set(header).size===2){stations=header;continue;}
    if(!/^\d{4}-\d\d-\d\d/.test(line))continue;
    const [t,...values]=line.trim().split(/\s*;\s*/);
    if(!stations||values.length!==stations.length)throw new Error('NMDB station header missing or columns mismatch');
    for(const [i,station] of stations.entries())records.push(record(snapshot,{seriesId:`nmdb.${station}`,instrument:station,measuredAt:iso(ms(dateUTC(t))+3600000),quantity:'neutron_rate',unit:'counts/s',value:values[i].trim()!==''&&values[i]!=='null'?Number(values[i]):null,cadenceMinutes:60,maxAgeMinutes:120,payload:{intervalStart:t,raw:line}}));
  }if(!records.length)throw new Error('NMDB returned no ASCII measurements');return records;
}
export function parseCSV(text){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if(c==='\n'&&!quoted){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';}else value+=c;}if(value||row.length){row.push(value.replace(/\r$/,''));rows.push(row);}const headers=rows.shift()?.map(x=>x.trim())??[];return rows.filter(r=>r.length===headers.length).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));}
export function socrates(snapshot){const rows=parseCSV(snapshot.raw);if(!rows.length||!('NORAD_CAT_ID_1' in rows[0]))throw new Error('Unknown SOCRATES CSV schema');return rows.filter(r=>[r.NORAD_CAT_ID_1,r.NORAD_CAT_ID_2].some(x=>Number(x)===25544)).map(r=>record(snapshot,{seriesId:'socrates.iss',instrument:'NORAD/25544',recordId:`${r.NORAD_CAT_ID_1}-${r.NORAD_CAT_ID_2}-${r.TCA}`,measuredAt:snapshot.fetchedAt,quantity:'conjunction',objectId:25544,start:ms(dateUTC(r.TCA))-30*60000,end:ms(dateUTC(r.TCA))+30*60000,tca:ms(dateUTC(r.TCA)),value:Number(r.TCA_RANGE),unit:'km',provenance:'external_forecast',payload:r}));}
export function donki(snapshot){return JSON.parse(snapshot.raw).map(r=>record(snapshot,{seriesId:'donki.notifications',instrument:'CCMC',recordId:r.messageID,measuredAt:dateUTC(r.messageIssueTime),publishedAt:dateUTC(r.messageIssueTime),quantity:'notification',provenance:'external_forecast',payload:r}));}
export function geoalert(snapshot){const match=snapshot.raw.match(/:Issued:\s*(\d{4})\s+(\w{3})\s+(\d{1,2})\s+(\d{2})(\d{2})\s+UTC/i);if(!match)throw new Error('NCEI issue time missing; filename is not publication time');const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];const publishedAt=iso(Date.UTC(+match[1],months.findIndex(m=>m.toLowerCase()===match[2].toLowerCase()),+match[3],+match[4],+match[5]));return [record(snapshot,{seriesId:'ncei.geoalert',instrument:'SWPC',measuredAt:publishedAt,publishedAt,quantity:'bulletin',provenance:'external_forecast',payload:snapshot.raw})];}
export function nmdbURL(start,end){const u=new URL(SOURCES.find(s=>s.id==='nmdb').url);for(const [k,v] of Object.entries({formchk:1,output:'ascii',dtype:'corr_for_efficiency',tabchoice:'revori',tresolution:60,yunits:0,date_choice:'bydate'}))u.searchParams.set(k,v);for(const station of ['OULU','ROME'])u.searchParams.append('stations[]',station);for(const [prefix,t] of [['start',start],['end',end]]){const d=new Date(t);for(const [k,v] of Object.entries({year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:d.getUTCHours(),min:d.getUTCMinutes()}))u.searchParams.set(`${prefix}_${k}`,v);}return u.href;}
