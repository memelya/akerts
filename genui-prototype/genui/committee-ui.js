(()=>{
'use strict';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
const post=body=>window.TrustUI.post('/api/committee',body);
const num=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const fmt=value=>Number.isFinite(value)?num.format(value):'—';
const taskStatus={open:'Назначена',in_progress:'В работе',resolved:'Закрыта'};
const packStatus={draft:'Черновик',review:'На согласовании',approved:'Утверждён',rejected:'Возвращён'};
function button(title,run){const control=el('button',title);control.type='button';control.onclick=()=>run(control);return control;}
function field(host,title,type='text',max=120){
 const label=el('label',title),input=el(type==='textarea'?'textarea':'input');
 if(type!=='textarea')input.type=type;
 if(type==='text'||type==='textarea')input.maxLength=max;
 input.setAttribute('aria-label',title);label.append(input);host.append(label);return input;
}
async function busy(control,output,work){
 control.disabled=true;output.textContent='Выполняю…';
 try{await work();}catch(error){output.textContent=error.message;}finally{control.disabled=false;}
}
function history(host,items,statuses){
 const details=el('details');details.append(el('summary','История'));
 for(const item of items)details.append(el('p',new Date(item.at).toLocaleString('ru-RU')+' · '+item.actor+' · '+statuses[item.status]+(item.note?' · '+item.note:'')));
 host.append(details);
}

const dateLabel=value=>value.split('-').reverse().join('.');
const windowLabel=window=>dateLabel(window.start)+' — '+dateLabel(window.end);
function sendCalendar(activity){
 const root=el('div',undefined,'monitor-calendar');
 const days=el('div',undefined,'monitor-days');days.setAttribute('role','list');
 root.append(el('p',activity.sent+' из '+activity.days.length+' дн. с отправками · '+(activity.days.length-activity.observed)+' без данных','overview-source'));
 for(const day of activity.days){
  const state=day.sends===null?'unknown':day.sends>0?'sent':'zero';
  const square=el('span',Number(day.date.slice(-2)),'monitor-day '+state);
  square.setAttribute('role','listitem');
  square.title=dateLabel(day.date)+' · '+(state==='unknown'?'нет данных':state==='zero'?'0 отправок':fmt(day.sends)+' отправок');
  square.setAttribute('aria-label',square.title);
  days.append(square);
 }
 root.append(days);return root;
}
const signed=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1,signDisplay:'exceptZero'});
function signalSummary(signal,historical){
 const row=el('dl',undefined,'monitor-metrics'),day=signal.activity?.days.at(-1);
 const relative=key=>signal.baseline[key]>0&&Number.isFinite(signal.delta[key])?signed.format(signal.delta[key]/signal.baseline[key]*100)+'%':'—';
 const change=(key,unit)=>Number.isFinite(signal.delta[key])?signed.format(signal.delta[key])+' '+unit:'—';
 const pairs=[[historical?'Последний день':'Вчера',day?.sends==null?'Нет данных':day.sends>0?fmt(day.sends)+' отправок':'0 отправок'],
  ['Δ события',relative('events')],['Δ отправки',relative('sends')],['Δ ответы',relative('answers')],
  ['Δ доля отправок',change('sendShare','п.п.')],['Δ отклик',change('responseRate','п.п.')],['Δ CSI',change('csi','балла')]];
 for(const [label,value] of pairs){
  const cell=el('div');cell.append(el('dt',label),el('dd',value));row.append(cell);
 }
 return row;
}
function signalFacts(host,signal,windows=signal.windows){
 if(signal.kind){window.FeedbackOverview.snapshot(host,signal);return;}
 if(!windows){
  const end=new Date(signal.through+'T00:00:00Z');
  const day=offset=>new Date(end.getTime()-offset*86400000).toISOString().slice(0,10);
  windows={previous:{start:day(13),end:day(7)},current:{start:day(6),end:day(0)}};
 }
 const rows=[['События','events'],['Отправки','sends'],['Доля отправок','sendShare',true],['Ответы','answers'],['Отклик','responseRate',true],['CSI','csi'],['Доля стоп-листов','stopShare',true],['Доля политики контактов','contactPolicyShare',true],['Доля остатка / перекрытия','otherShare',true]];
 const wrap=el('div',undefined,'table-wrap'),table=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');
 for(const name of ['Показатель',windowLabel(windows.previous),windowLabel(windows.current),'Изменение'])tr.append(el('th',name));head.append(tr);
 for(const [label,key,share] of rows){
  const row=el('tr');row.append(el('th',label));
  for(const [values,suffix] of [[signal.baseline,'%'],[signal.current,'%'],[signal.delta,' п.п.']])row.append(el('td',fmt(values[key])+(share&&Number.isFinite(values[key])?suffix:'')));
  body.append(row);
 }
 table.append(head,body);wrap.append(table);if(signal.activity)host.append(sendCalendar(signal.activity));
 host.append(wrap,el('p',signal.pairedDays.length
  ?'Пар одинаковых дней недели: '+signal.pairedDays.length+'. Остаток равен событиям минус отправки и известные отсечения. Отрицательное значение показывает перекрытие.'
  :'Для сравнения недель недостаточно данных. Нужно не менее пяти пар одинаковых дней.', 'overview-source'));
 if(signal.remainingStatuses?.length){
  const details=el('details');details.append(el('summary','Остальные статусы · события минус отправки'));
  for(const row of signal.remainingStatuses)details.append(el('p',row.status+' · '+fmt(row.baseline)+' → '+fmt(row.current)+' · изменение '+fmt(row.delta)));
  host.append(details);
 }
}

