(()=>{'use strict';
const clone=structuredClone,finite=Number.isFinite,nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),df=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}),signed=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2,signDisplay:'always'}),compact=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
const themes={light:{bg:'#f2f5f3',card:'#fffdf5',ink:'#14261b',muted:'#5b6e61',grid:'#d9e2da',accent:'#247347',series:['#247347','#559987','#46758c','#987b38','#856892','#7b926a']},dark:{bg:'#181818',card:'#272727',ink:'#ededed',muted:'#b5b5b5',grid:'#414141',accent:'#91c89e',series:['#91c89e','#72b9e6','#c3c8d0','#d5b278','#b59cbd','#79aa95']}};
function ratingSuffix(series,i){
 const n=series.passport?.[i]?.denominator;
 return finite(n)&&n>0?' · n='+nf.format(n):'';
}
function normalize(entry){entry=clone(entry);const c=entry.chart;if(c.status!=='ok'||!c.data)throw new Error('У графика нет рассчитанных данных.');if(c.kind==='ranking'){
  const {ranking,label,periodLabel,dataRevision}=c.data;
  const categories=ranking.winners.map((_,i)=>'rank-'+(i+1));
  const values=ranking.winners.map(row=>row.value);
  return {name:c.title,sourceTitle:c.title,kind:'ranking',periodLabel,revision:dataRevision,capturedAt:new Date().toISOString(),
   dates:categories,periodLabels:Object.fromEntries(categories.map((key,i)=>[key,'#'+ranking.winners[i].id+' · '+(ranking.winners[i].channel==='communication'?'Пуш':'Экран')])),
   series:[{key:ranking.metric+':ranking',label,metric:ranking.metric,unit:ranking.metric==='csi'?'csi':'count',type:'bar',values,default:true,
    ...(ranking.metric==='csi'?{passport:ranking.winners.map(row=>({denominator:row.ratings}))}:{})}]};
 }
 c.data=window.ChartAppearance.filterData(c.data);const d=c.data;
 const passports=window.MetricPassports.graphSeries(entry,d);
 const out={keepMissingPeriods:Boolean(d.keepMissingPeriods||d.spec?.grain==='week'),passport:window.MetricPassports.metadata(d,entry),name:entry.presentationTitle||c.title,sourceTitle:c.title,kind:c.kind||'monthly',channel:c.channel||d.channel||'',scope:d.spec?.filters||{},revision:d.dataRevision||d.contract?.dataRevision||d.revision||entry.revision||'',capturedAt:new Date().toISOString(),statusAssignments:clone(d.appearance?.statusAssignments||{}),uiEdited:Boolean(d.uiEdited),partial:Boolean(d.cutoffCoverage?.some(r=>r.status==='some_observed')),periodLabel:d.periodLabel||'',periodEnds:Object.fromEntries((d.periods||[]).filter(p=>p.end).map(p=>[p.start,p.end])),periodLabels:Object.fromEntries((d.periods||[]).map(p=>[p.start,p.short])),dates:[],series:[]};
 if(c.kind==='daily-csi'){
  out.dates=d.days.map(v=>v.date);out.series=[{key:'csi:1007',label:'CSI',metric:'csi',unit:'csi',type:'bar',values:d.days.map(v=>v.csi),default:true},{key:'ratings:1007',label:'Всего оценок 1–5',metric:'ratings',unit:'count',type:'line',values:d.days.map(v=>v.hasRows?v.count:null),default:false}];
 }else{
  out.dates=[...d.months];const visible=entry.visibleKeys?new Set(entry.visibleKeys):null,metrics=entry.visible?new Set(entry.visible):null;
  for(const b of d.blocks){const composition=c.kind==='events-breakdown',lineKey=d.breakdownLineMetric||'sends',partKeys=d.breakdownParts||['sends','stop','contactPolicy'];if(composition&&b.metric!==lineKey&&!partKeys.includes(b.metric))continue;const roles=composition&&b.metric===lineKey&&partKeys.includes(b.metric)?['line','stack']:[composition&&partKeys.includes(b.metric)?'stack':'line'];for(const role of roles){const breakdown=role==='stack',key=b.metric+':'+b.id+(roles.length>1&&role==='line'?':line':'');out.series.push({key,label:b.label+(roles.length>1?(role==='line'?' · линия':' · столбцы'):'')+(d.spec?.ids?.length>1?' #'+b.id:''),metric:b.metric,unit:breakdown?'percent':b.metric==='csi'?'csi':b.metric==='responseRate'?'percent':'count',type:breakdown?'stack':(c.kind==='survey-bars'||d.visual?.type==='bars')&&b.metric!=='csi'?'bar':'line',values:clone(breakdown?b.ratio.values:b.values),counts:b.metric==='responseRate'?[]:clone(b.values),ratioBase:(b.ratio||b.sendRatio)?.baseMetric||'sends',ratios:clone((b.ratio||b.sendRatio)?.values||[]),partial:b.coverage?.map(r=>r.status==='some_observed')||[],default:composition?true:visible?visible.has(b.metric+':'+b.id):metrics?metrics.has(b.metric):b.enabled!==false&&b.available!==false});}}

 }
 for(const series of out.series){const key=series.key.replace(/:line$/,'');series.passport=passports[key]||passports[series.metric];}
 if(out.name.length>280)out.name=out.name.slice(0,277)+'…';if(!out.dates.length||!out.series.length)throw new Error('В графике нет временного ряда.');return out;
}
function newCard(entry,sourceRef){const graph=normalize(entry),selected=graph.series.filter(s=>s.default).map(s=>s.key);if(!selected.length)throw new Error('Включите хотя бы один показатель исходного графика.');validateGraph(graph);return{id:crypto.randomUUID(),sourceRef,graph,title:graph.name,selected,headline:selected.find(key=>graph.series.find(s=>s.key===key)?.metric===entry.chart.data.breakdownLineMetric)||selected.find(key=>graph.series.find(s=>s.key===key)?.unit==='csi')||selected[0]||graph.series[0].key,start:graph.dates[0],end:graph.dates.at(-1),baseline:graph.dates[0],style:'auto',labels:graph.kind==='ranking'?'all':'key',zoomCSI:false,valueMode:entry.chart.data.appearance?.valueMode||'both',colors:Object.fromEntries(Object.entries(entry.chart.data.appearance?.colors||{}).filter(([,v])=>typeof v==='string')),excludedDates:[],numberFormat:entry.chart.data.appearance?.numberFormat||'auto',numberDecimals:entry.chart.data.appearance?.numberDecimals??1,hiddenShares:clone(entry.chart.data.appearance?.hiddenShares||[])};}
function validateGraph(g){
 if(!g||typeof g!=='object'||typeof g.name!=='string'||g.name.length>500||!Array.isArray(g.dates)||!g.dates.length||g.dates.length>2000||!Array.isArray(g.series)||!g.series.length||g.series.length>32)throw new Error('Некорректные данные графика в проекте.');
 if(g.kind==='ranking'?g.dates.some((date,i)=>date!=='rank-'+(i+1)):g.dates.some((date,i)=>typeof date!=='string'||!/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(date)||i&&date<=g.dates[i-1]))throw new Error('Даты графика должны идти по порядку без повторов.');
 if(g.periodLabels&&(typeof g.periodLabels!=='object'||Array.isArray(g.periodLabels)||Object.entries(g.periodLabels).some(([key,value])=>!g.dates.includes(key)||typeof value!=='string'||value.length>80)))throw new Error('Некорректные подписи периодов.');const keys=new Set();for(const s of g.series){if(!s||typeof s.key!=='string'||keys.has(s.key)||typeof s.label!=='string'||s.label.length>300||!['csi','percent','count'].includes(s.unit)||s.type!==undefined&&!['line','bar','stack'].includes(s.type)||s.type==='stack'&&s.unit!=='percent'||!Array.isArray(s.values)||s.values.length!==g.dates.length||s.values.some(v=>v!==null&&(!finite(v)||v<0||s.unit==='csi'&&(v<1||v>5))))throw new Error('Некорректные значения ряда графика.');for(const key of ['counts','ratios'])if(s[key]!==undefined&&(!Array.isArray(s[key])||s[key].length!==g.dates.length&&s[key].length!==0||s[key].some(v=>v!==null&&(!finite(v)||v<0))))throw new Error('Некорректные значения количеств или долей.');keys.add(s.key);}
}
const isImage=card=>card.kind==='image';
const pngData=/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+=*$/;
function validImage(card){return typeof card.id==='string'&&typeof card.title==='string'&&card.title.length<=300&&typeof card.data==='string'&&card.data.length<=4_200_000&&pngData.test(card.data);}
function validateDocument(doc){
 if(doc?.format!=='genui-presentation-pages'||doc.version!==1||!Array.isArray(doc.pages)||doc.pages.length>30)throw new Error('Нужен JSON проекта презентационных страниц версии 1.');
 const ids=new Set();for(const p of doc.pages){if(!p||typeof p.id!=='string'||ids.has(p.id)||!['grid','one','two'].includes(p.layout)||!['light','dark'].includes(p.theme)||typeof p.title!=='string'||p.title.length>240||typeof p.subtitle!=='string'||p.subtitle.length>600||typeof p.footer!=='string'||p.footer.length>600||!Array.isArray(p.cards)||p.cards.length>6||!Array.isArray(p.notes)||p.notes.length>3||!Array.isArray(p.kpis)||p.kpis.length>3)throw new Error('Некорректная страница презентации.');ids.add(p.id);
  if(p.template!==undefined&&!Object.hasOwn(window.PresentationLayouts.templates,p.template))throw new Error('Неизвестный шаблон страницы.');
  if(p.marker!==undefined&&(!p.marker||typeof p.marker.date!=='string'||p.marker.date.length>10||typeof p.marker.text!=='string'||p.marker.text.length>160))throw new Error('Некорректная отметка периода.');
  if(p.table){if(typeof p.table.enabled!=='boolean'||typeof p.table.title!=='string'||p.table.title.length>120||!Array.isArray(p.table.headers)||p.table.headers.length!==3||p.table.headers.some(v=>typeof v!=='string'||v.length>80)||!Array.isArray(p.table.rows)||p.table.rows.length>6||p.table.rows.some(row=>!Array.isArray(row)||row.length!==3||row.some(v=>typeof v!=='string'||v.length>80)))throw new Error('Некорректная таблица страницы.');}
  for(const n of p.notes)if(typeof n.heading!=='string'||n.heading.length>120||typeof n.body!=='string'||n.body.length>2500)throw new Error('Некорректный текстовый блок.');for(const k of p.kpis)for(const key of ['label','value','detail'])if(typeof k[key]!=='string'||k[key].length>400)throw new Error('Некорректный KPI.');
  for(const card of p.cards){if(isImage(card)){if(!validImage(card))throw new Error('Некорректное изображение PNG.');continue;}validateGraph(card.graph);if(card.numberFormat!==undefined&&!['auto','full','thousands','millions'].includes(card.numberFormat)||card.numberDecimals!==undefined&&![0,1,2].includes(card.numberDecimals)||card.hiddenShares!==undefined&&(!Array.isArray(card.hiddenShares)||card.hiddenShares.length>64||card.hiddenShares.some(k=>typeof k!=='string'||k.length>200)))throw new Error('Некорректный формат чисел графика.');if(card.valueMode!==undefined&&!['absolute','percent','both'].includes(card.valueMode)||card.excludedDates!==undefined&&(!Array.isArray(card.excludedDates)||card.excludedDates.some(d=>!card.graph.dates.includes(d)))||card.colors!==undefined&&(typeof card.colors!=='object'||card.colors===null||Array.isArray(card.colors)||Object.values(card.colors).some(v=>typeof v!=='string'||!/^#[0-9a-f]{6}$/i.test(v))))throw new Error('Некорректное оформление графика.');if(typeof card.id!=='string'||typeof card.title!=='string'||card.title.length>300||!Array.isArray(card.selected)||card.selected.some(k=>!card.graph.series.some(s=>s.key===k))||!card.graph.series.some(s=>s.key===card.headline)||!['auto','line','bar'].includes(card.style)||!['key','all','none'].includes(card.labels)||!card.graph.dates.includes(card.start)||!card.graph.dates.includes(card.end)||!card.graph.dates.includes(card.baseline))throw new Error('Некорректные настройки графика.');}
 }return clone(doc);
}
function render(page,{scale=1,pageNumber=1,pageCount=1,editable=false,images=new Map()}={}){
 const canvas=document.createElement('canvas');canvas.width=1920*scale;canvas.height=1080*scale;const c=canvas.getContext('2d'),t=themes[page.theme]||themes.light,face=getComputedStyle(document.body).fontFamily||'sans-serif',errors=[],scene=[];let capture=editable;c.scale(scale,scale);c.fillStyle=t.bg;c.fillRect(0,0,1920,1080);
 const font=(size,bold=false)=>{c.font=(bold?'600 ':'')+size+'px '+face;};
 function text(str,x,y,size=18,color=t.ink,align='left',bold=false){
  const value=String(str);font(size,bold);c.textAlign=align;c.fillStyle=color;c.fillText(value,x,y);
  if(capture&&value)scene.push({kind:'text',value,x,y,size,color,align,bold,width:c.measureText(value).width});
 }
 function line(x1,y1,x2,y2,color=t.grid,width=1){
  c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke();
  if(capture)scene.push({kind:'line',x1,y1,x2,y2,color,width});
 }
 function wrap(str,max,size,bold=false){font(size,bold);const out=[];for(const paragraph of String(str).split('\n')){let current='';for(const word of paragraph.split(/\s+/).filter(Boolean)){const next=current?current+' '+word:word;if(current&&c.measureText(next).width>max){out.push(current);current=word;}else current=next;}out.push(current);}return out;}
 function block(str,x,y,w,maxLines,size,color=t.ink,bold=false,label='Текст'){let chosen=size,rows=wrap(str,w,chosen,bold);for(const step of [size,...[48,36,30,24,20,18,16,14].filter(v=>v<size&&v>=(label==='Заголовок страницы'?30:label==='Название графика'?18:14))]){chosen=step;rows=wrap(str,w,chosen,bold);if(rows.length<=maxLines)break;}font(chosen,bold);if(rows.some(row=>c.measureText(row).width>w))errors.push(label+': слишком длинное слово. Разбейте его пробелами.');if(rows.length>maxLines)errors.push(label+': текст не помещается. Сократите его или выберите другой макет.');rows.slice(0,maxLines).forEach((row,i)=>text(row,x,y+i*(chosen+8),chosen,color,'left',bold));return Math.min(rows.length,maxLines)*(chosen+8);}
 function panel(x,y,w,h){
  c.fillStyle=t.card;c.beginPath();c.roundRect(x,y,w,h,12);c.fill();
  if(page.template&&page.template!=='classic'){c.strokeStyle=t.grid;c.lineWidth=1;c.stroke();}
  if(capture)scene.push({kind:'panel',x,y,w,h,color:t.card,border:page.template&&page.template!=='classic'?t.grid:null});
 }
 function imageCard(card,{x,y,w,h}){
  panel(x,y,w,h);const titleHeight=card.title?block(card.title,x+24,y+36,w-48,2,24,t.ink,true,'Название PNG'):0;
  const image=images.get(card.data);
  if(!image){errors.push('Не удалось открыть PNG «'+card.title+'».');return;}
  const space={x:x+22,y:y+24+titleHeight,w:w-44,h:h-48-titleHeight};
  const ratio=Math.min(space.w/image.naturalWidth,space.h/image.naturalHeight);
  const width=image.naturalWidth*ratio,height=image.naturalHeight*ratio;
  const left=space.x+(space.w-width)/2,top=space.y+(space.h-height)/2;
  c.drawImage(image,left,top,width,height);
  if(capture)scene.push({kind:'image',data:card.data,x:left,y:top,w:width,h:height});
 }
 const result=()=>({canvas,errors:[...new Set(errors)],scene,background:t.bg});
 if(page.template&&page.template!=='classic'){
  window.PresentationLayouts.report(page,{text,block,line,panel,font,chart,imageCard,theme:t,errors,pageNumber,pageCount});
  return result();
 }
 const pageTitle=page.pngOptions?.title??page.title;if(!pageTitle.trim())errors.push('Задайте заголовок страницы.');const titleHeight=block(pageTitle||'Название страницы',80,86,1760,2,48,t.ink,true,'Заголовок страницы'),subtitleHeight=page.subtitle?block(page.subtitle,80,98+titleHeight,1760,2,22,t.muted,false,'Подзаголовок'):0,top=Math.max(192,118+titleHeight+subtitleHeight),bottom=960,gap=24;
 const maxCards=page.layout==='grid'?6:page.layout==='one'?1:2;if(!page.cards.length)errors.push('Добавьте хотя бы один график.');if(page.cards.length>maxCards)errors.push('В этом макете не хватает мест. Удалите лишние графики или выберите сетку.');
 const cards=page.cards.slice(0,maxCards),rects=[];
 if(page.layout==='grid'){const cols=cards.length<=2?Math.max(1,cards.length):cards.length===4?2:3,rows=Math.ceil(cards.length/cols)||1,w=(1760-gap*(cols-1))/cols,h=(bottom-top-gap*(rows-1))/rows;cards.forEach((card,i)=>rects.push({x:80+(i%cols)*(w+gap),y:top+Math.floor(i/cols)*(h+gap),w,h}));}
 else{const w=1248,h=(bottom-top-(page.layout==='two'?gap:0))/(page.layout==='two'?2:1);cards.forEach((card,i)=>rects.push({x:80,y:top+i*(h+gap),w,h}));drawSidebar(1352,top,488,bottom-top);}
 function drawSidebar(x,y,w,h){
  const blocks=page.kpis.filter(k=>k.label||k.value||k.detail).map(k=>({kind:'kpi',...k})).concat(page.notes.filter(n=>n.heading||n.body).map(n=>({kind:'note',...n})));if(page.table?.enabled)blocks.push({kind:'table',...page.table});if(!blocks.length){errors.push('Для макета с выводами заполните текстовый блок или KPI.');return;}
  let cy=y;for(const b of blocks){if(b.kind==='table'){
   const rows=b.rows.filter(row=>row.some(v=>v.trim()));if(!rows.length)errors.push('Заполните хотя бы одну строку таблицы.');const titleRows=b.title?wrap(b.title,w-48,22,true):[],rowHeight=50,bh=48+titleRows.length*30+48+rowHeight*rows.length;if(cy+bh>y+h){errors.push('Таблица не помещается справа. Уменьшите число строк или перенесите её на другую страницу.');break;}panel(x,cy,w,bh);let yy=cy+32;if(b.title){block(b.title,x+24,yy,w-48,2,22,t.ink,true,'Заголовок таблицы');yy+=titleRows.length*30;}const cw=(w-48)/3;b.headers.forEach((v,i)=>block(v,x+24+i*cw,yy,cw-12,2,16,t.muted,true,'Столбец таблицы'));yy+=48;for(const row of rows){line(x+24,yy-12,x+w-24,yy-12);row.forEach((v,i)=>block(v,x+24+i*cw,yy,cw-12,2,16,t.ink,false,'Ячейка таблицы'));yy+=rowHeight;}cy+=bh+16;continue;
  }const heading=b.kind==='kpi'?b.label:b.heading,rows=wrap(b.kind==='kpi'?b.detail:b.body,w-48,20),headingRows=wrap(heading,w-48,22,true),bh=24+headingRows.length*30+(b.kind==='kpi'&&b.value?76:0)+rows.length*28+24;if(cy+bh>y+h){errors.push('Боковые выводы не помещаются. Сократите текст или перенесите часть на другую страницу.');break;}panel(x,cy,w,bh);let yy=cy+34;block(heading,x+24,yy,w-48,2,22,t.ink,true,'Заголовок вывода');yy+=headingRows.length*30;if(b.kind==='kpi'&&b.value){block(b.value,x+24,yy+20,w-48,1,36,t.accent,true,'Значение KPI');yy+=76;}for(const row of rows){text(row,x+24,yy,20,t.muted);yy+=28;}cy+=bh+16;}
 }
 function chart(card,rect,reportOptions=null){
  const number=v=>window.ChartAppearance.formatNumber(v,card),showShare=key=>window.ChartAppearance.shareVisible(card,key);
  const {x,y,w,h}=rect,g=card.graph,{first:a,end:b,composition,mode,dates,series:ss,headline}=window.PresentationLayouts.selectData(card);
  const colorOf=(s,j)=>card.colors?.[s.key]||card.colors?.[s.metric]||reportOptions?.palette[s.metric]||t.series[j%t.series.length];
  panel(x,y,w,h);
  if(headline.unit==='percent'&&!showShare(card.headline)){headline.values=[...headline.counts];headline.unit='count';}
  if(!ss.length){errors.push('Выберите показатели для графика «'+card.title+'».');return;}if(!reportOptions&&page.layout==='grid'&&ss.length>3)errors.push('Для сетки оставьте до трёх показателей в графике «'+card.title+'».');
  if(a<0||b<=a){errors.push('Начало диапазона должно быть не позже конца в «'+card.title+'».');return;}if(!dates.length){text('Нет наблюдений в выбранном диапазоне',x+24,y+64,18,t.muted);errors.push('Нет данных для «'+card.title+'». Включите период с наблюдениями.');return;}const last=headline.values.findLastIndex(finite),base=dates.indexOf(card.baseline),latest=last>=0?headline.values[last]:null,baseline=headline.values[base],delta=finite(latest)&&finite(baseline)?['csi','percent'].includes(headline.unit)?latest-baseline:baseline!==0?(latest/baseline-1)*100:null:null;
  const ranking=g.kind==='ranking',titleWidth=reportOptions||ranking?w-48:w-184;const headingH=block(card.title,x+24,y+36,Math.max(160,titleWidth),2,24,t.ink,true,'Название графика');
  const span=ranking?g.periodLabel:window.PresentationLayouts.range(card,dates);
  if(span)text(span,x+24,y+headingH+38,15,t.muted);
  if(!reportOptions&&!ranking){text(finite(latest)?headline.unit==='csi'?df.format(latest)+ratingSuffix(headline,last):headline.unit==='percent'?df.format(latest)+'%':number(latest):'Нет данных',x+w-24,y+42,headline.unit==='csi'&&ratingSuffix(headline,last)?22:32,t.ink,'right',true);text(finite(delta)?signed.format(delta)+(headline.unit==='csi'?' балла':headline.unit==='percent'?' п.п.':'%'):'Нет сравнения',x+w-24,y+74,18,t.accent,'right');const shortDate=date=>date?.length===10?date.slice(8)+'.'+date.slice(5,7):date?new Intl.DateTimeFormat('ru-RU',{month:'short',timeZone:'UTC'}).format(new Date(date+'-01T12:00:00Z')).slice(0,3)+' '+date.slice(2,4):'—';text(last>=0?shortDate(dates[last])+' · база '+shortDate(dates[base]):'Нет наблюдений',x+w-24,y+98,12,t.muted,'right');}
  const legendY=y+(reportOptions?Math.max(92,headingH+64):Math.max(112,headingH+64));let lx=x+24,ly=legendY;for(let j=0;j<ss.length;j++){const s=ss[j],color=colorOf(s,j),caption=s.label+(s.unit==='percent'&&s.metric!=='responseRate'?' · % '+(s.ratioBase==='sends'?'отправок':'событий'):'');font(14);const tw=c.measureText(caption).width+44;if(tw>w-48)errors.push('Подпись показателя не помещается в «'+card.title+'». Выберите более крупный макет.');if(lx+tw>x+w-24){lx=x+24;ly+=24;}line(lx,ly-5,lx+24,ly-5,color,3);text(caption,lx+32,ly,14,color);lx+=tw;}
  font(12);const leftMargin=reportOptions?44:Math.max(72,...ss.filter(s=>s.unit==='count'&&(!composition||s.type==='stack')).flatMap(s=>s.values).filter(finite).map(v=>c.measureText(number(v)).width+20));const rightMargin=reportOptions?44:composition?32:56;const plotLeft=x+leftMargin,plotRight=x+w-rightMargin,regionTop=ly+32,plotBottom=y+h-(reportOptions?.marker?.text?76:52),regionHeight=plotBottom-regionTop,bandTop=regionTop+24,bandBottom=bandTop+Math.min(80,regionHeight*.2),plotTop=composition?bandBottom+48:regionTop,pw=plotRight-plotLeft,ph=plotBottom-plotTop;if(ph<(composition?60:90)){errors.push('Не хватает места для графика «'+card.title+'». Уменьшите заголовок или число показателей.');return;}
  const onlyCSI=ss.every(s=>s.unit==='csi'),hasCSI=ss.some(s=>s.unit==='csi'),hasCount=ss.some(s=>s.unit==='count'),countValues=ss.filter(s=>s.unit==='count').flatMap(s=>s.values).filter(finite),percentValues=ss.filter(s=>s.unit==='percent').flatMap(s=>s.values).filter(finite),maximum=composition?Math.max(1,...ss.filter(s=>s.type!=='stack').flatMap(s=>s.values).filter(finite)):Math.max(1,...countValues,...dates.map((_,i)=>ss.filter(s=>s.type==='stack'&&s.unit==='count').reduce((sum,s)=>sum+(s.values[i]??0),0))),csiValues=ss.filter(s=>s.unit==='csi').flatMap(s=>s.values).filter(finite),csiBar=card.style==='auto'&&ss.some(s=>s.unit==='csi'&&s.type==='bar'),cmin=csiBar?0:card.zoomCSI&&csiValues.length?Math.max(1,Math.floor((Math.min(...csiValues)-.05)*20)/20):1,cmax=!csiBar&&card.zoomCSI&&csiValues.length?Math.min(5,Math.ceil((Math.max(...csiValues)+.05)*20)/20):5,pmax=composition?Math.max(mode==='absolute'?1:100,...dates.map((_,i)=>ss.filter(s=>s.type==='stack').reduce((sum,s)=>sum+(s.values[i]??0),0))):Math.max(100,...percentValues,...dates.map((_,i)=>ss.filter(s=>s.unit==='percent'&&s.type==='stack').reduce((sum,s)=>sum+(s.values[i]??0),0))),xx=i=>plotLeft+pw*(i+.5)/dates.length;
  const useAxis=!reportOptions;
  const wasCapture=capture;capture=false;
  const yy=(v,s)=>composition?s.type==='stack'?plotBottom-ph*v/pmax:bandBottom-(bandBottom-bandTop)*v/maximum:plotBottom-ph*(s.unit==='csi'?(v-cmin)/Math.max(.05,cmax-cmin):s.unit==='percent'?v/pmax:v/maximum),axis=composition?(mode==='absolute'?'Столбцы, шт.':'Столбцы · доли, %'):onlyCSI?'CSI '+df.format(cmin)+'–'+df.format(cmax):hasCount?'Количество':'Доля, %';if(useAxis)text(axis,plotLeft,plotTop-12,12,t.muted);if(composition)text('Линия · количество у точек · без оси',plotLeft,regionTop-12,12,t.muted);else if(useAxis&&!onlyCSI&&hasCSI)text('CSI '+df.format(cmin)+'–'+df.format(cmax),plotRight,plotTop-12,12,t.muted,'right');else if(useAxis&&hasCount&&percentValues.length)text('Доли, %',plotRight,plotTop-12,12,t.muted,'right');
  if(useAxis)for(let n=0;n<=4;n++){const py=plotBottom-ph*n/4;if(composition){text(mode==='absolute'?number(pmax*n/4):df.format(pmax*n/4)+'%',plotLeft-10,py+4,12,t.muted,'right');continue;}text(onlyCSI?df.format(cmin+(cmax-cmin)*n/4):hasCount?number(maximum*n/4):df.format(pmax*n/4)+'%',plotLeft-10,py+4,12,t.muted,'right');if(!onlyCSI&&hasCSI)text(df.format(cmin+(cmax-cmin)*n/4),plotRight+10,py+4,12,t.muted);else if(hasCount&&percentValues.length)text(df.format(pmax*n/4)+'%',plotRight+10,py+4,12,t.muted);}
  if(ss.every(s=>s.values.every(v=>v===null)))text('Нет наблюдений в выбранном диапазоне',plotLeft+pw/2,plotTop+ph/2,18,t.muted,'center');const occupied=[],baseIndex=base;
  const isBar=s=>composition&&s.type!=='stack'?false:card.style==='bar'&&s.unit!=='csi'||card.style==='auto'&&(s.type==='bar'||s.type==='stack'),isStack=s=>s.type==='stack'&&card.style==='auto',barSeries=ss.filter(s=>isBar(s)&&!isStack(s)),labels=[];ss.map((s,j)=>({s,j})).sort((a,b)=>Number(isBar(b.s))-Number(isBar(a.s))).forEach(({s,j})=>{const color=colorOf(s,j),bar=isBar(s),stack=isStack(s),bw=Math.min(stack?104:40,pw/Math.max(1,dates.length)*.62/(stack?1:Math.max(1,barSeries.length))),format=v=>s.unit==='csi'?df.format(v):s.unit==='percent'?df.format(v)+'%':number(v);
   if(!bar){c.strokeStyle=color;c.lineWidth=3;window.ChartAppearance.stroke(c,s.values.map((v,i)=>v===null?null:[xx(i),yy(v,s)]));}
   s.values.forEach((v,i)=>{if(v===null)return;const px=bar&&!stack?xx(i)+(barSeries.indexOf(s)-(barSeries.length-1)/2)*bw:xx(i);let py=yy(v,s);if(bar){let bh=plotBottom-py;if(stack){const before=ss.slice(0,j).filter(k=>isStack(k)).reduce((sum,k)=>sum+(k.values[i]??0),0);const limit=composition?pmax:s.unit==='percent'?pmax:maximum;py=plotBottom-ph*(before+v)/limit;bh=ph*v/limit;}c.fillStyle=color;c.fillRect(px-bw/2,py,bw,Math.max(v===0?1:0,bh));}else{c.fillStyle=color;c.beginPath();c.arc(xx(i),py,3,0,Math.PI*2);c.fill();}
    const keyPoint=i===s.values.findIndex(finite)||i===s.values.findLastIndex(finite)||i===baseIndex;if(s.unit==='percent'&&mode==='percent'&&!showShare(s.key)||card.labels==='none'||card.labels==='key'&&!keyPoint&&!(composition&&s.type!=='stack'))return;labels.push({label:(s.unit==='csi'?format(v)+ratingSuffix(s,i):s.metric==='responseRate'?format(v):s.unit==='count'?number(v)+(mode==='both'&&showShare(s.key)&&finite(s.ratios[i])&&(!reportOptions||s.type==='stack')&&!(composition&&s.type!=='stack')?' ('+df.format(s.ratios[i])+'%)':''):!showShare(s.key)?mode==='percent'?'':number(s.counts[i]):mode==='both'&&finite(s.counts[i])?number(s.counts[i])+' ('+format(v)+')':format(v))+(s.partial?.[i]?'*':''),px,py,color,stack,bw,detached:composition&&s.type!=='stack',height:stack?ph*v/(composition?pmax:s.unit==='percent'?pmax:maximum):0});
   });
  });
  for(const item of labels){const {label,px,py,color,stack,bw,height,detached}=item,size=14;font(size);const tw=c.measureText(label).width,bx=Math.max(plotLeft,Math.min(plotRight-tw,px-tw/2));if(detached){text(label,bx,py-12,size,color);continue;}if(stack&&height>=22&&tw<=bw-4){text(label,px,py+height/2+5,size,window.ChartAppearance.ink(color),'center');continue;}if(stack&&height>=42){const pair=label.match(/^(.*) \(([^)]+)\)(\*?)$/);if(pair&&pair.slice(1,3).every(v=>c.measureText(v).width<=bw-4)){text(pair[1],px,py+height/2-3,size,window.ChartAppearance.ink(color),'center');text(pair[2]+pair[3],px,py+height/2+15,size,window.ChartAppearance.ink(color),'center');continue;}}let placed=false;for(const shift of [-12,22,-34,44,-56,66,-78,88]){const by=py+shift,box={x:bx,y:by-14,w:tw,h:18};if(by<plotTop-1||by>plotBottom-8||occupied.some(k=>box.x<k.x+k.w+4&&box.x+box.w+4>k.x&&box.y<k.y+k.h+4&&box.y+box.h+4>k.y))continue;c.fillStyle=t.card;c.fillRect(bx-3,by-15,tw+6,19);text(label,bx,by,size,color);occupied.push(box);placed=true;break;}if(!placed&&card.labels==='all')errors.push('Все подписи не помещаются в «'+card.title+'». Выберите ключевые точки или сократите период.');}
  const dateLabel=date=>reportOptions?window.PresentationLayouts.period(g,date):g.periodLabels?.[date]||(date.length===10?date.slice(8)+'.'+date.slice(5,7):new Intl.DateTimeFormat('ru-RU',{month:'short',timeZone:'UTC'}).format(new Date(date+'-01T12:00:00Z')));font(12);const finalLeft=xx(dates.length-1)-c.measureText(dateLabel(dates.at(-1))).width/2;let edge=-Infinity;for(let i=0;i<dates.length;i++){if(page.pngOptions?.showXAxis===false)break;const label=dateLabel(dates[i]);font(12);const tw=c.measureText(label).width,bx=xx(i)-tw/2;if(i!==dates.length-1&&(bx<edge+10||bx+tw>finalLeft-10))continue;text(label,xx(i),plotBottom+28,12,t.muted,'center');edge=bx+tw;}
  capture=wasCapture;
  if(capture){
   const data=ss.map((s,j)=>({...s,color:colorOf(s,j),renderType:isStack(s)?'stack':isBar(s)?'bar':'line'}));
   const chartConfig={kind:'chart',card,labels:dates.map(dateLabel),dates,data,
    background:t.card,ink:t.ink,muted:t.muted,showCategory:page.pngOptions?.showXAxis!==false,
    showAxis:useAxis,cmin,cmax,maximum,pmax};
   if(composition){
    const upper=data.filter(s=>s.type!=='stack'),lower=data.filter(s=>s.type==='stack');
    const plot=reportOptions?{x:24/(pw+48),w:pw/(pw+48)}:undefined;
    if(upper.length)scene.push({...chartConfig,plot,data:upper,x:plotLeft-24,y:regionTop-16,w:pw+48,h:bandBottom-regionTop+30,showAxis:false,showCategory:false,detached:true});
    if(lower.length)scene.push({...chartConfig,plot,data:lower,x:plotLeft-24,y:plotTop-19,w:pw+48,h:ph+57});
   }else{
    const plot=reportOptions?{x:27/(pw+54),w:pw/(pw+54)}:undefined;
    scene.push({...chartConfig,plot,x:plotLeft-27,y:regionTop-19,w:pw+54,h:ph+57});
   }
  }
  if(reportOptions?.marker?.text&&dates.includes(reportOptions.marker.date)){
   const markerX=xx(dates.indexOf(reportOptions.marker.date));
   line(markerX,regionTop+8,markerX,plotBottom+4,t.accent,2);
   font(18,true);
   const width=Math.min(w-70,c.measureText(reportOptions.marker.text).width+28);
   const left=Math.max(x+22,Math.min(x+w-22-width,markerX-width/2));
   panel(left,plotBottom+36,width,32);
   block(reportOptions.marker.text,left+12,plotBottom+58,width-24,1,18,t.accent,true,'Отметка периода');
  }
 }
 cards.forEach((card,i)=>isImage(card)?imageCard(card,rects[i]):chart(card,rects[i]));if(!cards.length){panel(80,top,1760,bottom-top);text('Добавьте графики из проекта',960,(top+bottom)/2,32,t.muted,'center');}
 const foot=[page.footer,page.cards.some(k=>k.graph?.uiEdited)?'Графики содержат ручные правки':'Снимки графиков проекта',page.cards.some(k=>k.graph?.partial)?'* Отсечения по найденным строкам':''].filter(Boolean).join(' · ');if(page.pngOptions?.showFootnotes!==false)block(foot,80,1012,1640,2,16,t.muted,false,'Подпись страницы');if(page.pngOptions?.showFootnotes!==false)text(pageNumber,1840,1036,16,t.muted,'right');return result();
}
window.PresentationRender={normalize,newCard,validateDocument,validImage,render,themes,ratingSuffix};
})();
