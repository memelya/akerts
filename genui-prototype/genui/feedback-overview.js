(()=>{
'use strict';
const post=body=>window.TrustUI.post('/api/committee',body);
const number=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const whole=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const signed=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2,signDisplay:'exceptZero'});
const percent=new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:2});
const finite=Number.isFinite;
const date=value=>value?value.split('-').reverse().join('.'):'—';
const span=window=>date(window.start)+' — '+date(window.end);
const values=[['events','Загруженные события'],['sends','Отправки'],['answers','Ответы'],['responseRate','Отклик'],['csi','CSI']];
const factors=[['events','Объём событий'],['sendShare','Доля отправок'],['responseRate','Отклик']];
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,run){const n=el('button',text);n.type='button';n.onclick=run;return n;}
function amount(key,value){return !finite(value)?'—':key==='responseRate'||key==='sendShare'?percent.format(value):number.format(value);}
function change(key,from,to){
 if(!finite(from)||!finite(to))return '—';
 return key==='responseRate'||key==='sendShare'?signed.format((to-from)*100)+' п.п.':signed.format(to-from)+(key==='csi'?' балла':'');
}
function coverage(s){
 return s.pairCount
  ?s.pairedDays.length+' из 7 дней · '+s.comparedSurveys+' из '+s.surveyCount+' опросов с наблюдениями · '+s.pairCount+' из '+(s.comparedSurveys*7)+' пар «опрос × день»'
  :'Недостаточно данных для сравнения. Для каждого опроса нужно от пяти пар одноимённых дней.';
}
function table(headers,rows){
 const wrap=el('div',undefined,'table-wrap'),t=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');
 for(const label of headers){const cell=el('th',label);cell.scope='col';tr.append(cell);}
 head.append(tr);
 for(const row of rows){
  const tr=el('tr');row.forEach((value,i)=>{const cell=el(i?'td':'th',value);if(!i)cell.scope='row';tr.append(cell);});body.append(tr);
 }
 t.append(head,body);wrap.append(t);return wrap;
}
function leadingDecline(s){
 return s.factors&&factors.filter(([key])=>s.factors[key]<-0.005).sort(([a],[b])=>s.factors[a]-s.factors[b])[0];
}
function snapshot(host,s){
 host.append(el('p',span(s.windows.current)+' к '+span(s.windows.previous)),el('p',coverage(s),'overview-source'));
 const difference=change('answers',s.baseline.answers,s.current.answers);
 host.append(el('p','Изменение числа ответов: '+difference,'feedback-delta'));
 if(s.factors){
  const leading=leadingDecline(s);
  if(leading)host.append(el('p','Наибольший отрицательный вклад: '+leading[1].toLocaleLowerCase('ru-RU')+' ('+signed.format(s.factors[leading[0]])+').'));
  host.append(table(['Фактор','База','Текущее окно','Вклад в ответы'],factors.map(([key,label])=>[
   label,amount(key,s.baseline[key]),amount(key,s.current[key]),signed.format(s.factors[key]),
  ])));
  host.append(el('p','Ответы = события × доля отправок × отклик. Вклады усреднены по всем порядкам изменения факторов и в сумме дают изменение ответов до округления.','overview-source'));
 }else host.append(el('p','Разложение недоступно: в одном из сопоставимых окон нет положительной базы событий или отправок.'));
 if(s.cutoffs?.length){
  host.append(el('h4','Отсечения в пуш + СМС'));
  host.append(table(['Статус','Найдено: база → текущее','Покрытие строк статуса','Доля событий: база → текущее'],s.cutoffs.map(row=>[
   row.metric==='stop'?'Стоп-листы':'Политика контактов',
   row.counts.map(value=>amount('events',value)).join(' → '),
   row.observed.map(n=>n+'/'+row.expected).join(' → '),
   row.shares?.every(finite)?row.shares.map(percent.format).join(' → ')+' ('+change('sendShare',...row.shares)+')':'Недостаточно строк статуса',
  ])));
  host.append(el('p','Отсутствие строки статуса не считается нулём. Доли отсечений показываются при полном покрытии сопоставимых пар.','overview-source'));
 }
}
function assignment(s,onSaved){
 const details=el('details'),form=el('form',undefined,'workflow-controls'),status=el('p');
 status.setAttribute('role','status');
 details.append(el('summary','Назначить проверку'),form,status);
 const fields={};
 for(const [key,label,type] of [['owner','Ответственный','text'],['actor','Кто назначил','text'],['due','Срок','date'],['check','Что проверить','textarea']]){
  const wrapper=el('label',label),control=el(type==='textarea'?'textarea':'input');
  if(type!=='textarea')control.type=type;
  if(type==='text')control.maxLength=120;
  if(type==='textarea')control.maxLength=500;
  control.required=key!=='check';wrapper.append(control);form.append(wrapper);fields[key]=control;
 }
 const leading=leadingDecline(s);
 fields.check.value=leading?'Проверить фактор «'+leading[1]+'» в срезе «'+s.name+'» за '+span(s.windows.current)+'.':'Сверить динамику ответов и полноту выгрузки в срезе «'+s.name+'».';
 const save=el('button','Создать задачу');form.append(save);
 let incidentFactor=null;
 fields.check.addEventListener('input',()=>{incidentFactor=null;});
 form.onsubmit=async event=>{
  event.preventDefault();save.disabled=true;status.textContent='Сохраняю…';
  try{
   await post({action:'assign',scope:'feedback',key:s.key,revision:s.revision,selection:s.selection,through:s.through,
    ...(incidentFactor?{incidentFactor}:{}),...Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value]))});
   status.textContent='Проверка назначена.';form.hidden=true;
   onSaved();
  }catch(error){status.textContent=error.message;save.disabled=false;}
 };
 return {details,use(hypothesis){
  if(form.hidden)return;
  fields.check.value=hypothesis.title+'. '+hypothesis.check;
  incidentFactor=hypothesis.id;details.open=true;fields.owner.focus();
 }};
}
function investigator(s,assign){
 const panel=el('details',undefined,'feedback-breakdown'),status=el('p'),output=el('div'),controls=el('div',undefined,'feedback-investigator-controls');
 status.setAttribute('role','status');
 const local=button('Обновить разбор',()=>load(false)),model=button('Расставить приоритеты через GigaCode',()=>load(true));
 controls.append(local,model);
 panel.append(el('summary','Следователь по инцидентам'),controls,status,output);
 panel.addEventListener('toggle',()=>{if(panel.open&&!output.children.length&&!local.disabled)load(false);});
 async function load(useModel){
  local.disabled=model.disabled=true;
  status.textContent=useModel?'GigaCode расставляет приоритеты…':'Сопоставляю расчёт, календарь и закрытые проверки…';
  try{
   const report=await post({action:'incident-investigator',key:s.key,revision:s.revision,useModel});
   renderInvestigation(output,report,assign,s);
   status.textContent=report.warning||(report.origin==='gigacode'?'Приоритеты предложила GigaCode.':'Приоритеты рассчитаны локально.');
   model.disabled=!report.hypotheses.length;
  }catch(error){status.textContent=error.message;model.disabled=false;}
  finally{local.disabled=false;}
 }
 return panel;
}
function renderInvestigation(host,report,assign,scope){
 host.replaceChildren();
 if(!report.hypotheses.length)host.append(el('p','По сопоставимым данным нет сигнала, из которого можно вывести гипотезу.'));
 else host.append(el('p','Гипотезы требуют проверки. Совпадение по времени само по себе не доказывает причину.'));
 const sources=el('details'),list=el('ul'),items=new Map();
 sources.append(el('summary','Факты и источники'),list);
 const labels={events:'Объём событий',answers:'Ответы',sendShare:'Доля отправок',responseRate:'Отклик',stop:'Доля стоп-листов',contactPolicy:'Доля политики контактов'};
 for(const [ref,f] of Object.entries(report.facts)){
  const item=el('li');
  item.tabIndex=-1;
  let label,description;
  if(f.kind==='calendar'){
   label='Календарь · '+f.title;
   description=date(f.from)+' — '+date(f.to)+' · '+f.relation;
  }else if(f.kind==='history'){
   label='Закрытая проверка · '+f.title;
   description='Данные по '+date(f.through)+' · результат: '+f.result;
  }else if(f.kind==='coverage'){
   label='Полнота сравнения';
   description=f.days+' из 7 дней · '+f.comparedSurveys+' из '+f.surveys+' опросов · '+f.pairs+' пар «опрос × день»';
  }else{
   label=labels[f.metric]||f.metric;
   const format=['stop','contactPolicy'].includes(f.metric)?percent.format:value=>amount(f.metric,value);
   description=format(f.baseline)+' → '+format(f.current)+(finite(f.impact)?' · вклад в ответы '+signed.format(f.impact):'');
  }
  item.append(el('strong',label),el('p',description));list.append(item);items.set(ref,{item,label});
 }
 for(const hypothesis of report.hypotheses){
  const card=el('article',undefined,'trust-card');
  card.append(el('h4',hypothesis.title),el('p',hypothesis.check));
  const refs=el('div',undefined,'feedback-investigator-controls');
  for(const ref of hypothesis.refs){
   const {item,label}=items.get(ref);
   refs.append(button(label,()=>{sources.open=true;item.focus();}));
  }
  const actions=el('div',undefined,'feedback-investigator-controls');
  actions.append(button('Назначить эту проверку',()=>assign.use(hypothesis)),
   button('Слайд для комитета',event=>window.CommitteeSlide.open(scope,hypothesis,event.currentTarget)));
  card.append(refs,actions);
  host.append(card);
 }
 host.append(sources);
}
function breakdown(s,onSaved){
 const details=el('details',undefined,'feedback-breakdown'),body=el('div');
 details.append(el('summary','Что повлияло'),body);
 details.addEventListener('toggle',()=>{
  if(details.open&&!body.children.length){
   const assign=assignment(s,onSaved);
   snapshot(body,s);body.append(button('Слайд для комитета',event=>window.CommitteeSlide.open(s,null,event.currentTarget)),investigator(s,assign),assign.details);
  }
 });
 return details;
}
function create(main){
 const page=el('section',undefined,'trust-page feedback-overview');page.hidden=true;main.append(page);
 let ticket=0;
 function show(){
  const current=++ticket,header=el('div',undefined,'feedback-header'),status=el('p'),content=el('div'),taskStatus=el('p'),tasks=el('section');
  status.setAttribute('role','status');taskStatus.setAttribute('role','status');tasks.id='feedback-tasks';
  const taskLink=el('a','Задачи');taskLink.href='#feedback';taskLink.onclick=event=>{event.preventDefault();tasks.scrollIntoView({block:'start'});};
  const refresh=button('Обновить',load);
  header.append(el('h1','Сбор обратной связи'),refresh,taskLink);
  page.replaceChildren(header,status,content,taskStatus,tasks);
  function loadTasks(){window.CommitteeUI.renderTasks(tasks).then(()=>{taskStatus.textContent='';}).catch(error=>{taskStatus.textContent=error.message;});}
  async function load(){
   status.textContent='Читаем локальные данные…';refresh.disabled=true;
   try{
    const data=await post({action:'feedback'});if(current!==ticket)return;
    content.replaceChildren();
    if(!data.overview){
     status.textContent='Для сравнения нужны дневные выгрузки.';
     const link=el('a','Открыть настройки данных');link.href='#admin-data';content.append(link);return;
    }
    render(data,content,loadTasks);
    status.textContent='';
   }catch(error){
    if(current===ticket)status.textContent=(content.children.length?'Обновление не удалось. На экране предыдущий результат. ':'')+error.message;
   }finally{refresh.disabled=false;}
  }
  load();loadTasks();
 }
 return {page,show};
}
function render(data,host,onSaved){
 const overview=data.overview,now=new Date(),today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
 const lag=value=>Math.floor((today-Date.parse(value))/86400000);
 host.append(el('p','Данные по '+date(overview.through)+' · '+span(overview.windows.current)+' к '+span(overview.windows.previous),'feedback-period'));
 if(lag(overview.through)>=2)host.append(el('p','Последние данные были '+lag(overview.through)+' дн. назад.','v2-chart-help is-warning'));
 const totals=el('section',undefined,'feedback-bank'),kpis=el('div',undefined,'feedback-kpis');
 totals.append(el('h2','По банку'),el('p',coverage(overview),'overview-source'));
 const comparable=overview.pairCount&&overview.observedSurveyDays===overview.pairCount*2;
 totals.append(el('p',comparable?'Текущее окно и изменение к сопоставимой неделе.':'Значения за текущее окно. Изменения рассчитаны только по сопоставимым парам.','overview-source'));
 for(const [key,label] of values){
  const card=el('article',undefined,'trust-card');
  card.append(el('h3',label),el('strong',amount(key,overview.actual[key])));
  if(key==='csi'&&finite(overview.actual.csi))card.append(el('small','Оценок: '+whole.format(overview.actual.csiSample)));
  if(overview.pairCount)card.append(el('small',change(key,overview.baseline[key],overview.current[key])));
  kpis.append(card);
 }
 totals.append(kpis);
 if(overview.pairCount)totals.append(breakdown(overview,onSaved));
 host.append(totals);
 const signals=el('section',undefined,'feedback-signals');signals.append(el('h2','Главные отклонения'));
 if(data.signals.length){
  signals.append(el('p','По снижению числа ответов в сопоставимых парах. Срезы могут пересекаться.','overview-source'));
  for(const s of data.signals){
   const card=el('article',undefined,'trust-card feedback-signal');
   card.append(el('h3',s.kind==='product'?'Продукт · '+s.name:s.name),el('p','−'+whole.format(s.loss)+' ответов к базе','feedback-delta'),el('p',coverage(s),'overview-source'),breakdown(s,onSaved));
   signals.append(card);
  }
 }else signals.append(el('p',overview.pairCount?'В сопоставимых срезах снижения числа ответов нет.':'Данных для выявления отклонений недостаточно.'));
 host.append(signals);
 const channels=el('section',undefined,'feedback-channels');channels.append(el('h2','Каналы'));
 for(const s of data.channels){
  const card=el('article',undefined,'trust-card'),latest=data.latest[s.key.split(':')[1]];
  const state=!s.pairCount?'Данных недостаточно':s.loss?'Есть снижение ответов':'Снижения в сопоставимых парах нет';
  card.append(el('h3',s.name),el('p',state),el('p',latest?'Данные по '+date(latest):'Дневных данных нет',latest&&lag(latest)>=2?'v2-chart-help is-warning':'overview-source'),el('p',coverage(s),'overview-source'));
  if(s.pairCount)card.append(breakdown(s,onSaved));
  channels.append(card);
 }
 host.append(channels);
}
function answerChangeQuery(query,previous){
 const text=query.toLowerCase().replaceAll('ё','е').replace(/\s+/g,' ').trim().replace(/[?!.]+$/,'');
 const why=/^почему (?:упал[ои]|снизил(?:ось|ись)|стало меньше|уменьшил(?:ось|ись)) (?:число |количество )?ответ(?:ов|ы)(?= |$)/u;
 const ranking=/^какие опросы (?:дали (?:основное|наибольшее) снижение|сильнее всего просели)(?: по ответам)?/u;
 const window=/(?:^| )за (?:последние )?(?:7|семь) (?:дней|суток)(?: |$)/u;
 const prefix=why.exec(text)||ranking.exec(text);
 if(!prefix)return null;
 let phrase=text.slice(prefix[0].length).trim();
 if(window.test(phrase))phrase=phrase.replace(window,' ').trim();
 else if(!ranking.test(text)||/\d|недел|месяц|год|дн|суток|\bпосле\b/u.test(phrase))return null;
 const filters=previous?.filters||{};
 const selection=previous?.ids?.length===1?{id:previous.ids[0],channel:filters.channel||''}:
  filters.product?{product:filters.product,channel:filters.channel||''}:filters.channel?{channel:filters.channel}:{id:1007};
 if(!phrase&&(previous?.ids?.length>1||filters.triggerGroup||filters.type||filters.top))return null;
 return {phrase,default:selection};
}

