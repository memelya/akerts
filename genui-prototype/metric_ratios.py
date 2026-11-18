"""Доли по воронке: показатель к базе того же опроса, канала и периода.

События — вершина воронки (100%). Отправки, стоп-листы и политика контактов — доля от событий.
Ответы — отклик, доля от отправок. CSI остаётся в баллах."""
from collections import defaultdict
from bisect import bisect_right
from metric_registry import calculate
COUNT_METRICS={'sends','answers','events','stop','contactPolicy'}
BASE_OF={'events':'events','sends':'events','stop':'events','contactPolicy':'events','answers':'sends'}
METHOD=('Проценты по воронке: события = 100%; отправки, стоп-листы и политика контактов — доля от событий того же опроса и периода; '
        'ответы — отклик, доля от отправок. Доля не превышает 100%, если строки выгрузки согласованы. При нулевой или неизвестной базе процент не выводится. CSI остаётся в баллах.')
def ratio(value,base):return value/base*100 if value is not None and base is not None and base>0 else None

def attach_send_ratios(result,state,chosen):
 periods=result['months'];period_set=set(periods);day=bool(periods and len(periods[0])==10);keys={(s['meta']['channel'],s['event']['id']) for s in chosen};base={'events':defaultdict(int),'sends':defaultdict(int)}
 weeks=result.get('periods',[]) if result.get('spec',{}).get('grain')=='week' else []
 for row in state.get('rawRecords',[]):
  period=row['date'] if day else row['date'][:7]
  if weeks:
   index=bisect_right(periods,period)-1
   if index<0 or period>weeks[index]['end']:continue
   period=periods[index]
  if (row['channel'],row['id']) not in keys or period not in period_set or day and row['grain']!='day':continue
  for metric,store in base.items():
   count=calculate([row],metric)
   if count is None:continue
   store[row['id'],period]+=count;store[None,period]+=count
 index={}
 for block in result['blocks']:
  if block['metric'] not in COUNT_METRICS:continue
  base_metric=BASE_OF[block['metric']];source=base[base_metric]
  denominator=[source.get((block['id'],p)) for p in periods];known=[v for v in denominator if v is not None];total_base=sum(known) if known else None;values=[ratio(v,d) for v,d in zip(block['values'],denominator)];known_values=[v for v in block['values'] if v is not None]
  info={'baseMetric':base_metric,'baseValues':denominator,'values':values,'totalBase':total_base,'total':ratio(sum(known_values) if known_values else None,total_base),'method':METHOD}
  block['sendRatio']=info;index[block['id'],block['label']]=info
 for total in result['totals']:
  if (total.get('id'),total.get('label')) in index:total['sendRatio']=index[total['id'],total['label']]
 positions={p:i for i,p in enumerate(periods)}
 for row in result['table']:
  info=index.get((row['id'],row['metric']))
  if info:
   i=positions[row['month']];row.update(sendRatio=info['values'][i],ratioBase=info['baseValues'][i],ratioBaseMetric=info['baseMetric'])
 if index:result.setdefault('methods',[]).append(METHOD)
 return result
