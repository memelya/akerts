(()=>{'use strict';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;},clone=structuredClone,catalog=new Map(),freshPage=()=>({id:crypto.randomUUID(),title:'Новая страница',subtitle:'',footer:'',layout:'grid',template:'classic',theme:'light',table:{enabled:false,title:'',headers:['Показатель','Значение','Изменение'],rows:[]},cards:[],notes:[{heading:'',body:''},{heading:'',body:''},{heading:'',body:''}],kpis:[{label:'',value:'',detail:''},{label:'',value:'',detail:''}]}),capacity=window.PresentationLayouts.capacity;
let api=null;const pngOptions=new Map(),imageCache=new Map();
async function loadImage(data){
 if(!imageCache.has(data)){
  const decoded=(async()=>{
   const image=new Image();image.src=data;await image.decode();
   if(image.naturalWidth*image.naturalHeight>40_000_000)throw new Error('PNG должен быть не больше 40 млн пикселей.');
   return image;
  })();
  if(imageCache.size>=12)imageCache.delete(imageCache.keys().next().value);
  imageCache.set(data,decoded);
  decoded.catch(()=>imageCache.delete(data));
 }
 return imageCache.get(data);
}
async function loadImages(pages){
 const assets=[...new Set(pages.flatMap(page=>page.cards.filter(card=>card.kind==='image').map(card=>card.data)))];
 return new Map(await Promise.all(assets.map(async data=>[data,await loadImage(data)])));
}
function readImage(file){
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Не удалось прочитать PNG.'));reader.readAsDataURL(file);});
}
let pngSize={width:3840,height:2160};
function appendChart(page,card){
 if(!page.cards.length&&page.title==='Новая страница')page.title=card.title.slice(0,240);
 page.cards.push(card);
}
function exportChartPng(entry,{name}){
 const page=freshPage();
 appendChart(page,window.PresentationRender.newCard(entry,'export'));
 window.ChartAppearance.openPNG(async(size,options)=>{
  await document.fonts.ready;
  const result=window.PresentationRender.render({...page,pngOptions:options},{scale:Math.min(size.width/1920,size.height/1080)});
  if(result.errors.length)throw new Error(result.errors.join(' '));
  return window.ChartAppearance.fit(result.canvas,size.width,size.height,result.background);
 },{name,title:page.title,width:3200,height:1800,bg:window.PresentationRender.themes.light.bg});
}
function register(key,get,label,scope){catalog.set(key,{get,label,scope});api?.catalogChanged();}
function button(key,get,label,scope){register(key,get,label,scope);const b=el('button','presentation-add','На страницу презентации');b.type='button';b.onclick=()=>api?.addDialog(key,b);return b;}
function openAdd(key,opener,options){return api?.addDialog(key,opener,options);}
window.PresentationPages={exportChartPng,register,button,openAdd,getDocument:()=>api?.getDocument()||null,clear(prefix){for(const key of catalog.keys())if(key.startsWith(prefix))catalog.delete(key);api?.catalogChanged();},create({main}){
 const page=el('section','presentation-pages');page.hidden=true;main.append(page);const nav=el('a','nav-item','Страницы презентации');nav.href='#presentation-pages';document.querySelector('.rail').insertBefore(nav,document.querySelector('.history'));
 let doc={format:'genui-presentation-pages',version:1,pages:[],activeId:null},db=null,projectId=null,persistError='',saveTimer=null,revision=0,renderToken=0,busy=false,actionError='',activeErrors=[],librarySelect=null,preview=null,errorBox=null,status=null;
 const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const ready=(async()=>{try{const response=await fetch('/api/health',{cache:'no-store'});if(!response.ok)throw new Error();const health=await response.json();if(typeof health.rootId!=='string'||!health.rootId)throw new Error();projectId=health.rootId;const open=indexedDB.open('genui-presentation-pages-v1',1);open.onupgradeneeded=()=>open.result.createObjectStore('projects');db=await request(open);const saved=await request(db.transaction('projects').objectStore('projects').get(projectId));if(saved)doc=window.PresentationRender.validateDocument(saved);}catch(e){persistError='Черновик не удалось загрузить из браузера. Можно работать и сохранять проект в JSON.';db=null;}})();
 const current=()=>doc.pages.find(p=>p.id===doc.activeId)||doc.pages[0];
 async function persist(){clearTimeout(saveTimer);if(!db||!projectId)return;const snapshot=clone(doc);try{await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(snapshot,projectId);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});persistError='';if(status)status.textContent='Черновик сохранён в браузере этого проекта.';}catch(e){persistError='Не удалось сохранить черновик в браузере. Скачайте проект в JSON.';if(status)status.textContent=persistError;}}
 function changed(){actionError='';revision++;if(status)status.textContent='Сохраняю черновик…';clearTimeout(saveTimer);saveTimer=setTimeout(persist,150);drawPreview();}
 function showErrors(layoutError=''){const text=[actionError,layoutError].filter(Boolean).join(' ');if(errorBox){errorBox.textContent=text;errorBox.hidden=!text;}}function report(text){actionError=text;showErrors();}
 const catalogFilters={query:'',channel:'',product:'',metric:'csi'};
 let surveyInventory=[],inventoryLoaded=false,inventoryRequest,libraryCount,addGraph,catalogProduct;
 const searchKey=value=>String(value||'').toLocaleLowerCase('ru-RU').replaceAll('ё','е');
 const inventoryByKey=new Map(),inventoryById=new Map();
 function catalogOptions(){
  if(!librarySelect)return;
  const selected=librarySelect.value,search=searchKey(catalogFilters.query).replaceAll('#','').split(/\s+/).filter(Boolean);
  const accepts=(label,members,channel)=>{
   const scoped=members.filter(s=>(!catalogFilters.channel||s.channel===catalogFilters.channel)&&(!catalogFilters.product||s.products.includes(catalogFilters.product)));
   if((catalogFilters.channel||catalogFilters.product)&&!scoped.length){
    if(catalogFilters.product||channel!==catalogFilters.channel||members.length)return false;
   }
   return search.every(term=>searchKey([label,...(scoped.length?scoped:members).flatMap(s=>[s.id,s.name,...s.products])].join(' ')).includes(term));
  };
  const options=[];
  for(const [key,item] of catalog){
   let members=[],channel='';
   if(item.scope){
    channel=item.scope.channel;
    members=item.scope.ids.flatMap(id=>channel?[inventoryByKey.get(channel+':'+id)].filter(Boolean):inventoryById.get(id)||[]);
   }
   if(accepts(item.label,members,channel))options.push([key,item.label]);
  }
  for(const survey of surveyInventory){
   if(!survey.latest)continue;
   const label='#'+survey.id+' · '+survey.name+' · '+window.DigestUI.channels[survey.channel];
   if(accepts(label,[survey],survey.channel))options.push(['csv:'+survey.channel+':'+survey.id,label+' · из CSV']);
  }
  librarySelect.replaceChildren(...options.slice(0,100).map(([key,label])=>new Option(label,key)));
  if([...librarySelect.options].some(option=>option.value===selected))librarySelect.value=selected;
  librarySelect.disabled=!options.length;
  if(addGraph)addGraph.disabled=!options.length;
  libraryCount.textContent=options.length>100?'Показаны первые 100 из '+options.length+'. Уточните поиск.':options.length?'Найдено '+options.length:inventoryLoaded?'Графики не найдены. Измените фильтры.':'Загружаю список опросов…';
 }
 async function loadInventory(){
  if(inventoryLoaded||inventoryRequest)return;
  inventoryRequest=window.TrustUI.post('/api/digest',{action:'inventory'});
  try{
   const result=await inventoryRequest;surveyInventory=result.surveys;
   inventoryByKey.clear();inventoryById.clear();
   for(const s of surveyInventory){
    inventoryByKey.set(s.channel+':'+s.id,s);
    if(!inventoryById.has(s.id))inventoryById.set(s.id,[]);
    inventoryById.get(s.id).push(s);
   }
   inventoryLoaded=true;updateCatalogProducts();catalogOptions();
  }catch(error){if(libraryCount)libraryCount.textContent=error.message;}
  finally{inventoryRequest=null;}
 }
 function updateCatalogProducts(){
  if(!catalogProduct)return;
  const values=[...new Set(surveyInventory.flatMap(s=>s.products))].sort();
  catalogProduct.replaceChildren(new Option('Все продукты',''),...values.map(value=>new Option(value,value)));
  catalogProduct.value=catalogFilters.product;
 }
 async function addFromLibrary(target,key){
  if(!key.startsWith('csv:')){appendCard(target,key);return;}
  const survey=inventoryByKey.get(key.slice(4));
  if(!survey)throw new Error('Опрос отсутствует в источнике.');
  const definition={...window.DigestUI.defaults(survey.latest.slice(0,4),[catalogFilters.metric]),ids:String(survey.id),channel:survey.channel,type:'detail'};
  const result=await window.TrustUI.post('/api/digest',{action:'run',definition});
  if(!doc.pages.includes(target))throw new Error('Страница изменилась. Выберите её заново.');
  if(target.cards.length>=capacity(target))throw new Error('В выбранном макете нет свободного места.');
  appendChart(target,window.DigestUI.makeCard(result,result.items[0],definition));
 }
 function capture(key){const item=catalog.get(key);if(!item)throw new Error('Исходный график сейчас недоступен. Откройте раздел с графиком.');return window.PresentationRender.newCard(item.get(),key);}
 function appendCard(target,key,options={}){if(target.cards.length>=capacity(target))throw new Error('В выбранном макете нет свободного места. Создайте страницу или выберите сетку.');const card=capture(key);if(options.valueTable)card.valueTable=true;appendChart(target,card);}
 async function addDialog(key,opener,options={}){await ready;const dialog=el('dialog','overview-dialog presentation-destination'),title=el('h2','','Добавить график на страницу'),select=el('select'),add=el('button','','Добавить'),close=el('button','','Отмена'),error=el('p','error');select.setAttribute('aria-label','Страница для графика');error.hidden=true;for(const p of doc.pages){const option=el('option','',p.title+' ('+p.cards.length+'/'+capacity(p)+')');option.value=p.id;option.disabled=p.cards.length>=capacity(p);select.append(option);}const next=el('option','','Новая страница');next.value='new';select.append(next);select.value=current()&&current().cards.length<capacity(current())?current().id:'new';const tableLabel=el('label','presentation-check'),tableBox=el('input');tableBox.type='checkbox';tableBox.checked=Boolean(options.valueTable);tableLabel.append(tableBox,document.createTextNode(' Добавить таблицу значений под графиком'));add.onclick=()=>{try{let target=doc.pages.find(p=>p.id===select.value);const created=!target;if(created){if(doc.pages.length>=30)throw new Error('В проекте может быть до 30 страниц.');target=freshPage();}appendCard(target,key,{valueTable:tableBox.checked});if(created)doc.pages.push(target);doc.activeId=target.id;changed();dialog.close();location.hash='#presentation-pages';if(!page.hidden)render();}catch(e){error.textContent=e.message;error.hidden=false;}};close.onclick=()=>dialog.close();dialog.append(title,el('p','',catalog.get(key)?.label||'График'),select,tableLabel,error,add,close);document.body.append(dialog);dialog.showModal();dialog.addEventListener('close',()=>{dialog.remove();opener?.focus({preventScroll:true});},{once:true});}
 async function show(){await ready;inventoryLoaded=false;if(!doc.pages.length){const p=freshPage();doc.pages.push(p);doc.activeId=p.id;changed();}render();}
 async function drawPreview(){if(!preview||page.hidden)return;const token=++renderToken;await document.fonts.ready;if(token!==renderToken||page.hidden)return;const p=current();if(!p)return;try{const images=await loadImages([p]);if(token!==renderToken||page.hidden)return;const result=window.PresentationRender.render(p,{pageNumber:doc.pages.indexOf(p)+1,pageCount:doc.pages.length,images});activeErrors=result.errors;preview.replaceChildren(result.canvas);showErrors(result.errors.join(' '));page.querySelector('[data-page-png]')?.toggleAttribute('disabled',busy||Boolean(result.errors.length));}catch(e){activeErrors=[e.message];preview.replaceChildren(el('p','presentation-source',e.message));showErrors(e.message);page.querySelector('[data-page-png]')?.setAttribute('disabled','');}}
 function field(host,label,value,onChange,{area=false,max=240,type='text'}={}){const wrap=el('label','presentation-field',label),input=el(area?'textarea':'input');if(!area)input.type=type;input.value=value;input.maxLength=max;input.setAttribute('aria-label',label);input.oninput=()=>{onChange(input.value);changed();};wrap.append(input);host.append(wrap);return input;}
 function select(host,label,options,value,change){const wrap=el('label','presentation-field',label),input=el('select');input.setAttribute('aria-label',label);for(const [key,text]of options){const option=el('option','',text);option.value=key;input.append(option);}input.value=value;input.onchange=()=>{change(input.value);changed();};wrap.append(input);host.append(wrap);return input;}
 function sourceInfo(card){if(card.kind==='image')return 'Изображение PNG';const g=card.graph;return[g.channel==='communication'?'Пуш + СМС':g.channel==='success_screen'?'Экран успеха':'',g.capturedAt?new Date(g.capturedAt).toLocaleString('ru-RU'):'',g.uiEdited?'с ручными правками':'',g.revision?'версия '+g.revision:''].filter(Boolean).join(' · ');}
 function renderCardSettings(host,card,index,p){
  const details=el('details','presentation-card-settings'),summary=el('summary','',String(index+1)+'. '+card.title),body=el('div','presentation-card-body');details.append(summary,body);field(body,'Название графика '+(index+1),card.title,value=>{card.title=value;summary.textContent=String(index+1)+'. '+value;},{max:300});body.append(el('p','presentation-source',sourceInfo(card)));
  if(card.kind==='image'){
   const actions=el('div','presentation-actions');
   for(const [label,offset] of [['Выше',-1],['Ниже',1],['Убрать PNG',0]]){
    const button=el('button','',label);const other=index+offset;
    button.disabled=offset!==0&&(other<0||other>=p.cards.length);
    button.onclick=()=>{if(offset)[p.cards[index],p.cards[other]]=[p.cards[other],p.cards[index]];else p.cards.splice(index,1);changed();render();};
    actions.append(button);
   }
   body.append(actions);host.append(details);return;
  }
  const choices=el('fieldset','presentation-series');choices.append(el('legend','','Показатели'));for(const s of card.graph.series){const label=el('label'),input=el('input');input.type='checkbox';input.checked=card.selected.includes(s.key);input.setAttribute('aria-label','Ряд '+s.label+' графика '+(index+1));input.onchange=()=>{if(input.checked)card.selected.push(s.key);else card.selected=card.selected.filter(key=>key!==s.key);changed();};label.append(input,document.createTextNode(s.label));choices.append(label);}body.append(choices);
  select(body,'Основной показатель '+(index+1),card.graph.series.map(s=>[s.key,s.label]),card.headline,value=>card.headline=value);
  if(card.graph.kind!=='ranking'){select(body,'С даты графика '+(index+1),card.graph.dates.map(v=>[v,v]),card.start,value=>card.start=value);select(body,'По дату графика '+(index+1),card.graph.dates.map(v=>[v,v]),card.end,value=>card.end=value);select(body,'База сравнения '+(index+1),card.graph.dates.map(v=>[v,v]),card.baseline,value=>card.baseline=value);}
  select(body,'Вид графика '+(index+1),[['auto','Как в источнике'],['line','Линии'],['bar','Столбцы; CSI остаётся линией']],card.style,value=>card.style=value);select(body,'Подписи '+(index+1),[['key','Первая, базовая и последняя точки'],['all','Все значения'],['none','Без подписей значений']],card.labels,value=>card.labels=value);
  card.colors||={};card.excludedDates||=[];const appearance={valueMode:card.valueMode||'both',colors:card.colors,excludedDates:card.excludedDates,numberFormat:card.numberFormat||'auto',numberDecimals:card.numberDecimals??1,hiddenShares:card.hiddenShares||[]};window.ChartAppearance.controls(body,{settings:appearance,series:card.graph.series.map((s,j)=>({key:s.key,label:s.label,color:card.colors[s.key]||card.colors[s.metric]||window.PresentationRender.themes[p.theme].series[j%6]})),dates:card.graph.dates,change:()=>{card.numberFormat=appearance.numberFormat;card.numberDecimals=appearance.numberDecimals;card.hiddenShares=appearance.hiddenShares;card.valueMode=appearance.valueMode;card.colors=appearance.colors;card.excludedDates=appearance.excludedDates;changed();}});
  const label=el('label','presentation-check'),zoom=el('input');zoom.type='checkbox';zoom.checked=card.zoomCSI;zoom.onchange=()=>{card.zoomCSI=zoom.checked;changed();};label.append(zoom,document.createTextNode('Приблизить шкалу CSI к данным'));body.append(label);
  {const tl=el('label','presentation-check'),tb=el('input');tb.type='checkbox';tb.checked=Boolean(card.valueTable);tb.onchange=()=>{card.valueTable=tb.checked;changed();render();};tl.append(tb,document.createTextNode('Таблица значений под графиком'));body.append(tl);}
  const actions=el('div','presentation-actions'),update=el('button','','Обновить снимок'),up=el('button','','Выше'),down=el('button','','Ниже'),remove=el('button','','Убрать график');update.disabled=!catalog.has(card.sourceRef);update.onclick=()=>{try{const next=capture(card.sourceRef),oldTitle=card.title;card.graph=next.graph;card.excludedDates=(card.excludedDates||[]).filter(d=>card.graph.dates.includes(d));card.title=oldTitle;card.selected=card.selected.filter(key=>card.graph.series.some(s=>s.key===key));if(!card.selected.length)card.selected=next.selected;if(!card.graph.series.some(s=>s.key===card.headline))card.headline=next.headline;for(const key of ['start','end','baseline'])if(!card.graph.dates.includes(card[key]))card[key]=next[key];changed();render();}catch(e){report(e.message);}};up.disabled=index===0;down.disabled=index===p.cards.length-1;up.onclick=()=>{[p.cards[index-1],p.cards[index]]=[p.cards[index],p.cards[index-1]];changed();render();};down.onclick=()=>{[p.cards[index+1],p.cards[index]]=[p.cards[index],p.cards[index+1]];changed();render();};remove.onclick=()=>{p.cards.splice(index,1);changed();render();};actions.append(update,up,down,remove);body.append(actions);host.append(details);
 }
 async function exported(kind){
  if(busy)return;
  const rasterPng=kind==='png'||kind==='all';
  let targetSize=null;
  try{if(rasterPng)targetSize=window.ChartAppearance.dimensions(pngSize.width,pngSize.height);}catch(e){report(e.message);return;}
  busy=true;page.querySelectorAll('[data-export]').forEach(button=>button.disabled=true);
  const saved=clone(doc),pages=kind==='png'?[saved.pages.find(p=>p.id===saved.activeId)||saved.pages[0]]:saved.pages;
  report('');
  try{
   if(kind==='xlsx'){
    const blob=await window.PresentationOffice.workbook(pages);
    window.MeetingExports.saveBlob(blob,'presentation-data.xlsx');
   }else{
    if(rasterPng)for(const p of pages)p.pngOptions=pngOptions.get(p.id)||{title:p.title,showFootnotes:true,showXAxis:true};
    await document.fonts.ready;
    const images=await loadImages(pages);
    const draw=(p,scale=1,editable=false)=>window.PresentationRender.render(p,{scale,editable,images,pageNumber:saved.pages.indexOf(p)+1,pageCount:saved.pages.length});
    await persist();
    if(kind==='pptx'||kind==='pptx-image'){
     const raster=kind==='pptx-image';
     const blob=await window.PresentationOffice.powerPoint(pages,p=>draw(p,raster?2:1,!raster),{
      raster,progress:n=>{status.textContent='Готовлю PPTX '+n+' / '+pages.length;},
      notes:p=>p.cards.map(card=>card.kind==='image'?card.title:card.title+'\n'+sourceInfo(card)+'\nИсточник: '+card.graph.sourceTitle+'\nДиапазон: '+card.start+' — '+card.end+' · база '+card.baseline).join('\n\n')
     });
     window.MeetingExports.saveBlob(blob,raster?'presentation-pages-images.pptx':'presentation-pages.pptx');
    }else{
     const files=[];
     for(const p of pages){
      const number=saved.pages.indexOf(p)+1;
      status.textContent='Готовлю PNG '+number+' / '+saved.pages.length;
      const rendered=draw(p,Math.min(targetSize.width/1920,targetSize.height/1080));
      if(rendered.errors.length)throw new Error('Страница «'+p.title+'». '+rendered.errors.join(' '));
      const canvas=window.ChartAppearance.fit(rendered.canvas,targetSize.width,targetSize.height,rendered.background);
      const blob=await window.MeetingExports.blobOf(canvas);
      files.push({name:'page-'+String(number).padStart(2,'0')+'.png',bytes:new Uint8Array(await blob.arrayBuffer()),blob});
     }
     if(files.length===1)window.MeetingExports.saveBlob(files[0].blob,files[0].name);
     else window.MeetingExports.saveBlob(window.MeetingExports.zip(files),'presentation-pages-png.zip');
    }
   }
   status.textContent=kind==='pptx'?'PPTX готов. Данные диаграмм можно открыть в Excel из PowerPoint.':'Файл готов к скачиванию.';
  }catch(e){report(e.message);}
  finally{busy=false;page.querySelectorAll('[data-export]').forEach(button=>button.disabled=false);if(activeErrors.length)page.querySelector('[data-page-png]')?.setAttribute('disabled','');}
 }
 function render(){
  const p=current();if(!p)return;page.replaceChildren();const header=el('header','overview-heading'),head=el('div'),actions=el('div','presentation-actions');head.append(el('h1','','Страницы презентации'),el('p','','Соберите графики, выводы и KPI на страницах 16:9 по вашим примерам.'));
  for(const [label,kind]of [['Скачать PPTX','pptx'],['Скачать Excel','xlsx'],['PNG страницы','png'],['Все страницы PNG','all'],['PPTX из PNG','pptx-image']]){const b=el('button','',label);b.dataset.export=kind;if(kind==='png')b.dataset.pagePng='';b.onclick=()=>exported(kind);actions.append(b);}const sizeBox=el('details','chart-appearance');sizeBox.append(el('summary','','Размер PNG'));const sizeFields=el('div','chart-appearance-fields');const sizes=window.ChartAppearance.sizeFields(sizeFields,{...pngSize,change:()=>{pngSize={width:sizes.width.value,height:sizes.height.value};}});const exportOptions=window.ChartAppearance.exportFields(sizeFields,{title:p.title,...pngOptions.get(p.id),change:()=>pngOptions.set(p.id,exportOptions.get())});sizeBox.append(sizeFields,el('p','','При другом соотношении сторон добавляются поля. PPTX: 16:9.'));header.append(head,actions);page.append(header,sizeBox);status=el('p','presentation-status',persistError||'Черновик хранится в этом браузере и адресе проекта. Для переноса сохраните JSON.');status.setAttribute('role','status');errorBox=el('p','error');errorBox.setAttribute('role','alert');errorBox.hidden=true;page.append(status,errorBox);
  const strip=el('div','presentation-page-strip');doc.pages.forEach((item,i)=>{const b=el('button','',''+(i+1)+'. '+item.title);b.setAttribute('aria-pressed',String(item.id===p.id));b.onclick=()=>{doc.activeId=item.id;changed();render();};strip.append(b);});const add=el('button','','Новая страница');add.disabled=doc.pages.length>=30;add.onclick=()=>{const next=freshPage();doc.pages.push(next);doc.activeId=next.id;changed();render();};strip.append(add);page.append(strip);
  const workbench=el('div','presentation-workbench'),inspector=el('aside','presentation-inspector'),stage=el('div','presentation-stage');preview=el('div','presentation-preview');preview.setAttribute('aria-label','Предпросмотр страницы 16:9');stage.append(preview,el('p','presentation-source','В странице хранится снимок графика на момент добавления. «Обновить снимок» явно возьмёт текущие значения источника. В PPTX диаграммы и текст редактируются. PNG можно добавить на любую страницу.'));
  field(inspector,'Заголовок страницы',p.title,v=>{p.title=v;const tab=page.querySelector('.presentation-page-strip [aria-pressed=true]');if(tab)tab.textContent=(doc.pages.indexOf(p)+1)+'. '+v;});field(inspector,'Подзаголовок',p.subtitle,v=>p.subtitle=v,{area:true,max:600});const template=p.template||'classic';
  select(inspector,'Шаблон страницы',Object.entries(window.PresentationLayouts.templates).map(([key,item])=>[key,item.label]),template,value=>{
   p.template=value;
   if(value==='comparison'&&p.kpis.length<3)p.kpis.push({label:'',value:'',detail:''});
   render();
  });
  if(template==='classic')select(inspector,'Макет',[['grid','Сетка до 6 графиков'],['one','Большой график и выводы справа'],['two','Два графика и выводы справа']],p.layout,v=>{p.layout=v;render();});select(inspector,'Оформление',[['light','Светлое с зелёным акцентом'],['dark','Тёмное']],p.theme,v=>p.theme=v);field(inspector,'Подпись внизу',p.footer,v=>p.footer=v,{area:true,max:600});
  const library=el('label','presentation-field','График для добавления');librarySelect=el('select');librarySelect.setAttribute('aria-label','График для страницы');library.append(librarySelect);
  const catalogPanel=el('div','presentation-catalog-filters');
  const searchLabel=el('label','','Поиск опроса или графика'),search=el('input');
  search.type='search';search.placeholder='Номер или название опроса';search.value=catalogFilters.query;
  searchLabel.append(search);catalogPanel.append(searchLabel);
  search.oninput=()=>{catalogFilters.query=search.value;catalogOptions();};
  const channelLabel=el('label','','Канал графика'),channel=el('select');
  for(const [value,label] of [['','Все каналы'],...Object.entries(window.DigestUI.channels)])channel.add(new Option(label,value));
  channel.value=catalogFilters.channel;channel.onchange=()=>{catalogFilters.channel=channel.value;catalogOptions();};channelLabel.append(channel);catalogPanel.append(channelLabel);
  const productLabel=el('label','','Продукт графика');catalogProduct=el('select');productLabel.append(catalogProduct);catalogPanel.append(productLabel);updateCatalogProducts();
  catalogProduct.onchange=()=>{catalogFilters.product=catalogProduct.value;catalogOptions();};
  const metricLabel=el('label','','Показатель для графиков из CSV'),metric=el('select');for(const [value,label] of [['csi','CSI'],['answers','Ответы'],['sends','Отправки'],['events','События']])metric.add(new Option(label,value));
  metric.value=catalogFilters.metric;metric.onchange=()=>{catalogFilters.metric=metric.value;};metricLabel.append(metric);catalogPanel.append(metricLabel);
  libraryCount=el('small');libraryCount.setAttribute('role','status');
  inspector.append(catalogPanel,library,libraryCount);
  addGraph=el('button','','Добавить график');
  addGraph.onclick=async event=>{const control=event.currentTarget;control.disabled=true;try{await addFromLibrary(p,librarySelect.value);changed();render();}catch(e){report(e.message);catalogOptions();}};
  inspector.append(addGraph);catalogOptions();loadInventory();

  const pngField=el('label','presentation-field','Вставить PNG'),pngFile=el('input');
  pngFile.type='file';pngFile.accept='image/png,.png';pngFile.disabled=p.cards.length>=capacity(p);
  pngFile.onchange=async()=>{
   const file=pngFile.files[0];if(!file)return;
   try{
    if(file.size>3*1024*1024)throw new Error('Выберите PNG до 3 МБ.');
    const data=(await readImage(file)).replace(/^data:application\/octet-stream;/,'data:image/png;');
    const card={kind:'image',id:crypto.randomUUID(),title:file.name.replace(/\.png$/i,'').slice(0,300),data};
    if(!window.PresentationRender.validImage(card))throw new Error('Выберите файл PNG.');
    await loadImage(data);
    if(!doc.pages.includes(p))throw new Error('Страница уже закрыта. Откройте её и повторите загрузку.');
    if(p.cards.length>=capacity(p))throw new Error('В шаблоне нет свободного места.');
    if(JSON.stringify(doc).length+data.length>25*1024*1024)throw new Error('Черновик превысит 25 МБ. Уберите лишние изображения.');
    p.cards.push(card);changed();render();
   }catch(e){report(e.message);}finally{pngFile.value='';}
  };
  pngField.append(pngFile);inspector.append(pngField);
  if(!catalog.size){const empty=el('p','presentation-source','Сначала откройте графики: ');for(const [label,href]of [['Встреча 05.11.2026','#meeting-20261105'],['Опросы пуш + СМС','#surveys-communication'],['Диалог с данными','#']]){const a=el('a','',label);a.href=href;empty.append(a,document.createTextNode(' '));}inspector.append(empty);}
  p.cards.forEach((card,i)=>renderCardSettings(inspector,card,i,p));
  if(template!=='classic'){
   p.marker||={date:'',text:''};
   const dates=[...new Set(p.cards.flatMap(card=>card.graph?.dates||[]))].sort();
   if(dates.length){
    select(inspector,'Период отметки',[['','Без отметки'],...dates.map(date=>[date,date])],p.marker.date,value=>p.marker.date=value);
    field(inspector,'Текст отметки',p.marker.text,value=>p.marker.text=value,{max:160});
   }
  }
  if(template==='comparison'||template==='classic'&&p.layout!=='grid'){
   const notes=el('details','presentation-notes');notes.open=true;notes.append(el('summary','',template==='comparison'?'KPI под графиками':'Выводы и KPI'));p.kpis.forEach((k,i)=>{field(notes,'Подпись KPI '+(i+1),k.label,v=>k.label=v,{max:400});field(notes,'Значение KPI '+(i+1),k.value,v=>k.value=v,{max:400});field(notes,'Пояснение KPI '+(i+1),k.detail,v=>k.detail=v,{area:true,max:400});});if(template==='classic')p.notes.forEach((n,i)=>{field(notes,'Заголовок вывода '+(i+1),n.heading,v=>n.heading=v,{max:120});field(notes,'Текст вывода '+(i+1),n.body,v=>n.body=v,{area:true,max:2500});});inspector.append(notes);
   if(template==='classic'){p.table=p.table||{enabled:false,title:'',headers:['Показатель','Значение','Изменение'],rows:[]};const tableSettings=el('details','presentation-notes');tableSettings.open=p.table.enabled;tableSettings.append(el('summary','','Таблица справа'));const tableLabel=el('label','presentation-check'),tableToggle=el('input');tableToggle.type='checkbox';tableToggle.checked=p.table.enabled;tableToggle.setAttribute('aria-label','Показывать таблицу справа');tableToggle.onchange=()=>{p.table.enabled=tableToggle.checked;changed();render();};tableLabel.append(tableToggle,document.createTextNode('Показывать таблицу'));tableSettings.append(tableLabel);
   if(p.table.enabled){field(tableSettings,'Заголовок таблицы',p.table.title,v=>p.table.title=v,{max:120});p.table.headers.forEach((v,i)=>field(tableSettings,'Столбец таблицы '+(i+1),v,text=>p.table.headers[i]=text,{max:80}));p.table.rows.forEach((row,i)=>{const rowBox=el('div','presentation-table-row');row.forEach((v,j)=>field(rowBox,'Строка '+(i+1)+', столбец '+(j+1),v,text=>p.table.rows[i][j]=text,{max:80}));const remove=el('button','','Убрать строку '+(i+1));remove.onclick=()=>{p.table.rows.splice(i,1);changed();render();};rowBox.append(remove);tableSettings.append(rowBox);});const rowAdd=el('button','','Добавить строку таблицы');rowAdd.disabled=p.table.rows.length>=6;rowAdd.onclick=()=>{p.table.rows.push(['','','']);changed();render();};tableSettings.append(rowAdd);}inspector.append(tableSettings);}
  }
  const pageTools=el('div','presentation-actions');for(const [label,action]of [['Копировать страницу',()=>{if(doc.pages.length>=30)return;const copy=clone(p);copy.id=crypto.randomUUID();copy.cards.forEach(c=>c.id=crypto.randomUUID());copy.title=p.title;doc.pages.splice(doc.pages.indexOf(p)+1,0,copy);doc.activeId=copy.id;}],['Страница выше',()=>{const i=doc.pages.indexOf(p);if(i>0)[doc.pages[i-1],doc.pages[i]]=[doc.pages[i],doc.pages[i-1]];}],['Страница ниже',()=>{const i=doc.pages.indexOf(p);if(i<doc.pages.length-1)[doc.pages[i+1],doc.pages[i]]=[doc.pages[i],doc.pages[i+1]];}],['Удалить страницу',()=>{doc.pages=doc.pages.filter(k=>k.id!==p.id);if(!doc.pages.length)doc.pages.push(freshPage());doc.activeId=doc.pages[Math.min(doc.pages.length-1,0)].id;}]]){const b=el('button','',label);b.onclick=()=>{action();changed();render();};pageTools.append(b);}inspector.append(pageTools);
  const save=el('button','','Скачать проект JSON');save.onclick=()=>{window.MeetingExports.saveBlob(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}),'presentation-pages.json');};const load=el('label','presentation-field','Открыть проект JSON'),file=el('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','Открыть проект JSON');file.onchange=async()=>{const selected=file.files[0];if(!selected)return;try{if(selected.size>25*1024*1024)throw new Error('Файл проекта должен быть не больше 25 МБ.');const next=window.PresentationRender.validateDocument(JSON.parse(await selected.text()));if(!next.pages.length)next.pages.push(freshPage());next.activeId=next.pages.some(k=>k.id===next.activeId)?next.activeId:next.pages[0].id;doc=next;changed();render();}catch(e){report(e.message);}};load.append(file);inspector.append(save,load,el('p','presentation-source','Открытие JSON заменяет текущие страницы. Перед этим скачайте свой проект, если нужна резервная копия.'));workbench.append(inspector,stage);page.append(workbench);drawPreview();
 }
 api={page,show,addDialog,catalogChanged:()=>{if(!page.hidden){catalogOptions();}},getDocument:()=>clone(doc),ready};return api;
}};
})();