async function renderTasks(host){
 const items=await post({action:'tasks'});host.replaceChildren(el('h2','Задачи'));
 if(!items.length)host.append(el('p','Назначенные проверки появятся здесь.'));
 for(const item of items){
  const card=el('article',undefined,'trust-card');
  const title=item.signal.kind?item.signal.name:'#'+item.signal.id+' · '+item.signal.name;
  card.append(el('h3',title+' · '+taskStatus[item.status]),el('p',item.owner+' · срок '+dateLabel(item.due)+' · данные по '+dateLabel(item.signal.through)));
  if(item.check)card.append(el('p',item.check));
  const evidence=el('details');
  evidence.append(el('summary','Отклонение на момент назначения'));
  signalFacts(evidence,item.signal);
  card.append(evidence);
  history(card,item.history,taskStatus);
  const controls=el('div',undefined,'workflow-controls'),message=el('p');
  if(item.status!=='resolved'){
   const actor=field(controls,'Кто меняет статус'),note=field(controls,'Результат проверки','textarea',2000);
   actor.value=item.owner;
   const change=(label,status)=>button(label,control=>busy(control,message,async()=>{
    await post({action:'task-update',id:item.id,version:item.version,status,actor:actor.value,note:note.value});await renderTasks(host);
   }));
   if(item.status==='open')controls.append(change('Взять в работу','in_progress'));
   controls.append(change('Закрыть с результатом','resolved'));
  }else{
   const actor=field(controls,'Кто меняет статус');actor.value=item.owner;
   controls.append(button('Возобновить',control=>busy(control,message,async()=>{
    await post({action:'task-update',id:item.id,version:item.version,status:'in_progress',actor:actor.value});await renderTasks(host);
   })));
  }
  card.append(controls,message);host.append(card);
 }
}

