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
function lineChart({series,marker,width=Math.max(320,Math.min(1100,(document.querySelector('.pulse-page')?.clientWidth||960)-48)),height=180,format=v=>nf.format(v),label='График'}){
 const all=series.flatMap(s=>s.points);const host=el('div','pulse-chart');
 if(!all.length){host.append(el('p','pulse-muted','Нет наблюдений для графика.'));return host;}
 const dates=[...new Set(all.map(p=>p[0]))].sort(),x0=Date.parse(dates[0]),x1=Date.parse(dates.at(-1))||x0+1;
 const values=all.map(p=>p[1]);let lo=Math.min(...values),hi=Math.max(...values);if(lo>0&&series.every(s=>!s.zeroless))lo=0;if(hi===lo)hi=lo+1;
 const pad={l:52,r:12,t:12,b:24},w=width-pad.l-pad.r,h=height-pad.t-pad.b;
 const X=d=>pad.l+(x1===x0?w/2:(Date.parse(d)-x0)/(x1-x0)*w),Y=v=>pad.t+h-(v-lo)/(hi-lo)*h;
 const root=svg('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':label,preserveAspectRatio:'none'});
 for(let i=0;i<=3;i++){const v=lo+(hi-lo)*i/3,y=Y(v);root.append(svg('line',{x1:pad.l,x2:width-pad.r,y1:y,y2:y,class:'grid'}));const t=svg('text',{x:pad.l-6,y:y+4,'text-anchor':'end',class:'axis'});t.textContent=format(v);root.append(t);}
 for(const d of [dates[0],dates[Math.floor(dates.length/2)],dates.at(-1)]){const t=svg('text',{x:X(d),y:height-6,'text-anchor':'middle',class:'axis'});t.textContent=dateLabel(d);root.append(t);}
 if(marker){const mx=X(marker);root.append(svg('line',{x1:mx,x2:mx,y1:pad.t,y2:pad.t+h,class:'marker'}));const t=svg('text',{x:mx+4,y:pad.t+10,class:'axis marker-label'});t.textContent='сдвиг '+dateLabel(marker);root.append(t);}
 for(const s of series){
  if(!s.points.length)continue;
  if(s.segments){for(const [from,to,value] of s.segments)root.append(svg('line',{x1:X(from),x2:X(to),y1:Y(value),y2:Y(value),class:'level'}));}
  const d=s.points.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ');
  root.append(svg('path',{d,class:'line '+(s.cls||''),fill:'none'}));
 }
 host.append(root);
 const legend=el('div','pulse-legend');for(const s of series)if(s.name){const item=el('span','pulse-legend-item '+(s.cls||''));item.append(el('i'),document.createTextNode(s.name));legend.append(item);}
 if(legend.childElementCount)host.append(legend);
 return host;
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
 const panels={brief:el('div','pulse-panel'),whatif:el('div','pulse-panel'),memory:el('div','pulse-panel'),meeting:el('div','pulse-panel')};
 const tabNames={brief:'Брифинг',whatif:'Что если',memory:'Память расследований',meeting:'Встреча в один клик'};
 for(const [key,name] of Object.entries(tabNames)){const t=button(name,()=>select(key),'pulse-tab');t.setAttribute('role','tab');t.dataset.tab=key;tabs.append(t);}
 const headText=el('div');headText.append(title,meta);header.append(headText,refresh);
 page.append(header,status,tabs,...Object.values(panels));
 function select(key){tab=key;for(const t of tabs.children){const on=t.dataset.tab===key;t.classList.toggle('active',on);t.setAttribute('aria-selected',String(on));}for(const [k,p] of Object.entries(panels))p.hidden=k!==key;
  if(key==='memory')renderMemory();if(key==='meeting'&&!panels.meeting.childElementCount)renderMeetingForm();if(key==='whatif'&&!panels.whatif.childElementCount)renderWhatIf();}

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
 function narrativeCard(){
  const card=el('section','pulse-card pulse-narrative');const statusLine=el('p','pulse-status');statusLine.setAttribute('role','status');
  card.append(el('p','pulse-eyebrow','Резюме для руководителя'));
  if(brief.narrative){
   card.append(el('h2','',brief.narrative.headline));const list=el('ul');
   const facts=new Map(brief.narrative.facts.map(f=>[f.ref,f]));
   for(const b of brief.narrative.bullets){const li=el('li','',b.text);const refs=el('span','pulse-refs');for(const r of b.refs){const f=facts.get(r);const chip=el('abbr','pulse-ref',r);if(f)chip.title=f.label+': '+(typeof f.value==='number'?fmt(f.value):f.value)+(f.unit?' '+f.unit:'')+(f.period?' · '+f.period:'');refs.append(chip);}li.append(refs);list.append(li);}
   card.append(list,el('p','pulse-muted','GigaCode CLI · '+new Date(brief.narrative.generatedAt).toLocaleString('ru-RU')+' · числа проверены по фактам F…; наведите на ссылку, чтобы увидеть факт'));
  }else{
   card.append(el('h2','',headline()));
   card.append(el('p','pulse-muted',brief.modelReady?'Резюме собрано правилами. GigaCode может сформулировать его для руководителя — числа будут проверены по фактам.':'Резюме собрано правилами. Подключите GigaCode CLI, чтобы получать формулировку модели.'));
  }
  const controls=el('div','pulse-row');
  if(brief.modelReady)controls.append(button(brief.narrative?'Переформулировать':'Сформулировать через GigaCode',e=>busy(e.target,statusLine,async()=>{const n=await post({action:'narrate'});brief.narrative=n;renderBrief();})));
  const auto=el('label','pulse-check'),box=el('input');box.type='checkbox';box.checked=Boolean(brief.settings?.autoNarrate);box.disabled=!brief.modelReady;
  box.onchange=()=>busy(box,statusLine,async()=>{const s=await post({action:'settings',autoNarrate:box.checked});brief.settings=s;statusLine.textContent=s.autoNarrate?'Резюме будет готовиться в фоне при каждой новой загрузке.':'Фоновая подготовка резюме выключена.';});
  auto.append(box,document.createTextNode(' Готовить AI-резюме заранее'));controls.append(auto);
  if(brief.error)statusLine.textContent=brief.error;
  card.append(controls,statusLine);return card;
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
 function shiftCard(s){
  const card=el('article','pulse-card pulse-shift '+s.direction);
  const tags=el('div','pulse-row');tags.append(el('span','pulse-tag '+(s.direction==='down'?'bad':'good'),s.label+' '+change(s)),el('span','pulse-tag',s.channelLabel));
  if(s.severity==='high')tags.append(el('span','pulse-tag bad','сильный'));
  if(s.hiddenFromWeekly)tags.append(el('span','pulse-tag warn','недельное сравнение не видит'));
  card.append(tags,el('h3','','#'+s.id+' · '+s.name));
  const unit=s.metric==='csi'?'':' '+s.unit;
  card.append(el('p','',s.label+': '+fmt(s.before,s.metric)+unit+' → '+fmt(s.after,s.metric)+unit+' с '+dateLabel(s.date)+' · дней до/после: '+s.daysBefore+'/'+s.daysAfter));
  const first=s.series[0][0],last=s.series.at(-1)[0];
  card.append(lineChart({series:[{points:s.series,cls:'primary',segments:[[first,s.lastBefore,s.before],[s.date,last,s.after]],zeroless:s.metric==='csi'}],marker:s.date,format:v=>s.metric==='csi'?cf.format(v):nf.format(v),label:s.label+' по дням, опрос '+s.id,height:150}));
  if(s.memory?.length){const mem=el('div','pulse-memory');mem.append(el('b','','Похоже на прошлый случай'));for(const n of s.memory)mem.append(el('p','',n.title+' — '+n.cause+(n.action?' · помогло: '+n.action:'')+' ('+new Date(n.created).toLocaleDateString('ru-RU')+')'));card.append(mem);}
  const out=el('div','pulse-output'),line=el('p','pulse-status');line.setAttribute('role','status');
  const actions=el('div','pulse-row');
  actions.append(button('Похожие опросы',e=>busy(e.target,line,async()=>renderSimilar(out,await post({action:'similar',channel:s.channel,id:s.id,metric:s.metric,date:s.date})))));
  actions.append(button('Факты и проверки',e=>busy(e.target,line,async()=>renderExplain(out,await post({action:'explain',channel:s.channel,id:s.id,metric:s.metric,useModel:false})))));
  if(brief.modelReady)actions.append(button('Объяснить через GigaCode',e=>busy(e.target,line,async()=>renderExplain(out,await post({action:'explain',channel:s.channel,id:s.id,metric:s.metric,useModel:true}))),'pulse-btn accent'));
  actions.append(button('Записать вывод',()=>openNote({surveyId:s.id,channel:s.channel,metric:s.metric,direction:s.direction,date:s.date,products:s.products,title:'#'+s.id+' · '+s.label.toLowerCase()+' '+change(s)})));
  actions.append(button('Что если…',()=>{select('whatif');whatifPrefill({id:s.id,channel:s.channel});}));
  card.append(actions,line,out);return card;
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
 function renderExplain(host,data){
  host.replaceChildren();const box=el('div','pulse-subcard');
  box.append(el('h4','',data.summary?'Объяснение':'Факты для проверки'),el('p','pulse-muted',data.source));
  if(data.summary)box.append(el('p','',data.summary));
  if(data.hypotheses?.length){const ul=el('ul');for(const h of data.hypotheses){const li=el('li','',h.text+' ');li.append(el('span','pulse-refs',h.refs.join(', ')));ul.append(li);}box.append(el('b','','Гипотезы'),ul);}
  const facts=el('table','pulse-table');for(const f of data.facts){const r=el('tr');r.append(el('td','pulse-ref',f.ref),el('td','',f.label),el('td','',(typeof f.value==='number'?fmt(f.value,f.unit==='балла'?'csi':''):f.value)+(f.unit?' '+f.unit:'')),el('td','pulse-muted',f.period||''));facts.append(r);}
  box.append(facts);
  if(data.checks?.length){const ol=el('ol');for(const c of data.checks)ol.append(el('li','',c.label+(c.refs?.length?' ('+c.refs.join(', ')+')':'')));box.append(el('b','','Что проверить'),ol);}
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
  host.replaceChildren();const card=el('div','pulse-card pulse-scenario');
  const scope=d.scope.id?'Опрос #'+d.scope.id:d.scope.product?'Продукт '+d.scope.product:'Все опросы канала';
  card.append(el('p','pulse-eyebrow',scope+' · '+d.scope.channelLabel+' · '+d.month+' · данные по '+dateLabel(d.through)));
  if(d.verdict)card.append(el('h3',d.scenario.forecast>=d.plan?'good':'bad',d.verdict+' · прогноз '+nf.format(d.scenario.forecast)+' из '+nf.format(d.plan)+' ('+df.format(d.completion)+'%)'));
  else card.append(el('h3','','Прогноз на конец месяца: '+nf.format(d.scenario.forecast)+' ответов · план не задан'));
  const tiles=el('div','pulse-kpis');
  const tile=(label,value,note)=>{const t=el('div','pulse-kpi');t.append(el('span','pulse-muted',label),el('b','',value),el('small','',note||''));tiles.append(t);};
  tile('Ответы с начала месяца',nf.format(d.answersToDate),'осталось дней: '+d.remainingDays);
  tile('Отправки в день',nf.format(d.scenario.sendsPerDay),'сейчас '+nf.format(d.baseline.sendsPerDay));
  tile('Отклик',d.scenario.responseRate===null?'—':df.format(d.scenario.responseRate)+'%','сейчас '+(d.baseline.responseRate===null?'—':df.format(d.baseline.responseRate)+'%'));
  tile('Прогноз без изменений',nf.format(d.baseline.forecast),'текущий темп');
  if(d.plan&&d.remainingDays){tile('Нужно отправок в день',d.requiredSendsPerDay===null?'—':nf.format(d.requiredSendsPerDay),'при отклике сценария');tile('Нужный отклик',d.requiredResponseRate===null?'—':df.format(d.requiredResponseRate)+'%','при отправках сценария');}
  card.append(tiles);
  card.append(lineChart({series:[{name:'Факт, накопительно',points:d.series.actual,cls:'primary'},{name:'Прогноз сценария',points:d.series.projection,cls:'dashed'},{name:'План',points:d.series.plan,cls:'muted'}],label:'Накопленные ответы и прогноз',height:200}));
  card.append(el('p','pulse-muted',d.method+(d.planSource?' · план: '+d.planSource:'')));host.append(card);
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
 function renderDeck(host,data){
  host.replaceChildren();const actions=el('div','pulse-row');host.append(el('p','pulse-muted',data.note),actions);
  const slides=[];
  data.slides.forEach((s,i)=>{const slide=el('article','pulse-slide '+s.kind);const t=el('h3','',s.title),sub=el('p','pulse-muted',s.subtitle);t.contentEditable='true';sub.contentEditable='true';
   slide.append(el('span','pulse-slide-no',String(i+1)),t,sub);
   if(s.kpis?.length){const k=el('div','pulse-kpis');for(const [a,b] of s.kpis){const tile=el('div','pulse-kpi');tile.append(el('span','pulse-muted',a),el('b','',b));k.append(tile);}slide.append(k);}
   if(s.series)slide.append(lineChart({series:[{points:s.series,cls:'primary',zeroless:s.metric==='csi'}],marker:s.marker,height:140,format:v=>s.metric==='csi'?cf.format(v):nf.format(v)}));
   const ul=el('ul');for(const b of s.bullets){const li=el('li','',b);li.contentEditable='true';ul.append(li);}slide.append(ul);
   const concl=el('p','pulse-conclusion',s.conclusion);concl.contentEditable='true';if(s.conclusion||s.kind!=='cover')slide.append(concl);
   host.append(slide);slides.push({source:s,slide,t,sub,ul,concl});});
  const read=()=>slides.map(({source,t,sub,ul,concl})=>({...source,title:t.textContent.trim(),subtitle:sub.textContent.trim(),bullets:[...ul.children].map(li=>li.textContent.trim()).filter(Boolean),conclusion:concl.textContent.trim()}));
  actions.append(button('Скачать PPTX',e=>busy(e.target,null,async()=>exportPptx(read(),data))),button('Печать / PDF',()=>printDeck(host),'pulse-btn ghost'));
 }
 function exportPptx(slides,data){
  if(!window.PptxGenJS)throw new Error('Модуль PPTX не загружен.');
  const pptx=new window.PptxGenJS();pptx.layout='LAYOUT_WIDE';
  for(const s of slides){
   const slide=pptx.addSlide();slide.background={color:'111111'};
   slide.addText(s.title,{x:.5,y:.35,w:12.3,h:.7,fontSize:s.kind==='cover'?32:24,bold:true,color:'EDEDED',fontFace:'Arial'});
   slide.addText(s.subtitle||'',{x:.5,y:1.05,w:12.3,h:.4,fontSize:13,color:'9A9A9A',fontFace:'Arial'});
   let y=1.6;
   if(s.kpis?.length){s.kpis.slice(0,4).forEach(([a,b],i)=>{slide.addText([{text:a+'\n',options:{fontSize:11,color:'9A9A9A'}},{text:String(b),options:{fontSize:20,bold:true,color:'FF8A35'}}],{x:.5+i*3.1,y,w:3,h:.9,fontFace:'Arial',fill:{color:'1F1F1F'},margin:8});});y+=1.1;}
   if(s.series?.length>1){const labels=s.series.map(p=>p[0].slice(5)),values=s.series.map(p=>p[1]);slide.addChart(pptx.ChartType.line,[{name:s.title,labels,values}],{x:.5,y,w:7.6,h:3.2,lineSize:2,chartColors:['FF8A35'],catAxisLabelColor:'9A9A9A',valAxisLabelColor:'9A9A9A',catAxisLabelFontSize:8,valAxisLabelFontSize:9,showLegend:false,plotArea:{fill:{color:'181818'}}});
    slide.addText(s.bullets.map(b=>({text:b,options:{bullet:true,breakLine:true}})),{x:8.3,y,w:4.5,h:3.2,fontSize:12,color:'EDEDED',fontFace:'Arial',valign:'top'});y+=3.4;}
   else if(s.bullets.length){slide.addText(s.bullets.map(b=>({text:b,options:{bullet:true,breakLine:true}})),{x:.5,y,w:12.3,h:3.6,fontSize:14,color:'EDEDED',fontFace:'Arial',valign:'top'});y+=3.8;}
   if(s.conclusion)slide.addText('Вывод: '+s.conclusion,{x:.5,y:Math.min(y,6.5),w:12.3,h:.6,fontSize:13,bold:true,color:'FF8A35',fontFace:'Arial'});
  }
  return pptx.writeFile({fileName:'meeting-'+(data.product||'all')+'-'+String(data.revision).slice(0,8)+'.pptx'});
 }
 function printDeck(host){const w=window.open('','_blank');if(!w)return alert('Разрешите всплывающие окна для печати.');const css=[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>'<link rel="stylesheet" href="'+l.href+'">').join('');w.document.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Встреча</title>'+css+'</head><body class="pulse-print">'+host.innerHTML+'</body></html>');w.document.close();setTimeout(()=>w.print(),400);}

 return {page,show,openUpload:()=>{location.hash='#pulse';},whatif:query=>{location.hash='#pulse';select('whatif');setTimeout(()=>{const input=panels.whatif.querySelector('.pulse-ask input');if(input&&query){input.value=query;input.form.requestSubmit();}},300);},meeting:()=>{location.hash='#pulse';select('meeting');}};
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
