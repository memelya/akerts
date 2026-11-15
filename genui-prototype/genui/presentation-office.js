(()=>{
'use strict';
const finite=Number.isFinite;
const unitLabel={count:'шт.',percent:'%',csi:'баллы'};
const xmlHeader='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const sheetNs='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNs='http://schemas.openxmlformats.org/package/2006/relationships';
const chartNs='http://schemas.openxmlformats.org/drawingml/2006/chart';
const drawingNs='http://schemas.openxmlformats.org/drawingml/2006/main';
const escapeXml=value=>String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'})[c]);
const stripHex=color=>color.replace(/^#/,'');
const inches=pixels=>pixels/144;
const formatUnit=(value,unit)=>unit==='percent'&&finite(value)?value/100:value;
const labelSize=item=>item.labels.length>16?7:item.w<700?7.5:9;
function numberFormat(card,unit){
 if(unit==='percent')return '0.0%';
 if(unit==='csi')return '0.00';
 const digits=card.numberDecimals??1,decimals=digits?'.'+'0'.repeat(digits):'';
 if(card.numberFormat==='full')return '#,##0';
 const million='0'+decimals+',," млн"',thousand='0'+decimals+'," тыс."';
 if(card.numberFormat==='millions')return million;
 if(card.numberFormat==='thousands')return thousand;
 return '[>=1000000]'+million+';[>=1000]'+thousand+';0';
}

function chartOptions(item,unit){
 const color=stripHex(item.muted);
 const range=unit==='csi'?{valAxisMinVal:item.cmin,valAxisMaxVal:item.cmax}:
  unit==='percent'?{valAxisMinVal:0,valAxisMaxVal:Math.max(1,item.pmax/100)*1.05}:{valAxisMinVal:0};
 return {...range,valAxisHidden:!item.showAxis,valAxisLabelColor:color,valAxisLabelFontSize:8,
  valAxisLabelFormatCode:numberFormat(item.card,unit),valGridLine:{style:'none'},
  catAxisHidden:!item.showCategory,catAxisLabelColor:color,catAxisLabelFontSize:item.labels.length>16?7:9,
  catAxisLabelRotate:0,catAxisLabelFrequency:Math.max(1,Math.ceil(item.labels.length/(item.w<700?10:16))),
  catAxisLineShow:item.showCategory,catAxisLineColor:color,catGridLine:{style:'none'},
  displayBlanksAs:'gap',showLegend:false,showTitle:false,showValue:item.card.labels!=='none',
  dataLabelFormatCode:numberFormat(item.card,unit),dataLabelColor:stripHex(item.ink),dataLabelFontSize:labelSize(item),
  dataLabelPosition:'t',lineSize:2.2,lineSmooth:true,lineDataSymbol:'circle',lineDataSymbolSize:3,
  chartArea:{fill:{color:stripHex(item.background),transparency:100}},
  x:inches(item.x),y:inches(item.y),w:inches(item.w),h:inches(item.h),
  layout:{x:item.plot?.x??(item.showAxis ? .09 : .035),y:.14,w:item.plot?.w??(item.showAxis ? .85 : .93),h:item.showCategory ? .73 : .76}};
}

function nativeChart(pptx,slide,item){
 const primary=item.data[0].unit==='csi'?(item.data.find(series=>series.unit!=='csi')?.unit||'csi'):item.data[0].unit;
 const secondary=item.data.find(series=>series.unit!==primary)?.unit;
 if(item.data.some(series=>series.unit!==primary&&series.unit!==secondary))throw new Error('Для диаграммы «'+item.card.title+'» доступны две шкалы. Разделите показатели на два графика.');
 const ordered=[...item.data].sort((a,b)=>Number(a.renderType==='line')-Number(b.renderType==='line'));
 const groups=[];
 for(const series of ordered){
  const last=groups.at(-1);
  if(last?.type===series.renderType&&last.unit===series.unit)last.series.push(series);
  else groups.push({type:series.renderType,unit:series.unit,series:[series]});
 }
 const options=chartOptions(item,primary);
 if(secondary){
  options.valAxes=[options,chartOptions(item,secondary)].map(axis=>({...axis}));
  options.catAxes=[options,{...options,catAxisHidden:true}].map(axis=>({...axis,valAxes:undefined}));
 }
 const charts=groups.map(group=>{
  const line=group.type==='line';
  return {type:line?pptx.ChartType.line:pptx.ChartType.bar,
   data:group.series.map(series=>({name:series.label,labels:item.labels,values:series.values.map(value=>formatUnit(value,series.unit))})),
   options:{chartColors:group.series.map(series=>stripHex(series.color)),
    secondaryValAxis:group.unit===secondary,secondaryCatAxis:group.unit===secondary,
    barDir:'col',barGrouping:group.type==='stack'?'stacked':'clustered',barGapWidthPct:50,
    dataLabelPosition:line?'t':group.type==='stack'?'ctr':'outEnd',dataLabelFormatCode:numberFormat(item.card,group.unit)}};
 });
 if(charts.length===1)slide.addChart(charts[0].type,charts[0].data,{...options,...charts[0].options});
 else slide.addChart(charts,options);
 return {...item,series:groups.flatMap(group=>group.series)};
}

function addObject(pptx,slide,item){
 if(item.kind==='image'){
  slide.addImage({data:item.data,x:inches(item.x),y:inches(item.y),w:inches(item.w),h:inches(item.h)});
 }else if(item.kind==='panel'){
  const color=stripHex(item.color);
  slide.addShape(pptx.ShapeType.roundRect,{x:inches(item.x),y:inches(item.y),w:inches(item.w),h:inches(item.h),radius:.09,
   rectRadius:.09,adjustPoint:.06,fill:{color},line:{color:stripHex(item.border||item.color),width:.6}});
 }else if(item.kind==='line'){
  slide.addShape(pptx.ShapeType.line,{x:inches(item.x1),y:inches(item.y1),w:inches(item.x2-item.x1),h:inches(item.y2-item.y1),
   line:{color:stripHex(item.color),width:item.width/2}});
 }else if(item.kind==='text'){
  const width=item.width+Math.max(10,item.width*.12);
  const left=item.align==='right'?item.x-width:item.align==='center'?item.x-width/2:item.x;
  const x=Math.max(0,left);
  slide.addText(item.value,{x:inches(x),y:inches(Math.max(0,item.y-item.size*.93)),w:inches(Math.min(width,1920-x)),h:inches(item.size*1.28),
   margin:0,fontFace:'Calibri',fontSize:item.size/2,bold:item.bold,color:stripHex(item.color),align:item.align,valign:'mid',breakLine:false});
 }
}

function parseXml(source){return new DOMParser().parseFromString(source,'application/xml');}
function chartElement(doc,name,value){const el=doc.createElementNS(chartNs,'c:'+name);if(value!==undefined)el.setAttribute('val',String(value));return el;}
function sheetElement(doc,name,attributes={},text){
 const el=doc.createElementNS(sheetNs,name);
 for(const [key,value] of Object.entries(attributes))el.setAttribute(key,String(value));
 if(text!==undefined)el.textContent=text;
 return el;
}
function chartLabelVisible(item,series,i){
 if(!finite(series.values[i])||item.card.labels==='none')return false;
 if(series.unit==='percent'&&!window.ChartAppearance.shareVisible(item.card,series.key))return false;
 return item.detached||item.card.labels==='all'||i===series.values.findIndex(finite)||item.dates[i]===item.card.baseline||i===series.values.findLastIndex(finite);
}

function labelFlags(doc,showValue){
 return ['showLegendKey','showVal','showCatName','showSerName','showPercent','showBubbleSize'].map(name=>chartElement(doc,name,name==='showVal'&&showValue?1:0));
}

function labelFormula(card,address){
 const decimals=card.numberDecimals??1;
 const millions=`ROUND(${address}/1000000,${decimals})&" млн"`;
 const thousands=`ROUND(${address}/1000,${decimals})&" тыс."`;
 const full=`FIXED(${address},0,FALSE)`;
 if(card.numberFormat==='full')return full;
 if(card.numberFormat==='millions')return millions;
 if(card.numberFormat==='thousands')return thousands;
 return `IF(${address}>=1000000,${millions},IF(${address}>=1000,${thousands},${full}))`;
}

async function refineWorkbook(archive,chartPath,item){
 const name=chartPath.split('/').at(-1),rels=archive.file('ppt/charts/_rels/'+name+'.rels');
 const relation=parseXml(await rels.async('string')).getElementsByTagNameNS(packageNs,'Relationship')[0];
 const target=relation?.getAttribute('Target'),path='ppt/'+target?.replace(/^\.\.\//,'');
 if(!target||!archive.file(path))throw new Error('Не найдена встроенная книга для диаграммы «'+item.card.title+'».');
 const workbook=await window.JSZip.loadAsync(await archive.file(path).async('uint8array'));
 const sheetPath='xl/worksheets/sheet1.xml',sheet=parseXml(await workbook.file(sheetPath).async('string'));
 const serializer=new XMLSerializer(),rows=[...sheet.getElementsByTagNameNS(sheetNs,'row')],labelColumns=new Map();
 for(const row of rows.slice(1))for(const cell of [...row.children]){
  const value=cell.getElementsByTagNameNS(sheetNs,'v')[0];
  if(value&&!value.textContent.trim()){cell.remove();continue;}
  const address=cell.getAttribute('r');
  const index=item.series.findIndex((_,j)=>address.replace(/\d/g,'')===columnName(j+1));
  if(item.series[index]?.unit==='percent')cell.setAttribute('s',2);
 }
 let nextColumn=item.series.length+1;
 item.series.forEach((series,j)=>{
  const dual=series.renderType==='stack'&&series.unit==='percent'&&(item.card.valueMode||'both')==='both'&&series.counts.some(finite)&&window.ChartAppearance.shareVisible(item.card,series.key);
  const csiSample=series.unit==='csi'&&series.passport?.some(proof=>finite(proof?.denominator)&&proof.denominator>0);
  if(item.card.labels==='none'||series.unit!=='count'&&!dual&&!csiSample)return;
  const valueColumn=columnName(j+1),countColumn=dual||csiSample?columnName(nextColumn++):null,labelColumn=columnName(nextColumn++);
  labelColumns.set(j,labelColumn);
  for(const [column,title] of [[countColumn,csiSample?'Количество оценок CSI':series.label+' · количество'],[labelColumn,series.label+' · подпись']]){
   if(!column)continue;
   const cell=sheetElement(sheet,'c',{r:column+'1',t:'inlineStr'}),inline=sheetElement(sheet,'is');
   inline.append(sheetElement(sheet,'t',{},title));cell.append(inline);rows[0].append(cell);
  }
  series.values.forEach((value,i)=>{
   const row=rows[i+1],rowNumber=i+2,count=csiSample?series.passport[i]?.denominator:series.counts[i],countAddress=countColumn+rowNumber,valueAddress=valueColumn+rowNumber;
   if(countColumn&&finite(count)){
    const cell=sheetElement(sheet,'c',{r:countAddress});cell.append(sheetElement(sheet,'v',{},count));row.append(cell);
   }
   const cell=sheetElement(sheet,'c',{r:labelColumn+rowNumber,t:'str'});
   const formula=dual?`IF(NOT(ISNUMBER(${valueAddress})),"",IF(ISNUMBER(${countAddress}),${labelFormula(item.card,countAddress)}&CHAR(10),"")&ROUND(${valueAddress}*100,1)&"%")`:
    csiSample?`IF(ISNUMBER(${valueAddress}),ROUND(${valueAddress},2)&IF(AND(ISNUMBER(${countAddress}),${countAddress}>0)," · n="&TEXT(${countAddress},"#,##0"),""),"")`:
    `IF(ISNUMBER(${valueAddress}),${labelFormula(item.card,valueAddress)},"")`;
   cell.append(sheetElement(sheet,'f',{},formula),sheetElement(sheet,'v',{},formattedLabel(item,series,i)));row.append(cell);
  });
 });
 if(labelColumns.size){
  const last=columnName(nextColumn-1);
  sheet.getElementsByTagNameNS(sheetNs,'dimension')[0]?.setAttribute('ref','A1:'+last+rows.length);
  rows.forEach(row=>row.setAttribute('spans','1:'+nextColumn));
 }
 workbook.file(sheetPath,serializer.serializeToString(sheet));workbook.file('xl/styles.xml',styleXml);
 const rowsWithProof=passportRows(item.card.graph,item.series);
 if(rowsWithProof.length)await addPassportSheet(workbook,rowsWithProof);
 archive.file(path,await workbook.generateAsync({type:'uint8array',compression:'DEFLATE'}));
 return labelColumns;
}

function formattedLabel(item,series,index){
 const value=series.values[index],count=series.counts[index];
 if(!finite(value))return '';
 if(series.unit==='count')return window.ChartAppearance.formatNumber(value,item.card);
 if(series.unit==='csi')return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value)+window.PresentationRender.ratingSuffix(series,index);
 const percent=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value)+'%';
 return (finite(count)?window.ChartAppearance.formatNumber(count,item.card)+'\n':'')+percent;
}

function labelColor(doc,color,size){
 const txPr=chartElement(doc,'txPr');
 const drawing=(name,attrs={})=>{const el=doc.createElementNS(drawingNs,'a:'+name);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el;};
 const paragraph=drawing('p'),properties=drawing('pPr'),run=drawing('defRPr',{sz:size*100}),fill=drawing('solidFill');
 fill.append(drawing('srgbClr',{val:stripHex(color)}));run.append(fill);properties.append(run);paragraph.append(properties);
 txPr.append(drawing('bodyPr'),drawing('lstStyle'),paragraph);return txPr;
}

// Keep native label settings and sparse caches consistent with the saved snapshot.
async function refineCharts(blob,charts){
 if(!charts.length)return blob;
 const archive=await window.JSZip.loadAsync(blob),parts=Object.keys(archive.files).filter(name=>/^ppt\/charts\/chart\d+\.xml$/.test(name))
  .sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 if(parts.length!==charts.length)throw new Error('Не удалось сопоставить диаграммы с данными презентации.');
 const serializer=new XMLSerializer();
 for(const [index,path] of parts.entries()){
  const item=charts[index],doc=parseXml(await archive.file(path).async('string'));
  const labelColumns=await refineWorkbook(archive,path,item);
  const nodes=[...doc.getElementsByTagNameNS(chartNs,'ser')];
  nodes.forEach((node,j)=>{
   const series=item.series[j];
   const cat=node.getElementsByTagNameNS(chartNs,'cat')[0];
   if(!series||!cat)return;
   const labels=chartElement(doc,'dLbls');
   for(let i=0;i<item.labels.length;i++){
    const visible=chartLabelVisible(item,series,i),column=labelColumns.get(j);
    if(visible&&!column)continue;
    const label=chartElement(doc,'dLbl');
    label.append(chartElement(doc,'idx',i));
    if(!visible)label.append(chartElement(doc,'delete',1));
    else{
     const text=chartElement(doc,'tx'),ref=chartElement(doc,'strRef'),formula=chartElement(doc,'f'),cache=chartElement(doc,'strCache');
     formula.textContent='Sheet1!$'+column+'$'+(i+2);
     const point=chartElement(doc,'pt'),value=chartElement(doc,'v');point.setAttribute('idx','0');value.textContent=formattedLabel(item,series,i);
     point.append(value);cache.append(chartElement(doc,'ptCount',1),point);ref.append(formula,cache);text.append(ref);
     const position=series.renderType==='line'?'t':series.renderType==='stack'?'ctr':'outEnd';
     label.append(text,chartElement(doc,'dLblPos',position),...labelFlags(doc,false));
    }
    labels.append(label);
   }
   const format=chartElement(doc,'numFmt');
   format.setAttribute('formatCode',numberFormat(item.card,series.unit));format.setAttribute('sourceLinked','0');
   labels.append(format);
   if(series.renderType==='stack')labels.append(labelColor(doc,window.ChartAppearance.ink(series.color),labelSize(item)),chartElement(doc,'dLblPos','ctr'));
   if(series.renderType==='line')labels.append(labelColor(doc,series.color,labelSize(item)),chartElement(doc,'dLblPos','t'));
   labels.append(...labelFlags(doc,item.card.labels!=='none'&&!labelColumns.has(j)));
   node.insertBefore(labels,cat);
   for(const point of [...node.getElementsByTagNameNS(chartNs,'pt')]){
    if(point.parentElement.localName==='numCache'&&!point.textContent.trim())point.remove();
   }
  });
  archive.file(path,serializer.serializeToString(doc));
 }
 return archive.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
}

async function powerPoint(pages,renderPage,{raster=false,notes=()=>'',progress=()=>{}}={}){
 const pptx=new window.PptxGenJS();
 pptx.layout='LAYOUT_WIDE';pptx.author='GEN UI';pptx.title=pages[0]?.title||'Презентация';pptx.lang='ru-RU';
 const charts=[];
 for(const [index,page] of pages.entries()){
  progress(index+1);
  const render=renderPage(page,index);
  if(render.errors.length)throw new Error('Страница «'+page.title+'». '+render.errors.join(' '));
  const slide=pptx.addSlide();
  slide.background={color:stripHex(render.background)};
  if(raster)slide.addImage({data:render.canvas.toDataURL('image/png'),x:0,y:0,w:13.3333333333,h:7.5});
  else for(const item of render.scene){
   if(item.kind==='chart')charts.push(nativeChart(pptx,slide,item));
   else addObject(pptx,slide,item);
  }
  const note=notes(page);if(note)slide.addNotes(note);
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 const blob=await pptx.write({outputType:'blob',compression:true});
 return refineCharts(blob,charts);
}

function columnName(index){
 let name='';
 for(let value=index+1;value>0;value=Math.floor((value-1)/26))name=String.fromCharCode(65+(value-1)%26)+name;
 return name;
}
const cell=(value,address,style)=>value==null?'':typeof value==='number'?`<c r="${address}" s="${style}"><v>${value}</v></c>`:
 `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
function worksheet(rows,widths,styles=[],filter=true){
 const data=rows.map((row,i)=>`<row r="${i+1}">${row.map((value,j)=>cell(value,columnName(j)+(i+1),i===0?1:styles[j]||0)).join('')}</row>`).join('');
 const columns=widths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${width}" customWidth="1"/>`).join('');
 const range='A1:'+columnName(widths.length-1)+rows.length;
 return xmlHeader+`<worksheet xmlns="${sheetNs}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${data}</sheetData>${filter?'<autoFilter ref="'+range+'"/>':''}</worksheet>`;
}
function dataSheet(card){
 const {dates,series,indices}=window.PresentationLayouts.selectData(card),graph=card.graph;
 const columns=[{label:'Период',width:17,get:i=>dates[i]},{label:'Подпись периода',width:21,get:i=>window.PresentationLayouts.period(graph,dates[i])}];
 for(const item of series){
  columns.push({label:item.label+' · график ('+unitLabel[item.unit]+')',width:Math.min(62,Math.max(25,item.label.length+16)),style:item.unit==='percent'?2:item.unit==='csi'?3:4,get:i=>formatUnit(item.values[i],item.unit)});
  if(item.counts.some(finite)&&item.unit!=='csi')columns.push({label:item.label+' · количество',width:Math.min(62,Math.max(25,item.label.length+15)),style:4,get:i=>item.counts[i]});
  if(item.ratios.some(finite))columns.push({label:item.label+' · доля ('+(item.ratioBase==='sends'?'от отправок':'от событий')+')',width:Math.min(62,Math.max(30,item.label.length+21)),style:2,get:i=>formatUnit(item.ratios[i],'percent')});
  if(item.partial.some(Boolean))columns.push({label:item.label+' · покрытие',width:28,get:i=>item.partial[i]?'Часть строк':null});
 }
 const rows=[columns.map(column=>column.label),...indices.map((_,i)=>columns.map(column=>column.get(i)))];
 return worksheet(rows,columns.map(column=>column.width),columns.map(column=>column.style));
}

const passportHeaders=['График','Ряд','Период','Значение','Формула','Доля','Числитель','Знаменатель','База','Исходное значение','Исходная доля','Исходная база','Автор правки','Время правки','Покрытие','Источник','Версия данных','Версия формулы','Фильтры','Файлы'];
const passportWidths=[36,34,26,19,55,14,20,20,20,21,19,20,24,26,19,40,26,17,48,40];
const passportStyles=[0,0,0,0,0,2,0,0,0,0,2];
function passportRows(graph,series){
 const info=graph.passport;
 if(!info)return [];
 return series.flatMap(item=>(item.passport||[]).filter(Boolean).map(row=>[graph.name,item.label,row.window||row.period,row.value,row.formula,
  formatUnit(row.ratio,'percent'),row.numerator,row.denominator,row.baseMetric,row.changed?row.original:null,row.changed?formatUnit(row.originalShare,'percent'):null,row.changed?row.originalBase:null,
  row.changed?row.author||'Не указан':'',row.editedAt,row.coverage,info.source,info.revision,info.metricVersion,JSON.stringify(info.scope),info.sourceFiles?.join(', ')]));
}

function addPassportSheet(workbook,rows){
 const sheetPath='xl/worksheets/sheet2.xml';
 workbook.file(sheetPath,worksheet([passportHeaders,...rows],passportWidths,passportStyles));
 const paths=['xl/workbook.xml','xl/_rels/workbook.xml.rels','[Content_Types].xml'];
 const relation='<Relationship Id="rIdPassport" Type="'+relNs+'/worksheet" Target="worksheets/sheet2.xml"/>';
 return Promise.all(paths.map(path=>workbook.file(path).async('string'))).then(([book,rels,types])=>{
  workbook.file(paths[0],book.replace('</sheets>','<sheet name="Паспорта" sheetId="2" r:id="rIdPassport"/></sheets>'));
  workbook.file(paths[1],rels.replace('</Relationships>',relation+'</Relationships>'));
  workbook.file(paths[2],types.replace('</Types>','<Override PartName="/'+sheetPath+'" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
 });
}

const styleXml=xmlHeader+`<styleSheet xmlns="${sheetNs}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF247347"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
async function workbook(pages,{comparison=null,evidence=null}={}){
 const archive=new window.JSZip(),sheets=[],proofs=[],index=[['Лист','Страница','График','Источник','Снимок','Версия данных','Ручные правки','Назначения статусов']];
 for(const [i,page] of pages.entries())for(const [j,card] of page.cards.entries()){
  if(card.kind==='image')continue;
  const name='Слайд '+(i+1)+' график '+(j+1),graph=card.graph;
  sheets.push({name,content:dataSheet(card)});
  proofs.push(...passportRows(graph,window.PresentationLayouts.selectData(card).series));
  index.push([name,page.title,card.title,graph.sourceTitle,graph.capturedAt,graph.revision,graph.uiEdited?'Да':'Нет',Object.entries(graph.statusAssignments||{}).map(([key,value])=>key+' → '+value).join(', ')]);
 }
 if(!sheets.length)throw new Error('Добавьте график с данными для Excel.');
 sheets.unshift({name:'Источники',content:worksheet(index,[23,42,38,48,27,29,18,44])});
 if(proofs.length)sheets.push({name:'Паспорта',content:worksheet([passportHeaders,...proofs],passportWidths,passportStyles)});
 if(comparison)sheets.push({name:'Сравнение',content:worksheet(comparison,[42,28,14,23,23,20,32],[0,0,0,3,3,3,0])});
 if(evidence)sheets.push({name:'Проверка утверждений',content:worksheet(evidence,[19,44,22,22,100])});
 const rel=(id,type,target)=>`<Relationship Id="rId${id}" Type="${relNs}/${type}" Target="${target}"/>`;
 const rels=body=>xmlHeader+`<Relationships xmlns="${packageNs}">${body}</Relationships>`;
 archive.file('_rels/.rels',rels(rel(1,'officeDocument','xl/workbook.xml')));
 archive.file('xl/workbook.xml',xmlHeader+`<workbook xmlns="${sheetNs}" xmlns:r="${relNs}"><sheets>${sheets.map(({name},i)=>`<sheet name="${escapeXml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
 archive.file('xl/_rels/workbook.xml.rels',rels(sheets.map((_,i)=>rel(i+1,'worksheet',`worksheets/sheet${i+1}.xml`)).join('')+rel(sheets.length+1,'styles','styles.xml')));
 archive.file('xl/styles.xml',styleXml);
 sheets.forEach(({content},i)=>archive.file(`xl/worksheets/sheet${i+1}.xml`,content));
 archive.file('[Content_Types].xml',xmlHeader+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>');
 return archive.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
window.PresentationOffice={powerPoint,workbook};
})();
