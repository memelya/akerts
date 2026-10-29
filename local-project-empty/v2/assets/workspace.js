/* Personal workspace is local to this browser; reports use the current filtered list. */
window.createEventsWorkspace = function ({cards, readFilters, applyFilters, refresh}) {
  const host=document.getElementById('personalWorkspace');
  if(!host)return null;
  const key='events-personal-v2';
  let state={favorites:[],views:[],mode:'all',filters:null};
  try{const saved=JSON.parse(localStorage.getItem('empty-local-v1:'+key)||'null');if(saved&&typeof saved==='object')state={...state,...saved};}catch{}
  state.favorites=Array.isArray(state.favorites)?state.favorites.map(String):[];
  state.views=Array.isArray(state.views)?state.views.filter(v=>v&&typeof v.name==='string'&&v.filters):[];
  if(!['all','favorites','problems'].includes(state.mode))state.mode='all';
  const feedback=document.createElement('p');feedback.className='view-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');host.querySelector('.personal-views').after(feedback);
  const save=()=>{try{localStorage.setItem('empty-local-v1:'+key,JSON.stringify(state));host.querySelector('[data-storage-note]').textContent='Настройки сохранены в этом браузере';}catch{host.querySelector('[data-storage-note]').textContent='Браузер не разрешает сохранение настроек';}};
  const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=n=>Number.isFinite(n)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n):'Нет данных';
  const decimal=n=>Number(n).toFixed(2).replace('.',',');
  const favorites=new Set(state.favorites);
  cards.forEach(card=>{
    const button=document.createElement('button');button.type='button';button.className='favorite-toggle';
    const sync=()=>{const selected=favorites.has(card.dataset.id);button.textContent=selected?'★':'☆';button.setAttribute('aria-pressed',String(selected));button.setAttribute('aria-label',(selected?'Удалить из избранного опрос ':'Добавить в избранное опрос ')+card.dataset.id);};
    sync();card.querySelector('.card-actions').prepend(button);
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(favorites.has(card.dataset.id))favorites.delete(card.dataset.id);else favorites.add(card.dataset.id);state.favorites=[...favorites];sync();save();refresh();});
  });
  const renderViews=()=>{const select=host.querySelector('[data-saved-view]');select.replaceChildren(new Option('Сохранённые фильтры',''));state.views.forEach((v,i)=>select.add(new Option(v.name,String(i))));};
  renderViews();
  host.querySelectorAll('[data-personal-mode]').forEach(button=>button.addEventListener('click',()=>{state.mode=button.dataset.personalMode;save();refresh();}));
  host.querySelector('[data-save-view]').addEventListener('click',()=>{const input=host.querySelector('[data-view-name]'),name=input.value.trim();if(!name){feedback.textContent='Введите название набора фильтров, например «Мои риски».';feedback.classList.add('is-error');input.setAttribute('aria-invalid','true');input.focus();return;}input.setCustomValidity('');input.removeAttribute('aria-invalid');const view={name:name.slice(0,80),filters:readFilters(),mode:state.mode};const existing=state.views.findIndex(v=>v.name===view.name);if(existing>=0)state.views[existing]=view;else state.views.push(view);input.value='';save();renderViews();feedback.classList.remove('is-error');feedback.textContent='Набор «'+view.name+'» сохранён.';});
  host.querySelector('[data-view-name]').addEventListener('input',e=>{e.target.setCustomValidity('');e.target.removeAttribute('aria-invalid');feedback.textContent='';});
  host.querySelector('[data-saved-view]').addEventListener('change',e=>{const view=state.views[Number(e.target.value)];if(e.target.value===''||!view)return;state.mode=view.mode||'all';applyFilters(view.filters);refresh();});
  host.querySelector('[data-delete-view]').addEventListener('click',()=>{const select=host.querySelector('[data-saved-view]');if(select.value==='')return;state.views.splice(Number(select.value),1);save();renderViews();});
  const data=JSON.parse(document.getElementById('managementData').textContent);
  const dialog=document.getElementById('managementReport');let reportRows=[];
  const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  const download=(name,content,type)=>{const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  host.querySelector('[data-open-report]').addEventListener('click',()=>{
    const ids=new Set(cards.filter(c=>!c.hidden).map(c=>Number(c.dataset.id)));reportRows=data.rows.filter(r=>ids.has(r.id));
    const planned=reportRows.filter(r=>r.plan>0),answers=reportRows.reduce((n,r)=>n+r.answers,0),target=planned.reduce((n,r)=>n+r.plan,0),plannedAnswers=planned.reduce((n,r)=>n+r.answers,0);
    const projected=planned.filter(r=>Number.isFinite(r.forecast)),forecast=projected.length?projected.reduce((n,r)=>n+r.forecast,0):null,deficit=projected.length?projected.reduce((n,r)=>n+Math.max(0,r.plan-r.forecast),0):null;
    const risks=[...planned].filter(r=>Number.isFinite(r.forecast)).sort((a,b)=>Math.max(0,b.plan-b.forecast)-Math.max(0,a.plan-a.forecast)).filter(r=>r.forecast<r.plan).slice(0,3);
    dialog.querySelector('[data-report-body]').innerHTML='<h2>Отчёт для руководителя</h2><p>Период: '+safe(data.period)+' · '+reportRows.length+' опросов в текущей выборке</p><p class="report-method">Прогноз: ответы за период ÷ прошедшие рабочие дни × рабочие дни месяца. Это сценарий сохранения среднего темпа. CSI сравнивается с предыдущим полным месяцем. Плановые итоги включают только опросы с заданным планом. Прогноз не рассчитывается для неполной дневной выборки; прогнозные суммы учитывают только опросы с рассчитанным прогнозом.</p><div class="report-summary"><div>Получено ответов<b>'+fmt(answers)+'</b></div><div>Выполнение месячного плана<b>'+(target?(plannedAnswers/target*100).toFixed(1).replace('.',',')+'%':'—')+'</b></div><div>Прогноз ответов по плановым опросам<b>'+fmt(forecast)+'</b></div><div>Сумма прогнозных дефицитов<b>'+fmt(deficit)+'</b></div></div><h3>Три главных риска по прогнозному дефициту</h3>'+(risks.length?'<ul>'+risks.map(r=>'<li><b>#'+r.id+' '+safe(r.name)+'</b>: прогнозный дефицит '+fmt(r.plan-r.forecast)+' ответов. '+safe(r.action)+'</li>').join('')+'</ul>':'<p>В выбранных опросах прогнозного дефицита к плану нет.</p>')+'<div class="report-table-wrap"><table><thead><tr>'+['Опрос','Канал','Ответы','План','Выполнение','Прогноз','CSI периода','Δ CSI','Необходимое действие'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+reportRows.map(r=>'<tr><td>#'+r.id+' '+safe(r.name)+'</td><td>'+safe(r.channel)+'</td><td>'+fmt(r.answers)+'</td><td>'+(r.plan?fmt(r.plan):'—')+'</td><td>'+(r.plan?(r.answers/r.plan*100).toFixed(1).replace('.',',')+'%':'—')+'</td><td>'+fmt(r.forecast)+'</td><td>'+(r.csi===null?'—':decimal(r.csi))+'</td><td>'+(r.delta===null?'—':(Math.abs(r.delta)<0.005?'0,00':(r.delta>0?'+':'')+decimal(r.delta)))+'</td><td>'+safe(r.action)+'</td></tr>').join('')+'</tbody></table></div>'+(reportRows.length?'':'<p>Выборка пуста. Измените фильтры перед формированием отчёта.</p>');
    const datedRows=reportRows.filter(row=>row.asOf);
    if(datedRows.length){const note=document.createElement('p');note.className='report-method';note.textContent='Исключения из общего периода отчёта: '+datedRows.map(row=>'№'+row.id+' — данные по '+row.asOf.split('-').reverse().join('.')).join('; ')+'. Дневная выборка может содержать пропуски; ограничения указаны на странице опроса.';dialog.querySelector('[data-report-body] h2').after(note);}
    dialog.showModal();
  });
  dialog.querySelector('[data-report-close]').addEventListener('click',()=>dialog.close());
  dialog.querySelector('[data-report-csv]').addEventListener('click',()=>{const rows=[['Период','ID','Опрос','Канал','Ответы','План','Прогноз','CSI','Изменение CSI, баллы','Действие','Данные по'],...reportRows.map(r=>[data.period,r.id,r.name,r.channel,r.answers,r.plan??'',r.forecast,r.csi??'',r.delta??'',r.action,r.asOf??'Дата среза не указана'])];download('events-management-report.csv','\uFEFF'+rows.map(r=>r.map(csvCell).join(';')).join('\r\n'),'text/csv;charset=utf-8');});
  dialog.querySelector('[data-report-html]').addEventListener('click',()=>download('events-management-report.html','<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт Events</title><style>body{font:14px Manrope,sans-serif;margin:32px;color:#153c2b}table{border-collapse:collapse;width:100%}td,th{padding:9px;border:1px solid #ccc;text-align:left}b{display:block}.report-summary{display:flex;gap:24px}.report-table-wrap{overflow:auto}@media print{body{margin:0}}</style>'+dialog.querySelector('[data-report-body]').innerHTML+'</html>','text/html;charset=utf-8'));
  if(state.filters)applyFilters(state.filters);
  return {allows(card){return state.mode==='all'||favorites.has(card.dataset.id)&&(state.mode==='favorites'||card.dataset.planStatus==='risk'||data.issueIds.includes(Number(card.dataset.id)));},changed(){state.filters=readFilters();host.querySelectorAll('[data-personal-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.personalMode===state.mode);b.setAttribute('aria-pressed',String(b.dataset.personalMode===state.mode));});host.querySelector('[data-favorite-count]').textContent=favorites.size;save();}};
};
