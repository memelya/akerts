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
    dialogEyebrow.textContent=dashboard.querySelector('.eyebrow').textContent;
    dialogTitle.textContent='Динамика событий, отправок и ответов';
    dialogBody.replaceChildren(dashboard.querySelector('.group-dashboard__charts').cloneNode(true));
    chartDialog.showModal();
  }));
  chartDialog.querySelector('.chart-dialog__head button').addEventListener('click',()=>chartDialog.close());
  chartDialog.addEventListener('click',event=>{if(event.target===chartDialog)chartDialog.close()});
}
