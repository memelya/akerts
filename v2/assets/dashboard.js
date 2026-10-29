const data=window.EVENT_DATA;
const nf=new Intl.NumberFormat('ru-RU');
const compact=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
const monthNames=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
const monthLabel=value=>{const [year,month]=value.split('-');return monthNames[Number(month)-1]+' '+year.slice(2)};
const jump=document.getElementById('eventJump');
window.EVENT_LIST.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent='#'+item.id+(item.id===data.id?' · текущий':item.isTop?' · топ':'')+(item.hasData?'':' · нет данных');option.selected=item.id===data.id;jump.append(option)});
jump.addEventListener('change',()=>location.href=jump.value+'.html');
const tooltip=document.getElementById('chartTooltip');
const colorFor=code=>{if(code===0)return '#2ca77c';let n=Math.abs(Number(code));return ['#5f8dff','#f17665','#8a6fe8','#df9b39','#32a4b8','#cc5c8d'][n%6]};
const communicationStatus=data.statuses.find(status=>status.code===0);
function smoothPath(points){if(points.length<2)return points.length?'M'+points[0][0]+','+points[0][1]:'';let d='M'+points[0][0]+','+points[0][1];for(let i=0;i<points.length-1;i++){const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;const c1=[p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6];const c2=[p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6];d+=' C'+c1[0].toFixed(1)+','+c1[1].toFixed(1)+' '+c2[0].toFixed(1)+','+c2[1].toFixed(1)+' '+p2[0].toFixed(1)+','+p2[1].toFixed(1)}return d}
function niceMax(value){if(value<=0)return 1;const power=10**Math.floor(Math.log10(value));const ratio=value/power;const nice=ratio<=1?1:ratio<=2?2:ratio<=5?5:10;return nice*power}
function renderChart(status){
  const mobile=window.matchMedia('(max-width:560px)').matches;
  const width=mobile?360:720,height=270,pad={top:45,right:20,bottom:38,left:mobile?44:62};
  const plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const isCsi=status.isCsi===true;
  const max=isCsi?5:niceMax(Math.max(...status.values));
  const points=status.values.map((value,index)=>[pad.left+(index/(status.values.length-1))*plotW,pad.top+plotH-(value/max)*plotH]);
  const segments=[[]];
  points.forEach((point,index)=>{if(status.values[index]===null){if(segments.at(-1).length)segments.push([])}else segments.at(-1).push(point)});
  const validSegments=segments.filter(segment=>segment.length);
  const line=validSegments.map(smoothPath).join(' '),area=validSegments.map(segment=>smoothPath(segment)+' L'+segment.at(-1)[0]+','+(pad.top+plotH)+' L'+segment[0][0]+','+(pad.top+plotH)+' Z').join(' ');
  const isQaResponse=status.isQaResponse===true;
  const displayCode=status.displayCode??status.code;
  const displayDescription=status.displayDescription??status.description;
  const color=isCsi?'#8a6fe8':isQaResponse?'#16a34a':colorFor(status.code);
  const hasQa=status.code===0&&Array.isArray(status.qaValues);
  const ticks=[0,.25,.5,.75,1].map(f=>{const y=pad.top+plotH-f*plotH;return '<line class="grid-line" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"/><text class="axis-label" x="'+(pad.left-10)+'" y="'+(y+3)+'" text-anchor="end">'+compact.format(max*f)+'</text>'}).join('');
  const labelCount=Math.min(5,data.months.length);
  const mobileMonthIndexes=new Set(Array.from({length:labelCount},(_,i)=>Math.round(i*(data.months.length-1)/Math.max(1,labelCount-1))));
  const months=data.months.map((month,index)=>mobile&&!mobileMonthIndexes.has(index)?'':'<text class="axis-label axis-label--month" x="'+points[index][0]+'" y="'+(height-10)+'" text-anchor="middle">'+monthLabel(month)+'</text>').join('');
  const qaBars=hasQa?status.qaValues.map((value,index)=>{if(value===null)return '';const response=Math.min(value,status.values[index]);const barHeight=status.values[index]?Math.max(2,(response/max)*plotH):0;const rate=status.values[index]?(response/status.values[index])*100:0;const labelY=Math.max(pad.top+plotH-barHeight-16,16);return '<g class="qa-bar-group"><rect class="qa-bar" x="'+(points[index][0]-8)+'" y="'+(pad.top+plotH-barHeight)+'" width="16" height="'+barHeight+'"><title>'+data.months[index]+': '+nf.format(response)+' ответов · отклик '+rate.toFixed(1).replace('.',',')+'%</title></rect><text class="qa-label" x="'+points[index][0]+'" y="'+labelY+'" text-anchor="middle"><tspan x="'+points[index][0]+'">'+compact.format(response)+'</tspan><tspan class="qa-label__rate" x="'+points[index][0]+'" dy="10">'+rate.toFixed(1).replace('.',',')+'%</tspan></text></g>'}).join(''):'';
  const comparisonOverlay=!hasQa&&!isQaResponse&&!isCsi&&communicationStatus?(()=>{
    const overlayPath=values=>{const safe=values.map(value=>value??0),low=Math.min(...safe),high=Math.max(...safe),range=Math.max(high-low,1);const overlayPoints=safe.map((value,index)=>[pad.left+(index/(safe.length-1))*plotW,pad.top+plotH-((value-low)/range)*plotH]);return smoothPath(overlayPoints)};
    const responses=communicationStatus.qaValues?.map(value=>value??0)||Array(data.months.length).fill(0);
    return '<g class="comparison-overlay"><g class="comparison-legend"><line class="comparison-send" x1="'+pad.left+'" y1="24" x2="'+(pad.left+22)+'" y2="24"/><text x="'+(pad.left+28)+'" y="27">Отправки</text><line class="comparison-response" x1="'+(pad.left+105)+'" y1="24" x2="'+(pad.left+127)+'" y2="24"/><text x="'+(pad.left+133)+'" y="27">Ответы</text><text class="comparison-note" x="'+(width-pad.right)+'" y="27" text-anchor="end">сравнительный фон · нормировано</text></g><path class="comparison-send" d="'+overlayPath(communicationStatus.values)+'"/><path class="comparison-response" d="'+overlayPath(responses)+'"/></g>';
  })():'';
  const valueLabel=value=>isCsi?value.toFixed(2).replace('.',','):compact.format(value);
  const pointEls=points.map((point,index)=>{if(status.values[index]===null)return '';const labelY=Math.max(point[1]-(isQaResponse?20:12),16);const rate=isQaResponse&&status.rates[index]!==null?status.rates[index].toFixed(1).replace('.',',')+'%':null;return '<g><circle class="chart-point" data-index="'+index+'" cx="'+point[0]+'" cy="'+point[1]+'" r="4" fill="'+color+'"/><text class="point-label" x="'+point[0]+'" y="'+labelY+'" text-anchor="middle"><tspan x="'+point[0]+'">'+valueLabel(status.values[index])+'</tspan>'+(rate?'<tspan class="point-label__rate" x="'+point[0]+'" dy="11">'+rate+'</tspan>':'')+'</text></g>'}).join('');
  const rows=data.months.map((month,index)=>'<tr><td>'+month+'</td><td>'+(isCsi&&status.sourceValues?.[index]===null?'—':isCsi?status.values[index].toFixed(3).replace('.',','):nf.format(status.values[index]))+'</td>'+(hasQa?'<td>'+(status.qaValues[index]===null?'—':nf.format(status.qaValues[index]))+'</td><td>'+(status.qaValues[index]===null||!status.values[index]?'—':(status.qaValues[index]/status.values[index]*100).toFixed(1).replace('.',',')+'%')+'</td>':'')+'</tr>').join('');
  const card=document.createElement('article');card.className='chart-card';
  card.innerHTML='<header class="chart-card__header"><span class="status-chip">'+displayCode+'</span><div class="chart-card__title"><h3>'+displayDescription+'</h3><p>'+(isCsi?'Средняя оценка клиентской удовлетворённости · шкала 1–5':isQaResponse?'Количество полученных ответов · подпись точки содержит отклик':hasQa?'Линия — отправки · столбцы — ответы и отклик':'Статус '+status.code+' · сравнение с основными бизнес-метриками')+'</p></div><div class="chart-card__actions"><div class="chart-card__latest"><b>'+(isCsi?(status.latest===null?'—':status.latest.toFixed(2).replace('.',',')):nf.format(status.latest))+'</b><small>'+data.months.at(-1)+'</small></div><button class="chart-card__expand" type="button" aria-label="Развернуть график на весь экран" title="Развернуть на весь экран">⛶ <span>Развернуть</span></button></div></header><div class="chart-wrap"><svg class="status-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Динамика: '+displayDescription+'">'+ticks+months+qaBars+'<path class="chart-area" d="'+area+'" fill="'+color+'"/><path class="chart-line" d="'+line+'" stroke="'+color+'"/>'+comparisonOverlay+pointEls+'</svg></div><details class="data-table"'+(mobile?' open':'')+'><summary>Показать таблицу значений</summary><table><thead><tr><th>Месяц</th><th>'+(isCsi?'CSI':isQaResponse?'Ответы':'Отправки')+'</th>'+(hasQa?'<th>Ответы</th><th>Отклик</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></details>';
  const expandButton=card.querySelector('.chart-card__expand');
  expandButton.addEventListener('click',async()=>{
    if(document.fullscreenElement===card){await document.exitFullscreen();return}
    if(card.requestFullscreen){await card.requestFullscreen();return}
    card.classList.toggle('chart-card--expanded');
    expandButton.querySelector('span').textContent=card.classList.contains('chart-card--expanded')?'Свернуть':'Развернуть';
    card.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.addEventListener('fullscreenchange',()=>{const active=document.fullscreenElement===card;expandButton.querySelector('span').textContent=active?'Свернуть':'Развернуть';expandButton.setAttribute('aria-label',active?'Свернуть график':'Развернуть график на весь экран')});
  card.querySelectorAll('.chart-point').forEach(point=>{point.addEventListener('pointerenter',event=>{const index=Number(point.dataset.index);const rate=isQaResponse&&status.rates[index]!==null?' · отклик '+status.rates[index].toFixed(1).replace('.',',')+'%':'';tooltip.innerHTML=data.months[index]+'<b>'+nf.format(status.values[index])+rate+'</b>';tooltip.hidden=false;const rect=event.target.getBoundingClientRect();tooltip.style.left=Math.min(rect.left,innerWidth-170)+'px';tooltip.style.top=Math.max(8,rect.top-58)+'px'});point.addEventListener('pointerleave',()=>tooltip.hidden=true)});
  return card;
}
const chartGrid=document.getElementById('chartGrid');
const primaryStatus=data.statuses.find(status=>status.code===0);
if(data.channel==='success_screen'){
  chartGrid.append(renderChart({code:0,displayCode:'ЭУ · ВСЕ',displayDescription:'Все события экрана успеха · сумма cnt по mp_status',values:data.totals,latest:data.totals.at(-1)}));
  chartGrid.append(renderChart({code:0,displayCode:'ЭУ · ОТВЕТЫ',displayDescription:'Ответы экрана успеха · сумма qa_cnt по mp_status',values:data.responseTotals,latest:data.responseTotals.at(-1),isQaResponse:true,rates:data.months.map(()=>null)}));
  chartGrid.querySelectorAll('.chart-card').forEach((card,index)=>{
    card.querySelector('.chart-card__title p').textContent=index?'Сумма qa_cnt по всем mp_status · помесячно':'Сумма cnt по всем mp_status · помесячно';
    card.querySelector('thead th:nth-child(2)').textContent=index?'Ответы':'Все события';
  });
  const csiValues=data.csiValues;
  const csiCard=renderChart({code:0,displayCode:'ЭУ · CSI',displayDescription:'Динамика CSI экрана успеха',values:csiValues,sourceValues:csiValues,latest:csiValues.at(-1),isCsi:true});
  csiCard.querySelector('.chart-card__title p').textContent='Среднее по cnt · Σ(cnt × csi) / Σ(cnt) · оценки 1–5, без нулевых CSI'+(csiValues.at(-1)===null?' · За текущий месяц оценки отсутствуют':'');
  chartGrid.append(csiCard);
}
if(primaryStatus){
  chartGrid.append(renderChart(primaryStatus));
  if(Array.isArray(primaryStatus.qaValues)){
    const values=primaryStatus.qaValues.map(value=>value??0);
    const sends=primaryStatus.sendValues??primaryStatus.values;
    const rates=values.map((value,index)=>sends[index]?value/sends[index]*100:null);
    chartGrid.append(renderChart({code:0,displayCode:'QA',displayDescription:'Динамика ответов на коммуникации',values,rates,latest:values.at(-1),isQaResponse:true,qaValues:null}));
  }
  if(Array.isArray(primaryStatus.csiValues)&&primaryStatus.csiValues.some(value=>value!==null)){
    const sourceValues=primaryStatus.csiValues;
    const values=sourceValues;
    chartGrid.append(renderChart({code:0,displayCode:'CSI',displayDescription:'Динамика CSI',values,sourceValues,latest:sourceValues.at(-1),isCsi:true,qaValues:null}));
  }
}
data.statuses
  .filter(status=>data.channel!=='success_screen'&&status.code!==0)
  .sort((a,b)=>b.values.reduce((sum,value)=>sum+(value||0),0)-a.values.reduce((sum,value)=>sum+(value||0),0))
  .forEach(status=>chartGrid.append(renderChart(status)));
const alertFilterButtons=[...document.querySelectorAll('[data-alert-filter]')];
const alertPeriodButtons=[...document.querySelectorAll('[data-alert-period-filter]')];
const alertItems=[...document.querySelectorAll('.alert-item')];
const alertCount=document.querySelector('.alert-count');
function updateAlertFilters(){
  const enabled=new Set(alertFilterButtons.filter(button=>button.classList.contains('active')).map(button=>button.dataset.alertFilter));
  const period=alertPeriodButtons.find(button=>button.classList.contains('active'))?.dataset.alertPeriodFilter||'latest';
  let visible=0;
  alertItems.forEach(item=>{const show=enabled.has(item.classList.contains('alert-item--down')?'down':'up')&&item.dataset.alertPeriod===period;item.hidden=!show;if(show)visible+=1});
  if(alertCount)alertCount.textContent=visible===alertItems.length?alertItems.length+' алертов':visible+' из '+alertItems.length+' алертов';
}
alertFilterButtons.forEach(button=>button.addEventListener('click',()=>{button.classList.toggle('active');button.setAttribute('aria-pressed',button.classList.contains('active'));updateAlertFilters()}));
alertPeriodButtons.forEach(button=>button.addEventListener('click',()=>{alertPeriodButtons.forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',active)});updateAlertFilters()}));
updateAlertFilters();
