(()=>{
'use strict';
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const sf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2,signDisplay:'exceptZero'});
const pf=new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:2});
const labels={events:'Объём событий',sendShare:'Доля отправок',responseRate:'Отклик',answers:'Ответы',stop:'Доля стоп-листов',contactPolicy:'Доля политики контактов'};
const date=value=>value.split('-').reverse().join('.');
const span=window=>date(window.start)+' — '+date(window.end);
const post=body=>window.TrustUI.post('/api/committee',body);
function el(tag,value){const node=document.createElement(tag);if(value!==undefined)node.textContent=value;return node;}
function button(value,onclick){const node=el('button',value);node.type='button';node.onclick=onclick;return node;}

function buildSlide(draft){
 const {windows,baseline,current,delta,scope,hypothesis,factors,revision}=draft;
 const title=(delta<0?'Ответов стало меньше':delta>0?'Ответов стало больше':'Число ответов не изменилось')+(delta?' на '+nf.format(Math.abs(delta)):'');
 const compared=[windows.previous,windows.current];
 const coverage=draft.facts.coverage;
 const coverageText=coverage.days+' из 7 дней · '+coverage.comparedSurveys+' из '+coverage.surveys+' опросов · '+coverage.pairs+' пар «опрос × день»';
 const excluded=draft.comparisonCoverage;
 const excludedText=excluded?'Вне сравнения ответы в известных строках: '+nf.format(excluded.previous.excludedAnswers)+' → '+nf.format(excluded.current.excludedAnswers):'';
 const method='Сумма ответов по сопоставимым парам опросов и дней недели.';
 const data={source:'Локальные CSV проекта',dataRevision:revision,visual:{type:'bars'},months:compared.map(p=>p.start),
  periods:compared.map(p=>({...p,short:span(p)})),blocks:[{metric:'answers',id:null,label:'Ответы',values:[baseline,current]}]};
 const card=window.PresentationRender.newCard({presentationTitle:'Ответы за сопоставимые периоды',chart:{status:'ok',title:method,data}},'committee-slide');
 card.labels='all';card.valueMode='absolute';card.numberFormat='full';
 const contributors=factors?Object.entries(factors).map(([key,value])=>labels[key]+'  '+sf.format(value)):[];
 const topSurvey=delta<0&&coverage.surveys>1&&draft.contributors?.find(row=>row.delta<0);
 const topText=topSurvey?'Первым проверить #'+topSurvey.id+' ('+sf.format(topSurvey.delta)+' ответов). ':'';
 const page={layout:'one',template:'classic',theme:'light',title,
  subtitle:scope+' · '+span(windows.current)+' к '+span(windows.previous),
  footer:['Сопоставимость · '+coverageText,excludedText,draft.excludedSurveys?.length?'Опросов вне сравнения: '+draft.excludedSurveys.length:'','версия '+revision].filter(Boolean).join(' · '),
  cards:[card],kpis:[],notes:[
   {heading:'Вклад в изменение ответов',body:contributors.join('\n')||'Разложение недоступно: недостаточно данных о событиях или отправках.'},
   {heading:hypothesis||topText?'Следующая проверка':'Что можно утверждать',body:topText+(hypothesis?hypothesis.check:'Доступные данные подтверждают сравнение. Оснований для проверки конкретной причины пока нет.')},
   ...(hypothesis?[{heading:'Статус гипотезы',body:'Причина ещё не подтверждена. Совпадение с календарём требует проверки.'}]:[])
  ]};
 const evidence=[['Ссылка','Показатель или источник','База','Текущее окно','Описание']];
 for(const [ref,fact] of Object.entries(draft.facts)){
  if(fact.kind==='metric'){
   const format=['sendShare','responseRate','stop','contactPolicy'].includes(fact.metric)?pf.format:nf.format;
   evidence.push([ref,labels[fact.metric],format(fact.baseline),format(fact.current),
    Number.isFinite(fact.impact)?'Вклад в ответы '+sf.format(fact.impact):method]);
  }else if(fact.kind==='coverage'){
   evidence.push([ref,'Полнота сравнения','','',coverageText]);
  }else if(fact.kind==='calendar'){
   evidence.push([ref,fact.title,'','',span({start:fact.from,end:fact.to})+' · '+fact.relation+' · запись календаря']);
  }else{
   evidence.push([ref,fact.title,'','','Закрытая проверка · '+date(fact.through)+' · '+fact.result]);
  }
 }
 if(hypothesis)evidence.push(['hypothesis',hypothesis.title,'','','Требует проверки. '+hypothesis.check]);
 if(excluded){
  evidence.push(['excluded','Ответы в исключённых строках',excluded.previous.excludedAnswers,excluded.current.excludedAnswers,'Учитываются только известные строки.']);
  evidence.push(['missing','Дни без строк',excluded.previous.missing.join(', '),excluded.current.missing.join(', '),'Пустой список означает полное покрытие.']);
 }
 if(draft.observedMetrics)for(const metric of ['events','sends','sendShare','responseRate']){
  const {baseline,current}=draft.observedMetrics,format=metric==='sendShare'||metric==='responseRate'?pf.format:nf.format;
  evidence.push(['comparison',labels[metric]||'Отправки',baseline[metric]===null?'—':format(baseline[metric]),current[metric]===null?'—':format(current[metric]),method]);
 }
 evidence.push(['revision','Версия данных','','',revision],['signature','Отпечаток проверенного снимка','','',draft.signature]);
 const notes=[page.subtitle,method,...contributors,...evidence.slice(1).map(row=>row.filter(Boolean).join(' · '))];
 const surveyCaption=row=>'#'+row.id+' · '+row.name+' · '+(row.channel==='communication'?'Пуш + СМС':'Экраны успеха');
 for(const row of draft.contributors||[])evidence.push(['contributor',surveyCaption(row),row.baseline,row.current,
  'Изменение: '+sf.format(row.delta)+' · пар дней: '+row.pairs+(row.leading?' · '+labels[row.leading]:'')]);
 for(const row of draft.excludedSurveys||[])evidence.push(['excluded-survey',surveyCaption(row),row.baselineObserved?row.baseline:null,row.current,
  'Опрос вне сравнения · доступных пар дней: '+row.pairs]);
 if(topSurvey)notes.push('Проверить первым: '+surveyCaption(topSurvey)+' · '+sf.format(topSurvey.delta)+' ответов.');
 return {page,evidence,notes:notes.join('\n')};
}

