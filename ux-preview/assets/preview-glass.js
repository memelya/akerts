(() => {
 const menu=document.querySelector('.glass-menu'),sidebar=document.querySelector('.glass-sidebar');
 const close=()=>{document.body.classList.remove('glass-menu-open');menu?.setAttribute('aria-expanded','false');};
 menu?.addEventListener('click',()=>{const open=document.body.classList.toggle('glass-menu-open');menu.setAttribute('aria-expanded',String(open));});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
 document.addEventListener('click',e=>{if(!sidebar?.contains(e.target)&&!menu?.contains(e.target))close();});
 const search=document.getElementById('eventSearch'),quick=document.querySelector('.glass-search input');
 function catalogue(){document.getElementById('catalogue')?.scrollIntoView({block:'start'});search?.focus({preventScroll:true});}
 function filters(channel,scope){
  if(channel||scope){search.value='';quick.value='';document.querySelector('[data-personal-mode="all"]')?.click();search.dispatchEvent(new Event('input',{bubbles:true}));}
  if(channel)document.querySelector('[data-channel-filter="'+channel+'"]')?.click();
  if(scope)document.querySelector('[data-scope="'+scope+'"]')?.click();
 }
 if(search){
  document.querySelector('.glass-search').addEventListener('submit',e=>{e.preventDefault();search.value=quick.value;search.dispatchEvent(new Event('input',{bubbles:true}));catalogue();});
  document.querySelectorAll('[data-glass-channel],[data-glass-scope]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();filters(a.dataset.glassChannel,a.dataset.glassScope);catalogue();close();}));
  const params=new URLSearchParams(location.search),channel=params.get('channel'),scope=params.get('scope');
  filters(['communication','success_screen'].includes(channel)?channel:null,['all','top'].includes(scope)?scope:null);
  if(params.has('q')){quick.value=params.get('q');search.value=quick.value;search.dispatchEvent(new Event('input',{bubbles:true}));catalogue();}
  if(channel||scope)requestAnimationFrame(catalogue);
 }
 document.querySelectorAll('.glass-sidebar nav a').forEach(a=>{const url=new URL(a.href);if(url.pathname===location.pathname&&!url.hash&&!url.search)a.classList.add('is-active');});
 // Keep group detail graphs available without making the first screen excessively long.
 document.querySelectorAll('.dashboard-links .group-dashboard__charts').forEach(charts=>{const details=document.createElement('details');details.className='glass-group-details';const summary=document.createElement('summary');summary.textContent='Динамика по каналам';charts.before(details);details.append(summary,charts);});
 document.querySelectorAll('.glass-panel-link[href="#detailedDynamics"]').forEach(a=>a.addEventListener('click',()=>{document.getElementById('detailedDynamics').open=true;}));
})();
