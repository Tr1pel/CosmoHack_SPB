import { HOUR, computePlan } from './domain.js';
export function validateDataset(data,disabled=[]) {
  const fail=()=>{throw new Error('Ответ сервера не соответствует контракту данных.');};
  const timestamp=x=>typeof x==='string'&&x.endsWith('Z')&&Number.isFinite(Date.parse(x));
  const interval=x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start&&timestamp(x.publishedAt);
  if(!data||typeof data.demo!=='boolean'||!Array.isArray(data.sources)||!Array.isArray(data.events)||!Array.isArray(data.gaps)||!Number.isFinite(data.orbit?.epoch))fail();
  if(data.sources.length!==3||!['weather','conjunction','orbit'].every(id=>data.sources.some(s=>s.id===id)))fail();
  for(const s of data.sources){
    if(!['fresh','stale','unavailable'].includes(s.status)||typeof s.enabled!=='boolean'||!timestamp(s.publishedAt)||!timestamp(s.lastSuccess)||!['name','version','detail'].every(k=>typeof s[k]==='string')||!Number.isFinite(s.cadenceMinutes))fail();
    if(s.url&&!/^https:\/\//i.test(s.url))fail();
    s.enabled=s.enabled&&!disabled.includes(s.id);
  }
  if(new Set(data.events.map(e=>e.id)).size!==data.events.length)fail();
  for(const e of data.events)if(!interval(e)||!['weather','conjunction'].includes(e.factor)||e.sourceId!==e.factor||!Number.isFinite(e.value)||!Number.isFinite(e.weight)||e.weight<0||!['id','title','type','origin','unit','rule','limitation','version'].every(k=>typeof e[k]==='string')||!/^[a-zA-Z0-9_-]+$/.test(e.id))fail();
  for(const g of data.gaps)if(!interval(g)||!data.sources.some(s=>s.id===g.sourceId)||typeof g.reason!=='string')fail();
  return data;
}
// One replaceable ingress for all data. API responses must follow docs/api-contract.md.
export class MockDataProvider {
  async load(request, disabled=[]) {
    const midnight=Date.parse(request.start.slice(0,10)+'T00:00:00Z');
    const at=h=>midnight+h*HOUR;
    const iso=h=>new Date(at(h)).toISOString();
    const sources=[
      {id:'weather',name:'NOAA SWPC',detail:'Космическая погода',version:'mock-swpc-v3',publishedAt:iso(7),lastSuccess:new Date().toISOString(),cadenceMinutes:5,status:'fresh',url:'https://www.swpc.noaa.gov/'},
      {id:'conjunction',name:'События сближений',detail:'Демонстрационный каталог CDM',version:'mock-cdm-v2',publishedAt:iso(8),lastSuccess:new Date().toISOString(),cadenceMinutes:60,status:'fresh',url:null},
      {id:'orbit',name:'Орбитальные данные',detail:'Синтетическая модель МКС',version:'mock-orbit-v1',publishedAt:iso(6),lastSuccess:new Date().toISOString(),cadenceMinutes:360,status:'fresh',url:null}
    ].map(s=>({...s,enabled:!disabled.includes(s.id),provenance:'synthetic'}));
    return {demo:true,sources,orbit:{epoch:at(6),format:'DEMO / не TLE',model:'synthetic-orbit-v1',inclination:51.6,periodMinutes:92.7},gaps:[{sourceId:'weather',start:at(19),end:at(21),publishedAt:iso(7),reason:'Нет прогнозных значений для части окна'}],events:[
      {id:'sep-01',title:'Повышенный поток протонов',type:'SEP',factor:'weather',sourceId:'weather',start:at(9),end:at(13.5),publishedAt:iso(7),origin:'Внешний прогноз',value:12,unit:'pfu (> 10 MeV)',weight:1,rule:'DEMO-SW-01: поток > 10 pfu и пересечение с окном → требуется проверка',limitation:'Поток частиц — прокси-показатель, не расчёт дозы экипажа.',version:'mock-sep-v3'},
      {id:'cdm-01',title:'Сближение вблизи окна ВКД',type:'CDM',factor:'conjunction',sourceId:'conjunction',start:at(11.5),end:at(12.5),tca:at(12),publishedAt:iso(8),origin:'Расчёт сервиса',value:850,unit:'м · расстояние в TCA',weight:4,rule:'DEMO-CA-01: TCA ± 30 мин пересекает окно → требуется проверка',limitation:'Синтетическое событие для МКС. Не оценка вероятности столкновения и не модель фонового MMOD.',version:'mock-cdm-v2'},
      {id:'geo-01',title:'Геомагнитная активность',type:'Kp',factor:'weather',sourceId:'weather',start:at(22),end:at(29),publishedAt:iso(7),origin:'Внешний прогноз',value:5,unit:'Kp · безразмерный индекс',weight:0.7,rule:'DEMO-SW-02: Kp ≥ 5 и пересечение с окном → требуется проверка',limitation:'Планетарный индекс не описывает локальную экспозицию экипажа.',version:'mock-kp-v1'}
    ],verification:{publishedAt:iso(20),forecast:12,observed:9,unit:'pfu',complete:false}};
  }
  async calculate(request,disabled=[]) { const data=await this.load(request,disabled);return {plan:computePlan(request,data),data}; }
}
export class ApiDataProvider {
  constructor(baseUrl) {this.baseUrl=baseUrl.replace(/\/$/,'');}
  async load(request,disabled=[]) {
    const response=await fetch(`${this.baseUrl}/v1/eva/dataset`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request,disabledSources:disabled}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`Источник данных вернул ошибку ${response.status}. Повторите загрузку.`);
    const data=await response.json();
    return validateDataset(data,disabled);
  }
  async calculate(request,disabled=[]) {const data=await this.load(request,disabled);return {plan:computePlan(request,data),data};}
}
// Set apiBaseUrl in config.js to enable your backend. No silent fallback to mock data.
export function createProvider(config) {return config.apiBaseUrl?new ApiDataProvider(config.apiBaseUrl):new MockDataProvider();}
