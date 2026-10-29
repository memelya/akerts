export function top30Payload(surveys){
 const months=[...new Set(surveys.flatMap(({event})=>event.months))].sort();
 return {months,defaultMonth:months.at(-2)||months.at(-1),surveys:surveys.filter(({event})=>event.channel!=='success_screen').map(({event,meta})=>{const primary=event.statuses.find(s=>Number(s.code)===0);return {id:event.id,name:meta.name,surveyType:meta.surveyType,surveyTypeKey:meta.surveyTypeKey,through:meta.sourceThrough,values:months.map(month=>{const i=event.months.indexOf(month);return meta.availableMonths.includes(month)&&i>=0?primary?(primary.sendValues?.[i]??primary.values[i]):0:null;})};})};
}
export function monthChange(current,previous){
 if(!Number.isFinite(current)||!Number.isFinite(previous))return {absolute:null,relative:null,reason:'missing'};
 const absolute=current-previous;return {absolute,relative:previous>0?absolute/previous:null,reason:previous===0?'zero':null};
}
export function rankTop30(data,month,type='all'){
 const index=data.months.indexOf(month);if(index<0)return {rows:[],index,month,total:0,sum:0,share:null,eligible:0,paired:0,previous:null,pairedCurrent:0,pairedPrevious:0,change:monthChange(null,null),growing:0,shrinking:0,unchanged:0};
 const eligible=data.surveys.filter(s=>(type==='all'||s.surveyTypeKey===type)&&Number.isFinite(s.values[index])),rows=eligible.slice().sort((a,b)=>b.values[index]-a.values[index]||a.id-b.id).slice(0,30).map((s,rank)=>({...s,rank:rank+1,current:s.values[index],previous:index>0?s.values[index-1]:null,change:monthChange(s.values[index],index>0?s.values[index-1]:null)})),total=eligible.reduce((sum,s)=>sum+s.values[index],0),sum=rows.reduce((sum,s)=>sum+s.current,0),pairs=rows.filter(s=>Number.isFinite(s.previous)),pairedCurrent=pairs.reduce((sum,s)=>sum+s.current,0),pairedPrevious=pairs.reduce((sum,s)=>sum+s.previous,0);
 return {rows,index,month,previous:index>0?data.months[index-1]:null,total,sum,share:total>0?sum/total:null,eligible:eligible.length,paired:pairs.length,pairedCurrent,pairedPrevious,change:pairs.length?monthChange(pairedCurrent,pairedPrevious):monthChange(null,null),growing:pairs.filter(s=>s.current>s.previous).length,shrinking:pairs.filter(s=>s.current<s.previous).length,unchanged:pairs.filter(s=>s.current===s.previous).length};
}
