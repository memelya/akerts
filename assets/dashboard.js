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
  const width=720,height=270,pad={top:45,right:20,bottom:38,left:62};
  const plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const max=niceMax(Math.max(...status.values));
  const points=status.values.map((value,index)=>[pad.left+(index/(status.values.length-1))*plotW,pad.top+plotH-(value/max)*plotH]);
  const line=smoothPath(points),area=line+' L'+points.at(-1)[0]+','+(pad.top+plotH)+' L'+points[0][0]+','+(pad.top+plotH)+' Z';
  const isQaResponse=status.isQaResponse===true;
  const displayCode=status.displayCode??status.code;
  const displayDescription=status.displayDescription??status.description;
  const color=isQaResponse?'#16a34a':colorFor(status.code);
  const hasQa=status.code===0&&Array.isArray(status.qaValues);
  const ticks=[0,.25,.5,.75,1].map(f=>{const y=pad.top+plotH-f*plotH;return '<line class="grid-line" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"/><text class="axis-label" x="'+(pad.left-10)+'" y="'+(y+3)+'" text-anchor="end">'+compact.format(max*f)+'</text>'}).join('');
  const months=data.months.map((month,index)=>'<text class="axis-label" x="'+points[index][0]+'" y="'+(height-10)+'" text-anchor="middle">'+monthLabel(month)+'</text>').join('');
  const qaBars=hasQa?status.qaValues.map((value,index)=>{if(value===null)return '';const response=Math.min(value,status.values[index]);const barHeight=status.values[index]?Math.max(2,(response/max)*plotH):0;const rate=status.values[index]?(response/status.values[index])*100:0;return '<g class="qa-bar-group"><rect class="qa-bar" x="'+(points[index][0]-8)+'" y="'+(pad.top+plotH-barHeight)+'" width="16" height="'+barHeight+'"><title>'+data.months[index]+': '+nf.format(response)+' ответов · отклик '+rate.toFixed(1).replace('.',',')+'%</title></rect><text class="qa-label" x="'+points[index][0]+'" y="'+Math.max(pad.top+plotH-barHeight-7,12)+'" text-anchor="middle">'+nf.format(response)+' · '+rate.toFixed(1).replace('.',',')+'%</text></g>'}).join(''):'';
  const comparisonOverlay=!hasQa&&!isQaResponse&&communicationStatus?(()=>{
    const overlayPath=values=>{const safe=values.map(value=>value??0),low=Math.min(...safe),high=Math.max(...safe),range=Math.max(high-low,1);const overlayPoints=safe.map((value,index)=>[pad.left+(index/(safe.length-1))*plotW,pad.top+plotH-((value-low)/range)*plotH]);return smoothPath(overlayPoints)};
    const responses=communicationStatus.qaValues?.map(value=>value??0)||Array(data.months.length).fill(0);
    return '<g class="comparison-overlay"><g class="comparison-legend"><line class="comparison-send" x1="'+pad.left+'" y1="24" x2="'+(pad.left+22)+'" y2="24"/><text x="'+(pad.left+28)+'" y="27">Отправки</text><line class="comparison-response" x1="'+(pad.left+105)+'" y1="24" x2="'+(pad.left+127)+'" y2="24"/><text x="'+(pad.left+133)+'" y="27">Ответы</text><text class="comparison-note" x="'+(width-pad.right)+'" y="27" text-anchor="end">сравнительный фон · нормировано</text></g><path class="comparison-send" d="'+overlayPath(communicationStatus.values)+'"/><path class="comparison-response" d="'+overlayPath(responses)+'"/></g>';
  })():'';
  const pointEls=points.map((point,index)=>'<g><circle class="chart-point" data-index="'+index+'" cx="'+point[0]+'" cy="'+point[1]+'" r="4" fill="'+color+'"/><text class="point-label" x="'+point[0]+'" y="'+Math.max(point[1]-11,14)+'" text-anchor="middle">'+nf.format(status.values[index])+(isQaResponse&&status.rates[index]!==null?' · '+status.rates[index].toFixed(1).replace('.',',')+'%':'')+'</text></g>').join('');
  const rows=data.months.map((month,index)=>'<tr><td>'+month+'</td><td>'+nf.format(status.values[index])+'</td>'+(hasQa?'<td>'+(status.qaValues[index]===null?'—':nf.format(status.qaValues[index]))+'</td><td>'+(status.qaValues[index]===null||!status.values[index]?'—':(status.qaValues[index]/status.values[index]*100).toFixed(1).replace('.',',')+'%')+'</td>':'')+'</tr>').join('');
  const card=document.createElement('article');card.className='chart-card';
  card.innerHTML='<header class="chart-card__header"><span class="status-chip">'+displayCode+'</span><div class="chart-card__title"><h3>'+displayDescription+'</h3><p>'+(isQaResponse?'Количество полученных ответов · подпись точки содержит отклик':hasQa?'Линия — отправки · столбцы — ответы и отклик':'Статус '+status.code+' · сравнение с основными бизнес-метриками')+'</p></div><div class="chart-card__latest"><b>'+nf.format(status.latest)+'</b><small>'+data.months.at(-1)+'</small></div></header><div class="chart-wrap"><svg class="status-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Динамика: '+displayDescription+'">'+ticks+months+qaBars+'<path class="chart-area" d="'+area+'" fill="'+color+'"/><path class="chart-line" d="'+line+'" stroke="'+color+'"/>'+comparisonOverlay+pointEls+'</svg></div><details class="data-table"><summary>Показать таблицу значений</summary><table><thead><tr><th>Месяц</th><th>'+(isQaResponse?'Ответы':'Отправки')+'</th>'+(hasQa?'<th>Ответы</th><th>Отклик</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></details>';
  card.querySelectorAll('.chart-point').forEach(point=>{point.addEventListener('pointerenter',event=>{const index=Number(point.dataset.index);tooltip.innerHTML=data.months[index]+'<b>'+nf.format(status.values[index])+'</b>';tooltip.hidden=false;const rect=event.target.getBoundingClientRect();tooltip.style.left=Math.min(rect.left,innerWidth-130)+'px';tooltip.style.top=Math.max(8,rect.top-58)+'px'});point.addEventListener('pointerleave',()=>tooltip.hidden=true)});
  return card;
}
const chartGrid=document.getElementById('chartGrid');
data.statuses.forEach(status=>{
  chartGrid.append(renderChart(status));
  if(status.code===0&&Array.isArray(status.qaValues)){
    const values=status.qaValues.map(value=>value??0);
    const rates=values.map((value,index)=>status.values[index]?value/status.values[index]*100:null);
    chartGrid.append(renderChart({code:0,displayCode:'QA',displayDescription:'Динамика ответов на коммуникации',values,rates,latest:values.at(-1),isQaResponse:true,qaValues:null}));
  }
});
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
