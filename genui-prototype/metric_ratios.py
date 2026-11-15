"""Quantity ratios to sends of the same survey, channel selection and period."""
from collections import defaultdict
from bisect import bisect_right
from metric_registry import calculate
COUNT_METRICS={'sends','answers','events','stop','contactPolicy'}
METHOD='Процент = показатель / отправки того же опроса и периода × 100. Это отношение объёмов, не конверсия одной когорты. Возможно больше 100%. При нулевой или неизвестной базе процент не выводится. CSI остаётся в баллах.'
def ratio(value,base):return value/base*100 if value is not None and base is not None and base>0 else None

def attach_send_ratios(result,state,chosen):
 periods=result['months'];period_set=set(periods);day=bool(periods and len(periods[0])==10);keys={(s['meta']['channel'],s['event']['id']) for s in chosen};base=defaultdict(int)
 weeks=result.get('periods',[]) if result.get('spec',{}).get('grain')=='week' else []
 for row in state.get('rawRecords',[]):
  period=row['date'] if day else row['date'][:7]
  if weeks:
   index=bisect_right(periods,period)-1
   if index<0 or period>weeks[index]['end']:continue
   period=periods[index]
  if (row['channel'],row['id']) not in keys or period not in period_set or day and row['grain']!='day':continue
  count=calculate([row],'sends');base[row['id'],period]+=count;base[None,period]+=count
 index={}
 for block in result['blocks']:
  if block['metric'] not in COUNT_METRICS:continue
  denominator=[base.get((block['id'],p)) for p in periods];known=[v for v in denominator if v is not None];total_base=sum(known) if known else None;values=[ratio(v,d) for v,d in zip(block['values'],denominator)];known_values=[v for v in block['values'] if v is not None]
  info={'baseMetric':'sends','baseValues':denominator,'values':values,'totalBase':total_base,'total':ratio(sum(known_values) if known_values else None,total_base),'method':METHOD}
  block['sendRatio']=info;index[block['id'],block['label']]=info
 for total in result['totals']:
  if (total.get('id'),total.get('label')) in index:total['sendRatio']=index[total['id'],total['label']]
 positions={p:i for i,p in enumerate(periods)}
 for row in result['table']:
  info=index.get((row['id'],row['metric']))
  if info:
   i=positions[row['month']];row.update(sendRatio=info['values'][i],ratioBase=info['baseValues'][i])
 if index:result.setdefault('methods',[]).append(METHOD)
 return result
