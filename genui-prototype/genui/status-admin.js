/* Администрирование → Статусы: группы и коды status_det, алиасы, порядок, отображение в дашбордах,
   импорт/экспорт и превью легенды. Все изменения идут через REST /api/status-*; права проверяет сервер. */
(()=>{'use strict';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n;};
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),df=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const ICON={check:'✓',gear:'⚙',clock:'◷',shield:'⛨',ban:'⊘',filter:'⏷',users:'⚇',alert:'!',mail:'✉',circle:'●'};
const ROLE_NAMES={admin:'admin · полный доступ',analyst:'analyst · только просмотр',viewer:'viewer · только дашборды'};
const PRESETS=['#3f9f6b','#8a94a6','#d39b45','#e2675b','#9b7fd1','#5aa2e6','#4fb4a8','#c7798f','#6f6f6f'];
const compact=v=>!Number.isFinite(v)?'—':Math.abs(v)>=1e6?df.format(v/1e6)+' млн':Math.abs(v)>=1e4?df.format(v/1e3)+' тыс.':nf.format(v);

class ApiError extends Error{constructor(message,status,fields){super(message);this.status=status;this.fields=fields||{};}}
async function api(method,path,body){
 const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const type=response.headers.get('Content-Type')||'';const data=type.includes('json')?await response.json().catch(()=>({error:'Некорректный ответ сервера.'})):await response.text();
 if(!response.ok)throw new ApiError(data.error||'Ошибка '+response.status,response.status,data.fields);return data;
}
function button(text,handler,cls='sa-btn'){const b=el('button',cls,text);b.type='button';if(handler)b.onclick=handler;return b;}
function download(name,content,type){const blob=new Blob([content],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}

function create(host){
 const root=el('div','status-admin');host.append(root);
 const state={groups:[],codes:[],selected:null,role:'admin',settings:null,q:'',page:1,pages:1,total:0,loading:false,breakdown:null,codeDrag:null,groupDrag:null};
 const toast=el('div','sa-toast');toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');document.body.append(toast);let toastTimer=null;
 function notify(text,kind='ok'){toast.textContent=text;toast.className='sa-toast show '+kind;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.className='sa-toast',3800);}
 const canWrite=()=>state.role==='admin';
 async function guarded(task,success){try{const r=await task();if(success)notify(success);return r;}catch(error){notify(error.message,'error');throw error;}}

 /* --- загрузка --- */
 async function load(keepSelection=true){
  state.loading=true;render();
  try{const groups=await api('GET','/api/status-groups');state.groups=groups.items;state.role=groups.role;state.settings=groups.settings;
   if(!keepSelection||!state.groups.some(g=>g.id===state.selected))state.selected=state.groups[0]?.id??null;
   await loadCodes();state.error=null;}
  catch(error){state.error=error;}
  finally{state.loading=false;render();}
  loadBreakdown();
 }
 async function loadCodes(){
  const params=new URLSearchParams({page:String(state.page),page_size:'100'});if(state.q)params.set('q',state.q);else if(state.selected!=null)params.set('group_id',String(state.selected));
  const r=await api('GET','/api/status-codes?'+params);state.codes=r.items;state.total=r.total;state.pages=r.pages;state.page=r.page;
 }
 async function loadBreakdown(){try{state.breakdown=await api('GET','/api/analytics/status-breakdown?group_by=group&grain=total');}catch(error){state.breakdown={error:error.message};}renderInsights();}
 async function refreshCodes(){try{await loadCodes();}catch(error){notify(error.message,'error');}renderCodes();renderPreview();}

 /* --- каркас --- */
 const head=el('div','sa-head'),title=el('div'),roleBadge=el('span','sa-role');
 title.append(el('h2','','Статусы status_det'),el('p','sa-muted','Группы и коды статусов: как они называются, в каком порядке и с каким цветом показываются в легендах, фильтрах и воронке. Числа считает платформа по выгрузке — справочник меняет только группировку и подписи.'));
 const tools=el('div','sa-tools');head.append(title,tools);
 const layout=el('div','sa-layout'),groupsCol=el('section','sa-groups'),codesCol=el('section','sa-codes'),side=el('aside','sa-side');
 groupsCol.setAttribute('aria-label','Группы статусов');codesCol.setAttribute('aria-label','Коды выбранной группы');side.setAttribute('aria-label','Превью и данные');
 layout.append(groupsCol,codesCol,side);root.append(head,layout);

 function render(){
  tools.replaceChildren(roleBadge);roleBadge.textContent='Роль: '+(ROLE_NAMES[state.role]||state.role);roleBadge.title='Роль задаётся на компьютере с сервером: .local-data/access.json → {"statusAdmin":"admin|analyst|viewer"}';
  const exp=el('details','sa-menu'),sum=el('summary','sa-btn','Экспорт ▾'),menu=el('div','sa-menu-list');exp.append(sum,menu);
  menu.append(button('JSON — вся конфигурация',async()=>{exp.open=false;const d=await guarded(()=>api('GET','/api/status-config/export?format=json'));download('status-directory-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(d,null,1),'application/json');},'sa-menu-item'),
   button('CSV — коды для Excel',async()=>{exp.open=false;const d=await guarded(()=>api('GET','/api/status-config/export?format=csv'));download('status-directory-'+new Date().toISOString().slice(0,10)+'.csv',d,'text/csv');},'sa-menu-item'));
  tools.append(exp);
  if(canWrite())tools.append(button('Импорт…',()=>importDialog()),button('Отображение в дашбордах',()=>settingsDialog()));
  if(state.error){groupsCol.replaceChildren();codesCol.replaceChildren(el('div','sa-error','Не удалось открыть справочник: '+state.error.message),button('Повторить',()=>load()));side.replaceChildren();return;}
  if(state.loading&&!state.groups.length){groupsCol.replaceChildren(...[1,2,3,4].map(()=>el('div','sa-skeleton')));codesCol.replaceChildren(el('div','sa-skeleton tall'));return;}
  renderGroups();renderCodes();renderPreview();renderInsights();
 }

 /* --- группы --- */
 function renderGroups(){
  groupsCol.replaceChildren();const bar=el('div','sa-col-head');bar.append(el('h3','','Группы'),el('span','sa-muted',String(state.groups.length)));groupsCol.append(bar);
  const list=el('ol','sa-group-list');list.setAttribute('aria-label','Порядок групп в легенде');
  state.groups.forEach((g,i)=>{
   const li=el('li','sa-group'+(g.id===state.selected&&!state.q?' active':'')+(g.is_active?'':' off'));li.dataset.id=g.id;li.style.setProperty('--group-color',g.color);
   const pick=button('',()=>{state.selected=g.id;state.q='';state.page=1;search.value='';refreshCodes().then(renderGroups);},'sa-group-pick');pick.setAttribute('aria-current',String(g.id===state.selected));
   pick.append(el('span','sa-group-icon',ICON[g.icon]||'●'),el('span','sa-group-name',g.name),el('span','sa-count',String(g.codes_count)));
   if(g.is_system){const lock=el('span','sa-lock-icon','◆');lock.title='Системная группа: удалить нельзя, можно скрыть';lock.setAttribute('aria-label','системная');pick.append(lock);}
   const toggle=el('input');toggle.type='checkbox';toggle.className='sa-switch';toggle.checked=g.is_active;toggle.disabled=!canWrite();toggle.setAttribute('aria-label',(g.is_active?'Скрыть из дашбордов':'Показывать в дашбордах')+': '+g.name);toggle.title=g.is_active?'Показывается в дашбордах':'Скрыта из дашбордов';
   toggle.onchange=()=>guarded(()=>api('PATCH','/api/status-groups/'+g.id,{is_active:toggle.checked,expected_updated_at:g.updated_at}),toggle.checked?'Группа «'+g.name+'» показывается в дашбордах.':'Группа «'+g.name+'» скрыта из дашбордов.').then(()=>load()).catch(()=>{toggle.checked=!toggle.checked;});
   const tools=el('div','sa-group-tools');tools.append(toggle,el('small','',g.is_active?'в дашбордах':'скрыта'));li.append(pick,tools);
   if(canWrite()){
    const up=button('↑',()=>moveGroup(i,-1),'sa-icon-btn'),down=button('↓',()=>moveGroup(i,1),'sa-icon-btn');up.disabled=i===0;down.disabled=i===state.groups.length-1;up.setAttribute('aria-label','Выше: '+g.name);down.setAttribute('aria-label','Ниже: '+g.name);tools.append(up,down);
    li.draggable=true;li.addEventListener('dragstart',e=>{state.groupDrag=i;li.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','group');});
    li.addEventListener('dragend',()=>{li.classList.remove('dragging');state.groupDrag=null;});
    li.addEventListener('dragover',e=>{if(state.groupDrag!==null){e.preventDefault();li.classList.add('over');}else if(state.codeDrag){e.preventDefault();li.classList.add('drop-code');}});
    li.addEventListener('dragleave',()=>li.classList.remove('over','drop-code'));
    li.addEventListener('drop',e=>{e.preventDefault();li.classList.remove('over','drop-code');if(state.groupDrag!==null&&state.groupDrag!==i){const ids=state.groups.map(x=>x.id);const [m]=ids.splice(state.groupDrag,1);ids.splice(i,0,m);reorderGroups(ids);}else if(state.codeDrag&&state.codeDrag.group_id!==g.id){moveCode(state.codeDrag,g.id);}});
   }
   list.append(li);
  });
  groupsCol.append(list);
  if(canWrite())groupsCol.append(button('＋ Добавить группу',()=>groupDialog(),'sa-btn accent wide'));
  groupsCol.append(el('p','sa-muted small',canWrite()?'Перетащите группы, чтобы задать порядок легенды. Код можно перетащить из таблицы на группу — он перенесётся.':'Только просмотр: изменять справочник может роль admin.'));
 }
 function moveGroup(i,d){const ids=state.groups.map(g=>g.id),j=i+d;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];reorderGroups(ids);}
 async function reorderGroups(ids){const previous=state.groups;state.groups=ids.map(id=>previous.find(g=>g.id===id));renderGroups();renderPreview();try{await guarded(()=>api('PATCH','/api/status-groups/reorder',{ids}),'Порядок групп сохранён.');await load();}catch{state.groups=previous;renderGroups();}}

 /* --- коды --- */
 const search=el('input');search.type='search';search.placeholder='Найти код или описание во всех группах';search.setAttribute('aria-label','Поиск по кодам');let searchTimer=null;
 search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.q=search.value.trim();state.page=1;refreshCodes().then(renderGroups);},250);};
 function renderCodes(){
  codesCol.replaceChildren();const group=state.groups.find(g=>g.id===state.selected);
  const bar=el('div','sa-col-head');
  if(state.q)bar.append(el('h3','','Поиск: «'+state.q+'»'),el('span','sa-muted','найдено '+state.total));
  else if(group){const name=el('h3');const dot=el('span','sa-dot');dot.style.background=group.color;name.append(dot,document.createTextNode(group.name));bar.append(name,el('span','sa-muted',group.codes_count+' код(ов) · '+({delivered:'успешная отправка',loss:'отсечение в воронке',neutral:'вне воронки'})[group.funnel_role]+' · '+({sum:'сумма',share:'доля от событий',avg:'среднее в день'})[group.aggregation]));
   if(canWrite()){const edit=button('Изменить группу',()=>groupDialog(group),'sa-btn'),del=button('Удалить',()=>deleteGroup(group),'sa-btn danger');if(group.is_system){del.disabled=true;del.title='Системную группу удалить нельзя — её можно скрыть переключателем.';}bar.append(edit,del);}}
  codesCol.append(bar,search);
  if(group?.description&&!state.q)codesCol.append(el('p','sa-muted',group.description));
  if(!state.codes.length){const empty=el('div','sa-empty');empty.append(el('b','',state.q?'Ничего не найдено':'В группе пока нет кодов'),el('p','',state.q?'Проверьте номер кода или слово из описания.':'Добавьте код или перетащите его сюда из другой группы.'));if(canWrite()&&!state.q)empty.append(button('＋ Добавить код',()=>codeDialog(null,group?.id),'sa-btn accent'));codesCol.append(empty);return;}
  const wrap=el('div','sa-table-wrap'),table=el('table','sa-table'),thead=el('tr');
  for(const h of ['','Код','Описание','Алиас на графиках',...(state.q?['Группа']:[]),'Порядок','Активен','Действия'])thead.append(el('th','',h));table.append(thead);
  state.codes.forEach((c,i)=>{
   const tr=el('tr',c.is_active?'':'off');tr.dataset.code=c.code;
   const grip=el('td','sa-grip',canWrite()&&!state.q?'⠿':'');
   const owner=state.groups.find(g=>g.id===c.group_id);
   const order=el('td','sa-order');if(canWrite()&&!state.q){const up=button('↑',()=>moveCodeOrder(i,-1),'sa-icon-btn'),down=button('↓',()=>moveCodeOrder(i,1),'sa-icon-btn');up.disabled=!i;down.disabled=i===state.codes.length-1;up.setAttribute('aria-label','Выше: код '+c.code);down.setAttribute('aria-label','Ниже: код '+c.code);order.append(up,down);}else order.textContent=String(c.sort_order);
   const active=el('td'),sw=el('input');sw.type='checkbox';sw.className='sa-switch';sw.checked=c.is_active;sw.disabled=!canWrite();sw.setAttribute('aria-label','Активен код '+c.code);sw.onchange=()=>guarded(()=>api('PATCH','/api/status-codes/'+c.id,{is_active:sw.checked,expected_updated_at:c.updated_at}),'Код '+c.code+(sw.checked?' включён.':' выключен — в дашбордах он посчитается в «Без группы».')).then(()=>load()).catch(()=>{sw.checked=!sw.checked;});active.append(sw);
   const actions=el('td','sa-actions');
   if(canWrite()){const edit=button('✎',()=>codeDialog(c),'sa-icon-btn'),move=button('⇄',()=>moveDialog(c),'sa-icon-btn'),del=button('🗑',()=>deleteCode(c),'sa-icon-btn danger');edit.setAttribute('aria-label','Изменить код '+c.code);move.setAttribute('aria-label','Перенести код '+c.code+' в другую группу');del.setAttribute('aria-label','Удалить код '+c.code);edit.title='Изменить';move.title='Перенести в другую группу';if(c.is_system){del.disabled=true;del.title='Системный код удалить нельзя — выключите или перенесите.';}else del.title='Удалить';actions.append(edit,move,del);}
   const codeCell=el('td','sa-code');codeCell.append(el('code','',String(c.code)));if(c.is_system)codeCell.append(el('span','sa-lock','сист.'));
   tr.append(grip,codeCell,el('td','sa-desc',c.description),el('td','',c.alias||'—'),...(state.q?[el('td','',owner?.name||'—')]:[]),order,active,actions);
   if(canWrite()){tr.draggable=true;tr.addEventListener('dragstart',e=>{state.codeDrag=c;state.codeDragIndex=i;tr.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','code');});tr.addEventListener('dragend',()=>{tr.classList.remove('dragging');state.codeDrag=null;});
    if(!state.q){tr.addEventListener('dragover',e=>{if(state.codeDrag&&state.codeDrag.group_id===c.group_id){e.preventDefault();tr.classList.add('over');}});tr.addEventListener('dragleave',()=>tr.classList.remove('over'));tr.addEventListener('drop',e=>{e.preventDefault();tr.classList.remove('over');if(state.codeDrag&&state.codeDragIndex!==i&&state.codeDrag.group_id===c.group_id){const ids=state.codes.map(x=>x.id);const [m]=ids.splice(state.codeDragIndex,1);ids.splice(i,0,m);reorderCodes(ids);}});}}
   table.append(tr);
  });
  wrap.append(table);codesCol.append(wrap);
  if(state.pages>1){const pager=el('div','sa-pager');const prev=button('← Назад',()=>{state.page--;refreshCodes();}),next=button('Дальше →',()=>{state.page++;refreshCodes();});prev.disabled=state.page<=1;next.disabled=state.page>=state.pages;pager.append(prev,el('span','sa-muted','Страница '+state.page+' из '+state.pages),next);codesCol.append(pager);}
  if(canWrite()&&!state.q)codesCol.append(button('＋ Добавить код',()=>codeDialog(null,group?.id),'sa-btn accent'));
 }
 function moveCodeOrder(i,d){const ids=state.codes.map(c=>c.id),j=i+d;[ids[i],ids[j]]=[ids[j],ids[i]];reorderCodes(ids);}
 async function reorderCodes(ids){const previous=state.codes;state.codes=ids.map(id=>previous.find(c=>c.id===id));renderCodes();try{await guarded(()=>api('PATCH','/api/status-codes/reorder',{group_id:state.selected,ids}),'Порядок кодов сохранён.');await refreshCodes();renderPreview();}catch{state.codes=previous;renderCodes();}}
 async function moveCode(code,groupId){const target=state.groups.find(g=>g.id===groupId);try{await guarded(()=>api('PATCH','/api/status-codes/'+code.id+'/move',{group_id:groupId}),'Код '+code.code+' перенесён в «'+target.name+'».');await load();}catch{}}
 async function deleteCode(c){if(!confirm('Удалить код '+c.code+' «'+c.description+'»? Если он встретится в выгрузке, то посчитается в «Без группы».'))return;try{await guarded(()=>api('DELETE','/api/status-codes/'+c.id),'Код '+c.code+' удалён.');await load();}catch{}}

 /* --- превью и данные --- */
 function renderPreview(){
  side.querySelector('.sa-preview')?.remove();
  const card=el('section','sa-card sa-preview');card.append(el('h3','','Превью легенды'),el('p','sa-muted small','Так группы выглядят в дашбордах: порядок, цвет, название. Нажмите на группу — раскроются её коды (drill-down).'));
  const legend=el('div','sa-legend');
  for(const g of state.groups.filter(g=>g.is_active&&!(g.slug==='ungrouped'&&state.settings?.unassigned_mode==='hide'))){const item=el('details','sa-legend-item');item.style.setProperty('--group-color',g.color);if(g.id===state.selected)item.open=true;const s=el('summary');s.append(el('i'),el('span','sa-group-icon',ICON[g.icon]||'●'),document.createTextNode(g.name),el('small','',' · '+g.codes_count));item.append(s);
   item.addEventListener('toggle',async()=>{if(!item.open||item.dataset.loaded)return;item.dataset.loaded='1';try{const r=await api('GET','/api/status-codes?group_id='+g.id+'&page_size=500');const ul=el('ul');for(const c of r.items.filter(c=>c.is_active))ul.append(el('li','',(c.alias||c.description)+' · '+c.code));if(!ul.childElementCount)ul.append(el('li','','Активных кодов нет'));item.append(ul);}catch(error){item.append(el('p','sa-error',error.message));}});
   if(item.open)item.dispatchEvent(new Event('toggle'));legend.append(item);}
  if(!legend.childElementCount)legend.append(el('p','sa-muted','Все группы скрыты — легенда будет пустой.'));
  card.append(legend);side.prepend(card);
 }
 function renderInsights(){
  side.querySelector('.sa-insights')?.remove();const card=el('section','sa-card sa-insights');side.append(card);
  card.append(el('h3','','На ваших данных'));const b=state.breakdown;
  if(!b){card.append(el('div','sa-skeleton'));return;}
  if(b.error){card.append(el('p','sa-muted small','Разбивка по группам появится после загрузки выгрузки пуш+СМС с дневными строками. '+b.error));return;}
  card.append(el('p','sa-muted small','Доля событий по группам за '+(b.date_from||'')+' — '+(b.date_to||'')+' · опросов: '+b.surveys));
  const total=b.eventsTotal[0]||0,list=el('ul','sa-bars');
  for(const s of b.series){const p=s.points[0]||{},li=el('li'),bar=el('i');bar.style.width=Math.max(1,p.share||0)+'%';bar.style.background=s.color;li.append(el('span','',s.label),el('b','',df.format(p.share||0)+'%'),el('small','',compact(p.events)),bar);list.append(li);}
  card.append(list);
  if(b.unknown?.length){const warn=el('div','sa-unknown');warn.append(el('b','','Коды в выгрузке, которых нет в справочнике'),el('p','sa-muted small','Сейчас они считаются в «Без группы». Добавьте описание и группу.'));
   for(const u of b.unknown.slice(0,8)){const row=el('div','sa-unknown-row');row.append(el('code','',String(u.code)),el('span','',compact(u.events)+' событий'));if(canWrite())row.append(button('Добавить',()=>codeDialog(null,state.groups.find(g=>g.slug==='ungrouped')?.id,{code:u.code}),'sa-btn small'));warn.append(row);}
   card.append(warn);}
  const audit=el('details','sa-audit');audit.append(el('summary','','Журнал изменений'));audit.addEventListener('toggle',async()=>{if(!audit.open||audit.dataset.loaded)return;audit.dataset.loaded='1';try{const r=await api('GET','/api/status-audit?limit=30');const ul=el('ul');for(const a of r.items)ul.append(el('li','',new Date(a.at).toLocaleString('ru-RU')+' · '+a.role+' · '+({'group-create':'создана группа','group-update':'изменена группа','group-delete':'удалена группа','group-reorder':'порядок групп','code-create':'добавлен код','code-update':'изменён код','code-move':'перенесён код','code-delete':'удалён код','code-reorder':'порядок кодов',settings:'настройки отображения',import:'импорт'})[a.action]+' · '+a.target));if(!r.items.length)ul.append(el('li','','Изменений пока не было'));audit.append(ul);}catch(error){audit.append(el('p','sa-error',error.message));}});
  card.append(audit);
 }

 /* --- формы --- */
 function dialogShell(titleText){const d=el('dialog','sa-dialog');d.setAttribute('aria-label',titleText);const form=el('form');form.method='dialog';form.noValidate=true;form.append(el('h3','',titleText));d.append(form);document.body.append(d);d.addEventListener('close',()=>d.remove(),{once:true});return {d,form};}
 function field(form,label,input,hint){const wrap=el('label','sa-field');wrap.append(el('span','',label),input);const err=el('small','sa-field-error');err.setAttribute('role','alert');wrap.append(err);if(hint)wrap.append(el('small','sa-hint',hint));form.append(wrap);input.errorBox=err;return input;}
 function input(type,value,attrs={}){const i=el(type==='textarea'?'textarea':type==='select'?'select':'input');if(type!=='textarea'&&type!=='select')i.type=type;if(value!==undefined&&value!==null&&type!=='select')i.value=value;for(const [k,v] of Object.entries(attrs))i.setAttribute(k,v);return i;}
 function showErrors(fields,map,general){for(const i of Object.values(map)){i.errorBox.textContent='';i.removeAttribute('aria-invalid');}for(const [k,v] of Object.entries(fields||{}))if(map[k]){map[k].errorBox.textContent=v;map[k].setAttribute('aria-invalid','true');}general.textContent=Object.keys(fields||{}).some(k=>map[k])?'':general.dataset.message||'';}
 function actions(form,okText,run,d){const line=el('p','sa-error');line.setAttribute('role','alert');const row=el('div','sa-dialog-actions'),ok=el('button','sa-btn accent',okText),cancel=button('Отмена',()=>d.close());ok.type='submit';row.append(cancel,ok);form.append(line,row);form.onsubmit=async e=>{e.preventDefault();ok.disabled=true;line.textContent='';try{await run(line);}catch(error){line.dataset.message=error.message;line.textContent=error.message;run.onError?.(error);}finally{ok.disabled=false;}};return line;}
 function groupDialog(group){
  const {d,form}=dialogShell(group?'Группа «'+group.name+'»':'Новая группа статусов'),opt=state.settings.options;
  const name=field(form,'Название *',input('text',group?.name,{maxlength:'120',required:'',autocomplete:'off'}));
  const slug=field(form,'Идентификатор',input('text',group?.slug,{maxlength:'48',pattern:'[a-z0-9][a-z0-9-]+',placeholder:'создастся из названия'}),group?.is_system?'Системная группа: идентификатор не меняется.':'Латиница, цифры и дефис. Нужен для импорта и ссылок.');if(group?.is_system)slug.disabled=true;
  const description=field(form,'Описание',input('textarea',group?.description,{maxlength:'600',rows:'2'}));
  const colorRow=el('div','sa-colors'),color=input('color',group?.color||PRESETS[state.groups.length%PRESETS.length]);for(const c of PRESETS){const b=button('',()=>{color.value=c;},'sa-swatch');b.style.background=c;b.setAttribute('aria-label','Цвет '+c);colorRow.append(b);}colorRow.append(color);field(form,'Цвет',colorRow);color.errorBox=colorRow.parentElement.querySelector('.sa-field-error');
  const icon=field(form,'Иконка',input('select'));for(const k of opt.icons)icon.add(new Option((ICON[k]||'')+' '+k,k));icon.value=group?.icon||'circle';
  const role=field(form,'Роль в воронке',input('select'),'«Отсечение» — отдельный шаг воронки между событиями и отправками.');for(const [k,v] of Object.entries(opt.funnel_role))role.add(new Option(v,k));role.value=group?.funnel_role||'loss';
  const agg=field(form,'Агрегация на графиках',input('select'));for(const [k,v] of Object.entries(opt.aggregation))agg.add(new Option(v,k));agg.value=group?.aggregation||state.settings.default_aggregation||'sum';
  const activeLabel=el('label','sa-check'),active=input('checkbox');active.checked=group?group.is_active:true;activeLabel.append(active,document.createTextNode(' Показывать в дашбордах'));form.append(activeLabel);
  const map={name,slug,description,color,icon,funnel_role:role,aggregation:agg};
  const run=async line=>{
   if(!name.value.trim()){showErrors({name:'Обязательное поле'},map,line);name.focus();return;}
   if(slug.value&&!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug.value)){showErrors({slug:'Латиница, цифры и дефис, 2–48 символов'},map,line);return;}
   const body={name:name.value,description:description.value,color:color.value,icon:icon.value,funnel_role:role.value,aggregation:agg.value,is_active:active.checked};if(slug.value&&!group?.is_system)body.slug=slug.value;
   try{if(group){body.expected_updated_at=group.updated_at;await api('PATCH','/api/status-groups/'+group.id,body);notify('Группа «'+body.name+'» сохранена.');}else{const g=await api('POST','/api/status-groups',body);state.selected=g.id;notify('Группа «'+g.name+'» создана.');}d.close();load();}
   catch(error){showErrors(error.fields,map,line);throw error;}
  };
  actions(form,group?'Сохранить':'Создать группу',run,d);d.showModal();name.focus();
 }
 function codeDialog(code,groupId,preset={}){
  const {d,form}=dialogShell(code?'Код '+code.code:'Новый код статуса');
  const value=field(form,'Код status_det *',input('text',code?.code??preset.code??'',{inputmode:'numeric',maxlength:'9',autocomplete:'off',placeholder:'например, 1025 или -1'}),code?.is_system?'Системный код из выгрузки: номер не меняется.':'Целое число, допускаются отрицательные (-1).');if(code?.is_system)value.disabled=true;
  const description=field(form,'Описание *',input('textarea',code?.description,{maxlength:'600',rows:'3'}));
  const alias=field(form,'Алиас на графиках',input('text',code?.alias,{maxlength:'80',placeholder:'коротко, например «Стоп-лист»'}),'Если пусто — на графиках будет описание.');
  const group=field(form,'Группа *',input('select'));for(const g of state.groups)group.add(new Option(g.name,String(g.id)));group.value=String(code?.group_id??groupId??state.groups[0]?.id);
  const activeLabel=el('label','sa-check'),active=input('checkbox');active.checked=code?code.is_active:true;activeLabel.append(active,document.createTextNode(' Активен (участвует в легенде и фильтрах)'));form.append(activeLabel);
  const map={code:value,description,alias,group_id:group};
  const run=async line=>{
   const raw=value.value.trim().replace('−','-'),errors={};if(!/^-?\d{1,8}$/.test(raw))errors.code='Целое число, например 1002 или -1';if(!description.value.trim())errors.description='Обязательное поле';
   if(Object.keys(errors).length){showErrors(errors,map,line);return;}
   const body={description:description.value,alias:alias.value||null,group_id:Number(group.value),is_active:active.checked};if(!code?.is_system)body.code=Number(raw);
   try{if(code){body.expected_updated_at=code.updated_at;await api('PATCH','/api/status-codes/'+code.id,body);notify('Код '+(body.code??code.code)+' сохранён.');}else{await api('POST','/api/status-codes',body);state.selected=body.group_id;notify('Код '+body.code+' добавлен.');}d.close();state.q='';search.value='';load();loadBreakdown();}
   catch(error){showErrors(error.fields,map,line);throw error;}
  };
  actions(form,code?'Сохранить':'Добавить код',run,d);d.showModal();(code?.is_system?description:value).focus();
 }
 function moveDialog(code){
  const {d,form}=dialogShell('Перенести код '+code.code);form.append(el('p','sa-muted',code.description));
  const target=field(form,'В группу',input('select'));for(const g of state.groups)if(g.id!==code.group_id)target.add(new Option(g.name,String(g.id)));
  const note=el('p','sa-muted small');const describe=()=>{const g=state.groups.find(x=>x.id===Number(target.value));note.textContent=g?'В дашбордах и воронке код будет считаться в «'+g.name+'»'+(g.is_active?'':' (группа скрыта — код уйдёт в «Без группы»)')+'.':'';};target.onchange=describe;describe();form.append(note);
  actions(form,'Перенести',async()=>{await api('PATCH','/api/status-codes/'+code.id+'/move',{group_id:Number(target.value)});notify('Код '+code.code+' перенесён.');d.close();load();},d);d.showModal();target.focus();
 }
 function deleteGroup(group){
  const {d,form}=dialogShell('Удалить группу «'+group.name+'»');form.append(el('p','',group.codes_count?'В группе '+group.codes_count+' код(ов). Куда их перенести?':'Группа пустая.'));
  const target=field(form,'Перенести коды в',input('select'));for(const g of state.groups)if(g.id!==group.id)target.add(new Option(g.name,String(g.id)));target.value=String(state.groups.find(g=>g.slug==='ungrouped')?.id);
  actions(form,'Удалить группу',async()=>{const r=await api('DELETE','/api/status-groups/'+group.id,{move_to:Number(target.value)});notify('Группа удалена'+(r.moved?', перенесено кодов: '+r.moved:'')+'.');state.selected=Number(target.value);d.close();load();},d);d.showModal();
 }
 function settingsDialog(){
  const {d,form}=dialogShell('Отображение в дашбордах'),opt=state.settings.options;
  const mode=field(form,'Коды без группы',input('select'),'Выключенные коды и группы в расчётах тоже уходят в «Без группы», чтобы сумма сходилась с событиями.');for(const [k,v] of Object.entries(opt.unassigned_mode))mode.add(new Option(v,k));mode.value=state.settings.unassigned_mode;
  const agg=field(form,'Агрегация по умолчанию для новых групп',input('select'));for(const [k,v] of Object.entries(opt.aggregation))agg.add(new Option(v,k));agg.value=state.settings.default_aggregation;
  const drillLabel=el('label','sa-check'),drill=input('checkbox');drill.checked=state.settings.drill_down;drillLabel.append(drill,document.createTextNode(' Drill-down: по клику на группу показывать её коды'));form.append(drillLabel);
  actions(form,'Сохранить',async()=>{await api('PATCH','/api/status-settings',{unassigned_mode:mode.value,default_aggregation:agg.value,drill_down:drill.checked});notify('Настройки отображения сохранены.');d.close();load();},d);d.showModal();
 }
 function importDialog(){
  const {d,form}=dialogShell('Импорт справочника статусов');
  form.append(el('p','sa-muted small','JSON — файл экспорта этой админки. CSV — столбцы code;description;group;alias;is_active (разделитель «;» или «,»). Сначала покажем план изменений; ничего не удаляется.'));
  const file=field(form,'Файл',input('file',undefined,{accept:'.json,.csv,application/json,text/csv'}));
  const mode=field(form,'Режим',input('select'),'«Заменить» дополнительно выключит коды, которых нет в файле.');mode.add(new Option('Добавить и обновить','merge'));mode.add(new Option('Заменить (выключить отсутствующие)','replace'));
  const plan=el('div','sa-plan');form.append(plan);let payload=null,checked=false;
  const ok=actions(form,'Проверить файл',async line=>{
   if(!payload){const f=file.files[0];if(!f){line.textContent='Выберите файл.';return;}const content=await f.text();payload={format:/\.json$/i.test(f.name)||content.trim().startsWith('{')?'json':'csv',content};}
   const r=await api('POST','/api/status-config/import',{...payload,mode:mode.value,dry_run:!checked});
   const p=r.plan;plan.replaceChildren(el('b','',checked?'Импорт выполнен':'План изменений'));const ul=el('ul');for(const [k,label] of [['groups_create','Новых групп'],['groups_update','Обновить групп'],['codes_create','Новых кодов'],['codes_update','Изменить кодов'],['codes_move','Перенести кодов'],['codes_disable','Выключить кодов']])if(p[k].length)ul.append(el('li','',label+': '+p[k].length+(k.startsWith('codes')?' ('+p[k].slice(0,12).join(', ')+(p[k].length>12?'…':'')+')':' ('+p[k].slice(0,5).join(', ')+')')));if(!ul.childElementCount)ul.append(el('li','','Изменений нет — справочник уже совпадает с файлом.'));plan.append(ul);
   if(p.errors.length){const e=el('ul','sa-error');for(const x of p.errors.slice(0,10))e.append(el('li','',x));plan.append(el('b','','Ошибки — исправьте файл:'),e);return;}
   if(checked){notify('Импорт выполнен: изменений '+r.changes+'.');d.close();load();loadBreakdown();return;}
   if(r.changes){checked=true;form.querySelector('.sa-dialog-actions .accent').textContent='Применить импорт';}
  },d);
  file.onchange=mode.onchange=()=>{payload=null;checked=false;plan.replaceChildren();form.querySelector('.sa-dialog-actions .accent').textContent='Проверить файл';};
  d.showModal();
 }
 return {show(){load();},root};
}
window.StatusAdmin={create};
})();
