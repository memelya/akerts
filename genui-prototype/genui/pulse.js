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
function lineChart({series,marker,events=[],width=Math.max(320,Math.min(1100,(chartHostWidth||document.querySelector('.pulse-page')?.clientWidth||960)-48)),height=180,format=v=>nf.format(v),label='График',onPoint}){
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
 for(const ev of events){if(ev.date<dates[0]||ev.date>dates.at(-1))continue;const ex=X(ev.date);const line=svg('line',{x1:ex,x2:ex,y1:pad.t,y2:pad.t+h,class:'event'});const flag=svg('path',{d:`M${ex} ${pad.t}l8 4l-8 4z`,class:'event-flag'});const tip=svg('title');tip.textContent=dateLabel(ev.date)+' · '+ev.title;flag.append(tip);root.append(line,flag);}
 if(marker){const mx=X(marker);root.append(svg('line',{x1:mx,x2:mx,y1:pad.t,y2:pad.t+h,class:'marker'}));const t=svg('text',{x:mx+4,y:pad.t+10,class:'axis marker-label'});t.textContent='сдвиг '+dateLabel(marker);root.append(t);}
 series.forEach((s,si)=>{
  if(!s.points.length)return;const cls=s.cls||'c'+si%5;
  if(s.segments){for(const [from,to,value] of s.segments)root.append(svg('line',{x1:X(from),x2:X(to),y1:Y(value),y2:Y(value),class:'level'}));}
  const d=s.points.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ');
  root.append(svg('path',{d,class:'line '+cls,fill:'none'}));
 });
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
 let brief=null,catalog=null,tab='brief',loading=false;
 const header=el('div','pulse-head'),title=el('h1','','Пульс дня');title.id='pulseTitle';
 const meta=el('p','pulse-muted'),status=el('p','pulse-status');status.setAttribute('role','status');
 const refresh=button('Пересчитать',()=>load(true),'pulse-btn ghost');
 const tabs=el('div','pulse-tabs');tabs.setAttribute('role','tablist');
 const panels={brief:el('div','pulse-panel'),compare:el('div','pulse-panel'),whatif:el('div','pulse-panel'),memory:el('div','pulse-panel'),meeting:el('div','pulse-panel')};
 const tabNames={brief:'Брифинг',compare:'Сравнение',whatif:'Что если',memory:'Память расследований',meeting:'Встреча в один клик'};
 for(const [key,name] of Object.entries(tabNames)){const t=button(name,()=>select(key),'pulse-tab');t.setAttribute('role','tab');t.dataset.tab=key;tabs.append(t);}
 const showButton=button('▶ Режим показа',()=>showMode(),'pulse-btn accent'),mailButton=button('Бриф письмом',e=>busy(e.target,status,async()=>{select('meeting');await renderMeetingForm();panels.meeting.querySelector('.pulse-btn.accent')?.click();status.textContent='Черновик собран — нажмите «Письмо (.eml)» или «Скачать PPTX».';}),'pulse-btn ghost'),demoReset=button('Сбросить демо',e=>{if(!confirm('Вернуть демо в исходное состояние? Заметки и резюме демо будут очищены.'))return;busy(e.target,status,async()=>{brief=await post({action:'demo-reset'});panels.compare.replaceChildren();panels.whatif.replaceChildren();panels.meeting.replaceChildren();renderBrief();status.textContent='Демо возвращено в исходное состояние.';});},'pulse-btn ghost'),demoBadge=el('span','pulse-tag warn','ДЕМО-ДАННЫЕ');demoReset.hidden=demoBadge.hidden=true;
 const headText=el('div'),tools=el('div','pulse-row pulse-tools');headText.append(title,meta);tools.append(demoBadge,showButton,mailButton,refresh,demoReset);header.append(headText,tools);
 page.append(header,status,tabs,...Object.values(panels));
 function select(key){tab=key;for(const t of tabs.children){const on=t.dataset.tab===key;t.classList.toggle('active',on);t.setAttribute('aria-selected',String(on));}for(const [k,p] of Object.entries(panels))p.hidden=k!==key;
  if(key==='memory')renderMemory();if(key==='compare'&&!panels.compare.childElementCount)renderCompare();if(key==='meeting'&&!panels.meeting.childElementCount)renderMeetingForm();if(key==='whatif'&&!panels.whatif.childElementCount)renderWhatIf();}

 async function ensureCatalog(){if(!catalog){try{catalog=await post({action:'catalog'});}catch{catalog={surveys:[],products:[]};}}return catalog;}
 async function load(force=false){
  if(loading)return;loading=true;status.textContent=force?'Пересчитываем брифинг…':'Открываем подготовленный брифинг…';status.classList.remove('is-error');
  try{brief=await post({action:'brief',force});status.textContent='';renderBrief();}
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
  host.append(narrativeCard(),kpiRow(),changesCard());
  if(brief.clusters?.length){const section=el('section','pulse-section');section.append(el('h2','','Групповые инциденты · '+brief.clusters.length),el('p','pulse-muted','Однотипные сдвиги у нескольких опросов в пределах двух дней. Вероятна общая причина — проверьте её один раз, а не по каждому опросу.'));for(const c of brief.clusters)section.append(clusterCard(c));host.append(section);}
  const shifts=el('section','pulse-section');shifts.append(el('h2','','Сдвиги уровня за 8 недель · '+brief.shiftTotal),el('p','pulse-muted','Устойчивая ступень в дневном ряду: минимум 7 дней до и после, изменение от 25% (CSI — от 0,25 балла) и подтверждение в последние 7 дней. Пропуски не считаются нулями.'));
  if(!brief.shifts.length)shifts.append(el('p','pulse-empty','Устойчивых сдвигов не найдено.'));
  for(const s of brief.shifts)shifts.append(shiftCard(s));
  host.append(shifts);
  const urgent=brief.signals.filter(s=>s.severity==='urgent'),attention=brief.signals.filter(s=>s.severity!=='urgent');
  const signals=el('section','pulse-section');signals.append(el('h2','','Сигналы утреннего мониторинга · '+brief.signals.length));
  if(!brief.signals.length)signals.append(el('p','pulse-empty','Сигналов недельного сравнения нет.'));
  for(const s of [...urgent,...attention].slice(0,12)){const card=el('article','pulse-card pulse-signal '+s.severity);card.append(el('span','pulse-tag '+(s.severity==='urgent'?'bad':''),s.severity==='urgent'?'Срочно':'Внимание'),el('h3','','#'+s.id+' · '+s.name),el('p','pulse-muted',s.channelLabel+' · по '+s.through),el('p','',s.reasons.join(' · ')));signals.append(card);}
  const more=el('a','pulse-link','Открыть утренний мониторинг →');more.href='#morning-monitor';signals.append(more);host.append(signals);
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
   steps.replaceChildren();const data=await post({action:'point',...ctx,useModel:false});
   const extra=ai()?button('Объяснить эту точку через GigaCode',e=>busy(e.target,line,async()=>{const r=await runJob({action:'point',...ctx,useModel:true},steps);renderExplain(out,{...r,date:ctx.date,title:ctx.title});}),'pulse-btn accent'):null;
   renderExplain(out,{...data,title:ctx.title},extra);
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
   onPoint:date=>openPoint(out,steps,{channel:s.channel,id:s.id,metric:s.metric,date,title:'#'+s.id+' · '+s.label.toLowerCase()+' · '+dateLabel(date)},line)}));
  if(s.memory?.length){const mem=el('div','pulse-memory');mem.append(el('b','','Похоже на прошлый случай'));for(const n of s.memory)mem.append(el('p','',n.title+' — '+n.cause+(n.action?' · помогло: '+n.action:'')+' ('+new Date(n.created).toLocaleDateString('ru-RU')+')'));card.append(mem);}
  const actions=el('div','pulse-row');
  actions.append(button('Похожие опросы',e=>busy(e.target,line,async()=>{steps.replaceChildren();renderSimilar(out,await post({action:'similar',channel:s.channel,id:s.id,metric:s.metric,date:s.date}));})));
  actions.append(button('Факты и проверки',e=>busy(e.target,line,async()=>{steps.replaceChildren();renderExplain(out,await post({action:'explain',channel:s.channel,id:s.id,metric:s.metric,useModel:false}));})));
  if(ai())actions.append(button('Объяснить через GigaCode',e=>busy(e.target,line,async()=>{const r=await runJob({action:'explain',channel:s.channel,id:s.id,metric:s.metric,useModel:true},steps);renderExplain(out,r);}),'pulse-btn accent'));
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
  go.onclick=()=>busy(go,line,async()=>{const data=await post({action:'meeting',product:product.value||null,limit:Number(limit.value)||5});renderDeck(deck,data);});
  host.append(row,go,line,deck);
 }
 const TEMPLATES={dark:{name:'Тёмный',bg:'111111',fg:'EDEDED',muted:'9A9A9A',card:'1F1F1F',plot:'181818'},light:{name:'Светлый',bg:'FFFFFF',fg:'1C1B19',muted:'716E67',card:'F3F2EE',plot:'FFFFFF'},brand:{name:'Фирменный',bg:'FFFFFF',fg:'1C1B19',muted:'716E67',card:'F3F2EE',plot:'FFFFFF',band:true}};
 function brandSettings(){let saved={};try{saved=JSON.parse(localStorage.getItem('pulse-brand')||'{}')||{};}catch{}const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();return {template:saved.template||'dark',accent:saved.accent||(/^#[0-9a-f]{6}$/i.test(accent)?accent:'#ff8a35'),org:saved.org||'',logo:saved.logo||''};}
 function saveBrand(value){try{localStorage.setItem('pulse-brand',JSON.stringify(value));}catch{}}
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
  actions.append(button('Скачать PPTX',e=>busy(e.target,line,async()=>{await exportPptx(read(),data,brand);line.textContent='PPTX скачан: шаблон «'+TEMPLATES[brand.template].name+'».';}),'pulse-btn accent'),
   button('Письмо (.eml)',e=>busy(e.target,line,async()=>{const images=[];for(const item of slides)images.push(item.chart?await svgToPng(item.chart.querySelector('svg'),'#ffffff'):null);const content=read();download('pulse-'+String(data.revision).slice(0,8)+'.eml',buildEml(content[0].title+' · '+content[0].subtitle,content,images,brand.accent),'message/rfc822');line.textContent='Письмо скачано: откройте файл — это черновик в почтовой программе.';})),
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
  slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Пульс дня · данные по '+dateLabel(brief.kpis.map(k=>k.through).sort().at(-1))),el('h1','',brief.narrative?.headline||headline()));if(brief.narrative){const ul=el('ul','show-bullets');for(const b of brief.narrative.bullets)ul.append(el('li','',b.text));s.append(ul);}s.append(kpiRow());return s;});
  if(brief.changes&&(brief.changes.counts.added||brief.changes.counts.worse||brief.changes.counts.resolved))slides.push(()=>changesCard());
  for(const c of brief.clusters.slice(0,3))slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Групповой инцидент'),clusterCard(c));for(const m of c.members.slice(0,2)){const full=brief.shifts.find(x=>x.id===m.id&&x.metric===c.metric);if(full)s.append(shiftCard(full));}return s;});
  const inCluster=new Set(brief.clusters.flatMap(c=>c.members.map(m=>m.id+':'+c.metric)));
  for(const sft of brief.shifts.filter(x=>!inCluster.has(x.id+':'+x.metric)).slice(0,5))slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow',sft.direction==='down'?'Устойчивое снижение':'Устойчивый рост'),shiftCard(sft));return s;});
  if(brief.signals.length)slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Сигналы недельного сравнения'),el('h1','','Что случилось на этой неделе'));for(const g of brief.signals.slice(0,6)){const card=el('article','pulse-card pulse-signal '+g.severity);card.append(el('span','pulse-tag '+(g.severity==='urgent'?'bad':''),g.severity==='urgent'?'Срочно':'Внимание'),el('h3','','#'+g.id+' · '+g.name),el('p','',g.reasons.join(' · ')));s.append(card);}return s;});
  slides.push(()=>{const s=el('div','show-body');s.append(el('p','pulse-eyebrow','Что дальше'),el('h1','','От отклонения — к решению'));const row=el('div','pulse-row');row.append(button('Смоделировать «что если»',()=>{closeShow();select('whatif');},'pulse-btn accent'),button('Сравнить опросы и продукты',()=>{closeShow();select('compare');}),button('Собрать презентацию',()=>{closeShow();select('meeting');}));s.append(row);return s;});
  let index=0;const overlay=el('div','pulse-show'),stage=el('div','show-stage'),bar=el('div','show-bar'),counter=el('span','show-counter'),dots=el('div','show-dots');
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','Режим показа');
  const prev=button('← Назад',()=>go(index-1),'pulse-btn ghost'),next=button('Дальше →',()=>go(index+1),'pulse-btn accent'),close=button('Закрыть',closeShow,'pulse-btn ghost');
  bar.append(prev,dots,counter,next,close);overlay.append(stage,bar);document.body.append(overlay);showOverlay=overlay;
  function go(i){index=Math.max(0,Math.min(slides.length-1,i));chartHostWidth=Math.min(stage.clientWidth,1180);stage.replaceChildren(slides[index]());stage.scrollTop=0;counter.textContent=(index+1)+' / '+slides.length;prev.disabled=index===0;next.disabled=index===slides.length-1;dots.replaceChildren(...slides.map((_,k)=>{const d=el('i',k===index?'on':'');d.onclick=()=>go(k);return d;}));}
  showKeys=e=>{if(e.target.closest?.('input,textarea,select,[contenteditable=true]'))return;if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();go(index+1);}else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(index-1);}else if(e.key==='Escape'){closeShow();}};
  document.addEventListener('keydown',showKeys);
  document.documentElement.requestFullscreen?.().catch(()=>{}).finally(()=>setTimeout(()=>go(index),150));go(0);
 }

 return {page,show,openUpload:()=>{location.hash='#pulse';},whatif:query=>{location.hash='#pulse';select('whatif');setTimeout(()=>{const input=panels.whatif.querySelector('.pulse-ask input');if(input&&query){input.value=query;input.form.requestSubmit();}},300);},meeting:()=>{location.hash='#pulse';select('meeting');},compare:()=>{location.hash='#pulse';select('compare');},showMode:()=>{location.hash='#pulse';setTimeout(showMode,400);}};
}

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
 let items=[],active=0,catalog=null,modelReady=false;
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
   {kind:'Действие',label:'Режим показа (презентация брифинга)',run:()=>api.showMode()},
   {kind:'Действие',label:'Оформление: тема, цвета, фон графиков',run:()=>window.Appearance?.open()},
   {kind:'Действие',label:'Загрузить CSV',run:()=>{location.hash='#pulse';const picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.accept='.csv';picker.onchange=()=>{const toast=document.querySelector('.pulse-toast');toast.hidden=false;uploadFiles([...picker.files],toast);};picker.click();}},
   {kind:'Действие',label:'Проверить данные',run:()=>{location.hash='#admin-data';setTimeout(()=>document.getElementById('refreshData')?.click(),100);}},
  ];
  for(const a of actions){const s=score(a.label);if(s)out.push({...a,s:s+1});}
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
 input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();active=Math.min(items.length-1,active+1);render();listbox.children[active]?.scrollIntoView({block:'nearest'});}else if(e.key==='ArrowUp'){e.preventDefault();active=Math.max(0,active-1);render();listbox.children[active]?.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'){e.preventDefault();choose(active);}});
 box.addEventListener('click',e=>{if(e.target===box)box.close();});
 async function open(){input.value='';update();box.showModal();input.focus();try{if(!catalog)catalog=await post({action:'catalog'});const s=await (await fetch('/api/genui/status')).json();modelReady=Boolean(s.configured);update();}catch{}}
 document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'||((e.ctrlKey||e.metaKey)&&e.code==='KeyK')){e.preventDefault();if(box.open)box.close();else open();}});
 window.addEventListener('pulse:data',()=>{catalog=null;});
 const bar=document.querySelector('.topbar');if(bar){const trigger=el('button','pulse-palette-trigger');trigger.type='button';trigger.append(el('span','','Поиск и команды'),el('kbd','','Ctrl K'));trigger.onclick=open;const crumb=bar.querySelector('span');if(crumb)crumb.after(trigger);else bar.prepend(trigger);}
 return {open};
}

/* ---------- заголовок раздела ---------- */
function fixBreadcrumb(){const name=document.getElementById('sectionName');if(!name)return;const hash=location.hash||'#pulse';const active=document.querySelector('.rail .nav-item.active');
 if(hash.startsWith('#admin')||['#agent-log','#diagnostics'].includes(hash))name.textContent='Администрирование';else if(active&&!active.classList.contains('nav-more-summary'))name.textContent=active.textContent.trim();}

window.PulseUI={create:main=>{
 const ui=create(main);
 window.addEventListener('load',()=>{compactNav();new MutationObserver(()=>{const rail=document.querySelector('.rail');if([...rail.querySelectorAll(':scope > .nav-item')].some(n=>!PRIMARY.includes(n.getAttribute('href'))&&!n.classList.contains('nav-more-summary')))compactNav();}).observe(document.querySelector('.rail'),{childList:true});fixBreadcrumb();palette(ui);globalDrop();});
 window.addEventListener('hashchange',()=>setTimeout(()=>{compactNav();fixBreadcrumb();},0));
 window.addEventListener('pulse:data',()=>{if(location.hash==='#pulse'||!location.hash)ui.show();});
 return ui;
}};
})();
