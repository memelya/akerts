/* Attribution explains observed changes; it never infers business causes. */
(()=>{
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;},known=Number.isFinite;
const number=v=>known(v)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(v):'Нет данных';
const date=m=>new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',...(m.length===10?{day:'numeric'}:{}),timeZone:'UTC'}).format(new Date(m+(m.length===7?'-01':'')+'T12:00:00Z'));
function analyze(data,metric,index,baseline){
 const rows=data.details.map((detail,i)=>{const block=detail.blocks.find(b=>b.metric===metric),values=block?.values||[],current=values[index]??null;
 const before=baseline==='average'?values.slice(Math.max(0,index-3),index).filter(known):index?[values[index-1]].filter(known):[];
 const reference=before.length?before.reduce((a,b)=>a+b,0)/before.length:null;
 return {member:data.members[i],index:i,current,reference,observations:before.length,delta:known(current)&&known(reference)?current-reference:null};});
 const observed=rows.filter(r=>known(r.current)),total=observed.length?observed.reduce((s,r)=>s+r.current,0):null;
 const comparable=rows.filter(r=>known(r.delta)),complete=comparable.length===rows.length;
 const change=comparable.length?comparable.reduce((s,r)=>s+r.delta,0):null;
 return {rows:rows.map(r=>({...r,share:total>0&&known(r.current)?r.current/total*100:null})),total,change,complete};
}
window.ProductExplorer={analyze,attach({data,charts,colors,onOpen}){
 const metrics=data.blocks.filter(b=>!['csi','plan','unique_surveys'].includes(b.metric));
 if(!data.details?.length||!data.members?.length||!metrics.length)return null;
 const normal=el('div');while(charts.firstChild)normal.append(charts.firstChild);charts.append(normal);
 const modes=el('div');modes.className='explorer-modes';const alt=el('div');alt.hidden=true;charts.append(alt);
 charts.before(modes);
 const panel=el('section');panel.className='product-explorer';charts.after(panel);
 const heading=el('h3','Что повлияло на показатель'),intro=el('p','Нажмите на период общего графика или выберите его ниже.');panel.append(heading,intro);
 const controls=el('div');controls.className='explorer-controls';panel.append(controls);
 const metric=el('select'),period=el('select'),baseline=el('select');metric.setAttribute('aria-label','Показатель для разбора');period.setAttribute('aria-label','Период для разбора');baseline.setAttribute('aria-label','С чем сравнивать');
 metrics.forEach(b=>metric.add(new Option(b.label,b.metric)));data.months.forEach((m,i)=>period.add(new Option(date(m),String(i))));baseline.add(new Option('С предыдущим периодом','previous'));baseline.add(new Option('Со средним за 3 предыдущих периода','average'));
 const label=(text,input)=>{const l=el('label',text);l.append(input);return l;};controls.append(label('Показатель',metric),label('Период',period),label('Сравнение',baseline));
 const body=el('div');body.setAttribute('aria-live','polite');panel.append(body);
 let view='total';const buttons={};
 for(const [key,text] of [['total','Общий график'],['surveys','Линии опросов'],['shares','Доли опросов']]){const b=el('button',text);b.type='button';b.dataset.explorerView=key;b.onclick=()=>{view=key;drawView();};modes.append(b);buttons[key]=b;}
 function select(key){const index=data.months.indexOf(key);if(index<0)return;period.value=String(index);drawPanel();}
 function series(){return data.details.map((detail,i)=>({key:'member:'+i,label:'#'+data.members[i].id+' · '+(data.members[i].channel==='success_screen'?'Экран успеха':'Пуш+СМС'),color:colors[i%colors.length],values:detail.blocks.find(b=>b.metric===metric.value)?.values||[]}));}
 function drawView(){
  normal.hidden=view!=='total';alt.hidden=view==='total';Object.entries(buttons).forEach(([key,b])=>b.setAttribute('aria-pressed',String(key===view)));
  alt.querySelectorAll('.v2-chart').forEach(c=>c.destroy?.());alt.replaceChildren();if(view==='total')return;
  const items=series();
  if(view==='surveys'){
   window.V2Chart(alt,{title:metric.selectedOptions[0].text+' по опросам',badge:'Состав продукта',context:data.periodLabel,help:'Нажмите на точку, чтобы разобрать вклад опросов за период.',onSelect:r=>select(r.key),modes:[{key:'period',label:'По периодам',rows:data.months.map((m,i)=>({key:m,label:date(m),short:m.length===10?m.slice(8)+'.'+m.slice(5,7):date(m),...Object.fromEntries(items.map(s=>[s.key,s.values[i]??null]))}))}],series:items.map(s=>({...s,total:s.values[Number(period.value)]})),receipt:[['Расчёт','Исходные значения по каждому опросу. Пропуски не заменяются нулями.']]});return;
  }
  alt.append(el('h3','Доли опросов · '+metric.selectedOptions[0].text),el('p','Каждый столбец — 100% известных значений периода. Нажмите на сегмент для подробного разбора.'));
  const legend=el('div');legend.className='explorer-modes';items.forEach(s=>{const label=el('span',s.label);label.style.borderLeft='8px solid '+s.color;label.style.paddingLeft='8px';legend.append(label);});alt.append(legend);
  const scroll=el('div');scroll.className='explorer-composition';alt.append(scroll);
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),width=Math.max(700,scroll.clientWidth,data.months.length*78+70),height=320,slot=(width-70)/data.months.length;svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('role','group');svg.setAttribute('aria-label','Доли опросов по периодам');scroll.append(svg);
  const shape=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));if(text!==undefined)n.textContent=text;svg.append(n);return n;};
  for(let t=0;t<=100;t+=25){const y=270-t*2.3;shape('line',{x1:50,x2:width-10,y1:y,y2:y,stroke:'#313131'});shape('text',{x:4,y:y+4,fill:'#b5b5b5','font-size':12},t+'%');}
  data.months.forEach((m,i)=>{const vals=items.map(s=>s.values[i]),total=vals.filter(known).reduce((a,b)=>a+b,0);let y=270;const x=60+i*slot;
   vals.forEach((v,j)=>{if(!known(v)||!total)return;const h=v/total*230;y-=h;const rect=shape('rect',{x,y,width:48,height:h,fill:items[j].color,tabindex:0,'data-share-member':j,'data-share-period':m,role:'button','aria-label':`${date(m)} · ${items[j].label} · ${number(v/total*100)}%`});const title=document.createElementNS(ns,'title');title.textContent=`${date(m)} · ${items[j].label}: ${number(v)} (${number(v/total*100)}%)`;rect.append(title);rect.onclick=()=>select(m);rect.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(m);}};});
   shape('text',{x:x+24,y:300,'text-anchor':'middle',fill:'#b5b5b5','font-size':11},m);if(!total)shape('text',{x:x+24,y:155,'text-anchor':'middle',fill:'#b5b5b5','font-size':11},vals.some(known)?'Σ = 0':'Нет данных');
  });
 }
 function drawPanel(){
  const result=analyze(data,metric.value,Number(period.value),baseline.value),signed=v=>known(v)?(v>0?'+':'')+number(v):'Нет сравнения';body.replaceChildren();
  const summary=el('p');summary.className='explorer-summary';summary.textContent=`${date(data.months[Number(period.value)])}: ${number(result.total)} · изменение ${signed(result.change)}${result.complete?'':' по сопоставимым опросам'}`;body.append(summary);
  const growth=result.rows.filter(r=>r.delta>0).sort((a,b)=>b.delta-a.delta),fall=result.rows.filter(r=>r.delta<0).sort((a,b)=>a.delta-b.delta);
  if(growth.length)body.append(el('p',`Наибольший рост: ${growth.slice(0,3).map(r=>'#'+r.member.id+' ('+signed(r.delta)+')').join(', ')}.`));
  if(fall.length)body.append(el('p',`Наибольшее снижение: ${fall.slice(0,3).map(r=>'#'+r.member.id+' ('+signed(r.delta)+')').join(', ')}.`));
  if(!result.complete)body.append(el('p','Для части опросов нет значения в выбранном периоде или базе сравнения. Они отмечены ниже; пропуски не считаются нулём.'));
  const table=el('table');table.className='explorer-table';const head=el('tr');['Опрос и канал','Значение','Доля','База сравнения','Изменение','Подробнее'].forEach(t=>head.append(el('th',t)));const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');
  result.rows.sort((a,b)=>Math.abs(b.delta??0)-Math.abs(a.delta??0)||(b.current??-1)-(a.current??-1)).forEach(r=>{const row=el('tr');row.dataset.contributor=r.member.id;const name=el('td',`#${r.member.id} · ${r.member.name} · ${r.member.channel==='success_screen'?'Экран успеха':'Пуш+СМС'}`);const swatch=el('i');swatch.style.background=colors[r.index%colors.length];name.prepend(swatch);row.append(name,el('td',number(r.current)),el('td',known(r.share)?number(r.share)+'%':'—'),el('td',number(r.reference)+(baseline.value==='average'&&r.observations?' · '+r.observations+' период(а)':'')),el('td',signed(r.delta)));const cell=el('td'),open=el('button','График');open.type='button';open.onclick=()=>onOpen(r.index);cell.append(open);row.append(cell);tbody.append(row);});table.append(tbody);const wrap=el('div');wrap.className='table-wrap';wrap.append(table);body.append(wrap,el('p','Вклад — значение опроса минус его база сравнения. Это показывает источник изменения объёма, но не доказывает сбой или разовый запуск. Проверяйте полноту текущего периода.'));
 }
 const first=series()[0];period.value=String(Math.max(0,data.months.findLastIndex((m,i)=>data.details.some(d=>known(d.blocks.find(b=>b.metric===metric.value)?.values[i])))));
 metric.onchange=()=>{drawPanel();drawView();};period.onchange=drawPanel;baseline.onchange=drawPanel;drawView();drawPanel();return {select};
}};
})();
