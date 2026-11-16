/* Оформление: тема, акцент и фон графиков меняются сразу на всех экранах.
   Настройки хранятся в браузере (localStorage) и не затрагивают данные. */
(()=>{'use strict';
const KEY='genui-appearance-v1',root=document.documentElement;
const THEMES={dark:'Тёмная',light:'Светлая',brand:'Фирменная'};
const ACCENTS={dark:['#ff8a35','#4fb477','#5aa2e6','#b08ae0','#e0b84a'],light:['#d9610b','#1f8a4c','#1f6fc2','#7a4fc4','#a8790a'],brand:['#1f9d55','#0b7a8a','#1f6fc2','#7a4fc4','#d9610b']};
const BACKS={none:'Без фона',soft:'Мягкая заливка',accent:'Оттенок акцента'};
let state={theme:'dark',accent:'',chart:'none'};
try{const saved=JSON.parse(localStorage.getItem(KEY)||'{}');if(saved&&THEMES[saved.theme])state={...state,...saved};}catch{}
function apply(){
 root.dataset.theme=state.theme;root.dataset.chartBg=state.chart;
 const accent=state.accent||ACCENTS[state.theme][0];root.style.setProperty('--accent',accent);
 const hex=accent.replace('#','');const lum=(parseInt(hex.slice(0,2),16)*299+parseInt(hex.slice(2,4),16)*587+parseInt(hex.slice(4,6),16)*114)/1000;
 root.style.setProperty('--on-accent',lum>150?'#111111':'#ffffff');
 try{localStorage.setItem(KEY,JSON.stringify(state));}catch{}
 window.dispatchEvent(new CustomEvent('appearance:change',{detail:{...state,accent}}));
}
apply();
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
let panel=null;
function build(){
 panel=el('dialog','appearance-panel');panel.setAttribute('aria-label','Оформление');
 const head=el('div','appearance-head');head.append(el('h2','','Оформление'));const close=el('button','pulse-btn ghost','Закрыть');close.type='button';close.onclick=()=>panel.close();head.append(close);
 const body=el('div','appearance-body');
 function group(title){const g=el('fieldset','appearance-group');g.append(el('legend','',title));body.append(g);return g;}
 const themes=group('Тема'),accents=group('Акцентный цвет'),backs=group('Фон графиков');
 function draw(){
  themes.querySelectorAll('button').forEach(b=>b.remove());accents.querySelectorAll('button,label').forEach(b=>b.remove());backs.querySelectorAll('button').forEach(b=>b.remove());
  for(const [key,name] of Object.entries(THEMES)){const b=el('button','appearance-choice theme-'+key,name);b.type='button';b.setAttribute('aria-pressed',String(state.theme===key));b.onclick=()=>{state.theme=key;state.accent='';apply();draw();};themes.append(b);}
  const current=state.accent||ACCENTS[state.theme][0];
  for(const color of ACCENTS[state.theme]){const b=el('button','appearance-swatch');b.type='button';b.style.background=color;b.setAttribute('aria-label','Акцент '+color);b.setAttribute('aria-pressed',String(current===color));b.onclick=()=>{state.accent=color;apply();draw();};accents.append(b);}
  const custom=el('label','appearance-custom','Свой цвет ');const input=el('input');input.type='color';input.value=current;input.oninput=()=>{state.accent=input.value;apply();};input.onchange=draw;custom.append(input);accents.append(custom);
  for(const [key,name] of Object.entries(BACKS)){const b=el('button','appearance-choice',name);b.type='button';b.setAttribute('aria-pressed',String(state.chart===key));b.onclick=()=>{state.chart=key;apply();draw();};backs.append(b);}
 }
 const note=el('p','pulse-muted','Изменения применяются сразу ко всем разделам и сохраняются в этом браузере. Презентация выгружается в выбранном шаблоне отдельно — на вкладке «Встреча в один клик».');
 const reset=el('button','pulse-btn ghost','Вернуть исходное оформление');reset.type='button';reset.onclick=()=>{state={theme:'dark',accent:'',chart:'none'};apply();draw();};
 panel.append(head,body,note,reset);document.body.append(panel);panel.addEventListener('click',e=>{if(e.target===panel)panel.close();});draw();
}
function open(){if(!panel)build();if(!panel.open)panel.show();}
window.Appearance={open,get:()=>({...state}),set:next=>{state={...state,...next};apply();}};
window.addEventListener('load',()=>{const bar=document.querySelector('.topbar');if(!bar)return;const trigger=el('button','pulse-palette-trigger appearance-trigger');trigger.type='button';trigger.append(el('span','','Оформление'));trigger.onclick=()=>{if(panel?.open)panel.close();else open();};const after=bar.querySelector('.pulse-palette-trigger')||bar.querySelector('span');if(after)after.after(trigger);else bar.prepend(trigger);});
})();
