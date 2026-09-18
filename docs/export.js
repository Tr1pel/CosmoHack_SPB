const enc=new TextEncoder();
function crc32(bytes){let crc=-1;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^-1)>>>0;}
// ZIP STORE, UTF-8 names. No remote export service or dependencies.
export function zipFiles(files){
  const parts=[],central=[];let offset=0;
  for(const [name,contents] of Object.entries(files)){
    const n=enc.encode(name),b=enc.encode(contents),crc=crc32(b),h=new Uint8Array(30+n.length),v=new DataView(h.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,crc,true);v.setUint32(18,b.length,true);v.setUint32(22,b.length,true);v.setUint16(26,n.length,true);h.set(n,30);
    const c=new Uint8Array(46+n.length),cv=new DataView(c.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint32(16,crc,true);cv.setUint32(20,b.length,true);cv.setUint32(24,b.length,true);cv.setUint16(28,n.length,true);cv.setUint32(42,offset,true);c.set(n,46);
    parts.push(h,b);central.push(c);offset+=h.length+b.length;
  }
  const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,central.length,true);ev.setUint16(10,central.length,true);ev.setUint32(12,central.reduce((n,c)=>n+c.length,0),true);ev.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function downloadPlan(plan){
  const report=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт ВКД</title><style>body{font:16px/1.6 system-ui;max-width:850px;margin:40px auto}pre{white-space:pre-wrap}h1{font-size:28px}@media print{body{margin:0}}</style><h1>ОРБИТА · Обоснование расчёта ВКД</h1><p>${plan.demo?'ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ':'Данные внешнего API'}</p><p>Предпочтительное окно: ${escape(new Date(plan.recommended.start).toISOString())} — ${escape(new Date(plan.recommended.end).toISOString())}</p><p>Статус: ${escape(plan.recommended.status)}. Уверенность: ${plan.recommended.confidence}/100.</p><p>Алгоритм: ${escape(plan.algorithmVersion)}. Отсечение: ${escape(plan.cutoff||'не применяется')}.</p><h2>Ограничения</h2><ul>${plan.limitations.map(x=>`<li>${escape(x)}</li>`).join('')}</ul><h2>Полный расчёт и происхождение данных</h2><pre>${escape(JSON.stringify(plan,null,2))}</pre></html>`;
  const blob=zipFiles({'calculation.json':JSON.stringify(plan,null,2),'sources.json':JSON.stringify(plan.sources,null,2),'report.html':report});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`eva-${plan.request.start.slice(0,10)}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