function create(main){
 const page=el('section',undefined,'trust-page');page.hidden=true;main.append(page);
 const link=el('a','Утренний мониторинг','nav-item');link.href='#morning-monitor';document.querySelector('.rail').insertBefore(link,document.querySelector('.history'));
 function show(){
  page.classList.add('morning-monitor');
  const rules=el('details',undefined,'monitor-rules');
  rules.append(el('summary','Как формируются сигналы'),
   el('p','Срочно: с начала месяца во все проверенные дни есть данные и в каждый день отправок было ноль. Если в календаре есть пропуски, полный останов подтвердить нельзя.'),
   el('p','Внимание: в последний проверяемый день было 0 отправок, в наблюдаемые дни с начала месяца отправок не было при неполной выгрузке или сработало сравнение недель.'),
   el('p','Сравнение недель: минимум 5 пар одинаковых дней. Сигнал появляется при снижении доли отправок на 5 п.п. и более (от 100 событий в каждом окне), снижении числа ответов на 20% и более (от 30 ответов в базе) или снижении CSI на 0,3 балла и более (от 30 оценок в каждом окне).'),
   el('p','Доля отправок: отправки / события. Отклик: ответы / отправки. Изменения событий, отправок и ответов показаны в процентах к предыдущей неделе. Дни без строк не считаются нулём.'),
   el('p','Топ-продукты: продукты, у которых хотя бы один опрос отмечен как топ в справочнике. Фильтр «Топ опросы» оставляет только отмеченные опросы.'));
  page.replaceChildren(el('h1','Утренний мониторинг'),el('p','Отправки с начала месяца и изменения к сопоставимой неделе.'),rules);
  const filters=el('div',undefined,'workflow-controls'),survey=field(filters,'Опрос','number'),through=field(filters,'Последний день окна','date'),channel=el('select');
  survey.min='1';survey.max='9999999';survey.placeholder='Все опросы';channel.setAttribute('aria-label','Канал мониторинга');
  channel.add(new Option('Пуш + СМС','communication'));channel.add(new Option('Экран успеха','success_screen'));filters.append(channel);
  const product=el('select'),productLabel=el('label','Продукт'),topLabel=el('label','Топ опросы'),top=el('input');
  product.setAttribute('aria-label','Продукт');product.add(new Option('Топ-продукты','@top'));product.add(new Option('Все продукты',''));
  productLabel.append(product);top.type='checkbox';topLabel.prepend(top);filters.append(productLabel,topLabel);
  const status=el('p'),queue=el('div'),tasks=el('div'),taskStatusLine=el('p');status.setAttribute('role','status');
  const scan=button('Рассчитать сигналы',control=>busy(control,status,async()=>{
   const selection=product.value;
   const query={survey:survey.value?Number(survey.value):null,through:through.value,channel:channel.value,
    product:selection==='@top'?'':selection,topProducts:selection==='@top',top:top.checked};
   const filterFields=[survey,through,channel,product,top];
   filterFields.forEach(field=>field.disabled=true);
   let data;
   try{data=await post({action:'monitor',...query});}
   finally{filterFields.forEach(field=>field.disabled=false);}
   product.replaceChildren(new Option('Топ-продукты','@top'),new Option('Все продукты',''),
    ...data.products.map(name=>new Option(name+(data.topProducts.includes(name)?' · топ':''),name)));
   product.value=selection;
   queue.replaceChildren();
   if(data.topProductsFallback)queue.append(el('p','Для топ-опросов не найдены продукты в справочнике. Показаны сами топ-опросы.','overview-source'));
   status.textContent=data.message||'Найдено '+data.total+' · по '+data.through+' · версия '+data.revision+(data.total>100?' · показаны первые 100':'');
   if(data.latest){
    const now=new Date(),today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
    const lag=Math.round((today-Date.parse(data.latest))/86400000);
    if(lag>=2)queue.append(el('p','Данные устарели. Последний день наблюдений: '+dateLabel(data.latest)+' ('+lag+' дн. назад).','v2-chart-help is-warning'));
    if(query.through&&query.through!==data.latest)queue.append(el('p','Исторический срез по '+dateLabel(data.through)+'. Последние наблюдения по '+dateLabel(data.latest)+'.','overview-source'));
   }
   const activity=el('details',undefined,'monitor-activity'),calendarList=el('div');
   activity.open=true;
   activity.append(el('summary','Отправки с начала месяца · по '+dateLabel(data.calendarThrough)),
    el('p','Зелёный: были отправки · красный: 0 отправок · серый: нет данных','overview-source'),calendarList);
   let shown=0;
   const more=button('Показать ещё опросы',showCalendars);
   function showCalendars(){
    for(const entry of data.calendars.slice(shown,shown+12)){
     const row=el('article',undefined,'monitor-activity-row');
     row.append(el('h3','#'+entry.id+' · '+entry.name),sendCalendar(entry));calendarList.append(row);
    }
    shown+=12;more.hidden=shown>=data.calendars.length;
   }
   activity.append(more);showCalendars();
   if(!data.calendars.length)calendarList.append(el('p','В отборе нет опросов.'));
   const urgent=el('section',undefined,'monitor-signal-group'),attention=el('section',undefined,'monitor-signal-group');
   for(const [section,label,severity] of [[urgent,'Срочно','urgent'],[attention,'Внимание','attention']]){
    const count=data.signals.filter(s=>s.severity===severity).length;
    section.append(el('h2',label+' · '+data.severityCounts[severity]));
    if(!count)section.append(el('p',data.severityCounts[severity]?'Сигналы не вошли в первые 100.':'Сигналов нет.','overview-source'));
   }
   if(data.productSummary){
    const group=data.productSummary,card=el('article',undefined,'trust-card monitor-signal');
    card.append(el('h2',group.name),el('p',group.pairCount
     ?'Ответы: '+fmt(group.baseline.answers)+' → '+fmt(group.current.answers)+' · опросов в сравнении '+group.comparedSurveys+' из '+group.surveyCount
     :'Недостаточно сопоставимых дней для вывода по продукту.'));
    card.append(button('Разобрать изменение по продукту',control=>window.FeedbackOverview.openAnswerChange(
     {selection:group.selection,through:data.through,revision:data.revision},control,refreshTasks)));
    queue.append(card);
   }
   queue.append(urgent,attention,activity);
   for(const signal of data.signals){
    const item=el('article',undefined,'trust-card monitor-signal '+signal.severity),assign=el('details'),controls=el('div',undefined,'workflow-controls'),message=el('p');
    const origin={...query,asOf:data.calendarThrough,key:signal.key,revision:data.revision};
    const detail=el('details',undefined,'monitor-details');
    detail.append(el('summary','Сравнение периодов и действия'));
    item.append(el('h3','#'+signal.id+' · '+signal.name),signalSummary(signal,data.historical),el('p',signal.reasons.join(' · '),'monitor-reasons'),detail);
    item.insertBefore(button('Разобрать изменение ответов',control=>window.FeedbackOverview.openAnswerChange(
     {selection:{id:signal.id,channel:signal.channel},through:data.through,revision:data.revision},control,refreshTasks)),detail);
    signalFacts(detail,signal,data.windows);
    assign.append(el('summary','Назначить проверку'));
    const owner=field(controls,'Ответственный'),actor=field(controls,'Кто назначил'),due=field(controls,'Срок','date');
    const check=field(controls,'Что проверить','textarea',500),review=el('div'),reviewStatus=el('p'),reviewControls=el('div',undefined,'workflow-controls'),model=el('input');
    model.type='checkbox';const label=el('label','Упорядочить проверки через GigaCode');label.prepend(model);
    reviewControls.append(label,button('Разобрать сигнал',control=>busy(control,reviewStatus,async()=>{
     const result=await post({action:'signal-review',...origin,useModel:model.checked});review.replaceChildren();
     const facts=new Map(result.facts.map(f=>[f.ref,f]));
     review.append(el('p','Возможные проверки. Совпадение по времени требует подтверждения.'));
     for(const option of result.checks){
      const row=el('div',undefined,'ai-section');row.append(el('p',option.label));
      for(const ref of option.refs){
       const fact=facts.get(ref);
       row.append(el('small',fact.label+' · '+fmt(fact.baseline)+' → '+fmt(fact.current)+' · изменение '+fmt(fact.delta)+' '+fact.unit));
      }
      row.append(button('Назначить эту проверку',()=>{check.value=option.label;assign.open=true;owner.focus();}));review.append(row);
     }
     if(result.calendar.length)review.append(el('p','Совпало с календарём: '+result.calendar.map(event=>event.from+' · '+event.title).join(' / ')));
     reviewStatus.textContent=result.warning|| (result.origin==='gigacode'?'Порядок проверок предложила GigaCode.':'Проверки подобраны по локальным правилам.');
    })));
    detail.append(reviewControls,reviewStatus,review);
    controls.append(button('Создать задачу',save=>busy(save,message,async()=>{
     await post({action:'assign',...origin,actor:actor.value,owner:owner.value,due:due.value,check:check.value});
     assign.open=false;status.textContent='Задача назначена '+owner.value+'.';
     await refreshTasks();
    })));
    assign.append(controls,message);detail.append(assign);(signal.severity==='urgent'?urgent:attention).append(item);
   }
  }));
  filters.append(scan);page.append(filters,status,queue,taskStatusLine,tasks);
  async function refreshTasks(){
   try{await renderTasks(tasks);taskStatusLine.textContent='';}
   catch(error){taskStatusLine.textContent=error.message;}
  }
  for(const control of [product,top,channel,through])control.addEventListener('change',()=>scan.click());
  refreshTasks();
  scan.click();
 }
 return {page,show};
}

