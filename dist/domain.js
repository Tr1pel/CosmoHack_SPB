import {assessV2} from './pipeline.js';
export const ALGORITHM_VERSION = 'eva-demo/1.0.0';
export const HOUR = 3600000;
export const time = ms => new Date(ms).toISOString().slice(11,16);
export const date = ms => new Date(ms).toLocaleDateString('ru-RU',{timeZone:'UTC',day:'2-digit',month:'short',year:'numeric'});
export const range = w => `${time(w.start)}–${time(w.end)}`;
export const overlap = (a,b,c,d) => Math.max(0, Math.min(b,d)-Math.max(a,c));
export function validateRequest(r) {
  if(!['current','history'].includes(r.mode)||!['archive','replay'].includes(r.historyMode)) throw new Error('Некорректный режим анализа.');
  if (!Number.isFinite(Date.parse(r.start))) throw new Error('Укажите корректные дату и время начала.');
  if (!Number.isFinite(r.duration) || r.duration<1 || r.duration>8) throw new Error('Длительность должна быть от 1 до 8 часов.');
  if (!Number.isInteger(r.shift) || r.shift<0 || r.shift>24) throw new Error('Диапазон сдвига должен быть целым числом от 0 до 24 часов.');
  if (r.mode==='history' && r.historyMode==='replay' && (!Number.isFinite(Date.parse(r.cutoff)) || Date.parse(r.cutoff)>Date.parse(r.start))) throw new Error('Момент отсечения должен быть не позже начала ВКД.');
}
// Synthetic orbital samples. These are NOT a physical orbit propagator or TLE computation.
export function orbitPoint(ms, epoch) {
  const phase=(ms-epoch)/60000/92.7*Math.PI*2;
  return {time:ms,lat:51.6*Math.sin(phase),lon:((phase*180/Math.PI-(ms-epoch)/HOUR*15+540)%360+360)%360-180,sunlit:((phase%(Math.PI*2))+Math.PI*2)%(Math.PI*2)<Math.PI*1.24};
}
export function computePlan(request, dataset) {
  validateRequest(request);
  if(dataset.schemaVersion===2)return assessV2(request,dataset);
  const start=Date.parse(request.start), replay=request.mode==='history' && request.historyMode==='replay';
  const cutoff=replay?Date.parse(request.cutoff):Infinity;
  const sources=dataset.sources.map(s=>({...s,eligible:s.enabled && s.status==='fresh' && Date.parse(s.publishedAt)<=cutoff}));
  const available=id=>sources.some(s=>s.id===id&&s.eligible);
  const events=dataset.events.filter(e=>available(e.sourceId)&&Date.parse(e.publishedAt)<=cutoff);
  const duration=request.duration*HOUR;
  function assess(t,index) {
    const end=t+duration;
    const warnings=events.filter(e=>overlap(t,end,e.start,e.end)>0).map(e=>({...e,overlapMinutes:Math.round(overlap(t,end,e.start,e.end)/60000)}));
    const weather=warnings.filter(e=>e.factor==='weather');
    const conjunction=warnings.filter(e=>e.factor==='conjunction');
    const gaps=dataset.gaps.filter(g=>Date.parse(g.publishedAt)<=cutoff&&overlap(t,end,g.start,g.end)>0);
    const missing=sources.filter(s=>!s.eligible).map(s=>s.id);
    const minutes=Math.ceil(duration/60000);
    const lit=Array.from({length:minutes},(_,i)=>orbitPoint(t+i*60000,dataset.orbit.epoch)).filter(p=>p.sunlit).length;
    const lightMinutes=available('orbit')?lit:null;
    const penalty=weather.reduce((n,e)=>n+e.overlapMinutes*e.weight,0)+conjunction.reduce((n,e)=>n+e.weight*e.overlapMinutes,0)+(request.lightConstraint&&lightMinutes!==null?(minutes-lightMinutes)*1.2:0);
    const incomplete=missing.length>0||gaps.length>0;
    const confidence=Math.max(0,Math.round(100-missing.length*30-(gaps.length?20:0)-(replay?10:0)));
    return {id:index===0?'A':`C${index}`,start:t,end,weather:weather.length?'Умеренный риск':'Низкий риск',conjunction:conjunction.length?'Есть пересечение':'Нет пересечений',warnings,gaps,missing,lightMinutes,penalty,confidence,status:missing.length?'insufficient':warnings.length||gaps.length?'review':'acceptable',incomplete};
  }
  const candidates=Array.from({length:Math.floor(request.shift)+1},(_,i)=>assess(start+i*HOUR,i));
  // Prefer complete data before a lower proxy risk; never make absence of data look safe.
  const ranked=[...candidates].sort((a,b)=>a.missing.length-b.missing.length || a.gaps.length-b.gaps.length || a.penalty-b.penalty || a.start-b.start);
  const recommended=ranked[0];
  const alternative= recommended.start!==start?recommended:(ranked.find(w=>w.start!==start)||null);
  if(alternative) alternative.id='B';
  const improvement=recommended.start!==start && recommended.penalty<candidates[0].penalty && !recommended.missing.length;
  return {request:structuredClone(request),generatedAt:new Date().toISOString(),algorithmVersion:ALGORITHM_VERSION,demo:dataset.demo,cutoff:replay?request.cutoff:null,sources,events,orbit:dataset.orbit,original:candidates[0],alternative,recommended,candidates,improvement,strictReproducibility:false,limitations:['Синтетические данные: не использовать для допуска к реальной ВКД.','Поток частиц — прокси-показатель, не расчёт дозы экипажа.','События сближения не описывают весь фон MMOD.','Траектория и освещённость — демонстрационная модель, не распространение TLE.']};
}
