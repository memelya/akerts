const finite=Number.isFinite;
export const rate=(a,b)=>finite(a)&&finite(b)&&b>0?a/b:null;
export const change=(a,b)=>finite(a)&&finite(b)?{absolute:b-a,relative:rate(b-a,a)}:null;
export function compareRows(before,after){
 if(!before||!after||![before.events,before.sends,before.answers,after.events,after.sends,after.answers].every(finite)||before.events<=0||after.events<=0||before.sends<=0||after.sends<=0)return null;
 const delivery0=before.sends/before.events,delivery1=after.sends/after.events,response0=before.answers/before.sends,response1=after.answers/after.sends;
 const effects=[
  {key:'volume',label:'Изменение объёма событий',value:(after.events-before.events)*delivery0*response0},
  {key:'stop',label:'Изменение доли стоп-листов · 1002',value:-after.events*(after.stop/after.events-before.stop/before.events)*response0},
  {key:'policy',label:'Изменение доли групповой политики · 1011',value:-after.events*(after.policy/after.events-before.policy/before.events)*response0},
  {key:'other',label:'Изменение доли прочих отсечений',value:-after.events*((after.events-after.sends-after.stop-after.policy)/after.events-(before.events-before.sends-before.stop-before.policy)/before.events)*response0},
  {key:'response',label:'Изменение отклика после отправки',value:after.sends*(response1-response0)}
 ];
 return {before,after,answers:change(before.answers,after.answers),sends:change(before.sends,after.sends),events:change(before.events,after.events),delivery0,delivery1,response0,response1,effects,sendEffect:(after.sends-before.sends)*response0,responseEffect:after.sends*(response1-response0),cutoffs:['stop','policy'].map(key=>({key,before:before[key],after:after[key],absolute:after[key]-before[key],relative:rate(after[key]-before[key],before[key]),share0:before[key]/before.events,share1:after[key]/after.events,extraAtOldShare:after[key]-after.events*before[key]/before.events}))};
}
export function rankOthers(others,from,to){
 const common=[],added=[],missing=[];
 for(const survey of others){const before=survey.sends.find(row=>row.month===from),after=survey.sends.find(row=>row.month===to);if(before&&after&&finite(before.value)&&finite(after.value))common.push({id:survey.id,name:survey.name,before:before.value,after:after.value,delta:after.value-before.value,relative:rate(after.value-before.value,before.value)});else if(after)added.push(survey.id);else if(before)missing.push(survey.id);}
 common.sort((a,b)=>b.delta-a.delta||a.id-b.id);
 return {common,added,missing,before:common.reduce((sum,row)=>sum+row.before,0),after:common.reduce((sum,row)=>sum+row.after,0),growing:common.filter(row=>row.delta>0),shrinking:common.filter(row=>row.delta<0).sort((a,b)=>a.delta-b.delta),probe193:common.find(row=>row.id===193)||null};
}