function summaryLines(pack){
 const source=pack.snapshot;
 if(source.scopeChanged)return ['Настройки сценария изменились. Для этого пакета создана новая база сравнения.'];
 return source.comparison.flatMap((item,i)=>{
  if(item.firstRun)return [];
  const prefix=(source.titles[i]||'График '+(i+1)).slice(0,120);
  const changed=item.totals.filter(total=>total.delta!==null&&total.delta!==0);
  return [prefix+(item.periodChanged?' · период изменился':''),...changed.slice(0,6).map(total=>total.label+': '+fmt(total.previous)+' → '+fmt(total.current))];
 });
}

function compositionOf(data){
 const events=data.blocks.find(block=>block.metric==='events');
 const keys=['sends','stop','contactPolicy'];
 if(!events||!keys.every(key=>data.blocks.some(block=>block.metric===key&&block.id===events.id)))return null;
 const blocks=structuredClone([events,...keys.map(key=>data.blocks.find(block=>block.metric===key&&block.id===events.id))]);
 for(const block of blocks){
  const baseValues=[...events.values];
  block.ratio={baseMetric:'events',baseValues,values:block.values.map((value,i)=>Number.isFinite(value)&&baseValues[i]>0?value/baseValues[i]*100:null)};
 }
 return {...data,blocks,breakdownLineMetric:'events',breakdownParts:keys};
}

