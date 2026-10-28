/* Progressive presentation only: existing filters, data and formulas stay authoritative. */
(()=>{
 const catalogue=document.querySelector('.catalogue');
 if(catalogue){
  const workspace=document.getElementById('personalWorkspace'),tools=catalogue.querySelector('.catalogue-tools');
  if(workspace&&tools){workspace.before(tools);const views=workspace.querySelector('.personal-views');if(views){const details=document.createElement('details');details.className='saved-filters';const summary=document.createElement('summary');summary.textContent='Сохранённые фильтры';details.append(summary);views.before(details);details.append(views);const feedback=workspace.querySelector('.view-feedback'),note=workspace.querySelector('[data-storage-note]');if(feedback)details.append(feedback);if(note)details.append(note);}}
  const search=document.getElementById('eventSearch');if(search)search.setAttribute('aria-label','Поиск опроса по ID, названию или статусу');
 }
 function rings(root){root.querySelectorAll('.plan-ring:not([data-elaya-ring])').forEach(ring=>{ring.dataset.elayaRing='true';const progress=Math.max(0,Math.min(100,parseFloat(ring.style.getPropertyValue('--progress'))||0));const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 88 88');svg.classList.add('ring-track');svg.setAttribute('aria-hidden','true');for(let i=0;i<2;i++){const circle=document.createElementNS(ns,'circle');for(const [key,value] of Object.entries({cx:44,cy:44,r:40}))circle.setAttribute(key,value);if(i){circle.classList.add('ring-value');circle.setAttribute('pathLength','100');circle.setAttribute('stroke-dasharray',progress+' 100');}svg.append(circle);}ring.prepend(svg);});}
 function fitRingValues(root){root.querySelectorAll('.plan-ring').forEach(ring=>{
  const value=ring.querySelector('b'),inner=ring.querySelector(':scope > div');if(!value||!inner||!ring.getBoundingClientRect().width)return;
  const available=Math.max(0,inner.getBoundingClientRect().width-4);if(!available)return;
  value.style.transform='none';const range=document.createRange();range.selectNodeContents(value);let width=0;
  for(const [size,lineHeight] of [[18,28],[16,24],[14,20],[12,16]]){value.style.fontSize=size+'px';value.style.lineHeight=lineHeight+'px';width=range.getBoundingClientRect().width;if(width<=available)break;}
  // Extreme values retain all digits rather than clipping or rounding the metric.
  if(width>available)value.style.transform='scale('+available/width+')';
 });}
 rings(document);fitRingValues(document);
 const grid=document.getElementById('eventGrid');let pending=false,lastWidth=0;
 function equalize(){if(!grid||pending)return;pending=true;requestAnimationFrame(()=>{pending=false;fitRingValues(grid);const cards=[...grid.querySelectorAll(':scope > .event-card.is-top:not([hidden])')];grid.style.removeProperty('--equal-card-height');let height=0;for(const card of cards)height=Math.max(height,card.getBoundingClientRect().height,card.scrollHeight+2);if(height)grid.style.setProperty('--equal-card-height',Math.ceil(height)+'px');});}
 if(grid){new MutationObserver(()=>{rings(grid);equalize();}).observe(grid,{childList:true,attributes:true,attributeFilter:['hidden']});new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(Math.abs(width-lastWidth)>1){lastWidth=width;equalize();}}).observe(grid);document.fonts.ready.then(equalize);equalize();}
 document.fonts.ready.then(()=>fitRingValues(document));
 document.querySelectorAll('dialog').forEach(dialog=>new MutationObserver(()=>{rings(dialog);fitRingValues(dialog);}).observe(dialog,{childList:true,subtree:true,attributes:true,attributeFilter:['open']}));
})();
