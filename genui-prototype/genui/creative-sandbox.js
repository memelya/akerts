/* Trusted shell only. Generated JS executes in a terminable Worker, never in the page. */
(()=>{'use strict';
function shell(){
 'use strict';let token,worker,timer,health,last=Date.now(),stopped=false,renders=0,started=Date.now(),lastPong=Date.now(),lastHealth=Date.now();const root=document.getElementById('root');
 const send=(type,extra={})=>parent.postMessage({channel:token,type,...extra},'*');
 function stop(message){if(stopped)return;stopped=true;worker?.terminate();clearTimeout(timer);clearInterval(health);send('error',{message:String(message).slice(0,600)});}
 const tags=new Set('div span section article header footer p b strong small h1 h2 h3 h4 ul ol li dl dt dd table thead tbody tr td th button select option label input details summary svg g path rect circle ellipse line polyline polygon text tspan defs clippath title desc'.split(' '));
 const attrs=new Set('id class role aria-label aria-hidden aria-pressed aria-expanded tabindex type value checked selected min max step disabled data-action data-key data-fact-ref data-fact-field viewbox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill stroke stroke-width stroke-dasharray stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity transform text-anchor dominant-baseline font-size font-weight preserveaspectratio clip-path'.split(' '));
 function clean(html,facts){
  if(typeof html!=='string'||html.length>100000)throw Error('Слишком большой результат отрисовки.');
  const documentCopy=new DOMParser().parseFromString(html,'text/html');let count=0,bindings=0;
  for(const node of [...documentCopy.body.querySelectorAll('*')]){
   if(!documentCopy.body.contains(node))continue;
   if(++count>3000)throw Error('В предпросмотре больше 3000 элементов.');
   if(!tags.has(node.localName.toLowerCase())){node.remove();continue;}
   for(const attr of [...node.attributes])if(!attrs.has(attr.name.toLowerCase())||attr.value.length>12000||/javascript:|https?:|data:|url\s*\((?!\s*#)/i.test(attr.value))node.removeAttribute(attr.name);
   if(node.localName==='button')node.setAttribute('type','button');
   if(node.localName==='input'&&!['checkbox','range'].includes(node.getAttribute('type')))node.remove();
   if(node.hasAttribute('data-fact-ref')){const ref=node.getAttribute('data-fact-ref'),field=node.getAttribute('data-fact-field')||'actual';if(!facts[ref]||!['actual','baseline','delta','percent','share'].includes(field))throw Error('Неизвестная привязка к данным: '+ref);const v=facts[ref][field];node.textContent=Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumFractionDigits:2})+(['percent','share'].includes(field)?'%':''):'нет данных';bindings++;}
  }
  if(!count||!bindings)throw Error('Нужен видимый интерфейс хотя бы с одним значением, привязанным к источнику.');
  return {html:documentCopy.body.innerHTML,elements:count,bindings};
 }
 addEventListener('message',event=>{
  if(event.source!==parent||event.data?.kind!=='init'||worker)return;
  token=event.data.channel;const {bundle,data}=event.data;const facts=Object.fromEntries(data.facts.map(row=>[row[0],Object.fromEntries(data.factColumns.map((name,i)=>[name,row[i]]))]));
  try{
   if(/@import|url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/i.test(bundle.css))throw Error('Внешние ресурсы и активные CSS конструкции запрещены.');
   document.getElementById('design').textContent=bundle.css;
   const prelude=`(()=>{const post=self.postMessage.bind(self),listen=self.addEventListener.bind(self);let action;const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};const data=freeze(${JSON.stringify(data)});const facts=freeze(Object.fromEntries(data.facts.map(r=>[r[0],Object.fromEntries(data.factColumns.map((c,i)=>[c,r[i]]))])));let viewport=Object.freeze(${JSON.stringify({width:innerWidth,height:innerHeight})});const ui=Object.freeze({data,facts,get viewport(){return viewport;},template:${JSON.stringify(bundle.html)},escape:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),value:(r,f='actual')=>facts[r]?.[f]??null,render:html=>post({kind:'render',html}),onAction:f=>{if(typeof f==='function')action=f;},select:key=>post({kind:'select',key})});Object.defineProperty(self,'ui',{value:ui,writable:false,configurable:false});listen('message',e=>{if(e.data.kind==='ping')post({kind:'pong'});else if(e.data.kind==='viewport'){viewport=Object.freeze(e.data.viewport);try{action?.({action:'viewport',key:'',value:''});}catch(error){post({kind:'error',message:String(error.message)});}}else if(e.data.kind==='action'){try{action?.(Object.freeze(e.data.event));post({kind:'complete'});}catch(error){post({kind:'error',message:String(error.message)});}}});for(const name of ['fetch','XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker','importScripts','indexedDB','caches','setTimeout','setInterval','postMessage']){try{Object.defineProperty(self,name,{value:undefined,writable:false,configurable:false});}catch{}}})();\n`;
   const code=prelude+'\n"use strict";\n'+bundle.javascript;
   const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
   worker.onerror=e=>{e.preventDefault();stop('Ошибка JavaScript: '+e.message);};
   worker.onmessage=e=>{
    if(stopped)return;const value=e.data;
    if(value?.kind==='pong'){lastPong=Date.now();return;}
    if(value?.kind==='error'){stop(value.message);return;}
    if(value?.kind==='select'){if(data.surveys.some(s=>s.key===value.key))send('select',{key:value.key});return;}
    if(value?.kind!=='render')return;
    if(++renders>1000||renders>10&&(Date.now()-started)<1000){stop('Слишком частая перерисовка. Уберите бесконечный цикл.');return;}
    try{const result=clean(value.html,facts);root.innerHTML=result.html;const visible=[...root.querySelectorAll('[data-fact-ref]')].some(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';});if(!visible)throw Error('Не видно ни одного значения с привязкой к данным. Исправьте компоновку.');const smallText=[...root.querySelectorAll('svg text')].filter(n=>{const m=n.getScreenCTM();return m&&parseFloat(getComputedStyle(n).fontSize)*Math.hypot(m.a,m.b)<12;}).length;clearTimeout(timer);send('rendered',{report:{status:'rendered',bindings:result.bindings,elements:result.elements,smallText}});}catch(error){stop(error.message);}
   };
   timer=setTimeout(()=>stop('Код не отрисовал интерфейс за пять секунд.'),5000);
   health=setInterval(()=>{const now=Date.now();if(document.hidden||now-lastHealth>2000)lastPong=now;lastHealth=now;if(now-lastPong>3500){stop('Код перестал отвечать. Предпросмотр остановлен.');return;}worker.postMessage({kind:'ping'});},700);
   addEventListener('resize',()=>{if(!stopped)worker.postMessage({kind:'viewport',viewport:{width:innerWidth,height:innerHeight}});});
   root.addEventListener('click',e=>{const element=e.target.closest('[data-action]');if(element&&element.tagName!=='SELECT'&&!stopped)worker.postMessage({kind:'action',event:{action:element.dataset.action,key:element.dataset.key||'',value:element.value||''}});});
   root.addEventListener('change',e=>{const element=e.target.closest('[data-action]');if(element&&!stopped)worker.postMessage({kind:'action',event:{action:element.dataset.action,key:element.dataset.key||'',value:element.type==='checkbox'?String(element.checked):element.value||''}});});
   root.addEventListener('keydown',e=>{const element=e.target.closest('[data-action]');if(element&&!['BUTTON','INPUT','SELECT'].includes(element.tagName)&&['Enter',' '].includes(e.key)&&!stopped){e.preventDefault();worker.postMessage({kind:'action',event:{action:element.dataset.action,key:element.dataset.key||'',value:''}});}});
  }catch(error){stop(error.message);}
 });
 parent.postMessage({kind:'creative-shell-ready'},'*');
}
window.CreativeSandbox={mount(host,bundle,data,{onReady,onError,onSelect}){
 const nonce=crypto.randomUUID().replaceAll('-',''),channel=crypto.randomUUID(),iframe=document.createElement('iframe');iframe.className='creative-frame';iframe.title='Изолированный предпросмотр новой визуализации';iframe.setAttribute('sandbox','allow-scripts');iframe.setAttribute('referrerpolicy','no-referrer');iframe.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
 const csp=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
 iframe.srcdoc=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;padding:16px;background:#181818;color:#ededed;color-scheme:dark;font-family:Manrope,system-ui,sans-serif;font-size:14px;line-height:20px}*{box-sizing:border-box}svg{max-width:100%;height:auto}button,select{font:inherit}button{cursor:pointer}#root{min-width:0;overflow:auto}p{text-wrap:pretty}h1,h2,h3,h4{text-wrap:balance}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style><style id="design"></style></head><body><div id="root" aria-live="polite">Проверяем новый интерфейс…</div><script nonce="${nonce}">(${shell.toString()})();</script></body></html>`;
 let disposed=false;const receive=event=>{if(disposed||event.source!==iframe.contentWindow)return;if(event.data?.kind==='creative-shell-ready'){iframe.contentWindow.postMessage({kind:'init',channel,bundle,data},'*');return;}if(event.data?.channel!==channel)return;if(event.data.type==='rendered')onReady?.(event.data.report);if(event.data.type==='error')onError?.(event.data.message);if(event.data.type==='select'&&data.surveys.some(s=>s.key===event.data.key))onSelect?.(event.data.key);};
 addEventListener('message',receive);host.append(iframe);const timeout=setTimeout(()=>onError?.('Предпросмотр не запустился. Обновите страницу или попробуйте другой вариант.'),8000);const listener=receive;const wrappedReady=onReady,wrappedError=onError;onReady=report=>{clearTimeout(timeout);wrappedReady?.(report);};onError=message=>{clearTimeout(timeout);wrappedError?.(message);};
 return ()=>{disposed=true;clearTimeout(timeout);removeEventListener('message',listener);iframe.remove();};
}};
})();