async function open(scope,hypothesis,opener,signature){
 const dialog=el('dialog'),preview=el('div'),status=el('p'),facts=el('details'),list=el('ul');
 dialog.className='overview-dialog committee-slide-dialog';dialog.setAttribute('aria-label','Слайд для комитета');
 status.setAttribute('role','status');status.textContent='Проверяю расчёт и источники…';
 facts.append(el('summary','Расчёт и источники'),list);facts.hidden=true;
 const controls=el('div');controls.className='feedback-investigator-controls';
 const pptx=button('Скачать PPTX',()=>download('pptx')),xlsx=button('Скачать Excel',()=>download('xlsx')),close=button('Закрыть',()=>dialog.close());
 pptx.disabled=xlsx.disabled=true;
 controls.append(pptx,xlsx,close);
 dialog.append(el('h2','Слайд для комитета'),status,preview,facts,controls);
 document.body.append(dialog);dialog.showModal();
 dialog.addEventListener('close',()=>{dialog.remove();opener?.focus();},{once:true});
 const request={action:'committee-slide',key:scope.key,revision:scope.revision,hypothesis:hypothesis?.id,
  selection:scope.selection,through:scope.through};
 let draft;
 try{
  draft=await post({...request,signature});if(!dialog.open)return;
  await document.fonts.ready;if(!dialog.open)return;
  const slide=buildSlide(draft),render=window.PresentationRender.render(slide.page);
  if(render.errors.length)throw new Error(render.errors.join(' '));
  render.canvas.setAttribute('role','img');render.canvas.setAttribute('aria-label',slide.page.title);
  preview.append(render.canvas);
  for(const row of slide.evidence.slice(1))list.append(el('li',row.filter(Boolean).slice(1).join(' · ')));
  facts.hidden=false;
  status.textContent='Цифры сверены с расчётом. Источники включены в заметки PPTX и Excel.';
  pptx.disabled=xlsx.disabled=false;
 }catch(error){status.textContent=error.message;}
 async function download(format){
  pptx.disabled=xlsx.disabled=true;status.textContent='Повторно сверяю цифры и источники…';
  try{
   const checked=await post({...request,signature:draft.signature});if(!dialog.open)return;
   const slide=buildSlide(checked);
   const blob=format==='pptx'
    ?await window.PresentationOffice.powerPoint([slide.page],page=>window.PresentationRender.render(page,{editable:true}),{notes:()=>slide.notes})
    :await window.PresentationOffice.workbook([slide.page],{evidence:slide.evidence});
   if(!dialog.open)return;
   window.MeetingExports.saveBlob(blob,'committee-feedback.'+format);
   status.textContent='Файл готов к скачиванию.';
  }catch(error){status.textContent=error.message;}
  finally{pptx.disabled=xlsx.disabled=false;}
 }
}
window.CommitteeSlide={open};
})();
