/* A stable chart stage with independent text history and explicit step changes. */
(()=>{
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const labels={sends:'Отправки',answers:'Ответы',responseRate:'Отклик',events:'События',csi:'CSI',stop:'Стоп-листы',contactPolicy:'Политика контактов',unique_surveys:'Уникальные опросы',plan:'План'};
const grains={day:'по дням',week:'по неделям',month:'по месяцам'};
const format=v=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v);
const filterKey=f=>JSON.stringify(Object.entries(f||{}).sort(([a],[b])=>a.localeCompare(b)));
const filterLabel=f=>Object.entries(f||{}).map(([key,value])=>key==='product'?'Продукт: '+value:key==='triggerGroup'?'Группа: '+value:key==='top'?(value?'Приоритет: Топ':'Все приоритеты'):key==='channel'?'Канал: '+(value==='success_screen'?'Экран успеха':'Пуш+СМС'):key==='type'?'Тип: '+value:value).join(' · ')||'без фильтров';
function delta(before,after){
 if(after.kind==='calculated-dashboard')return ['Создан отдельный дашборд. '+after.periodLabel+'.'];
 if(before?.kind==='calculated-dashboard')return ['Создан новый график. '+after.periodLabel+'.'];
 if(after.kind==='generated-ui')return ['Применена новая визуализация: '+after.bundle.title+'.',before?.kind==='generated-ui'?'Предыдущий вариант доступен через возврат шага.':'Расчёт и код доступны для сверки под предпросмотром.'];
 if(before?.kind==='generated-ui')return ['Открыт обычный график для проверки данных.'];
 if(after.kind==='ai-workspace'){
  const next=after.view.components[0].items,old=before?.kind==='ai-workspace'?before.view.components[0].items:[],changes=[];
  if(!old.length)changes.push('Сформирована очередь проверок: '+next.length+'. '+after.view.title+' · '+after.periodLabel);
  else{for(const item of next){const was=old.find(o=>o.key===item.key);if(!was)changes.push('Добавлен в очередь #'+after.members[item.key].id);else if(was.priority!==item.priority)changes.push('#'+after.members[item.key].id+': '+was.priority+' → '+item.priority);}for(const was of old)if(!next.some(i=>i.key===was.key))changes.push('Снят с очереди #'+before.members[was.key].id);if(!changes.length)changes.push('Состав и приоритеты очереди сохранены. Модель повторно проверила основания.');if(JSON.stringify(before.criteria)!==JSON.stringify(after.criteria))changes.push('Изменены пороги анализа: значения доступны под экраном.');if(before.periodLabel!==after.periodLabel)changes.push('Период: '+before.periodLabel+' → '+after.periodLabel);}
  return changes;
 }
 if(before?.kind==='ai-workspace')return ['Открыта динамика для проверки сигнала.'];
 if(!before)return ['Создан новый график. '+after.periodLabel+'.'];
 const changes=[],old=before.spec,newer=after.spec;
 const pairs=s=>s.series||s.ids.flatMap(id=>s.metrics.map(metric=>({id,metric})));
 const oldPairs=pairs(old),newPairs=pairs(newer),extraPairs=newPairs.filter(p=>!oldPairs.some(o=>o.id===p.id&&o.metric===p.metric));
 if(extraPairs.length&&newer.series)changes.push('Добавлены кривые: '+extraPairs.map(p=>(labels[p.metric]||p.metric)+' · #'+p.id).join(', ')+'.');
 const added=newer.metrics.filter(k=>!old.metrics.includes(k)),removed=old.metrics.filter(k=>!newer.metrics.includes(k));
 if(added.length)changes.push('Добавлено: '+added.map(k=>labels[k]||k).join(', ')+'.');
 if(removed.length)changes.push('Убрано: '+removed.map(k=>labels[k]||k).join(', ')+'.');
 if(before.periodLabel!==after.periodLabel)changes.push('Период: '+before.periodLabel+' → '+after.periodLabel+'.');
 if(JSON.stringify(old.ids)!==JSON.stringify(newer.ids))changes.push('Опросы: '+(old.ids.join(', ')||'все по условиям')+' → '+(newer.ids.join(', ')||'все по условиям')+'.');
 if(filterKey(old.filters)!==filterKey(newer.filters))changes.push('Отбор: '+filterLabel(old.filters)+' → '+filterLabel(newer.filters)+'.');
 if((old.grain||'month')!==(newer.grain||'month'))changes.push('Детализация: '+grains[old.grain||'month']+' → '+grains[newer.grain||'month']+'.');
 if(old.layout!==newer.layout)changes.push('Расположение: '+(newer.layout==='combined'?'на одном графике':'отдельные панели')+'.');
 const samePopulation=JSON.stringify(old.ids)===JSON.stringify(newer.ids)&&filterKey(old.filters)===filterKey(newer.filters);
 if(samePopulation&&before.periodLabel===after.periodLabel){for(const total of after.totals){const previous=before.totals.find(t=>t.id===total.id&&t.metric===total.metric);if(previous&&Number.isFinite(previous.value)&&Number.isFinite(total.value)&&previous.value!==total.value){const diff=total.value-previous.value;changes.push(`${labels[total.metric]||total.metric}${total.id?' · #'+total.id:''}: ${format(previous.value)} → ${format(total.value)} (${diff>0?'+':''}${format(diff)}${total.metric==='csi'?' пункта':''}).`);}}}
 if(samePopulation&&before.periodLabel===after.periodLabel){for(const block of after.blocks||[]){const previous=(before.blocks||[]).find(b=>b.id===block.id&&b.metric===block.metric);if(!previous)continue;const changed=after.months.map((m,i)=>({month:m,before:previous.values[before.months.indexOf(m)]??null,after:block.values[i]??null})).filter(p=>p.before!==p.after);if(changed.length){const value=v=>Number.isFinite(v)?format(v):'нет данных';changes.push(`${labels[block.metric]||block.metric}${block.id?' · #'+block.id:''}: изменилось точек — ${changed.length}. ${changed.slice(0,3).map(p=>p.month+': '+value(p.before)+' → '+value(p.after)).join('; ')}${changed.length>3?'; остальные — на графике.':'.'}`);}}}
 if(!changes.length)changes.push('Параметры прежние. Данные перечитаны; сопоставимые итоги не изменились.');
 return changes;
}
const chartLabel=turn=>turn.data.kind==='calculated-dashboard'?'№'+turn.number+' · '+turn.data.dataset.title+' · дашборд':turn.data.kind==='generated-ui'?'№'+turn.number+' · '+turn.data.bundle.title+' · новый интерфейс':turn.data.kind==='ai-workspace'?'№'+turn.number+' · '+turn.data.view.title+' · шаг '+(turn.step||1):'№'+turn.number+' · '+turn.data.spec.metrics.map(m=>labels[m]||m).join(', ')+' · '+(turn.data.spec.ids.length?'#'+turn.data.spec.ids.join(', #'):filterLabel(turn.data.spec.filters))+' · шаг '+(turn.step||1);
window.FocusWorkspace={delta,label:chartLabel,create({main,feed,composer,onSelect,onNew,onUndo}){
 const root=el('section','focus-workspace');root.hidden=true;root.setAttribute('aria-label','Работа с графиком');
 const toolbar=el('header','focus-toolbar'),title=el('strong','','Рабочий график'),picker=el('select');picker.setAttribute('aria-label','Выбрать график');picker.onchange=()=>onSelect(Number(picker.value));
 const fresh=el('button','','Новый график');fresh.type='button';fresh.onclick=onNew;
 const back=el('button','','Вернуть предыдущий шаг');back.type='button';back.disabled=true;back.onclick=()=>onUndo(current);
 const center=el('button','focus-center','К графику');center.type='button';center.onclick=()=>{pane('chart');revealPlot();};toolbar.append(title,picker,back,center,fresh);root.append(toolbar);
 const mobile=el('div','focus-tabs'),chartTab=el('button','','График'),chatTab=el('button','','Диалог');chartTab.type=chatTab.type='button';mobile.append(chartTab,chatTab);root.append(mobile);
 function pane(name){root.dataset.pane=name;chartTab.setAttribute('aria-pressed',String(name==='chart'));chatTab.setAttribute('aria-pressed',String(name==='chat'));}chartTab.onclick=()=>{pane('chart');requestAnimationFrame(revealPlot);};chatTab.onclick=()=>pane('chat');pane('chart');
 const grid=el('div','focus-grid'),left=el('section','focus-chart-pane'),status=el('div','focus-status','Готов к запросу'),deltaBox=el('div','step-delta'),stage=el('div','focus-stage');stage.setAttribute('aria-label','Текущий график');status.setAttribute('role','status');deltaBox.setAttribute('aria-live','polite');stage.append(feed);left.append(status,deltaBox,stage);
 const right=el('aside','focus-chat-pane'),chatTitle=el('h2','','Диалог изменений'),thread=el('div','focus-thread');thread.setAttribute('role','log');thread.setAttribute('aria-label','Сообщения и шаги');right.append(chatTitle,thread);grid.append(left,right);root.append(grid);main.append(root);
 let current=null;let isBusy=false;
 function caption(){if(current?.data.kind==='calculated-dashboard')return current.data.dataset.title+' · '+current.data.periodLabel;if(current?.data.kind==='generated-ui')return current.data.bundle.title+' · '+current.data.periodLabel;if(current?.data.kind==='ai-workspace')return current.data.view.title+' · '+current.data.periodLabel;return current?current.data.spec.metrics.map(m=>labels[m]||m).join(', ')+' · '+(current.data.spec.ids.length?'Опросы '+current.data.spec.ids.join(', '):filterLabel(current.data.spec.filters))+' · '+current.data.periodLabel:'';}
 function revealPlot(){if(!current)return;if(['ai-workspace','generated-ui','calculated-dashboard'].includes(current.data.kind)){stage.scrollTop=0;return;}const card=current.element.querySelector('.v2-chart')||current.element.querySelector('.charts');if(card){stage.scrollTop+=card.getBoundingClientRect().top-stage.getBoundingClientRect().top-8;}}
 window.addEventListener('resize',()=>{if(current&&!root.hidden)requestAnimationFrame(revealPlot);});
 function start(){root.hidden=document.body.classList.contains('focus-browse');document.body.classList.add('focus-active');right.append(composer);}
 function show(turn,all,reveal=true){start();current=turn;for(const item of all)item.element.hidden=item!==turn;picker.replaceChildren();for(const item of all)picker.add(new Option(chartLabel(item),item.number));picker.value=turn.number;picker.title=chartLabel(turn);title.textContent=(turn.data.kind==='calculated-dashboard'?'Дашборд №':turn.data.kind==='generated-ui'?'Новый интерфейс №':turn.data.kind==='ai-workspace'?'AI-мониторинг №':'График №')+turn.number;back.disabled=isBusy||!turn.versions?.length;
  deltaBox.replaceChildren(el('strong','','Шаг '+(turn.step||1)+' · '+(turn.deltaTitle||'Что изменилось')));for(const line of turn.delta||[])deltaBox.append(el('p','',line));
  if(!isBusy)status.textContent='Готово · '+caption();
  if(reveal){stage.scrollTop=0;pane('chart');requestAnimationFrame(()=>requestAnimationFrame(revealPlot));}
 }
 function loading(value,target){isBusy=value;root.classList.toggle('is-updating',value);stage.setAttribute('aria-busy',String(value));back.disabled=value||!current?.versions?.length;picker.disabled=value;fresh.disabled=value;status.textContent=value?(target?'Обновляю график №'+target.number+' · текущая версия остаётся на экране':'Создаю новый график · текущий остаётся на экране'):'Готово · '+caption();}
 function message(kind,text){const host=el('article','chat-message message-'+kind);host.append(el('div','message-label',kind==='user'?'Вы':'GEN UI'),el('p','message-text',text));thread.append(host);thread.scrollTop=thread.scrollHeight;return host;}
 function messageDone(){thread.scrollTop=thread.scrollHeight;}
 function reset(){root.hidden=true;document.body.classList.remove('focus-active');composer.hidden=document.body.classList.contains('focus-browse');main.append(composer);thread.replaceChildren();current=null;}
 return {root,stage,thread,start,show,loading,message,messageDone,reset,chat:()=>pane('chat'),notice:text=>{status.textContent=text;}};
}};
})();
