const grid=document.getElementById('eventGrid');
const cards=[...grid.querySelectorAll('.event-card')];
const search=document.getElementById('eventSearch');
const sort=document.getElementById('eventSort');
const planFilter=document.getElementById('planFilter');
const typeFilter=document.getElementById('surveyTypeFilter');
const count=document.getElementById('resultCount');
const empty=document.getElementById('emptyState');
const scopeButtons=[...document.querySelectorAll('[data-scope]')];
const channelButtons=[...document.querySelectorAll('[data-channel-filter]')];
let scope='top';
let channel='communication';
let personal=null;
const plural=n=>{const d=n%10,h=n%100;return h>=11&&h<=14?'опросов':d===1?'опрос':d>=2&&d<=4?'опроса':'опросов'};
function update(){
  const query=search.value.trim().toLowerCase();
  const scoped=cards.filter(card=>scope==='top'?card.dataset.top==='true':card.dataset.hasData==='true');
  channelButtons.forEach(button=>{button.querySelector('[data-channel-count]').textContent=scoped.filter(card=>card.dataset.channel===button.dataset.channelFilter&&(!typeFilter||typeFilter.value==='all'||card.dataset.surveyType===typeFilter.value)).length});
  let visible=scoped.filter(card=>card.dataset.channel===channel&&(!personal||personal.allows(card))&&(!query||card.dataset.search.includes(query))&&(planFilter.value==='all'||card.dataset.planStatus===planFilter.value)&&(!typeFilter||typeFilter.value==='all'||card.dataset.surveyType===typeFilter.value));
  const key=sort.value;
  visible.sort((a,b)=>key==='top'?Number(a.dataset.rank)-Number(b.dataset.rank):key==='id'?Number(a.dataset.id)-Number(b.dataset.id):key==='change'?Number(b.dataset.change)-Number(a.dataset.change):Number(b.dataset.latest)-Number(a.dataset.latest));
  cards.forEach(card=>card.hidden=true);
  visible.forEach(card=>{card.hidden=false;grid.append(card)});
  count.textContent=visible.length+' '+plural(visible.length);
  empty.hidden=visible.length!==0;
  personal?.changed();
}
scopeButtons.forEach(button=>button.addEventListener('click',()=>{scope=button.dataset.scope;scopeButtons.forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button))});update()}));
channelButtons.forEach(button=>button.addEventListener('click',()=>{channel=button.dataset.channelFilter;channelButtons.forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button))});update()}));
search.addEventListener('input',update);sort.addEventListener('change',update);planFilter.addEventListener('change',update);typeFilter?.addEventListener('change',update);update();
personal=window.createEventsWorkspace?.({cards,refresh:update,readFilters:()=>({scope,channel,query:search.value,sort:sort.value,plan:planFilter.value,type:typeFilter?.value||'all'}),applyFilters:filters=>{
  scope=filters.scope==='all'?'all':'top';channel=filters.channel==='success_screen'?'success_screen':'communication';
  search.value=typeof filters.query==='string'?filters.query:'';sort.value=['latest','top','id','change'].includes(filters.sort)?filters.sort:'latest';planFilter.value=['all','risk','ontrack'].includes(filters.plan)?filters.plan:'all';
  if(typeFilter)typeFilter.value=['all','csi','csat'].includes(filters.type)?filters.type:'all';
  scopeButtons.forEach(b=>{b.classList.toggle('active',b.dataset.scope===scope);b.setAttribute('aria-pressed',String(b.dataset.scope===scope));});
  channelButtons.forEach(b=>{b.classList.toggle('active',b.dataset.channelFilter===channel);b.setAttribute('aria-pressed',String(b.dataset.channelFilter===channel));});
}})??null;
update();
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