async function downloadPack(pack){
 const source=pack.snapshot,pages=[];
 const base={layout:'grid',template:'timeline',theme:'light',subtitle:'',footer:'',notes:[],kpis:[]};
 let compositionAdded=false;const omissions=[];
 for(const [index,data] of source.charts.entries()){
  const title=source.titles[index]||'График '+(index+1);
  const entry={revision:source.revision,presentationTitle:title,chart:{status:'ok',kind:'monthly',title,channel:data.spec.filters?.channel,data}};
  const original=window.PresentationRender.newCard(entry,'committee:'+pack.id);
  const series=original.graph.series.filter(item=>item.values.some(Number.isFinite)).map(item=>item.key);
  if(series.length!==original.selected.length)omissions.push(title+' · ряды без наблюдений: '+original.graph.series.filter(item=>!series.includes(item.key)).map(item=>item.label).join(', '));
  for(let start=0;index!==source.compositionIndex&&start<series.length;start+=6){
   const selected=series.slice(start,start+6),card={...original,selected,headline:selected[0]};
   const heading=pages.length===0?source.name:title+(series.length>6?' · часть '+(start/6+1):'');
   const overview=pages.length===0;
   const kpis=overview?source.comparison[index].totals.filter(total=>Number.isFinite(total.current)).slice(0,3).map(total=>({
    label:total.label+(total.id?' · #'+total.id:''),value:total.previous===null?fmt(total.current):fmt(total.previous)+' → '+fmt(total.current),
    detail:total.previous===null?'Текущий период':source.comparison[index].periodChanged?'Интервалы различаются':'Предыдущий утверждённый пакет и текущий'
   })):[];
   const conclusion=source.conclusion||'';
   pages.push({...base,template:overview?'comparison':'timeline',kpis,title:heading.slice(0,180),subtitle:overview?(conclusion.length>210?conclusion.slice(0,205)+'…':conclusion):data.periodLabel,
    footer:'Версия данных '+source.revision+' · согласовал '+pack.history.at(-1).actor,cards:[card]});
  }
  const composition=compositionAdded?null:compositionOf(data);
  if(composition){
   const chart=window.PresentationRender.newCard({...entry,presentationTitle:'Объём и состав событий',chart:{...entry.chart,kind:'events-breakdown',data:composition}},'committee:'+pack.id+':composition');
   pages.push({...base,template:'composition',title:'Состав событий',subtitle:data.periodLabel,cards:[chart]});
   compositionAdded=true;
  }
 }
 await document.fonts.ready;
 const lines=summaryLines(pack);
 const pptx=await window.PresentationOffice.powerPoint(pages,(page,index)=>window.PresentationRender.render(page,{editable:true,pageNumber:index+1,pageCount:pages.length}),{
  notes:()=>['Версия данных '+source.revision,'Снимок '+pack.hash,'Предыдущий утверждённый пакет '+(source.previousApproved?.id||'—'),source.conclusion,...lines,...omissions].filter(Boolean).join('\n')
 });
 const comparison=[['График','Показатель','Опрос','Предыдущий пакет','Текущий пакет','Изменение','Сравнение']];
 source.comparison.forEach((item,i)=>item.totals.forEach(total=>comparison.push([source.titles[i],total.label,total.id,total.previous,total.current,total.delta,source.scopeChanged?'Настройки изменились':item.firstRun?'Первая версия':item.periodChanged?'Интервалы различаются':'Сопоставимый период'])));
 const workbook=await window.PresentationOffice.workbook(pages,{comparison});
 const manifest={id:pack.id,scenario:source.name,hash:pack.hash,revision:source.revision,metricVersion:source.metricVersion,history:pack.history,previousApproved:source.previousApproved,scopeChanged:source.scopeChanged,comparison:source.comparison};
 const zip=new window.JSZip();
 zip.file('committee.pptx',await pptx.arrayBuffer());zip.file('committee.xlsx',await workbook.arrayBuffer());zip.file('manifest.json',JSON.stringify(manifest,null,2));
 window.MeetingExports.saveBlob(await zip.generateAsync({type:'blob',compression:'DEFLATE'}),'committee-'+pack.id.slice(0,10)+'.zip');
}

