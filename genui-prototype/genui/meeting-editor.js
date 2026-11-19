(()=>{'use strict';
const clone=value=>structuredClone(value),nf=new Intl.NumberFormat('ru-RU'),el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const sum=values=>{const known=values.filter(Number.isFinite);if(!known.length)return null;const total=known.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(total))throw new Error('Сумма слишком велика для точного расчёта. Уменьшите значения.');return total;};
const ratio=(value,base)=>Number.isFinite(value)&&Number.isFinite(base)&&base>0?value/base*100:null;
function recalculate(chart){
 const data=chart.data;
 if(chart.kind==='daily-csi'){
  for(const day of data.days){const total=sum(day.ratings.map(r=>r.count))??0;day.count=total;day.csi=total?day.ratings.reduce((n,r)=>n+r.score*(r.count/total),0):null;for(const r of day.ratings)r.percent=ratio(r.count,total);}
  return chart;
 }
 const blocks=new Map(data.blocks.map(b=>[b.metric,b])),stop=blocks.get('stop'),policy=blocks.get('contactPolicy'),combined=blocks.get('stopAndPolicy');
 if(combined){combined.values=data.months.map((_,i)=>sum([stop?.values[i],policy?.values[i]]));combined.coverage=data.months.map((_,i)=>({status:[stop?.coverage?.[i]?.status,policy?.coverage?.[i]?.status].includes('manual')?'manual':stop?.coverage?.[i]?.status==='all_observed'&&policy?.coverage?.[i]?.status==='all_observed'?'all_observed':combined.values[i]===null?'no_status':'some_observed'}));}
 data.totals=[];data.table=[];
 for(const b of data.blocks){
  const baseMetric=b.metric==='answers'&&chart.kind!=='events-breakdown'?'sends':'events',baseValues=blocks.get(baseMetric).values,value=sum(b.values),base=sum(baseValues),complete=b.values.every((v,i)=>baseValues[i]===null||v!==null);
  b.ratio={baseMetric,baseValues:[...baseValues],values:b.values.map((v,i)=>ratio(v,baseValues[i])),totalBase:base,total:complete?ratio(value,base):null,method:b.ratio?.method||''};
  if(chart.channel==='communication'&&['stop','contactPolicy','stopAndPolicy'].includes(b.metric))b.available=b.values.some(Number.isFinite);
  data.totals.push({...b,value,note:'За 2026 год'});
  data.table.push(...data.months.map((month,i)=>({id:b.id,name:b.name,month,metric:b.label,value:b.values[i],sendRatio:b.ratio.values[i],ratioBase:baseValues[i],ratioBaseMetric:baseMetric})));
 }
 return chart;
}
function attach(host,source,{current=source,onChange,onState}={}){
 const original=clone(source);let chart=clone(current),dirty=Boolean(chart.data.uiEdited);
 const details=el('details'),summary=el('summary','Изменить значения'),status=el('p'),reset=el('button','Сбросить правки'),help=el('p',source.kind==='daily-csi'?'Меняйте количества оценок 1–5: CSI, «Всего» и проценты пересчитываются автоматически. Пустая ячейка означает 0 при наличии других оценок дня.':'Меняйте количества за месяц: проценты, годовые итоги и сумма отсечений пересчитываются автоматически. Пустая ячейка: неизвестное значение; 0: известный ноль.'),wrap=el('div'),table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody'),error=el('p');
 details.className='meeting-editor';wrap.className='meeting-editor-scroll';status.className='meeting-edit-status';status.setAttribute('role','status');error.className='error';error.setAttribute('role','alert');error.hidden=true;reset.type='button';
 const actorLabel=el('label','Автор ручных правок'),actor=el('input');actor.type='text';actor.maxLength=120;actor.value=chart.data.editActor||'';actor.setAttribute('aria-label','Автор ручных правок');actorLabel.append(actor);
 const daily=source.kind==='daily-csi',fields=daily?[1,2,3,4,5].map(n=>({key:'score:'+n,label:'Оценка '+n})):source.data.blocks.filter(b=>b.metric!=='stopAndPolicy'&&(source.channel==='communication'||!['stop','contactPolicy'].includes(b.metric))).map(b=>({key:b.metric,label:b.label})),dates=daily?source.data.days.map(d=>d.date):source.data.months,inputs=[];
 header.append(el('th',daily?'День':'Месяц'));for(const field of fields)header.append(el('th',field.label));head.append(header);table.append(head,body);
 function valueAt(value,index,key){if(daily){const day=value.data.days[index];return day.hasRows?day.ratings[Number(key.slice(6))-1].count:null;}return value.data.blocks.find(b=>b.metric===key).values[index];}
 dates.forEach((date,index)=>{const row=el('tr');row.append(el('th',date));for(const field of fields){const cell=el('td'),input=el('input');input.type='number';input.min='0';input.max=String(Number.MAX_SAFE_INTEGER);input.step='1';input.inputMode='numeric';input.value=valueAt(chart,index,field.key)??'';input.dataset.editDate=date;input.dataset.editMetric=field.key;input.setAttribute('aria-label',source.title+' · '+date+' · '+field.label);cell.append(input);row.append(cell);inputs.push({input,index,key:field.key});input.addEventListener('input',update);}body.append(row);});
 function sync(){status.textContent=dirty?'Ручные правки · только этот график · CSV и база не изменены':'Значения из источника. Правки хранятся только в текущей вкладке.';status.classList.toggle('is-edited',dirty);reset.disabled=!dirty&&!inputs.some(({input})=>input.getAttribute('aria-invalid')==='true');}
 function update(){
  const next=clone(original);let invalid=false;
  for(const {input,index,key}of inputs){const value=input.value===''?null:input.valueAsNumber,valid=!input.validity.badInput&&(value===null||Number.isSafeInteger(value)&&value>=0);input.setAttribute('aria-invalid',String(!valid));if(!valid){invalid=true;continue;}
   if(daily)next.data.days[index].ratings[Number(key.slice(6))-1].count=value??0;else{const block=next.data.blocks.find(b=>b.metric===key);block.values[index]=value;if(block.coverage&&value!==valueAt(original,index,key))block.coverage[index]={...block.coverage[index],status:'manual'};}
  }
  if(invalid){error.textContent='Введите целое неотрицательное число. График сохраняет последние корректные значения.';error.hidden=false;sync();return;}
  if(daily)next.data.days.forEach((day,index)=>{day.hasRows=original.data.days[index].hasRows||inputs.some(item=>item.index===index&&item.input.value!=='');});
  try{recalculate(next);}catch(e){error.textContent=e.message;error.hidden=false;reset.disabled=false;return;}
  next.data.editActor=actor.value.trim();
  const previous=new Map((chart.data.manualEdits||[]).map(edit=>[edit.period+':'+edit.metric,edit]));
  next.data.manualEdits=inputs.flatMap(({input,index,key})=>{const value=input.value===''?null:input.valueAsNumber,before=valueAt(original,index,key);if(value===before)return [];const period=dates[index],saved=previous.get(period+':'+key);return [saved?.value===value&&saved.actor?saved:{period,metric:key,original:before,value,actor:next.data.editActor,at:new Date().toISOString()}];});
  dirty=Boolean(next.data.manualEdits.length);next.data.uiEdited=dirty;next.data.source=dirty?'Ручные правки в UI · '+(original.data.source||'Ваши CSV'):original.data.source;chart=next;error.hidden=true;sync();onState?.(clone(chart));onChange?.(clone(chart));
 }
 reset.onclick=()=>{chart=clone(original);dirty=false;for(const item of inputs){item.input.value=valueAt(chart,item.index,item.key)??'';item.input.removeAttribute('aria-invalid');}error.hidden=true;sync();onState?.(clone(chart));onChange?.(clone(chart));};
 actor.onchange=update;
 if(source.data.statusComposition)help.textContent+=' Здесь базовые количества до ручного распределения статусов; добавленные остатки видны на графике.';wrap.append(table);details.append(summary,actorLabel,help,el('p','Изменения сразу видны на графике и в PNG. Они не меняют другие графики. «Обновить из date» или перезагрузка страницы удаляют правки.'),wrap,error,reset);host.append(status,details);sync();return clone(chart);
}
window.MeetingEdits={attach,recalculate};
})();
