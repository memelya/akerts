const grid=document.getElementById('eventGrid');
const cards=[...grid.querySelectorAll('.event-card')];
const search=document.getElementById('eventSearch');
const sort=document.getElementById('eventSort');
const planFilter=document.getElementById('planFilter');
const count=document.getElementById('resultCount');
const empty=document.getElementById('emptyState');
const scopeButtons=[...document.querySelectorAll('[data-scope]')];
const channelButtons=[...document.querySelectorAll('[data-channel-filter]')];
let scope='top';
let channel='communication';
let personal=null;
const statusSearch={"0":"По событию после всех проверок совершена коммуникация с клиентом","1":"Синхронизация с CRM: Ошибка тайм-аута CRM. Детальный статус не был присвоен.","10":"За определённый срок не стало применимым и было удалено","100":"Синхронизация с CRM: Неверный формат запроса","1001":"Время жизни события истекло","1002":"Интеграция со стоплистами массперс: Найден в стоплисте","1003":"Проверка по УК внутри ППРБ: Недавно участвовал в опросе","1004":"Интеграция с ЕПК: Не найден в ЕПК","1005":"Интеграция с ЕПК: Нет номера МБК","1006":"Интеграция с ЕПК: Не соответствует сегменту","1007":"Синхронизация с CRM: Ошибка тайм-аута CRM","1008":"Событие было не применимо на данный момент","1009":"Текст с персональными тегами не может быть подготовлен","1010":"Проверка по УК внутри ППРБ: Недавно участвовал в опросе (spec)","1011":"Проверка УК по групповой политике: Недавно участвовал в опросе группы","1012":"Интеграция с ЕПК: Нет эл. почты","1013":"Интеграция с ЕПК: Не соответствует выбранной опции «последний вход в СБОЛ»","1014":"Интеграция с ЕПК: Не тот сегмент B2C","1015":"Дубликат по epk id и event type id","1016":"Политика коммуникаций по подгруппам не пройдена (ThirdGroup)","1017":"Сегмент исключен (ThirdGroup)","1018":"Недавно опрошен по сегменту (ThirdGroup)","1019":"Канал исключен (ThirdGroup)","1020":"Политика коммуникаций по группам не пройдена (SecondGroup)","1021":"Сегмент исключен (SecondGroup)","1022":"Недавно опрошен по сегменту (SecondGroup)","1023":"Канал исключен (SecondGroup)","1024":"Не пройдена ПК по каналу коммуникации (FirstGroup)","1025":"Отключена коммуникация по телефону","-1":"За определённый срок не было взято в обработку и было удалено"};
const searchable=new Map(cards.map(card=>[card,(card.dataset.search+' '+(card.dataset.statusCodes||'').split(',').map(code=>code+' '+(statusSearch[code]||'')).join(' ')).toLowerCase()]));
const plural=n=>{const d=n%10,h=n%100;return h>=11&&h<=14?'опросов':d===1?'опрос':d>=2&&d<=4?'опроса':'опросов'};
let sparkRequest=null;
function hydrateSparks(visible){
  const targets=visible.flatMap(card=>[...card.querySelectorAll('[data-spark-id]')]);
  if(!targets.length)return;
  if(!sparkRequest)sparkRequest=fetch('assets/card-sparks.json').then(r=>{if(!r.ok)throw Error('graph load');return r.json()}).catch(()=>{sparkRequest=null;return null});
  sparkRequest.then(data=>targets.forEach(target=>{if(!data){target.textContent='График временно недоступен. Повторите поиск.';return;}target.innerHTML=data[target.dataset.sparkId]||'';target.removeAttribute('data-spark-id');target.removeAttribute('aria-busy');}));
}
function update(){
  const query=search.value.trim().toLowerCase().replace(/^#\s*/, '');
  const scoped=cards.filter(card=>scope==='top'?card.dataset.top==='true':card.dataset.hasData==='true');
  channelButtons.forEach(button=>{button.querySelector('[data-channel-count]').textContent=scoped.filter(card=>card.dataset.channel===button.dataset.channelFilter).length});
  let visible=scoped.filter(card=>card.dataset.channel===channel&&(!personal||personal.allows(card))&&(!query||searchable.get(card).includes(query))&&(planFilter.value==='all'||card.dataset.planStatus===planFilter.value));
  const key=sort.value;
  visible.sort((a,b)=>key==='top'?Number(a.dataset.rank)-Number(b.dataset.rank):key==='id'?Number(a.dataset.id)-Number(b.dataset.id):key==='change'?Number(b.dataset.change)-Number(a.dataset.change):Number(b.dataset.latest)-Number(a.dataset.latest));
  cards.forEach(card=>card.hidden=true);
  visible.forEach(card=>{card.hidden=false;grid.append(card)});
  count.textContent=visible.length+' '+plural(visible.length);
  empty.hidden=visible.length!==0;
  personal?.changed();
  hydrateSparks(visible);
}
scopeButtons.forEach(button=>button.addEventListener('click',()=>{scope=button.dataset.scope;scopeButtons.forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button))});update()}));
channelButtons.forEach(button=>button.addEventListener('click',()=>{channel=button.dataset.channelFilter;channelButtons.forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button))});update()}));
search.addEventListener('input',update);sort.addEventListener('change',update);planFilter.addEventListener('change',update);update();
personal=window.createEventsWorkspace?.({cards,refresh:update,readFilters:()=>({scope,channel,query:search.value,sort:sort.value,plan:planFilter.value}),applyFilters:filters=>{
  scope=filters.scope==='all'?'all':'top';channel=filters.channel==='success_screen'?'success_screen':'communication';
  search.value=typeof filters.query==='string'?filters.query:'';sort.value=['latest','top','id','change'].includes(filters.sort)?filters.sort:'latest';planFilter.value=['all','risk','ontrack'].includes(filters.plan)?filters.plan:'all';
  scopeButtons.forEach(b=>{b.classList.toggle('active',b.dataset.scope===scope);b.setAttribute('aria-pressed',String(b.dataset.scope===scope));});
  channelButtons.forEach(b=>{b.classList.toggle('active',b.dataset.channelFilter===channel);b.setAttribute('aria-pressed',String(b.dataset.channelFilter===channel));});
}})??null;
update();
document.getElementById('resetFilters')?.addEventListener('click',()=>{scope='all';channel='communication';search.value='';sort.value='latest';planFilter.value='all';document.querySelector('[data-personal-mode="all"]')?.click();scopeButtons.forEach(b=>{b.classList.toggle('active',b.dataset.scope===scope);b.setAttribute('aria-pressed',String(b.dataset.scope===scope));});channelButtons.forEach(b=>{b.classList.toggle('active',b.dataset.channelFilter===channel);b.setAttribute('aria-pressed',String(b.dataset.channelFilter===channel));});update();});
// Keep the primary search above optional personalisation controls.
document.querySelector('.catalogue-tools')?.after(document.getElementById('personalWorkspace'));
function focusCatalogue(){requestAnimationFrame(()=>requestAnimationFrame(()=>{document.getElementById('catalogue').scrollIntoView({block:'start'});search.focus({preventScroll:true});}));}
document.querySelectorAll('a[href="#catalogue"]').forEach(link=>link.addEventListener('click',focusCatalogue));
if(location.hash==='#catalogue'){focusCatalogue();window.addEventListener('load',focusCatalogue,{once:true});document.fonts?.ready.then(focusCatalogue);}
const chartDialog=document.getElementById('chartDialog');
if(chartDialog){
  const dialogBody=chartDialog.querySelector('.chart-dialog__body');
  const dialogEyebrow=chartDialog.querySelector('.chart-dialog__head .eyebrow');
  const dialogTitle=chartDialog.querySelector('.chart-dialog__head strong');
  document.querySelectorAll('.chart-expand').forEach(button=>button.addEventListener('click',()=>{
    const dashboard=button.closest('.group-dashboard');
    chartDialog.classList.remove('is-card-view');
    dialogEyebrow.textContent=dashboard.querySelector('.eyebrow').textContent;
    dialogTitle.textContent='Пуш и SMS · Экраны успеха';
    dialogBody.replaceChildren(dashboard.querySelector('.group-dashboard__charts').cloneNode(true));
    chartDialog.showModal();
  }));
  document.querySelectorAll('.card-expand').forEach(button=>button.addEventListener('click',event=>{
    event.preventDefault();event.stopPropagation();
    const card=button.closest('.event-card');
    const clone=card.cloneNode(true);
    clone.removeAttribute('href');clone.removeAttribute('hidden');
    chartDialog.classList.add('is-card-view');
    dialogEyebrow.textContent='ОПРОС '+card.dataset.id;
    dialogTitle.textContent='План и динамика ответов';
    dialogBody.replaceChildren(clone);
    chartDialog.showModal();
  }));
  chartDialog.querySelector('.chart-dialog__head button').addEventListener('click',()=>chartDialog.close());
  chartDialog.addEventListener('click',event=>{if(event.target===chartDialog)chartDialog.close()});
}
const compareToggle=document.getElementById('compareToggle');
const compareBar=document.getElementById('compareBar');
const compareCount=document.getElementById('compareCount');
const compareOpen=document.getElementById('compareOpen');
const compareClear=document.getElementById('compareClear');
const compareDialog=document.getElementById('compareDialog');
const compareTable=document.getElementById('compareTable');
const selected=new Set();
const fmt=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0);
function syncCompare(){
  document.body.classList.toggle('compare-mode',compareToggle?.classList.contains('active'));
  compareBar.hidden=selected.size===0;
  compareCount.textContent=selected.size;
  compareOpen.disabled=selected.size<2;
  document.querySelectorAll('.compare-pick').forEach(button=>{const active=selected.has(button.closest('.event-card').dataset.id);button.setAttribute('aria-pressed',active);button.textContent=active?'✓ Выбран':'＋ Сравнить'});
}
compareToggle?.addEventListener('click',()=>{compareToggle.classList.toggle('active');syncCompare()});
document.querySelectorAll('.compare-pick').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const id=button.closest('.event-card').dataset.id;if(selected.has(id))selected.delete(id);else if(selected.size<5)selected.add(id);syncCompare()}));
compareClear?.addEventListener('click',()=>{selected.clear();syncCompare()});
compareOpen?.addEventListener('click',()=>{
  const rows=cards.filter(card=>selected.has(card.dataset.id)).map(card=>'<tr><td>#'+card.dataset.id+'</td><td>'+fmt(card.dataset.events)+'</td><td>'+fmt(card.dataset.sends)+'</td><td>'+fmt(card.dataset.responses)+'</td><td>'+Number(card.dataset.rate||0).toFixed(1).replace('.',',')+'%</td><td>'+(card.dataset.csi?Number(card.dataset.csi).toFixed(2).replace('.',','):'—')+'</td><td>'+(card.dataset.planProgress?Number(card.dataset.planProgress).toFixed(1).replace('.',',')+'%':'—')+'</td><td>'+(Number(card.dataset.change)>-999999?(Number(card.dataset.change)>=0?'↑ ':'↓ ')+Math.abs(Number(card.dataset.change)).toFixed(1).replace('.',',')+'%':'—')+'</td></tr>').join('');
  compareTable.innerHTML=rows;compareDialog.showModal();
  [...compareTable.rows].forEach(row=>{const id=row.cells[0].textContent.slice(1);if(cards.find(card=>card.dataset.id===id)?.dataset.channel==='success_screen'){row.cells[0].textContent+=' · ЭУ';row.cells[2].textContent='—';row.cells[4].textContent='—';}});
});
compareDialog?.querySelector('[data-compare-close]')?.addEventListener('click',()=>compareDialog.close());
compareDialog?.addEventListener('click',event=>{if(event.target===compareDialog)compareDialog.close()});