function attachPacks(host,source,{model=false,archive=false}={}){
 const target=typeof source==='string'?{scenario:source}:source||{};
 const panel=el('details',undefined,'method');panel.append(el('summary',archive?'Пакеты из диалога':'Пакет на комитет'));
 const controls=el('div',undefined,'workflow-controls'),author=field(controls,'Автор пакета'),conclusion=field(controls,'Вывод для комитета','textarea',600),status=el('p'),list=el('div');
 let sourceHash='';
 if(model&&!archive)controls.append(button('Подготовить вывод через GigaCode',control=>busy(control,status,async()=>{
  const draft=await post({action:'pack-draft',...target});conclusion.value=draft.conclusion;sourceHash=draft.sourceHash;
  status.textContent='Вывод собран по рассчитанным точкам. Проверьте текст перед сохранением.';
 })));
 controls.append(button('Собрать черновик',control=>busy(control,status,async()=>{
  await post({action:'pack-create',...target,actor:author.value,conclusion:conclusion.value,sourceHash});await load();status.textContent='Черновик собран по зафиксированным данным.';
 })));
 panel.append(el('p','В согласовании используются имена, указанные участниками в локальном проекте.'));if(!archive)panel.append(controls);panel.append(status,list);host.append(panel);
 panel.ontoggle=()=>{if(panel.open)load().catch(error=>{status.textContent=error.message;});};
 async function load(){
  const packs=await post({action:archive?'packs-model':'packs',...target});list.replaceChildren();
  if(!packs.length)list.append(el('p','Здесь появятся сохранённые пакеты.'));
  for(const pack of packs){
   const card=el('article',undefined,'trust-card'),message=el('p');
   card.append(el('h3',packStatus[pack.status]+' · '+new Date(pack.created).toLocaleString('ru-RU')),el('p','Версия '+pack.revision+' · '+pack.author));history(card,pack.history,packStatus);
   card.append(button('Проверить содержание',control=>busy(control,message,async()=>{
    const full=await post({action:'pack-open',id:pack.id});const detail=el('div');detail.append(el('p',full.snapshot.conclusion||'Вывод не добавлен.'));
    for(const chart of full.snapshot.charts){detail.append(el('p',chart.periodLabel+' · '+chart.totals.map(total=>total.label+' '+fmt(total.value)).join(' · ')));}
    const lines=summaryLines(full);for(const line of lines)detail.append(el('p',line));message.replaceChildren(detail);
   })));
   if(['draft','review'].includes(pack.status)){
    const row=el('div',undefined,'workflow-controls'),actor=field(row,'Участник согласования'),note=field(row,'Комментарий согласования','textarea',1200);
    if(pack.status==='draft')actor.value=pack.author;
    function step(label,next){return button(label,control=>busy(control,message,async()=>{await post({action:'pack-review',id:pack.id,version:pack.version,status:next,actor:actor.value,note:note.value});await load();}));}
    if(pack.status==='draft')row.append(step('На согласование','review'));
    else row.append(step('Утвердить','approved'),step('Вернуть с комментарием','rejected'));
    card.append(row);
   }
   if(pack.status==='approved')card.append(button('Скачать PPTX и Excel',control=>busy(control,message,async()=>{await downloadPack(await post({action:'pack-export',id:pack.id}));message.textContent='Пакет подготовлен.';})));
   card.append(message);list.append(card);
  }
 }
}

function attachQuality(host){
 const details=el('details',undefined,'method'),policy=el('p'),results=el('div'),message=el('p');
 details.append(el('summary','Контур ИИ и эталонные проверки'),policy,el('p','Эталонные проверки используют синтетические данные. Для проверки настроенной модели запустите python release_eval.py --model.'));
 details.append(button('Запустить эталонные проверки',control=>busy(control,message,async()=>{
  const report=await post({action:'evaluate'});message.textContent=report.ok?'Все локальные проверки пройдены.':'Есть отклонения от эталона.';
  results.replaceChildren(...report.cases.map(test=>el('p',(test.ok?'Пройдено · ':'Ошибка · ')+test.name+(test.detail?' · '+test.detail:''))));
 })),message,results);
 details.ontoggle=()=>{if(details.open)post({action:'policy'}).then(result=>{policy.textContent=result.profile==='protected'?'Защищённый режим · разрешённые агрегаты и CLI в режиме plan.':'Режим разработки · экспериментальная генерация разрешена.';}).catch(error=>{policy.textContent=error.message;});};
 host.append(details);
}
window.CommitteeUI={create,attachPacks,attachQuality,renderTasks};
})();
