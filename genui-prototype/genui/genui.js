(()=>{
const $=id=>document.getElementById(id),form=$('queryForm'),input=$('query'),source=$('source'),provider=$('provider'),feed=$('conversation');
const clone=value=>JSON.parse(JSON.stringify(value));
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const fmt=(value,metric)=>value===null?'Нет данных':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:metric==='csi'||metric==='responseRate'?2:0}).format(value)+(metric==='responseRate'?'%':'');
const surveyLabel=id=>id===null?'Все выбранные опросы':'#'+id;
const month=value=>new Intl.DateTimeFormat('ru-RU',{day:value.length===10?'numeric':undefined,month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value+(value.length===7?'-01':'')+'T12:00:00Z'));
const palette=['#ff8a35','#c3c8d0','#8da9c4','#d5b278','#b59cbd','#79aa95','#c4837a','#9b9fa8','#b1ba8d','#8cadd0','#c7a397','#8db8b3','#cfb57d','#ad96b8','#94a1ac','#b2aa92'];
let turns=[],activeTurn=null,busy=false,serial=0,creativeBaseOverride=null,dialogueActive=true,dataStatus=null;
const focusUI=window.FocusWorkspace.create({main:$('main'),feed,composer:$('composer'),onSelect:number=>{if(busy)return;const turn=turns.find(t=>t.number===number);if(turn){setContext(turn,true);focusUI.show(turn,turns);}},onNew:()=>{setContext(null,false);focusUI.chat();input.focus({preventScroll:true});focusUI.notice('Новый график · предыдущий останется в истории');},onUndo:turn=>{if(busy||!turn?.versions?.length)return;const before=clone(turn.data),saved=turn.versions.pop();turn.data=saved.data;turn.revision=saved.revision;turn.step=(turn.step||1)+1;turn.deltaTitle='Возвращён предыдущий шаг';turn.delta=window.FocusWorkspace.delta(before,turn.data);renderTurn(turn);setContext(turn,true);focusUI.show(turn,turns);}});
const favoritesKey='genui-favorites-v1';
let favorites=[];try{favorites=JSON.parse(localStorage.getItem(favoritesKey)||'[]');if(!Array.isArray(favorites))favorites=[];}catch{}
const favoritesPage=node('section','conversation');favoritesPage.hidden=true;$('main').append(favoritesPage);
const favoriteNav=node('a','nav-item','Избранное');favoriteNav.href='#favorites';document.querySelector('.rail').insertBefore(favoriteNav,document.querySelector('.history'));
function saveFavorites(){try{localStorage.setItem(favoritesKey,JSON.stringify(favorites));return true;}catch{alert('Не удалось сохранить избранное: хранилище браузера недоступно или заполнено.');return false;}}
function showFavorites(){destroyCharts(favoritesPage);favoritesPage.replaceChildren(node('h1','','Избранное'),node('p','','Сохранённые снимки графиков. Хранятся в этом браузере на текущем адресе и сохраняются после F5.'));
 if(!favorites.length)favoritesPage.append(node('p','','Выберите «В избранное» под нужными графиками в диалоге.'));
 for(const item of favorites){const host=node('article','chat-message answer');favoritesPage.append(host);renderTurn({...clone(item),element:host,favorite:true});}
}
const adminPage=$('administration'),logPage=$('adminLog'),adminNav=node('a','nav-item','Администрирование');
adminNav.href='#admin';
const statusAdmin=window.StatusAdmin.create($('adminStatuses'));
const adminTabs={'#admin-statuses':$('adminStatuses'),'#admin-data':$('adminData'),'#admin-connection':$('adminConnection'),'#admin-log':logPage,'#admin-diagnostics':$('adminDiagnostics')};
const adminAliases={'#statuses':'#admin-statuses','#admin':'#admin-data','#agent-log':'#admin-log','#diagnostics':'#admin-diagnostics'};
const trustUI=window.TrustUI.create({main:$('main'),diagnostics:$('adminDiagnostics'),onChange:()=>refreshStatus()});
const creativeNav=node('button','nav-item','Библиотека визуализаций');creativeNav.type='button';creativeNav.onclick=()=>!busy&&window.CreativeUI.library((data,refinement)=>{openSavedChart(data,data.query||data.bundle.title);if(refinement){creativeBaseOverride=data.savedId||data.jobId;$('creativeMode').checked=true;$('creativeMode').onchange();focusUI.chat();input.value=refinement;input.focus({preventScroll:true});}});document.querySelector('.rail').insertBefore(creativeNav,document.querySelector('.history'));
const workflowsUI=window.WorkflowsUI.create({main:$('main'),getTurns:()=>turns.filter(t=>!['ai-workspace','generated-ui','local-ranking','calculated-dashboard'].includes(t.data.kind)),onOpen:openSavedChart});
const committeeUI=window.CommitteeUI.create($('main'));
const feedbackUI=window.FeedbackOverview.create($('main'));
const overviewUI=window.SurveySections.create({main:$('main')});
const meetingUI=window.MeetingPage.create({main:$('main')});
const presentationUI=window.PresentationPages.create({main:$('main')});
const digestUI=window.DigestUI.create($('main'));
const pulseUI=window.PulseUI.create($('main'));
const clientBaseUI=window.ClientBase.create({main:$('main')});
for(const [label,hash] of [['\u0420\u0430\u0431\u043e\u0447\u0438\u0435 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0438','#scenarios'],['\u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c \u0437\u0430\u043f\u0443\u0441\u043a\u043e\u0432','#calendar']]){const link=node('a','nav-item',label);link.href=hash;document.querySelector('.rail').insertBefore(link,document.querySelector('.history'));const shortcut=node('a','',label);shortcut.href=hash;document.querySelector('.data-actions').append(shortcut);}
for(const [label,hash] of [['Качество данных','#trust'],['Словарь показателей','#metrics']]){const link=node('a','nav-item',label);link.href=hash;document.querySelector('.rail').insertBefore(link,document.querySelector('.history'));const shortcut=node('a','',label);shortcut.href=hash;document.querySelector('.data-actions').append(shortcut);}
document.querySelector('.rail').insertBefore(adminNav,document.querySelector('.history'));
let logRequest=0;
async function showAgentLog(){
 const ticket=++logRequest;
 logPage.replaceChildren(node('h2','','Лог GigaCode'),node('p','','Последние 200 записей вызовов и этапов запроса. Ответ CLI и готовность результата показываются отдельно. История хранится локально.'));
 const refresh=node('button','suggestion','Обновить лог');refresh.onclick=showAgentLog;logPage.append(refresh);
 try{const response=await fetch('/api/genui/log');if(!response.ok)throw new Error('Не удалось загрузить лог');const rows=await response.json();if(ticket!==logRequest)return;
 if(!rows.length)logPage.append(node('p','','Обращений пока нет. Выберите GigaCode и отправьте запрос в диалоге.'));
 for(const entry of rows.slice().reverse()){
 const stages={'chart-conversation':'Диалог с графиком · модель','chart-conversation-validation':'Проверка объяснения и параметров графика','creative-plan':'Выбор данных моделью','creative-plan-repair':'Исправление параметров моделью','creative-plan-validation':'Проверка параметров платформой','creative-data':'Подготовка полного набора','creative-plan-confirmation':'Подтверждение состава расчёта','creative-code':'Генерация кода моделью','creative-generation':'Ожидание кода от модели','creative-generation-retry':'Повтор генерации по подтверждённым данным','creative-target-plan':'Дневной план из запроса · локальный разбор','creative-calculated-view':'Стандартный просмотр расчёта','creative-metadata-repair':'Исправление пояснений · код сохранён','creative-code-validation':'Проверка кода и ссылок','creative-preview':'Проверка предпросмотра','creative-apply':'Применение пользователем'};
 const pipeline=entry.mode==='pipeline',outcome=entry.status==='waiting'?'Ожидает решения':entry.status==='clarification'?'Нужно уточнение':entry.status==='cancelled'?'Остановлено':entry.status==='ok'?(pipeline?'Этап пройден':entry.mode==='local-rule'?'Разобрано правилами':'Ответ CLI получен · параметры проверяются отдельно'):(pipeline?'Этап не пройден':'Ошибка CLI');
 const card=node('article','chat-message answer');card.append(node('div','message-label',new Date(entry.time).toLocaleString('ru-RU')+' · '+entry.durationMs+' мс · '+(pipeline?'Платформа':entry.mode==='local-rule'?'Встроенный обработчик':'GigaCode CLI')+' · '+(stages[entry.stage]||entry.stage||'план графика')+' · '+outcome));
 card.append(node('h3','','Пользователь'),node('p','message-text',entry.query));
 card.append(node('h3','','Ответ агента'));const reply=node('pre','',entry.response||entry.error||entry.detail||(entry.mode==='local-rule'?'Запрос разобран встроенным обработчиком, CLI не вызывалась.':''));reply.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';card.append(reply);
 for(const [label,value] of [['Привязка явных условий запроса',entry.parameterBindings],['Проверенные параметры этапа',entry.details],['Параметры графика',entry.spec],['Контекст предыдущего графика',entry.previous],['Полный запрос к агенту',entry.prompt]])if(value){const details=node('details','');details.append(node('summary','',label));const pre=node('pre','',typeof value==='string'?value:JSON.stringify(value,null,2));pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';details.append(pre);card.append(details);}
 if(entry.error&&entry.response)card.append(node('p','message-text',entry.error));logPage.append(card);
 }
 }catch(error){if(ticket===logRequest)logPage.append(node('p','error',error.message));}
}
function showPage(){
 const hash=location.hash||'#pulse',adminKey=adminAliases[hash]||hash,adminPanel=adminTabs[adminKey];
 const category=hash.match(/^#surveys-(top|communication|success_screen)$/)?.[1];
 const pages={
  '#pulse':[pulseUI.page,pulseUI.show],
  '#feedback':[feedbackUI.page,feedbackUI.show],
  '#favorites':[favoritesPage,showFavorites],
  '#scenarios':[workflowsUI.scenarios,workflowsUI.showScenarios],
  '#calendar':[workflowsUI.calendar,workflowsUI.showCalendar],
  '#trust':[trustUI.page,trustUI.show],
  '#metrics':[trustUI.metrics,trustUI.showMetrics],
  '#morning-monitor':[committeeUI.page,committeeUI.show],
  '#client-base-2026':[clientBaseUI.page,clientBaseUI.show],
  '#presentation-pages':[presentationUI.page,presentationUI.show],
  '#digest':[digestUI.page,digestUI.show],
  '#meeting-20261105':[meetingUI.page,meetingUI.show]
 };
 const [page,show]=adminPanel?[adminPage,()=>showAdmin(adminKey)]:category?[overviewUI.page,()=>overviewUI.show(category)]:pages[hash]||[];
 dialogueActive=!page;
 document.body.classList.toggle('focus-browse',Boolean(page));
 document.body.classList.toggle('has-survey-overview',Boolean(category||['#pulse','#feedback','#morning-monitor','#client-base-2026','#presentation-pages','#meeting-20261105'].includes(hash)));
 if(hash!=='#meeting-20261105')meetingUI.stop();
 if(!category)overviewUI.stop();
 for(const child of $('main').children)child.hidden=page?child!==page:child===focusUI.root?!document.body.classList.contains('focus-active'):Object.values(pages).some(([section])=>section===child)||child===adminPage||child===overviewUI.page;
 for(const link of document.querySelectorAll('.rail a.nav-item')){
  const href=link.getAttribute('href');
  const active=href==='#dialog'?dialogueActive:href==='#admin'?Boolean(adminPanel):href===hash;
  link.classList.toggle('active',active);
  if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
 }
 {const activeLink=[...document.querySelectorAll('.rail .nav-item.active')].find(link=>!link.classList.contains('nav-more-summary'));$('sectionName').textContent=adminPanel?'Администрирование':category&&activeLink?activeLink.textContent.trim():page&&activeLink?activeLink.textContent.trim():'Диалог с данными';}
 if(show)show();else{updateDialogueStatus();refreshStatus();syncContext();}
}
function showAdmin(key){
 window.scrollTo(0,0);
 for(const [hash,panel] of Object.entries(adminTabs))panel.hidden=hash!==key;
 for(const link of adminPage.querySelectorAll('.admin-nav a')){
  if(link.getAttribute('href')===key)link.setAttribute('aria-current','page');
  else link.removeAttribute('aria-current');
 }
 if(key==='#admin-statuses')statusAdmin.show();
 else if(key==='#admin-log')showAgentLog();
 else if(key==='#admin-diagnostics')trustUI.showDiagnostics();
 else refreshStatus();
}
function openSavedChart(data,query,parentTurn=null){
 if(busy)return;location.hash='#dialog';focusUI.start();$('intro').hidden=$('examples').hidden=true;document.body.classList.add('chat-started');
 const element=node('article','chat-message answer');feed.append(element);const turn={number:++serial,query,messages:data.scenarioQueries||[query],data:clone(data),source:'local',element,step:1,parentTurn,delta:['\u041e\u0442\u043a\u0440\u044b\u0442 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0439 \u0440\u0430\u0441\u0447\u0451\u0442.']};turns.push(turn);renderTurn(turn);setContext(turn,true);updateHistory();focusUI.show(turn,turns);
}

window.addEventListener('hashchange',showPage);
document.querySelector('.skip').onclick=event=>{event.preventDefault();$('main').focus();};
async function exportPng(data){if(!data.returnCanvas&&!data.pngSize)return window.ChartAppearance.openPNG((size,options)=>exportPng({...data,pngSize:size,pngOptions:options,meetingTitle:options.title,returnCanvas:true}),{name:data.exportFilename||'genui-chart.png',title:data.meetingTitle||'GEN UI · '+data.periodLabel});data=window.ChartAppearance.filterData(data);const appearance=data.appearance||{},mode=appearance.valueMode||'both';data.blocks=data.blocks.map(b=>({...b,absoluteValues:[...b.values],values:mode==='percent'&&b.metric!=='csi'?(b.ratio||b.sendRatio)?.values||b.values.map(()=>null):b.values}));const target=data.pngSize||{width:2880,height:1620},scale=Math.min(target.width/1600,target.height/900);
 const canvas=document.createElement('canvas');canvas.width=Math.ceil(1600*scale);canvas.height=Math.ceil(900*scale);const c=canvas.getContext('2d');c.scale(scale,scale);c.fillStyle='#181818';c.fillRect(0,0,1600,900);c.fillStyle='#f0f0f0';const heading=data.pngOptions?.title??((data.meetingTitle||'GEN UI')+' · '+data.periodLabel);let headingSize=28;c.font='bold '+headingSize+'px sans-serif';while(c.measureText(heading).width>1460&&headingSize>16){headingSize-=2;c.font='bold '+headingSize+'px sans-serif';}c.fillText(heading,70,50);c.font='18px sans-serif';
 const colors=data.visual?.theme==='presentation'?['#ffad66','#7eb8cc','#d3c6a5','#b0a5d7','#84b5a0','#e4a7a0']:palette;const blocks=data.blocks,left=90,right=1490,top=Math.max(220,130+Math.ceil(data.blocks.length/3)*25),bottom=780;
 blocks.forEach((b,i)=>{c.fillStyle=appearance.colors?.[b.metric+':'+b.id]||appearance.colors?.[b.metric]||data.chartColors?.[b.metric]||colors[i%colors.length];c.fillText(b.label+' · '+surveyLabel(b.id),70+(i%3)*500,90+Math.floor(i/3)*25);});
 const quantities=blocks.filter(b=>b.metric!=='csi').flatMap(b=>b.values).filter(v=>v!==null),max=Math.max(1,...quantities),onlyCsi=blocks.every(b=>b.metric==='csi');
 c.strokeStyle='#313131';c.fillStyle='#b5b5b5';for(let i=0;i<=5;i++){let y=bottom-(bottom-top)*i/5;c.fillText(onlyCsi?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(1+4*i/5):mode==='percent'?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(max*i/5)+'%':window.ChartAppearance.formatNumber(max*i/5,appearance),5,y);}
 if(!onlyCsi&&blocks.some(b=>b.metric==='csi'))for(let i=1;i<=5;i++)c.fillText('CSI '+i,right+12,bottom-(bottom-top)*(i-1)/4);
 const x=i=>left+(right-left)*i/Math.max(1,data.months.length-1);const exportLabels=[];
 blocks.forEach((b,j)=>{c.strokeStyle=appearance.colors?.[b.metric+':'+b.id]||appearance.colors?.[b.metric]||data.chartColors?.[b.metric]||colors[j%colors.length];c.setLineDash(data.chartColors&&b.metric==='answers'?[8,5]:[]);c.fillStyle=c.strokeStyle;c.lineWidth=3;c.beginPath();let open=false;b.values.forEach((v,i)=>{if(v===null){open=false;return;}const y=bottom-(bottom-top)*(b.metric==='csi'?(v-1)/4:v/max);if(data.visual?.type==='bars'&&b.metric!=='csi'){const bw=Math.min(40,(right-left)/Math.max(1,data.months.length)/Math.max(1,blocks.length));c.fillRect(x(i)+(j-(blocks.length-1)/2)*bw-bw/2,y,bw*.85,bottom-y);open=false;return;}});if(data.visual?.type!=='bars'||b.metric==='csi')window.ChartAppearance.stroke(c,b.values.map((v,i)=>v===null?null:[x(i),bottom-(bottom-top)*(b.metric==='csi'?(v-1)/4:v/max)]));b.values.forEach((v,i)=>{if(v===null)return;const y=bottom-(bottom-top)*(b.metric==='csi'?(v-1)/4:v/max);c.beginPath();c.arc(x(i),y,4,0,Math.PI*2);c.fill();{const r=(b.ratio||b.sendRatio)?.values[i],text=window.ChartAppearance.valueLabel(b.absoluteValues[i],r,b.metric+':'+b.id,appearance,b.metric==='csi'?'csi':'count');c.font='12px sans-serif';const tw=c.measureText(text).width,bx=Math.max(left,Math.min(right-tw,x(i)-tw/2));for(const shift of [-12,24,-30,42]){const by=y+shift,box={x:bx,y:by-12,w:tw,h:16};if(by<top+14||by>bottom-8||exportLabels.some(a=>box.x<a.x+a.w+6&&box.x+box.w+6>a.x&&box.y<a.y+a.h+4&&box.y+box.h+4>a.y))continue;if(text)c.fillText(text,bx,by);exportLabels.push(box);break;}}});});
 c.setLineDash([]);c.fillStyle='#b5b5b5';c.font='16px sans-serif';if(data.pngOptions?.showXAxis!==false)data.months.forEach((m,i)=>{if(i%Math.max(1,Math.ceil(data.months.length/12))===0){c.save();c.translate(x(i),bottom+25);c.rotate(-0.35);c.fillText(data.periods?.[i]?.short||m,0,0);c.restore();}});if(data.pngOptions?.showFootnotes!==false&&data.cutoffCoverage?.some(r=>r.status==='some_observed'))c.fillText('Отсечения — суммы найденных строк части опросов. Отсутствующие статусы не приравнены к нулю.',70,826);if(data.pngOptions?.showFootnotes!==false&&data.meetingPercentages)c.fillText('Проценты: ответы / отправки; отправки и отсечения / события. События — сумма всех статусов.',70,854);if(data.pngOptions?.showFootnotes!==false)c.fillText('Источник: '+data.source+' · Пропуски не заменяются нулями',70,880);
 if(data.returnCanvas)return window.ChartAppearance.fit(canvas,target.width,target.height);
 canvas.toBlob(blob=>{if(!blob){alert('Не удалось создать PNG');return;}const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=data.exportFilename||'genui-chart.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
}

const scrollTo=element=>element.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
function destroyCharts(parent){parent.querySelectorAll('.v2-chart').forEach(chart=>chart.destroy?.());parent.querySelectorAll('[data-creative-host]').forEach(host=>host._creativeDispose?.());}
function setContext(turn,update=false){activeTurn=turn;if(turn?.data.kind==='generated-ui'){$('creativeMode').checked=true;$('creativeMode').onchange();}$('updateExisting').checked=update&&turn?.data.kind!=='calculated-dashboard';syncContext();}
function syncContext(){
 $('contextBar').hidden=!activeTurn||activeTurn.data.kind==='calculated-dashboard';
 $('contextLabel').textContent=activeTurn?.data.kind==='calculated-dashboard'?'Дашборд · '+activeTurn.data.dataset.title:activeTurn?.data.kind==='generated-ui'?'Новый интерфейс №'+activeTurn.number+' · '+activeTurn.data.bundle.title:activeTurn?'График №'+activeTurn.number+' · '+(activeTurn.data.spec.ids.length?'опросы '+activeTurn.data.spec.ids.join(', '):'Все опросы'):'';
 input.placeholder=activeTurn?.data.kind==='calculated-dashboard'?'Задайте новый вопрос или откройте исходный график':activeTurn?.data.kind==='generated-ui'?'Опишите, как изменить интерфейс':activeTurn?'Продолжите: «Добавь ответы» или задайте новый вопрос':'Покажи опрос 193 за 3 месяца';
 $('submitLabel').textContent=$('updateExisting').checked&&activeTurn?(activeTurn.data.kind==='generated-ui'?'Обновить интерфейс':'Обновить график'):'Отправить';
}
function addMessage(kind,text){const message=focusUI.message(kind,text||'');if(kind!=='user'&&provider.value==='gigacode')message.querySelector('.message-label').textContent='GigaCode';return message;}
function updateHistory(){
 $('history').replaceChildren();for(const turn of [...turns].reverse()){const button=node('button','',window.FocusWorkspace.label(turn));button.type='button';button.onclick=()=>{if(busy)return;setContext(turn,true);focusUI.show(turn,turns);};$('history').append(button);}
 if(!turns.length)$('history').append(node('p','muted','Результаты появятся здесь'));
}
function updateView(turn,change,description){
 if(busy)return;
 const saved=clone(turn.data),position=focusUI.stage.scrollTop;
 change();
 if(!turn.favorite&&!turn.drilldown){turn.versions=turn.versions||[];turn.versions.push({data:saved,revision:turn.revision});turn.versions=turn.versions.slice(-8);turn.step=(turn.step||1)+1;turn.delta=[description,'Данные, период и фильтры сохранены.'];turn.deltaTitle='Изменение визуализации';}
 renderTurn(turn);
 if(!turn.favorite&&!turn.drilldown){focusUI.show(turn,turns,false);focusUI.stage.scrollTop=position;}
}
function downloadCsv(rows,name){const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(quote).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'})),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function download(data){
 const weekly=data.spec.grain==='week';
 downloadCsv([['Опрос','Период','Показатель','Значение','Процент к отправкам','Отправки периода',...(weekly?['Полнота']:[])],
  ...data.table.map(r=>[r.id,r.month,r.metric,r.value,r.sendRatio,r.ratioBase,...(weekly?[coverageText(r.coverage)]:[])])],'genui-monitoring.csv');
}
function coverageText(coverage){
 if(!coverage)return 'Полнота не сохранена';
 const {observedDays,expectedDays,metricDays}=coverage;
 if(!observedDays)return 'Нет наблюдений';
 return observedDays+' из '+expectedDays+' дн. с данными'+(Number.isInteger(metricDays)?' · по показателю '+metricDays+' из '+expectedDays+' дн.':'');
}
async function exportVisualPng(host,data,size,options){
 const svgs=[...host.querySelectorAll('.charts svg')].filter(s=>s.closest('.chat-message')===host&&!s.closest('[hidden]')&&s.getBoundingClientRect().width>0);if(!svgs.length)return exportPng({...data,...(size?{pngSize:size,pngOptions:options,meetingTitle:options?.title,returnCanvas:true}:{})});if(!size)return window.ChartAppearance.openPNG((target,opts)=>exportVisualPng(host,data,target,opts),{name:data.exportFilename||'genui-chart.png',title:'GEN UI · '+data.periodLabel,width:3200,height:Math.min(12000,(140+svgs.length*650)*2)});
 const canvas=document.createElement('canvas');const logicalHeight=140+svgs.length*650,factor=Math.min(size.width/1600,size.height/logicalHeight);canvas.width=Math.ceil(1600*factor);canvas.height=Math.ceil(logicalHeight*factor);const c=canvas.getContext('2d');c.scale(factor,factor);c.fillStyle='#181818';c.fillRect(0,0,canvas.width,canvas.height);c.fillStyle='#f0f0f0';c.font='bold 26px sans-serif';c.fillText(options?.title??('GEN UI · '+data.periodLabel),48,48);
 for(let i=0;i<svgs.length;i++){const original=svgs[i],copy=original.cloneNode(true),sources=[original,...original.querySelectorAll('*')],targets=[copy,...copy.querySelectorAll('*')];sources.forEach((element,j)=>{const style=getComputedStyle(element);for(const key of ['fill','stroke','stroke-width','opacity','font-family','font-size','font-weight','paint-order'])targets[j].style.setProperty(key,style.getPropertyValue(key));});copy.setAttribute('xmlns','http://www.w3.org/2000/svg');if(options?.showXAxis===false)copy.querySelectorAll('[data-axis-tick]').forEach(n=>n.remove());const box=original.viewBox.baseVal;const rasterScale=Math.min(1500/box.width,450/box.height)*factor;copy.setAttribute('width',Math.ceil(box.width*rasterScale));copy.setAttribute('height',Math.ceil(box.height*rasterScale));const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml;charset=utf-8'}));try{const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});const card=original.closest('.v2-chart')||original.parentElement.parentElement;c.fillStyle='#f0f0f0';c.font='bold 20px sans-serif';if(svgs.length>1)c.fillText(card.querySelector('h3').textContent,48,100+i*650);c.font='14px sans-serif';const labels=[...card.querySelectorAll('.v2-chart-series b')].map(n=>n.textContent);labels.forEach((label,j)=>c.fillText(label,48,130+i*650+j*22));const scale=Math.min(1500/box.width,450/box.height);c.drawImage(img,48,180+i*650,box.width*scale,box.height*scale);}finally{URL.revokeObjectURL(url);}}
 if(options?.showFootnotes!==false){c.font='14px sans-serif';c.fillStyle='#b5b5b5';c.fillText('Источник: '+data.source+' · '+data.periodLabel,48,logicalHeight-24);}return window.ChartAppearance.fit(canvas,size.width,size.height);
}
function renderTurn(turn){
 const data=turn.data,host=turn.element;const visual=data.visual||{type:'line',theme:'default'};const colors=visual.theme==='presentation'?['#ffad66','#7eb8cc','#d3c6a5','#b0a5d7','#84b5a0','#e4a7a0']:palette;destroyCharts(host);host.replaceChildren();host.id='answer-'+turn.number;host.dataset.turnId=turn.number;
 if(data.kind==='calculated-dashboard'){
  host.classList.remove('creative-result');
  const actions=node('div','creative-actions'),status=node('p','creative-status');status.setAttribute('role','status');
  const save=node('button','quiet',data.savedId?'Сохранён в библиотеке':'Сохранить дашборд');save.type='button';save.disabled=Boolean(data.savedId);
  save.onclick=async()=>{save.disabled=true;status.textContent='Сохраняю…';try{
   const result=await window.TrustUI.post('/api/creative',{action:'save-dashboard',jobId:data.jobId});
   data.savedId=result.id;save.textContent='Сохранён в библиотеке';status.textContent='Дашборд можно открыть в библиотеке после перезапуска.';
  }catch(error){status.textContent=error.message;save.disabled=false;}};
  actions.append(save);
  if(turn.parentTurn){const back=node('button','quiet','Вернуться к исходному графику');back.type='button';back.onclick=()=>{setContext(turn.parentTurn,true);focusUI.show(turn.parentTurn,turns);};actions.append(back);}
  host.append(actions,status);window.CalculatedView.render(host,data);return;
 }
 if(data.kind==='generated-ui'){
  host.classList.add('creative-result');window.CreativeUI.render(host,data,{notice:text=>focusUI.notice(text),onRefine:base=>{if(busy)return;creativeBaseOverride=base.savedId||base.jobId;$('creativeMode').checked=true;$('creativeMode').onchange();setContext(turn,true);focusUI.chat();input.placeholder='Что изменить в новой визуализации?';input.focus({preventScroll:true});},onDetail:async key=>{if(busy)return;try{const metric=Object.keys(data.dataset.labels).find(m=>['sends','answers','csi','events','stop','contactPolicy'].includes(m))||'answers',chart=await window.TrustUI.post('/api/ai',{action:'chart',jobId:data.jobId,keys:[key],metrics:[metric]});openSavedChart(chart,'Детализация '+key);}catch(e){focusUI.notice(e.message);}}});return;
 }
 host.classList.remove('creative-result');
 if(data.kind==='ai-workspace'){
  window.AgentUI.render(host,data,{onChart:openSavedChart,onRerun:criteria=>send(turn.revision||turn.query,{turn,update:true,source:'local',provider:'gigacode',criteria}),renderChart:(element,chartData)=>renderTurn({number:turn.number+'-ai-'+Math.random().toString(36).slice(2,7),data:chartData,element,drilldown:true,source:'local'})});
  if(!data.stale)window.CommitteeUI.attachPacks(host,{jobId:data.jobId},{model:true});return;
 }
 if(data.kind==='local-ranking'){
  const {winners,limit,eligible}=data.ranking;
  const title='Топ '+limit+' опросов · '+data.label;
  const channelLabel=row=>row.channel==='communication'?'Пуш + СМС':'Экран успеха';
  host.append(node('h2','answer-title',title),node('p','source-receipt',data.periodLabel+' · опросов с данными: '+eligible+' · версия '+data.dataRevision));
  if(winners.length){
   const entry=()=>({chart:{status:'ok',kind:'ranking',title,data}});
   const actions=node('div','assistant-heading'),csv=node('button','quiet','CSV ↓'),png=node('button','quiet','PNG ↓');
   csv.type=png.type='button';
   csv.onclick=()=>downloadCsv([['Место','ID опроса','Опрос','Канал',data.label,'Период','Версия данных'],
    ...winners.map((row,i)=>[i+1,row.id,row.name,channelLabel(row),row.value,data.periodLabel,data.dataRevision])],'genui-ranking.csv');
   png.onclick=()=>window.PresentationPages.exportChartPng(entry(),{name:'genui-ranking.png'});
   actions.append(csv,window.PresentationPages.button('dialog-ranking:'+turn.number,entry,title),png);
   host.append(actions);
  }
  const wrap=node('div','table-wrap'),table=node('table'),head=node('thead'),headRow=node('tr'),body=node('tbody');
  for(const text of ['Место','Опрос','Канал',data.label]){const cell=node('th','',text);cell.scope='col';headRow.append(cell);}
  head.append(headRow);
  for(const [index,row] of winners.entries()){
   const line=node('tr');
   for(const value of [index+1,'#'+row.id+' · '+row.name,channelLabel(row),fmt(row.value,data.ranking.metric)])line.append(node('td','',value));
   body.append(line);
  }
  table.append(head,body);wrap.append(table);
  host.append(winners.length?wrap:node('p','','За выбранный период нет значений для рейтинга.'));
  return;
 }
 const header=node('div','assistant-heading');header.append(node('span','message-label',(data.contract?.planner==='rules'?'GEN UI · проверенные правила':data.provider==='gigacode'?'GigaCode':'GEN UI · локальный разбор')+' · график №'+turn.number));
 const downloadButton=node('button','quiet','CSV ↓');downloadButton.type='button';downloadButton.onclick=()=>download(data);header.append(downloadButton);
 const presentationButton=window.PresentationPages.button('dialog:'+String(turn.savedId||turn.number),()=>({presentationTitle:(data.spec.ids.length===1?'Опрос '+data.spec.ids[0]:data.spec.ids.length>1?'Сравнение опросов':'Все выбранные опросы')+' · '+[...new Set(data.blocks.map(b=>b.label))].join(', '),chart:{status:'ok',kind:'monthly',title:turn.query||data.blocks[0].name,id:data.spec.ids.length===1?data.spec.ids[0]:null,channel:data.spec.filters?.channel,data:clone(data)},visibleKeys:[...host.querySelectorAll('input[data-period-series]:checked')].map(e=>e.dataset.periodSeries)}),'Диалог · '+(turn.query||data.blocks[0].name),{ids:data.spec.ids,channel:data.spec.filters?.channel});header.append(presentationButton);
 const png=node('button','quiet','PNG ↓');png.type='button';png.onclick=()=>exportVisualPng(host,data).catch(()=>alert('Не удалось сохранить PNG. Повторите попытку.'));header.append(png);
 const star=node('button','quiet',turn.favorite?'Удалить из избранного':'В избранное');star.type='button';star.onclick=async()=>{
 const old=clone(favorites);
 if(turn.favorite){favorites=favorites.filter(f=>f.savedId!==turn.savedId);if(!saveFavorites())favorites=old;showFavorites();}
 else{favorites.push({savedId:Date.now()+'-'+Math.random(),number:turn.number,query:turn.query,data:clone(data),source:turn.source});if(saveFavorites()){star.textContent='Сохранено ✓';star.disabled=true;if(data.analysisId){try{await window.TrustUI.post('/api/genui/evidence',{action:'retain',analysisId:data.analysisId});}catch{star.title='Сверка будет пересчитана по сохранённой версии данных.';}}}else favorites=old;}
 };if(!turn.drilldown)header.append(star);if(!turn.favorite&&!turn.drilldown)workflowsUI.saveButton(turn,header);host.append(header);
 const title=data.spec.ids.length>1?'Сравнение опросов '+data.spec.ids.join(' и '):data.blocks[0].name;
 host.append(node('h2','answer-title',title),node('p','interpretation',(data.spec.ids.length?'Опросы: '+data.spec.ids.join(', '):'Все загруженные опросы')+' · '+[...new Set(data.blocks.map(b=>b.label))].join(', ')+' · '+data.periodLabel));
 host.append(node('p','source-receipt',data.source+' · период '+data.periodLabel+' · последние загруженные наблюдения: '+(data.anchor||'нет наблюдений')+'.'));
 if(data.contract)host.append(node('p','query-contract','Запрос понят: '+data.contract.interpretation+' · расчёт: '+data.contract.resolvedPeriod+' · версия данных: '+(data.contract.dataRevision||'архивная база')));
 if(turn.revision)host.append(node('p','revision-note','Обновлено по сообщению: «'+turn.revision+'»'));
 const ratioText=value=>Number.isFinite(value)&&Math.abs(value-100)>1e-9?' ('+new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value)+'%)':'';
 const kpis=node('div','kpis');for(const total of data.totals){const card=node('article','kpi'),amount=node('div','kpi-amount');amount.append(node('strong','',fmt(total.value,total.metric)));
 const sample=total.proofs?.at(-1)?.denominator;
 if(total.metric==='csi'&&Number.isFinite(total.value)&&Number.isFinite(sample))amount.append(node('span','metric-ratio','n='+fmt(sample,'count')));if(Number.isFinite(total.sendRatio?.total)){const share=node('span','metric-ratio',ratioText(total.sendRatio.total));share.title=(total.sendRatio.baseMetric==='sends'?'Отклик · отправки за тот же период: ':'Доля от событий · события за тот же период: ')+fmt(total.sendRatio.totalBase,'count');amount.append(share);}card.append(node('span','',total.label+' · '+surveyLabel(total.id)),amount,node('small','',total.note));kpis.append(card);}host.append(kpis);
 let explorer=null,investigation=null,passport=null;
 const charts=node('div','charts'),tableWrap=node('div','table-wrap');tableWrap.hidden=true;
 const periodLabels=new Map((data.periods||[]).map(period=>[period.start,period.short]));
 const weekly=data.spec.grain==='week';
 const periodName=key=>periodLabels.get(key)||month(key);
 const controls=node('div','view-controls'),buttons=node('div');
 const chartButton=node('button','','Графики'),tableButton=node('button','','Таблица'),combineButton=node('button','','На одном графике');
 for(const button of [chartButton,tableButton,combineButton])button.type='button';
 chartButton.dataset.action='charts';tableButton.dataset.action='table';combineButton.dataset.action='combine';
 chartButton.setAttribute('aria-pressed','true');tableButton.setAttribute('aria-pressed','false');combineButton.setAttribute('aria-pressed',String(data.spec.layout==='combined'));
 const funnelButton=node('button','','Воронка');funnelButton.type='button';funnelButton.dataset.action='funnel';funnelButton.setAttribute('aria-pressed','false');funnelButton.title='События → политика контактов → стоп-листы → отправки → ответы → отклик';let funnel=null;
 const pressOnly=active=>{for(const b of [chartButton,tableButton,funnelButton])b.setAttribute('aria-pressed',String(b===active));if(active!==funnelButton)funnel?.hide();};
 chartButton.onclick=()=>{charts.hidden=false;tableWrap.hidden=true;pressOnly(chartButton);};
 tableButton.onclick=()=>{charts.hidden=true;tableWrap.hidden=false;pressOnly(tableButton);};
 funnelButton.onclick=()=>{if(!funnel)funnel=window.GenuiFunnel?.attach(funnelHost,data);if(!funnel)return;charts.hidden=true;tableWrap.hidden=true;pressOnly(funnelButton);funnel.show();};
 combineButton.onclick=()=>{updateView(turn,()=>{data.spec.layout=data.spec.layout==='combined'?'separate':'combined';},data.spec.layout==='combined'?'Показатели разнесены по панелям.':'Показатели объединены на одном графике.');if(activeTurn===turn)syncContext();};
 const funnelHost=node('div','funnel-host');const funnelReady=!data.spec.metrics?.includes('unique_surveys')&&data.blocks.some(b=>['events','sends','answers','stop','contactPolicy'].includes(b.metric))&&window.GenuiFunnel?.paramsOf(data);buttons.append(chartButton,tableButton,...(funnelReady?[funnelButton]:[]),combineButton);controls.append(buttons);host.append(controls,charts,funnelHost);
 const combined=data.spec.layout==='combined',amounts=data.blocks.filter(b=>b.metric!=='responseRate'),rates=data.blocks.filter(b=>b.metric==='responseRate');
 const groups=(combined?[amounts,rates]:data.spec.metrics.map(metric=>data.blocks.filter(b=>b.metric===metric))).filter(blocks=>blocks.length);
 const setVisual=(change,text)=>updateView(turn,()=>{if(!data.originalLayout)data.originalLayout=data.spec.layout;data.visual={...visual};change();},text);
 const views=turn.drilldown?[]:[
  {key:'line',icon:'⟋',label:'Линии',hint:'Линии по периодам — исходный вид.',pressed:(visual.type||'line')==='line',run:()=>setVisual(()=>{data.visual.type='line';},'Линии.')},
  {key:'bars',icon:'▮▮',label:'Столбцы',hint:'Столбцы удобнее сопоставлять по периодам; CSI остаётся линией.',pressed:visual.type==='bars',run:()=>setVisual(()=>{data.visual.type='bars';},'Сравнить столбцами.')},
  {key:'area',icon:'◢',label:'Заливка',hint:'Заливка подчеркнёт динамику первого количественного показателя.',pressed:visual.type==='area',run:()=>setVisual(()=>{data.visual.type='area';},'Подчеркнуть динамику.')},
  ...(data.blocks.length>1?[{key:'panels',icon:'☰',label:combined?'Раздельно':'Вместе',hint:combined?'Каждый показатель — отдельный график со своей шкалой.':'Все показатели на одном графике.',pressed:false,run:()=>setVisual(()=>{data.spec.layout=combined?'separate':'combined';},combined?'Показатели разнесены по панелям.':'Показатели объединены на одном графике.')}]:[]),
  {key:'presentation',icon:'◐',label:'Палитра для слайда',hint:'Контрастные цвета для проектора и презентации. Нажмите ещё раз, чтобы вернуть обычные.',pressed:visual.theme==='presentation',run:()=>setVisual(()=>{data.visual.theme=visual.theme==='presentation'?'default':'presentation';},'Палитра для презентации.')}];
 for(const blocks of groups){const key=b=>b.metric+':'+b.id,rows=data.months.map((m,i)=>({key:m,label:periodName(m),...(weekly?{missing:!data.periods?.[i]?.observedDays,_coverage:Object.fromEntries(blocks.map(b=>[key(b),coverageText(b.weeklyCoverage?.[i])]))}:{}),short:periodLabels.get(m)||(m.length===10?m.slice(8)+'.'+m.slice(5,7):month(m)),...Object.fromEntries(blocks.map(b=>[key(b),b.values[i]])),_sendRatios:Object.fromEntries(blocks.map(b=>[key(b),b.sendRatio?.values[i]??null]))}));
 data.appearance||={valueMode:'both',colors:{},excludedDates:[]};window.V2Chart(charts,{views,onTableToPresentation:turn.drilldown?null:opener=>window.PresentationPages.openAdd('dialog:'+String(turn.savedId||turn.number),opener,{valueTable:true}),keepMissingPeriods:weekly,seriesCoverage:weekly,appearance:data.appearance,onPoint:(row,key)=>passport?.open(row.key,key),onSelect:r=>{explorer?.select(r.key);investigation?.select(r.key);passport?.select(r.key);},chartType:visual.type,title:[...new Set(blocks.map(b=>b.label))].join(' · '),badge:combined&&new Set(blocks.map(b=>b.metric)).size>1?'Совмещённый график':'Динамика',context:data.periodLabel,help:'Линии можно отключать в легенде. Последний период может быть неполным.'+(blocks.some(b=>b.sendRatio)?' Проценты по воронке: события = 100%, отправки и отсечения — доля от событий, ответы — отклик от отправок.':''),modes:[{key:'month',label:({day:'По дням',week:'По неделям'})[data.spec.grain]||'По месяцам',rows}],series:blocks.map((b,i)=>({key:key(b),label:b.label+' · '+(b.id===null?'Все выбранные опросы':'#'+b.id+' · '+b.name),color:colors[i%colors.length],dash:b.metric==='csi'?'6 4':b.metric==='answers'?'3 3':null,total:b.values.at(-1),lastRatio:b.sendRatio?.values.at(-1)})),receipt:[['Источник',data.source],['Расчёт',(data.methods||['Количество суммируется по записям месяца. CSI не суммируется.']).join(' ')],['Полнота',data.warnings.join(' ')]]});}
 const table=node('table'),thead=node('thead'),tr=node('tr');for(const h of ['Опрос','Период','Показатель','Значение',...(weekly?['Полнота']:[])]){const th=node('th','',h);th.scope='col';tr.append(th);}thead.append(tr);table.append(thead);const tbody=node('tbody');for(const row of data.table){const tr=node('tr');for(const value of [surveyLabel(row.id),periodName(row.month),row.metric,fmt(row.value,row.metricKey||(row.metric==='CSI'?'csi':'count'))+ratioText(row.sendRatio),...(weekly?[coverageText(row.coverage)]:[])])tr.append(node('td','',value));tbody.append(tr);}table.append(tbody);tableWrap.append(table);host.append(tableWrap);
 const method=node('details','method');method.append(node('summary','','Источники и полнота данных'));for(const warning of [...(data.methods||[]),...data.warnings])method.append(node('p','',warning));method.append(node('p','','Ответ фиксирует данные на момент запроса. Новый запрос перечитывает CSV. Пропуски не заменяются нулями.'));host.append(method);
 passport=window.MetricPassports.attach(host,()=>({chart:{data}}));
 if(data.analysisId)window.TrustUI.attachEvidence(host,data);if(!turn.favorite&&!turn.drilldown)investigation=turn.investigator=workflowsUI.attachInvestigation(turn,host);
 if(!turn.favorite&&(data.provider==='gigacode'||weekly)&&data.analysisId)window.CommitteeUI.attachPacks(host,{analysisId:data.analysisId},{model:data.provider==='gigacode'});
 if(data.members){const members=node('details','method');members.append(node('summary','','Какие опросы входят в расчёт · '+data.members.length));for(const member of data.members)members.append(node('p','',`#${member.id} · ${member.name} · ${member.channel==='success_screen'?'Экран успеха':'Пуш+СМС'} · ${member.products.join(', ')}`));host.append(members);}
 if(data.details?.length){const detail=node('details','method');detail.append(node('summary','','Показать графики по каждому опросу'));let ready=false;turn.openDetail=index=>{detail.open=true;requestAnimationFrame(()=>document.getElementById('answer-'+turn.number+'-detail-'+index)?.scrollIntoView({block:'start',behavior:'smooth'}));};detail.ontoggle=()=>{if(!detail.open||ready)return;ready=true;data.details.forEach((data,index)=>{const element=node('article','chat-message answer');detail.append(element);renderTurn({number:turn.number+'-detail-'+index,data,element,drilldown:true});});};host.append(detail);}
 if(turn.drilldown)return;
 explorer=window.ProductExplorer?.attach({data,charts,colors,onOpen:index=>turn.openDetail?.(index)});
 if(turn.favorite)return;
 const chips=node('div','followups');chips.append(node('span','','Продолжить от этого графика'));if(funnelReady){const f=node('button','suggestion','Воронка: события → отклик');f.type='button';f.onclick=()=>{funnelButton.click();funnelHost.scrollIntoView({block:'start',behavior:'smooth'});};chips.append(f);}
 for(const option of data.optionalSeries||[]){const button=node('button','suggestion','＋ '+option.label);button.type='button';button.onclick=()=>send(option.query,{turn,update:true,source:turn.source,provider:provider.value});chips.append(button);}
 for(const [label,query] of (data.spec.metrics.includes('unique_surveys')?[['За 2026 год','Покажи количество уникальных опросов за 2026 год'],['За 6 месяцев','Теперь за последние 6 месяцев']]:[['＋ Ответы','Добавь ответы'],['＋ CSI','Добавь CSI и объедини на одном графике'],['＋ Стоп-листы','Добавь отсечения по стоп-листам'],['＋ Политика контактов','Добавь отсечения по политике контактов'],['За 6 месяцев','Теперь за последние 6 месяцев']])){const button=node('button','suggestion',label);button.type='button';button.dataset.followup=query;const metric={'Добавь ответы':'answers','Добавь CSI и объедини на одном графике':'csi','Добавь отсечения по стоп-листам':'stop','Добавь отсечения по политике контактов':'contactPolicy'}[query];const present=metric&&data.spec.metrics.includes(metric)&&(!data.spec.series||!data.spec.ids.length||data.spec.ids.every(id=>data.spec.series.some(p=>p.id===id&&p.metric===metric)));if(present){button.dataset.metricPresent='true';button.disabled=true;button.textContent={answers:'Ответы уже добавлены',csi:'CSI уже добавлен',stop:'Стоп-листы уже добавлены',contactPolicy:'Политика контактов уже добавлена'}[metric];button.title='Показатель уже есть для всех выбранных опросов. Если линия скрыта, включите её в легенде.';}button.onclick=()=>send(query,{turn,update:true,source:turn.source,provider:provider.value});chips.append(button);}
 const edit=node('button','edit-chart','Изменить этот график');edit.type='button';edit.dataset.action='edit';edit.onclick=()=>{if(busy)return;source.value=turn.source;updateSource();setContext(turn,true);focusUI.show(turn,turns,false);focusUI.chat();input.focus({preventScroll:true});};chips.append(edit);host.append(chips);
}
function setBusy(value){busy=value;for(const control of [$('submit'),source,provider,$('creativeMode'),$('newSession'),$('updateExisting'),$('clearContext')])control.disabled=value;feed.querySelectorAll('.suggestion,.edit-chart,[data-action="combine"]').forEach(b=>b.disabled=value||b.dataset.metricPresent==='true');}
async function send(query,options){
 if(busy)return;query=query.trim();if(!query){$('error').textContent='Напишите сообщение или выберите подсказку.';$('error').hidden=false;input.focus();return;}
 const context=options||{turn:activeTurn,update:$('updateExisting').checked,source:source.value,provider:provider.value};
 source.value=context.source;updateSource();provider.value=context.provider;provider.onchange();
 const request={query,source:context.source,provider:context.provider,reviewPlan:true,previous:context.turn&&!['ai-workspace','generated-ui','local-ranking','calculated-dashboard'].includes(context.turn.data.kind)?clone(context.turn.data.spec):null,previousAgent:context.turn?.data.agentPlan||null,criteria:context.criteria,mode:$('creativeMode').checked?'creative':'standard',creativeBase:creativeBaseOverride||(context.turn?.data.kind==='generated-ui'?(context.turn.data.savedId||context.turn.data.jobId):null)};
 const weeklyAnswers=!context.resumeJobId&&window.FeedbackOverview.answerChangeQuery(query,request.previous);
 const target=context.update?context.turn:null;
 focusUI.start();focusUI.loading(true,target);
 $('error').hidden=true;$('intro').hidden=true;$('examples').hidden=true;document.body.classList.add('chat-started');
 const user=addMessage('user',query);user.append(node('small','message-context','Мои CSV'));
 if(context.turn)user.append(node('small','message-context',(target?'Изменение':'Продолжение')+' графика №'+context.turn.number));
 const responseElement=addMessage('assistant');const loading=node('div','skeleton',weeklyAnswers?'Сравниваем ответы за две недели…':request.provider==='gigacode'?'GigaCode обрабатывает запрос…':'Читаем данные и собираем график…');loading.setAttribute('role','status');responseElement.append(loading);
 let failed=false;input.value='';setBusy(true);focusUI.messageDone();
 try{
 if(weeklyAnswers){
  focusUI.chat();
  const analyze=async overrides=>{
   const result=await window.TrustUI.post('/api/committee',{action:'answer-change',...weeklyAnswers,...overrides});
   const headline=window.FeedbackOverview.renderAnswerChange(responseElement,result,async(selected,button)=>{
    button.disabled=true;
    try{await analyze(selected);}catch(error){responseElement.append(node('p','error',error.message));button.disabled=false;}
   });
   focusUI.notice(headline);focusUI.messageDone();
  };
  await analyze();return;
 }
 if(request.mode!=='creative'&&request.provider!=='gigacode'&&/^(?:почему|что\s+повлияло|разбери.*отклон|расследуй)/iu.test(query)&&context.turn?.investigator){
  loading.textContent='Сопоставляем наблюдения и календарь запусков…';const result=await context.turn.investigator.ask(query);context.turn.messages=[...(context.turn.messages||[context.turn.query]),query].slice(-12);const main=result.metrics.find(m=>m.metric===result.metric),lead=result.contributors.find(r=>r.contribution!==null);
  responseElement.replaceChildren(node('div','message-label','Расследование · '+result.period),node('p','message-text',main.label+': сопоставимое изменение '+(main.delta===null?'не определено':fmt(main.delta,main.metric))+(lead?' · наибольший вклад #'+lead.id+': '+fmt(lead.contribution,main.metric):'')+'. Совпавших событий календаря: '+result.events.length+'. Подробности открыты под выбранным графиком.'));focusUI.notice('Разбор периода '+result.period+' · исходный график сохранён');focusUI.messageDone();return;
 }
 const plan=context.resumeJobId?(await window.TrustUI.post('/api/creative',{action:'retry-generation',jobId:context.resumeJobId,codeTimeoutSeconds:context.codeTimeoutSeconds}),{kind:'agent-job',jobId:context.resumeJobId,mode:'creative'}):await window.TrustUI.post('/api/genui/plan',request);if(plan.mode==='creative')request.mode='creative';let data;
 if(plan.kind==='agent-job'){
  try{data=await window.AgentUI.wait(plan.jobId,responseElement,text=>focusUI.notice(text));}
  catch(e){if(e.clarification)e.clarification.options=e.clarification.options.map(o=>({...o,query:query+'. Уточнение: '+o.query}));throw e;}
 }else{
  focusUI.notice('Запрос понят: '+plan.interpretation);
  data=plan.planner==='gigacode'?await window.AgentUI.reviewChart(plan):await window.TrustUI.post('/api/genui',{planId:plan.planId});
 }
 if(data.kind==='chart-plan')data=await window.AgentUI.reviewChart(data);

 if(data.kind==='calculated-only'){responseElement.replaceChildren(node('p','message-text','Данные рассчитаны. Готов стандартный просмотр.'));const open=node('button','quiet','Открыть расчёт');open.type='button';open.onclick=()=>window.CreativeUI.calculated(data.jobId).catch(error=>responseElement.append(node('p','error',error.message)));responseElement.append(open);focusUI.messageDone();return;}
 if(data.kind==='generated-ui')data=await window.CreativeUI.review(data,{notice:text=>focusUI.notice(text)});
 creativeBaseOverride=null;
 let completed;
 if(target&&data.kind!=='calculated-dashboard'){const before=clone(target.data);target.versions=target.versions||[];target.versions.push({data:before,revision:target.revision});target.versions=target.versions.slice(-8);target.data=clone(data);target.messages=[...(target.messages||[target.query]),query].slice(-12);target.revision=query;target.step=(target.step||1)+1;target.delta=window.FocusWorkspace.delta(before,target.data);target.deltaTitle='Изменения по запросу';renderTurn(target);completed=target;}
 else{const element=node('article','chat-message answer');feed.append(element);const turn={number:++serial,query,messages:[query],data:clone(data),source:request.source,element,step:1,parentTurn:data.kind==='calculated-dashboard'?context.turn:null,delta:window.FocusWorkspace.delta(context.turn?.data,data)};turns.push(turn);renderTurn(turn);completed=turn;}
 responseElement.replaceChildren(node('div','message-label','Шаг '+completed.step+(completed.data.kind==='calculated-dashboard'?' · дашборд №':' · график №')+completed.number),node('p','message-text',completed.delta.join('\n')));const jump=node('button','quiet',(completed.data.kind==='calculated-dashboard'?'Показать дашборд №':'Показать график №')+completed.number);jump.type='button';jump.onclick=()=>{setContext(completed,true);focusUI.show(completed,turns);};responseElement.append(jump);setContext(completed,true);updateHistory();focusUI.show(completed,turns);focusUI.messageDone();
 }catch(e){if(e.discarded||e.refinement||e.planEdit){responseElement.replaceChildren(node('p','message-text',e.message));if(e.planEdit){input.value=e.query;focusUI.chat();input.focus({preventScroll:true});}if(e.refinement){creativeBaseOverride=e.draft.savedId||e.draft.jobId;$('creativeMode').checked=true;$('creativeMode').onchange();input.value=e.refinement;focusUI.chat();input.focus({preventScroll:true});}focusUI.notice('Текущий экран сохранён.');return;}failed=true;focusUI.chat();responseElement.replaceChildren(node('div','message-label',request.mode==='creative'?'Не удалось завершить этап новой визуализации':'Не удалось построить график'));const failure=node('p','error',e.message==='Failed to fetch'?'Соединение с локальным сервером прервано. Проверьте, что окно запуска проекта открыто, затем повторите запрос.':e.message);failure.setAttribute('role','alert');responseElement.append(failure);if(request.mode==='creative'&&context.turn?.data.spec&&!e.recovery?.options?.some(option=>option.action==='show-calculated')){const standard=node('button','quiet','Продолжить с обычным графиком');standard.type='button';standard.onclick=()=>{$('creativeMode').checked=false;$('creativeMode').onchange();send(query,{...context,provider:'local',resumeJobId:null});};responseElement.append(standard);}if(e.code==='no_data'||e.code==='data_import'){const setup=node('a','quiet','Открыть настройки данных');setup.href='#admin-data';responseElement.append(setup);}else if(e.code==='calendar_period'){const edit=node('button','quiet','Уточнить период');edit.type='button';edit.onclick=()=>{input.value=query;input.focus();};responseElement.append(edit);}else if(request.provider!=='local'){const local=node('a','quiet','Открыть локальный мониторинг');local.href='#morning-monitor';responseElement.append(local);}if(e.diagnosis){const d=e.diagnosis,details=node('div','failure-diagnosis');details.append(node('p','','Где остановилось: '+d.stage+' · '+d.owner),node('p','',d.cause),node('p','',d.nextAction),node('p','',d.changeQuery?'Нужно уточнить условия запроса.':'Изменение аналитического запроса не требуется для устранения этой ошибки.'),node('small','','Код: '+d.code+' · запрос '+(d.requestId||'до запуска задачи')+' · вызовов модели: '+d.modelCalls));responseElement.append(details);}for(const option of e.clarification?.options||[]){const choice=node('button','quiet recovery-option',option.label);choice.type='button';choice.onclick=()=>send(option.query,context);responseElement.append(choice);}if(e.recovery){for(const option of e.recovery.options||[]){const action=node('button','quiet recovery-option',option.label);action.type='button';action.onclick=()=>{if(option.edit){input.value=query;focusUI.chat();input.focus({preventScroll:true});}else if(option.action==='show-calculated'){window.TrustUI.post('/api/creative',{action:'finish-dashboard',jobId:option.jobId}).then(data=>openSavedChart(data,query,context.turn)).catch(error=>responseElement.append(node('p','error',error.message)));}else if(option.action==='retry-generation'){send(query,{...context,resumeJobId:option.jobId,codeTimeoutSeconds:option.timeout});}else send(query+option.suffix,{...context,resumeJobId:null});};responseElement.append(action);}}else if(e.code!=='calendar_period'){const retry=node('button','quiet','Повторить запрос');retry.type='button';retry.onclick=()=>send(query,{...context,resumeJobId:null});responseElement.append(retry);}focusUI.messageDone();
 }finally{setBusy(false);focusUI.loading(false);if(failed)focusUI.notice('\u0417\u0430\u043f\u0440\u043e\u0441 \u043d\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d. \u0422\u0435\u043a\u0443\u0449\u0438\u0439 \u0433\u0440\u0430\u0444\u0438\u043a \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d.');focusUI.messageDone();refreshStatus();}
}
form.addEventListener('submit',e=>{e.preventDefault();send(input.value);});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit();}});
document.querySelectorAll('[data-query]').forEach(b=>b.onclick=()=>send(b.dataset.query,{turn:null,update:false,source:source.value,provider:provider.value}));
function updateSource(){$('sourceBadge').textContent='Мои CSV';}
$('creativeMode').onchange=()=>{$('creativeHint').hidden=!$('creativeMode').checked;if($('creativeMode').checked&&provider.value==='local'){provider.value='auto';provider.onchange();}};
source.onchange=()=>{setContext(null,false);updateSource();};
const providerKey='genui-provider-v1';
try{const saved=localStorage.getItem(providerKey);if([...provider.options].some(option=>option.value===saved))provider.value=saved;}catch{}
provider.onchange=()=>{
 $('providerBadge').textContent=provider.value==='auto'?'Авто · правила + модель':provider.value==='gigacode'?'GigaCode CLI':'Локальный разбор';
 try{localStorage.setItem(providerKey,provider.value);}catch{}
};
$('clearContext').onclick=()=>setContext(null,false);$('updateExisting').onchange=syncContext;
$('newSession').onclick=()=>{if(busy)return;focusUI.reset();destroyCharts(feed);feed.replaceChildren();turns=[];serial=0;creativeBaseOverride=null;$('creativeMode').checked=false;$('creativeMode').onchange();setContext(null,false);updateHistory();$('error').hidden=true;document.body.classList.remove('chat-started');if(!dialogueActive)location.hash='#dialog';else updateDialogueStatus();input.value='';input.focus();window.scrollTo({top:0,behavior:'instant'});};
let statusBusy=false;
function updateDialogueStatus(){
 if(!dialogueActive)return;
 const hasConversation=document.body.classList.contains('chat-started'),notice=$('dialogueDataNotice');
 $('intro').hidden=hasConversation;
 $('examples').hidden=hasConversation||!dataStatus?.ready;
 notice.hidden=!dataStatus||dataStatus.ready;
 notice.querySelector('span').textContent=dataStatus?.message||'';
}
async function refreshStatus(){
 if(statusBusy)return;statusBusy=true;$('refreshData').disabled=true;
 try{
  const response=await fetch('/api/genui/status');if(!response.ok)throw new Error('status');
  const status=await response.json(),data=status.data;if(!data)throw new Error('data');
  $('cliStatus').textContent=(status.configured?'CLI настроена. Авторизация проверяется при запросе.':'CLI не настроена. Доступен локальный разбор.')+' · Версия проекта '+(status.build||'не определена');
  const hasData=data.surveys>0,currentRows=data.files.filter(file=>!file.file.endsWith('products.csv')).reduce((sum,file)=>sum+(file.rows||0),0);
  dataStatus={ready:hasData&&!data.error,message:data.error?'Проверьте выгрузки CSV.':'Добавьте выгрузки, чтобы построить первый график.'};
  $('dataHeading').textContent=data.error?'Проверьте CSV':hasData?'Данные подключены':'Добавьте свои выгрузки';
  $('dataSummary').textContent=data.error?'CSV не применены: '+data.error:hasData?'Опросов: '+data.surveys+' · месяцев с данными: '+data.months.length+'. '+(currentRows?'Можно задавать вопросы в диалоге.':'В текущих CSV нет строк. Показана ранее принятая локальная история.'):'Показателей пока нет. Справочники сохранены. Опросы появятся после первой загрузки CSV.';
  $('dataInstructions').hidden=Boolean(hasData&&!data.error);
  $('dataFileList').replaceChildren();
  for(const file of data.files){
   const line=node('div','data-file');line.append(node('b','',file.file),node('span','',(file.rows||0)+' строк · '+file.modified));$('dataFileList').append(line);
  }
 }catch{
  dataStatus={ready:false,message:'Не удалось проверить данные проекта.'};
  $('dataHeading').textContent='Не удалось проверить данные';
  $('dataSummary').textContent='Убедитесь, что локальный сервер запущен, и нажмите «Проверить данные».';
 }finally{
  statusBusy=false;$('refreshData').disabled=false;
  document.querySelectorAll('[data-query]').forEach(button=>button.disabled=!dataStatus?.ready);
  updateDialogueStatus();
 }
}
$('refreshData').onclick=refreshStatus;
provider.onchange();
window.ExportGenuiChartPng=exportPng;
async function showBuild(){
 const status=$('appBuild');
 try{
  const response=await fetch('/api/health',{cache:'no-store'});
  if(!response.ok)throw new Error();
  const {build,builtAt}=await response.json();
  status.replaceChildren(node('span','',build?'Версия '+build:'Версия неизвестна'));
  const parsed=new Date(builtAt);
  if(builtAt&&Number.isFinite(parsed.getTime())){
   const time=node('time','',new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Moscow'}).format(parsed)+' МСК');
   time.dateTime=builtAt;time.title='Дата и время сборки';status.append(time);
  }else status.append(node('span','','Время сборки неизвестно'));
 }catch{status.textContent='Версия недоступна';}
}
showBuild();
updateSource();syncContext();showPage();
})();
