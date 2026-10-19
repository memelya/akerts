const items=[...document.querySelectorAll('.attention-item')];
const fields={plan:document.getElementById('rulePlan'),csi:document.getElementById('ruleCsi'),rate:document.getElementById('ruleRate'),sample:document.getElementById('ruleSample')};
const saved=JSON.parse(localStorage.getItem('events-alert-rules')||'{}');
Object.entries(fields).forEach(([key,input])=>{if(saved[key]!==undefined)input.value=saved[key]});
function apply(){
  const rules=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,Number(input.value)]));
  localStorage.setItem('events-alert-rules',JSON.stringify(rules));let visible=0;
  items.forEach(item=>{const type=item.dataset.type;const show=type==='Нет данных'||(type==='Дефицит к плану'&&Number(item.dataset.plan)<rules.plan)||(type==='Падение CSI'&&Number(item.dataset.csiDrop)>rules.csi)||(type==='Снижение отклика'&&Number(item.dataset.rateDrop)>rules.rate)||(type==='Сокращение событий')||(type==='Маленькая выборка'&&Number(item.dataset.sample)<rules.sample);item.hidden=!show;if(show)visible++});
  document.getElementById('attentionCount').textContent=visible;document.getElementById('rulesSaved').textContent='Правила сохранены · показано '+visible+' сигналов';
}
document.getElementById('applyRules').addEventListener('click',apply);apply();
document.getElementById('exportAlerts').addEventListener('click',()=>{const rows=[['Приоритет','Тип','Опрос','Описание']];items.filter(item=>!item.hidden).forEach(item=>rows.push([item.querySelector('.attention-rank').textContent,item.dataset.type,item.querySelector('h3').textContent,item.querySelector('p').textContent]));const csv='\uFEFF'+rows.map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(';')).join('\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='critical-alerts-2026-10.csv';link.click();URL.revokeObjectURL(link.href)});
