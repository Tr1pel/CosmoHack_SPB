import {time,date,range} from './domain.js';
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const confidenceText=c=>typeof c==='object'?({low:'Низкая',medium:'Средняя',high:'Высокая'}[c.level]??c.level):`${c}%`;
const STATUS={insufficient:'Недостаточно данных',review:'Требует проверки',acceptable:'Покрытие полное',context:'Контекст, выбор не блокирует'};
const VERDICT={acceptable:'Подходит',review:'Требует проверки',insufficient:'Недостаточно данных'};
const pick=(plan,id)=>plan.candidates.find(w=>w.id===id);
const precise=(x,digits=2)=>x===null||x===undefined?'—':Number(x).toPrecision(digits);
// What keeps a window from being good, in the words of the mechanisms.
function issues(w,names){
  const out=[],f=w.factors;
  if(w.missing.length)out.push(`нет данных: ${w.missing.map(id=>(names[id]??'орбита').toLowerCase()).join(', ')}`);
  if(f.sep.status==='review')out.push(`SEP до ${precise(f.sep.peak)} pfu`);
  if(f.trapped.status==='review')out.push(`ЮАА: AP-8 до ${Math.round(f.trapped.peak)} см⁻²с⁻¹`);
  if(f.meteor.status==='review')out.push(`метеоры ${precise(f.meteor.value)}`);
  const conflicts=w.warnings.filter(e=>e.factor==='ops').length;
  if(conflicts)out.push(`сближений: ${conflicts}`);
  return out.length?out:[`без срабатываний · ЮАА ${w.saaMinutes??'—'} мин`];
}
function chip(w,names,selected){return `<button class="window-chip ${w.status==='acceptable'?'good':''} ${w.id===selected.id?'selected':''}" data-window="${esc(w.id)}"><strong>${w.position}. ${range(w)} UTC</strong><small>${esc(VERDICT[w.status])} · ${esc(issues(w,names).join(' · '))}</small></button>`;}
export function pipelinePanel(plan,data,selected=plan.recommended){
  const w=plan.recommended,names=Object.fromEntries(data.factors.map(f=>[f.id,f.name]));
  const best=plan.best.map(id=>pick(plan,id)).filter(Boolean),other=selected.id===plan.original.id?plan.alternative:selected;
  const heading=plan.goodCount?`Хорошие окна: ${plan.goodCount} из ${plan.candidates.length}`:best.every(x=>x.incomplete)?'Оснований для выбора недостаточно':'Хороших окон нет';
  const lead=plan.goodCount?`Лучшее — ${range(w)} UTC${w.id===plan.original.id?', исходное окно':''}.`:best.every(x=>x.incomplete)?'Ни одно окно не оценено полностью; ниже — ближайшие к полноте.':'У каждого окна есть срабатывания; ниже — два лучших из доступных.';
  const column=x=>x?`<th><button class="text-button" data-window="${esc(x.id)}">Окно ${esc(x.id)}</button><small>${esc(date(x.start))} · ${range(x)} UTC</small></th>`:'<th>—<small>Нет альтернативы</small></th>';
  return `<section class="panel pipeline-summary"><div class="panel-heading"><h2>${heading}</h2><span class="subtle-tag">PIPELINE V2</span></div><p>${esc(lead)} Уверенность: <strong>${esc(confidenceText(w.confidence))}</strong>. Механизмы сравниваются отдельно, без суммарного балла.</p><div class="window-chips">${best.map(x=>chip(x,names,selected)).join('')}</div><div class="table-scroll"><table><thead><tr><th>Механизм</th>${column(plan.original)}${column(other)}</tr></thead><tbody>${data.factors.map(f=>`<tr><td>${esc(f.name)}</td>${[plan.original,other].map(window=>{const v=window?.factors[f.id];return `<td>${v?`${esc(STATUS[v.status])}<small>Покрытие ${(v.coverage*100).toFixed(1)}% · ${v.value===null?'Оценка неизвестна':`${v.value.toPrecision(4)} ${esc(v.unit)}`}</small>`:'—'}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div><details open><summary>Причины и ограничения</summary><ul>${w.confidence.reasons.map(r=>`<li>${esc(r.detail)}</li>`).join('')}</ul></details><details><summary>Правила · ${esc(plan.rules.version)}</summary><pre>${esc(JSON.stringify(plan.rules,null,2))}</pre></details><p>${plan.cutoff?`Replay: публикации до ${esc(plan.cutoff)}. Источники без времени выпуска исключены.`:plan.request.mode==='current'?'После последнего замера GOES действует базовый прогноз «последнее наблюдение сохраняется»: начало события он не предсказывает.':'Архивный разбор: только наблюдения периода, без прогноза.'}</p></section>`;
}
export function pipelineCandidates(plan,data,selected=plan.recommended){
  const best=new Set(plan.best),rows=[...plan.candidates].sort((a,b)=>a.start-b.start);
  const flagged=(f,text)=>f.status==='review'?`<strong>${text}</strong>`:text;
  return `<section class="panel pipeline-summary candidates-panel"><div class="panel-heading"><h2>Все окна</h2><span class="subtle-tag">${rows.length} · шаг 1 ч</span></div><p class="muted">Хорошее окно — полные данные SEP, захваченных частиц и метеоров и ни одного срабатывания. «Место» — порядок выбора, ★ — показанные выше лучшие окна.</p><div class="table-scroll"><table class="candidates-table"><thead><tr><th>Место</th><th>Окно, UTC</th><th>Итог</th><th>SEP пик, pfu</th><th>ЮАА, мин</th><th>AP-8 пик</th><th>Метеоры</th><th>Сближения</th><th>ГКЛ</th><th>Уверенность</th></tr></thead><tbody>${rows.map(w=>{const f=w.factors,forecast=w.confidence.reasons.some(r=>r.code==='persistence');return `<tr class="${w.status==='acceptable'?'good':''} ${w.id===selected.id?'selected':''}"><td>${best.has(w.id)?'★ ':''}${w.position}</td><td><button class="text-button" data-window="${esc(w.id)}">${range(w)}</button><small>${esc(date(w.start))}</small></td><td><span class="badge ${w.status}"><span class="dot"></span>${esc(VERDICT[w.status])}</span></td><td>${flagged(f.sep,precise(f.sep.peak))}${forecast?'<small>прогноз</small>':''}</td><td>${w.saaMinutes??'—'}</td><td>${flagged(f.trapped,f.trapped.peak===null?'—':Math.round(f.trapped.peak))}</td><td>${flagged(f.meteor,precise(f.meteor.value))}</td><td>${f.ops.coverage<1?'—':flagged(f.ops,f.ops.value)}</td><td>${f.gcr.value===null?'—':`${f.gcr.value.toFixed(1)}%`}</td><td>${esc(confidenceText(w.confidence))}</td></tr>`;}).join('')}</tbody></table></div></section>`;
}
// Runs of consecutive profile samples that satisfy a predicate, as [start, end) intervals.
function runs(samples,step,from,to,predicate){
  const out=[];let open=null;
  for(const p of samples){if(p.t<from||p.t>=to)continue;if(predicate(p)){if(open===null)open=p.t;}else if(open!==null){out.push([open,p.t]);open=null;}}
  if(open!==null)out.push([open,Math.min(to,samples.at(-1).t+step)]);return out;
}
export function pipelineTimeline(plan,data,selected=plan.recommended){
  const samples=plan.profile.samples,step=plan.profile.stepSeconds*1000,origin=plan.original.start,end=Math.max(...plan.candidates.map(w=>w.end)),total=end-origin;
  const pos=t=>Math.max(0,Math.min(100,(t-origin)/total*100)),width=(s,e)=>Math.max(.3,pos(e)-pos(s));
  const span=([s,e],cls,label)=>`<span class="time-bar ${cls}" style="left:${pos(s)}%;width:${width(s,e)}%" title="${esc(label)}: ${esc(range({start:s,end:e}))} UTC">${esc(label)}</span>`;
  const button=(w,cls,label,attrs)=>`<button class="time-bar ${cls}" style="left:${pos(w.start)}%;width:${width(w.start,w.end)}%" ${attrs} title="${esc(label)}: ${esc(range(w))} UTC">${esc(label)}</button>`;
  const during=predicate=>runs(samples,step,origin,end,predicate),finiteNumber=x=>typeof x==='number'&&Number.isFinite(x);
  const threshold=id=>plan.rules[id].threshold.value,storm=plan.rules.cutoff?.storm?.indexThreshold??5;
  const other=selected.id===plan.original.id?plan.alternative:selected,conjunctions=plan.events.filter(e=>e.factor==='ops'&&e.start<end&&e.end>origin);
  const screened=samples.some(p=>finiteNumber(p.ops)),within=t=>t>=origin&&t<end;
  // GOES >=10 MeV at geostationary orbit on the NOAA S scale: the event the station may partly escape.
  const radiation=data.series.filter(x=>x.quantity==='proton_integral_flux'&&x.energy===10).flatMap(x=>{
    const out=[];let open=null,last=null,peak=0;
    for(const q of [...x.samples,{t:Infinity,v:null}]){if(q.v!==null&&q.v>=10&&within(q.t)){open??=q.t;last=q.t;peak=Math.max(peak,q.v);}else if(open!==null){out.push({start:open,end:last+x.cadenceMinutes*60000,peak});open=null;peak=0;}}
    return out;});
  const notices=data.context.map(r=>({t:Date.parse(r.publishedAt??r.measuredAt),label:r.sourceId==='nasa.donki'?r.payload?.messageType??'DONKI':'GEOALERT'})).filter(n=>within(n.t));
  const rows=[
    ['Окно A',button(plan.original,'original-bar','Окно A','data-window="A"')],
    [other?`Окно ${esc(other.id)}`:'Альтернатива',other?button(other,other.status==='acceptable'?'good-bar':'alternative-bar',`Окно ${other.id}`,`data-window="${esc(other.id)}"`):'<span class="row-empty">Нет сдвига</span>'],
    ['Солнечные протоны',[...during(p=>p.sep===null).map(r=>span(r,'gap-bar','нет данных')),...during(p=>p.sepBasis==='persistence').map(r=>span(r,'forecast-bar','прогноз')),...during(p=>finiteNumber(p.sep)&&p.sep>=threshold('sep')).map(r=>span(r,'weather-bar',`≥ ${threshold('sep')} pfu`))].join('')],
    ['GOES ≥10 МэВ',radiation.map(r=>span([r.start,r.end],'weather-bar',`S${Math.min(5,Math.floor(Math.log10(r.peak)))}`)).join('')],
    ['Геомагнитная буря',during(p=>(p.hp30??p.hp30Forecast)>=storm).map(r=>span(r,'storm-bar',`Hp30 ≥ ${storm}`)).join('')],
    ['ЮАА',during(p=>finiteNumber(p.trapped)&&p.trapped>=threshold('trapped')).map(r=>span(r,'saa-bar','ЮАА')).join('')],
    ['Сближения',screened||conjunctions.length?conjunctions.map(e=>button(e,'conjunction-bar','TCA',`data-warning="${esc(e.id)}"`)).join(''):'<div class="missing-full">Нет экрана SOCRATES для этого периода</div>'],
    ['Уведомления',notices.map(n=>`<span class="time-bar notice-bar" style="left:${pos(n.t)}%" title="${esc(n.label)} · ${esc(time(n.t))} UTC">${esc(n.label)}</span>`).join('')],
    ['Освещённость',during(p=>p.sunlit===true).map(([s,e])=>`<span class="light-segment" style="left:${pos(s)}%;width:${width(s,e)}%"></span>`).join('')],
    ['Неполнота данных',during(p=>p.lat===null||['sep','trapped','meteor'].some(id=>p[id]===null)).map(r=>span(r,'gap-bar','нет данных')).join('')]
  ];
  const ticks=Array.from({length:5},(_,i)=>`<span style="left:${i*25}%">${time(origin+total*i/4)}</span>`).join('');
  return `<section class="panel timeline-panel pipeline-timeline"><div class="panel-heading"><h2>Таймлайн обстановки</h2><span class="subtle-tag">UTC</span></div><div class="timeline-subheading"><span>${esc(date(origin))}</span><span>Горизонт ${Math.round(total/3600000)} ч</span></div><div class="timeline"><div class="axis"><div></div><div class="ticks">${ticks}</div></div>${rows.map(([label,bars],i)=>`<div class="timeline-row ${i===2?'row-section':''}"><div class="row-label">${label}</div><div class="track"><div class="track-grid"></div>${bars||'<span class="row-empty">Нет событий</span>'}</div></div>`).join('')}</div><div class="timeline-legend"><span><i class="legend-color orange"></i>Срабатывание механизма</span><span><i class="legend-color green"></i>Хорошее окно</span><span><i class="legend-color dashed"></i>Прогноз «сохранение»</span><span><i class="legend-color hatch"></i>Нет данных</span></div><div class="timeline-note">Нажмите на окно или TCA: окно свяжется с картой, TCA откроет предупреждение.</div></section>`;
}
export function pipelineSources(plan,data){return `<section class="panel pipeline-summary"><div class="panel-heading"><h2>Источники и происхождение</h2><button class="button outline" data-action="refresh">Обновить</button></div><div class="table-scroll"><table><thead><tr><th>Источник / версия</th><th>Последняя загрузка</th><th>Состояние / ограничения</th><th>Включён</th></tr></thead><tbody>${plan.sources.map(s=>`<tr><td><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.name)}</a><small>${esc(s.version)}</small></td><td>${esc(s.lastSuccess)}<small>Публикация: ${esc(s.publishedAt)}</small></td><td>${s.applicable===false?'не используется в этом режиме':esc(s.status)}<small>${esc(s.detail)}</small><small>В строгом replay: ${s.replayEligible?'есть датированные записи':'нет подтверждения публикации'}</small></td><td><button class="switch ${s.enabled?'on':''}" role="switch" aria-checked="${s.enabled}" data-source="${esc(s.id)}" aria-label="Источник ${esc(s.name)}"><span></span></button></td></tr>`).join('')}</tbody></table></div><h3>Покрытие рядов по всему горизонту</h3><ul>${Object.entries(data.coverage).map(([id,c])=>`<li>${esc(id)}: ${(c.fraction*100).toFixed(1)}% (${c.validSamples}/${c.expectedSamples})</li>`).join('')||'<li>Нет валидных рядов</li>'}</ul></section>`;}
export function pipelineHistory(plan,data){return `<section class="panel pipeline-summary"><h2>Исторические выпуски и независимая сверка</h2><p>В строгом replay используются только версии с подтверждённой публикацией не позже отсечения. Время скачивания и эпоха орбиты не заменяют дату выпуска.</p><p>Датированных выпусков на срезе: ${data.context.length}. Строгая воспроизводимость полного решения: ${plan.strictReproducibility?'да':'не подтверждена'}.</p>${data.context.map(r=>`<details><summary>${esc(r.sourceId)} · ${esc(r.publishedAt)}</summary><pre>${esc(typeof r.payload==='string'?r.payload:JSON.stringify(r.payload,null,2))}</pre></details>`).join('')}<p>DONKI — контекст для сверки, а не измерение потока у станции. FAR и заблаговременность требуют размеченных событий и полного архива.</p></section>`;}
