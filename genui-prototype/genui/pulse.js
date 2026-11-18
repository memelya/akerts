/* Пульс дня: проактивный брифинг, сдвиги уровня, похожие инциденты, «что если»,
   память расследований, черновик встречи, командная строка Ctrl+K,
   компактная навигация и загрузка CSV перетаскиванием.
   Все числа приходят из локального расчёта /api/pulse. Модель только формулирует. */
(()=>{'use strict';
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),df=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}),cf=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n;};
const ns='http://www.w3.org/2000/svg';const svg=(tag,attrs={})=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);return n;};
const fmt=(value,metric)=>value===null||value===undefined?'—':metric==='csi'?cf.format(value):metric==='responseRate'?df.format(value)+'%':nf.format(value);
const signed=(value,suffix='%')=>value===null||value===undefined?'—':(value>0?'+':'')+df.format(value)+suffix;
const dateLabel=value=>{if(!value)return '—';const d=new Date(value.slice(0,10)+'T12:00:00Z');return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'}).format(d);};
const change=item=>item.relative!==null&&item.relative!==undefined?signed(item.relative):signed(item.delta,' балла');
const pctChange=(a,b)=>a&&b!==null&&b!==undefined?signed((b-a)/a*100):'нет базы';

async function post(body,path='/api/pulse'){
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let data;try{data=await response.json();}catch{throw new Error('Сервер вернул неожиданный ответ. Проверьте окно сервера.');}
 if(!response.ok||data.error)throw new Error(data.error||'Ошибка запроса');return data;
}
function button(text,handler,cls='pulse-btn'){const b=el('button',cls,text);b.type='button';if(handler)b.onclick=handler;return b;}
async function busy(control,status,task){
 const label=control.textContent;control.disabled=true;control.setAttribute('aria-busy','true');if(status){status.textContent='Выполняется…';status.classList.remove('is-error');}
 try{const result=await task();if(status&&status.textContent==='Выполняется…')status.textContent='';return result;}
 catch(error){if(status){status.textContent=error.message;status.classList.add('is-error');}else alert(error.message);}
 finally{control.disabled=false;control.removeAttribute('aria-busy');control.textContent=label;}
}
function field(host,label,type='text',attrs={}){const wrap=el('label','pulse-field');wrap.append(el('span','',label));const input=type==='select'?el('select'):type==='textarea'?el('textarea'):el('input');if(type!=='select'&&type!=='textarea')input.type=type;for(const [k,v] of Object.entries(attrs))input.setAttribute(k,v);wrap.append(input);host.append(wrap);return input;}

/* ---------- графики ---------- */
let chartHostWidth=null;
const periodLabel=(value,grain)=>grain==='month'?new Intl.DateTimeFormat('ru-RU',{month:'short',year:'2-digit',timeZone:'UTC'}).format(new Date(value.slice(0,7)+'-01T12:00:00Z')):grain==='week'?'нед. '+dateLabel(value):dateLabel(value);
function lineChart({series,marker,events=[],width=Math.max(320,Math.min(1100,(chartHostWidth||document.querySelector('.pulse-page')?.clientWidth||960)-48)),height=180,format=v=>nf.format(v),label='График',onPoint,onEvent,grain='day',labels='none'}){
 const dateLabel=value=>periodLabel(value,grain);
 const all=series.flatMap(s=>s.points);const host=el('div','pulse-chart');
 if(!all.length){host.append(el('p','pulse-muted','Нет наблюдений для графика.'));return host;}
 const dates=[...new Set(all.map(p=>p[0]))].sort(),x0=Date.parse(dates[0]),x1=Date.parse(dates.at(-1))||x0+1;
 const values=all.map(p=>p[1]);let lo=Math.min(...values),hi=Math.max(...values);if(lo>0&&series.every(s=>!s.zeroless))lo=0;if(hi===lo)hi=lo+1;
 const pad={l:52,r:12,t:12,b:24},w=width-pad.l-pad.r,h=height-pad.t-pad.b;
 const X=d=>pad.l+(x1===x0?w/2:(Date.parse(d)-x0)/(x1-x0)*w),Y=v=>pad.t+h-(v-lo)/(hi-lo)*h;
 const root=svg('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':label,preserveAspectRatio:'none'});
 root.append(svg('rect',{x:pad.l,y:pad.t,width:w,height:h,class:'plot-bg'}));
 for(let i=0;i<=3;i++){const v=lo+(hi-lo)*i/3,y=Y(v);root.append(svg('line',{x1:pad.l,x2:width-pad.r,y1:y,y2:y,class:'grid'}));const t=svg('text',{x:pad.l-6,y:y+4,'text-anchor':'end',class:'axis'});t.textContent=format(v);root.append(t);}
 for(const d of [dates[0],dates[Math.floor(dates.length/2)],dates.at(-1)]){const t=svg('text',{x:X(d),y:height-6,'text-anchor':'middle',class:'axis'});t.textContent=dateLabel(d);root.append(t);}
 for(const ev of events){if(ev.date<dates[0]||ev.date>dates.at(-1))continue;const ex=X(ev.date);const line=svg('line',{x1:ex,x2:ex,y1:pad.t,y2:pad.t+h,class:'event'});const flag=svg('path',{d:`M${ex} ${pad.t}l8 4l-8 4z`,class:'event-flag'});const tip=svg('title');tip.textContent=dateLabel(ev.date)+' · '+ev.title+(onEvent?' — нажмите, чтобы увидеть, что сдвинулось после':'');flag.append(tip);root.append(line,flag);if(onEvent){const hit=svg('rect',{x:ex-7,y:pad.t-2,width:16,height:h+4,class:'event-hit',tabindex:'0',role:'button','aria-label':'Событие '+dateLabel(ev.date)+': '+ev.title});const t2=svg('title');t2.textContent=tip.textContent;hit.append(t2);const fire=()=>onEvent(ev);hit.addEventListener('click',fire);hit.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fire();}});root.append(hit);}}
 if(marker){const mx=X(marker);root.append(svg('line',{x1:mx,x2:mx,y1:pad.t,y2:pad.t+h,class:'marker'}));const t=svg('text',{x:mx+4,y:pad.t+10,class:'axis marker-label'});t.textContent='сдвиг '+dateLabel(marker);root.append(t);}
 series.forEach((s,si)=>{
  if(!s.points.length)return;const cls=s.cls||'c'+si%5;
  if(s.segments){for(const [from,to,value] of s.segments)root.append(svg('line',{x1:X(from),x2:X(to),y1:Y(value),y2:Y(value),class:'level'}));}
  const d=s.points.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ');
  root.append(svg('path',{d,class:'line '+cls,fill:'none'}));
 });
 if(labels!=='none'){/* подписи значений у точек: ключевые (мин., макс., последняя) или все, без наложений */
  const boxes=[],charW=6.2;series.forEach((s,si)=>{const pts=s.points;if(!pts.length)return;let chosen=pts;if(labels==='key'){const hi=pts.reduce((a,b)=>b[1]>a[1]?b:a),lo=pts.reduce((a,b)=>b[1]<a[1]?b:a);chosen=[...new Set([hi,lo,pts.at(-1),pts[0]])];}
   for(const p of chosen){const text=format(p[1]),tw=text.length*charW,px=X(p[0]),py=Y(p[1]);let placed=null;for(const dy of [-8,14,-20,26]){const x=Math.max(pad.l,Math.min(width-pad.r-tw,px-tw/2)),y=py+dy,box={x,y:y-10,w:tw,h:12};if(y<10||y>height-pad.b+2||boxes.some(o=>box.x<o.x+o.w+3&&box.x+box.w+3>o.x&&box.y<o.y+o.h+2&&box.y+box.h+2>o.y))continue;placed=box;break;}
    if(!placed)continue;boxes.push(placed);const t=svg('text',{x:placed.x,y:placed.y+10,class:'point-label '+(s.cls||'c'+si%5)});t.textContent=text;root.append(t);root.append(svg('circle',{cx:px,cy:py,r:2.5,class:'point-dot '+(s.cls||'c'+si%5)}));}});
 }
 if(onPoint)series.forEach((s,si)=>{if(s.pick===false)return;for(const p of s.points){const c=svg('circle',{cx:X(p[0]),cy:Y(p[1]),r:Math.max(4,Math.min(9,w/Math.max(s.points.length,1)/2)),class:'hit',tabindex:'0',role:'button','aria-label':(s.name?s.name+' · ':'')+dateLabel(p[0])+': '+format(p[1])+'. Объяснить точку'});const tip=svg('title');tip.textContent=(s.name?s.name+' · ':'')+dateLabel(p[0])+': '+format(p[1])+' — нажмите, чтобы объяснить';c.append(tip);const fire=()=>{root.querySelectorAll('.hit.is-picked').forEach(n=>n.classList.remove('is-picked'));c.classList.add('is-picked');onPoint(p[0],p[1],si,s);};c.addEventListener('click',fire);c.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fire();}});root.append(c);}});
 host.append(root);
 const legend=el('div','pulse-legend');series.forEach((s,si)=>{if(s.name){const item=el('span','pulse-legend-item '+(s.cls||'c'+si%5));item.append(el('i'),document.createTextNode(s.name));legend.append(item);}});
 if(onPoint)legend.append(el('span','pulse-legend-hint','Нажмите на точку, чтобы получить объяснение'));
 if(legend.childElementCount)host.append(legend);
 return host;
}
/* Пошаговый статус: сервер сообщает реальные этапы обработки. */
async function runJob(job,host){
 const box=el('ol','pulse-steps-live');box.setAttribute('aria-live','polite');host.replaceChildren(box);
 const {id}=await post({action:'job-start',job});let shown=0;
 for(;;){
  const state=await post({action:'job-status',id});
  for(const stage of state.stages.slice(shown)){box.lastElementChild?.classList.add('done');box.append(el('li','',stage.text));}
  shown=state.stages.length;
  if(state.done){if(state.error){box.lastElementChild?.classList.add('failed');throw new Error(state.error);}box.lastElementChild?.classList.add('done');box.append(el('li','pulse-steps-time done','Время: '+df.format(state.elapsed)+' с'));return state.result;}
  await new Promise(resolve=>setTimeout(resolve,300));
 }
}
function slider(host,label,min,max,step,value,show){const wrap=el('label','pulse-slider'),head=el('span',''),out=el('b','',show(value)),input=el('input');head.append(document.createTextNode(label+' '),out);input.type='range';input.min=min;input.max=max;input.step=step;input.value=value;input.addEventListener('input',()=>{out.textContent=show(Number(input.value));});wrap.append(head,input);host.append(wrap);return input;}
/* SVG → PNG для письма и вставки: стили берутся из текущей темы. */
async function svgToPng(node,background){
 const clone=node.cloneNode(true),box=node.viewBox.baseVal,width=box.width||640,height=box.height||180;
 const source=[node,...node.querySelectorAll('*')],target=[clone,...clone.querySelectorAll('*')];
 source.forEach((item,i)=>{const cs=getComputedStyle(item),t=target[i];for(const prop of ['stroke','fill','stroke-width','stroke-dasharray','opacity','font-size','font-family','fill-opacity'])t.style.setProperty(prop,cs.getPropertyValue(prop));});
 clone.querySelectorAll('.hit').forEach(n=>n.remove());clone.setAttribute('width',width);clone.setAttribute('height',height);clone.setAttribute('xmlns',ns);
 const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(clone));
 const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Не удалось подготовить график для письма.'));image.src=url;});
 const canvas=document.createElement('canvas');canvas.width=width*2;canvas.height=height*2;const ctx=canvas.getContext('2d');ctx.fillStyle=background;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
 return canvas.toDataURL('image/png');
}
const b64=text=>{const bytes=new TextEncoder().encode(text);let bin='';for(const b of bytes)bin+=String.fromCharCode(b);return btoa(bin);};
const wrap76=text=>text.replace(/(.{76})/g,'$1\r\n');
function download(name,content,type){const blob=content instanceof Blob?content:new Blob([content],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
const escapeHtml=text=>String(text).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
/* Письмо-черновик .eml: открывается в почтовой программе, графики вложены картинками. */
function buildEml(subject,slides,images,accent){
 const boundary='----pulse'+Date.now();let html='<html><body style="font-family:Arial,sans-serif;color:#1c1b19;max-width:760px">';
 slides.forEach((s,i)=>{html+='<h2 style="margin:24px 0 4px;font-size:'+(i?18:22)+'px">'+escapeHtml(s.title)+'</h2>';if(s.subtitle)html+='<p style="margin:0 0 10px;color:#716e67;font-size:13px">'+escapeHtml(s.subtitle)+'</p>';
  if(s.kpis?.length){html+='<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;margin:6px 0"><tr>';for(const [a,b] of s.kpis)html+='<td style="border:1px solid #dcd9d1"><div style="font-size:11px;color:#716e67">'+escapeHtml(a)+'</div><div style="font-size:18px;font-weight:bold;color:'+accent+'">'+escapeHtml(b)+'</div></td>';html+='</tr></table>';}
  if(images[i])html+='<p><img src="cid:chart'+i+'" width="640" alt="График" style="max-width:100%"></p>';
  if(s.bullets?.length)html+='<ul style="font-size:14px;line-height:1.5">'+s.bullets.map(b=>'<li>'+escapeHtml(b)+'</li>').join('')+'</ul>';
  if(s.conclusion)html+='<p style="font-weight:bold;color:'+accent+'">Вывод: '+escapeHtml(s.conclusion)+'</p>';});
 html+='<p style="color:#716e67;font-size:11px;margin-top:24px">Подготовлено в GEN UI мониторинг. Числа рассчитаны по загруженным выгрузкам.</p></body></html>';
 let eml='X-Unsent: 1\r\nSubject: =?UTF-8?B?'+b64(subject)+'?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="'+boundary+'"\r\n\r\n--'+boundary+'\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+wrap76(b64(html))+'\r\n';
 images.forEach((data,i)=>{if(!data)return;eml+='--'+boundary+'\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <chart'+i+'>\r\nContent-Disposition: inline; filename="chart'+i+'.png"\r\n\r\n'+wrap76(data.split(',')[1])+'\r\n';});
 return eml+'--'+boundary+'--\r\n';
}

/* ---------- страница «Пульс дня» ---------- */
function create(main){
 const page=el('section','trust-page pulse-page');page.hidden=true;page.setAttribute('aria-labelledby','pulseTitle');main.append(page);
 const rail=document.querySelector('.rail'),link=el('a','nav-item','Пульс дня');link.href='#pulse';link.dataset.navPrimary='0';
 const anchor=rail.querySelector('.rail-label');if(anchor)anchor.after(link);else rail.insertBefore(link,rail.querySelector('.history'));
 let brief=null,catalog=null,tab='brief',loading=false,ui=null;const api=()=>ui;
 const header=el('div','pulse-head'),title=el('h1','','Пульс дня');title.id='pulseTitle';
 const meta=el('p','pulse-muted'),status=el('p','pulse-status');status.setAttribute('role','status');
 const refresh=button('Пересчитать',()=>load(true),'pulse-btn ghost');
 const tabs=el('div','pulse-tabs');tabs.setAttribute('role','tablist');
 const panels={brief:el('div','pulse-panel'),canvas:el('div','pulse-panel'),portfolio:el('div','pulse-panel'),compare:el('div','pulse-panel'),skills:el('div','pulse-panel'),effect:el('div','pulse-panel'),whatif:el('div','pulse-panel'),memory:el('div','pulse-panel'),meeting:el('div','pulse-panel')};
 const tabNames={brief:'Брифинг',canvas:'Холсты',portfolio:'Портфель групп',compare:'Сравнение',whatif:'Что если',skills:'Скилы',memory:'Память',meeting:'Встреча в один клик',effect:'Эффект'};
 for(const [key,name] of Object.entries(tabNames)){const t=button(name,()=>select(key),'pulse-tab');t.setAttribute('role','tab');t.dataset.tab=key;tabs.append(t);}
 const showButton=button('▶ Режим показа',()=>showMode(),'pulse-btn accent'),mailButton=button('Бриф письмом',e=>busy(e.target,status,async()=>{select('meeting');await renderMeetingForm();panels.meeting.querySelector('.pulse-btn.accent')?.click();status.textContent='Черновик собран — нажмите «Письмо (.eml)» или «Скачать PPTX».';}),'pulse-btn ghost'),demoReset=button('Сбросить демо',e=>{if(!confirm('Вернуть демо в исходное состояние? Заметки и резюме демо будут очищены.'))return;busy(e.target,status,async()=>{brief=await post({action:'demo-reset'});panels.compare.replaceChildren();panels.whatif.replaceChildren();panels.meeting.replaceChildren();renderBrief();status.textContent='Демо возвращено в исходное состояние.';});},'pulse-btn ghost'),demoBadge=el('span','pulse-tag warn','ДЕМО-ДАННЫЕ');demoReset.hidden=demoBadge.hidden=true;
 const headText=el('div'),tools=el('div','pulse-row pulse-tools');headText.append(title,meta);tools.append(demoBadge,showButton,mailButton,refresh,demoReset);header.append(headText,tools);
 page.append(header,status,tabs,...Object.values(panels));
 function select(key){tab=key;for(const t of tabs.children){const on=t.dataset.tab===key;t.classList.toggle('active',on);t.setAttribute('aria-selected',String(on));}for(const [k,p] of Object.entries(panels))p.hidden=k!==key;
  if(key==='memory')renderMemory();if(key==='canvas')renderCanvas();if(key==='portfolio')renderPortfolio();if(key==='skills')renderSkills();if(key==='effect')renderEffect();if(key==='compare'&&!panels.compare.childElementCount)renderCompare();if(key==='meeting'&&!panels.meeting.childElementCount)renderMeetingForm();if(key==='whatif'&&!panels.whatif.childElementCount)renderWhatIf();}

 async function ensureCatalog(){if(!catalog){try{catalog=await post({action:'catalog'});}catch{catalog={surveys:[],products:[]};}}return catalog;}
 async function load(force=false){
  if(loading)return;loading=true;status.textContent=force?'Пересчитываем брифинг…':'Открываем подготовленный брифинг…';status.classList.remove('is-error');
  try{brief=await post({action:'brief',force});status.textContent='';renderBrief();if(tab==='canvas')renderCanvas();}
  catch(error){status.textContent=error.message;status.classList.add('is-error');}
  finally{loading=false;}
 }
 function show(){window.scrollTo(0,0);select(tab);if(!brief)load(false);else load(false);}

 /* --- брифинг --- */
 function renderBrief(){
  const host=panels.brief;host.replaceChildren();
  if(!brief)return;
  const generated=new Date(brief.generatedAt);
  meta.textContent=brief.empty?'Данных пока нет.':'Подготовлено '+generated.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' · версия данных '+String(brief.revision).slice(0,8)+' · готовится автоматически при каждой новой загрузке CSV';
  demoBadge.hidden=demoReset.hidden=!brief.demo;showButton.hidden=mailButton.hidden=Boolean(brief.empty);
  if(brief.empty){host.append(onboarding());return;}
  clustersHost=shiftsHost=null;host.append(statusCard(),decisionsSection(),analystSection());
 }
 const ai=()=>Boolean(brief?.modelReady||brief?.demo);
 function trustLine(trust){return el('p','pulse-trust','Паспорт доверия: фактов в основе — '+trust.facts+' · ссылок на факты — '+trust.refs+' · чисел вне фактов — 0 (иначе ответ отклоняется целиком)'+(trust.rejected?' · отклонено ответов модели: '+trust.rejected:''));}
 function narrativeCard(){
  const card=el('section','pulse-card pulse-narrative');const statusLine=el('p','pulse-status'),steps=el('div','pulse-steps-host');statusLine.setAttribute('role','status');
  card.append(el('p','pulse-eyebrow','Резюме для руководителя'));
  if(brief.narrative){
   card.append(el('h2','',brief.narrative.headline));const list=el('ul');
   const facts=new Map(brief.narrative.facts.map(f=>[f.ref,f]));
   for(const b of brief.narrative.bullets){const li=el('li','',b.text);const refs=el('span','pulse-refs');for(const r of b.refs){const f=facts.get(r);const chip=el('abbr','pulse-ref',r);if(f)chip.title=f.label+': '+(typeof f.value==='number'?fmt(f.value):f.value)+(f.unit?' '+f.unit:'')+(f.period?' · '+f.period:'');refs.append(chip);}li.append(refs);list.append(li);}
   card.append(list,el('p','pulse-muted',(brief.narrative.source||'GigaCode CLI')+' · '+new Date(brief.narrative.generatedAt).toLocaleString('ru-RU')+' · наведите на ссылку F…, чтобы увидеть факт'));
   if(brief.narrative.trust)card.append(trustLine(brief.narrative.trust));
   card.append(verdictRow('Резюме брифинга · '+(brief.narrative.source||''),brief.narrative.canned));
  }else{
   card.append(el('h2','',headline()));
   card.append(el('p','pulse-muted',ai()?'Резюме собрано правилами. GigaCode может сформулировать его для руководителя — числа будут проверены по фактам.':'Резюме собрано правилами. Подключите GigaCode CLI, чтобы получать формулировку модели.'));
  }
  const controls=el('div','pulse-row');
  if(ai())controls.append(button(brief.narrative?'Переформулировать':'Сформулировать через GigaCode',e=>busy(e.target,statusLine,async()=>{const n=await runJob({action:'narrate'},steps);brief.narrative=n;renderBrief();}),'pulse-btn accent'));
  const auto=el('label','pulse-check'),box=el('input');box.type='checkbox';box.checked=Boolean(brief.settings?.autoNarrate);box.disabled=!brief.modelReady;
  box.onchange=()=>busy(box,statusLine,async()=>{const s=await post({action:'settings',autoNarrate:box.checked});brief.settings=s;statusLine.textContent=s.autoNarrate?'Резюме будет готовиться в фоне при каждой новой загрузке.':'Фоновая подготовка резюме выключена.';});
  auto.append(box,document.createTextNode(' Готовить AI-резюме заранее'));controls.append(auto);
  card.append(controls,statusLine,steps);return card;
 }
 function headline(){
  const down=brief.shifts.filter(s=>s.direction==='down').length,urgent=brief.signals.filter(s=>s.severity==='urgent').length;
  const parts=[];if(urgent)parts.push(urgent+' срочн. сигнал(ов)');if(brief.clusters.length)parts.push(brief.clusters.length+' групповых инцидента(ов)');if(down)parts.push(down+' устойчивых снижений');
  return parts.length?'Сегодня в фокусе: '+parts.join(', ')+'.':'Существенных отклонений не найдено — показатели стабильны.';
 }
 function kpiRow(){
  const row=el('div','pulse-kpis');
  for(const k of brief.kpis){
   for(const [label,metric,a,b] of [['Ответы за 7 дней','answers',k.baseline.answers,k.current.answers],['Отклик','responseRate',k.baseline.responseRate,k.current.responseRate],['CSI','csi',k.baseline.csi,k.current.csi]]){
    if(metric!=='answers'&&b===null)continue;
    const tile=el('div','pulse-kpi');const delta=metric==='answers'?pctChange(a,b):a===null||b===null?'нет базы':signed(b-a,metric==='csi'?' балла':' п.п.');
    const bad=metric==='answers'?(a&&b<a*0.9):a!==null&&b!==null&&b<a-(metric==='csi'?.1:.3);
    tile.append(el('span','pulse-muted',k.label+' · '+label),el('b','',fmt(b,metric)),el('small',bad?'bad':'',delta+' к прошлой неделе'));row.append(tile);
   }
  }
  return row;
 }
 function changesCard(){
  const card=el('section','pulse-section');card.append(el('h2','','Что изменилось с прошлого брифинга'));
  if(!brief.changes){card.append(el('p','pulse-muted','Это первый брифинг для этой папки. Сравнение появится после следующей загрузки CSV.'));return card;}
  card.append(el('p','pulse-muted','Прошлый брифинг: '+new Date(brief.previousAt).toLocaleString('ru-RU')));
  const grid=el('div','pulse-changes');
  for(const [key,label,cls] of [['added','Новые','bad'],['worse','Ухудшились','warn'],['resolved','Закрылись','good']]){
   const col=el('div','pulse-change '+cls);col.append(el('h3','',label+' · '+brief.changes.counts[key]));
   if(!brief.changes[key].length)col.append(el('p','pulse-muted','Нет'));
   for(const item of brief.changes[key].slice(0,8)){const row=el('div','pulse-change-item');row.append(el('b','',item.title),el('span','pulse-muted',item.kind),el('span','',item.detail));col.append(row);}
   grid.append(col);
  }
  card.append(grid);return card;
 }
 function clusterCard(c){
  const card=el('article','pulse-card pulse-cluster');
  card.append(el('span','pulse-tag '+(c.direction==='down'?'bad':''),c.channelLabel+' · '+dateLabel(c.from)+(c.to!==c.from?' — '+dateLabel(c.to):'')),el('h3','',c.title),el('p','pulse-muted',c.hint));
  const list=el('ul','pulse-members');for(const m of c.members)list.append(el('li','','#'+m.id+' · '+m.name+' · '+change(m)+' с '+dateLabel(m.date)));card.append(list);
  card.append(el('p','pulse-muted','Продукты: '+c.products.map(([p,n])=>p+' ('+n+')').join(', ')));
  card.append(button('Записать общую причину',()=>openNote({channel:c.channel,metric:c.metric,direction:c.direction,date:c.from,title:c.title,products:c.products.map(p=>p[0])})));
  return card;
 }
 function openPoint(out,steps,ctx,line){
  return busy(document.createElement("button"),line,async()=>{
   steps.replaceChildren();const {key:_k,title:_t,...pointQuery}=ctx;const data=await post({action:'point',...pointQuery,useModel:false});
   const {key,title,...query}=ctx,extra=el('div','pulse-extra');
   if(ai())extra.append(button('Объяснить эту точку через GigaCode',e=>busy(e.target,line,async()=>{const r=await runJob({action:'point',...query,useModel:true},steps);renderExplain(out,{...r,date:ctx.date,title},eventForm(ctx,out,line));}),'pulse-btn accent'));
   extra.append(eventForm(ctx,out,line));
   renderExplain(out,{...data,title},extra);
  });
 }
 function shiftCard(s){
  const card=el('article','pulse-card pulse-shift '+s.direction);
  const tags=el('div','pulse-row');tags.append(el('span','pulse-tag '+(s.direction==='down'?'bad':'good'),s.label+' '+change(s)),el('span','pulse-tag',s.channelLabel));
  if(s.severity==='high')tags.append(el('span','pulse-tag bad','сильный'));
  if(s.hiddenFromWeekly)tags.append(el('span','pulse-tag warn','недельное сравнение не видит'));
  card.append(tags,el('h3','','#'+s.id+' · '+s.name));
  const unit=s.metric==='csi'?'':' '+s.unit;
  card.append(el('p','',s.label+': '+fmt(s.before,s.metric)+unit+' → '+fmt(s.after,s.metric)+unit+' с '+dateLabel(s.date)+' · дней до/после: '+s.daysBefore+'/'+s.daysAfter));
  const out=el('div','pulse-output'),line=el('p','pulse-status'),steps=el('div','pulse-steps-host');line.setAttribute('role','status');
  const first=s.series[0][0],last=s.series.at(-1)[0];
  card.append(lineChart({series:[{points:s.series,cls:'primary',segments:[[first,s.lastBefore,s.before],[s.date,last,s.after]],zeroless:s.metric==='csi'}],marker:s.date,format:v=>s.metric==='csi'?cf.format(v):nf.format(v),label:s.label+' по дням, опрос '+s.id,height:150,
   events:eventsFor(s.channel,[s.id]),onEvent:ev=>{steps.replaceChildren();renderImpact(out,ev,line);},
   onPoint:date=>openPoint(out,steps,{channel:s.channel,id:s.id,metric:s.metric,date,key:s.key,title:'#'+s.id+' · '+s.label.toLowerCase()+' · '+dateLabel(date)},line)}));
  if(s.memory?.length){const mem=el('div','pulse-memory');mem.append(el('b','','Похоже на прошлый случай'));for(const n of s.memory)mem.append(el('p','',n.title+' — '+n.cause+(n.action?' · помогло: '+n.action:'')+' ('+new Date(n.created).toLocaleDateString('ru-RU')+')'));card.append(mem);}
  const actions=el('div','pulse-row');
  actions.append(button('Похожие опросы',e=>busy(e.target,line,async()=>{steps.replaceChildren();renderSimilar(out,await post({action:'similar',channel:s.channel,id:s.id,metric:s.metric,date:s.date}));})));
  actions.append(button('Факты и проверки',e=>busy(e.target,line,async()=>{steps.replaceChildren();renderExplain(out,{...await post({action:'explain',channel:s.channel,id:s.id,metric:s.metric,useModel:false}),shiftRef:{channel:s.channel,id:s.id,metric:s.metric}});})));
  if(ai())actions.append(button('Объяснить через GigaCode',e=>busy(e.target,line,async()=>{const r=await runJob({action:'explain',channel:s.channel,id:s.id,metric:s.metric,useModel:true},steps);renderExplain(out,{...r,shiftRef:{channel:s.channel,id:s.id,metric:s.metric},title:'#'+s.id+' · '+s.label.toLowerCase()});}),'pulse-btn accent'));
  actions.append(button('Записать вывод',()=>openNote({surveyId:s.id,channel:s.channel,metric:s.metric,direction:s.direction,date:s.date,products:s.products,title:'#'+s.id+' · '+s.label.toLowerCase()+' '+change(s)})));
  actions.append(button('Что если…',()=>{closeShow();select('whatif');whatifPrefill({id:s.id,channel:s.channel});}));
  card.append(actions,line,steps,out);return card;
 }
 function renderSimilar(host,data){
  host.replaceChildren();const box=el('div','pulse-subcard');
  box.append(el('h4','','Похожие изменения: '+data.label.toLowerCase()+' вокруг '+dateLabel(data.date)),el('p','pulse-muted','Сравнено опросов: '+data.compared+' · '+data.window));
  if(!data.matches.length){box.append(el('p','','Похожих изменений у других опросов нет — вероятна локальная причина этого опроса.'));host.append(box);return;}
  box.append(el('p','','Такое же направление у '+data.total+' опросов. '+(data.total>=2?'Это похоже на общую причину.':'')));
  const table=el('table','pulse-table');const head=el('tr');for(const h of ['Опрос','До','После','Изменение'])head.append(el('th','',h));table.append(head);
  for(const m of data.matches.slice(0,12)){const r=el('tr');r.append(el('td','','#'+m.id+' · '+m.name),el('td','',fmt(m.before,data.metric)),el('td','',fmt(m.after,data.metric)),el('td','',change(m)));table.append(r);}
  box.append(table);if(data.products.length)box.append(el('p','pulse-muted','Продукты: '+data.products.map(([p,n])=>p+' ('+n+')').join(', ')));host.append(box);
 }
 function renderExplain(host,data,extra){
  host.replaceChildren();const box=el('div','pulse-subcard');
  box.append(el('h4','',(data.title?data.title+' · ':'')+(data.summary?'Объяснение':'Факты для проверки')),el('p','pulse-muted',data.source));
  if(data.summary)box.append(el('p','pulse-summary',data.summary));
  if(data.hypotheses?.length){const ul=el('ul');for(const h of data.hypotheses){const li=el('li','',h.text+' ');li.append(el('span','pulse-refs',h.refs.join(', ')));ul.append(li);}box.append(el('b','','Гипотезы'),ul);}
  if(data.trust)box.append(trustLine(data.trust));
  const facts=el('table','pulse-table');for(const f of data.facts){const r=el('tr');r.append(el('td','pulse-ref',f.ref),el('td','',f.label),el('td','',(typeof f.value==='number'?fmt(f.value,f.unit==='балла'||/CSI/.test(f.label)?'csi':''):f.value)+(f.unit?' '+f.unit:'')),el('td','pulse-muted',f.period||''));facts.append(r);}
  box.append(facts);
  if(data.checks?.length){const ol=el('ol');for(const c of data.checks)ol.append(el('li','',c.label+(c.refs?.length?' ('+c.refs.join(', ')+')':'')));box.append(el('b','','Что проверить'),ol);}
  if(data.summary&&data.source)box.append(verdictRow((data.title||'Разбор')+' · '+data.source,data.canned));
  if(data.shiftRef)box.append(trustDemo(data.shiftRef));
  if(extra)box.append(extra);
  host.append(box);
 }

 /* --- первый запуск --- */
 function onboarding(){
  const box=el('section','pulse-card pulse-onboarding');
  box.append(el('p','pulse-eyebrow','Первый запуск · 3 шага'),el('h2','','Подключим данные за минуту'));
  const steps=el('ol','pulse-steps');
  const s1=el('li');s1.append(el('b','','Перетащите выгрузки CSV сюда'),el('p','pulse-muted','push-sms.csv, success-screen.csv и при желании products.csv. Заголовки проверяются сразу, файлы сохраняются в папку date.'));
  const drop=el('div','pulse-drop','Перетащите файлы или нажмите, чтобы выбрать');drop.tabIndex=0;drop.setAttribute('role','button');
  const picker=el('input');picker.type='file';picker.accept='.csv,text/csv';picker.multiple=true;picker.hidden=true;
  const log=el('div','pulse-upload-log');log.setAttribute('role','status');
  drop.onclick=()=>picker.click();drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();picker.click();}};
  picker.onchange=()=>uploadFiles([...picker.files],log);
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('is-over');});drop.addEventListener('dragleave',()=>drop.classList.remove('is-over'));
  drop.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('is-over');uploadFiles([...e.dataTransfer.files],log);});
  s1.append(drop,picker,log);
  const s2=el('li');s2.append(el('b','','Проверьте данные'),el('p','pulse-muted','После загрузки проект перечитает CSV и покажет качество данных.'));const check=el('a','pulse-link','Открыть «Данные» →');check.href='#admin-data';s2.append(check);
  const s3=el('li');s3.append(el('b','','Подключите GigaCode (по желанию)'),el('p','pulse-muted','Без модели работают все расчёты. С моделью — резюме, объяснения и разбор вопросов. Запустите START_GIGACODE.cmd.'));const conn=el('a','pulse-link','Подключение →');conn.href='#admin-connection';s3.append(conn);
  steps.append(s1,s2,s3);box.append(steps);return box;
 }

 /* --- что если --- */
 let whatifForm=null;
 async function renderWhatIf(){
  const host=panels.whatif;host.replaceChildren();const cat=await ensureCatalog();
  host.append(el('h2','','Что если'),el('p','pulse-muted','Задайте вопрос словами или параметрами. Прогноз считается локально; модель только переводит вопрос в параметры.'));
  const ask=el('form','pulse-ask'),q=el('input');q.type='text';q.placeholder='Например: что если отклик по продукту Вклады упадёт до 3% и отправки −20%?';q.setAttribute('aria-label','Вопрос «что если»');
  const go=button('Разобрать вопрос');go.type='submit';ask.append(q,go);const askStatus=el('p','pulse-status');askStatus.setAttribute('role','status');
  const grid=el('div','pulse-form-grid');
  const channel=field(grid,'Канал','select');channel.add(new Option('Пуш + СМС','communication'));channel.add(new Option('Экран успеха','success_screen'));
  const survey=field(grid,'Опрос (номер)','number',{min:'1',placeholder:'все опросы'});
  const product=field(grid,'Продукт','select');product.add(new Option('Все продукты',''));for(const p of cat.products)product.add(new Option(p,p));
  const plan=field(grid,'План ответов на месяц','number',{min:'1',placeholder:'из справочника'});
  const rate=field(grid,'Отклик, %','number',{min:'0.01',max:'100',step:'0.01',placeholder:'текущий'});
  const sends=field(grid,'Отправки в день','number',{min:'0',placeholder:'текущие'});
  const changePct=field(grid,'Изменение отправок, %','number',{min:'-100',max:'1000',placeholder:'0'});
  const run=button('Рассчитать сценарий',null,'pulse-btn accent');const runStatus=el('p','pulse-status');runStatus.setAttribute('role','status');const out=el('div','pulse-output');
  const num=v=>v.value===''?null:Number(v.value);
  const compute=()=>busy(run,runStatus,async()=>{const data=await post({action:'whatif',channel:channel.value,id:survey.value?Number(survey.value):null,product:product.value||null,plan:num(plan),responseRate:num(rate),sendsPerDay:num(sends),sendsChangePct:num(changePct)});renderScenario(out,data);});
  run.onclick=compute;
  ask.onsubmit=e=>{e.preventDefault();if(!q.value.trim())return;busy(go,askStatus,async()=>{const r=await post({action:'whatif-parse',query:q.value,useModel:Boolean(brief?.modelReady)});const p=r.params;
   channel.value=p.channel||'communication';survey.value=p.id??'';product.value=p.product&&cat.products.includes(p.product)?p.product:'';plan.value=p.plan??'';rate.value=p.responseRate??'';sends.value=p.sendsPerDay??'';changePct.value=p.sendsChangePct??'';
   askStatus.textContent=(r.understood?'Понял: ':'Не удалось распознать параметры. ')+r.source+(r.notes?.length?' · '+r.notes.join(' '):'');if(r.understood)compute();});};
  host.append(ask,askStatus,grid,run,runStatus,out);whatifForm={channel,survey,product,compute};
 }
 async function whatifPrefill({id,channel}){await renderWhatIf();whatifForm.channel.value=channel;whatifForm.survey.value=id;whatifForm.product.value='';whatifForm.compute();}
 function renderScenario(host,d){
  host.replaceChildren();const card=el('div','pulse-card pulse-scenario');host.append(card);
  const scope=d.scope.id?'Опрос #'+d.scope.id:d.scope.product?'Продукт '+d.scope.product:'Все опросы канала';
  card.append(el('p','pulse-eyebrow',scope+' · '+d.scope.channelLabel+' · '+d.month+' · данные по '+dateLabel(d.through)));
  const sliders=el('div','pulse-sliders'),body=el('div','pulse-scenario-body'),base=d.baseline;
  const rate0=d.scenario.responseRate??base.responseRate??1,change0=base.sendsPerDay?(d.scenario.sendsPerDay/base.sendsPerDay-1)*100:0;
  const rate=slider(sliders,'Отклик',0.1,Math.max(10,Math.ceil((base.responseRate||rate0)*2.5)),0.1,Math.round(rate0*10)/10,v=>df.format(v)+'%');
  const shift=slider(sliders,'Отправки к текущему темпу',-90,150,5,Math.max(-90,Math.min(150,Math.round(change0/5)*5)),v=>signed(v));
  const reset=button('Вернуть текущий темп',()=>{rate.value=Math.round((base.responseRate||rate0)*10)/10;shift.value=0;rate.dispatchEvent(new Event('input'));shift.dispatchEvent(new Event('input'));},'pulse-btn ghost');sliders.append(reset);
  function recompute(){
   const r=Number(rate.value),sends=base.sendsPerDay*(1+Number(shift.value)/100),perDay=sends*r/100,forecast=d.answersToDate+d.remainingDays*perDay;
   const projection=[[d.through,d.answersToDate]];for(let i=1;i<=d.remainingDays;i++)projection.push([new Date(Date.parse(d.through)+i*864e5).toISOString().slice(0,10),d.answersToDate+i*perDay]);
   const gap=d.plan?Math.max(d.plan-d.answersToDate,0):null;
   return {...d,scenario:{sendsPerDay:sends,responseRate:r,answersPerDay:perDay,forecast},completion:d.plan?forecast/d.plan*100:null,verdict:d.plan?(forecast>=d.plan?'План будет выполнен':'План не будет выполнен'):null,
    requiredSendsPerDay:d.plan&&d.remainingDays&&r?gap/d.remainingDays/(r/100):null,requiredResponseRate:d.plan&&d.remainingDays&&sends?gap/d.remainingDays/sends*100:null,series:{...d.series,projection}};
  }
  function draw(x){
   body.replaceChildren();
   if(x.verdict)body.append(el('h3',x.scenario.forecast>=x.plan?'good':'bad',x.verdict+' · прогноз '+nf.format(x.scenario.forecast)+' из '+nf.format(x.plan)+' ('+df.format(x.completion)+'%)'));
   else body.append(el('h3','','Прогноз на конец месяца: '+nf.format(x.scenario.forecast)+' ответов · план не задан'));
   const tiles=el('div','pulse-kpis');
   const tile=(label,value,note)=>{const t=el('div','pulse-kpi');t.append(el('span','pulse-muted',label),el('b','',value),el('small','',note||''));tiles.append(t);};
   tile('Ответы с начала месяца',nf.format(x.answersToDate),'осталось дней: '+x.remainingDays);
   tile('Отправки в день',nf.format(x.scenario.sendsPerDay),'сейчас '+nf.format(x.baseline.sendsPerDay));
   tile('Отклик',x.scenario.responseRate===null?'—':df.format(x.scenario.responseRate)+'%','сейчас '+(x.baseline.responseRate===null?'—':df.format(x.baseline.responseRate)+'%'));
   tile('Прогноз без изменений',nf.format(x.baseline.forecast),'текущий темп');
   if(x.plan&&x.remainingDays){tile('Нужно отправок в день',x.requiredSendsPerDay===null?'—':nf.format(x.requiredSendsPerDay),'при отклике сценария');tile('Нужный отклик',x.requiredResponseRate===null?'—':df.format(x.requiredResponseRate)+'%','при отправках сценария');}
   body.append(tiles,lineChart({series:[{name:'Факт, накопительно',points:x.series.actual,cls:'primary'},{name:'Прогноз сценария',points:x.series.projection,cls:'dashed'},{name:'План',points:x.series.plan,cls:'muted'}],label:'Накопленные ответы и прогноз',height:200}));
   body.append(el('p','pulse-muted',x.method+(x.planSource?' · план: '+x.planSource:'')+' · ползунки пересчитывают прогноз мгновенно, без обращения к серверу'));
  }
  rate.addEventListener('input',()=>draw(recompute()));shift.addEventListener('input',()=>draw(recompute()));
  card.append(el('p','pulse-muted','Двигайте ползунки — прогноз и вердикт по плану меняются сразу.'),sliders,body);draw(d);
 }

 /* --- память --- */
 async function renderMemory(){
  const host=panels.memory;host.replaceChildren(el('h2','','Память расследований'),el('p','pulse-muted','Выводы прошлых разборов. При похожем сдвиге (тот же опрос, показатель, направление или продукт) пульс напомнит о них.'));
  const add=button('Добавить вывод',()=>openNote({}),'pulse-btn accent');host.append(add);
  const list=el('div','pulse-notes');host.append(list);
  try{const {notes}=await post({action:'notes'});if(!notes.length)list.append(el('p','pulse-empty','Записей пока нет. Нажмите «Записать вывод» на карточке сдвига.'));
   for(const n of notes){const card=el('article','pulse-card');card.append(el('span','pulse-tag',(n.surveyId?'#'+n.surveyId+' · ':'')+(n.metric||'')+(n.date?' · '+dateLabel(n.date):'')),el('h3','',n.title),el('p','',n.cause));if(n.action)card.append(el('p','pulse-muted','Что помогло: '+n.action));card.append(el('p','pulse-muted',(n.author?n.author+' · ':'')+new Date(n.created).toLocaleString('ru-RU')));
    card.append(button('Удалить',e=>{if(!confirm('Удалить запись «'+n.title+'»?'))return;busy(e.target,null,async()=>{await post({action:'note-delete',noteId:n.id});renderMemory();load(false);});},'pulse-btn ghost'));list.append(card);}
  }catch(error){list.append(el('p','pulse-status is-error',error.message));}
 }
 const dialog=el('dialog','pulse-dialog');document.body.append(dialog);
 function openNote(preset){
  dialog.replaceChildren();const form=el('form');form.method='dialog';
  form.append(el('h2','','Записать вывод расследования'),el('p','pulse-muted',preset.title?'Связано: '+preset.title:'Свободная запись'));
  const title=field(form,'Заголовок','text',{maxlength:'160',required:''});title.value=preset.title||'';
  const cause=field(form,'Причина (что выяснили)','textarea',{maxlength:'1000',required:'',rows:'3'});
  const action=field(form,'Что помогло / решение','textarea',{maxlength:'1000',rows:'2'});
  const author=field(form,'Автор','text',{maxlength:'80'});try{author.value=localStorage.getItem('pulse-author')||'';}catch{}
  const line=el('p','pulse-status');line.setAttribute('role','status');const row=el('div','pulse-row');const save=button('Сохранить',null,'pulse-btn accent');save.type='submit';row.append(save,button('Отмена',()=>dialog.close(),'pulse-btn ghost'));form.append(row,line);
  form.onsubmit=e=>{e.preventDefault();busy(save,line,async()=>{try{localStorage.setItem('pulse-author',author.value);}catch{}await post({...preset,action:'note-add',title:title.value,cause:cause.value,resolution:action.value,author:author.value});dialog.close();await load(false);if(tab==='memory')renderMemory();});};
  dialog.append(form);dialog.showModal();title.focus();
 }

 /* --- встреча --- */
 async function renderMeetingForm(){
  const host=panels.meeting;host.replaceChildren();const cat=await ensureCatalog();
  host.append(el('h2','','Встреча в один клик'),el('p','pulse-muted','Черновик слайдов из групповых инцидентов, сдвигов и срочных сигналов. Заголовки и выводы можно править прямо на слайдах, затем выгрузить PPTX.'));
  const row=el('div','pulse-form-grid'),product=field(row,'Продукт','select');product.add(new Option('Все продукты',''));for(const p of cat.products)product.add(new Option(p,p));
  const limit=field(row,'Тем, не больше','number',{min:'1',max:'10',value:'5'});
  const go=button('Собрать черновик',null,'pulse-btn accent'),line=el('p','pulse-status'),deck=el('div','pulse-deck');line.setAttribute('role','status');
  go.onclick=()=>busy(go,line,async()=>{meetingStarted=Date.now();const data=await post({action:'meeting',product:product.value||null,limit:Number(limit.value)||5});renderDeck(deck,data);});
  host.append(row,go,line,deck);
 }
 const TEMPLATES={dark:{name:'Тёмный',bg:'111111',fg:'EDEDED',muted:'9A9A9A',card:'1F1F1F',plot:'181818'},light:{name:'Светлый',bg:'FFFFFF',fg:'1C1B19',muted:'716E67',card:'F3F2EE',plot:'FFFFFF'},brand:{name:'Фирменный',bg:'FFFFFF',fg:'1C1B19',muted:'716E67',card:'F3F2EE',plot:'FFFFFF',band:true}};
 function brandSettings(){let saved={};try{saved=JSON.parse(localStorage.getItem('pulse-brand')||'{}')||{};}catch{}const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();return {template:saved.template||'dark',accent:saved.accent||(/^#[0-9a-f]{6}$/i.test(accent)?accent:'#ff8a35'),org:saved.org||'',logo:saved.logo||''};}
 function saveBrand(value){try{localStorage.setItem('pulse-brand',JSON.stringify(value));}catch{}}
 let meetingStarted=null;
 function logExport(format){if(!meetingStarted)return;post({action:'journal-add',kind:'meeting-exported',seconds:Math.round((Date.now()-meetingStarted)/1000),format}).catch(()=>{});}
 function renderDeck(host,data){
  host.replaceChildren();const brand=brandSettings();
  const options=el('div','pulse-form-grid pulse-deck-options');
  const template=field(options,'Шаблон','select');for(const [key,t] of Object.entries(TEMPLATES))template.add(new Option(t.name,key));template.value=brand.template;
  const accent=field(options,'Акцентный цвет','color');accent.value=brand.accent;
  const org=field(options,'Название на слайдах','text',{maxlength:'60',placeholder:'например, название подразделения'});org.value=brand.org;
  const logo=field(options,'Логотип (PNG, до 300 КБ)','file',{accept:'image/png,image/jpeg'});
  const actions=el('div','pulse-row'),line=el('p','pulse-status');line.setAttribute('role','status');
  const deck=el('div','pulse-deck-slides');host.append(el('p','pulse-muted',data.note),options,actions,line,deck);
  const slides=[];
  function applyLook(){brand.template=template.value;brand.accent=accent.value;brand.org=org.value.trim();saveBrand(brand);deck.dataset.tpl=brand.template;deck.style.setProperty('--accent',brand.accent);deck.querySelectorAll('.pulse-slide-band').forEach(b=>{b.hidden=brand.template!=='brand';b.querySelector('span').textContent=brand.org;const img=b.querySelector('img');img.hidden=!brand.logo;if(brand.logo)img.src=brand.logo;});}
  data.slides.forEach((s,i)=>{const slide=el('article','pulse-slide '+s.kind);const band=el('div','pulse-slide-band'),bandImg=el('img'),bandText=el('span');bandImg.alt='';band.append(bandImg,bandText);
   const t=el('h3','',s.title),sub=el('p','pulse-muted',s.subtitle);t.contentEditable='true';sub.contentEditable='true';
   slide.append(band,el('span','pulse-slide-no',String(i+1)),t,sub);
   if(s.kpis?.length){const k=el('div','pulse-kpis');for(const [a,b] of s.kpis){const tile=el('div','pulse-kpi');tile.append(el('span','pulse-muted',a),el('b','',b));k.append(tile);}slide.append(k);}
   let chart=null;if(s.series){chart=lineChart({series:[{points:s.series,cls:'primary',zeroless:s.metric==='csi'}],marker:s.marker,height:140,format:v=>s.metric==='csi'?cf.format(v):nf.format(v)});slide.append(chart);}
   const ul=el('ul');for(const b of s.bullets){const li=el('li','',b);li.contentEditable='true';ul.append(li);}slide.append(ul);
   const concl=el('p','pulse-conclusion',s.conclusion);concl.contentEditable='true';if(s.conclusion||s.kind!=='cover')slide.append(concl);
   deck.append(slide);slides.push({source:s,slide,t,sub,ul,concl,chart});});
  const read=()=>slides.map(({source,t,sub,ul,concl})=>({...source,title:t.textContent.trim(),subtitle:sub.textContent.trim(),bullets:[...ul.children].map(li=>li.textContent.trim()).filter(Boolean),conclusion:concl.textContent.trim()}));
  template.onchange=accent.oninput=org.oninput=applyLook;
  logo.onchange=()=>{const file=logo.files[0];if(!file)return;if(file.size>300*1024){line.textContent='Логотип больше 300 КБ — выберите файл меньше.';line.classList.add('is-error');return;}const reader=new FileReader();reader.onload=()=>{brand.logo=String(reader.result);line.textContent='Логотип добавлен.';line.classList.remove('is-error');applyLook();};reader.readAsDataURL(file);};
  actions.append(button('Скачать PPTX',e=>busy(e.target,line,async()=>{await exportPptx(read(),data,brand);logExport('pptx');line.textContent='PPTX скачан: шаблон «'+TEMPLATES[brand.template].name+'».';}),'pulse-btn accent'),
   button('Письмо (.eml)',e=>busy(e.target,line,async()=>{const images=[];for(const item of slides)images.push(item.chart?await svgToPng(item.chart.querySelector('svg'),'#ffffff'):null);const content=read();download('pulse-'+String(data.revision).slice(0,8)+'.eml',buildEml(content[0].title+' · '+content[0].subtitle,content,images,brand.accent),'message/rfc822');logExport('eml');line.textContent='Письмо скачано: откройте файл — это черновик в почтовой программе.';})),
   button('Текст для мессенджера',e=>busy(e.target,line,async()=>{const text=read().map(s=>s.title+(s.subtitle?' — '+s.subtitle:'')+'\n'+s.bullets.map(b=>'• '+b).join('\n')+(s.conclusion?'\nВывод: '+s.conclusion:'')).join('\n\n');await navigator.clipboard.writeText(text);line.textContent='Текст скопирован в буфер обмена.';})),
   button('Печать / PDF',()=>printDeck(deck),'pulse-btn ghost'));
  applyLook();
 }
 function exportPptx(slides,data,brand){
  if(!window.PptxGenJS)throw new Error('Модуль PPTX не загружен.');
  const tpl=TEMPLATES[brand.template]||TEMPLATES.dark,accent=brand.accent.replace('#','').toUpperCase();
  const pptx=new window.PptxGenJS();pptx.layout='LAYOUT_WIDE';
  for(const s of slides){
   const slide=pptx.addSlide();slide.background={color:tpl.bg};let top=.35;
   if(tpl.band){slide.addShape(pptx.ShapeType.rect,{x:0,y:0,w:13.33,h:.55,fill:{color:accent},line:{color:accent}});if(brand.logo)slide.addImage({data:brand.logo,x:.35,y:.08,w:.4,h:.4});if(brand.org)slide.addText(brand.org,{x:brand.logo?.85:.5,y:.08,w:9,h:.4,fontSize:13,bold:true,color:'FFFFFF',fontFace:'Arial'});top=.8;}
   slide.addText(s.title,{x:.5,y:top,w:12.3,h:.7,fontSize:s.kind==='cover'?32:24,bold:true,color:tpl.fg,fontFace:'Arial'});
   slide.addText(s.subtitle||'',{x:.5,y:top+.7,w:12.3,h:.4,fontSize:13,color:tpl.muted,fontFace:'Arial'});
   let y=top+1.25;
   if(s.kpis?.length){s.kpis.slice(0,4).forEach(([a,b],i)=>{slide.addText([{text:a+'\n',options:{fontSize:11,color:tpl.muted}},{text:String(b),options:{fontSize:20,bold:true,color:accent}}],{x:.5+i*3.1,y,w:3,h:.9,fontFace:'Arial',fill:{color:tpl.card},margin:8});});y+=1.1;}
   if(s.series?.length>1){const labels=s.series.map(p=>p[0].slice(5)),values=s.series.map(p=>p[1]);slide.addChart(pptx.ChartType.line,[{name:s.title,labels,values}],{x:.5,y,w:7.6,h:3.0,lineSize:2,chartColors:[accent],catAxisLabelColor:tpl.muted,valAxisLabelColor:tpl.muted,catAxisLabelFontSize:8,valAxisLabelFontSize:9,showLegend:false,plotArea:{fill:{color:tpl.plot}}});
    slide.addText(s.bullets.map(b=>({text:b,options:{bullet:true,breakLine:true}})),{x:8.3,y,w:4.5,h:3.0,fontSize:12,color:tpl.fg,fontFace:'Arial',valign:'top'});y+=3.2;}
   else if(s.bullets.length){slide.addText(s.bullets.map(b=>({text:b,options:{bullet:true,breakLine:true}})),{x:.5,y,w:12.3,h:3.4,fontSize:14,color:tpl.fg,fontFace:'Arial',valign:'top'});y+=3.6;}
   if(s.conclusion)slide.addText('Вывод: '+s.conclusion,{x:.5,y:Math.min(y,6.6),w:12.3,h:.6,fontSize:13,bold:true,color:accent,fontFace:'Arial'});
  }
  return pptx.writeFile({fileName:'meeting-'+(data.product||'all')+'-'+brand.template+'-'+String(data.revision).slice(0,8)+'.pptx'});
 }
 function printDeck(host){const w=window.open('','_blank');if(!w)return alert('Разрешите всплывающие окна для печати.');const css=[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>'<link rel="stylesheet" href="'+l.href+'">').join('');const root=document.documentElement;w.document.write('<!doctype html><html lang="ru" data-theme="'+(root.dataset.theme||'dark')+'" style="'+root.style.cssText.replace(/"/g,'&quot;')+'"><head><meta charset="utf-8"><title>Встреча</title>'+css+'</head><body class="pulse-print"><div class="pulse-deck-slides" data-tpl="'+(host.dataset.tpl||'dark')+'" style="'+host.style.cssText.replace(/"/g,'&quot;')+'">'+host.innerHTML+'</div></body></html>');w.document.close();setTimeout(()=>w.print(),500);}

 /* --- сравнение --- */
 const compareState={items:[],metric:'answers',days:60,index:false};
 async function renderCompare(){
  const host=panels.compare;host.replaceChildren();const cat=await ensureCatalog();
  host.append(el('h2','','Сравнение'),el('p','pulse-muted','Добавьте до пяти опросов или продуктов. Линии накладываются на один график; нажмите на любую точку, чтобы получить объяснение.'));
  const add=el('form','pulse-form-grid pulse-compare-add');
  const channel=field(add,'Канал','select');channel.add(new Option('Пуш + СМС','communication'));channel.add(new Option('Экран успеха','success_screen'));
  const survey=field(add,'Опрос (номер)','number',{min:'1',placeholder:'например, 1427'});
  const product=field(add,'или продукт','select');product.add(new Option('—',''));for(const p of cat.products)product.add(new Option(p,p));
  const addButton=button('Добавить');addButton.type='submit';const addWrap=el('div','pulse-field');addWrap.append(el('span','',' '),addButton);add.append(addWrap);
  const chips=el('div','pulse-row pulse-chips'),controls=el('div','pulse-row');
  const metric=el('select');for(const [k,v] of [['answers','Ответы'],['sends','Отправки'],['responseRate','Отклик, %'],['csi','CSI'],['events','События']])metric.add(new Option(v,k));metric.value=compareState.metric;metric.setAttribute('aria-label','Показатель');
  const days=el('select');for(const d of [14,30,60,90])days.add(new Option(d+' дней',String(d)));days.value=String(compareState.days);days.setAttribute('aria-label','Период');
  const indexLabel=el('label','pulse-check'),indexBox=el('input');indexBox.type='checkbox';indexBox.checked=compareState.index;indexLabel.append(indexBox,document.createTextNode(' Индекс: первая неделя = 100'));
  controls.append(metric,days,indexLabel);
  const line=el('p','pulse-status'),out=el('div','pulse-output'),steps=el('div','pulse-steps-host'),pointOut=el('div','pulse-output');line.setAttribute('role','status');
  const quick=el('div','pulse-row');quick.append(el('span','pulse-muted','Быстро:'));for(const p of cat.products.slice(0,6))quick.append(button(p,()=>{push({channel:channel.value,product:p,label:p});},'pulse-btn ghost'));
  function push(item){if(compareState.items.length>=5){line.textContent='Не больше пяти объектов.';return;}if(compareState.items.some(x=>x.channel===item.channel&&x.id===item.id&&x.product===item.product))return;compareState.items.push(item);run();}
  function drawChips(){chips.replaceChildren();compareState.items.forEach((item,i)=>{const chip=el('span','pulse-chip c'+i%5);chip.append(el('i'),document.createTextNode(item.label+' '));const x=button('×',()=>{compareState.items.splice(i,1);run();},'pulse-chip-x');x.setAttribute('aria-label','Убрать '+item.label);chip.append(x);chips.append(chip);});}
  async function run(){
   drawChips();compareState.metric=metric.value;compareState.days=Number(days.value);compareState.index=indexBox.checked;pointOut.replaceChildren();steps.replaceChildren();
   if(!compareState.items.length){out.replaceChildren(el('p','pulse-empty','Добавьте первый опрос или продукт.'));return;}
   line.textContent='Считаем…';line.classList.remove('is-error');
   try{const data=await post({action:'compare',metric:compareState.metric,days:compareState.days,items:compareState.items.map(i=>({channel:i.channel,id:i.id??null,product:i.product??null}))});line.textContent='';data.items.forEach((item,i)=>{compareState.items[i].label=item.label;});drawChips();draw(data);}
   catch(error){line.textContent=error.message;line.classList.add('is-error');}
  }
  function draw(data){
   out.replaceChildren();const rate=data.metric==='csi'||data.metric==='responseRate',f=v=>data.metric==='csi'?cf.format(v):data.metric==='responseRate'?df.format(v)+'%':nf.format(v);
   const series=data.items.map(item=>{let points=item.series;if(compareState.index&&points.length){const head=points.slice(0,7),base=head.reduce((a,p)=>a+p[1],0)/head.length;points=base?points.map(p=>[p[0],p[1]/base*100]):points;}return {name:item.label,points,zeroless:compareState.index||rate,item};});
   out.append(lineChart({series,height:260,format:compareState.index?v=>nf.format(v):f,label:'Сравнение: '+data.label,
    onPoint:(date,value,si,s)=>openPoint(pointOut,steps,{channel:s.item.channel,id:s.item.id,product:s.item.product,metric:data.metric,date,title:s.item.label+' · '+dateLabel(date)},line)}));
   if(data.conclusion)out.append(el('p','pulse-summary',data.conclusion));
   const table=el('table','pulse-table'),head=el('tr');for(const h of ['Объект',rate?'За период':'Всего за период','Изменение за период','Последние 7 дней','Изменение за неделю'])head.append(el('th','',h));table.append(head);
   data.items.forEach((item,i)=>{const r=el('tr'),name=el('td');const dot=el('span','pulse-chip c'+i%5);dot.append(el('i'));name.append(dot,document.createTextNode(item.label+(item.surveys>1?' · опросов: '+item.surveys:'')));
    const unit=data.metric==='csi'?' балла':' п.п.',chg=(rel,dlt)=>rel!==null&&rel!==undefined?signed(rel):dlt!==null&&dlt!==undefined?signed(dlt,unit):'—';const period=el('td','',chg(item.periodRelative,item.periodDelta));if((item.periodRelative??item.periodDelta??0)<0)period.classList.add('bad');
    r.append(name,el('td','',item.total===null?'—':f(item.total)),period,el('td','',item.current===null?'—':f(item.current)),el('td','',chg(item.relative,item.delta)));table.append(r);});
   out.append(table,el('p','pulse-muted',data.method));
  }
  add.onsubmit=e=>{e.preventDefault();if(survey.value){const id=Number(survey.value);const found=cat.surveys.find(s=>s.id===id&&s.channel===channel.value);push({channel:channel.value,id,label:'#'+id+(found?' · '+found.name:'')});survey.value='';}else if(product.value){push({channel:channel.value,product:product.value,label:product.value});product.value='';}};
  metric.onchange=days.onchange=indexBox.onchange=run;
  host.append(add,quick,chips,controls,line,out,steps,pointOut);run();
 }

 /* --- режим показа --- */
 let showOverlay=null;
 function closeShow(){if(!showOverlay)return;showOverlay.remove();showOverlay=null;chartHostWidth=null;document.removeEventListener('keydown',showKeys);if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});}
 let showKeys=()=>{};
 function showMode(){
  if(!brief||brief.empty)return;closeShow();
  const slides=[];
  slides.push(()=>{const s=el('div','show-body'),items=decisionProblems(),notes=new Map((brief.narrative?.items||[]).map(i=>[i.key,i.note]));s.append(el('p','pulse-eyebrow','Пульс дня · мой фокус · '+(brief.focus?.total||0)+' опросов'),el('h1','',brief.narrative?.status||headline()));const ul=el('ul','show-bullets');for(const p of items.slice(0,5)){const li=el('li');li.append(el('b','',p.title+': '),document.createTextNode(p.line));const n=notes.get(p.key)||p.hint;if(n)li.append(el('div','pulse-muted',n));ul.append(li);}if(items.length)s.append(ul);const bank=el('div','pulse-bank');for(const b of brief.bank||[])bank.append(el('span','pulse-bank-chip '+(b.alert?'bad':'ok'),b.label+(b.alert?': '+b.reasons.join(', '):': без существенных изменений')));s.append(bank);return s;});
  if(brief.changes&&(brief.changes.counts.added||brief.changes.counts.worse||brief.changes.counts.resolved))slides.push(()=>changesCard());
  for(const c of brief.clusters.slice(0,3))slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Групповой инцидент'),clusterCard(c));for(const m of c.members.slice(0,2)){const full=brief.shifts.find(x=>x.id===m.id&&x.metric===c.metric);if(full)s.append(shiftCard(full));}return s;});
  const inCluster=new Set(brief.clusters.flatMap(c=>c.members.map(m=>m.id+':'+c.metric)));
  for(const sft of brief.shifts.filter(x=>!inCluster.has(x.id+':'+x.metric)).slice(0,5))slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow',sft.direction==='down'?'Устойчивое снижение':'Устойчивый рост'),shiftCard(sft));return s;});
  if(brief.signals.length)slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Сигналы недельного сравнения'),el('h1','','Что случилось на этой неделе'));for(const g of brief.signals.slice(0,6)){const card=el('article','pulse-card pulse-signal '+g.severity);card.append(el('span','pulse-tag '+(g.severity==='urgent'?'bad':''),g.severity==='urgent'?'Срочно':'Внимание'),el('h3','','#'+g.id+' · '+g.name),el('p','',g.reasons.join(' · ')));s.append(card);}return s;});
  slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Что дальше'),el('h1','','От отклонения — к решению'));const row=el('div','pulse-row');row.append(button('Смоделировать «что если»',()=>{closeShow();select('whatif');},'pulse-btn accent'),button('Сравнить опросы и продукты',()=>{closeShow();select('compare');}),button('Собрать презентацию',()=>{closeShow();select('meeting');}));s.append(row);return s;});
  openShow(slides,'Режим показа',0);
 }
 function openShow(slides,label,start){
  closeShow();let index=start||0;const overlay=el('div','pulse-show'),stage=el('div','show-stage'),bar=el('div','show-bar'),counter=el('span','show-counter'),dots=el('div','show-dots');
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label',label);
  const prev=button('← Назад',()=>go(index-1),'pulse-btn ghost'),next=button('Дальше →',()=>go(index+1),'pulse-btn accent'),close=button('Закрыть',closeShow,'pulse-btn ghost');
  bar.append(prev,dots,counter,next,close);overlay.append(stage,bar);document.body.append(overlay);showOverlay=overlay;
  function go(i){index=Math.max(0,Math.min(slides.length-1,i));chartHostWidth=Math.min(stage.clientWidth,1180);stage.replaceChildren(slides[index]());stage.scrollTop=0;counter.textContent=(index+1)+' / '+slides.length;prev.disabled=index===0;next.disabled=index===slides.length-1;dots.replaceChildren(...slides.map((_,k)=>{const d=el('i',k===index?'on':'');d.onclick=()=>go(k);return d;}));}
  showKeys=e=>{if(e.target.closest?.('input,textarea,select,[contenteditable=true]'))return;if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();go(index+1);}else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(index-1);}else if(e.key==='Escape'){closeShow();}};
  document.addEventListener('keydown',showKeys);
  document.documentElement.requestFullscreen?.().catch(()=>{}).finally(()=>setTimeout(()=>go(index),150));go(index);
 }

 /* --- чувствительность, сдвиги, кластеры (на клиенте, мгновенно) --- */
 let sensOverride=null,shiftsHost=null,clustersHost=null,cardsByKey=new Map();
 const levels=()=>brief.sensitivity||{'':1};
 function levelFor(s){const own=(s.products||[]).map(p=>levels()[p]).filter(v=>v!==undefined);let base=own.length?Math.min(...own):(levels()['']??1);if(sensOverride){if(sensOverride.product){if((s.products||[]).includes(sensOverride.product))base=sensOverride.level;}else if(!own.length)base=sensOverride.level;}return base;}
 const visibleShifts=()=>(brief.candidates||brief.shifts||[]).filter(s=>s.strength===undefined||s.strength>=levelFor(s)-1e-9);
 function clientClusters(shifts){
  const groups=[];
  for(const s of [...shifts].sort((a,b)=>a.date<b.date?-1:1)){const d=Date.parse(s.date);const g=groups.find(g=>g.metric===s.metric&&g.direction===s.direction&&g.channel===s.channel&&Math.abs(d-g.anchor)<=2*864e5);if(g)g.members.push(s);else groups.push({metric:s.metric,direction:s.direction,channel:s.channel,channelLabel:s.channelLabel,anchor:d,members:[s],label:s.label});}
  return groups.filter(g=>new Set(g.members.map(m=>m.id)).size>=2).map(g=>{const dates=g.members.map(m=>m.date).sort(),prod={};for(const m of g.members)for(const p of (m.products?.length?m.products:['без продукта']))prod[p]=(prod[p]||0)+1;
   return {...g,from:dates[0],to:dates.at(-1),products:Object.entries(prod).sort((a,b)=>b[1]-a[1]),title:(g.direction==='down'?'Групповое снижение':'Групповой рост')+': '+g.label.toLowerCase()+' у '+g.members.length+' опросов',hint:'Одновременное изменение у нескольких опросов чаще указывает на общую причину (стоп-лист, загрузка, интеграция), чем на независимые инциденты. Это гипотеза для проверки.'};})
   .sort((a,b)=>(a.direction!=='down')-(b.direction!=='down')||b.members.length-a.members.length);
 }
 function sensitivityBar(){
  const box=el('section','pulse-card pulse-sens'),cat=brief.candidates||[],products=[...new Set(cat.flatMap(s=>s.products||[]))].sort();
  const head=el('div','pulse-row'),count=el('b','pulse-sens-count'),saved=el('span','pulse-muted');head.append(el('span','pulse-eyebrow','Чувствительность сигналов'),count,saved);
  const row=el('div','pulse-sens-row'),label1=el('span','pulse-muted','Мягче — больше сигналов'),label2=el('span','pulse-muted','Строже — только сильные');
  const range=el('input');range.type='range';range.min='0.6';range.max='2';range.step='0.05';range.setAttribute('aria-label','Чувствительность сигналов');
  const scope=el('select');scope.setAttribute('aria-label','Для какого продукта');scope.add(new Option('Все продукты',''));for(const p of products)scope.add(new Option(p,p));
  row.append(label1,range,label2,scope);
  const actions=el('div','pulse-row'),line=el('p','pulse-status');line.setAttribute('role','status');
  const save=button('Сохранить',e=>busy(e.target,line,async()=>{await post({action:'settings',sensitivity:Number(range.value),product:scope.value});sensOverride=null;brief=await post({action:'brief'});renderBrief();status.textContent='Чувствительность сохранена'+(scope.value?' для продукта «'+scope.value+'»':' для всех продуктов')+'.';}),'pulse-btn accent');
  const reset=button('Сбросить',e=>busy(e.target,line,async()=>{await post({action:'settings',sensitivity:null,reset:true,product:scope.value});sensOverride=null;brief=await post({action:'brief'});renderBrief();}),'pulse-btn ghost');
  actions.append(save,reset,el('span','pulse-muted','Порог «1,0» — исходные правила: от 25% (CSI — от 0,25 балла). Сдвиги ищутся заранее, ползунок только отбирает — без пересчёта.'));
  function sync(){const level=Number(range.value);sensOverride={level,product:scope.value};const vis=visibleShifts();count.textContent='Сдвигов: '+vis.length+' из '+cat.length+' кандидатов · порог '+df.format(level);renderShiftSections(vis);}
  function setFrom(){const v=scope.value?(levels()[scope.value]??levels()['']??1):(levels()['']??1);range.value=String(v);const own=Object.entries(levels()).filter(([k])=>k).map(([k,v])=>k+': '+df.format(v));saved.textContent='сохранено: все — '+df.format(levels()['']??1)+(own.length?' · '+own.join(' · '):'');sync();}
  range.addEventListener('input',sync);scope.addEventListener('change',setFrom);
  box.append(head,row,actions,line);setTimeout(setFrom,0);return box;
 }
 function renderShiftSections(vis){
  if(!shiftsHost)return;cardsByKey=new Map();
  const clusters=clientClusters(vis);clustersHost.replaceChildren();
  if(clusters.length){clustersHost.append(el('h2','','Групповые инциденты · '+clusters.length),el('p','pulse-muted','Однотипные сдвиги у нескольких опросов в пределах двух дней. Вероятна общая причина — проверьте её один раз, а не по каждому опросу.'));for(const c of clusters)clustersHost.append(clusterCard(c));}
  shiftsHost.replaceChildren(el('h2','','Сдвиги уровня за 8 недель · '+vis.length),el('p','pulse-muted','Устойчивая ступень в дневном ряду: минимум 7 дней до и после и подтверждение в последние 7 дней. Пропуски не считаются нулями. Флажки на графике — события календаря; нажмите, чтобы увидеть, что сдвинулось после них.'));
  if(!vis.length)shiftsHost.append(el('p','pulse-empty','Устойчивых сдвигов при этом пороге нет.'));
  for(const s of vis){const card=shiftCard(s);cardsByKey.set(s.key,card);shiftsHost.append(card);}
 }
 function eventsFor(channel,ids){return (brief?.events||[]).filter(ev=>(!ev.channel||!channel||ev.channel===channel)&&(!ev.ids?.length||ids.some(i=>ev.ids.includes(i))));}
 async function renderImpact(host,ev,line){
  return busy(document.createElement('button'),line,async()=>{
   const data=await post({action:'event-impact',date:ev.date,ids:ev.ids||[],channel:ev.channel||null});
   host.replaceChildren();const box=el('div','pulse-subcard pulse-impact');
   box.append(el('h4','','Событие '+dateLabel(ev.date)+' · '+ev.title),el('p','pulse-muted',(ev.note?ev.note+' · ':'')+data.scope),el('p','pulse-summary',data.summary));
   const table=el('table','pulse-table'),head=el('tr');for(const h of ['Опрос','Показатель','7 дней до','7 дней после','Изменение'])head.append(el('th','',h));table.append(head);
   for(const r of data.rows.slice(0,12)){const tr=el('tr'),f=v=>r.metric==='csi'?cf.format(v):nf.format(v),c=el('td','',r.relative!==null?signed(r.relative):signed(r.delta,' балла'));if(r.strong)c.classList.add((r.relative??r.delta)<0?'bad':'good');tr.append(el('td','','#'+r.id+' · '+r.name),el('td','',r.label),el('td','',f(r.before)),el('td','',f(r.after)),c);table.append(tr);}
   if(!data.rows.length)box.append(el('p','pulse-empty','Недостаточно дней до и после события.'));else box.append(table);
   box.append(el('p','pulse-muted',data.method));host.append(box);
  });
 }
 function eventForm(ctx,out,line){
  const box=el('details','pulse-event-form');box.append(el('summary','','Отметить событие в эту дату'));
  const row=el('div','pulse-row'),title=el('input'),kind=el('select');title.type='text';title.maxLength=160;title.placeholder='Что изменили, например: «новая версия анкеты»';title.setAttribute('aria-label','Название события');
  for(const [v,n] of [['other','Изменение'],['campaign','Кампания'],['policy','Правила / стоп-лист'],['incident','Сбой']])kind.add(new Option(n,v));kind.setAttribute('aria-label','Тип события');
  const save=button('Поставить отметку',e=>{if(!title.value.trim()){title.focus();return;}busy(e.target,line,async()=>{const res=await post({action:'event-add',title:title.value,date:ctx.date,id:ctx.id??null,channel:ctx.channel,kind:kind.value});brief.events=res.events;const key=ctx.key;renderShiftSections(visibleShifts());const card=key&&cardsByKey.get(key);const ev={date:ctx.date,title:title.value,ids:ctx.id?[ctx.id]:[],channel:ctx.channel};if(card){card.scrollIntoView({block:'center'});const target=card.querySelector('.pulse-output'),l=card.querySelector('.pulse-status');await renderImpact(target,ev,l);l.textContent='Отметка «'+ev.title+'» добавлена на графики и в календарь запусков.';}else{await renderImpact(out,ev,line);line.textContent='Отметка добавлена в календарь запусков.';}});},'pulse-btn accent');
  row.append(title,kind,save);box.append(row);return box;
 }
 /* --- оценка AI-разбора и проверка защиты --- */
 function verdictRow(target,canned){
  const row=el('div','pulse-row pulse-verdict');row.append(el('span','pulse-muted','Разбор полезен?'));
  const done=v=>busy(document.createElement('button'),null,async()=>{await post({action:'journal-add',kind:'ai-verdict',verdict:v,target,canned:Boolean(canned)});row.replaceChildren(el('span','pulse-trust','Оценка записана в журнал эффекта: '+({accepted:'принято',edited:'нужно исправить',rejected:'отклонено'}[v])+'.'));});
  row.append(button('Принять',()=>done('accepted'),'pulse-btn'),button('Исправить',()=>done('edited'),'pulse-btn ghost'),button('Отклонить',()=>done('rejected'),'pulse-btn ghost'));
  return row;
 }
 function trustDemo(ref){
  const wrap=el('div','pulse-trust-demo'),line=el('p','pulse-status');line.setAttribute('role','status');
  const go=button('Проверить защиту: подставить выдуманное число',e=>busy(e.target,line,async()=>{
   const r=await post({action:'trust-demo',...ref});wrap.querySelector('.pulse-trust-result')?.remove();const box=el('div','pulse-trust-result');
   for(const [label,item] of [['Ответ по фактам',r.honest],['Ответ с выдуманным числом',r.tampered]]){const ok=item.outcome==='accepted';const rowEl=el('div','pulse-trust-row '+(ok?'good':'bad'));rowEl.append(el('b','',(ok?'✓ Принят · ':'✕ Отклонён · ')+label),el('p','','«'+item.text+'»'));if(item.reason)rowEl.append(el('p','pulse-muted',item.reason));box.append(rowEl);}
   box.append(el('p','pulse-muted','Так же проверяется каждый ответ GigaCode: любое число, которого нет среди фактов F…, отклоняет ответ целиком. Проверка записана в журнал эффекта.'));wrap.append(box);}),'pulse-btn ghost');
  wrap.append(go,line);return wrap;
 }
 /* --- галерея вопросов и скилы --- */
 const GALLERY=[
  {role:'Руководитель',name:'Утренний мониторинг продукта',ai:true,query:'Собери утренний мониторинг руководителю продукта {продукт} на пять минут: выяви отклонения и расставь приоритеты проверок'},
  {role:'Руководитель',name:'План ответов под угрозой',query:'Что если по продукту {продукт} отправки упадут на 20%?',kind:'whatif'},
  {role:'Руководитель',name:'Ответы и CSI продукта за месяц',query:'Покажи ответы и CSI по продукту {продукт} за последние 30 дней'},
  {role:'Руководитель',name:'Качество обратной связи падает',ai:true,query:'Найди опросы, где много ответов, но ухудшается качество обратной связи'},
  {role:'Аналитик',name:'Разбор: отправки выросли, ответы упали',ai:true,query:'Разбери проблему по продукту {продукт}: отправки выросли, ответы упали. Сравни сопоставимые дни'},
  {role:'Аналитик',name:'Стоп-листы и политика контактов',query:'Покажи по опросу {опрос} отсечения по стоп листам и политике контактов'},
  {role:'Аналитик',name:'Почему упали ответы за неделю',query:'Почему упали ответы по опросу {опрос} за последние 7 дней?'},
  {role:'Аналитик',name:'Уникальные опросы по месяцам',query:'Покажи количество опросов уникальных по месяцам с начала 2026 года'},
  {role:'Владелец опроса',name:'Мой опрос за 3 месяца',query:'Покажи отправки, ответы и CSI по опросу {опрос} за последние 3 месяца по дням'},
  {role:'Владелец опроса',name:'Что изменилось за неделю',query:'Почему изменились ответы по опросу {опрос} за последние 7 дней?'},
  {role:'Владелец опроса',name:'Хватит ли темпа до конца месяца',query:'Что если по опросу {опрос} отклик упадёт до 3%?',kind:'whatif'},
 ];
 const paramDialog=el('dialog','pulse-dialog');document.body.append(paramDialog);
 async function fillParams(query){
  const need=[...new Set(query.match(/\{(продукт|опрос)\}/g)||[])];if(!need.length)return query;const cat=await ensureCatalog();
  return new Promise(resolve=>{paramDialog.replaceChildren();const form=el('form');form.method='dialog';form.append(el('h2','','Параметры скила'),el('p','pulse-muted',query));const inputs={};
   for(const token of need){if(token==='{продукт}'){const s=field(form,'Продукт','select');for(const p of cat.products)s.add(new Option(p,p));inputs[token]=s;}else{const s=field(form,'Опрос','select');for(const v of cat.surveys)s.add(new Option('#'+v.id+' · '+v.name,String(v.id)));inputs[token]=s;}}
   const row=el('div','pulse-row'),ok=button('Запустить',null,'pulse-btn accent');ok.type='submit';row.append(ok,button('Отмена',()=>{paramDialog.close();resolve(null);},'pulse-btn ghost'));form.append(row);
   form.onsubmit=e=>{e.preventDefault();let q=query;for(const [t,s] of Object.entries(inputs))q=q.split(t).join(s.value);paramDialog.close();resolve(q);};paramDialog.append(form);paramDialog.showModal();});
 }
 async function runSkill(skill){const q=await fillParams(skill.query);if(!q)return;post({action:'skill-run',skillId:skill.id||null,builtin:skill.id?null:skill.name}).catch(()=>{});if(skill.kind==='whatif'||/^что если/i.test(q))api().whatif(q);else askDialog(q);}
 async function saveSkill(preset={}){
  paramDialog.replaceChildren();const form=el('form');form.method='dialog';form.append(el('h2','','Сохранить как скил'),el('p','pulse-muted','Скил — повторяемый запрос. Замените номер опроса или продукт на {опрос} или {продукт}, чтобы выбирать их при запуске.'));
  const name=field(form,'Название','text',{maxlength:'120',required:''});name.value=preset.name||'';const query=field(form,'Запрос','textarea',{maxlength:'1200',rows:'3',required:''});query.value=preset.query||'';
  const role=field(form,'Для кого','select');for(const r of ['Все','Руководитель','Аналитик','Владелец опроса'])role.add(new Option(r,r));
  const line=el('p','pulse-status'),row=el('div','pulse-row'),ok=button('Сохранить',null,'pulse-btn accent');ok.type='submit';row.append(ok,button('Отмена',()=>paramDialog.close(),'pulse-btn ghost'));form.append(row,line);
  form.onsubmit=e=>{e.preventDefault();busy(ok,line,async()=>{await post({action:'skill-save',name:name.value,query:query.value,role:role.value});paramDialog.close();skillsCache=null;if(tab==='skills')renderSkills();status.textContent='Скил «'+name.value+'» сохранён — он в «Скилах» и в Ctrl+K.';});};
  paramDialog.append(form);paramDialog.showModal();name.focus();
 }
 let skillsCache=null,skillRole='Все';
 async function renderSkills(){
  const host=panels.skills;host.replaceChildren(el('h2','','Скилы и галерея вопросов'),el('p','pulse-muted','Готовые вопросы по ролям и сохранённые скилы команды. Запуск одним кликом; параметры {продукт} и {опрос} выбираются при запуске.'));
  const roles=el('div','pulse-row');for(const r of ['Все','Руководитель','Аналитик','Владелец опроса']){const b=button(r,()=>{skillRole=r;renderSkills();},'pulse-btn'+(skillRole===r?' accent':' ghost'));b.setAttribute('aria-pressed',String(skillRole===r));roles.append(b);}
  roles.append(button('＋ Новый скил',()=>saveSkill(),'pulse-btn'));host.append(roles);
  try{if(!skillsCache)skillsCache=(await post({action:'skills'})).skills;}catch{skillsCache=[];}
  const mine=skillsCache.filter(s=>skillRole==='Все'||s.role===skillRole||s.role==='Все');
  if(mine.length){const sec=el('section','pulse-section');sec.append(el('h3','','Скилы команды · '+mine.length));const grid=el('div','pulse-skill-grid');for(const s of mine){const card=el('article','pulse-card pulse-skill mine');card.append(el('span','pulse-tag',s.role),el('h3','',s.name),el('p','pulse-muted',s.query),el('p','pulse-muted','Запусков: '+(s.runs||0)+(s.lastRun?' · последний '+new Date(s.lastRun).toLocaleDateString('ru-RU'):'')));const r=el('div','pulse-row');r.append(button('Запустить',()=>runSkill(s),'pulse-btn accent'),button('Удалить',e=>{if(!confirm('Удалить скил «'+s.name+'»?'))return;busy(e.target,null,async()=>{await post({action:'skill-delete',skillId:s.id});skillsCache=null;renderSkills();});},'pulse-btn ghost'));card.append(r);grid.append(card);}sec.append(grid);host.append(sec);}
  const sec=el('section','pulse-section');sec.append(el('h3','','Галерея'));const grid=el('div','pulse-skill-grid');
  for(const g of GALLERY.filter(g=>skillRole==='Все'||g.role===skillRole)){const card=el('article','pulse-card pulse-skill');const tags=el('div','pulse-row');tags.append(el('span','pulse-tag',g.role));if(g.ai)tags.append(el('span','pulse-tag warn','нужна GigaCode'));card.append(tags,el('h3','',g.name),el('p','pulse-muted',g.query));const r=el('div','pulse-row');r.append(button('Запустить',()=>runSkill(g),'pulse-btn accent'),button('В мои скилы',()=>saveSkill({name:g.name,query:g.query}),'pulse-btn ghost'));card.append(r);grid.append(card);}
  sec.append(grid);host.append(sec);
 }
 /* --- холсты: один объект вместо разделов. Вопрос создаёт блок, блоки живут на холсте,
        пересчитываются с каждой выгрузкой и сами становятся слайдами и письмом. --- */
 const BLOCK_NAMES={status:'Статус',problems:'Требует решения',kpi:'Показатель',chart:'График',compare:'Сравнение',forecast:'Прогноз плана',signals:'Сигналы',shifts:'Сдвиги',portfolio:'Портфель групп',note:'Заметка'};
 const METRIC_NAMES={answers:'Ответы',sends:'Отправки',responseRate:'Отклик',csi:'CSI',events:'События'};
 const KPI_METRICS={answers:'Ответы за 7 дней',responseRate:'Отклик',csi:'CSI',sends:'Отправки за 7 дней'};
 const CHARTABLE=new Set(['chart','compare']);
 let canvasResize=null,canvasStore=null,canvasEdit=false,pendingBlock=null,canvasSpecs=new Map(),canvasLine=null,canvasFlash='';
 const newUid=()=>(Math.random().toString(36)+'00000000').slice(2,12);
 const activeCanvas=()=>canvasStore?.canvases.find(c=>c.id===canvasStore.active)||canvasStore?.canvases[0]||null;
 const metricFormat=m=>v=>m==='csi'?cf.format(v):m==='responseRate'?df.format(v)+'%':nf.format(v);
 function blockScope(b){if(b.kind==='compare')return (b.items||[]).map(t=>t.id?'#'+t.id:t.product||'все').join(' · ');return b.id?'#'+b.id:b.product||(b.channel==='success_screen'?'экраны успеха':b.kind==='chart'||b.kind==='forecast'?'все опросы':'');}
 function blockTitle(b){if(b.title)return b.title;const m=METRIC_NAMES[b.metric||'answers'];if(b.kind==='chart')return m+' · '+blockScope(b)+' · '+(b.days||60)+' дней';if(b.kind==='compare')return 'Сравнение · '+m.toLowerCase()+' · '+(b.days||60)+' дней';if(b.kind==='forecast')return 'Прогноз плана · '+blockScope(b);if(b.kind==='kpi')return KPI_METRICS[b.metric||'answers']+' · '+(b.channel==='success_screen'?'экран успеха':'пуш + СМС');return BLOCK_NAMES[b.kind];}
 function targetsOf(b){return b.kind==='compare'?(b.items||[]):[{channel:b.channel||'communication',id:b.id??null,product:b.product??null}];}
 /* Параметры холста: связанные блоки (bind) берут объект, период и группировку из параметров; клик по проблеме
    или группе временно фильтрует весь холст (canvasFocus). */
 const BINDABLE=new Set(['chart','compare','forecast','kpi','problems','signals','shifts','portfolio']);
 let canvasFocus=null,pendingPlan=null,teamTemplates=null;
 const sameTarget=(a,b)=>a&&b&&a.channel===b.channel&&(a.id??null)===(b.id??null)&&(a.product??null)===(b.product??null);
 const targetLabel=t=>!t?'все опросы':t.id?'#'+t.id+(catalog?.surveys.find(s=>s.id===t.id&&s.channel===t.channel)?' · '+catalog.surveys.find(s=>s.id===t.id&&s.channel===t.channel).name:''):t.product+(t.channel==='success_screen'?' · экраны успеха':'');
 function canvasTarget(canvas){return canvasFocus&&canvasFocus.canvasId===canvas?.id?canvasFocus.target:canvas?.params?.target||null;}
 function resolveBlock(b,canvas){
  if(!b.bind||!canvas)return b;const p=canvas.params||{},t=canvasTarget(canvas),r={...b};
  if(t){if(['chart','forecast','shifts'].includes(b.kind)){r.channel=t.channel;if(t.id){r.id=t.id;delete r.product;}else{r.product=t.product;delete r.id;}}
   else if(b.kind==='compare'){const rest=(b.items||[]).filter(x=>!sameTarget(x,t));r.items=[t,...rest].slice(0,5);}
   else if(b.kind==='kpi'||b.kind==='portfolio')r.channel=t.channel;
   r._filter=t;}
  if(CHARTABLE.has(b.kind)){if(p.days)r.days=p.days;if(p.grain==='day')delete r.grain;else if(p.grain)r.grain=p.grain;}
  return r;
 }
 function setCanvasFocus(target){const canvas=activeCanvas();if(!canvas)return;canvasFocus=target?{canvasId:canvas.id,target}:null;canvasFlash=target?'Холст отфильтрован: '+targetLabel(target)+'. Связанные блоки пересчитаны.':'';renderCanvas();}
 function canvasTemplates(cat){
  const product=cat.products[0]||null,focus=brief&&!brief.empty?decisionProblems().slice(0,3):[];
  const incident=focus.length?focus.map(p=>({channel:p.channel,id:p.id,product:null})):[{channel:'communication',id:null,product}];
  const plan=(cat.products.length?cat.products.slice(0,6):[null]).map(p=>({kind:'forecast',channel:'communication',product:p,span:4}));
  return [
   {key:'morning',bindAll:true,name:'Утро · мой фокус',hint:'Статус, проблемы фокуса, прогноз, график и портфель групп',blocks:[{kind:'status',span:12},{kind:'problems',span:8},{kind:'forecast',channel:'communication',span:4},{kind:'chart',metric:'answers',days:60,channel:'communication',product,span:8},{kind:'portfolio',span:4},{kind:'note',span:12,text:'Что решаем сегодня: '}]},
   {key:'incident',bindAll:true,name:'Инцидент',hint:'Проблемные опросы фокуса на одном графике + гипотеза и проверка',blocks:[{kind:'compare',metric:'sends',days:60,index:true,items:incident,span:12},{kind:'compare',metric:'answers',days:60,index:true,items:incident,span:12},{kind:'note',span:6,text:'Гипотеза: '},{kind:'note',span:6,text:'Что проверить и кто: '}]},
   {key:'committee',bindAll:true,name:'Комитет',hint:'Статус, показатели каналов, решения и владельцы',blocks:[{kind:'status',span:12},{kind:'kpi',metric:'answers',channel:'communication',span:3},{kind:'kpi',metric:'csi',channel:'communication',span:3},{kind:'kpi',metric:'answers',channel:'success_screen',span:3},{kind:'kpi',metric:'csi',channel:'success_screen',span:3},{kind:'problems',span:12},{kind:'note',span:12,text:'Решения и владельцы: '}]},
   {key:'plan',bindAll:false,name:'План',hint:'Прогноз выполнения плана по продуктам и портфель',blocks:[...plan,{kind:'portfolio',span:12}]},
   {key:'empty',name:'Пустой холст',hint:'Начните с вопроса в строке холста',blocks:[]},
  ];
 }
 async function saveCanvas(canvas,quiet){
  const r=await post({action:'canvas-save',canvas:{id:canvas.id,name:canvas.name,template:canvas.template||null,blocks:canvas.blocks,params:canvas.params||{}}});
  /* локальный объект холста сохраняет идентичность: открытые блоки продолжают менять именно его */
  const local=canvas.id?canvas:null;canvasStore={canvases:r.canvases.map(x=>local&&x.id===local.id?Object.assign(local,{updated:x.updated}):x),active:r.active};if(!quiet&&canvasLine)canvasLine.textContent='Холст сохранён в папке проекта.';return r.canvas;
 }
 let saveTimer=null;
 function touch(){const c=activeCanvas();if(!c)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveCanvas(c,true).catch(e=>{if(canvasLine){canvasLine.textContent=e.message;canvasLine.classList.add('is-error');}}),400);}
 async function createFromTemplate(t,silent){
  const taken=new Set((canvasStore?.canvases||[]).map(c=>c.name));let name=t.name,n=2;while(taken.has(name))name=t.name+' '+n++;
  const blocks=t.blocks.map(b=>({...b,uid:newUid(),...(BINDABLE.has(b.kind)&&t.bindAll?{bind:true}:{})}));
  await saveCanvas({name,template:t.key,blocks,params:structuredClone(t.params||{})},true);canvasEdit=false;pendingBlock=null;pendingPlan=null;canvasFocus=null;
  if(t.needsTarget||(blocks.some(b=>b.bind)&&!(t.params||{}).target&&t.key!=='morning'&&t.key!=='committee'))canvasFlash='Выберите опрос или продукт в параметрах холста — связанные блоки ⛓ посчитаются для него.';renderCanvas();
 }
 async function openCanvas(id){canvasStore=await post({action:'canvas-open',id});pendingBlock=null;pendingPlan=null;canvasFocus=null;renderCanvas();}
 async function renderCanvas(){
  const host=panels.canvas,cat=await ensureCatalog();
  if(!canvasStore){try{canvasStore=await post({action:'canvas-list'});}catch(error){host.replaceChildren(el('p','pulse-status is-error',error.message));return;}
   if(!canvasStore.canvases.length){await createFromTemplate(canvasTemplates(cat)[0],true);return;}}
  if(!brief){host.replaceChildren(el('p','pulse-muted','Открываем брифинг…'));return;}
  if(brief.empty){host.replaceChildren(el('h2','','Холсты'),el('p','pulse-empty','Загрузите выгрузки (перетащите CSV в окно) — блоки холстов посчитаются по ним.'));return;}
  const canvas=activeCanvas();host.replaceChildren();canvasSpecs=new Map();
  const layout=el('div','canvas-layout'),side=el('nav','canvas-side'),col=el('div','canvas-main');side.setAttribute('aria-label','Мои холсты');
  side.append(el('p','canvas-side-label','Мои холсты'));
  for(const c of canvasStore.canvases){const on=c.id===canvas?.id,b=button('',()=>openCanvas(c.id),'canvas-side-item'+(on?' active':''));b.append(el('span','',c.name),el('small','',String(c.blocks.length)));if(on)b.setAttribute('aria-current','true');side.append(b);}
  const tpl=el('details','canvas-templates');tpl.open=window.innerWidth>850;tpl.append(el('summary','canvas-side-label','Новый из шаблона'));
  for(const t of canvasTemplates(cat)){const b=button('＋ '+t.name,()=>createFromTemplate(t),'canvas-side-item ghost');b.title=t.hint;tpl.append(b);}
  const imp=button('Открыть файл холста или шаблона…',()=>importCanvas(),'canvas-side-item ghost');imp.title='Холст или шаблон, присланный коллегой (.json)';tpl.append(imp);side.append(tpl);
  if(!teamTemplates){try{teamTemplates=(await post({action:'canvas-templates'})).templates;}catch{teamTemplates=[];}}
  const team=el('details','canvas-templates');team.open=window.innerWidth>850;team.append(el('summary','canvas-side-label','Шаблоны команды · '+teamTemplates.length));
  if(!teamTemplates.length)team.append(el('p','canvas-side-hint','Сохраните любой холст как шаблон: «Экспорт ▾ → Сохранить как шаблон команды».'));
  for(const t of teamTemplates){const row=el('div','canvas-team-row'),b=button('＋ '+t.name,()=>createFromTemplate({...t,key:'team'}),'canvas-side-item ghost');b.title=(t.description||'')+(t.author?' · '+t.author:'')+(t.needsTarget?' · объект выбирается после создания':'');const del=button('×',()=>{if(!confirm('Удалить шаблон «'+t.name+'»?'))return;post({action:'canvas-template-delete',id:t.id}).then(r=>{teamTemplates=r.templates;renderCanvas();}).catch(e=>alert(e.message));},'canvas-tbtn');del.setAttribute('aria-label','Удалить шаблон '+t.name);row.append(b,del);team.append(row);}
  side.append(team);
  layout.append(side,col);host.append(layout);
  if(!canvas){col.append(el('p','pulse-empty','Выберите шаблон слева.'));return;}
  const head=el('div','canvas-head'),name=canvasEdit?el('input','canvas-name-input'):el('h2','canvas-name',canvas.name);
  if(canvasEdit){name.value=canvas.name;name.maxLength=80;name.setAttribute('aria-label','Название холста');name.onchange=()=>{if(name.value.trim()){canvas.name=name.value.trim();touch();}};}
  const meta=el('span','pulse-tag',canvas.blocks.length+' '+plural(canvas.blocks.length,'блок','блока','блоков')+' · пересчитывается с каждой выгрузкой');
  const tools=el('div','pulse-row canvas-tools');
  tools.append(button(canvasEdit?'Готово':'Настроить',()=>{canvasEdit=!canvasEdit;renderCanvas();},'pulse-btn'+(canvasEdit?' accent':' ghost')));
  const exp=el('details','canvas-export'),sum=el('summary','pulse-btn ghost','Экспорт ▾'),menu=el('div','canvas-menu');menu.setAttribute('role','menu');exp.append(sum,menu);
  const item=(label,sub,run)=>{const b=button('',e=>{exp.open=false;busy(sum,canvasLine,run);},'canvas-menu-item');b.setAttribute('role','menuitem');b.append(el('span','',label),el('small','',sub));menu.append(b);};
  item('PPTX · фирменный шаблон','слайд на каждый блок, оформление из «Встречи»',()=>exportCanvasPptx(canvas));
  item('Письмо (.eml)','статус, блоки и картинки графиков',()=>exportCanvasEml(canvas));
  item('PDF / печать','холст как есть, на бумагу к комитету',()=>printCanvas(canvas));
  item('Файл холста для коллеги','только устройство холста, без данных: у коллеги блоки посчитаются по его выгрузке',()=>{download('canvas-'+new Date().toISOString().slice(0,10)+'.genui-canvas.json',JSON.stringify({format:'genui-canvas',version:1,name:canvas.name,template:canvas.template||null,params:canvas.params||{},blocks:canvas.blocks},null,1),'application/json');canvasLine.textContent='Файл холста скачан. Данных внутри нет — только блоки.';});
  item('Сохранить как шаблон команды','блоки и параметры без данных; объект выбирается при создании',()=>templateDialog(canvas));
  item('Файл шаблона для коллеги','шаблон можно добавить в «Шаблоны команды» на другом компьютере',()=>{download('template-'+new Date().toISOString().slice(0,10)+'.genui-template.json',JSON.stringify({format:'genui-canvas-template',version:1,name:canvas.name,params:{...(canvas.params||{}),target:undefined},blocks:canvas.blocks.map(({uid,question,...b})=>b)},null,1),'application/json');canvasLine.textContent='Файл шаблона скачан: в нём только устройство холста, без данных и без выбранного объекта.';});
  tools.append(exp,button('▶ Показать',()=>canvasShow(canvas,0),'pulse-btn accent'));
  if(canvasEdit)tools.append(button('Выровнять размеры',()=>{const span=typicalSpan(canvas,'chart');for(const x of canvas.blocks)if(!['status','note','problems','compare','portfolio'].includes(x.kind))x.span=span;canvasFlash='Графики и показатели выровнены: '+({3:'¼',4:'⅓',6:'½',8:'⅔',12:'вся'})[span]+' строки.';touch();renderCanvas();},'pulse-btn ghost'));
  if(canvasEdit)tools.append(button('Удалить холст',e=>{if(!confirm('Удалить холст «'+canvas.name+'»?'))return;busy(e.target,canvasLine,async()=>{canvasStore=await post({action:'canvas-delete',id:canvas.id});canvasEdit=false;if(!canvasStore.canvases.length)canvasStore=null;renderCanvas();});},'pulse-btn ghost'));
  head.append(name,meta,tools);
  canvasLine=el('p','pulse-status',canvasFlash);canvasLine.setAttribute('role','status');
  if(canvasFlash&&canvasUndo&&canvasUndo.canvasId===canvas.id&&canvasFlash.endsWith('удалён.')){const undo=button('Вернуть',()=>{canvas.blocks.splice(Math.min(canvasUndo.index,canvas.blocks.length),0,canvasUndo.block);canvasUndo=null;canvasFlash='Блок возвращён.';touch();renderCanvas();},'pulse-btn ghost canvas-undo');canvasLine.append(' ',undo);}
  canvasFlash='';
  col.append(head,paramsBar(canvas,cat),askBar(canvas),canvasLine);
  const preview=el('div','canvas-preview-host');col.append(preview);if(pendingPlan)drawPlan(preview,canvas);if(pendingBlock)drawPending(preview,canvas);
  if(canvasEdit)col.append(el('p','pulse-muted','Перетащите блок: на левую половину другого блока — поставить перед ним; график на правую половину другого графика — сравнить на одном графике. Под заголовком блока — ← → и ширина. Удалить блок — 🗑 в углу (можно вернуть).'));
  const grid=el('div','canvas-grid'+(canvasEdit?' is-edit':''));col.append(grid);
  canvasResize?.disconnect();let gridWidth=0,resizeTimer=null;canvasResize=new ResizeObserver(([entry])=>{const w=Math.round(entry.contentRect.width);if(!gridWidth){gridWidth=w;return;}if(Math.abs(w-gridWidth)<40||tab!=='canvas')return;gridWidth=w;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!panels.canvas.querySelector('.canvas-note-edit:focus'))renderCanvas();},350);});canvasResize.observe(grid);
  if(!canvas.blocks.length)grid.append(el('p','pulse-empty canvas-empty','Холст пуст. Спросите что-нибудь в строке выше — ответ станет первым блоком.'));
  canvas.blocks.forEach((b,i)=>grid.append(blockCard(canvas,b,i)));
 }
 function paramsBar(canvas,cat){
  const p=canvas.params||(canvas.params={}),bar=el('div','canvas-params'),bound=canvas.blocks.filter(b=>b.bind).length;
  const listId='canvasTargets'+canvas.id,list=el('datalist');list.id=listId;const options=new Map();
  for(const product of cat.products)for(const channel of ['communication','success_screen']){const label='Продукт: '+product+(channel==='success_screen'?' · экраны успеха':'');options.set(label,{channel,id:null,product});}
  for(const sv of cat.surveys){const label='#'+sv.id+' · '+sv.name+(sv.channel==='success_screen'?' · экран успеха':'');options.set(label,{channel:sv.channel,id:sv.id,product:null});}
  for(const label of options.keys())list.append(new Option(label));
  const labelOf=t=>{for(const [k,v] of options)if(sameTarget(v,t))return k;return t?targetLabel(t):'';};
  const obj=el('input');obj.type='search';obj.setAttribute('list',listId);obj.placeholder='все опросы — введите номер, название или продукт';obj.setAttribute('aria-label','Объект холста: опрос или продукт');obj.value=labelOf(p.target);
  obj.onchange=()=>{const v=obj.value.trim();if(!v){delete p.target;}else if(options.has(v)){p.target=options.get(v);}else{const n=Number(v.replace(/[#№\s]/g,''));const sv=Number.isInteger(n)&&cat.surveys.find(s=>s.id===n);const pr=cat.products.find(x=>x.toLowerCase()===v.toLowerCase());if(sv)p.target={channel:sv.channel,id:sv.id,product:null};else if(pr)p.target={channel:'communication',id:null,product:pr};else{canvasFlash='Не нашёл «'+v+'» — выберите опрос или продукт из подсказок.';renderCanvas();return;}}
   canvasFocus=null;canvasFlash=p.target?'Объект холста: '+targetLabel(p.target)+'. Пересчитано блоков: '+bound+'.':'Объект холста сброшен — блоки показывают свои значения.';touch();renderCanvas();};
  const period=el('select');period.setAttribute('aria-label','Период холста');period.add(new Option('период: как в блоках',''));for(const [d,t] of [[14,'14 дней'],[30,'30 дней'],[60,'60 дней'],[90,'90 дней'],[180,'полгода'],[365,'год']])period.add(new Option(t,String(d)));period.value=p.days?String(p.days):'';period.onchange=()=>{if(period.value)p.days=Number(period.value);else delete p.days;if(p.days>=180&&!p.grain)p.grain='week';touch();renderCanvas();};
  const grain=el('select');grain.setAttribute('aria-label','Группировка холста');grain.add(new Option('группировка: как в блоках',''));for(const [k,t] of [['day','по дням'],['week','по неделям'],['month','по месяцам']])grain.add(new Option(t,k));grain.value=p.grain||'';grain.onchange=()=>{if(grain.value)p.grain=grain.value;else delete p.grain;touch();renderCanvas();};
  const head=el('div','canvas-params-row');head.append(el('span','canvas-params-label','Параметры'),obj,list,period,grain);
  const info=el('div','canvas-params-row');info.append(el('small','pulse-muted','⛓ связано блоков: '+bound+' из '+canvas.blocks.length+(bound?'':' — отметьте блоки «по параметрам холста» в «Настроить»')));
  if(bound<canvas.blocks.filter(b=>BINDABLE.has(b.kind)).length)info.append(button('Связать все графики и показатели',()=>{for(const b of canvas.blocks)if(BINDABLE.has(b.kind))b.bind=true;canvasFlash='Все графики и показатели следуют за параметрами холста.';touch();renderCanvas();},'pulse-btn ghost small'));
  if(canvasFocus&&canvasFocus.canvasId===canvas.id){const chip=el('span','canvas-focus');chip.append(document.createTextNode('Фильтр: '+targetLabel(canvasFocus.target)+' '));chip.append(button('сделать параметром',()=>{p.target=canvasFocus.target;canvasFocus=null;canvasFlash='Фильтр сохранён как объект холста.';touch();renderCanvas();},'pulse-linkbtn'),button('×',()=>setCanvasFocus(null),'canvas-tbtn'));info.append(chip);}
  if(bound&&!p.target&&!canvasFocus&&canvas.template==='team')bar.classList.add('needs-target');
  bar.append(head,info);return bar;
 }
 function drawPlan(host,canvas){
  const plan=pendingPlan,card=el('section','canvas-pending canvas-plan'),head=el('div','canvas-bh');
  head.append(el('span','canvas-new','План холста · из вашей задачи'),el('span','pulse-tag',plan.source));card.append(head);
  const name=el('input','canvas-name-input');name.value=plan.name;name.maxLength=80;name.setAttribute('aria-label','Название нового холста');card.append(name);
  card.append(el('p','pulse-muted','Задача: «'+plan.query+'»'));
  const pp=plan.params||{};card.append(el('p','pulse-muted','Параметры: '+(pp.target?targetLabel(pp.target):'объект не выбран')+(pp.days?' · '+pp.days+' дней':'')+(pp.grain?' · '+({day:'по дням',week:'по неделям',month:'по месяцам'})[pp.grain]:'')));
  for(const n of plan.notes||[])card.append(el('p','pulse-muted',n));
  const list=el('ol','canvas-plan-list'),fake={id:'plan',params:pp};
  plan.blocks.forEach((b,i)=>{const li=el('li'),l=el('label','pulse-check'),c=el('input');c.type='checkbox';c.checked=plan.keep[i];c.onchange=()=>{plan.keep[i]=c.checked;};const rb=resolveBlock(b,fake);l.append(c,document.createTextNode(' '+BLOCK_NAMES[b.kind]+(b.kind==='note'?' · '+(b.text||'').trim():blockTitle(rb)!==BLOCK_NAMES[b.kind]?' · '+blockTitle(rb).replace(BLOCK_NAMES[b.kind]+' · ',''):'')+(b.bind?' ⛓':'')));li.append(l);list.append(li);});
  card.append(list,el('p','canvas-trust','✓ Модель (если подключена) выбрала только блоки и объекты из справочника. Все числа посчитает платформа по вашей выгрузке.'));
  const actions=el('div','pulse-row'),chosen=()=>plan.blocks.filter((_,i)=>plan.keep[i]).map(b=>({...b,uid:newUid()}));
  actions.append(button('Создать холст',e=>busy(e.target,canvasLine,async()=>{const blocks=chosen();if(!blocks.length)throw new Error('Отметьте хотя бы один блок.');await saveCanvas({name:name.value.trim()||plan.name,template:'plan',blocks,params:structuredClone(pp)},true);pendingPlan=null;canvasFocus=null;canvasFlash='Холст «'+(name.value.trim()||plan.name)+'» собран: '+blocks.length+' '+plural(blocks.length,'блок','блока','блоков')+'.';renderCanvas();}),'pulse-btn accent'),
   button('Добавить на этот холст',()=>{const blocks=chosen();canvas.blocks.push(...blocks);if(pp.target&&!canvas.params?.target)canvas.params={...(canvas.params||{}),target:pp.target};pendingPlan=null;canvasFlash='Добавлено блоков: '+blocks.length+'.';touch();renderCanvas();},'pulse-btn'),
   button('Отмена',()=>{pendingPlan=null;renderCanvas();},'pulse-btn ghost'));
  card.append(actions);host.append(card);
 }
 function templateDialog(canvas){
  const dialog=el('dialog','pulse-dialog'),form=el('form');form.method='dialog';dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  form.append(el('h2','','Сохранить как шаблон команды'),el('p','pulse-muted','В шаблон попадают блоки, их настройки и параметры холста — без данных. Коллеги увидят шаблон в «Шаблоны команды» этой папки проекта или получат его файлом.'));
  const name=field(form,'Название шаблона','text',{maxlength:'80',required:''});name.value=canvas.name;
  const description=field(form,'Описание','text',{maxlength:'300',placeholder:'для чего этот холст'});
  let author='';try{author=localStorage.getItem('pulse-author')||'';}catch{}const who=field(form,'Автор','text',{maxlength:'80'});who.value=author;
  const keep=el('label','pulse-check'),box=el('input');box.type='checkbox';keep.append(box,document.createTextNode(' Сохранить с текущим объектом ('+targetLabel(canvas.params?.target)+')'));if(!canvas.params?.target)box.disabled=true;form.append(keep);
  const line=el('p','pulse-status');const row=el('div','pulse-row'),ok=el('button','pulse-btn accent','Сохранить шаблон');ok.type='submit';row.append(button('Отмена',()=>dialog.close(),'pulse-btn ghost'),ok);form.append(line,row);
  form.onsubmit=e=>{e.preventDefault();busy(ok,line,async()=>{try{localStorage.setItem('pulse-author',who.value);}catch{}const r=await post({action:'canvas-template-save',template:{name:name.value,description:description.value,author:who.value,keepTarget:box.checked,params:canvas.params||{},blocks:canvas.blocks}});teamTemplates=r.templates;dialog.close();canvasFlash='Шаблон «'+r.template.name+'» сохранён в «Шаблоны команды».';renderCanvas();});};
  dialog.showModal();name.focus();
 }
 function askBar(canvas){
  const form=el('form','canvas-ask'),input=el('input'),go=el('button','pulse-btn accent','Добавить блок');
  input.type='text';input.maxLength=400;input.placeholder='Спросите или добавьте блок: «сравни отправки 1427 и 1428 за 60 дней»';input.setAttribute('aria-label','Вопрос к холсту');go.type='submit';
  const chips=el('div','canvas-chips');
  const examples=['прогноз плана','что требует решения','портфель по группам','CSI экранов успеха за 30 дней'];
  const focus=brief&&!brief.empty?decisionProblems().slice(0,2):[];if(focus.length===2)examples.unshift('сравни ответы '+focus[0].id+' и '+focus[1].id);else if(focus.length)examples.unshift('отправки и ответы '+focus[0].id+' за 60 дней');
  for(const ex of examples.slice(0,5))chips.append(button(ex,()=>{input.value=ex;form.requestSubmit();},'canvas-chip'));
  chips.append(button('＋ заметка',()=>{canvas.blocks.push({kind:'note',span:6,text:'',uid:newUid()});canvasEdit=true;touch();renderCanvas();},'canvas-chip'));
  form.onsubmit=e=>{e.preventDefault();const q=input.value.trim();if(!q)return;busy(go,canvasLine,async()=>{const r=await post({action:'canvas-ask',query:q,useModel:true});pendingBlock={block:{...r.block,uid:r.block.uid||newUid()},source:r.source,notes:r.notes||[],understood:r.understood};input.value='';renderCanvas();});};
  const plan=button('Собрать холст',()=>{const q=input.value.trim();if(!q){input.placeholder='Опишите задачу: «подготовь холст к комитету по кредитам: что просело за месяц и прогноз плана»';input.focus();return;}busy(plan,canvasLine,async()=>{const r=await post({action:'canvas-plan',query:q,useModel:true});pendingPlan={...r,blocks:r.blocks.map(b=>({...b,uid:newUid()})),keep:r.blocks.map(()=>true)};pendingBlock=null;input.value='';renderCanvas();});},'pulse-btn');plan.title='GigaCode (или локальный планировщик) соберёт холст из блоков под задачу; числа посчитает платформа';
  const row=el('div','canvas-ask-row');row.append(input,go,plan);form.append(row,chips);return form;
 }
 function drawPending(host,canvas){
  const {block,source,notes,understood}=pendingBlock,card=el('section','canvas-pending'),head=el('div','canvas-bh');
  head.append(el('span','canvas-new','Новый блок · из вашего вопроса'),el('span','pulse-tag','ещё не закреплён'));
  card.append(head,el('h3','',blockTitle(block)));
  if(block.question)card.append(el('p','pulse-muted','Вопрос: «'+block.question+'» · '+source+(understood?'':' · вопрос понят не полностью')));
  for(const n of notes)card.append(el('p','pulse-muted',n));
  card.append(blockSettings(block,()=>renderCanvas()));
  const body=el('div','canvas-body');card.append(body);fillBlock(block,body);
  card.append(el('p','canvas-trust','✓ Числа посчитаны платформой по вашей выгрузке. Модель могла выбрать только тип блока и объекты — чисел от модели 0.'));
  const actions=el('div','pulse-row');
  actions.append(button('Закрепить на холсте',()=>{if(!['status','problems'].includes(block.kind))block.span=typicalSpan(canvas,block.kind);canvas.blocks.unshift(block);pendingBlock=null;touch();renderCanvas();},'pulse-btn accent'));
  const same=canvas.blocks.map((b,i)=>[b,i]).filter(([b])=>b.kind===block.kind||CHARTABLE.has(b.kind)&&CHARTABLE.has(block.kind));
  if(same.length){const sel=el('select');sel.setAttribute('aria-label','Какой блок заменить');sel.add(new Option('Заменить блок…',''));for(const [b,i] of same)sel.add(new Option(blockTitle(b),String(i)));sel.onchange=()=>{if(sel.value==='')return;canvas.blocks[Number(sel.value)]={...block,span:canvas.blocks[Number(sel.value)].span};pendingBlock=null;touch();renderCanvas();};actions.append(sel);}
  if(CHARTABLE.has(block.kind)){const compareTo=canvas.blocks.map((b,i)=>[b,i]).filter(([b])=>CHARTABLE.has(b.kind));if(compareTo.length){const sel=el('select');sel.setAttribute('aria-label','С каким графиком сравнить');sel.add(new Option('Сравнить с…',''));for(const [b,i] of compareTo)sel.add(new Option(blockTitle(b),String(i)));sel.onchange=()=>{if(sel.value==='')return;const i=Number(sel.value);canvas.blocks[i]=mergeBlocks(canvas.blocks[i],block);pendingBlock=null;touch();renderCanvas();};actions.append(sel);}}
  if(!understood&&block.question)actions.append(button('Спросить в диалоге',()=>{const q=block.question;pendingBlock=null;askDialog(q);},'pulse-btn ghost'));
  actions.append(button('Отбросить',()=>{pendingBlock=null;renderCanvas();},'pulse-btn ghost'));
  card.append(actions);host.append(card);
 }
 function blockSettings(b,redraw){
  const row=el('div','pulse-row canvas-settings');
  if(CHARTABLE.has(b.kind)||b.kind==='kpi'){const m=el('select');m.setAttribute('aria-label','Показатель');for(const [k,v] of Object.entries(b.kind==='kpi'?{answers:'Ответы',sends:'Отправки',responseRate:'Отклик',csi:'CSI'}:METRIC_NAMES))m.add(new Option(v,k));m.value=b.metric||'answers';m.onchange=()=>{b.metric=m.value;redraw();};row.append(m);}
  if(CHARTABLE.has(b.kind)){const d=el('select');d.setAttribute('aria-label','Период');for(const [x,t] of [[14,'14 дней'],[30,'30 дней'],[60,'60 дней'],[90,'90 дней'],[180,'полгода'],[365,'год']])d.add(new Option(t,String(x)));d.value=String(b.days||60);d.onchange=()=>{b.days=Number(d.value);if(b.days>=180&&(b.grain||'day')==='day')b.grain='week';redraw();};row.append(d);
   const g=el('select');g.setAttribute('aria-label','Группировка');for(const [k,t] of [['day','по дням'],['week','по неделям'],['month','по месяцам']])g.add(new Option(t,k));g.value=b.grain||'day';g.onchange=()=>{if(g.value==='day')delete b.grain;else b.grain=g.value;if(g.value==='month'&&(b.days||60)<90)b.days=180;redraw();};row.append(g);
   const lb=el('select');lb.setAttribute('aria-label','Подписи точек');for(const [k,t] of [['none','без подписей'],['key','подписи: ключевые'],['all','подписи: все точки']])lb.add(new Option(t,k));lb.value=b.labels||'none';lb.onchange=()=>{if(lb.value==='none')delete b.labels;else b.labels=lb.value;redraw();};row.append(lb);
   if(b.kind==='compare'){const l=el('label','pulse-check'),c=el('input');c.type='checkbox';c.checked=Boolean(b.index);c.onchange=()=>{b.index=c.checked;redraw();};l.append(c,document.createTextNode(' индекс = 100'));row.append(l);}}
  if(['kpi','forecast','chart','portfolio'].includes(b.kind)){const ch=el('select');ch.setAttribute('aria-label','Канал');ch.add(new Option('Пуш + СМС','communication'));ch.add(new Option('Экран успеха','success_screen'));ch.value=b.channel||'communication';ch.onchange=()=>{b.channel=ch.value;if(b.kind!=='kpi'&&b.kind!=='portfolio'){delete b.id;}redraw();};row.append(ch);}
  return row;
 }
 function mergeBlocks(target,source){
  const items=[];for(const t of [...targetsOf(target),...targetsOf(source)])if(items.length<5&&!items.some(x=>x.channel===t.channel&&x.id===t.id&&x.product===t.product))items.push(t);
  return {kind:'compare',uid:target.uid,span:12,metric:target.metric||source.metric||'answers',days:target.days||60,index:true,items};
 }
 function blockCard(canvas,b,i){
  const card=el('section','canvas-block span-'+(b.span||6)+' kind-'+b.kind);card.dataset.index=String(i);card.setAttribute('aria-label',blockTitle(b));
  const head=el('div','canvas-bh');head.append(el('span','canvas-grip',canvasEdit?'⠿':''),el('span','canvas-kind',BLOCK_NAMES[b.kind]));
  const btns=el('div','canvas-bbtns');
  const tiny=(t,label,run)=>{const x=button(t,run,'canvas-tbtn');x.setAttribute('aria-label',label);x.title=label;btns.append(x);};
  tiny('▶','Показать с этого блока',()=>canvasShow(canvas,i));
  if(b.kind==='compare'&&(b.items||[]).length>1)tiny('⇲','Разделить на отдельные графики',()=>{canvas.blocks.splice(i,1,...b.items.map(t=>({kind:'chart',uid:newUid(),span:6,metric:b.metric,days:b.days,channel:t.channel,id:t.id??undefined,product:t.product??undefined})));touch();renderCanvas();});
  tiny('🗑','Удалить блок «'+blockTitle(b)+'»',()=>removeBlock(canvas,i));
  head.append(btns);card.append(head);
  if(canvasEdit){
   const row=el('div','canvas-edit-row'),mv=d=>{const j=i+d;if(j<0||j>=canvas.blocks.length)return;[canvas.blocks[i],canvas.blocks[j]]=[canvas.blocks[j],canvas.blocks[i]];touch();renderCanvas();};
   const prev=button('←',()=>mv(-1),'canvas-tbtn'),next=button('→',()=>mv(1),'canvas-tbtn');prev.setAttribute('aria-label','Переместить раньше');next.setAttribute('aria-label','Переместить позже');prev.disabled=!i;next.disabled=i===canvas.blocks.length-1;
   const width=el('select');width.setAttribute('aria-label','Ширина блока');for(const [k,t] of [[3,'¼ строки'],[4,'⅓ строки'],[6,'½ строки'],[8,'⅔ строки'],[12,'вся строка']])width.add(new Option(t,String(k)));width.value=String(b.span||6);width.onchange=()=>{b.span=Number(width.value);touch();renderCanvas();};
   row.append(prev,next,width);
   if(BINDABLE.has(b.kind)){const l=el('label','pulse-check'),c=el('input');c.type='checkbox';c.checked=Boolean(b.bind);c.onchange=()=>{if(c.checked)b.bind=true;else delete b.bind;touch();renderCanvas();};l.append(c,document.createTextNode(' по параметрам холста'));row.append(l);}
   card.append(row);
  }
  const rb=resolveBlock(b,canvas);if(b.bind){const link=el('span','canvas-bound','⛓');link.title='Блок следует за параметрами холста';head.querySelector('.canvas-kind').append(' ',link);}
  if(b.kind!=='note'&&b.kind!=='status'&&blockTitle(rb)!==BLOCK_NAMES[b.kind])card.append(el('h3','canvas-title',blockTitle(rb)));
  if(canvasEdit&&b.kind!=='note'&&b.kind!=='status'&&b.kind!=='problems'&&b.kind!=='signals')card.append(blockSettings(b,()=>{touch();renderCanvas();}));
  const body=el('div','canvas-body');card.append(body);
  if(b.kind==='note'&&canvasEdit){const t=el('textarea','canvas-note-edit');t.value=b.text||'';t.maxLength=1200;t.rows=3;t.setAttribute('aria-label','Текст заметки');t.oninput=()=>{b.text=t.value;touch();};body.append(t);}
  else canvasSpecs.set(b.uid,fillBlock(rb,body).then(spec=>({...spec,node:body})));
  if(canvasEdit){
   card.draggable=true;
   card.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',String(i));e.dataTransfer.effectAllowed='move';card.classList.add('is-drag');canvasDrag=i;});
   card.addEventListener('dragend',()=>{card.classList.remove('is-drag');canvasDrag=null;});
   card.addEventListener('dragover',e=>{if(canvasDrag===null||canvasDrag===i)return;e.preventDefault();const r=card.getBoundingClientRect(),can=CHARTABLE.has(b.kind)&&CHARTABLE.has(canvas.blocks[canvasDrag].kind);card.dataset.drop=can&&e.clientX>r.left+r.width/2?'merge':'move';});
   card.addEventListener('dragleave',e=>{if(!card.contains(e.relatedTarget))delete card.dataset.drop;});
   card.addEventListener('drop',e=>{e.preventDefault();const mode=card.dataset.drop;delete card.dataset.drop;const from=canvasDrag;canvasDrag=null;if(from===null||from===i)return;
    if(mode==='merge'){canvas.blocks[i]=mergeBlocks(b,canvas.blocks[from]);canvas.blocks.splice(from,1);canvasFlash='Блоки слиты в сравнение. Кнопка «⇲» на блоке разделит их обратно.';}
    else{const [m]=canvas.blocks.splice(from,1);canvas.blocks.splice(from<i?i-1:i,0,m);}
    touch();renderCanvas();});
  }
  return card;
 }
 let canvasDrag=null,canvasUndo=null;
 function removeBlock(canvas,i){const [removed]=canvas.blocks.splice(i,1);canvasUndo={canvasId:canvas.id,block:removed,index:i};canvasFlash='Блок «'+blockTitle(removed)+'» удалён.';touch();renderCanvas();}
 function typicalSpan(canvas,kind){const spans=canvas.blocks.filter(x=>CHARTABLE.has(x.kind)===CHARTABLE.has(kind)&&!['status','note','problems'].includes(x.kind)).map(x=>x.span||6);if(!spans.length)return kind==='compare'?12:6;const count=new Map();for(const v of spans)count.set(v,(count.get(v)||0)+1);return [...count.entries()].sort((a,c)=>c[1]-a[1]||c[0]-a[0])[0][0];}
 async function fillBlock(b,body,big=false){
  const spec={title:blockTitle(b),subtitle:'',bullets:[],kpis:[]};
  try{
   if(b.kind==='status'){const text=brief.narrative?.status||headline();body.append(el('p','canvas-status',text));const bank=el('div','pulse-bank');for(const x of brief.bank||[])bank.append(el('span','pulse-bank-chip '+(x.alert?'bad':'ok'),x.label+(x.alert?': '+x.reasons.join(', '):': без существенных изменений')));body.append(bank);spec.title=text;spec.bullets=(brief.bank||[]).map(x=>x.label+(x.alert?': '+x.reasons.join(', '):': без изменений'));return spec;}
   if(b.kind==='problems'){const f=b._filter,items=decisionProblems().filter(p=>!f||(f.id?p.id===f.id&&p.channel===f.channel:(p.products||[]).includes(f.product))),notes=new Map((brief.narrative?.items||[]).map(i=>[i.key,i.note]));if(!items.length)body.append(el('p','pulse-empty',f?'По объекту «'+targetLabel(f)+'» проблем, требующих решения, нет.':'В фокусе всё стабильно.'));const shown=items.slice(0,big?4:(b.span||6)>=8?3:2);for(const p of shown){const card=problemCard(p,notes.get(p.key)||p.hint);if(!big&&!f){const fb=button('Фокус холста',()=>setCanvasFocus({channel:p.channel,id:p.id,product:null}),'pulse-btn ghost');fb.title='Отфильтровать связанные блоки холста по этому опросу';card.querySelector('.pulse-row')?.append(fb);}body.append(card);}if(items.length>shown.length)body.append(el('p','pulse-muted','Ещё '+(items.length-shown.length)+' — во вкладке «Брифинг».'));spec.title='Требует решения · '+items.length;spec.bullets=items.slice(0,5).map(p=>p.title+': '+p.line);return spec;}
   if(b.kind==='kpi'){const k=(brief.kpis||[]).find(x=>x.channel===(b.channel||'communication')),m=b.metric||'answers';if(!k){body.append(el('b','pulse-tile-value','—'));return spec;}const a=k.baseline[m],v=k.current[m];body.append(el('b','pulse-tile-value',fmt(v,m)));const delta=m==='answers'||m==='sends'?pctChange(a,v):a===null||v===null?'нет базы':signed(v-a,m==='csi'?' балла':' п.п.');body.append(el('small','','к прошлой неделе: '+delta));spec.kpis=[[KPI_METRICS[m],fmt(v,m)],['к прошлой неделе',delta]];return spec;}
   if(b.kind==='signals'){const f=b._filter,list=(brief.signals||[]).filter(s=>!f||(f.id?s.id===f.id:true));const ul=el('ul','pulse-tile-list');for(const s of list.slice(0,big?8:5))ul.append(el('li',s.severity==='urgent'?'bad':'','#'+s.id+' · '+s.name+' — '+s.reasons[0]));if(!list.length)ul.append(el('li','','Сигналов нет'));body.append(ul);spec.title='Сигналы недели · '+list.length;spec.bullets=list.slice(0,6).map(s=>'#'+s.id+' · '+s.name+' — '+s.reasons[0]);return spec;}
   if(b.kind==='shifts'){const vis=visibleShifts().filter(s=>(!b.product||(s.products||[]).includes(b.product))&&(!b.id||s.id===b.id));body.append(el('b','pulse-tile-value',String(vis.length)));const ul=el('ul','pulse-tile-list');for(const s of vis.slice(0,big?6:3))ul.append(el('li',s.direction==='down'?'bad':'good','#'+s.id+' · '+s.label.toLowerCase()+' '+change(s)+' с '+dateLabel(s.date)));body.append(ul);spec.bullets=vis.slice(0,6).map(s=>'#'+s.id+' · '+s.label.toLowerCase()+' '+change(s)+' с '+dateLabel(s.date));return spec;}
   if(b.kind==='note'){body.append(el('p','canvas-note',b.text||'Пустая заметка — нажмите «Настроить», чтобы написать.'));spec.bullets=[b.text||''].filter(Boolean);return spec;}
   if(b.kind==='forecast'){const d=await post({action:'whatif',channel:b.channel||'communication',id:b.id??null,product:b.product??null});spec.subtitle=d.month;
    if(d.plan){const ok=d.scenario.forecast>=d.plan;body.append(el('b','pulse-tile-value '+(ok?'good':'bad'),df.format(d.completion)+'%'),el('small','',d.verdict+': '+nf.format(d.scenario.forecast)+' из '+nf.format(d.plan)+' · '+d.month));spec.kpis=[['Прогноз выполнения',df.format(d.completion)+'%'],['Ответов к концу месяца',nf.format(d.scenario.forecast)],['План',nf.format(d.plan)]];spec.conclusion=d.verdict;}
    else{body.append(el('b','pulse-tile-value',nf.format(d.scenario.forecast)),el('small','','ответов к концу месяца · план не задан'));spec.kpis=[['Ответов к концу месяца',nf.format(d.scenario.forecast)]];}
    body.append(button('Что если…',()=>{select('whatif');whatifPrefill({id:b.id??null,channel:b.channel||'communication'});},'pulse-btn ghost'));return spec;}
   if(b.kind==='portfolio'){const d=await post({action:'portfolio',channel:b.channel||'communication',groupBy:b.groupBy||'product'});const ul=el('ul','canvas-groups');
    for(const g of d.groups.slice(0,big?8:5)){const li=el('li','lvl-'+g.level+((b.groupBy||'product')==='product'?' is-link':''));if((b.groupBy||'product')==='product'&&!big){li.tabIndex=0;li.setAttribute('role','button');li.title='Отфильтровать холст по продукту «'+g.name+'»';const pick=()=>setCanvasFocus({channel:b.channel||'communication',id:null,product:g.name});li.onclick=pick;li.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}};}li.append(el('i'),el('span','',g.name),el('small','',(g.answersChange==null?'—':signed(g.answersChange))+(g.csi==null?'':' · CSI '+cf.format(g.csi))));ul.append(li);}
    body.append(el('small','pulse-muted',d.channelLabel+' · '+d.groups.length+' групп · красных '+d.groups.filter(g=>g.level==='bad').length),ul,button('Весь портфель',()=>select('portfolio'),'pulse-btn ghost'));
    spec.title='Портфель групп · '+d.channelLabel;spec.bullets=d.groups.slice(0,6).map(g=>g.name+': ответы '+(g.answersChange==null?'—':signed(g.answersChange))+(g.csi==null?'':', CSI '+cf.format(g.csi)));return spec;}
   if(CHARTABLE.has(b.kind)){
    const metric=b.metric||'answers',items=targetsOf(b),data=await post({action:'compare',metric,days:b.days||60,grain:b.grain||'day',items:items.map(t=>({channel:t.channel,id:t.id??null,product:t.product??null}))});
    const rate=metric==='csi'||metric==='responseRate',useIndex=b.kind==='compare'&&b.index;
    const series=data.items.map(item=>{let points=item.series;if(useIndex&&points.length){const h=points.slice(0,7),base=h.reduce((a,p)=>a+p[1],0)/h.length;points=base?points.map(p=>[p[0],p[1]/base*100]):points;}return {name:item.label,points,zeroless:useIndex||rate,item,cls:data.items.length===1?'primary':undefined};});
    const ids=data.items.flatMap(x=>x.id?[x.id]:[]);
    const width=Math.max(220,body.clientWidth||(big?1100:600));chartHostWidth=width+48;
    const pointOut=el('div','pulse-output'),steps=el('div','pulse-steps-host');
    body.append(lineChart({series,events:b.grain?[]:eventsFor(data.items[0].channel,ids),height:big?300:170,grain:b.grain||'day',labels:b.labels||'none',format:useIndex?v=>nf.format(v):metricFormat(metric),label:blockTitle(b),
     onPoint:(date,value,si,s)=>openPoint(pointOut,steps,{channel:s.item.channel,id:s.item.id,product:s.item.product,metric,date,title:s.item.label+' · '+dateLabel(date)},canvasLine)}));chartHostWidth=null;
    if(data.items.some(x=>x.partial?.length))body.append(el('small','pulse-muted','Неполные периоды по краям ('+[...new Set(data.items.flatMap(x=>x.partial||[]))].map(k=>periodLabel(k,b.grain)).join(', ')+') в сравнение «за период» не входят.'));
    if(data.items.length===1)body.append(el('small','','за период: '+(data.items[0].periodRelative!=null?signed(data.items[0].periodRelative):data.items[0].periodDelta!=null?signed(data.items[0].periodDelta):'—')));
    if(data.conclusion&&data.items.length>1)body.append(el('p','canvas-conclusion',data.conclusion));
    body.append(steps,pointOut);
    spec.subtitle=data.label+' · '+dateLabel(data.from)+' — '+dateLabel(data.to)+(useIndex?' · индекс: первая неделя = 100':'');spec.series=data.items[0].series;spec.bullets=data.items.map(x=>x.label+': за период '+(x.periodRelative!=null?signed(x.periodRelative):x.periodDelta!=null?signed(x.periodDelta):'—'));spec.conclusion=data.conclusion||'';
    return spec;}
  }catch(error){body.append(el('p','pulse-status is-error',error.message));}
  return spec;
 }
 function canvasShow(canvas,start){
  if(!canvas.blocks.length)return;
  const slides=canvas.blocks.map((b,i)=>()=>{const s=el('div','show-body canvas-show');s.append(el('p','pulse-eyebrow',canvas.name+' · '+(i+1)+' из '+canvas.blocks.length+' · '+BLOCK_NAMES[b.kind]));if(b.kind!=='status')s.append(el('h1','',b.kind==='note'?(b.text||'').split('\n')[0].slice(0,140):blockTitle(resolveBlock(b,canvas))));const body=el('div','canvas-body');s.append(body);if(b.kind==='note'){const rest=(b.text||'').split('\n').slice(1).join('\n');if(rest)body.append(el('p','canvas-note',rest));}else fillBlock(resolveBlock(b,canvas),body,true);return s;});
  openShow(slides,'Холст «'+canvas.name+'»',start);post({action:'journal-add',kind:'canvas-shown'}).catch(()=>{});
 }
 async function canvasSlides(canvas){
  const status=brief.narrative?.status||headline();
  const slides=[{kind:'cover',title:canvas.name,subtitle:'Холст GEN UI · '+new Date().toLocaleDateString('ru-RU'),bullets:[status]}];
  const images=[null];
  for(const b of canvas.blocks){if(b.kind==='status')continue;const lines=(b.text||'').split('\n').filter(Boolean),spec=b.kind==='note'?{title:lines[0]||'Заметка',bullets:lines.slice(1)}:await (canvasSpecs.get(b.uid)||Promise.resolve({title:blockTitle(b),bullets:[]}));slides.push({title:spec.title||blockTitle(b),subtitle:spec.subtitle||'',kpis:spec.kpis||[],series:spec.series||[],bullets:spec.bullets||[],conclusion:spec.conclusion||''});const chart=spec.node?.querySelector('svg.pulse-chart,svg');images.push(chart?await svgToPng(chart,getComputedStyle(document.body).backgroundColor||'#111'):null);}
  return {slides,images};
 }
 async function exportCanvasPptx(canvas){const {slides}=await canvasSlides(canvas);await exportPptx(slides,{product:'canvas',revision:new Date().toISOString().slice(0,10).replace(/-/g,'')},brandSettings());post({action:'journal-add',kind:'canvas-exported',format:'pptx'}).catch(()=>{});canvasLine.textContent='PPTX скачан: '+slides.length+' '+plural(slides.length,'слайд','слайда','слайдов')+'.';}
 async function exportCanvasEml(canvas){const {slides,images}=await canvasSlides(canvas);download('canvas-'+new Date().toISOString().slice(0,10)+'.eml',buildEml(canvas.name,slides,images,brandSettings().accent),'message/rfc822');post({action:'journal-add',kind:'canvas-exported',format:'eml'}).catch(()=>{});canvasLine.textContent='Черновик письма скачан — откройте его в почте.';}
 function printCanvas(canvas){const grid=panels.canvas.querySelector('.canvas-grid');if(!grid)return;const w=window.open('','_blank');if(!w)throw new Error('Разрешите всплывающие окна для печати.');const css=[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>'<link rel="stylesheet" href="'+l.href+'">').join('');const root=document.documentElement;w.document.write('<!doctype html><html lang="ru" data-theme="'+(root.dataset.theme||'dark')+'" style="'+root.style.cssText.replace(/"/g,'&quot;')+'"><head><meta charset="utf-8"><title>'+escapeHtml(canvas.name)+'</title>'+css+'</head><body class="pulse-print canvas-print"><h1>'+escapeHtml(canvas.name)+'</h1><div class="canvas-grid">'+grid.innerHTML+'</div></body></html>');w.document.close();setTimeout(()=>w.print(),500);}
 function importCanvas(){const picker=document.createElement('input');picker.type='file';picker.accept='.json,application/json';picker.onchange=async()=>{const file=picker.files[0];if(!file)return;try{const d=JSON.parse(await file.text());if(!['genui-canvas','genui-canvas-template'].includes(d.format)||!Array.isArray(d.blocks))throw new Error('Это не файл холста или шаблона GEN UI.');if(d.format==='genui-canvas-template'){await post({action:'canvas-template-save',template:{name:d.name,description:d.description||'',author:d.author||'',params:d.params||{},blocks:d.blocks}});teamTemplates=null;canvasFlash='Шаблон «'+d.name+'» добавлен в «Шаблоны команды».';renderCanvas();return;}await saveCanvas({name:String(d.name||'Холст коллеги').slice(0,80),template:d.template||'import',params:d.params||{},blocks:d.blocks.map(b=>({...b,uid:newUid()}))},true);pendingBlock=null;renderCanvas();}catch(error){alert(error.message);}};picker.click();}
 /* --- эффект «было → стало» --- */
 async function renderEffect(){
  const host=panels.effect;host.replaceChildren(el('h2','','Эффект платформы: было → стало'));const line=el('p','pulse-status');line.setAttribute('role','status');
  let d;try{d=await post({action:'effect'});}catch(error){host.append(el('p','pulse-status is-error',error.message));return;}
  const b=d.baseline||{},rows=effectRows(d);
  if(d.baselineDemo)host.append(el('p','pulse-tag warn','Пример базовых значений для демо — замените своими в форме ниже'));
  host.append(el('p','pulse-muted','«Стало» считается по журналу этой папки'+(d.since?' с '+new Date(d.since).toLocaleString('ru-RU'):'')+'. «Было» — ваши базовые значения до платформы.'));
  const grid=el('div','pulse-effect-grid');
  for(const r of rows){const card=el('article','pulse-card pulse-effect');card.append(el('span','pulse-muted',r.title));const pair=el('div','pulse-effect-pair');const was=el('div','was');was.append(el('small','','было'),el('b','',r.was));const now=el('div','now');now.append(el('small','','стало'),el('b','',r.now));pair.append(was,el('span','pulse-effect-arrow','→'),now);card.append(pair,el('p','pulse-muted',r.note));grid.append(card);}
  host.append(grid);
  const actions=el('div','pulse-row');actions.append(button('Слайд для совета (PPTX)',e=>busy(e.target,line,async()=>{await effectPptx(rows,d);line.textContent='Слайд скачан.';}),'pulse-btn accent'),button('Обновить',()=>renderEffect(),'pulse-btn ghost'));host.append(actions,line);
  const form=el('details','pulse-card pulse-baseline');form.open=!Object.keys(b).length;form.append(el('summary','','Базовые значения «было» (до платформы)'));
  const grid2=el('div','pulse-form-grid'),inputs={};
  for(const [key,label,max] of [['detectDays','Через сколько дней замечали отклонение',365],['closeDays','Дней до найденной причины',365],['meetingHours','Часов на подготовку одной встречи',200],['meetingsPerMonth','Встреч в месяц',100],['checkHoursPerDay','Часов в день на ручные проверки',24],['people','Людей на проверках и отчётах',500]]){const input=field(grid2,label,'number',{min:'0',max:String(max),step:'0.5'});input.value=b[key]??'';inputs[key]=input;}
  const save=button('Сохранить базовые значения',e=>busy(e.target,line,async()=>{const baseline={};for(const [k,i] of Object.entries(inputs))if(i.value!=='')baseline[k]=Number(i.value);await post({action:'settings',baseline});renderEffect();}),'pulse-btn accent');
  form.append(grid2,save);host.append(form,el('p','pulse-muted',d.method));
 }
 const hours=h=>h===null||h===undefined?'—':h<1?Math.max(1,Math.round(h*60))+' мин':df.format(h)+' ч';
 function effectRows(d){
  const b=d.baseline||{},det=d.detection,cl=d.closure,mt=d.meeting,ai=d.ai;
  return [
   {title:'Время до обнаружения отклонения',was:b.detectDays!=null?df.format(b.detectDays)+' дн.':'не задано',now:det.count?'в день загрузки':'—',note:det.count?'Найдено отклонений: '+det.count+(det.computeSeconds!=null?' · брифинг готов за '+df.format(Math.max(det.computeSeconds,0.1))+' с после загрузки':'')+(det.medianAgeDays!=null?' · найденные сдвиги к моменту сигнала длились в среднем (медиана) '+det.medianAgeDays+' дн.':''):'Загрузите данные — журнал начнёт считать.'},
   {title:'От сигнала до записанной причины',was:b.closeDays!=null?df.format(b.closeDays)+' дн.':'не задано',now:cl.medianHours!=null?hours(cl.medianHours):'—',note:'Закрыто с выводом: '+cl.closed+' из '+(cl.closed+cl.open)+(cl.share!=null?' ('+df.format(cl.share)+'%)':'')+'. Вывод — запись в памяти расследований по тому же опросу.'},
   {title:'Подготовка встречи',was:b.meetingHours!=null?df.format(b.meetingHours)+' ч':'не задано',now:mt.medianMinutes!=null?(mt.medianMinutes<1?'< 1 мин':df.format(mt.medianMinutes)+' мин'):'—',note:'Собрано черновиков: '+mt.built+' · выгружено: '+mt.exported+(d.savedMeetingHoursPerMonth!=null?' · экономия около '+df.format(d.savedMeetingHoursPerMonth)+' ч в месяц при '+df.format(b.meetingsPerMonth)+' встречах':'')},
   {title:'AI-разборы, принятые без правок',was:'нет разборов',now:ai.acceptedShare!=null?df.format(ai.acceptedShare)+'%':'—',note:'Оценок: '+ai.verdicts+' (принято '+ai.accepted+', исправить '+ai.edited+', отклонено '+ai.rejected+') · ответы модели: принято проверкой '+ai.checksAccepted+', отклонено '+ai.checksRejected+(ai.protectionTests?' · проверок защиты: '+ai.protectionTests:'')},
   {title:'Ручные ежедневные проверки',was:b.checkHoursPerDay!=null?df.format(b.checkHoursPerDay)+' ч/день'+(b.people?' · '+df.format(b.people)+' чел.':''):'не задано',now:det.briefs?'автоматически':'—',note:'Брифингов подготовлено без участия людей: '+det.briefs+'. Брифинг пересчитывается сам при каждой новой выгрузке; люди работают с очередью сигналов, а не просматривают все опросы.'},
  ];
 }
 function effectPptx(rows,d){
  if(!window.PptxGenJS)throw new Error('Модуль PPTX не загружен.');const brand=brandSettings(),accent=brand.accent.replace('#','').toUpperCase();
  const pptx=new window.PptxGenJS();pptx.layout='LAYOUT_WIDE';const slide=pptx.addSlide();slide.background={color:'FFFFFF'};
  slide.addShape(pptx.ShapeType.rect,{x:0,y:0,w:13.33,h:.12,fill:{color:accent},line:{color:accent}});
  slide.addText('Эффект платформы мониторинга опросов: было → стало',{x:.5,y:.35,w:12.3,h:.7,fontSize:26,bold:true,color:'1C1B19',fontFace:'Arial'});
  slide.addText('По журналу пилота'+(d.since?' с '+new Date(d.since).toLocaleDateString('ru-RU'):'')+(d.baselineDemo?' · базовые значения — пример для демо':''),{x:.5,y:1.0,w:12.3,h:.4,fontSize:13,color:'716E67',fontFace:'Arial'});
  const head=['Показатель','Было','Стало','Комментарий'].map(t=>({text:t,options:{bold:true,color:'FFFFFF',fill:{color:accent}}}));
  const body=rows.map(r=>[{text:r.title,options:{bold:true}},{text:r.was},{text:r.now,options:{bold:true,color:accent}},{text:r.note,options:{fontSize:10,color:'4A4843'}}]);
  slide.addTable([head,...body],{x:.5,y:1.6,w:12.3,colW:[3.0,1.8,2.0,5.5],fontSize:13,fontFace:'Arial',color:'1C1B19',border:{type:'solid',pt:.5,color:'DCD9D1'},valign:'middle',rowH:.75});
  return pptx.writeFile({fileName:'pulse-effect-'+new Date().toISOString().slice(0,10)+'.pptx'});
 }
 /* --- брифинг руководителя: мой фокус → группы → банк --- */
 function star(channel,id,on){
  const b=button(on?'★':'☆',e=>{e.stopPropagation();busy(b,status,async()=>{const r=await post({action:'focus-toggle',channel,id});b.textContent=r.favorite?'★':'☆';b.setAttribute('aria-pressed',String(r.favorite));status.textContent=r.favorite?'Опрос #'+id+' добавлен в избранное — он теперь в вашем фокусе.':'Опрос #'+id+' убран из избранного.';brief=await post({action:'brief'});renderBrief();if(tab==='portfolio')renderPortfolio();});},'pulse-star');
  b.setAttribute('aria-label',(on?'Убрать из избранного':'Добавить в избранное')+' опрос #'+id);b.setAttribute('aria-pressed',String(on));b.title=on?'В избранном — в вашем фокусе':'Добавить в избранное';return b;
 }
 const decisionProblems=()=>(brief.problems||[]).filter(p=>p.inFocus&&!p.lowVolume&&p.kind!=='growth');
 function statusCard(){
  const card=el('section','pulse-card pulse-status-card'),line=el('p','pulse-status'),steps=el('div','pulse-steps-host');line.setAttribute('role','status');
  const focus=brief.focus||{total:0,top:0,favorites:0},items=decisionProblems();
  const status=brief.narrative?.status||(items.length?'В вашем фокусе требуют решения '+items.length+' '+plural(items.length,'опрос','опроса','опросов'):'В вашем фокусе проблем нет')+'.';
  card.append(el('p','pulse-eyebrow','Мой фокус · '+focus.total+' '+plural(focus.total,'опрос','опроса','опросов')+' (топ '+focus.top+' + избранные '+focus.favorites+')'),el('h2','pulse-status-line',status));
  const bank=el('div','pulse-bank');
  for(const b of brief.bank||[]){const chip=el('span','pulse-bank-chip '+(b.alert?'bad':'ok'));chip.append(el('b','',b.label),document.createTextNode(b.alert?' · внимание: '+b.reasons.join(', '):' · без существенных изменений'),el('small','',' · 14 дней по '+dateLabel(b.through)));chip.title='Ответы '+(b.answersChange==null?'—':signed(b.answersChange))+', CSI '+(b.csiChange==null?'—':signed(b.csiChange,' балла'))+' к предыдущим 14 дням · опросов: '+b.surveys;bank.append(chip);}
  card.append(bank);
  const tools=el('div','pulse-row');
  if(ai())tools.append(button(brief.narrative?'Переформулировать':'Сформулировать через GigaCode',e=>busy(e.target,line,async()=>{const n=await runJob({action:'narrate'},steps);brief.narrative=n;renderBrief();}),'pulse-btn accent'));
  const auto=el('label','pulse-check'),box=el('input');box.type='checkbox';box.checked=Boolean(brief.settings?.autoNarrate);box.disabled=!brief.modelReady;
  box.onchange=()=>busy(box,line,async()=>{const s=await post({action:'settings',autoNarrate:box.checked});brief.settings=s;});auto.append(box,document.createTextNode(' Готовить AI-резюме заранее'));tools.append(auto);
  tools.append(button('Изменить фокус',()=>openFocus(),'pulse-btn ghost'));
  card.append(tools,line,steps);
  if(brief.narrative){card.append(el('p','pulse-trust',(brief.narrative.source||'')+' · все числа подставлены платформой, модель пишет только слова — исказить число невозможно'+(brief.narrative.trust?.rejected?' · отклонено ответов модели: '+brief.narrative.trust.rejected:'')));card.append(verdictRow('Резюме брифинга · '+(brief.narrative.source||''),brief.narrative.canned));}
  return card;
 }
 function problemCard(p,note){
  const card=el('article','pulse-card pulse-problem '+p.kind),head=el('div','pulse-problem-head');
  head.append(p.inFocus&&!p.favorite?el('span','pulse-tag pulse-top','топ'):star(p.channel,p.id,p.favorite),el('h3','',p.title),el('span','pulse-tag '+(p.kind==='urgent'?'bad':p.kind==='growth'?'good':'warn'),p.kindLabel),el('span','pulse-tag',p.channelLabel));
  card.append(head,el('p','pulse-problem-line',p.line));
  if(note)card.append(el('p','pulse-problem-note',note));
  const more=el('div','pulse-problem-more');more.hidden=true;
  const actions=el('div','pulse-row');
  actions.append(button('Подробнее',e=>{more.hidden=!more.hidden;e.target.textContent=more.hidden?'Подробнее':'Свернуть';if(!more.hidden&&!more.childElementCount){const list=(brief.candidates||brief.shifts||[]).filter(s=>p.shiftKeys.includes(s.key));for(const s of list)more.append(shiftCard(s));for(const g of (brief.signals||[]).filter(g=>g.channel===p.channel&&g.id===p.id))more.append(el('p','pulse-muted','Сигнал недели: '+g.reasons.join(' · ')));if(!more.childElementCount)more.append(el('p','pulse-muted','Подробностей нет.'));}},'pulse-btn'),
   button('Записать вывод',()=>openNote({surveyId:p.id,channel:p.channel,metric:p.metrics[0]||'other',direction:'down',date:p.since,products:p.products,title:p.title}),'pulse-btn ghost'),
   button('Что если…',()=>{select('whatif');whatifPrefill({id:p.id,channel:p.channel});},'pulse-btn ghost'));
  card.append(actions,more);return card;
 }
 function decisionsSection(){
  const sec=el('section','pulse-section'),items=decisionProblems(),notes=new Map((brief.narrative?.items||[]).map(i=>[i.key,i.note]));
  const order=brief.narrative?.items?.length?[...items].sort((a,b)=>{const ia=brief.narrative.items.findIndex(i=>i.key===a.key),ib=brief.narrative.items.findIndex(i=>i.key===b.key);return (ia<0?99:ia)-(ib<0?99:ib);}):items;
  sec.append(el('h2','','Требует решения'+(items.length?' · '+Math.min(items.length,5)+(items.length>5?' из '+items.length:''):'')));
  if(!items.length){sec.append(el('p','pulse-empty','В вашем фокусе всё стабильно. Сигналы по остальным опросам — ниже, в блоке для аналитика.'));return sec;}
  for(const p of order.slice(0,5))sec.append(problemCard(p,notes.get(p.key)||p.hint));
  const rest=[...order.slice(5),...(brief.problems||[]).filter(p=>p.inFocus&&!p.lowVolume&&p.kind==='growth')];
  if(rest.length){const d=el('details','pulse-more');d.append(el('summary','','Ещё в фокусе: '+rest.length));for(const p of rest)d.append(problemCard(p,p.hint));sec.append(d);}
  return sec;
 }
 let analystOpen=false;
 function analystSection(){
  const others=(brief.problems||[]).filter(p=>!p.inFocus||p.lowVolume);
  const d=el('details','pulse-card pulse-analyst');d.append(el('summary','','Для аналитика: все сигналы и сдвиги · вне фокуса '+others.length+(others.some(p=>p.lowVolume)?' · из них малых опросов '+others.filter(p=>p.lowVolume).length:'')));
  const body=el('div','pulse-panel');d.append(body);let built=false;
  d.addEventListener('toggle',()=>{analystOpen=d.open;if(!d.open||built)return;built=true;
   if(others.length){const list=el('section','pulse-section');list.append(el('h3','','Вне фокуса руководителя'),el('p','pulse-muted','Опросы не в топе и не в избранном, а также малые опросы (меньше '+(brief.focus?.minAnswers||5)+' ответов в день). Звёздочка добавляет опрос в фокус.'));for(const p of others.slice(0,30))list.append(problemCard(p,p.lowVolume?'Малый объём: в среднем '+df.format(p.avgAnswers||0)+' ответа в день — в фокус руководителя не выносится.':p.hint));body.append(list);}
   body.append(el('h3','','Показатели каналов за неделю'),kpiRow(),changesCard(),sensitivityBar());
   clustersHost=el('section','pulse-section');shiftsHost=el('section','pulse-section');body.append(clustersHost,shiftsHost);renderShiftSections(visibleShifts());
   const signals=el('section','pulse-section');signals.append(el('h2','','Сигналы утреннего мониторинга · '+brief.signals.length));for(const s of brief.signals.slice(0,12)){const card=el('article','pulse-card pulse-signal '+s.severity);card.append(el('span','pulse-tag '+(s.severity==='urgent'?'bad':''),s.severity==='urgent'?'Срочно':'Внимание'),el('h3','','#'+s.id+' · '+s.name),el('p','',s.reasons.join(' · ')));signals.append(card);}body.append(signals);
  });
  if(analystOpen)d.open=true;
  return d;
 }
 /* --- редактор фокуса --- */
 const focusDialog=el('dialog','pulse-dialog pulse-focus-dialog');document.body.append(focusDialog);
 async function openFocus(){
  focusDialog.replaceChildren(el('h2','','Мой фокус'),el('p','pulse-muted','Топ-опросы из справочника всегда в фокусе. Избранные добавляются звёздочкой здесь, на карточках, в портфеле групп.'));
  const search=el('input');search.type='search';search.placeholder='Найти опрос по номеру или названию';search.setAttribute('aria-label','Найти опрос');
  const list=el('div','pulse-focus-list'),cat=await ensureCatalog();let focus=await post({action:'focus-get'});
  function draw(){list.replaceChildren();const q=search.value.trim().toLowerCase();const fav=new Set(focus.surveys.filter(s=>s.favorite).map(s=>s.channel+':'+s.id));
   const rows=q?cat.surveys.filter(s=>String(s.id).startsWith(q)||s.name.toLowerCase().includes(q)).slice(0,30):focus.surveys;
   if(!rows.length)list.append(el('p','pulse-empty',q?'Ничего не найдено.':'Фокус пуст.'));
   for(const s of rows){const row=el('div','pulse-focus-row'),on=fav.has(s.channel+':'+s.id);row.append(s.top?el('span','pulse-tag','топ'):star(s.channel,s.id,on),el('span','','#'+s.id+' · '+s.name),el('small','pulse-muted',(s.channelLabel||(s.channel==='success_screen'?'Экран успеха':'Пуш + СМС'))+(s.products?.length?' · '+s.products.join(', '):'')));list.append(row);}}
  search.oninput=draw;const close=button('Готово',()=>{focusDialog.close();},'pulse-btn accent');
  focusDialog.append(search,list,close);draw();focusDialog.showModal();search.focus();
 }
 /* --- портфель групп --- */
 const portfolioState={channel:'communication',groupBy:'product',open:new Set()};
 async function renderPortfolio(){
  const host=panels.portfolio;host.replaceChildren(el('h2','','Портфель групп'),el('p','pulse-muted','Опросы в крупных группах: где просели ответы, CSI или темп плана. Нажмите на группу, чтобы увидеть её опросы.'));
  const controls=el('div','pulse-row');
  for(const [key,label] of [['communication','Пуш + СМС'],['success_screen','Экраны успеха']]){const b=button(label,()=>{portfolioState.channel=key;portfolioState.open.clear();renderPortfolio();},'pulse-btn'+(portfolioState.channel===key?' accent':' ghost'));b.setAttribute('aria-pressed',String(portfolioState.channel===key));controls.append(b);}
  const group=el('select');group.setAttribute('aria-label','Группировка');
  const line=el('p','pulse-status');line.setAttribute('role','status');host.append(controls,line);
  let data;try{data=await post({action:'portfolio',channel:portfolioState.channel,groupBy:portfolioState.groupBy});}catch(error){line.textContent=error.message;line.classList.add('is-error');return;}
  for(const [k,v] of Object.entries(data.groupings))group.add(new Option('Группировка: '+v,k));group.value=data.groupBy;group.onchange=()=>{portfolioState.groupBy=group.value;portfolioState.open.clear();renderPortfolio();};controls.append(group);
  const bad=data.groups.filter(g=>g.level==='bad').length,warn=data.groups.filter(g=>g.level==='warn').length;
  host.append(el('p','pulse-summary',data.channelLabel+' · '+data.surveys+' опросов в '+data.groups.length+' группах · данные по '+dateLabel(data.through)+': красных групп '+bad+', жёлтых '+warn+'.'));
  const table=el('table','pulse-table pulse-heat'),head=el('tr');
  for(const h of ['',data.groupLabel,'Опросов','Ответы, 7 дней','К пред. неделе','Отклик','CSI','Δ CSI','Темп плана','Проблемы'])head.append(el('th','',h));table.append(head);
  const pctCell=(v,warnAt,badAt)=>{const c=el('td','',v==null?'—':signed(v));if(v!=null){if(v<=badAt)c.classList.add('heat-bad');else if(v<=warnAt)c.classList.add('heat-warn');else if(v>=5)c.classList.add('heat-good');}return c;};
  const csiCell=v=>{const c=el('td','',v==null?'—':(v>0.005?'+':v<-0.005?'−':'')+cf.format(Math.abs(v)));if(v!=null){if(v<=-.1)c.classList.add('heat-bad');else if(v<=-.05)c.classList.add('heat-warn');else if(v>=.05)c.classList.add('heat-good');}return c;};
  const paceCell=v=>{const c=el('td','',v==null?'—':df.format(v)+'%');if(v!=null){if(v<75)c.classList.add('heat-bad');else if(v<90)c.classList.add('heat-warn');else c.classList.add('heat-good');}return c;};
  for(const g of data.groups){
   const open=portfolioState.open.has(g.name),tr=el('tr','pulse-heat-row '+g.level);tr.tabIndex=0;tr.setAttribute('role','button');tr.setAttribute('aria-expanded',String(open));
   tr.append(el('td','pulse-heat-toggle',open?'▾':'▸'),el('td','pulse-heat-name',g.name),el('td','',g.observed+' / '+g.surveys),el('td','',compactNum(g.answers)),pctCell(g.answersChange,-5,-15),el('td','',g.responseRate==null?'—':df.format(g.responseRate)+'%'),el('td','',g.csi==null?'—':cf.format(g.csi)),csiCell(g.csiChange),paceCell(g.planPace),el('td',g.problems?'heat-warn':'',String(g.problems)));
   const toggle=()=>{if(portfolioState.open.has(g.name))portfolioState.open.delete(g.name);else portfolioState.open.add(g.name);renderPortfolio();};
   tr.onclick=toggle;tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}};table.append(tr);
   if(open){for(const m of g.members){const r=el('tr','pulse-heat-member'),name=el('td','pulse-heat-name');const link=button('#'+m.id+' · '+m.name,()=>askDialog('Покажи отправки, ответы и CSI по опросу '+m.id+' за последние 60 дней по дням'),'pulse-linkbtn');name.append(link);if(m.top)name.append(el('span','pulse-tag','топ'));
     const change=m.answersPrevious?(m.answers-m.answersPrevious)/m.answersPrevious*100:null,csiD=m.csi!=null&&m.csiPrevious!=null?m.csi-m.csiPrevious:null,pace=m.plan?m.mtdAnswers/(m.plan*(new Date(data.through).getUTCDate()/new Date(Date.UTC(+data.through.slice(0,4),+data.through.slice(5,7),0)).getUTCDate()))*100:null;
     const st=el('td');if(!m.top)st.append(star(data.channel,m.id,m.favorite));
     r.append(st,name,el('td','',m.observed?'':'нет данных'),el('td','',compactNum(m.answers)),pctCell(change,-5,-15),el('td','',m.sends?df.format(m.answers/m.sends*100)+'%':'—'),el('td','',m.csi==null?'—':cf.format(m.csi)),csiCell(csiD),paceCell(pace),el('td',m.shifts||m.signal?'heat-warn':'',(m.shifts?'сдвиг':'')+(m.signal?(m.shifts?' · ':'')+'сигнал':'')||'—'));table.append(r);}}
  }
  const wrap=el('div','pulse-table-wrap');wrap.append(table);host.append(wrap,el('p','pulse-muted',data.method));
 }
 function compactNum(v){if(v==null)return '—';const a=Math.abs(v);if(a>=1e6)return df.format(v/1e6)+' млн';if(a>=1e4)return nf.format(v/1e3)+' тыс.';return nf.format(v);}
 function plural(n,one,few,many){n=Math.abs(n)%100;if(n>=11&&n<=14)return many;n%=10;return n===1?one:n>=2&&n<=4?few:many;}
 ui={page,show,openUpload:()=>{location.hash='#pulse';},whatif:query=>{location.hash='#pulse';select('whatif');setTimeout(()=>{const input=panels.whatif.querySelector('.pulse-ask input');if(input&&query){input.value=query;input.form.requestSubmit();}},300);},meeting:()=>{location.hash='#pulse';select('meeting');},compare:()=>{location.hash='#pulse';select('compare');},showMode:()=>{location.hash='#pulse';setTimeout(showMode,400);},open:key=>{location.hash='#pulse';setTimeout(()=>select(key),50);},saveSkill:query=>saveSkill({query}),openCanvas:id=>{location.hash='#pulse';setTimeout(async()=>{select('canvas');await openCanvas(id);},50);},runSkill:skill=>runSkill(skill),skills:async()=>{try{if(!skillsCache)skillsCache=(await post({action:'skills'})).skills;}catch{skillsCache=[];}return skillsCache;}};
 return ui;
}

function askDialog(text){location.hash='#dialog';setTimeout(()=>{const q=document.getElementById('query'),form=document.getElementById('queryForm');if(q&&form){q.value=text;q.dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();}},250);}
/* ---------- загрузка CSV ---------- */
const expected={'push-sms.csv':'day_part','success-screen.csv':'mp_status','products.csv':'Опрос'};
function guessName(file,text){const name=file.name.toLowerCase();if(expected[name])return name;const head=text.replace(/^﻿/,'').split(/\r?\n/,1)[0].toLowerCase();if(head.includes('mp_status'))return 'success-screen.csv';if(head.includes('status_det'))return 'push-sms.csv';if(head.includes('опрос')&&head.includes('продукт'))return 'products.csv';return null;}
async function readText(file){const buffer=await file.arrayBuffer();const bytes=new Uint8Array(buffer);if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(buffer);if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(buffer);try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{return new TextDecoder('windows-1251').decode(buffer);}}
async function uploadFiles(files,log){
 log.replaceChildren();let saved=0;
 for(const file of files){const row=el('p','pulse-upload-row','⏳ '+file.name);log.append(row);
  try{if(file.size>150*1024*1024)throw new Error('файл больше 150 МБ — положите его в папку date вручную');const text=await readText(file);const name=guessName(file,text);if(!name)throw new Error('не удалось определить тип по имени и заголовку');
   const result=await post({name,content:text},'/api/pulse/upload');row.textContent='✓ '+result.message;row.classList.add('good');saved++;}
  catch(error){row.textContent='✕ '+file.name+': '+error.message;row.classList.add('bad');}
 }
 if(saved){const done=el('p','pulse-upload-row','Перечитываем данные…');log.append(done);try{const r=await fetch('/api/genui/status');const s=await r.json();done.textContent=s.data?.error?'CSV сохранены, но не применены: '+s.data.error:'Данные обновлены: опросов '+(s.data?.surveys??0)+'. Брифинг готовится.';document.getElementById('refreshData')?.click();window.dispatchEvent(new CustomEvent('pulse:data'));}catch{done.textContent='CSV сохранены. Нажмите «Проверить данные».';}}
}
function globalDrop(){
 const overlay=el('div','pulse-drop-overlay','Отпустите CSV — сохраним в папку date и проверим заголовки');overlay.hidden=true;document.body.append(overlay);
 const toast=el('div','pulse-toast');toast.hidden=true;toast.setAttribute('role','status');document.body.append(toast);let depth=0;
 const isFiles=e=>[...(e.dataTransfer?.types||[])].includes('Files');
 window.addEventListener('dragenter',e=>{if(!isFiles(e))return;depth++;overlay.hidden=false;});
 window.addEventListener('dragleave',e=>{if(!isFiles(e))return;depth=Math.max(0,depth-1);if(!depth)overlay.hidden=true;});
 window.addEventListener('dragover',e=>{if(isFiles(e))e.preventDefault();});
 window.addEventListener('drop',e=>{if(!isFiles(e))return;e.preventDefault();depth=0;overlay.hidden=true;const files=[...e.dataTransfer.files].filter(f=>/\.(csv|txt)$/i.test(f.name));if(!files.length)return;toast.hidden=false;uploadFiles(files,toast).finally(()=>setTimeout(()=>toast.hidden=true,8000));});
}

/* ---------- компактная навигация ---------- */
const PRIMARY=['#pulse','#feedback','#dialog','#morning-monitor','#surveys-top','#surveys-communication','#surveys-success_screen','#favorites'];
function compactNav(){
 const rail=document.querySelector('.rail');if(!rail)return;
 let group=rail.querySelector('.nav-more');
 if(!group){group=el('details','nav-more');const summary=el('summary','nav-item nav-more-summary','Ещё разделы');group.append(summary,el('div','nav-more-list'));rail.insertBefore(group,rail.querySelector('.history'));
  try{group.open=localStorage.getItem('pulse-nav-more')==='1';}catch{}group.addEventListener('toggle',()=>{try{localStorage.setItem('pulse-nav-more',group.open?'1':'0');}catch{}});}
 const list=group.querySelector('.nav-more-list');
 for(const item of [...rail.querySelectorAll(':scope > .nav-item')]){if(item.classList.contains('nav-more-summary'))continue;const href=item.getAttribute('href');if(!PRIMARY.includes(href))list.append(item);}
 const primary=[...rail.querySelectorAll(':scope > .nav-item')].sort((a,b)=>PRIMARY.indexOf(a.getAttribute('href'))-PRIMARY.indexOf(b.getAttribute('href')));
 const label=rail.querySelector('.rail-label');let after=label;for(const item of primary){after.after(item);after=item;}
 group.querySelector('summary').textContent='Ещё разделы · '+list.childElementCount;
 if(list.querySelector('.active'))group.open=true;
}

/* ---------- командная строка Ctrl+K ---------- */
function palette(api){
 const box=el('dialog','pulse-palette');box.setAttribute('aria-label','Поиск и команды');
 const input=el('input');input.type='search';input.placeholder='Раздел, опрос, продукт или вопрос к данным…';input.setAttribute('aria-label','Поиск и команды');input.setAttribute('role','combobox');input.setAttribute('aria-controls','pulsePaletteList');input.setAttribute('aria-expanded','true');
 const listbox=el('div','pulse-palette-list');listbox.id='pulsePaletteList';listbox.setAttribute('role','listbox');const hint=el('p','pulse-muted','↑↓ — выбор · Enter — открыть · Esc — закрыть');
 box.append(input,listbox,hint);document.body.append(box);
 let items=[],active=0,catalog=null,modelReady=false,skills=[],canvases=[];
 const norm=s=>s.toLowerCase().replace(/ё/g,'е');
 function navItems(){return [...document.querySelectorAll('.rail .nav-item')].filter(n=>!n.classList.contains('nav-more-summary')).map(n=>({kind:'Раздел',label:n.textContent.trim(),run:()=>{if(n.tagName==='A')location.hash=n.getAttribute('href');else n.click();}}));}
 function ask(text){location.hash='#dialog';setTimeout(()=>{const q=document.getElementById('query'),form=document.getElementById('queryForm');if(q&&form){q.value=text;q.dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();}},250);}
 function build(query){
  const q=norm(query.trim()),tokens=q.split(/\s+/).filter(Boolean),out=[];
  const score=label=>{const l=norm(label);if(!tokens.length)return 1;let s=0;for(const t of tokens){if(!l.includes(t))return 0;s+=l.startsWith(t)?3:1;}return s;};
  for(const item of navItems()){const s=score(item.label);if(s)out.push({...item,s:s+2});}
  const actions=[
   {kind:'Действие',label:'Пересчитать брифинг',run:()=>{location.hash='#pulse';setTimeout(()=>document.querySelector('.pulse-head .pulse-btn')?.click(),100);}},
   {kind:'Действие',label:'Собрать встречу в один клик',run:()=>api.meeting()},
   {kind:'Действие',label:'Сценарий «что если»',run:()=>api.whatif('')},
   {kind:'Действие',label:'Сравнить опросы и продукты',run:()=>api.compare()},
   {kind:'Раздел',label:'Холсты: мой экран, инцидент, комитет',run:()=>api.open('canvas')},
   {kind:'Раздел',label:'Скилы и галерея вопросов',run:()=>api.open('skills')},
   {kind:'Раздел',label:'Эффект: было → стало',run:()=>api.open('effect')},
   {kind:'Действие',label:'Режим показа (презентация брифинга)',run:()=>api.showMode()},
   {kind:'Действие',label:'Оформление: тема, цвета, фон графиков',run:()=>window.Appearance?.open()},
   {kind:'Действие',label:'Загрузить CSV',run:()=>{location.hash='#pulse';const picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.accept='.csv';picker.onchange=()=>{const toast=document.querySelector('.pulse-toast');toast.hidden=false;uploadFiles([...picker.files],toast);};picker.click();}},
   {kind:'Действие',label:'Проверить данные',run:()=>{location.hash='#admin-data';setTimeout(()=>document.getElementById('refreshData')?.click(),100);}},
  ];
  for(const a of actions){const s=score(a.label);if(s)out.push({...a,s:s+1});}
  for(const cv of canvases){const s=score('холст '+cv.name);if(s)out.push({kind:'Холст',label:cv.name,s:s+2,run:()=>api.openCanvas(cv.id)});}
  for(const sk of skills){const s=score(sk.name+' '+sk.query);if(s&&tokens.length)out.push({kind:'Скил',label:sk.name,s:s+2,run:()=>api.runSkill(sk)});}
  if(catalog){
   const idMatch=q.match(/\d{1,7}/);
   for(const sv of catalog.surveys){let s=0;if(idMatch&&String(sv.id).startsWith(idMatch[0]))s=String(sv.id)===idMatch[0]?9:4;else s=score(sv.name+' '+sv.products.join(' '));if(!s||!tokens.length)continue;
    out.push({kind:sv.channel==='success_screen'?'Опрос · ЭУ':'Опрос · пуш+СМС',label:'#'+sv.id+' · '+sv.name,s,run:()=>ask('Покажи отправки, ответы и CSI по опросу '+sv.id+' за последние 3 месяца по дням')});}
   for(const p of catalog.products){const s=score(p);if(!s||!tokens.length)continue;out.push({kind:'Продукт',label:p,s,run:()=>ask('Покажи отправки и ответы по продукту '+p+' за последние 30 дней')});}
  }
  out.sort((a,b)=>b.s-a.s);const top=out.slice(0,12);
  if(query.trim()){
   if(/что\s+если|если\s+отклик|если\s+отправ/i.test(query))top.unshift({kind:'Что если',label:query.trim(),run:()=>api.whatif(query.trim())});
   top.push({kind:'Диалог',label:'Спросить в диалоге: «'+query.trim()+'»',run:()=>ask(query.trim())});
   if(modelReady)top.push({kind:'GigaCode',label:'Подобрать раздел через GigaCode',run:()=>routeWithModel(query.trim())});
  }
  return top;
 }
 async function routeWithModel(query){const options=navItems().map((n,i)=>({id:'N'+i,label:n.label}));const nav=navItems();try{const r=await post({action:'route',query,options});if(r.ask||!r.id){ask(query);return;}const idx=Number(r.id.slice(1));nav[idx]?.run();}catch(error){alert(error.message);}}
 function render(){listbox.replaceChildren();items.forEach((item,i)=>{const row=el('div','pulse-palette-item'+(i===active?' active':''));row.setAttribute('role','option');row.id='pp'+i;row.setAttribute('aria-selected',String(i===active));row.append(el('span','pulse-palette-kind',item.kind),el('span','',item.label));row.onmousedown=e=>{e.preventDefault();choose(i);};listbox.append(row);});input.setAttribute('aria-activedescendant',items.length?'pp'+active:'');if(!items.length)listbox.append(el('p','pulse-muted','Ничего не найдено'));}
 function update(){items=build(input.value);active=0;render();}
 function choose(i){const item=items[i];if(!item)return;box.close();item.run();}
 input.addEventListener('input',update);
 input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();active=Math.min(items.length-1,active+1);render();listbox.children[active]?.scrollIntoView({block:'nearest'});}else if(e.key==='ArrowUp'){e.preventDefault();active=Math.max(0,active-1);render();listbox.children[active]?.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'){e.preventDefault();choose(active);}else if(e.key==='Escape'){e.preventDefault();box.close();}});
 box.addEventListener('click',e=>{if(e.target===box)box.close();});
 async function open(){input.value='';update();box.showModal();input.focus();try{skills=await api.skills();try{canvases=(await post({action:'canvas-list'})).canvases;}catch{}if(!catalog)catalog=await post({action:'catalog'});const s=await (await fetch('/api/genui/status')).json();modelReady=Boolean(s.configured);update();if(box.open)input.focus();}catch{}}
 document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'||((e.ctrlKey||e.metaKey)&&e.code==='KeyK')){e.preventDefault();if(box.open)box.close();else open();}});
 window.addEventListener('pulse:data',()=>{catalog=null;});
 document.addEventListener('focusin',e=>{if(box.open&&!box.contains(e.target))input.focus();});
 const bar=document.querySelector('.topbar');if(bar){const trigger=el('button','pulse-palette-trigger');trigger.type='button';trigger.append(el('span','','Поиск и команды'),el('kbd','','Ctrl K'));trigger.onclick=open;const crumb=bar.querySelector('span');if(crumb)crumb.after(trigger);else bar.prepend(trigger);}
 return {open};
}

function composerSkill(ui){
 const form=document.getElementById('queryForm'),input=document.getElementById('query');if(!form||!input)return;let last='';
 form.addEventListener('submit',()=>{if(input.value.trim())last=input.value.trim();},true);
 const bottom=form.querySelector('.composer-bottom')||form;const b=el('button','pulse-btn ghost pulse-save-skill','☆ В скилы');b.title='Сохранить запрос как скил';b.type='button';
 b.onclick=()=>{const q=input.value.trim()||last;if(!q){input.focus();return;}ui.saveSkill(q);};bottom.prepend(b);
}
/* ---------- крупные числа помещаются в плитку ---------- */
function fitNumbers(){for(const node of document.querySelectorAll('.trust-card>strong,.pulse-kpi b,.pulse-tile-value')){if(!node.offsetParent)continue;node.style.fontSize='';let size=parseFloat(getComputedStyle(node).fontSize);while(node.scrollWidth>node.clientWidth+1&&size>13){size-=1;node.style.fontSize=size+'px';}}}
function foldHelp(){for(const chart of document.querySelectorAll('.v2-chart:not([data-help-folded])')){chart.dataset.helpFolded='1';if(!chart.querySelector('.v2-chart-help:not(.is-warning)'))continue;chart.classList.add('v2-help-folded');const t=document.createElement('button');t.type='button';t.className='v2-chart-help-toggle';t.textContent='i';t.title='Как читать график';t.setAttribute('aria-label','Показать пояснения к графику');t.setAttribute('aria-expanded','false');t.onclick=()=>{const folded=chart.classList.toggle('v2-help-folded');t.setAttribute('aria-expanded',String(!folded));};const head=chart.querySelector('.v2-chart-head h3')||chart.querySelector('h3')||chart.firstElementChild;head?.append(document.createTextNode(' '),t);}}
let fitTimer=null;const scheduleFit=()=>{clearTimeout(fitTimer);fitTimer=setTimeout(()=>{fitNumbers();foldHelp();},120);};
/* ---------- заголовок раздела ---------- */
function fixBreadcrumb(){const name=document.getElementById('sectionName');if(!name)return;const hash=location.hash||'#pulse';const active=document.querySelector('.rail .nav-item.active');
 if(hash.startsWith('#admin')||['#agent-log','#diagnostics'].includes(hash))name.textContent='Администрирование';else if(active&&!active.classList.contains('nav-more-summary'))name.textContent=active.textContent.trim();}

window.PulseUI={create:main=>{
 const ui=create(main);
 window.addEventListener('load',()=>{new MutationObserver(scheduleFit).observe(document.getElementById('main')||document.body,{childList:true,subtree:true});window.addEventListener('resize',scheduleFit);composerSkill(ui);compactNav();new MutationObserver(()=>{const rail=document.querySelector('.rail');if([...rail.querySelectorAll(':scope > .nav-item')].some(n=>!PRIMARY.includes(n.getAttribute('href'))&&!n.classList.contains('nav-more-summary')))compactNav();}).observe(document.querySelector('.rail'),{childList:true});fixBreadcrumb();palette(ui);globalDrop();});
 window.addEventListener('hashchange',()=>setTimeout(()=>{compactNav();fixBreadcrumb();},0));
 window.addEventListener('pulse:data',()=>{if(location.hash==='#pulse'||!location.hash)ui.show();});
 return ui;
}};
})();
