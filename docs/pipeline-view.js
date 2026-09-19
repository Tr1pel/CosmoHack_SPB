import {time,date,range} from './domain.js';
import {SCORE_MAX} from './pipeline.js';
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const confidenceText=c=>typeof c==='object'?({low:'Низкая',medium:'Средняя',high:'Высокая'}[c.level]??c.level):`${c}%`;
// Plain-language answer to "what does low confidence actually mean here".
const MEANING={high:'полные и свежие измерения',medium:'часть оценки основана на прогнозе или допущениях',low:'данные неполные, устарели или прогноз не подтверждён'};
const VERDICT={acceptable:'Подходит',review:'Требует проверки',insufficient:'Недостаточно данных'};
const SHORT={acceptable:'Подходит',review:'Проверка',insufficient:'Нет данных'};
const STATUS={acceptable:'Ниже порога',review:'Выше порога',insufficient:'Нет полных данных',context:'Контекст'};
const MARK={high:'✓',medium:'◐',low:'✕'};
const score=c=>typeof c==='object'&&Number.isFinite(c?.score)?`${c.score} из ${SCORE_MAX}`:'';
// The criteria that hold the summary score down — the only ones worth acting on.
const limiting=c=>(c?.criteria??[]).filter(x=>(c.limiting??[]).includes(x.id));
const pick=(plan,id)=>plan.candidates.find(w=>w.id===id);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const day=t=>new Date(t).toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:'short'});
const SUPERSCRIPT={'-':'⁻',0:'⁰',1:'¹',2:'²',3:'³',4:'⁴',5:'⁵',6:'⁶',7:'⁷',8:'⁸',9:'⁹'};
// Two significant digits; very small or large values as a·10ⁿ instead of long zero runs.
function sci(x,digits=2){
  if(!finite(x))return '—';if(x===0)return '0';
  let e=Math.floor(Math.log10(Math.abs(x))),m=Number((x/10**e).toFixed(digits-1));
  if(Math.abs(m)>=10){m/=10;e+=1;}
  return e>=-2&&e<4?String(Number(x.toPrecision(digits))):`${m}·10${String(e).replace(/./g,c=>SUPERSCRIPT[c])}`;
}
// What keeps a window from being good, in the words of the mechanisms.
function issues(w,plan,names){
  const out=[],f=w.factors,rules=plan.rules;
  if(w.missing.length)out.push(`нет данных: ${w.missing.map(id=>(names[id]??'орбита').toLowerCase()).join(', ')}`);
  if(f.sep.status==='review')out.push(`солнечные протоны до ${sci(f.sep.peak)} pfu (порог ${rules.sep.threshold.value})`);
  if(f.trapped.status==='review')out.push(`ЮАА: захваченные протоны до ${Math.round(f.trapped.peak)} см⁻²с⁻¹ (порог ${rules.trapped.threshold.value})`);
  if(f.meteor.status==='review')out.push(`метеороиды ${sci(f.meteor.value)} (порог ${sci(rules.meteor.threshold.value)})`);
  const conflicts=w.warnings.filter(e=>e.factor==='ops').length;
  if(conflicts)out.push(`сближений: ${conflicts}`);
  return out;
}
export function pipelineSummary(plan,data,selected=plan.recommended){
  const w=plan.recommended,a=plan.original,total=plan.candidates.length,names=Object.fromEntries(data.factors.map(f=>[f.id,f.name]));
  const best=plan.best.map(id=>pick(plan,id)).filter(Boolean),incomplete=best.every(x=>x.incomplete);
  const heading=plan.goodCount?'Рекомендуемое окно':incomplete?'Оснований для выбора недостаточно':'Хороших окон нет — лучшее из доступных';
  const lead=plan.goodCount?`${plan.goodCount} из ${total} окон подходят по порогам.`:incomplete?`Не хватает данных: ${[...new Set(best.flatMap(x=>x.missing))].map(id=>(names[id]??'орбита').toLowerCase()).join(', ')}.`:'Подходящих окон нет: есть срабатывания или пробелы данных.';
  const aIssues=issues(a,plan,names),original=a.id===w.id?'Исходное окно — лучшее.':`Исходное окно A (${range(a)} UTC) — место ${a.position}: ${VERDICT[a.status].toLowerCase()}${aIssues.length?` — ${aIssues.join('; ')}`:''}.`;
  const chosen=selected.id===w.id;
  const choices=best;
  const option=x=>{
    const active=x.id===selected.id,recommended=x.id===w.id,shift=Math.round((x.start-a.start)/3600000);
    return `<button type="button" class="summary-option${active?' selected':''}" data-window="${esc(x.id)}" aria-pressed="${active}" aria-label="${esc(`${range(x)} UTC, ${date(x.start)}, место ${x.position}, ${VERDICT[x.status]}${recommended?', рекомендуемое':''}`)}"><span class="option-top"><span class="option-rank">№ ${x.position}</span><span class="option-label">${recommended?'Рекомендуемое':x.id===a.id?'Исходное окно':`Сдвиг +${shift} ч`}</span><span class="option-check" aria-hidden="true">${active?'✓':''}</span></span><strong class="option-time">${range(x)} <small>UTC</small></strong><span class="option-date">${esc(date(x.start))} · ${plan.request.duration} ч</span><span class="option-status ${x.status}"><i></i>${VERDICT[x.status]}</span>${plan.goodCount||!issues(x,plan,names).length?'':`<span class="option-issue">${esc(issues(x,plan,names).join(' · '))}</span>`}</button>`;
  };
  const c=w.confidence,weakest=limiting(c);
  return `<section class="panel summary-panel"><div class="summary-overview"><div class="summary-main"><div class="eyebrow">РЕКОМЕНДАЦИЯ</div><h2>${heading}</h2><div class="summary-time"><span class="rec-time">${range(w)}<span>UTC</span></span><span class="badge ${w.status}"><span class="dot"></span>${VERDICT[w.status]}</span></div><div class="rec-date">${esc(date(w.start))} · ${plan.request.duration} ч · место 1 из ${total}${w.id===a.id?' · исходное окно':` · сдвиг +${Math.round((w.start-a.start)/3600000)} ч`}</div><p>${esc(lead)}</p><button type="button" class="summary-select${chosen?' is-chosen':''}" data-window="${esc(w.id)}" aria-pressed="${chosen}">${chosen?'✓ Рекомендуемое выбрано':'Выбрать рекомендуемое'}<span aria-hidden="true">${chosen?'':'→'}</span></button></div><aside class="summary-confidence level-${c.level}"><span>Уверенность рекомендации</span><strong>${confidenceText(c)}<em>${esc(score(c))}</em></strong><div class="confidence-steps" aria-hidden="true">${Array.from({length:SCORE_MAX},(_,i)=>`<i class="${i<c.score?'filled':''}"></i>`).join('')}</div><p class="conf-meaning">${esc(MEANING[c.level]??'')}. Это не вероятность безопасности.</p>${weakest.length&&c.score<SCORE_MAX?`<p>Ограничивают: ${weakest.map(x=>esc(x.label)).join(', ')}.</p>`:''}<button type="button" class="text-button" data-window="${esc(w.id)}" data-scroll="confidence">Критерии оценки ↓</button></aside></div><div class="summary-chooser"><div class="chooser-heading"><div><h3>${plan.goodCount?'Подходящие окна':'Лучшие из доступных'} <span>${best.length}</span></h3><p>Выбрано: ${range(selected)} UTC · место ${selected.position}</p></div><button type="button" class="text-button" data-pane="table" data-scroll="windows">Все окна →</button></div><div class="summary-options" role="group" aria-label="Выбор окна">${choices.map(option).join('')}</div><p class="summary-original">${esc(original)}</p></div></section>`;
}
// Runs of consecutive profile samples that satisfy a predicate, as [start, end) intervals.
function runs(samples,step,from,to,predicate){
  const out=[];let open=null;
  for(const p of samples){if(p.t<from||p.t>=to)continue;if(predicate(p)){if(open===null)open=p.t;}else if(open!==null){out.push([open,p.t]);open=null;}}
  if(open!==null)out.push([open,Math.min(to,samples.at(-1).t+step)]);return out;
}
// Consecutive samples with the same value of a field, as {start, end, value}.
function segments(samples,step,from,to,value){
  const out=[];
  for(const p of samples){if(p.t<from||p.t>=to)continue;const v=value(p),last=out.at(-1);if(last&&last.value===v&&last.end===p.t)last.end=p.t+step;else out.push({start:p.t,end:p.t+step,value:v});}
  return out;
}
const HEAD=[
  ['Место','Порядок выбора: полнота данных → окна без срабатываний → число срабатываний → поток солнечных протонов → минуты в ЮАА → сближения. ★ — рекомендуемое окно'],
  ['Окно, UTC','Начало и конец выхода; кандидаты идут с шагом 1 ч'],
  ['Итог','Подходит — данные полные и ни одного срабатывания; Проверка — хотя бы один механизм выше порога или есть сближение; Нет данных — механизм покрыт не полностью'],
  ['<abbr>SEP</abbr>, pfu','Солнечные энергичные протоны: пик потока ≥ 30 МэВ у станции, за магнитным экраном. «прогноз» — часть окна после последнего замера GOES'],
  ['Прогноз, ч','Заблаговременность начала окна: непрерывное время от последнего наблюдения GOES. Пусто, если окно наблюдалось целиком'],
  ['<abbr>ЮАА</abbr>, мин','Минуты окна в Южно-Атлантической аномалии — области, где радиационный пояс ближе всего к Земле'],
  ['<abbr>AP-8</abbr>','Пик потока захваченных протонов ≥ 10 МэВ по модели NASA AP-8, см⁻²с⁻¹'],
  ['Метеор.','Ожидаемое число попаданий метеороидов ≥ 6,7 Дж в 1 м² за окно'],
  ['Сбл.','Сближения с объектами каталога (TCA ± 30 мин) по экрану SOCRATES. Контекст: выбор не блокирует'],
  ['<abbr>ГКЛ</abbr>, %','Галактические космические лучи: средняя доля межпланетного потока выше магнитного обрезания. Контекст'],
  ['Уверен.','Насколько вывод опирается на полные и свежие измерения; подробности — в разделе «Подробно»']
];
export function pipelineWindows(plan,data,selected=plan.recommended,sort='time',pane='timeline'){
  const samples=plan.profile.samples,step=plan.profile.stepSeconds*1000,rules=plan.rules,names=Object.fromEntries(data.factors.map(f=>[f.id,f.name]));
  const origin=Math.min(...plan.candidates.map(w=>w.start)),end=Math.max(...plan.candidates.map(w=>w.end)),total=end-origin;
  const pos=t=>Math.max(0,Math.min(100,(t-origin)/total*100)),style=(s,e)=>`left:${pos(s).toFixed(3)}%;width:${Math.max(.3,pos(e)-pos(s)).toFixed(3)}%`;
  const span=([s,e],cls,label)=>`<span class="time-bar ${cls}" style="${style(s,e)}" title="${esc(label)}: ${esc(range({start:s,end:e}))} UTC">${esc(label)}</span>`;
  const during=predicate=>runs(samples,step,origin,end,predicate),threshold=id=>rules[id].threshold.value,storm=rules.cutoff?.storm?.indexThreshold??5;
  // Hour ticks, the selected window and "now" run through every track of the chart.
  const every=[1,2,3,4,6].find(h=>total/(h*3600000)<=10)??6,ticks=[];
  for(let t=Math.ceil(origin/(every*3600000))*every*3600000;t<=end;t+=every*3600000)ticks.push(t);
  const now=plan.request.mode==='current'?Date.parse(plan.generatedAt):NaN,showNow=finite(now)&&now>origin&&now<end;
  const showSelection=pane==='table'||selected.status==='acceptable';
  const underlay=`${ticks.map(t=>`<i class="g-tick" style="left:${pos(t)}%"></i>`).join('')}${showSelection?`<i class="g-band" style="${style(selected.start,selected.end)}"></i>`:''}${showNow?`<i class="g-now" style="left:${pos(now)}%"></i>`:''}`;
  const track=(bars,empty='')=>`<div class="g-track">${underlay}${bars||empty}</div>`;
  const axis=`<div class="g-track g-axis">${ticks.map(t=>`<span${pane==='timeline'&& (pos(t)===0||pos(t)===100)?` class="${pos(t)===0?'axis-start':'axis-end'}"`:''} style="left:${pos(t)}%">${new Date(t).getUTCHours()<every?`<b>${esc(day(t))}</b>`:''}${time(t)}</span>`).join('')}${showNow?`<span class="g-now-label" style="left:${pos(now)}%">сейчас</span>`:''}</div>`;
  const head=`<div class="g-row g-head">${HEAD.map(([label,help],i)=>`<div class="g-cell ${i>2&&i<10?'g-num':''}" title="${esc(help)}">${label}</div>`).join('')}${axis}</div>`;
  const timelineHead=`<div class="g-row g-head"><div class="g-cell" title="Каждая строка — один фактор обстановки на общей шкале времени">Фактор обстановки</div>${axis}</div>`;
  const flagged=(f,text)=>f.status==='review'?`<b class="over">${text}</b>`:text;
  const order=[...plan.candidates].sort(sort==='rank'?(a,b)=>a.position-b.position:(a,b)=>a.start-b.start);
  const windowRow=w=>{
    const f=w.factors,forecast=w.confidence.reasons.some(r=>r.code==='persistence'),why=issues(w,plan,names),star=w.id===plan.recommended.id;
    const label=`${range(w)} UTC · место ${w.position}${star?', рекомендуемое':''} · ${VERDICT[w.status]}${why.length?` — ${why.join('; ')}`:''}`;
    return `<div class="g-row window-row ${w.status} ${w.id===selected.id?'selected':''}" data-window="${esc(w.id)}"><div class="g-cell g-rank">${star?'<span class="star" title="Рекомендуемое окно">★</span>':''}${w.position}</div><div class="g-cell g-when"><button type="button" class="text-button" aria-label="Выбрать окно ${esc(label)}">${range(w)}</button>${w.id===plan.original.id?'<small>A · исходное</small>':''}</div><div class="g-cell"><span class="badge ${w.status}"><span class="dot"></span>${SHORT[w.status]}</span></div><div class="g-cell g-num">${flagged(f.sep,sci(f.sep.peak))}${forecast?'<small>прогноз</small>':''}</div><div class="g-cell g-num">${finite(w.confidence.forecastLeadHours)?w.confidence.forecastLeadHours.toFixed(1):'—'}</div><div class="g-cell g-num">${w.saaMinutes??'—'}</div><div class="g-cell g-num">${flagged(f.trapped,f.trapped.peak===null?'—':Math.round(f.trapped.peak))}</div><div class="g-cell g-num">${flagged(f.meteor,sci(f.meteor.value))}</div><div class="g-cell g-num">${f.ops.coverage<1?'—':flagged(f.ops,f.ops.value)}</div><div class="g-cell g-num">${f.gcr.value===null?'—':f.gcr.value.toFixed(1)}</div><div class="g-cell g-conf level-${w.confidence.level}">${confidenceText(w.confidence)}<small>${esc(score(w.confidence))}</small></div>${track(`<span class="time-bar window-bar ${w.status}" style="${style(w.start,w.end)}" title="${esc(label)}">${star?'★':''}${w.position}</span>`)}</div>`;
  };
  const row=(title,help,bars,empty='<span class="row-empty">Нет событий</span>',cls='',height='')=>`<div class="g-row env-row ${cls}"${height?` style="--lane-height:${height}px"`:''}><div class="g-label" title="${esc(help)}"><strong>${title}</strong></div>${track(bars,empty)}</div>`;
  const since=samples.find(p=>p.sepBasis==='persistence')?.sepObservedAt;
  // GOES >= 10 MeV at geostationary orbit on the NOAA S scale: the event the station may partly escape.
  const within=t=>t>=origin&&t<end;
  const radiation=data.series.filter(x=>x.quantity==='proton_integral_flux'&&x.energy===10).flatMap(x=>{
    const out=[];let open=null,last=null,peak=0;
    for(const q of [...x.samples,{t:Infinity,v:null}]){if(q.v!==null&&q.v>=10&&within(q.t)){open??=q.t;last=q.t;peak=Math.max(peak,q.v);}else if(open!==null){out.push({start:open,end:last+x.cadenceMinutes*60000,peak});open=null;peak=0;}}
    return out;});
  const conjunctions=plan.events.filter(e=>e.factor==='ops'&&e.start<end&&e.end>origin),screened=samples.some(p=>finite(p.ops));
  const notices=data.context.map(r=>({t:Date.parse(r.publishedAt??r.measuredAt),label:r.sourceId==='nasa.donki'?r.payload?.messageType??'DONKI':'GEOALERT'})).filter(n=>within(n.t));
  const limit=rules.confidence?.sepForecastMaxPercent;
  const outlook=plan.request.mode!=='current'?'':row('Прогноз бури S1+ · SWPC',`Вероятность солнечной радиационной бури S1+ по суткам (NOAA SWPC). До ${limit} % прогноз «как сейчас» подтверждён независимым источником — уверенность средняя, выше — низкая`,segments(samples,step,origin,end,p=>finite(p.sepEventProbability)?p.sepEventProbability:null).map(s=>s.value===null?span([s.start,s.end],'gap-bar','нет прогноза SWPC'):span([s.start,s.end],`outlook-bar ${s.value>limit?'over':''}`,`${day(s.start)}: ${s.value} %`)).join(''));
  const rows=[
    row('Солнечные протоны · SEP',`Поток ≥ 30 МэВ за магнитным экраном. Оранжевое — выше порога ${threshold('sep')} pfu; пунктир — прогноз «как сейчас» после последнего замера GOES${finite(since)?` (${time(since)} UTC)`:''}; штриховка — нет данных`,[...during(p=>p.sep===null).map(r=>span(r,'gap-bar','нет данных')),...during(p=>p.sepBasis==='persistence').map(r=>span(r,'forecast-bar','прогноз «как сейчас»')),...during(p=>finite(p.sep)&&p.sep>=threshold('sep')).map(r=>span(r,'weather-bar',`≥ ${threshold('sep')} pfu`))].join('')),
    outlook,
    row('Радиационная буря · GOES','Радиационная буря по шкале NOAA S: S1 от 10 pfu, S2 от 100, S3 от 1000. Измеряется вне магнитного экрана — у станции поток ниже',radiation.map(r=>span([r.start,r.end],'weather-bar',`S${Math.min(5,Math.floor(Math.log10(r.peak)))}`)).join('')),
    row(`Геомагнитная буря · Hp30 ≥ ${storm}`,'Hp30 — получасовой индекс геомагнитной активности GFZ (аналог Kp). В бурю магнитный экран слабеет и протоны проникают глубже; пунктирная рамка — прогноз GFZ',[...during(p=>finite(p.hp30)&&p.hp30>=storm).map(r=>span(r,'storm-bar',`Hp30 ≥ ${storm}`)),...during(p=>p.hp30===null&&finite(p.hp30Forecast)&&p.hp30Forecast>=storm).map(r=>span(r,'storm-bar forecast',`прогноз Hp30 ≥ ${storm}`))].join('')),
    row('Радиационный пояс · ЮАА',`Пролёты Южно-Атлантической аномалии (сиреневое). Оранжевое — поток захваченных протонов по AP-8 ≥ ${threshold('trapped')} см⁻²с⁻¹, срабатывание`,[...during(p=>p.saa===true).map(r=>span(r,'saa-bar','ЮАА')),...during(p=>finite(p.trapped)&&p.trapped>=threshold('trapped')).map(r=>span(r,'saa-bar over',`AP-8 ≥ ${threshold('trapped')}`))].join('')),
    row('Сближения · TCA','Момент наибольшего сближения (TCA) с объектом каталога ± 30 мин по экрану SOCRATES на 7 суток. Нажмите, чтобы открыть предупреждение',conjunctions.map(e=>`<button class="time-bar conjunction-bar" style="${style(e.start,e.end)}" data-warning="${esc(e.id)}" title="Сближение: TCA ${esc(time(e.tca??e.start))} UTC">TCA</button>`).join(''),screened?'<span class="row-empty">Сближений нет</span>':'<div class="missing-full">Нет экрана SOCRATES для этого периода</div>'),
    row('Уведомления · DONKI / NCEI','Сообщения NASA DONKI: FLR — вспышка, CME — выброс массы, SEP — протонное событие, GST — геомагнитная буря, IPS — ударная волна, MPC — сжатие магнитосферы; GEOALERT — бюллетени NOAA',notices.map(n=>`<span class="time-bar notice-bar" style="left:${pos(n.t)}%" title="${esc(n.label)} · ${esc(time(n.t))} UTC">${esc(n.label)}</span>`).join('')),
    row('Освещённость','Жёлтое — станция на солнце, пусто — в тени Земли',during(p=>p.sunlit===true).map(([s,e])=>`<span class="light-segment" style="${style(s,e)}"></span>`).join(''),samples.some(p=>typeof p.sunlit==='boolean')?'<span class="row-empty">В тени Земли</span>':'<span class="row-empty">Нет данных орбиты</span>'),
    row('Неполнота данных','Нет данных солнечных протонов, захваченных частиц, метеороидов или орбиты — такие окна не оцениваются',during(p=>p.lat===null||['sep','trapped','meteor'].some(id=>p[id]===null)).map(r=>span(r,'gap-bar','нет данных')).join(''),'<span class="row-empty">Пробелов нет</span>')
  ];
  // Pack acceptable windows into non-overlapping lanes, including 5–8 hour windows.
  const laneWindows=plan.candidates.filter(w=>w.status==='acceptable').sort((a,b)=>a.start-b.start);
  const laneEnds=[];
  const lane=laneWindows.map(x=>{
    let index=laneEnds.findIndex(end=>end<=x.start);
    if(index===-1)index=laneEnds.length;
    laneEnds[index]=x.end;
    const star=x.id===plan.recommended.id,label=`${range(x)} UTC · место ${x.position}${star?', рекомендуемое':''}`;
    return `<button type="button" class="time-bar window-lane acceptable${x.id===selected.id?' selected':''}" style="${style(x.start,x.end)};top:${10+index*32}px" data-window="${esc(x.id)}" aria-pressed="${x.id===selected.id}" aria-label="${esc(label)}" title="${esc(label)}"><b>${star?'★ ':''}${x.position}</b><span>${range(x)}</span></button>`;
  }).join('');
  const table=`<div class="gantt">${head}${order.map(windowRow).join('')}</div>`;
  const laneRow=row(`Подходящие окна <span class="lane-count">${laneWindows.length}</span>`,'Число — место в рейтинге; ★ — рекомендуемое окно',lane,'<span class="row-empty">Подходящих окон нет</span>','lanes',Math.max(56,laneEnds.length*32+16));
  const timeline=`<div class="gantt mode-timeline">${timelineHead}${laneRow}${rows.join('')}</div>`;
  const tab=(id,label,help)=>`<button type="button" data-pane="${id}" class="${pane===id?'selected':''}" title="${esc(help)}">${label}</button>`;
  const intro=pane==='table'
    ?''
    :`${esc(date(origin))} · ${time(origin)} — ${day(end)} ${time(end)} UTC${showSelection?` · Выбрано ${range(selected)}`:''}`;
  return `<section class="panel windows-panel" id="windows"><div class="panel-heading"><h2>Окна и обстановка</h2><div class="panel-tools"><span class="subtle-tag">${plan.candidates.length} окон · шаг 1 ч · UTC</span><div class="segmented pane-switch" role="group" aria-label="Режим блока">${tab('timeline','Обстановка','Таймлайн факторов на общей шкале времени')}${tab('table','Все окна','Таблица окон-кандидатов с оценками механизмов')}</div>${pane==='table'?`<div class="segmented sort-switch" role="group" aria-label="Порядок окон"><button type="button" data-sort="time" class="${sort==='rank'?'':'selected'}">По времени</button><button type="button" data-sort="rank" class="${sort==='rank'?'selected':''}">По месту</button></div>`:''}</div></div>${intro?`<p class="windows-intro">${intro}</p>`:''}<div class="table-scroll">${pane==='table'?table:timeline}</div><div class="g-legend"><span><i class="lg acceptable"></i>Подходит</span>${pane==='table'?'<span><i class="lg review"></i>Требует проверки</span>':''}<span><i class="lg insufficient"></i>Нет данных</span>${showSelection?'<span><i class="lg band"></i>Выбранное окно</span>':''}${showNow?'<span><i class="lg now"></i>Сейчас</span>':''}<span><i class="lg dashed"></i>Прогноз «как сейчас»</span><span><i class="lg saa"></i>ЮАА</span><span><i class="lg storm"></i>Геомагнитная буря</span><span><i class="lg light"></i>Станция на солнце</span></div></section>`;
}
export function pipelineDetails(plan,data,selected=plan.recommended){
  const w=selected,a=plan.original,other=w.id===a.id?plan.alternative:w,rules=plan.rules,c=w.confidence;
  const value={
    sep:v=>v.peak===null?'оценки нет':`пик ${sci(v.peak)} pfu, порог ${rules.sep.threshold.value}`,
    trapped:v=>v.peak===null?'оценки нет':`пик ${Math.round(v.peak)} см⁻²с⁻¹, порог ${rules.trapped.threshold.value}`,
    meteor:v=>v.value===null?'оценки нет':`${sci(v.value)} попадания в 1 м², порог ${sci(rules.meteor.threshold.value)}`,
    gcr:v=>v.value===null?'оценки нет':`${v.value.toFixed(1)} % межпланетного потока`,
    ops:v=>v.coverage<1?'экрана сближений нет':`сближений: ${v.value}`
  };
  const cell=(x,f)=>{const v=x?.factors[f.id];if(!v)return '<td>—</td>';return `<td><span class="badge ${v.status==='context'?'':v.status}">${f.id==='ops'&&v.status==='review'?'Есть сближения':STATUS[v.status]}</span><small>${esc(value[f.id](v))} · покрытие ${Math.round(v.coverage*100)} %</small></td>`;};
  const column=x=>x?`<th><button class="text-button" data-window="${esc(x.id)}">${x.id===a.id?'Исходное окно A':`Окно · место ${x.position}`}</button><small>${esc(date(x.start))} · ${range(x)} UTC</small></th>`:'<th>—<small>Нет альтернативы</small></th>';
  const role=id=>(rules.contextMechanisms??[]).includes(id)?'контекст, выбор не блокирует':'решает';
  const note=plan.cutoff?`Replay: используются только публикации до ${plan.cutoff}; источники без времени выпуска исключены.`:plan.request.mode==='current'?'После последнего замера GOES действует базовый прогноз «последнее наблюдение сохраняется»: начало события он не предсказывает.':'Архивный разбор: только наблюдения за период, без прогноза.';
  return `<section class="panel details-panel" id="details"><div class="panel-heading"><h2>Подробно: окно ${range(w)} UTC</h2><span class="subtle-tag">${esc(date(w.start))} · место ${w.position} из ${plan.candidates.length} · ${VERDICT[w.status]}</span></div><div class="details-grid"><div><h3>Механизмы по отдельности</h3><div class="table-scroll"><table class="mechanisms-table"><thead><tr><th>Механизм</th>${column(a)}${column(other)}</tr></thead><tbody>${data.factors.map(f=>`<tr><td>${esc(f.name)}<small>${role(f.id)}</small></td>${cell(a,f)}${cell(other,f)}</tr>`).join('')}</tbody></table></div></div><div class="details-confidence level-${c.level}" id="confidence"><h3>Уверенность: ${confidenceText(c)}<span class="conf-score">${esc(score(c))}</span></h3><p class="muted">Оценка — минимум по критериям, от 0 до ${SCORE_MAX}.</p><ul class="criteria">${(c.criteria??[]).map(x=>`<li class="level-${x.level}${(c.limiting??[]).includes(x.id)?' limiting':''}"><span class="mark" aria-hidden="true">${MARK[x.level]}</span><details class="criterion"><summary title="${esc(x.measures??'')}"><strong>${esc(x.label)}<span class="crit-score">${x.score} из ${SCORE_MAX}</span></strong></summary><small>${esc(x.detail)}</small>${x.hint?`<small class="hint">${esc(x.hint)}</small>`:''}</details></li>`).join('')}</ul></div></div><details><summary>Причины и ограничения окна</summary><ul>${c.reasons.map(r=>`<li>${esc(r.detail)}</li>`).join('')}</ul><p class="muted">${esc(note)}</p></details><details><summary>Правила оценки · ${esc(rules.version)}</summary><pre>${esc(JSON.stringify(rules,null,2))}</pre></details></section>`;
}
export function pipelineSources(plan,data){return `<section class="panel pipeline-summary"><div class="panel-heading"><h2>Источники и происхождение</h2><button class="button outline" data-action="refresh">Обновить</button></div><div class="table-scroll"><table><thead><tr><th>Источник / версия</th><th>Последняя загрузка</th><th>Состояние / ограничения</th><th>Включён</th></tr></thead><tbody>${plan.sources.map(s=>`<tr><td><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.name)}</a><small>${esc(s.version)}</small></td><td>${esc(s.lastSuccess)}<small>Публикация: ${esc(s.publishedAt)}</small></td><td>${s.applicable===false?'не используется в этом режиме':esc(s.status)}<small>${esc(s.detail)}</small><small>В строгом replay: ${s.replayEligible?'есть датированные записи':'нет подтверждения публикации'}</small></td><td><button class="switch ${s.enabled?'on':''}" role="switch" aria-checked="${s.enabled}" data-source="${esc(s.id)}" aria-label="Источник ${esc(s.name)}"><span></span></button></td></tr>`).join('')}</tbody></table></div><h3>Покрытие рядов по всему горизонту</h3><ul>${Object.entries(data.coverage).map(([id,c])=>`<li>${esc(id)}: ${(c.fraction*100).toFixed(1)}% (${c.validSamples}/${c.expectedSamples})</li>`).join('')||'<li>Нет валидных рядов</li>'}</ul></section>`;}
export function pipelineHistory(plan,data){
  const start=Math.min(...plan.candidates.map(w=>w.start)),end=Math.max(...plan.candidates.map(w=>w.end)),selected=plan.recommended;
  const nasa=data.context.filter(r=>r.sourceId==='nasa.donki').map(r=>{const p=r.payload??{},body=p.messageBody??'',activity=body.match(/Activity ID:\s*(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?)(?:Z|-)/i)?.[1];return {...r,type:p.messageType??'NASA',url:p.messageURL,eventAt:activity?Date.parse(`${activity}Z`):Date.parse(r.measuredAt),body};}).sort((a,b)=>a.eventAt-b.eventAt);
  const sep=nasa.filter(r=>r.type==='SEP'&&/(GOES|SOHO|near[- ]Earth|L1|Earth orbit)/i.test(r.body));
  const primary=nasa.filter(r=>r.type==='SEP'||r.type==='GST'||(r.type==='CME'&&/(near[- ]Earth|missions near Earth)/i.test(r.body)));
  const model=selected.factors.sep,modelText=model.coverage<1?'оценка SEP неполна':model.status==='review'?`модель отметила превышение, пик ${sci(model.peak)} pfu`:`модель оставила SEP ниже порога, пик ${sci(model.peak)} pfu`;
  const comparison=sep.length?(model.coverage<1?'NASA сообщает о SEP в окрестности Земли, но у модели нет полного исторического SEP-профиля для честного численного сравнения.':model.status==='review'?'Модель и независимые уведомления NASA указывают на повышенную протонную обстановку.':'NASA сообщает о SEP в окрестности Земли, а выбранное окно модели ниже локального порога — это не прямое противоречие: DONKI описывает межпланетное событие, модель учитывает магнитный экран МКС.'):'В выбранном диапазоне нет уведомления DONKI о SEP у Земли; это отсутствие внешнего подтверждения, а не доказательство отсутствия события.';
  const query=`https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/notifications?startDate=${new Date(start-86400000).toISOString().slice(0,10)}&endDate=${new Date(end).toISOString().slice(0,10)}&type=all`;
  const report=r=>`<tr><td><strong>${esc(r.type)}</strong><small>${esc(r.payload?.messageID)}</small></td><td>${esc(date(r.eventAt))}<small>${esc(time(r.eventAt))} UTC · опубликовано ${esc(r.publishedAt)}</small></td><td>${r.url?`<a class="text-link" href="${esc(r.url)}" target="_blank" rel="noreferrer">Отчёт NASA →</a>`:'Ссылка не опубликована'}</td></tr>`;
  return `<section class="panel pipeline-summary"><div class="panel-heading"><h2>Исторические выпуски и независимая сверка</h2><a class="text-link" href="${esc(query)}" target="_blank" rel="noreferrer">Правда · NASA DONKI →</a></div><p><strong>Наша модель:</strong> окно ${range(selected)} UTC — ${esc(modelText)}. <strong>Сверка:</strong> ${esc(comparison)}</p><p class="muted">Сравнение ретроспективное: поздние отчёты не участвуют в Replay. DONKI — независимый событийный контекст, а не измерение локального потока у МКС. Ниже выбраны наиболее релевантные SEP, геомагнитные бури и направленные к Земле CME; полный ответ доступен по ссылке «Правда».</p><div class="table-scroll"><table><thead><tr><th>Событие</th><th>Время события / публикации</th><th>Первичный отчёт</th></tr></thead><tbody>${primary.length?primary.map(report).join(''):'<tr><td colspan="3">NASA DONKI не вернул релевантных датированных уведомлений для этого диапазона.</td></tr>'}</tbody></table></div><details><summary>Дополнительные архивные выпуски · DONKI / NCEI (${data.context.length})</summary>${data.context.filter(r=>r.sourceId!=='nasa.donki').map(r=>`<details><summary>${esc(r.sourceId)} · ${esc(r.publishedAt)}</summary><pre>${esc(typeof r.payload==='string'?r.payload:JSON.stringify(r.payload,null,2))}</pre></details>`).join('')||'<p class="muted">Дополнительных выпусков нет.</p>'}</details><p class="muted">Строгая воспроизводимость полного решения: ${plan.strictReproducibility?'да':'не подтверждена'}.</p></section>`;
}