function renderAnswerChange(host,result,retry,onSaved=()=>{}){
 const {scope,draft,report}=result;
 host.replaceChildren(el('div','Разбор · '+(scope.name||'Сравнение ответов'),'message-label'));
 if(scope.selectionChoices){
  host.append(el('p',scope.selectionChoices.length?'Уточните продукт для сравнения.':'Укажите номер опроса, название продукта из справочника, канал или «по всему банку».'));
  for(const choice of scope.selectionChoices)host.append(button(choice.label,event=>retry({selection:choice.selection},event.currentTarget)));
  return 'Уточните отбор';
 }
 if(scope.choices){
  host.append(el('p','У этого опроса есть дневные данные в обоих каналах. Выберите канал для сравнения.'));
  for(const channel of scope.choices)host.append(button(channel==='communication'?'Пуш + СМС':'Экраны успеха',event=>retry({selection:{...scope.selection,channel}},event.currentTarget)));
  return 'Выберите канал опроса';
 }
 if(scope.unavailable){
  host.append(el('p',scope.unavailable));
  return 'Недостаточно данных для разбора';
 }
 const comparison=span(scope.windows.current)+' к '+span(scope.windows.previous);
 const details=el('details',undefined,'feedback-breakdown');
 details.append(el('summary','Периоды, полнота и расчёт'),el('p',comparison),
  el('p','Сопоставимых пар «опрос × день»: '+scope.pairCount+' из '+scope.surveyCount*7+'. Опросов в сравнении: '+scope.comparedSurveys+' из '+scope.surveyCount+'. Последняя дневная дата CSV в отборе: '+date(scope.latest||scope.through)+'.'));
 for(const [key,label] of [['previous','База'],['current','Текущее окно']]){
  const item=scope.comparisonCoverage[key];
  details.append(el('p',label+' · пропуски по парам «опрос × день»: '+item.missingSurveyDays+' · даты: '+(item.missing.map(date).join(', ')||'нет')+
   ' · ответов в известных строках вне сравнения: '+whole.format(item.excludedAnswers)+'.'));
 }
 if(scope.excludedSurveys?.length){
  const excluded=el('details',undefined,'feedback-breakdown');
  excluded.append(el('summary','Опросы вне сравнения · '+scope.excludedSurveys.length),
   table(['Опрос','Канал','Пар дней из 7','Ответы по известным строкам базы'],scope.excludedSurveys.map(row=>[
    '#'+row.id+' · '+row.name,row.channel==='communication'?'Пуш + СМС':'Экраны успеха',row.pairs,row.baselineObserved?whole.format(row.baseline):'Нет строк',
   ])));
  details.append(excluded);
 }
 if(!draft){
  host.append(el('p','Изменение ответов не подтверждено. Нужно минимум пять сопоставимых пар дней.'),details);
  return 'Недостаточно сопоставимых дней';
 }
 const factor=leadingDecline(scope);
 const delta=draft.delta;
 const headline=(delta<0?'Ответов стало меньше на '+whole.format(-delta):delta>0?'Ответов стало больше на '+whole.format(delta):'Число ответов не изменилось')+
  (delta&&draft.baseline?' ('+percent.format(Math.abs(delta)/draft.baseline)+')':'')+'.';
 host.append(el('p',headline+' '+whole.format(draft.baseline)+' → '+whole.format(draft.current)+' ответов.','feedback-delta'),el('p',comparison,'overview-source'));
 if(delta<0&&factor){
  const [key,label]=factor;
  host.append(el('p','Наибольший вклад в снижение: '+label.toLocaleLowerCase('ru-RU')+' ('+amount(key,scope.baseline[key])+' → '+amount(key,scope.current[key])+').'));
 }else if(delta<0&&!scope.factors)host.append(el('p','Для разложения снижения недостаточно данных о событиях или отправках.'));
 if(scope.pairCount<scope.surveyCount*7)host.append(el('p','Вывод по '+scope.comparedSurveys+' из '+scope.surveyCount+
  ' опросов. Известных ответов базы вне сравнения: '+whole.format(scope.comparisonCoverage.previous.excludedAnswers)+'.'));
 if(scope.surveyCount>1&&scope.contributors.length){
  const rows=scope.contributors.filter(row=>row.delta<0);
  const lead=rows[0];
  if(lead&&delta<0)host.append(el('p','Первым проверить #'+lead.id+' · '+lead.name+' ('+signed.format(lead.delta)+' ответов).'));
  const parts=el('details',undefined,'feedback-breakdown');
  parts.append(el('summary','Вклад опросов в изменение'),table(['Опрос','Канал','База','Текущее окно','Изменение','Фактор снижения','Пар дней'],scope.contributors.map(row=>[
   '#'+row.id+' · '+row.name,row.channel==='communication'?'Пуш + СМС':'Экраны успеха',whole.format(row.baseline),whole.format(row.current),
   signed.format(row.delta),row.delta<0?factors.find(([key])=>key===row.leading)?.[1]||'—':'—',row.pairs,
  ])));
  host.append(parts);
 }
 const hypothesis=report.hypotheses.find(item=>item.id===draft.hypothesis?.id);
 const assign=assignment(scope,onSaved);
 if(hypothesis){
  host.append(el('p','Гипотеза: '+hypothesis.title+'. Причина требует подтверждения.'),el('p',hypothesis.check));
  for(const ref of hypothesis.refs){
   const fact=report.facts[ref];
   if(fact.kind==='calendar')details.append(el('p','Календарь · '+fact.title+' · '+date(fact.from)+' — '+date(fact.to)));
   if(fact.kind==='history')details.append(el('p','Закрытая проверка по '+date(fact.through)+' · '+fact.result));
  }
  host.append(button('Назначить эту проверку',()=>assign.use(hypothesis)));
 }
 snapshot(details,scope);
 host.append(button('Слайд для комитета',event=>window.CommitteeSlide.open(scope,hypothesis,event.currentTarget,draft.signature)),details,assign.details);
 return headline;
}
function openAnswerChange(params,opener,onSaved){
 const dialog=el('dialog',undefined,'overview-dialog committee-slide-dialog'),content=el('section');
 dialog.setAttribute('aria-label','Разбор изменения ответов');
 const close=button('Закрыть',()=>dialog.close());
 dialog.append(el('h2','Разбор изменения ответов'),content,close);
 document.body.append(dialog);dialog.showModal();
 dialog.addEventListener('close',()=>{dialog.remove();opener?.focus();},{once:true});
 async function load(overrides={}){
  content.replaceChildren(el('p','Сравниваем ответы…'));
  try{
   const result=await post({action:'answer-change',...params,...overrides});
   if(dialog.open)renderAnswerChange(content,result,load,onSaved);
  }catch(error){content.replaceChildren(el('p',error.message,'error'));}
 }
 load();
}
window.FeedbackOverview={create,snapshot,answerChangeQuery,renderAnswerChange,openAnswerChange};
})();
