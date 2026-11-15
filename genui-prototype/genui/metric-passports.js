(()=>{
'use strict';
const finite=Number.isFinite;
const labels={sends:'отправки',answers:'ответы',events:'события',stop:'стоп-листы',contactPolicy:'политика контактов'};
const policies='1003, 1011, 1016–1024';
const formulas={
 sends:'Пуш + СМС: сумма sends. Экран успеха: сумма events для SENDED.',
 answers:'Сумма answers за период по выбранным опросам.',
 responseRate:'Сумма ответов / сумма отправок того же периода × 100.',
 events:'Сумма events за период по выбранным опросам.',
 stop:'Сумма events по status_det = 1002.',
 contactPolicy:'Сумма events по status_det '+policies+'.',
 stopAndPolicy:'Сумма известных отсечений по стоп-листам и политике контактов.',
 csi:'Сумма произведений оценки и её веса / сумма весов для оценок 1–5.',
 unique_surveys:'Количество разных ID опросов в выбранном периоде.',
 plan:'Сумма известных планов опросов с поправкой на детализацию периода.',
 ratings:'Количество оценок 1–5.'
};
const fmt=value=>finite(value)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:6}).format(value):'—';
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};

function metadata(data,entry={}){
 return {source:data.source||entry.chart?.title||'Ваши CSV',revision:data.dataRevision||data.contract?.dataRevision||data.revision||entry.revision||'',
  metricVersion:data.metricVersion||data.contract?.metricVersion||'1.0',scope:{ids:data.spec?.ids||[],filters:data.spec?.filters||{}},
  sourceFiles:['date/push-sms.csv','date/success-screen.csv'].filter(file=>{const channel=entry.chart?.channel||data.spec?.filters?.channel;return !channel||file.includes(channel==='communication'?'push-sms':'success-screen');})};
}

function point(data,series,index,source){
 const period=data.months[index],value=series.values[index]??null,share=series.ratio||series.sendRatio;
 const oldIndex=source?.months?.indexOf(period)??-1;
 const old=source?.blocks?.find(block=>block.metric===series.metric&&block.id===series.id);
 const original=oldIndex>=0&&old?old.values[oldIndex]??null:value;
 const originalShare=oldIndex>=0&&old?(old.ratio||old.sendRatio)?.values?.[oldIndex]??null:share?.values?.[index]??null;
 const originalBase=oldIndex>=0&&old?(old.ratio||old.sendRatio)?.baseValues?.[oldIndex]??null:share?.baseValues?.[index]??null;
 const edit=(data.manualEdits||[]).find(item=>item.period===period&&item.metric===series.metric);
 const contributors=(data.manualEdits||[]).filter(item=>item.period===period&&[share?.baseMetric,series.metric==='stopAndPolicy'?'stop':'',series.metric==='stopAndPolicy'?'contactPolicy':''].includes(item.metric));
 const allocation=(data.statusAllocations||[]).filter(item=>item.month===period&&item.bucket===series.metric);
 const csi={...data.periods?.[index],...series.proofs?.[index]};
 const base=share?.baseValues?.[index]??null;
 const changed=value!==original||base!==originalBase||Boolean(edit)||allocation.length>0;
 const ratioValue=share?.values?.[index]??null;
 return {period,value,formula:(formulas[series.metric]||series.label)+(share?' Доля = показатель / '+(labels[share.baseMetric]||share.baseMetric)+' × 100.':''),original,originalShare,originalBase,
  ratio:ratioValue,numerator:share?value:['csi','responseRate'].includes(series.metric)?(csi.csiNumerator??csi.numerator??null):null,
  denominator:share?base:['csi','responseRate'].includes(series.metric)?(csi.csiDenominator??csi.denominator??null):null,
  baseMetric:share?.baseMetric||'',changed,author:[...new Set([edit?.actor,...contributors.map(item=>item.actor),...allocation.map(item=>item.actor)].filter(Boolean))].join(', '),
  editedAt:edit?.at||contributors.find(item=>item.at)?.at||allocation.find(item=>item.at)?.at||'',
  coverage:series.coverage?.[index]?.status||'',window:csi.start&&csi.end?csi.start+' — '+csi.end:period};
}

