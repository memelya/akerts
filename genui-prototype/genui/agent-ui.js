(()=>{'use strict';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const labels={sends:'Отправки',answers:'Ответы',responseRate:'Отклик',events:'События',csi:'CSI',stop:'Стоп-листы',contactPolicy:'Политика контактов',replyRatio:'Ответы / отправки периода',planExpected:'План ответов окна',signals:'Кандидаты на проверку'};
const priorities={critical:'P0 · Проверить немедленно',high:'P1 · Проверить сегодня',medium:'P2 · Уточнить данные',low:'P3 · Наблюдать'};
const flags={answers_drop:'Снижение ответов',send_change:'Изменение отправок',send_answer_mismatch:'Отправки растут, ответы падают',csi_drop:'Снижение CSI',stop_increase:'Рост отсечений стоп-листа',contactPolicy_increase:'Рост отсечений политики контактов',plan_gap:'Отставание от плана',no_observations:'Нет наблюдений в окне',incomplete_window:'Неполное окно',limited_csi_sample:'Малая выборка CSI',missing_baseline:'Нет сопоставимой базы',mixed_grain:'Смешанная детализация'};
const format=v=>Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumFractionDigits:2}):'нет данных';
const post=(body)=>window.TrustUI.post('/api/ai',body);
function fact(data,ref){const f=data.facts[ref],box=el('article','ai-fact');if(!f)return box;
 const m=data.members[f.key];box.append(el('b','',(labels[f.metric]||f.metric)+(m?' · #'+m.id:'')),el('strong','',format(f.actual)+' '+f.unit));
 if(f.baseline!==null&&f.baseline!==undefined)box.append(el('small','','Сопоставимо: '+format(f.current)+' ← '+format(f.baseline)+(f.delta!==null&&f.delta!==undefined?' · Δ '+format(f.delta)+(f.metric==='csi'?' балла':f.percent!==null&&f.percent!==undefined?' ('+format(f.percent)+'%)':''):'')));
 if(f.sample!==undefined&&f.sample!==null)box.append(el('small','','Выборка: '+format(f.sample)+' / база '+format(f.baselineSample)));
 if(f.coverage!==null&&f.coverage!==undefined)box.append(el('small','','Дни / периоды с наблюдениями: '+format(f.coverage*100)+'%'));
 if(f.note)box.append(el('small','',f.note));const details=el('details');details.append(el('summary','','Основание '+ref));details.append(el('p','','Источник: '+data.dataRevision+' · '+data.periodLabel));
 if(f.proof)details.append(el('p','','CSI = '+format(f.proof.current.numerator)+' / '+format(f.proof.current.denominator)+'; база '+format(f.proof.baseline.numerator)+' / '+format(f.proof.baseline.denominator)+'. Нулевые оценки исключены.'));
 details.append(el('p','','Отсутствующие даты не считаются нулями. Для изменения сравниваются только даты с наблюдениями в обоих окнах.'));box.append(details);return box;
}
function facts(host,data,refs){const grid=el('div','ai-facts');for(const ref of refs)grid.append(fact(data,ref));host.append(grid);}
function editPlan(plan,run,chart){
 const dialog=el('dialog','overview-dialog query-plan'),form=el('form'),fields=el('div','workflow-controls'),error=el('p','error'),scope=chart?plan.spec:plan.scope,period=chart?plan.spec:plan.period;
 function field(label,type,value,options){
  const wrap=el('label','',label),control=el(options?'select':'input');
  if(options)for(const [key,title] of options)control.add(new Option(title,key));
  else control.type=type;
  control.setAttribute('aria-label',label);control.value=value??'';wrap.append(control);fields.append(wrap);return control;
 }
 const ids=field('Номера опросов','text',scope.ids.join(', ')),channel=field('Канал','',scope.filters?.channel||scope.channel||'',[['','По данным'],['communication','Пуш + СМС'],['success_screen','Экран успеха']]);
 ids.placeholder='Пусто для общего отбора';
 const grains=[['month','По месяцам'],['day','По дням']];if(chart)grains.splice(1,0,['week','По неделям']);
 const grain=field('Группировка','',period.grain||'month',grains);
 const begin=field('Месяц начала','month',period.startMonth),end=field('Месяц окончания','month',period.endMonth);
 const months=field('Месяцев без явных дат','number',period.monthsCount||period.months||3);
 months.min=1;months.max=chart?24:12;
 const days=chart?null:field('Дней без явных дат','number',period.days||7);
 const startDay=field('Первый день','date',period.startDate),endDay=field('Последний день','date',period.endDate);
 if(days){days.min=1;days.max=366;}
 grain.onchange=()=>{
  const showMonth=chart||grain.value==='month';
  for(const input of [begin,end,months])input.parentElement.hidden=!showMonth;
  for(const input of [startDay,endDay])input.parentElement.hidden=grain.value==='month';
  if(days)days.parentElement.hidden=showMonth;
 };
 grain.onchange();
 const metrics={events:'События',sends:'Отправки',answers:'Ответы',responseRate:'Отклик',csi:'CSI',stop:'Стоп-листы',contactPolicy:'Политика контактов',unique_surveys:'Уникальные опросы',plan:'План ответов'},checks=[];
 if(chart){
  const group=el('fieldset','presentation-series');group.append(el('legend','','Показатели'));
  for(const [key,title] of Object.entries(metrics)){
   if(key==='plan'&&!scope.plan)continue;
   const label=el('label'),check=el('input');check.type='checkbox';check.checked=scope.metrics.includes(key)||key==='plan'&&scope.plan;label.append(check,document.createTextNode(title));group.append(label);checks.push([key,check]);
  }
  fields.append(group);
 }
 const go=el('button','','Выполнить расчёт'),cancel=el('button','quiet','Отмена');go.type='submit';cancel.type='button';error.setAttribute('role','alert');
 form.append(el('h2','','Проверьте план запроса'),el('p','',chart?plan.interpretation:plan.title),el('p','','Пустой конец периода использует последние доступные наблюдения.'),fields,go,cancel,error);
 dialog.append(form);document.body.append(dialog);
 return new Promise((resolve,reject)=>{
  let result,running=false;
  cancel.onclick=()=>dialog.close();
  dialog.oncancel=event=>{if(running)event.preventDefault();};
  dialog.onclose=()=>{dialog.remove();if(result)resolve(result);else reject(Object.assign(new Error('План закрыт. Расчёт не запущен.'),{discarded:true}));};
  form.onsubmit=async event=>{
   event.preventDefault();error.textContent='';
   const values=ids.value.trim().split(/[\s,]+/).filter(Boolean);
   if(values.some(value=>!/^\d{1,7}$/.test(value)||Number(value)<1)){error.textContent='Введите корректные номера опросов через запятую.';return;}
   const chosen=values.map(Number),selected=checks.filter(([,control])=>control.checked).map(([key])=>key);
   const exact=grain.value!=='month'&&(startDay.value||endDay.value);
   const params=chart?{ids:chosen,channel:channel.value,grain:grain.value,metrics:selected,startMonth:exact?'':begin.value,endMonth:exact?'':end.value,monthsCount:Number(months.value),...(exact?{startDate:startDay.value,endDate:endDay.value}:{})}:
    {ids:chosen,channel:channel.value,period:{grain:grain.value,comparison:period.comparison,...(grain.value==='month'?{months:Number(months.value),...(begin.value?{startMonth:begin.value}:{}),...(end.value?{endMonth:end.value}:{})}:{days:Number(days.value),...(startDay.value?{startDate:startDay.value}:{}),...(endDay.value?{endDate:endDay.value}:{})})}};
   running=true;go.disabled=cancel.disabled=true;dialog.setAttribute('aria-busy','true');
   try{result=await run(params);dialog.close();}catch(e){error.textContent=e.message;}finally{running=false;go.disabled=cancel.disabled=false;dialog.removeAttribute('aria-busy');}
  };
  dialog.showModal();
 });
}
window.AgentUI={async wait(jobId,host,notice){const status=el('p','ai-progress','Модель планирует анализ…'),view=el('button','quiet','Показать рассчитанные данные'),cancel=el('button','quiet','Остановить анализ');view.type='button';view.hidden=true;view.onclick=()=>window.CreativeUI.calculated(jobId).catch(e=>{status.textContent=e.message;});cancel.type='button';host.replaceChildren(status,view,cancel);let cancelled=false;cancel.onclick=async()=>{cancel.disabled=true;cancelled=true;try{await post({jobId,action:'cancel'});}catch(e){status.textContent=e.message;}};
 while(true){const job=await post({jobId});view.hidden=!job.hasCalculatedData;status.textContent=(cancelled?'Останавливаю…':job.stage)+' · вызовов модели: '+job.calls+(job.stageElapsedSeconds!==null&&job.stageElapsedSeconds!==undefined?' · '+job.stageElapsedSeconds+' / '+job.timeBudgetSeconds+' с':'');notice(status.textContent);
  if(job.status==='review_plan'){
   try{await editPlan(job.reviewPlan,edits=>post({jobId,action:'confirm-plan',edits}),false);}
   catch(e){await post({action:'cancel',jobId}).catch(()=>{});throw e;}
   await new Promise(resolve=>setTimeout(resolve,250));continue;
  }
  if(job.status==='awaiting_confirmation'){
   try{const settings=await window.CreativeUI.confirm(job.interpretation,jobId);if(settings.calculatedOnly){return await window.TrustUI.post('/api/creative',{action:'finish-dashboard',jobId});}await window.TrustUI.post('/api/creative',{action:'generate',jobId,...settings});}
   catch(e){await post({action:'cancel',jobId}).catch(()=>{});throw e;}
   continue;
  }
  if(job.status==='done')return {...job.result,stale:job.stale};
  if(job.status==='clarification'){const e=new Error(job.clarification.question);e.clarification={options:(job.clarification.options||[]).map(label=>({label,query:label}))};throw e;}
  if(['error','cancelled'].includes(job.status)){const error=new Error(job.error||'Анализ остановлен. Предыдущий экран сохранён.');error.recovery=job.recovery;error.diagnosis=job.diagnosis;throw error;}
  await new Promise(resolve=>setTimeout(resolve,650));
 }
},reviewChart:plan=>editPlan(plan,chartEdits=>window.TrustUI.post('/api/genui',{planId:plan.planId,chartEdits}),true),render(host,data,{onChart,onRerun,renderChart}){
 host.classList.add('ai-workspace');host.append(el('p','message-label','GigaCode · модельный анализ · '+data.modelCalls+' вызова'),el('h2','answer-title',data.view.title),el('p','ai-source','Загруженные наблюдения: '+data.periodLabel+' · версия '+data.dataRevision+' · определения '+data.metricVersion),el('p','',data.view.summary));
 if(data.stale)host.append(el('p','error','CSV обновились во время анализа. На экране зафиксированная предыдущая версия. Повторите запрос для новых данных.'));
 host.append(el('p','ai-caveat','Это очередь проверок, а не подтверждённые инциденты. Период привязан к последней дате CSV. Причины требуют проверки; пропуски не равны нулю.'));
 for(const component of data.view.components){const section=el('section','ai-section');section.append(el('h3','',component.title));
  if(component.type==='priority_queue'){
   if(!component.items.length)section.append(el('p','','По предложенным критериям подтверждённых кандидатов нет. Это не гарантирует отсутствие проблем.'));
   for(const item of component.items){const m=data.members[item.key],card=el('article','ai-priority');card.dataset.priority=item.priority;card.append(el('b','ai-priority-label',priorities[item.priority]),el('h4','','#'+m.id+' · '+m.name),el('small','',m.channel==='communication'?'Пуш + СМС':'Экран успеха'),el('p','',item.reason));facts(card,data,item.factRefs);
    const checks=el('ol');item.checks.forEach(t=>checks.append(el('li','',t)));card.append(el('b','','Что проверить'),checks);
    for(const h of item.hypotheses||[]){card.append(el('p','ai-hypothesis','Гипотеза: '+h.text));facts(card,data,h.factRefs);for(const ref of h.eventRefs||[])card.append(el('small','','Контекст календаря: '+data.events[ref].title));}
    const drill=el('button','quiet','Открыть динамику опроса');drill.type='button';drill.onclick=async()=>{drill.disabled=true;try{onChart(await post({jobId:data.jobId,action:'chart',keys:[item.key],metrics:[...new Set(item.factRefs.map(r=>data.facts[r].metric).filter(m=>['sends','answers','csi','stop','events','contactPolicy'].includes(m)))].slice(0,6)}),'Детализация #'+m.id);}catch(e){card.append(el('p','error',e.message));}finally{drill.disabled=false;}};card.append(drill);section.append(card);
   }
  }else if(['kpis','comparison'].includes(component.type))facts(section,data,component.refs);
  else if(component.type==='trend'){const chart=el('article','chat-message answer');section.append(chart);renderChart(chart,component.chartData);}
  else if(component.type==='context'){if(!component.eventRefs.length)section.append(el('p','','В календаре нет подходящих записей.'));for(const ref of component.eventRefs){const e=data.events[ref];section.append(el('p','',e.from+' · '+e.title+' · '+(e.note||'')));}}
  else if(component.type==='next_steps'){for(const item of component.items){section.append(el('p','',item.text));facts(section,data,item.factRefs);}}
  host.append(section);
  if(component.type==='priority_queue'){const proof=el('details','ai-section');proof.append(el('summary','','Основания общего вывода'));facts(proof,data,data.view.summaryRefs);host.append(proof);}
 }
 const coverage=el('details','ai-section');coverage.append(el('summary','','Охват анализа: '+Object.keys(data.members).length+' опросов · '+data.eligible.length+' кандидатов'));
 coverage.append(el('p','','Проверены все опросы отбора. Первичный индекс помогает выбрать кандидатов для модели; финальный приоритет назначает модель с ограничениями по надёжности. Все кандидаты доступны ниже.'));
 const list=el('div');let shown=0;const more=el('button','quiet','Показать следующие');more.type='button';const chosen=new Set(data.view.components[0].items.map(i=>i.key));const ordered=[...data.candidates].sort((a,b)=>b.score-a.score);
 const append=()=>{for(const c of ordered.slice(shown,shown+30)){const row=el('p','', '#'+c.id+' · '+c.name+' · '+(chosen.has(c.key)?'в очереди модели':'вне очереди модели')+' · '+(c.flags.map(f=>flags[f.code]||f.code).join('; ')||'сигналов нет')+' · сопоставимость '+format(c.comparisonCoverage*100)+'%');list.append(row);}shown+=30;more.hidden=shown>=ordered.length;};append();more.onclick=append;coverage.append(list,more);host.append(coverage);
 const thresholds=el('details','ai-section');thresholds.append(el('summary','','Критерии и пороги анализа'),el('p','',data.agentPlan.criteriaReason));
 const names={minAnswers:'Минимум ответов',answerDropPct:'Снижение ответов, %',sendChangePct:'Изменение отправок, %',csiDrop:'Падение CSI, балла',minCsiSample:'Минимальная выборка CSI',cutoffGrowthPct:'Рост отсечений, %',minCutoffDelta:'Минимальный прирост отсечений',minCoverage:'Доля сопоставимых периодов (0–1)',planGapPct:'Отставание от плана, %'};const fields={};
 for(const [k,v] of Object.entries(data.criteria)){const label=el('label','ai-threshold',names[k]);const input=el('input');input.type='number';input.step='any';input.value=v;fields[k]=input;label.append(input);thresholds.append(label);}
 const rerun=el('button','quiet','Пересмотреть анализ с этими порогами');rerun.type='button';rerun.onclick=()=>onRerun(Object.fromEntries(Object.entries(fields).map(([k,input])=>[k,Number(input.value)])));thresholds.append(rerun);host.append(thresholds);
 const technical=el('details','ai-section');technical.append(el('summary','','Как работал агент'),el('p','','Модель выбрала отбор, критерии, приоритеты и блоки. Расчёты выполнены локально. В CLI переданы агрегаты, названия опросов и контекст календаря; исходные строки CSV не передавались.'),el('p','','Инструменты: '+(data.tools.map(t=>t.tool+' '+t.keys.join(', ')).join('; ')||'первичный расчёт без дополнительной инспекции')));host.append(technical);
}};
})();
