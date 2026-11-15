(()=>{
'use strict';
const finite=Number.isFinite;
const templates={
 classic:{label:'Свободный макет'},
 comparison:{label:'Отчёт · два графика и KPI',capacity:2},
 composition:{label:'Отчёт · состав событий',capacity:1},
 timeline:{label:'Отчёт · динамика и отметка',capacity:1}
};
const capacity=page=>templates[page.template]?.capacity??(page.layout==='grid'?6:page.layout==='one'?1:2);
const period=(graph,date)=>graph.periodLabels?.[date]||(date.length===10?date.slice(8)+'.'+date.slice(5,7):date.slice(5,7)+'.'+date.slice(2,4));

function range(card,dates){
 if(!dates.length)return '';
 const format=value=>value.split('-').reverse().join('.');
 const graph=card.graph,from=dates[0],last=dates.at(-1),index=graph.dates.indexOf(last);
 const savedWindow=graph.series.find(series=>series.passport?.[index]?.window)?.passport[index].window;
 const to=graph.periodEnds?.[last]||savedWindow?.match(/ — (\d{4}-\d{2}-\d{2})$/)?.[1]||last;
 return format(from)+(from===to?'':' — '+format(to));
}

function selectData(card){
 const graph=card.graph,composition=graph.kind==='events-breakdown',mode=card.valueMode||'both';
 const first=graph.dates.indexOf(card.start),end=graph.dates.indexOf(card.end)+1;
 const selected=graph.series.filter(series=>card.selected.includes(series.key));
 function values(series){
  if(composition&&series.type!=='stack')return series.counts?.length?series.counts:series.values;
  if(mode==='percent'&&series.unit==='count')return series.ratios||[];
  if(mode==='absolute'&&series.unit==='percent'&&series.metric!=='responseRate')return series.counts||[];
  return series.values;
 }
 const indices=[];
 if(first>=0&&end>first){
  for(let i=first;i<end;i++){
   if(!card.excludedDates?.includes(graph.dates[i])&&(graph.keepMissingPeriods||selected.some(series=>finite(values(series)[i]))))indices.push(i);
  }
 }
 function transform(series){
  let unit=series.unit;
  if(composition&&series.type!=='stack')unit='count';
  else if(mode==='percent'&&unit==='count')unit='percent';
  else if(mode==='absolute'&&unit==='percent'&&series.metric!=='responseRate')unit='count';
  return {...series,unit,values:indices.map(i=>values(series)[i]??null),
   counts:indices.map(i=>series.counts?.[i]??(series.unit==='count'?series.values[i]:null)),
   ratios:indices.map(i=>series.ratios?.[i]??(series.unit==='percent'?series.values[i]:null)),
   partial:indices.map(i=>Boolean(series.partial?.[i])),passport:series.passport?indices.map(i=>series.passport[i]):undefined};
 }
 if(graph.keepMissingPeriods&&!selected.some(series=>indices.some(i=>finite(values(series)[i]))))indices.length=0;
 return {first,end,mode,composition,indices,dates:indices.map(i=>graph.dates[i]),series:selected.map(transform),
  headline:transform(graph.series.find(series=>series.key===card.headline))};
}

const reportColors={events:'#263444',sends:'#398250',answers:'#2b719f',stop:'#416882',contactPolicy:'#c68c4c'};
const darkColors={events:'#e2e8ef',sends:'#7dc693',answers:'#72b9e6',stop:'#83a9c5',contactPolicy:'#e7b376'};

function report(page,draw){
 const {text,block,line,panel,font,chart,imageCard,theme,errors,pageNumber,pageCount}=draw;
 const margin=72,right=1848,wide=right-margin;
 line(12,0,12,1080,theme.accent,8);
 line(margin,49,margin+112,49,theme.accent,4);
 const title=page.pngOptions?.title??page.title;
 if(!title.trim())errors.push('Задайте заголовок страницы.');
 const titleHeight=block(title||'Название страницы',margin,107,wide-95,2,44,theme.ink,true,'Заголовок страницы');
 text(String(pageNumber).padStart(2,'0')+' / '+String(pageCount).padStart(2,'0'),right,55,16,theme.muted,'right');
 let top=82+titleHeight;
 if(page.subtitle)top+=block(page.subtitle,margin,top+26,wide,2,23,theme.muted,false,'Подзаголовок')+20;
 top=Math.max(172,top+24);
 const bottom=970,hasKpis=page.template==='comparison'&&page.kpis.some(item=>item.label||item.value||item.detail);
 const chartBottom=hasKpis?805:bottom,chartHeight=chartBottom-top;
 const cards=page.cards;
 if(!cards.length){errors.push('Добавьте график или PNG.');panel(margin,top,wide,chartHeight);text('Добавьте график или PNG',960,top+chartHeight/2,32,theme.muted,'center');}
 if(cards.length>capacity(page))errors.push('В шаблоне не хватает мест. Перенесите лишние графики на другую страницу.');
 cards.slice(0,capacity(page)).forEach((card,i)=>{
  const split=page.template==='comparison'&&cards.length>1;
  const leftWidth=split?1122:wide;
  const rect={x:i?margin+leftWidth+24:margin,y:top,w:i?wide-leftWidth-24:leftWidth,h:chartHeight};
  if(card.kind==='image')imageCard(card,rect);
  else chart(card,rect,{report:true,marker:page.marker,palette:page.theme==='dark'?darkColors:reportColors});
 });
 if(hasKpis){
  const items=page.kpis.filter(item=>item.label||item.value||item.detail),gap=18,width=(wide-gap*(items.length-1))/items.length;
  items.forEach((item,i)=>{
   const x=margin+i*(width+gap),y=828;
   panel(x,y,width,142);
   const valueColor=page.theme==='dark'?theme.accent:reportColors.answers;
   const valueHeight=item.value?block(item.value,x+22,y+46,width-44,1,36,valueColor,true,'Значение KPI'):0;
   if(item.label||item.detail)block([item.label,item.detail].filter(Boolean).join(' · '),x+22,y+62+valueHeight/2,width-44,3,19,theme.muted,false,'Пояснение KPI');
  });
 }
 if(page.pngOptions?.showFootnotes!==false&&page.footer){
  line(margin,996,right,996,theme.grid,1);
  block(page.footer,margin,1025,wide,2,17,theme.accent,true,'Подпись страницы');
 }
}

window.PresentationLayouts={templates,capacity,period,range,selectData,report};
})();