function graphSeries(entry,data){
 const original=entry.source?.data;
 if(data.days){
  return Object.fromEntries(['csi','ratings'].map(metric=>[metric,data.days.map(day=>{
   const before=original?.days?.find(item=>item.date===day.date)||day;
   const value=metric==='csi'?day.csi:day.hasRows?day.count:null,old=metric==='csi'?before.csi:before.hasRows?before.count:null;
   const edits=(data.manualEdits||[]).filter(item=>item.period===day.date);
   return {period:day.date,window:day.date,value,original:old,formula:formulas[metric],
    numerator:metric==='csi'&&day.count?day.ratings.reduce((sum,rating)=>sum+rating.count*rating.score,0):null,
    denominator:metric==='csi'&&day.hasRows?day.count:null,changed:value!==old||edits.length>0,
    author:[...new Set(edits.map(item=>item.actor).filter(Boolean))].join(', '),editedAt:edits.find(item=>item.at)?.at||''};
  })]));
 }
 return Object.fromEntries(data.blocks.map(block=>[block.metric+':'+block.id,data.months.map((_,i)=>point(data,block,i,original))]));
}

function showPoint(host,proof,context){
 host.replaceChildren();
 const list=el('dl');
 const add=(name,value)=>{list.append(el('dt',name),el('dd',value||'—'));};
 add('Период',proof.window);add('Значение',fmt(proof.value));add('Формула',proof.formula);
 if(proof.baseMetric||finite(proof.denominator)){
  add('Числитель',fmt(proof.numerator));add('Знаменатель',fmt(proof.denominator)+(proof.baseMetric?' · '+(labels[proof.baseMetric]||proof.baseMetric):''));
  if(proof.baseMetric)add('Доля',finite(proof.ratio)?fmt(proof.ratio)+'%':'Нет вычислимой базы или значения');
 }
 add('Источник',context.source);add('Версия данных',context.revision);add('Версия формул',context.metricVersion);
 add('Отбор',JSON.stringify(context.scope));
 if(proof.changed){add('Исходное значение',fmt(proof.original));if(proof.baseMetric)add('Исходная доля и база',fmt(proof.originalShare)+'% · '+fmt(proof.originalBase));add('Автор правки',proof.author||'Не указан');if(proof.editedAt)add('Время правки',new Date(proof.editedAt).toLocaleString('ru-RU'));}
 host.append(list);
}

function attach(host,getEntry){
 const details=el('details');details.className='method metric-passport';
 const metric=el('select'),period=el('select'),output=el('div');
 metric.setAttribute('aria-label','Показатель паспорта');period.setAttribute('aria-label','Период паспорта');
 details.append(el('summary','Паспорт цифры'),metric,period,output);host.append(details);
 let wanted,wantedMetric;
 function draw(){
  if(!details.open)return;
  const entry=getEntry(),data=entry.chart.data,key=metric.value,date=period.value;
  const rows=graphSeries(entry,data);
  const names=data.days?['csi','ratings'].map(key=>[key,key==='csi'?'CSI':'Количество оценок']):data.blocks.map(b=>[b.metric+':'+b.id,b.label+(b.id===null?'':' · #'+b.id)]);
  metric.replaceChildren(...names.map(([key,name])=>new Option(name,key)));
  if(rows[wantedMetric||key])metric.value=wantedMetric||key;wantedMetric=null;
  const points=rows[metric.value]||[];
  period.replaceChildren(...points.map(item=>new Option(item.period,item.period)));
  const preferred=wanted||date||points.findLast(item=>finite(item.value))?.period;
  if(points.some(item=>item.period===preferred))period.value=preferred;
  const proof=points.find(item=>item.period===period.value);
  if(proof)showPoint(output,proof,metadata(data,entry));else output.replaceChildren(el('p','Нет точек в текущем отборе.'));
 }
 metric.onchange=draw;period.onchange=()=>{wanted=period.value;draw();};details.ontoggle=draw;
 return {select(date){wanted=date;draw();},open(date,key){wanted=date;wantedMetric=key;details.open=true;draw();details.scrollIntoView({block:'nearest'});},refresh:draw};
}
window.MetricPassports={metadata,graphSeries,attach,showPoint};
})();
