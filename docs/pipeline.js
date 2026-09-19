// Browser-compatible v2 contract and window assessment. No network or model code.
const mechanisms=['sep','trapped','gcr','meteor','ops'];
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const timestamp=x=>typeof x==='string'&&x.endsWith('Z')&&finite(Date.parse(x));
const provenance=['observation','external_forecast','own_computation','model','synthetic'];
export function validateV2(data,disabled=[]) {
  const fail=()=>{throw new Error('Ответ сервера не соответствует контракту v2.');};
  if(data.demo!==false||!Array.isArray(data.sources)||!Array.isArray(data.series)||!Array.isArray(data.factors)||!Array.isArray(data.events)||!Array.isArray(data.gaps)||!Array.isArray(data.profile?.samples)||data.profile.stepSeconds!==30||!data.rules||!Array.isArray(data.limitations))fail();
  for(const id of ['sep','trapped','meteor'])if(!finite(data.rules[id]?.threshold?.value)||data.rules[id].threshold.value<0||data.rules[id].threshold.op!=='>=')fail();
  if(data.rules.decisionMechanisms!==undefined&&(!Array.isArray(data.rules.decisionMechanisms)||!data.rules.decisionMechanisms.every(id=>mechanisms.includes(id))))fail();
  const ids=data.sources.map(s=>s.id);
  if(new Set(ids).size!==ids.length||!mechanisms.every(id=>data.factors.some(f=>f.id===id)))fail();
  for(const s of data.sources){if(typeof s.id!=='string'||!['fresh','stale','unavailable'].includes(s.status)||typeof s.enabled!=='boolean'||!Array.isArray(s.factors)||!provenance.includes(s.provenance)||!['name','version','detail'].every(k=>typeof s[k]==='string')||!finite(s.cadenceMinutes)||s.cadenceMinutes<=0||(s.publishedAt!==null&&!timestamp(s.publishedAt))||(s.lastSuccess!==null&&!timestamp(s.lastSuccess))||(s.url&&!/^https:\/\//i.test(s.url)))fail();}
  if(new Set(data.series.map(s=>s.id)).size!==data.series.length)fail();
  for(const s of data.series){if(!ids.includes(s.sourceId)||!provenance.includes(s.provenance)||!s.instrument||!finite(s.cadenceMinutes)||s.cadenceMinutes<=0||!Array.isArray(s.samples))fail();let prev=-Infinity;for(const p of s.samples){if(!finite(p.t)||p.t<=prev||!['ok','fill','quality','spike','channel_order'].includes(p.q)||(p.v!==null&&!finite(p.v))||(p.q==='ok'&&p.v===null)||(p.publishedAt!==null&&(!timestamp(p.publishedAt)||p.t>Date.parse(p.publishedAt))))fail();prev=p.t;}}
  if(new Set(data.events.map(e=>e.id)).size!==data.events.length)fail();
  for(const e of data.events){if(!/^[\w-]+$/.test(e.id)||!ids.includes(e.sourceId)||!mechanisms.includes(e.factor)||!provenance.includes(e.provenance)||!finite(e.start)||!finite(e.end)||e.end<=e.start||!finite(e.value)||!timestamp(e.measuredAt)||(e.publishedAt!==null&&(!timestamp(e.publishedAt)||Date.parse(e.measuredAt)>Date.parse(e.publishedAt))))fail();}
  let prev=-Infinity;for(const p of data.profile.samples){if(!finite(p.t)||p.t<=prev||(prev!==-Infinity&&p.t-prev!==30000))fail();prev=p.t;for(const key of ['lat','lon','alt','sep','trapped','gcr','meteor'])if(p[key]!==null&&!finite(p[key]))fail();if(p.lat!==null&&Math.abs(p.lat)>90||p.lon!==null&&Math.abs(p.lon)>180||p.sunlit!==null&&typeof p.sunlit!=='boolean')fail();}
  for(const g of data.gaps)if(!ids.includes(g.sourceId)||!finite(g.start)||!finite(g.end)||g.end<=g.start)fail();
  return {...data,sources:data.sources.map(s=>({...s,enabled:s.enabled&&!disabled.includes(s.id)}))};
}
export function compareVector(a,b){for(let i=0;i<a.length;i++){if(a[i]<b[i])return -1;if(a[i]>b[i])return 1;}return 0;}
export function assessV2(request,data){
  const start=Date.parse(request.start),duration=request.duration*3600000,step=data.profile.stepSeconds;
  const replay=request.mode==='history'&&request.historyMode==='replay',cutoff=replay?Date.parse(request.cutoff):Infinity;
  // Mechanisms with thresholds decide. Context mechanisms (GCR, conjunction screening) can never
  // be fully observed: they are shown and lower confidence but do not block the choice.
  const decision=data.rules.decisionMechanisms??mechanisms;
  const sources=data.sources.map(s=>({...s,eligible:s.enabled&&s.status==='fresh'}));
  const events=data.events.filter(e=>sources.some(s=>s.id===e.sourceId&&s.enabled)&&(cutoff===Infinity||(e.publishedAt!==null&&Date.parse(e.publishedAt)<=cutoff)));
  function assess(t,i){
    const end=t+duration,points=data.profile.samples.filter(p=>p.t>=t&&p.t<end),expected=duration/(step*1000);
    const factors={},warnings=events.filter(e=>e.start<end&&e.end>t).map(e=>({...e,overlapMinutes:Math.max(0,Math.min(end,e.end)-Math.max(t,e.start))/60000}));
    for(const id of mechanisms){
      const valid=points.filter(p=>finite(p[id])),coverage=valid.length/expected;
      const total=valid.reduce((n,p)=>n+p[id]*step,0),peak=valid.length?Math.max(...valid.map(p=>p[id])):null;
      const value=coverage!==1?null:id==='ops'?warnings.filter(e=>e.factor==='ops').length:id==='gcr'?100*total/(duration/1000):total,threshold=data.rules[id]?.threshold?.value;
      const flagged=id==='ops'?warnings.some(e=>e.factor==='ops'):id==='meteor'?value!==null&&value>=threshold:peak!==null&&peak>=threshold;
      // Context mechanisms are never green: an empty top-N screen or a GCR proxy proves nothing.
      const status=decision.includes(id)?(coverage<1?'insufficient':flagged?'review':'acceptable'):(flagged?'review':'context');
      factors[id]={coverage,value,peak,unit:{sep:'pfu s',trapped:'cm^-2',gcr:'% потока ГКЛ',meteor:'hits',ops:'сближений'}[id],status};
      if(flagged&&id!=='ops')warnings.push({id:`${id}-${i}`,title:data.factors.find(f=>f.id===id).name,type:id.toUpperCase(),factor:id,sourceId:id==='sep'?'noaa.swpc':id==='trapped'?'model.irbem':'nasa.meo',start:t,end,overlapMinutes:duration/60000,value:id==='meteor'?value:peak,unit:data.rules[id].threshold.unit,publishedAt:null,origin:'Расчёт команды',provenance:'own_computation',rule:JSON.stringify(data.rules[id]),version:data.rules.version,limitation:data.rules[id].limitation});
    }
    const missing=decision.filter(id=>factors[id].coverage<1);
    const orbitCoverage=points.filter(p=>p.lat!==null).length/expected;
    if(orbitCoverage<1)missing.push('orbit');
    const lightMinutes=points.length===expected&&points.every(p=>typeof p.sunlit==='boolean')?points.filter(p=>p.sunlit).length*step/60:null;
    const saaMinutes=points.length===expected&&points.every(p=>typeof p.saa==='boolean')?points.filter(p=>p.saa).length*step/60:null;
    const reasons=missing.map(id=>({code:'coverage',detail:`${data.factors.find(f=>f.id===id)?.name??'Орбита'}: ${Math.round((factors[id]?.coverage??orbitCoverage)*100)}% покрытия`}));
    for(const id of mechanisms.filter(id=>!decision.includes(id)&&factors[id].coverage<1))reasons.push({code:'context',detail:`${data.factors.find(f=>f.id===id)?.name}: контекст, ${Math.round(factors[id].coverage*100)}% покрытия — выбор окна не блокирует`});
    const persisted=points.filter(p=>p.sepBasis==='persistence'),observed=persisted.map(p=>p.sepObservedAt).filter(finite),bounded=points.filter(p=>p.sepBound).length;
    if(persisted.length)reasons.push({code:'persistence',detail:`Солнечные протоны: ${Math.round(persisted.length*step/60)} мин окна после последнего замера GOES${observed.length?` (${new Date(Math.min(...observed)).toISOString().slice(11,16)} UTC)`:''} — последнее наблюдение сохраняется; начало события такой прогноз не предсказывает`});
    if(bounded)reasons.push({code:'bound',detail:`Солнечные протоны: ${Math.round(bounded*step/60)} мин окна — верхняя оценка (обрезание выше последнего канала GOES или неизвестен геомагнитный индекс)`});
    for(const s of sources.filter(s=>s.applicable!==false&&(!s.enabled||s.status!=='fresh')))reasons.push({code:!s.enabled?'disabled':s.status,detail:`${s.name}: ${s.detail}`});
    if(replay)for(const s of sources.filter(s=>s.applicable!==false&&!s.replayEligible&&!s.id.startsWith('model.')))reasons.push({code:'no_publish',detail:`${s.name}: нет подтверждённого времени публикации`});
    reasons.push({code:'model',detail:'Исследовательские модели и пороги; не вероятность безопасности'});
    // Windows without any flag come first; SEP fluence is compared at a few significant digits so that
    // persistence noise of 0.1 % does not outrank minutes in the SAA.
    const digits=data.rules.ranking?.sepSignificantDigits,sep=factors.sep.value===null?Infinity:digits?Number(factors.sep.value.toPrecision(digits)):factors.sep.value;
    const rank=[missing.length,missing.length||warnings.length?1:0,decision.filter(id=>factors[id].status==='review').length,sep,saaMinutes??Infinity,warnings.filter(e=>e.factor==='ops').length];
    if(request.lightConstraint)rank.push(lightMinutes===null?Infinity:duration/60000-lightMinutes);
    return {id:i===0?'A':`C${i}`,start:t,end,factors,missing,gaps:data.gaps.filter(g=>g.start<end&&g.end>t),warnings,lightMinutes,saaMinutes,rank,confidence:{level:missing.length||persisted.length?'low':'medium',reasons},status:missing.length?'insufficient':warnings.length?'review':'acceptable',incomplete:missing.length>0,weather:missing.some(id=>['sep','trapped','gcr'].includes(id))?'Нет данных':warnings.some(e=>['sep','trapped','gcr'].includes(e.factor))?'Требует проверки':'Низкий прокси',conjunction:factors.ops.coverage<1?'Нет полного экрана':warnings.some(e=>e.factor==='ops')?'Есть пересечение':'Нет пересечений'};
  }
  const candidates=Array.from({length:request.shift+1},(_,i)=>assess(start+i*3600000,i));
  const ranked=[...candidates].sort((a,b)=>compareVector(a.rank,b.rank)||a.start-b.start),recommended=ranked[0];
  ranked.forEach((w,i)=>{w.position=i+1;});
  // Best windows: every good one (up to three shown first); without a good window, the two best anyway.
  const good=ranked.filter(w=>w.status==='acceptable'),best=good.length?good.slice(0,3):ranked.slice(0,2);
  const alternative=recommended.start!==start?recommended:ranked.find(w=>w.start!==start)??null;if(alternative)alternative.id='B';
  const improvement=!recommended.incomplete&&recommended.start!==start&&compareVector(recommended.rank,candidates[0].rank)<0;
  const tied=candidates.length>1&&candidates.every(w=>compareVector(w.rank,recommended.rank)===0);
  const outcome=recommended.incomplete||tied?'insufficient':improvement?'recommendation':'no_improvement';
  return {request:structuredClone(request),generatedAt:data.generatedAt,algorithmVersion:'eva-pipeline/2.1.0',demo:false,cutoff:replay?request.cutoff:null,sources,events:[...new Map([...events,...candidates.flatMap(w=>w.warnings)].map(e=>[e.id,e])).values()],orbit:data.orbit,profile:data.profile,rules:data.rules,original:candidates[0],alternative,recommended,candidates,best:best.map(w=>w.id),goodCount:good.length,improvement,outcome,strictReproducibility:false,limitations:data.limitations};
}
