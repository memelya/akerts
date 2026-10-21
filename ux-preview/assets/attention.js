const items=[...document.querySelectorAll('.attention-item')];
const fields={plan:document.getElementById('rulePlan'),csi:document.getElementById('ruleCsi'),rate:document.getElementById('ruleRate'),sample:document.getElementById('ruleSample')};
let saved={};try{saved=JSON.parse(localStorage.getItem('events-alert-rules')||'{}')||{}}catch{}
const defaults={plan:90,csi:0.2,rate:15,sample:30};
Object.entries(fields).forEach(([key,input])=>{input.required=true;if(key==='csi')input.max='4';if(key==='rate')input.max='100';input.value=saved[key]??defaults[key];if(!input.checkValidity()||!Number.isFinite(Number(input.value)))input.value=defaults[key];});
const feedback=document.getElementById('rulesSaved');feedback.setAttribute('role','status');
function apply(){
  const invalid=Object.values(fields).find(input=>!input.checkValidity()||!Number.isFinite(Number(input.value)));
  if(invalid){feedback.textContent='Проверьте пороги: план 1–100%, падение CSI 0–4, отклик 0–100%, выборка — целое число от 1.';feedback.classList.add('is-error');invalid.setAttribute('aria-invalid','true');invalid.focus();return;}
  Object.values(fields).forEach(input=>input.removeAttribute('aria-invalid'));feedback.classList.remove('is-error');
  const rules=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,Number(input.value)]));
  try{localStorage.setItem('events-alert-rules',JSON.stringify(rules))}catch{}
  let visible=0;
  items.forEach(item=>{const type=item.dataset.type;const show=type==='Нет данных'||(type==='Дефицит к плану'&&Number(item.dataset.plan)<rules.plan)||(type==='Падение CSI'&&Number(item.dataset.csiDrop)>rules.csi)||(type==='Снижение отклика'&&Number(item.dataset.rateDrop)>rules.rate)||(type==='Сокращение событий')||(type==='Маленькая выборка'&&Number(item.dataset.sample)<rules.sample);item.hidden=!show;if(show)visible++});
  document.getElementById('attentionCount').textContent=visible;feedback.textContent='Правила сохранены · показано '+visible+' сигналов';
}
document.getElementById('applyRules').addEventListener('click',apply);apply();
document.getElementById('exportAlerts').addEventListener('click',()=>{const rows=[['Приоритет','Тип','Опрос','Описание']];items.filter(item=>!item.hidden).forEach(item=>rows.push([item.querySelector('.attention-rank').textContent,item.dataset.type,item.querySelector('h3').textContent,item.querySelector('p').textContent]));const csv='\uFEFF'+rows.map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(';')).join('\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='critical-alerts-2026-10.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000)});
