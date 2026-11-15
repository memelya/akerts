(()=>{
'use strict';
const post=body=>window.TrustUI.post('/api/digest',body);
const labels={csi:'CSI',answers:'Ответы',sends:'Отправки',events:'События',responseRate:'Отклик'};
const channels={communication:'Пуш + СМС',success_screen:'Экраны успеха'};
const names={overview:'Сводная динамика',detail:'Графики по опросам',both:'Сводка и графики по опросам'};
function el(tag,value){const node=document.createElement(tag);if(value!==undefined)node.textContent=value;return node;}
function defaults(year,metrics=['csi']){
 return {name:metrics[0]==='csi'?'CSI за '+year:'Сбор обратной связи за '+year,start:year+'-01-01',end:year+'-12-31',
  metrics,channel:'',product:'',top:false,ids:'',layout:'4',chart:'line',theme:'light',type:'both',format:'pptx'};
}
function makeCard(result,item,definition){
 const survey=item.survey,title=survey?'#'+survey.id+' · '+survey.name+' · '+channels[survey.channel]:'Все опросы выбранного отбора';
 const source='Локальные CSV · '+definition.start+' — '+definition.end;
 const data={source,keepMissingPeriods:true,dataRevision:result.revision,months:result.months,periods:result.periods,blocks:item.blocks,
  spec:{grain:'month',ids:survey?[survey.id]:[],filters:survey?{channel:survey.channel}:{}}};
 const card=window.PresentationRender.newCard({chart:{status:'ok',title,channel:survey?.channel,data}},'digest');
 card.style=definition.chart;card.valueMode='absolute';
 card.graph.keepMissingPeriods=true;
 return card;
}
function makePages(result,definition){
 const footer='Локальные CSV · версия '+result.revision+(result.monthlyExcluded?' · на границах периода учитываются только дневные строки':'');
 const subtitle=definition.start+' — '+definition.end+' · '+result.surveyCount+' опросов с наблюдениями';
 const base={layout:'grid',template:'classic',theme:definition.theme,subtitle,footer,notes:[],kpis:[]};
 const pages=[];
 if(result.overall)pages.push({...base,title:definition.name,cards:[makeCard(result,result.overall,definition)]});
 const size=Number(definition.layout);
 for(let i=0;i<result.items.length;i+=size){
  const cards=result.items.slice(i,i+size).map(item=>makeCard(result,item,definition));
  pages.push({...base,title:definition.name+' · опросы '+(i+1)+'–'+(i+cards.length),cards});
 }
 return pages;
}
function create(main){
 const page=el('section');page.className='trust-page digest-page';page.hidden=true;main.append(page);
 const nav=el('a','Дайджест');nav.href='#digest';nav.className='nav-item';
 const rail=document.querySelector('.rail');rail.insertBefore(nav,rail.querySelector('.history'));
 let loaded=false, pending=false;
 async function show(){
  if(loaded||pending)return;
  pending=true;
  const status=el('p','Загружаю шаблоны…');status.setAttribute('role','status');
  page.replaceChildren(el('h1','Дайджест'),status);
  try{
   const data=await post({action:'list'});setup(data,status);loaded=true;
  }catch(error){
   status.textContent=error.message;
   const retry=el('button','Повторить');retry.onclick=show;page.append(retry);
  }finally{pending=false;}
 }
 function setup(data,status){
  status.textContent='';
  const year=data.latest?.slice(0,4)||String(new Date().getFullYear());
  const presets=[defaults(year),{...defaults(year,['events','sends','answers']),type:'overview',chart:'bar'}];
  let templates=data.templates, active=null, pages=null;
  const picker=el('select'),pickLabel=el('label','Шаблон'),form=el('form'),controls=el('div'),preview=el('section');
  picker.setAttribute('aria-label','Шаблон');pickLabel.append(picker);
  form.className='digest-fields';controls.className='workflow-controls';preview.className='digest-preview';
  const fields={};
  function field(key,label,options=null,type='text'){
   const labelNode=el('label',label),control=el(options?'select':'input');
   control.setAttribute('aria-label',label);
   if(options)for(const [value,text] of options)control.add(new Option(text,value));
   else control.type=type;
   labelNode.append(control);form.append(labelNode);fields[key]=control;
  }
  field('name','Название шаблона');fields.name.required=true;fields.name.maxLength=120;
  field('start','Период с',null,'date');field('end','Период по',null,'date');fields.start.required=fields.end.required=true;
  field('ids','Номера опросов');fields.ids.placeholder='Например, 1007, 3155';fields.ids.maxLength=500;
  field('channel','Канал',[['','Все каналы'],...Object.entries(channels)]);
  field('product','Продукт',[['','Все продукты'],...[...new Set(data.surveys.flatMap(s=>s.products))].sort().map(x=>[x,x])]);
  field('top','Только топ-опросы',null,'checkbox');
  field('type','Тип презентации',Object.entries(names));
  field('layout','Графиков на странице',['1','2','4','6'].map(n=>[n,n]));
  field('chart','Формат графиков',[['line','Линии'],['bar','Столбцы и линия CSI']]);
  field('theme','Оформление',[['light','Светлое'],['dark','Тёмное']]);
  field('format','Формат выгрузки',[['pptx','Редактируемый PPTX'],['png','PNG страниц'],['xlsx','Excel с данными']]);
  const metricBox=el('fieldset');metricBox.append(el('legend','Показатели'));
  for(const [key,text] of Object.entries(labels)){
   const label=el('label',text),check=el('input');check.type='checkbox';check.value=key;label.prepend(check);metricBox.append(label);
  }
  form.append(metricBox);
  const match=el('p');match.setAttribute('role','status');
  const run=el('button','Сформировать презентацию');run.type='submit';form.append(run);
  function read(){
   return {...Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,key==='top'?field.checked:field.value])),
    metrics:[...metricBox.querySelectorAll('input:checked')].map(field=>field.value)};
  }
  function showMatch(){
   const d=read(),ids=d.ids.split(/[\s,;]+/).filter(Boolean);
   const count=data.surveys.filter(s=>(!ids.length||ids.includes(String(s.id)))&&(!d.channel||d.channel===s.channel)
    &&(!d.product||s.products.includes(d.product))&&(!d.top||s.top)).length;
   match.textContent='Опросов в отборе: '+count+' · наличие данных проверяется за выбранный период';
  }
  function selectTemplate(value){
   const found=templates.find(t=>t.id===value);
   active=found?.id||null;
   const {id,...definition}=found||presets[Number(value.slice(-1))]||presets[0];
   fill(definition);
  }
  function fill(definition){
   for(const [key,field] of Object.entries(fields)){
    if(key==='top')field.checked=definition[key];
    else{
     if(key==='product'&&definition[key]&&![...field.options].some(o=>o.value===definition[key]))field.add(new Option(definition[key],definition[key]));
     field.value=definition[key];
    }
   }
   for(const input of metricBox.querySelectorAll('input'))input.checked=definition.metrics.includes(input.value);
   invalidate();showMatch();
  }
  function refreshPicker(value='preset0'){
   picker.replaceChildren(...presets.map((d,i)=>new Option(d.name,'preset'+i)),...templates.map(d=>new Option(d.name,d.id)));
   picker.value=value;
  }
  function invalidate(){pages=null;preview.replaceChildren();remove.disabled=!active;}
  function button(title,fn){const b=el('button',title);b.type='button';b.onclick=fn;controls.append(b);return b;}
  async function work(control,fn){
   control.disabled=true;status.textContent='Выполняю…';
   try{await fn();}catch(error){status.textContent=error.message;}finally{control.disabled=false;remove.disabled=!active;}
  }
  button('Новый шаблон',()=>{active=null;picker.selectedIndex=-1;fill({...presets[0],name:''});fields.name.focus();});
  button('Сохранить шаблон',e=>work(e.currentTarget,async()=>{
   const saved=await post({action:'save',id:active,definition:read()});
   templates=[saved,...templates.filter(x=>x.id!==saved.id)];active=saved.id;refreshPicker(active);status.textContent='Шаблон сохранён в проекте.';
  }));
  const remove=button('Удалить шаблон',e=>{
   if(!confirm('Удалить выбранный шаблон?'))return;
   work(e.currentTarget,async()=>{
    await post({action:'delete',id:active});templates=templates.filter(x=>x.id!==active);refreshPicker();selectTemplate('preset0');status.textContent='Шаблон удалён.';
   });
  });
  button('Скачать шаблон JSON',()=>window.MeetingExports.saveBlob(new Blob([JSON.stringify({version:1,definition:read()},null,2)],{type:'application/json'}),'digest-template.json'));
  const imported=el('input'),importLabel=el('label','Открыть шаблон JSON');imported.type='file';imported.accept='.json,application/json';
  importLabel.append(imported);controls.append(importLabel);
  imported.onchange=async()=>{
   try{
    const file=imported.files[0];if(!file)return;
    if(file.size>16000)throw new Error('Файл шаблона слишком большой.');
    const data=JSON.parse(await file.text());if(data.version!==1)throw new Error('Нужен JSON шаблона дайджеста версии 1.');
    const saved=await post({action:'validate',definition:data.definition});
    active=null;picker.selectedIndex=-1;fill(saved);status.textContent='Шаблон открыт. Можно сохранить его в проекте.';
   }catch(error){status.textContent=error.message;}finally{imported.value='';}
  };
  picker.onchange=()=>selectTemplate(picker.value);
  form.oninput=()=>{invalidate();showMatch();};
  form.onsubmit=e=>{e.preventDefault();work(run,async()=>{
   const definition=read(),submitted=JSON.stringify(definition);
   const result=await post({action:'run',definition});await document.fonts.ready;
   if(submitted!==JSON.stringify(read()))return;
   pages=makePages(result,definition);
   const rendered=pages.map((p,index)=>window.PresentationRender.render(p,{scale:.48,pageNumber:index+1,pageCount:pages.length}));
   const error=rendered.findIndex(r=>r.errors.length);
   if(error>=0){pages=null;throw new Error('Страница '+(error+1)+'. '+rendered[error].errors.join(' '));}
   const heading=el('h2','Предпросмотр'),which=el('select'),output=el('div'),save=el('button','Скачать '+({pptx:'PPTX',png:'PNG',xlsx:'Excel'}[definition.format]));
   which.setAttribute('aria-label','Страница предпросмотра');
   rendered.forEach((_,i)=>which.add(new Option('Страница '+(i+1)+' из '+rendered.length,String(i))));
   function draw(){const index=Number(which.value),canvas=rendered[index].canvas;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',pages[index].title);output.replaceChildren(canvas);}
   which.onchange=draw;
   save.type='button';save.onclick=()=>work(save,()=>exportPages(pages,definition.format,status));
   preview.replaceChildren(heading,which,save,output);draw();
   status.textContent='Готово · '+pages.length+' стр. · версия данных '+result.revision;
  });};
  page.append(pickLabel,controls,form,match,preview);
  refreshPicker();selectTemplate('preset0');
 }
 return {page,show};
}
async function exportPages(pages,format,status){
 const office=window.PresentationOffice,exports=window.MeetingExports;
 if(format==='pptx'){
  exports.saveBlob(await office.powerPoint(pages,(page,index)=>window.PresentationRender.render(page,{editable:true,pageNumber:index+1,pageCount:pages.length}),
   {notes:page=>[page.subtitle,page.footer,'CSI взвешен по числу оценок 1–5.'].join('\n')}),'digest.pptx');
 }else if(format==='xlsx'){
  exports.saveBlob(await office.workbook(pages),'digest.xlsx');
 }else{
  const files=[];
  for(const [index,page] of pages.entries()){
   const {canvas}=window.PresentationRender.render(page,{scale:2,pageNumber:index+1,pageCount:pages.length});
   files.push({name:'page-'+String(index+1).padStart(2,'0')+'.png',bytes:new Uint8Array(await (await exports.blobOf(canvas)).arrayBuffer())});
  }
  exports.saveBlob(exports.zip(files),'digest-png.zip');
 }
 status.textContent='Файл готов к скачиванию.';
}
window.DigestUI={create,makeCard,defaults,channels};
})();
