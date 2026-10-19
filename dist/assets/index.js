const grid=document.getElementById('eventGrid');
const cards=[...grid.querySelectorAll('.event-card')];
const search=document.getElementById('eventSearch');
const sort=document.getElementById('eventSort');
const count=document.getElementById('resultCount');
const empty=document.getElementById('emptyState');
const scopeButtons=[...document.querySelectorAll('[data-scope]')];
let scope='top';
const plural=n=>{const d=n%10,h=n%100;return h>=11&&h<=14?'опросов':d===1?'опрос':d>=2&&d<=4?'опроса':'опросов'};
function update(){
  const query=search.value.trim().toLowerCase();
  let visible=cards.filter(card=>(scope==='top'?card.dataset.top==='true':card.dataset.hasData==='true')&&(!query||card.dataset.search.includes(query)));
  const key=sort.value;
  visible.sort((a,b)=>key==='top'?Number(a.dataset.rank)-Number(b.dataset.rank):key==='id'?Number(a.dataset.id)-Number(b.dataset.id):key==='change'?Number(b.dataset.change)-Number(a.dataset.change):Number(b.dataset.latest)-Number(a.dataset.latest));
  cards.forEach(card=>card.hidden=true);
  visible.forEach(card=>{card.hidden=false;grid.append(card)});
  count.textContent=visible.length+' '+plural(visible.length);
  empty.hidden=visible.length!==0;
}
scopeButtons.forEach(button=>button.addEventListener('click',()=>{scope=button.dataset.scope;scopeButtons.forEach(item=>item.classList.toggle('active',item===button));sort.value='latest';update()}));
search.addEventListener('input',update);sort.addEventListener('change',update);update();
const chartDialog=document.getElementById('chartDialog');
if(chartDialog){
  const dialogBody=chartDialog.querySelector('.chart-dialog__body');
  const dialogEyebrow=chartDialog.querySelector('.chart-dialog__head .eyebrow');
  const dialogTitle=chartDialog.querySelector('.chart-dialog__head strong');
  document.querySelectorAll('.chart-expand').forEach(button=>button.addEventListener('click',()=>{
    const dashboard=button.closest('.group-dashboard');
    chartDialog.classList.remove('is-card-view');
    dialogEyebrow.textContent=dashboard.querySelector('.eyebrow').textContent;
    dialogTitle.textContent='Динамика событий, отправок и ответов';
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
});
compareDialog?.querySelector('[data-compare-close]')?.addEventListener('click',()=>compareDialog.close());
compareDialog?.addEventListener('click',event=>{if(event.target===compareDialog)compareDialog.close()});
