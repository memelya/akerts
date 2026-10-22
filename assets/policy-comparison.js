/* Absolute event counts on ONE scale; no per-series normalization. */
(() => {
 const data=window.EVENT_DATA,grid=document.getElementById('chartGrid');
 if(!data||!grid||data.channel==='success_screen'||document.getElementById('policy-comparison'))return;
 const nf=new Intl.NumberFormat('ru-RU'),compact=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
 const names=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
 const month=m=>names[Number(m.slice(5))-1]+' '+m.slice(2,4);
 const series=[{code:1002,label:'Стоп-листы Массперс',description:'Найден в стоп-листе',color:'#d89b4b',dash:''},{code:1011,label:'Групповая политика контактов',description:'Недавно участвовал в опросе группы',color:'#8c7bd6',dash:'7 5'}].map(s=>{
  const status=data.statuses.find(item=>Number(item.code)===s.code);
  return {...s,available:Boolean(status),values:data.months.map((_,i)=>status?(status.values[i]??0):null),visible:Boolean(status)};
 });
 const card=document.createElement('article');card.id='policy-comparison';card.className='chart-card policy-comparison';
 card.setAttribute('aria-labelledby','policy-comparison-title');
 const header=document.createElement('header');header.className='policy-comparison-header';
 header.innerHTML='<div><span class="policy-comparison-eyebrow">СРАВНЕНИЕ ПРИЧИН ОТСЕЧЕНИЯ</span><h3 id="policy-comparison-title">Стоп-листы Массперс и групповая политика</h3><p>Количество событий по месяцам · единая линейная шкала · без нормирования</p></div><button type="button" class="policy-comparison-expand" aria-expanded="false">⛶ Развернуть</button>';
 card.append(header);
 const legend=document.createElement('div');legend.className='policy-comparison-legend';
 series.forEach(s=>{
  const label=document.createElement('label');label.className='policy-comparison-series';label.style.setProperty('--series-color',s.color);
  const input=document.createElement('input');input.type='checkbox';input.checked=s.visible;input.disabled=!s.available;input.setAttribute('aria-label','Показать '+s.label+' · '+s.code);
  const line=document.createElement('i');if(s.dash)line.className='is-dashed';
  const title=document.createElement('span');const b=document.createElement('b');b.textContent=s.label+' · '+s.code;const small=document.createElement('small');small.textContent=s.description;title.append(b,small);
  const value=document.createElement('strong');value.textContent=s.available?nf.format(s.values.at(-1)):'—';const period=document.createElement('small');period.textContent=s.available?data.months.at(-1):'Нет данных о статусе';value.append(period);
  label.append(input,line,title,value);legend.append(label);input.addEventListener('change',()=>{s.visible=input.checked;render();});
 });
 card.append(legend);
 const missing=series.filter(s=>!s.available);if(missing.length){const p=document.createElement('p');p.className='policy-comparison-note';p.textContent='В выгрузке отсутствует '+missing.map(s=>'статус '+s.code).join(' и ')+'. Соответствующая линия не строится; отсутствие данных не подменяется нулём.';card.append(p);}
 const plot=document.createElement('div');plot.className='policy-comparison-plot';card.append(plot);
 const message=document.createElement('p');message.className='policy-comparison-note';message.setAttribute('role','status');card.append(message);
 const details=document.createElement('details');details.className='policy-comparison-table';details.open=matchMedia('(max-width:560px)').matches;
 const summary=document.createElement('summary');summary.textContent='Точные значения по месяцам';details.append(summary);
 const table=document.createElement('table');table.innerHTML='<caption>Опрос '+data.id+' · cnt по статусам 1002 и 1011</caption><thead><tr><th>Месяц</th><th>Массперс · 1002</th><th>Групповая политика · 1011</th></tr></thead>';
 const tbody=document.createElement('tbody');data.months.forEach((m,i)=>{const row=document.createElement('tr');const cell=document.createElement('td');cell.textContent=m;row.append(cell);series.forEach(s=>{const td=document.createElement('td');td.textContent=s.values[i]===null?'—':nf.format(s.values[i]);td.dataset.code=String(s.code);td.dataset.value=s.values[i]===null?'':String(s.values[i]);row.append(td);});tbody.append(row);});table.append(tbody);details.append(table);card.append(details);
 const anchors=[...grid.querySelectorAll('.chart-card')].filter(el=>['0','QA','CSI'].includes(el.querySelector('.status-chip')?.textContent.trim()));if(anchors.length)anchors.at(-1).after(card);else grid.prepend(card);
 const counter=document.querySelector('.section-heading--charts>span');if(counter)counter.textContent=grid.querySelectorAll('.chart-card').length+' графиков';
 const svgNS='http://www.w3.org/2000/svg';
 function node(tag,attrs={},text){const el=document.createElementNS(svgNS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;return el;}
 function niceMax(v){if(v<=0)return 1;const power=10**Math.floor(Math.log10(v)),ratio=v/power;return (ratio<=1?1:ratio<=2?2:ratio<=5?5:10)*power;}
 function render(){
  const mobile=plot.clientWidth<540,width=Math.max(260,Math.floor(plot.clientWidth||700)),height=mobile?260:330,pad={l:mobile?55:72,r:22,t:26,b:40},pw=width-pad.l-pad.r,ph=height-pad.t-pad.b;
  const maximum=niceMax(Math.max(0,...series.flatMap(s=>s.values.filter(v=>v!==null))));
  const svg=node('svg',{viewBox:'0 0 '+width+' '+height,role:'img','aria-label':'Сравнение количества событий: Массперс 1002 и групповая политика 1011. Общая шкала от 0 до '+nf.format(maximum)});
  for(let i=0;i<=4;i++){const f=i/4,y=height-pad.b-f*ph;svg.append(node('line',{x1:pad.l,x2:width-pad.r,y1:y,y2:y,class:'policy-comparison-grid'}),node('text',{x:pad.l-9,y:y+4,'text-anchor':'end',class:'policy-comparison-axis'},compact.format(maximum*f)));}
  const labelCount=mobile?Math.min(5,data.months.length):data.months.length;const indices=new Set(Array.from({length:labelCount},(_,i)=>Math.round(i*(data.months.length-1)/Math.max(1,labelCount-1))));
  const x=i=>pad.l+i/Math.max(1,data.months.length-1)*pw,y=v=>height-pad.b-v/maximum*ph;
  data.months.forEach((m,i)=>{if(indices.has(i))svg.append(node('text',{x:x(i),y:height-12,'text-anchor':'middle',class:'policy-comparison-axis'},month(m)));});
  series.filter(s=>s.visible).forEach(s=>{
   const d=s.values.map((v,i)=>(i?'L':'M')+x(i)+','+y(v)).join(' ');svg.append(node('path',{d,stroke:s.color,'stroke-dasharray':s.dash||'none',fill:'none','stroke-width':2.8,'stroke-linejoin':'round','stroke-linecap':'round','data-code':s.code}));
   s.values.forEach((v,i)=>{const point=node('circle',{cx:x(i),cy:y(v),r:4,fill:s.color,stroke:'#fff','stroke-width':2,tabindex:0,'data-code':s.code,'data-index':i,'data-value':v,'aria-label':data.months[i]+', '+s.label+': '+nf.format(v)+' событий'});point.append(node('title',{},data.months[i]+' · '+s.label+': '+nf.format(v)));const announce=()=>{message.textContent=data.months[i]+' · '+s.label+': '+nf.format(v)+' событий';};point.addEventListener('pointerenter',announce);point.addEventListener('focus',announce);point.addEventListener('click',announce);svg.append(point);});
  });
  plot.replaceChildren(svg);message.textContent=series.some(s=>s.visible)?'Шкала общая для обеих линий. Наведите на точку или нажмите её, чтобы увидеть точное значение.':series.some(s=>s.available)?'Выберите хотя бы одну линию в легенде.':'Нет данных по обоим статусам.';
 }
 render();if(window.ResizeObserver)new ResizeObserver(render).observe(plot);else window.addEventListener('resize',render);
 const expand=header.querySelector('button');expand.addEventListener('click',async()=>{try{if(document.fullscreenElement===card){await document.exitFullscreen();return;}if(card.requestFullscreen){await card.requestFullscreen();return;}}catch{}card.classList.toggle('policy-comparison-expanded');expand.setAttribute('aria-expanded',String(card.classList.contains('policy-comparison-expanded')));expand.textContent=card.classList.contains('policy-comparison-expanded')?'Свернуть':'⛶ Развернуть';render();});
 document.addEventListener('fullscreenchange',()=>{const active=document.fullscreenElement===card;expand.setAttribute('aria-expanded',String(active));expand.textContent=active?'Свернуть':'⛶ Развернуть';render();});
})();
