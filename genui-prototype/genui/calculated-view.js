/* Trusted view of locally calculated facts. Does not run model-generated code. */
(()=>{'use strict';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;},format=v=>Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumFractionDigits:2}):'нет данных';
function render(host,data){
 const d=data.dataset,pick=el('select'),plot=el('div',undefined,'calculated-plot'),summary=el('div',undefined,'kpis'),tableHost=el('div',undefined,'table-wrap');let charts=[];
 host.append(el('p','Стандартный дашборд','eyebrow'),el('h2',d.title),el('p',d.period+' · версия '+data.dataRevision,'creative-source'));
 if(d.answersTarget)host.append(el('p','План из запроса: '+format(d.answersTarget.value)+' ответов на календарный день. Отклонение = факт − план. Справочник не изменён.'));
 
 if(data.stale)host.append(el('p','CSV уже обновились. Здесь сохранён расчёт по указанной версии.','error'));
 const label=el('label','Опрос ');pick.setAttribute('aria-label','Опрос в рассчитанных данных');for(const s of d.surveys)pick.add(new Option('#'+s.id+' · '+s.name+' · '+(s.channel==='communication'?'Пуш + СМС':'Экран успеха'),s.key));label.append(pick);host.append(label,summary,plot,tableHost);
 function draw(){for(const chart of charts)chart.destroy();charts=[];summary.replaceChildren();plot.replaceChildren();tableHost.replaceChildren();const s=d.surveys.find(x=>x.key===pick.value);if(!s)return;const metrics=Object.keys(d.labels),series=d.series.filter(x=>x.key===s.key),facts=data.facts;
  for(const metric of metrics){const f=facts[s.refs[metric]],card=el('article',undefined,'kpi');card.append(el('span',d.labels[metric]),el('strong',format(f?.actual)),el('small',f?.note||'За выбранный период'));summary.append(card);}
  const shown=d.answersTarget?['answers','planExpected']:metrics,dates=[...new Set(series.flatMap(x=>x.points.map(p=>p[0])))].sort(),lookup=new Map(series.map(x=>[x.metric,new Map(x.points)])),value=(metric,date)=>facts[lookup.get(metric)?.get(date)]?.actual??null;
  if(dates.length){
   const percent=['replyRatio','planCompletion'];
   const groups=[shown.filter(m=>!percent.includes(m)),...shown.filter(m=>percent.includes(m)).map(m=>[m])];
   for(const group of groups.filter(g=>g.some(metric=>dates.some(date=>Number.isFinite(value(metric,date)))))){
    const key=m=>percent.includes(m)?'responseRate:'+m:m;
    charts.push(window.V2Chart(plot,{title:d.answersTarget&&group.length>1?'Ответы и план из запроса':group.map(m=>d.labels[m]).join(' · '),
     badge:'Динамика',context:d.period,keepMissingPeriods:true,noAppearanceControls:true,
     modes:[{key:'period',label:dates[0].length===10?'По дням':'По месяцам',rows:dates.map(date=>({key:date,label:date,short:date.length===10?date.slice(8)+'.'+date.slice(5,7):date,...Object.fromEntries(group.map(m=>[key(m),value(m,date)]))}))}],
     series:group.map((m,i)=>({key:key(m),label:d.labels[m],color:['#ff8a35','#c3c8d0','#8da9c4','#d5b278'][i],dash:m==='csi'?'6 4':null,total:dates.length?value(m,dates.at(-1)):null})),
     receipt:[['Источник','Локальные CSV · версия '+data.dataRevision],['Пропуски','Отсутствующие значения остаются пропусками.']]}));
   }
  }
  const table=el('table'),head=el('thead'),body=el('tbody'),tr=el('tr');for(const text of ['Период',...metrics.map(m=>d.labels[m])])tr.append(el('th',text));head.append(tr);table.append(head,body);for(const date of dates.length?dates:[d.period]){const row=el('tr');row.append(el('td',date));for(const metric of metrics)row.append(el('td',format(dates.length?value(metric,date):facts[s.refs[metric]]?.actual)));body.append(row);}tableHost.append(table);
 }
 pick.onchange=draw;draw();
}
window.CalculatedView={render,async open(jobId){
 const data=await window.TrustUI.post('/api/creative',{action:'calculated',jobId});
 return new Promise(resolve=>{
  const dialog=el('dialog',undefined,'creative-dialog calculated-dialog');
  const close=el('button','Закрыть расчёт');close.type='button';close.onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{dialog.querySelectorAll('.v2-chart').forEach(chart=>chart.destroy());dialog.remove();resolve();},{once:true});
  document.body.append(dialog);dialog.showModal();render(dialog,data);dialog.append(close);
 });
}};
})();
