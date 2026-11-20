/* Экран загрузки данных. Пока сервер импортирует CSV и готовит брифинг, страница не пустая:
   кольцо прогресса, бегущий пульс, стадии импорта и файлы с размерами. Опрос /api/loading без блокировок. */
(function(){
 const NS='http://www.w3.org/2000/svg';
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
 const svg=(tag,attrs)=>{const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs||{}))n.setAttribute(k,v);return n;};
 const mb=bytes=>bytes>=1048576?(bytes/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МБ':Math.max(1,Math.round(bytes/1024)).toLocaleString('ru-RU')+' КБ';
 const rows=n=>n>=1e6?(n/1e6).toLocaleString('ru-RU',{maximumFractionDigits:2})+' млн строк':n>=1e3?Math.round(n/1e3).toLocaleString('ru-RU')+' тыс. строк':n.toLocaleString('ru-RU')+' строк';
 const seconds=s=>s<60?Math.max(1,Math.round(s))+' с':Math.floor(s/60)+' мин '+String(Math.round(s%60)).padStart(2,'0')+' с';
 const files=n=>n===1?'файл':n>=2&&n<=4?'файла':'файлов';
 const R=74,C=2*Math.PI*R;
 // Кривая пульса: ровная линия с ударом посередине. Повторяется дважды, чтобы бег был бесшовным.
 const BEAT='h46 l8 -6 l7 12 l9 -54 l10 78 l9 -42 l7 12 h44';
 let root=null,parts=null,state=null,shown=0,target=0,raf=0,timer=0,waiters=[],startedAt=0,closing=false,seenActive=false;

 function build(){
  root=el('div','dl-overlay');root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-labelledby','dlTitle');
  const card=el('div','dl-card');
  const ring=svg('svg',{viewBox:'0 0 180 180',class:'dl-ring','aria-hidden':'true'});
  const track=svg('circle',{cx:90,cy:90,r:R,class:'dl-track'});
  const ticks=svg('g',{class:'dl-ticks'});
  for(let i=0;i<60;i++){const a=i/60*2*Math.PI,r1=R+12,r2=R+(i%5?15:18);ticks.append(svg('line',{x1:90+r1*Math.sin(a),y1:90-r1*Math.cos(a),x2:90+r2*Math.sin(a),y2:90-r2*Math.cos(a)}));}
  const bar=svg('circle',{cx:90,cy:90,r:R,class:'dl-bar','stroke-dasharray':C,'stroke-dashoffset':C,transform:'rotate(-90 90 90)'});
  const orbit=svg('g',{class:'dl-orbit'});orbit.append(svg('circle',{cx:90,cy:90-R,r:4,class:'dl-comet'}),svg('circle',{cx:90,cy:90-R,r:10,class:'dl-comet-glow'}));
  ring.append(ticks,track,bar,orbit);
  const center=el('div','dl-center');const percent=el('b','dl-percent','0');const unit=el('span','dl-unit','%');const step=el('span','dl-step','');
  const pct=el('div','dl-pct');pct.append(percent,unit);center.append(pct,step);
  const dial=el('div','dl-dial');dial.append(ring,center);
  const eyebrow=el('p','dl-eyebrow','');const title=el('h2','dl-title','Загружаем данные');title.id='dlTitle';
  const lead=el('p','dl-lead','');const live=el('p','dl-live','');live.setAttribute('role','status');live.setAttribute('aria-live','polite');
  const wave=svg('svg',{viewBox:'0 0 280 90',class:'dl-wave',preserveAspectRatio:'none','aria-hidden':'true'});
  const d='M0 50 '+BEAT+' '+BEAT;
  wave.append(svg('path',{d:'M0 50 H280',class:'dl-wave-base'}),svg('path',{d,class:'dl-wave-trail'}),svg('path',{d,class:'dl-wave-line'}));
  const phases=el('ol','dl-phases');const fileList=el('ul','dl-files');
  const foot=el('p','dl-foot','');
  const head=el('div','dl-head');head.append(dial,el('div','dl-copy'));head.lastChild.append(eyebrow,title,lead,live);
  card.append(head,wave,phases,fileList,foot);root.append(card);
  document.body.append(root);
  parts={bar,percent,step,eyebrow,lead,live,phases,fileList,foot,title};
  requestAnimationFrame(()=>root.classList.add('is-open'));
 }

 // Внутри стадии сервер сообщает долю не всегда (запись индексов, расчёт брифинга): полоса подползает сама, но не обгоняет следующую стадию.
 function tick(){
  raf=0;if(!root)return;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const creep=state&&state.active&&!closing?Math.min(target+3,99.4):target;
  const goal=Math.max(target,shown<creep?shown+0.012:shown);
  shown=reduce?goal:shown+(goal-shown)*0.12;
  if(Math.abs(goal-shown)<0.05)shown=goal;
  const value=Math.min(100,shown);
  parts.bar.setAttribute('stroke-dashoffset',String(C*(1-value/100)));
  parts.percent.textContent=String(Math.floor(value));
  if(state&&state.active&&state.elapsed!=null){const local=state.elapsed+(performance.now()-startedAt)/1000;parts.foot.textContent=footText(local);}
  if(root&&(closing?shown<99.9:true))raf=requestAnimationFrame(tick);
 }
 function footText(elapsed){
  const estimate=state&&state.estimate;
  let text='Прошло '+seconds(elapsed);
  if(estimate&&estimate>3){const left=estimate-elapsed;text+=left>2?' · осталось около '+seconds(left):' · почти готово';}
  return text+'. Можно не закрывать вкладку: страница откроется сама.';
 }

 function render(next){
  if(!next||!next.active)return;
  if(!root)build();
  state=next;startedAt=performance.now();target=Math.max(target,Number(next.percent)||0);
  const total=(next.files||[]).reduce((s,f)=>s+(f.size||0),0),count=(next.files||[]).filter(f=>f.size).length;
  parts.eyebrow.textContent=next.firstRun?'Первый запуск':next.phase==='brief'?'Данные загружены':'Обновились CSV';
  parts.title.textContent=next.phase==='brief'?'Собираем брифинг':'Загружаем данные';
  parts.lead.textContent=next.phase==='brief'
   ?'Импорт завершён'+(next.importSeconds?' за '+seconds(next.importSeconds):'')+'. Считаем сдвиги, сигналы и проверки опросов.'
   :(count?'Импортируем '+count+' '+files(count)+' · '+mb(total)+'. ':'')+(next.firstRun?'Это нужно один раз: данные сохраняются в локальную базу, и дальше страницы открываются сразу.':'Новые строки добавляются к сохранённой истории.');
  parts.step.textContent='шаг '+next.step+' из '+next.steps;
  parts.live.textContent=next.label+(next.detail?' · '+next.detail:'');
  parts.phases.replaceChildren(...(next.phases||[]).map(p=>{const li=el('li','dl-phase is-'+p.state);li.append(el('i','dl-dot'),el('span','',p.label));if(p.state==='active')li.setAttribute('aria-current','step');return li;}));
  parts.fileList.replaceChildren(...(next.files||[]).filter(f=>f.size).map(f=>{
   const li=el('li','dl-file'+(f.done?' is-done':f.active?' is-active':''));
   const name=el('span','dl-file-name',f.name);const meta=el('span','dl-file-meta',mb(f.size)+(f.rows?' · '+rows(f.rows):''));
   const line=el('span','dl-file-line');const fill=el('i');
   const share=f.done?100:Math.round(100*(f.fraction||0));
   fill.style.width=share+'%';line.append(fill);li.append(name,meta,line);return li;}));
  parts.foot.textContent=footText(next.elapsed||0);
  if(!raf)raf=requestAnimationFrame(tick);
 }

 function finish(){
  if(!root){flush(true);return;}
  closing=true;target=100;state=Object.assign({},state,{active:false});
  parts.live.textContent='Готово';parts.title.textContent='Данные готовы';
  for(const li of parts.phases.children)li.className='dl-phase is-done';
  for(const li of parts.fileList.children)li.className='dl-file is-done';
  if(!raf)raf=requestAnimationFrame(tick);
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(()=>{root.classList.add('is-done');setTimeout(()=>{root?.remove();root=null;parts=null;closing=false;shown=target=0;flush(true);},reduce?0:520);},reduce?150:700);
 }
 function flush(loaded){const list=waiters;waiters=[];list.forEach(fn=>fn());if(loaded)window.dispatchEvent(new CustomEvent('genui:data-ready'));}

 async function poll(){
  clearTimeout(timer);
  try{
   const response=await fetch('/api/loading',{cache:'no-store'});
   if(!response.ok)throw new Error('loading');
   const next=await response.json();
   if(next.active){seenActive=true;render(next);timer=setTimeout(poll,500);return;}
   if(seenActive||root){seenActive=false;finish();}else flush(false);
  }catch{timer=setTimeout(poll,1500);}
 }

 window.DataLoading={
  // Показать экран с уже известным состоянием и ждать, пока данные будут готовы.
  wait(initial){if(initial&&initial.active){seenActive=true;render(initial);}const done=new Promise(resolve=>waiters.push(resolve));poll();return done;},
  active:()=>Boolean(root)
 };
 // Проверка при открытии любой страницы: если сервер ещё импортирует CSV, показываем экран сразу.
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',poll,{once:true});else poll();
})();
