/* Воронка опроса: события → группы отсечений из справочника статусов → отправки → ответы → отклик.
   Шаги, названия, цвета и порядок отсечений задаёт «Администрирование → Статусы».
   Все числа считает сервер (/api/pulse, action=funnel) по дневным строкам выгрузки. */
(()=>{'use strict';
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),df=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}),df2=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n;};
const ns='http://www.w3.org/2000/svg',svg=(tag,attrs={},text)=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
const finite=Number.isFinite;
const compact=v=>!finite(v)?'—':Math.abs(v)>=1e6?df.format(v/1e6)+' млн':Math.abs(v)>=1e4?df.format(v/1e3)+' тыс.':nf.format(v);
const pct=v=>!finite(v)?'—':(v>0&&v<.1?df2:df).format(v)+'%';
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
 let result=null,period='all',focus=null,loaded=false;
 const head=el('div','funnel-head'),title=el('h3','','Воронка'),sub=el('p','funnel-sub'),controls=el('div','funnel-controls');
 const periodSelect=el('select');periodSelect.setAttribute('aria-label','Период воронки');
 const status=el('p','funnel-status');status.setAttribute('role','status');
 const kpis=el('div','funnel-kpis'),diagram=el('div','funnel-diagram'),drill=el('div','funnel-drill'),details=el('div','funnel-details');
 const label=el('label','funnel-period');label.append(document.createTextNode('Период '),periodSelect);
 const admin=el('a','funnel-admin','Группы статусов ↗');admin.href='#admin-statuses';admin.title='Названия, порядок и состав шагов задаются в «Администрирование → Статусы»';
 controls.append(label,admin);head.append(title,sub,controls);box.append(head,status,kpis,diagram,drill,details);
 periodSelect.onchange=()=>{period=periodSelect.value;draw();};
 async function load(){
  status.textContent='Считаем воронку по дневным строкам…';status.classList.remove('is-error');
  try{result=await post({action:'funnel',...params});status.textContent='';loaded=true;
   const cut=v=>v.slice(0,params.grain==='month'?7:10);
   periodSelect.replaceChildren(new Option('Весь период · '+monthName(cut(result.from))+' — '+monthName(cut(result.to)),'all'),...result.periods.map(p=>new Option(monthName(p.key),p.key)));periodSelect.value=period;
   title.textContent='Воронка · '+result.channelLabel;sub.textContent=(params.ids?.length===1?'Опрос #'+params.ids[0]:result.surveyCount+' опрос(ов)')+' · события → '+(result.lossGroups.some(g=>result.total.groups[g.slug]?.events)?result.lossGroups.filter(g=>result.total.groups[g.slug]?.events).map(g=>g.name.toLowerCase()).join(' → ')+' → ':'')+'отправки → ответы → отклик';
   focus=focus||(result.lossGroups.length?'g:'+[...result.lossGroups].sort((a,b)=>(result.total.groups[b.slug]?.events||0)-(result.total.groups[a.slug]?.events||0))[0].slug:null);
   if(result.unknownCodes?.length)status.textContent='В выгрузке есть коды, которых нет в справочнике: '+result.unknownCodes.slice(0,6).map(c=>c.code).join(', ')+'. Они посчитаны в «Без группы», добавьте их в «Администрирование → Статусы».';
   draw();}
  catch(error){status.textContent=error.message;status.classList.add('is-error');}
 }
 const current=()=>period==='all'?result.total:result.periods.find(p=>p.key===period)||result.total;
 function steps(d){
  const list=[{key:'events',label:'События',value:d.events,share:100,hint:'Все события опроса за период, 100%.'}];
  for(const g of result.lossGroups){const v=d.groups[g.slug];if(!(result.total.groups[g.slug]?.events))continue;list.push({key:'g:'+g.slug,slug:g.slug,label:g.name,color:g.color,loss:true,value:v?.events||0,share:v?.share,hint:(g.description||g.name)+'. Доля от событий. Нажмите, чтобы увидеть коды группы.'});}
  if((result.total.unexplained||0)>0)list.push({key:'unexplained',label:'Прочие статусы',loss:true,value:d.unexplained,share:d.unexplainedShare,hint:'Не отправлено, но статус не попал в группы отсечений (например, группа с ролью «не участвует»).'});
  list.push({key:'sends',label:'Отправки',value:d.sends,share:d.sendShare,hint:'Дошло до клиента. Доля от событий.'},{key:'answers',label:'Ответы',value:d.answers,share:d.answerShare,hint:'Ответы на опрос. Доля от событий, отклик считается от отправок.'});
  return list;
 }
 function draw(){
  const d=current();kpis.replaceChildren();
  for(const [name,value,note] of [['События',compact(d.events),'100%'],['Отправки',compact(d.sends),pct(d.sendShare)+' событий'],['Ответы',compact(d.answers),pct(d.answerShare)+' событий'],['Отклик',pct(d.response),'ответы / отправки']]){const k=el('div','funnel-kpi');k.append(el('span','',name),el('b','',value),el('small','',note));kpis.append(k);}
  drawDiagram(d);drawDrill(d);drawDetails();
 }
 function drawDiagram(d){
  diagram.replaceChildren();
  const list=steps(d),W=1000,rowH=52,H=list.length*rowH+12,maxW=480,mid=180+maxW/2;
  const root=svg('svg',{viewBox:'0 0 '+W+' '+(H+16),class:'funnel-svg',role:'img','aria-label':'Воронка: '+list.map(s=>s.label+' '+compact(s.value)).join(', ')});
  let remaining=d.events||0;
  list.forEach((step,i)=>{
   const y=6+i*rowH,g=svg('g',{class:'funnel-step'+(step.loss?' is-loss':'')+(focus===step.key?' is-focus':''),tabindex:'0',role:'button','aria-label':step.label+': '+compact(step.value)+', '+pct(step.share)});
   g.append(svg('title',{},step.hint));
   if(step.loss){
    const before=remaining,after=Math.max(0,remaining-(step.value||0)),wb=d.events?Math.max(4,before/d.events*maxW):4,wa=d.events?Math.max(4,after/d.events*maxW):4;
    g.append(svg('path',{d:'M'+(mid-wb/2)+' '+y+' L'+(mid+wb/2)+' '+y+' L'+(mid+wa/2)+' '+(y+rowH-12)+' L'+(mid-wa/2)+' '+(y+rowH-12)+' Z',class:'funnel-neck'}));
    const lossW=d.events?Math.max(3,(step.value||0)/d.events*maxW):3,bar=svg('rect',{x:mid+maxW/2+24,y:y+8,width:Math.min(lossW,W-(mid+maxW/2+24)-10),height:14,rx:4,class:'funnel-loss-bar'});if(step.color)bar.style.fill=step.color;g.append(bar);
    const t=svg('text',{x:mid+maxW/2+24,y:y+40,class:'funnel-loss-label'},'− '+step.label+' · '+compact(step.value)+' · '+pct(step.share));if(step.color)t.style.fill=step.color;g.append(t);
    remaining=after;
   }else{
    const width=d.events?Math.max(4,(step.value||0)/d.events*maxW):4;
    g.append(svg('rect',{x:mid-width/2,y,width,height:rowH-12,rx:6,class:'funnel-bar funnel-'+step.key}));
    g.append(svg('text',{x:mid-maxW/2-16,y:y+18,'text-anchor':'end',class:'funnel-name'},step.label));
    g.append(svg('text',{x:mid-maxW/2-16,y:y+36,'text-anchor':'end',class:'funnel-value'},compact(step.value)+' · '+pct(step.share)));
    if(step.key==='sends')remaining=step.value||0;
   }
   const pick=()=>{focus=step.key;draw();if(step.slug)drill.scrollIntoView({block:'nearest',behavior:'smooth'});};g.onclick=pick;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}};
   root.append(g);
  });
  root.append(svg('text',{x:mid,y:H+8,'text-anchor':'middle',class:'funnel-response'},'Отклик: '+pct(d.response)+' = ответы '+compact(d.answers)+' / отправки '+compact(d.sends)));
  const empty=result.lossGroups.filter(g=>!result.total.groups[g.slug]?.events).map(g=>g.name);diagram.append(root,...(empty.length?[el('p','funnel-hint','Без событий за период: '+empty.join(', ')+'.')]:[]));
 }
 function drawDrill(d){
  drill.replaceChildren();const group=focus?.startsWith('g:')?result.lossGroups.find(g=>'g:'+g.slug===focus):null;if(!group||!result.drillDown)return;
  const own=new Set(group.codes.map(String)),rows=Object.entries(d.codes||{}).filter(([code])=>group.slug==='ungrouped'?(own.has(code)||!result.codeLabels[code]||result.codeLabels[code].group==='ungrouped'||!result.lossGroups.some(g=>g.slug===result.codeLabels[code].group)):own.has(code)).sort((a,b)=>b[1].events-a[1].events);
  const card=el('div','funnel-drill-card');card.style.setProperty('--group-color',group.color);
  card.append(el('h4','',group.name+' · коды status_det'),el('p','funnel-hint',(group.description||'')+' · '+(period==='all'?'весь период':monthName(period))));
  if(!rows.length){card.append(el('p','funnel-hint','За период событий по кодам этой группы нет.'));drill.append(card);return;}
  const total=rows.reduce((s,[,v])=>s+v.events,0),list=el('ul','funnel-codes');
  for(const [code,v] of rows){const info=result.codeLabels[code],li=el('li');li.title=info?.description||'Кода нет в справочнике статусов';const bar=el('i');bar.style.width=Math.max(2,v.events/total*100)+'%';li.append(el('code','',code),el('span','',info?.label||'Нет в справочнике'),el('b','',compact(v.events)),el('small','',pct(v.share)+' событий'),bar);list.append(li);}
  card.append(list);drill.append(card);
 }
 function columns(){return [...result.lossGroups.filter(g=>result.total.groups[g.slug]?.events).map(g=>({key:'g:'+g.slug,label:g.name,get:r=>r.groups?.[g.slug]})),...((result.total.unexplained||0)>0?[{key:'unexplained',label:'Прочие статусы',get:r=>({events:r.unexplained,share:r.unexplainedShare})}]:[])];}
 function cells(r){const c=(v,s)=>compact(v)+(finite(s)?' · '+pct(s):'');return [compact(r.events),...columns().map(col=>{const v=col.get(r);return c(v?.events,v?.share);}),c(r.sends,r.sendShare),c(r.answers,r.answerShare),pct(r.response)];}
 function headers(first){return [first,'События',...columns().map(c=>c.label),'Отправки','Ответы','Отклик'];}
 function focusIndex(){const i=columns().findIndex(c=>c.key===focus);return i<0?-1:i+2;}
 function table(head,rows,{onRow,selected}={}){const t=el('table','funnel-table'),tr=el('tr'),fi=focusIndex();head.forEach((h,i)=>{const th=el('th','',h);th.scope='col';if(i===fi)th.classList.add('is-focus');tr.append(th);});t.append(tr);for(const row of rows){const r=el('tr');if(row.key===selected)r.classList.add('is-selected');row.cells.forEach((v,i)=>{const td=el(i?'td':'th','',v);if(!i)td.scope='row';if(i===fi)td.classList.add('is-focus');r.append(td);});if(onRow){r.tabIndex=0;r.onclick=()=>onRow(row);r.onkeydown=e=>{if(e.key==='Enter')onRow(row);};}t.append(r);}return t;}
 function copyButton(getHead,getRows){const b=el('button','funnel-copy','Копировать таблицу');b.type='button';b.onclick=async()=>{const head=getHead(),rows=getRows().map(r=>r.cells),html='<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:Arial;font-size:11pt"><tr>'+head.map(h=>'<th style="background:#eeeeee">'+esc(h)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+r.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</table>',tsv=[head,...rows].map(r=>r.join('\t')).join('\n');try{if(window.ClipboardItem)await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([tsv],{type:'text/plain'})})]);else await navigator.clipboard.writeText(tsv);b.textContent='Скопировано';}catch{b.textContent='Не удалось скопировать';}setTimeout(()=>{b.textContent='Копировать таблицу';},2000);};return b;}
 function drawDetails(){
  details.replaceChildren();
  const periodRows=()=>[{key:'all',cells:['Весь период',...cells(result.total)]},...result.periods.map(p=>({key:p.key,cells:[monthName(p.key),...cells(p)]}))];
  const sec=el('div','funnel-section'),bar=el('div','funnel-section-head');bar.append(el('h4','','По периодам'),copyButton(()=>headers('Период'),periodRows));
  sec.append(bar,table(headers('Период'),periodRows(),{selected:period,onRow:row=>{period=row.key;periodSelect.value=row.key;draw();}}));details.append(sec);
  if(result.surveys.length>1){
   const col=columns().find(c=>c.key===focus),value=r=>col?col.get(r)?.share??-1:focus==='sends'?r.sendShare??-1:focus==='answers'?r.answerShare??-1:r.events,sorted=[...result.surveys].sort((a,b)=>value(b)-value(a));
   const rows=()=>sorted.map(s=>({key:s.id,cells:['#'+s.id+' · '+s.name,...cells(s)]}));
   const sec2=el('div','funnel-section'),bar2=el('div','funnel-section-head');bar2.append(el('h4','','По опросам · сортировка: '+(col?.label||({sends:'отправки',answers:'ответы'})[focus]||'события')+(result.surveyCount>result.surveys.length?' · топ-'+result.surveys.length+' по событиям из '+result.surveyCount:'')),copyButton(()=>headers('Опрос'),rows));
   sec2.append(bar2,table(headers('Опрос'),rows()));details.append(sec2);
  }
  const method=el('details','funnel-method');method.append(el('summary','','Как рассчитано'),el('p','',result.method+' Версия справочника статусов: '+result.statusRevision+'.'));details.append(method);
 }
 return {show(){box.hidden=false;if(!loaded)load();},hide(){box.hidden=true;},reload(){loaded=false;load();},element:box};
}
window.GenuiFunnel={attach,paramsOf};
})();
