const grid=document.getElementById('eventGrid');
const cards=[...grid.querySelectorAll('.event-card')];
const search=document.getElementById('eventSearch');
const sort=document.getElementById('eventSort');
const count=document.getElementById('resultCount');
const empty=document.getElementById('emptyState');
const plural=n=>{const d=n%10,h=n%100;return h>=11&&h<=14?'событий':d===1?'событие':d>=2&&d<=4?'события':'событий'};
function update(){
  const query=search.value.trim().toLowerCase();
  let visible=cards.filter(card=>!query||card.dataset.search.includes(query));
  const key=sort.value;
  visible.sort((a,b)=>key==='id'?Number(a.dataset.id)-Number(b.dataset.id):key==='change'?Number(b.dataset.change)-Number(a.dataset.change):Number(b.dataset.latest)-Number(a.dataset.latest));
  cards.forEach(card=>card.hidden=true);
  visible.forEach(card=>{card.hidden=false;grid.append(card)});
  count.textContent=visible.length+' '+plural(visible.length);
  empty.hidden=visible.length!==0;
}
search.addEventListener('input',update);sort.addEventListener('change',update);update();
