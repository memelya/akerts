/* Обзор по разрезам: пуш + СМС, экраны успеха и топ опросы рядом, за один период.
   Все числа считает сервер (/api/pulse, action=segments); суммы — целые, форматы выдерживают миллиарды. */
(()=>{'use strict';
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),df=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}),cf=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
const finite=Number.isFinite;
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n;};
const ns='http://www.w3.org/2000/svg',svg=(tag,attrs={},text)=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
const COLORS={communication:'var(--accent,#ff8a35)',success_screen:'#5aa2e6',top:'#c4a7f0'};
/* 1 234 → «1 234», 45 600 → «45,6 тыс.», 12 300 000 → «12,3 млн», 1 230 000 000 → «1,23 млрд» */
function compact(v){if(!finite(v))return '—';const a=Math.abs(v);if(a>=1e12)return df.format(v/1e12)+' трлн';if(a>=1e9)return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v/1e9)+' млрд';if(a>=1e6)return df.format(v/1e6)+' млн';if(a>=1e4)return df.format(v/1e3)+' тыс.';return nf.format(v);}
const full=v=>finite(v)?nf.format(v):'—';
const pct=v=>finite(v)?(Math.abs(v)<1&&v!==0?cf:df).format(v)+'%':'—';
function change(now,before){if(!finite(now)||!finite(before)||!before)return null;return (now-before)/before*100;}
function deltaText(now,before,kind){if(!finite(now)||!finite(before))return {text:'нет сравнения',tone:'flat'};if(kind==='rate'){const d=now-before;return {text:(d>0.005?'+':d<-0.005?'−':'')+cf.format(Math.abs(d))+' п.п.',tone:d<=-0.005?'down':d>=0.005?'up':'flat'};}if(kind==='csi'){const d=now-before;return {text:(d>0.005?'+':d<-0.005?'−':'')+cf.format(Math.abs(d)),tone:d<=-0.05?'down':d>=0.05?'up':'flat'};}const c=change(now,before);if(c===null)return {text:before===0&&now>0?'было 0':'нет сравнения',tone:'flat'};return {text:(c>0?'+':c<0?'−':'')+df.format(Math.abs(c))+'%',tone:c<=-5?'down':c>=5?'up':'flat'};}
function sparkline(values,color,w=88,h=24){const s=svg('svg',{width:w,height:h,viewBox:`0 0 ${w} ${h}`,'aria-hidden':'true'}),v=values.map(x=>finite(x)?x:null),known=v.filter(x=>x!==null);if(known.length<2)return s;const lo=Math.min(...known),hi=Math.max(...known),r=hi-lo||1;let d='';v.forEach((x,i)=>{if(x===null)return;d+=(d?'L':'M')+(i*w/(v.length-1)).toFixed(1)+','+(h-2-(x-lo)/r*(h-4)).toFixed(1);});s.append(svg('path',{d,fill:'none',stroke:color,'stroke-width':1.6}));return s;}
async function post(body){const r=await fetch('/api/pulse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d;try{d=await r.json();}catch{throw new Error('Сервер вернул неожиданный ответ.');}if(!r.ok||d.error)throw new Error(d.error||'Ошибка запроса');return d;}

function create(main){
 const page=el('section','trust-page segments-page');page.hidden=true;page.setAttribute('aria-labelledby','segmentsTitle');main.append(page);
 const rail=document.querySelector('.rail'),link=el('a','nav-item','Обзор по разрезам');link.href='#segments';
 const pulseLink=rail.querySelector('a[href="#pulse"]');if(pulseLink)pulseLink.after(link);else rail.insertBefore(link,rail.querySelector('.history'));
 let period='week',data=null,tableSegment='all',sortKey='answers',sortDir=-1,shown=50,loading=false;
 const head=el('header','seg-head'),titleBox=el('div'),title=el('h1','','Обзор по разрезам');title.id='segmentsTitle';
 const sub=el('p','seg-muted'),status=el('p','pulse-status');status.setAttribute('role','status');
 const periods=el('div','seg-periods');periods.setAttribute('role','group');periods.setAttribute('aria-label','Период');
 for(const [k,t] of [['week','Неделя'],['month','Месяц'],['quarter','Квартал']]){const b=el('button','seg-btn',t);b.type='button';b.dataset.period=k;b.onclick=()=>{period=k;load();};periods.append(b);}
 titleBox.append(title,sub);head.append(titleBox,periods);
 const body=el('div','seg-body');page.append(head,status,body);

 async function load(){
  if(loading)return;loading=true;for(const b of periods.children)b.setAttribute('aria-pressed',String(b.dataset.period===period));
  status.textContent='Считаем разрезы…';status.classList.remove('is-error');
  try{data=await post({action:'segments',period});status.textContent='';shown=50;render();}
  catch(error){status.textContent=error.message;status.classList.add('is-error');}
  finally{loading=false;}
 }
 const openCheck=(channel,id)=>window.PulseCheck?window.PulseCheck(channel,id):(location.hash='#pulse');
 function surveyLink(item){const b=el('button','seg-link','#'+item.id+' · '+item.name);b.type='button';b.title='Открыть проверки опроса';b.onclick=()=>openCheck(item.channel,item.id);return b;}
 function render(){
  const w=data.windows,cur=w.at(-1),prev=w.at(-2);
  sub.textContent=cur.label+' к '+prev.label+' · данные по '+new Date(data.through+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'numeric',month:'long',timeZone:'UTC'})+(period!=='week'?' · последний полный '+(period==='month'?'месяц':'квартал'):'');
  body.replaceChildren(columns(),healthBlock(),dynamics(),concentration(),surveysTable(),el('p','seg-muted',data.method));
 }
 function columns(){
  const grid=el('section','seg-columns');grid.setAttribute('aria-label','Разрезы');
  for(const s of data.segments){
   const card=el('article','seg-card');card.style.borderTopColor=COLORS[s.key];
   const h=el('div','seg-card-head');h.append(el('h2','',s.label),el('span','seg-muted',s.active+' с данными из '+s.catalog));card.append(h);
   const tiles=el('div','seg-tiles'),c=s.current,p=s.previous,series=s.series;
   const tile=(label,value,fullValue,d,points)=>{const t=el('div','seg-tile');t.append(el('span','seg-muted',label));const b=el('b','',value);if(fullValue)b.title=fullValue;t.append(b);const row=el('div','seg-tile-foot');row.append(el('span','seg-delta '+d.tone,d.text),sparkline(points,COLORS[s.key]));t.append(row);return t;};
   tiles.append(
    tile(s.key==='success_screen'?'Показы (SENDED)':s.key==='top'?'Отправки и показы':'Отправки',compact(c.sends),full(c.sends),deltaText(c.sends,p.sends),series.map(x=>x.sends)),
    tile('Ответы',compact(c.answers),full(c.answers),deltaText(c.answers,p.answers),series.map(x=>x.answers)),
    tile('Конверсия',pct(c.conversion),'',deltaText(c.conversion,p.conversion,'rate'),series.map(x=>x.conversion)),
    tile('CSI · '+compact(c.csiSample)+' оценок',finite(c.csi)?cf.format(c.csi):'—','',deltaText(c.csi,p.csi,'csi'),series.map(x=>x.csiSample>=30?x.csi:null)));
   card.append(tiles);
   if(s.extra.length){const list=el('dl','seg-extra');for(const e of s.extra){const row=el('div');row.append(el('dt','',e.label),el('dd','',(e.unit==='%'?pct(e.value):compact(e.value))+(e.note?' · '+e.note:'')));list.append(row);}card.append(list);}
   grid.append(card);
  }
  return grid;
 }
 function healthBlock(){
  const sec=el('section','seg-card seg-wide');sec.setAttribute('aria-labelledby','segHealth');const h=el('h2','','Здоровье опросов');h.id='segHealth';
  const head=el('div','seg-card-head');head.append(h,el('span','seg-muted','правила «Проверок опроса» за последние 2 недели'));sec.append(head);
  const grid=el('div','seg-columns');
  for(const s of data.segments){
   const col=el('div','seg-health');const t=el('div','seg-health-title'),dot=el('i','seg-dot');dot.style.background=COLORS[s.key];
   t.append(dot,el('b','',s.label),el('span','seg-tag '+(s.health.flagged?'bad':'good'),s.health.flagged?'С проблемами: '+s.health.flagged+' из '+s.health.checked:'Проблем нет'));col.append(t);
   const chips=el('div','seg-chips');for(const r of s.health.rules){if(!r.problem&&!r.attention)continue;const c=el('span','seg-chip');c.append(el('strong',r.problem?'bad':'warn',String(r.problem||r.attention)),document.createTextNode(' '+r.label+(r.problem?'':' (внимание)')));chips.append(c);}
   if(!chips.childElementCount)chips.append(el('span','seg-muted','Все правила в норме.'));col.append(chips);
   if(s.health.worst.length){const ol=el('ol','seg-worst');for(const x of s.health.worst.slice(0,3)){const li=el('li');li.append(surveyLink(x),el('span','seg-muted',' · '+x.problems.join(', ')));ol.append(li);}col.append(ol);}
   grid.append(col);
  }
  sec.append(grid);return sec;
 }
 function dynamics(){
  const wrap=el('section','seg-two');
  /* ответы: каждый разрез на своей полосе со своей шкалой; подпись — последнее значение */
  const a=el('article','seg-card');a.append(el('h2','','Ответы по '+({week:'неделям',month:'месяцам',quarter:'кварталам'})[period]));
  const W=640,lane=64,H=data.segments.length*lane+24,root=svg('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%',role:'img','aria-label':'Ответы по периодам, каждый разрез на своей шкале'});
  data.segments.forEach((s,i)=>{const v=s.series.map(x=>x.answers),max=Math.max(1,...v),top=i*lane+18,h=lane-26,x=k=>40+k*(W-200)/Math.max(1,v.length-1),y=val=>top+h-(val/max)*h;
   root.append(svg('line',{x1:40,x2:W-160,y1:top+h,y2:top+h,class:'seg-grid'}));let d='';v.forEach((val,k)=>{d+=(d?'L':'M')+x(k).toFixed(1)+','+y(val).toFixed(1);});const path=svg('path',{d,fill:'none','stroke-width':2.4});path.style.stroke=COLORS[s.key];root.append(path);
   const label=svg('text',{x:W-150,y:y(v.at(-1))+4,class:'seg-label'},s.label+' · '+compact(v.at(-1)));label.style.fill=COLORS[s.key];root.append(label);});
  const lastSeries=data.segments[0].series;root.append(svg('text',{x:40,y:H-2,class:'seg-axis'},lastSeries[0].label),svg('text',{x:W-160,y:H-2,'text-anchor':'end',class:'seg-axis'},lastSeries.at(-1).label));
  a.append(root);
  const b=el('article','seg-card');b.append(el('h2','','CSI'));
  const all=data.segments.flatMap(s=>s.series.filter(x=>x.csiSample>=30).map(x=>x.csi)).filter(finite);
  if(!all.length){b.append(el('p','seg-muted','Мало оценок для сравнения.'));wrap.append(a,b);return wrap;}
  const lo=Math.floor(Math.min(...all)*20)/20,hi=Math.ceil(Math.max(...all)*20)/20||lo+0.05,H2=220,r2=svg('svg',{viewBox:`0 0 ${W} ${H2}`,width:'100%',role:'img','aria-label':'CSI по периодам по трём разрезам'}),yy=v=>16+(H2-40)*(1-(v-lo)/Math.max(0.05,hi-lo)),xx=(k,n)=>40+k*(W-200)/Math.max(1,n-1);
  for(const v of [lo,(lo+hi)/2,hi]){r2.append(svg('line',{x1:40,x2:W-160,y1:yy(v),y2:yy(v),class:'seg-grid'}),svg('text',{x:34,y:yy(v)+4,'text-anchor':'end',class:'seg-axis'},cf.format(v)));}
  for(const s of data.segments){let d='';const n=s.series.length;s.series.forEach((x,k)=>{if(x.csiSample<30||!finite(x.csi)){return;}d+=(d?'L':'M')+xx(k,n).toFixed(1)+','+yy(x.csi).toFixed(1);});if(!d)continue;const p=svg('path',{d,fill:'none','stroke-width':2.4});p.style.stroke=COLORS[s.key];r2.append(p);const last=[...s.series].reverse().find(x=>x.csiSample>=30&&finite(x.csi));if(last){const t=svg('text',{x:W-150,y:yy(last.csi)+4,class:'seg-label'},s.label+' · '+cf.format(last.csi));t.style.fill=COLORS[s.key];r2.append(t);}}
  b.append(r2,el('p','seg-muted','Точка только при 30 и больше оценках за период.'));
  wrap.append(a,b);return wrap;
 }
 function concentration(){
  const sec=el('section','seg-card seg-wide');sec.append(el('h2','','Концентрация и лидеры изменений'));const grid=el('div','seg-columns');
  for(const s of data.segments){
   const c=s.concentration,col=el('div','seg-health');const t=el('b','',s.label);t.style.color=COLORS[s.key];col.append(t);
   if(!finite(c.top10)){col.append(el('p','seg-muted','Нет ответов за период.'));grid.append(col);continue;}
   const bar=el('div','seg-bar'),fill=el('i');fill.style.width=Math.min(100,c.top10)+'%';fill.style.background=COLORS[s.key];bar.append(fill);
   col.append(el('span','seg-muted','10 крупнейших опросов дают ответов'),bar,el('span','','10 опросов: '+pct(c.top10)+' · 80% ответов дают '+c.p80+' из '+c.surveys));
   const lists=el('div','seg-leaders');for(const [name,items,cls] of [['Рост ответов',c.up,'up'],['Падение ответов',c.down,'down']]){const box=el('div');box.append(el('span','seg-muted',name));if(!items.length)box.append(el('p','seg-muted','нет'));for(const x of items){const row=el('div','seg-leader');row.append(surveyLink(x),el('span','seg-delta '+cls,(x.change>0?'+':'−')+df.format(Math.abs(x.change))+'%'));box.append(row);}lists.append(box);}
   col.append(lists);grid.append(col);
  }
  sec.append(grid);return sec;
 }
 function surveysTable(){
  const sec=el('section','seg-card seg-wide');const head=el('div','seg-card-head');head.append(el('h2','','Опросы'));
  const filter=el('div','seg-periods');filter.setAttribute('role','group');filter.setAttribute('aria-label','Разрез таблицы');
  for(const [k,t] of [['all','Все'],['communication','Пуш + СМС'],['success_screen','Экраны успеха'],['top','Топ']]){const b=el('button','seg-btn',t);b.type='button';b.setAttribute('aria-pressed',String(tableSegment===k));b.onclick=()=>{tableSegment=k;shown=50;sec.replaceWith(surveysTable());};filter.append(b);}
  head.append(filter);sec.append(head);
  const rows=data.table.filter(r=>tableSegment==='all'||(tableSegment==='top'?r.top:r.channel===tableSegment));
  const value=(r,k)=>k==='sendsChange'?change(r.sends,r.sendsPrev):k==='answersChange'?change(r.answers,r.answersPrev):k==='checks'?r.problems*100+r.attention:r[k];
  rows.sort((a,b)=>{const x=value(a,sortKey),y=value(b,sortKey);return ((x??-Infinity)>(y??-Infinity)?1:(x??-Infinity)<(y??-Infinity)?-1:0)*sortDir;});
  const wrap=el('div','seg-table-wrap'),table=el('table','seg-table'),tr=el('tr');
  for(const [k,label] of [['name','Опрос'],['channel','Канал'],['sends','Отправки'],['sendsChange','Δ'],['answers','Ответы'],['answersChange','Δ'],['conversion','Конверсия'],['csi','CSI'],['spark','Динамика ответов'],['checks','Проверки']]){
   const th=el('th');th.scope='col';if(['spark','name','channel'].includes(k))th.textContent=label;else{const b=el('button','seg-sort',label+(sortKey===k?(sortDir<0?' ↓':' ↑'):''));b.type='button';b.onclick=()=>{sortDir=sortKey===k?-sortDir:-1;sortKey=k;sec.replaceWith(surveysTable());};th.append(b);th.setAttribute('aria-sort',sortKey===k?(sortDir<0?'descending':'ascending'):'none');}tr.append(th);}
  const thead=el('thead');thead.append(tr);table.append(thead);const tbody=el('tbody');
  for(const r of rows.slice(0,shown)){const row=el('tr'),name=el('td');name.append(surveyLink(r));if(r.top)name.append(el('span','seg-tag','топ'));
   const sd=deltaText(r.sends,r.sendsPrev),ad=deltaText(r.answers,r.answersPrev),checks=el('td');checks.append(el('span','seg-tag '+(r.problems?'bad':r.attention?'warn':'good'),r.problems?'Проблем: '+r.problems:r.attention?'Внимание: '+r.attention:'Норма'));
   const spark=el('td');spark.append(sparkline(r.spark,'#bdbdbd',80,20));
   row.append(name,el('td','seg-muted-cell',r.channel==='success_screen'?'Экраны успеха':'Пуш + СМС'),el('td','',full(r.sends)),el('td','seg-delta '+sd.tone,sd.text),el('td','',full(r.answers)),el('td','seg-delta '+ad.tone,ad.text),el('td','',pct(r.conversion)),el('td','',finite(r.csi)&&r.csiSample>=30?cf.format(r.csi):'—'),spark,checks);tbody.append(row);}
  table.append(tbody);wrap.append(table);sec.append(wrap);
  if(rows.length>shown){const more=el('button','seg-btn','Показать ещё '+Math.min(50,rows.length-shown)+' из '+(rows.length-shown));more.type='button';more.onclick=()=>{shown+=50;sec.replaceWith(surveysTable());};sec.append(more);}
  if(!rows.length)sec.append(el('p','seg-muted','Опросов с данными за период нет.'));
  return sec;
 }
 function show(){window.scrollTo(0,0);load();}
 return {page,show};
}
window.SegmentsUI={create,compact};
})();
