/* Воронка опроса: события → политика контактов → стоп-листы → отправки → ответы → отклик.
   Все числа считает сервер (/api/pulse, action=funnel) по дневным строкам выгрузки. */
(()=>{'use strict';
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),df=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}),df2=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n;};
const ns='http://www.w3.org/2000/svg',svg=(tag,attrs={},text)=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
const finite=Number.isFinite;
const compact=v=>!finite(v)?'—':Math.abs(v)>=1e6?df.format(v/1e6)+' млн':Math.abs(v)>=1e4?df.format(v/1e3)+' тыс.':nf.format(v);
const pct=v=>!finite(v)?'—':(v>0&&v<.1?df2:df).format(v)+'%';
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const STEPS=[
 {key:'events',label:'События',share:null,hint:'Все события опроса за период — вершина воронки, 100%.'},
 {key:'contactPolicy',label:'Политика контактов',share:'policyShare',loss:true,hint:'Не отправлено из-за политики контактов. Доля от событий.'},
 {key:'stop',label:'Стоп-листы',share:'stopShare',loss:true,hint:'Отсечено стоп-листом 1002. Доля от событий.'},
 {key:'other',label:'Прочие статусы',share:'otherShare',loss:true,hint:'События, не отправленные по другим статусам выгрузки. Доля от событий.'},
 {key:'sends',label:'Отправки',share:'sendShare',hint:'Дошло до клиента. Доля от событий.'},
 {key:'answers',label:'Ответы',share:'answerShare',hint:'Ответы на опрос. Доля от событий; отклик — от отправок.'},
];
const monthName=key=>key.length===7?new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(key+'-01T12:00:00Z')):new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(key+'T12:00:00Z'));
async function post(body){const r=await fetch('/api/pulse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d;try{d=await r.json();}catch{throw new Error('Сервер вернул неожиданный ответ.');}if(!r.ok||d.error)throw new Error(d.error||'Ошибка запроса');return d;}

function paramsOf(data){
 const spec=data.spec||{},months=data.months||[];if(!months.length)return null;
 const members=data.members||[],ids=(spec.ids||[]).length?spec.ids:members.length?members.map(m=>m.id):null;
 const channel=spec.filters?.channel||members[0]?.channel||'communication';
 return {channel:channel==='success_screen'?'success_screen':'communication',ids,product:ids?null:(spec.filters?.product||null),grain:spec.grain==='week'?'week':spec.grain==='day'?'day':'month',start:months[0],end:months.at(-1)};
}

function attach(host,data){
 const params=paramsOf(data);if(!params)return null;
 const box=el('section','funnel');box.hidden=true;host.append(box);
 let result=null,period='all',focus='stop',loaded=false;
 const head=el('div','funnel-head'),title=el('h3','','Воронка'),sub=el('p','funnel-sub'),controls=el('div','funnel-controls');
 const periodSelect=el('select');periodSelect.setAttribute('aria-label','Период воронки');
 const status=el('p','funnel-status');status.setAttribute('role','status');
 const kpis=el('div','funnel-kpis'),diagram=el('div','funnel-diagram'),details=el('div','funnel-details');
 const label=el('label','funnel-period');label.append(document.createTextNode('Период '),periodSelect);controls.append(label);
 head.append(title,sub,controls);box.append(head,status,kpis,diagram,details);
 periodSelect.onchange=()=>{period=periodSelect.value;draw();};
 async function load(){
  status.textContent='Считаем воронку по дневным строкам…';
  try{result=await post({action:'funnel',...params});status.textContent='';loaded=true;
   periodSelect.replaceChildren(new Option('Весь период · '+monthName(result.from.slice(0,params.grain==='month'?7:10))+' — '+monthName(result.to.slice(0,params.grain==='month'?7:10)),'all'),...result.periods.map(p=>new Option(monthName(p.key),p.key)));
   title.textContent='Воронка · '+result.channelLabel;sub.textContent=(params.ids?.length===1?'Опрос #'+params.ids[0]:result.surveyCount+' опрос(ов)')+' · '+(result.cutoffs?'события → политика контактов → стоп-листы → отправки → ответы → отклик':'события → отправки → ответы → отклик');draw();}
  catch(error){status.textContent=error.message;status.classList.add('is-error');}
 }
 const current=()=>period==='all'?result.total:result.periods.find(p=>p.key===period)||result.total;
 const steps=()=>STEPS.filter(s=>result.cutoffs||!['contactPolicy','stop'].includes(s.key)).filter(s=>s.key!=='other'||(result.total.other||0)>0);
 function draw(){
  const d=current();kpis.replaceChildren();
  for(const [name,value,note] of [['События',compact(d.events),'100% · вершина воронки'],['Отправки',compact(d.sends),pct(d.sendShare)+' событий'],['Ответы',compact(d.answers),pct(d.answerShare)+' событий'],['Отклик',pct(d.response),'ответы / отправки']]){const k=el('div','funnel-kpi');k.append(el('span','',name),el('b','',value),el('small','',note));kpis.append(k);}
  drawDiagram(d);drawDetails();
 }
 function drawDiagram(d){
  diagram.replaceChildren();
  const list=steps(),W=1000,rowH=58,H=list.length*rowH+12,maxW=480,mid=180+maxW/2;
  const root=svg('svg',{viewBox:'0 0 '+W+' '+H,class:'funnel-svg',role:'img','aria-label':'Воронка: '+list.map(s=>s.label+' '+compact(d[s.key])).join(', ')});
  let remaining=d.events||0;
  list.forEach((step,i)=>{
   const y=6+i*rowH,value=d[step.key],share=step.share?d[step.share]:100;
   const g=svg('g',{class:'funnel-step'+(step.loss?' is-loss':'')+(focus===step.key?' is-focus':''),tabindex:'0',role:'button','aria-label':step.label+': '+compact(value)+', '+pct(share)});
   g.append(svg('title',{},step.hint));
   if(step.loss){
    const before=remaining,after=Math.max(0,remaining-(value||0)),wb=d.events?Math.max(4,before/d.events*maxW):4,wa=d.events?Math.max(4,after/d.events*maxW):4;
    g.append(svg('path',{d:'M'+(mid-wb/2)+' '+y+' L'+(mid+wb/2)+' '+y+' L'+(mid+wa/2)+' '+(y+rowH-14)+' L'+(mid-wa/2)+' '+(y+rowH-14)+' Z',class:'funnel-neck'}));
    const lossW=d.events?Math.max(3,(value||0)/d.events*maxW):3;g.append(svg('rect',{x:mid+maxW/2+24,y:y+12,width:Math.min(lossW,W-(mid+maxW/2+24)-170),height:18,rx:4,class:'funnel-loss-bar'}));
    g.append(svg('text',{x:mid+maxW/2+24,y:y+48,class:'funnel-loss-label'},'− '+step.label+' · '+compact(value)+' · '+pct(share)));
    remaining=after;
   }else{
    const width=d.events?Math.max(4,(value||0)/d.events*maxW):4;
    g.append(svg('rect',{x:mid-width/2,y,width,height:rowH-14,rx:6,class:'funnel-bar funnel-'+step.key}));
    g.append(svg('text',{x:mid-maxW/2-16,y:y+20,'text-anchor':'end',class:'funnel-name'},step.label));
    g.append(svg('text',{x:mid-maxW/2-16,y:y+38,'text-anchor':'end',class:'funnel-value'},compact(value)+' · '+pct(share)));
    if(step.key==='sends')remaining=value||0;
   }
   const pick=()=>{focus=step.key;draw();};g.onclick=pick;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}};
   root.append(g);
  });
  const resp=svg('text',{x:mid,y:H-2,'text-anchor':'middle',class:'funnel-response'},'Отклик: '+pct(d.response)+' = ответы '+compact(d.answers)+' / отправки '+compact(d.sends));root.setAttribute('viewBox','0 0 '+W+' '+(H+16));
  root.append(resp);diagram.append(root);
  const legend=el('p','funnel-hint','Нажмите на шаг — таблицы ниже отсортируются по нему. Ширина — доля от событий; отсечения показаны справа.');diagram.append(legend);
 }
 function cells(r){const c=(v,s)=>compact(v)+(finite(s)?' · '+pct(s):'');return [compact(r.events),...(result.cutoffs?[c(r.contactPolicy,r.policyShare),c(r.stop,r.stopShare)]:[]),...((result.total.other||0)>0?[c(r.other,r.otherShare)]:[]),c(r.sends,r.sendShare),c(r.answers,r.answerShare),pct(r.response)];}
 function headers(first){return [first,'События',...(result.cutoffs?['Политика контактов','Стоп-листы']:[]),...((result.total.other||0)>0?['Прочие статусы']:[]),'Отправки','Ответы','Отклик'];}
 function table(head,rows,{onRow,selected}={}){const t=el('table','funnel-table'),tr=el('tr');head.forEach((h,i)=>{const th=el('th','',h);th.scope='col';if(i&&STEPS.find(s=>s.label===h)?.key===focus)th.classList.add('is-focus');tr.append(th);});t.append(tr);for(const row of rows){const r=el('tr');if(row.key===selected)r.classList.add('is-selected');row.cells.forEach((v,i)=>{const td=el(i?'td':'th','',v);if(!i)td.scope='row';if(i&&STEPS.find(s=>s.label===head[i])?.key===focus)td.classList.add('is-focus');r.append(td);});if(onRow){r.tabIndex=0;r.onclick=()=>onRow(row);r.onkeydown=e=>{if(e.key==='Enter')onRow(row);};}t.append(r);}return t;}
 function copyButton(getHead,getRows){const b=el('button','funnel-copy','Копировать таблицу');b.type='button';b.onclick=async()=>{const head=getHead(),rows=getRows().map(r=>r.cells),html='<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:Arial;font-size:11pt"><tr>'+head.map(h=>'<th style="background:#eeeeee">'+esc(h)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+r.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</table>',tsv=[head,...rows].map(r=>r.join('\t')).join('\n');try{if(window.ClipboardItem)await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([tsv],{type:'text/plain'})})]);else await navigator.clipboard.writeText(tsv);b.textContent='Скопировано';}catch{b.textContent='Не удалось скопировать';}setTimeout(()=>{b.textContent='Копировать таблицу';},2000);};return b;}
 function drawDetails(){
  details.replaceChildren();
  const periodRows=()=>[{key:'all',cells:['Весь период',...cells(result.total)]},...result.periods.map(p=>({key:p.key,cells:[monthName(p.key),...cells(p)]}))];
  const sec=el('div','funnel-section'),bar=el('div','funnel-section-head');bar.append(el('h4','','По периодам'),copyButton(()=>headers('Период'),periodRows));
  sec.append(bar,table(headers('Период'),periodRows(),{selected:period,onRow:row=>{period=row.key;periodSelect.value=row.key;draw();}}));details.append(sec);
  if(result.surveys.length>1){
   const step=STEPS.find(s=>s.key===focus),key=step?.share||'events',sorted=[...result.surveys].sort((a,b)=>(b[key]??-1)-(a[key]??-1));
   const rows=()=>sorted.map(s=>({key:s.id,cells:['#'+s.id+' · '+s.name,...cells(s)]}));
   const sec2=el('div','funnel-section'),bar2=el('div','funnel-section-head');bar2.append(el('h4','','По опросам · сортировка: '+(step?.label||'события')+(result.surveyCount>result.surveys.length?' · топ-'+result.surveys.length+' по событиям из '+result.surveyCount:'')),copyButton(()=>headers('Опрос'),rows));
   sec2.append(bar2,el('p','funnel-hint','Весь выбранный период. Где отсечение выше среднего — там и ищите причину.'),table(headers('Опрос'),rows()));details.append(sec2);
  }
  const method=el('details','funnel-method');method.append(el('summary','','Как рассчитано'),el('p','',result.method));details.append(method);
 }
 return {show(){box.hidden=false;if(!loaded)load();},hide(){box.hidden=true;},element:box};
}
window.GenuiFunnel={attach,paramsOf};
})();
