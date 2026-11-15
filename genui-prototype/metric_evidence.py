"""Reconcile a plotted value with canonical rows of its immutable data revision."""
import math
from metric_registry import METRICS,VERSION,calculate,weighted_csi,plan_for_day,response_proof
from genui_extended import select_surveys

def evidence(analysis,state,series,period,document):
    if type(series) is not int or not 0<=series<len(analysis['blocks']):raise ValueError('Выберите показатель графика.')
    if period not in analysis['months']:raise ValueError('Период отсутствует на этом графике.')
    block=analysis['blocks'][series];metric=block['metric'];selected=select_surveys(state,analysis['spec'])
    if block['id'] is not None:selected=[s for s in selected if s['event']['id']==block['id']]
    keys={(s['meta']['channel'],s['event']['id']) for s in selected}
    window=next((item for item in analysis.get('periods',[]) if item['start']==period),None)
    end=window['end'] if window else period
    rows=[r for r in state.get('rawRecords',[]) if (r['channel'],r['id']) in keys and (r['grain']=='day' and period<=r['date']<=end if len(period)==10 else r['date'][:7]==period)]
    expected=block['values'][analysis['months'].index(period)]
    proof={};reference_rows=[]
    if metric=='plan':
        reference_rows=[{'id':s['event']['id'],'channel':s['meta']['channel'],'monthlyPlan':s['meta'].get('plan')} for s in selected]
        plans=[r['monthlyPlan'] for r in reference_rows if r['monthlyPlan'] is not None]
        calculated=sum(plans) if plans else None
        if len(period)==10 and calculated is not None:
            from datetime import date,timedelta
            start=date.fromisoformat(period)
            calculated=sum(plan_for_day(calculated,(start+timedelta(days=i)).isoformat()) for i in range((date.fromisoformat(end)-start).days+1))
    else:
        calculated=calculate(rows,metric,'day' if len(period)==10 else 'month')
        if metric=='csi':proof=weighted_csi(rows)
        if metric=='responseRate':proof=response_proof(rows)
    matched=calculated==expected if calculated is None or expected is None else math.isclose(calculated,expected,rel_tol=1e-9,abs_tol=1e-9)
    records=[]
    for row in rows[:200]:
        item={k:row.get(k) for k in ('channel','date','id','status','rating','events','sends','answers','csi')}
        item['file']='date/success-screen.csv' if row['channel']=='success_screen' else 'date/push-sms.csv'
        item['contribution']=calculate([row],metric,'day' if len(period)==10 else 'month') if metric not in ('csi','plan','responseRate') else None
        records.append(item)
    sends=calculate(rows,'sends')
    share=expected/sends*100 if metric in ('sends','answers','events','stop','contactPolicy') and expected is not None and sends else None
    return {'metric':metric,'definition':dict(key=metric,**METRICS[metric]),'metricVersion':VERSION,'period':period+' — '+end if window else period,
            'scope':{'ids':analysis['spec']['ids'],'filters':analysis['spec'].get('filters',{}),'memberCount':len(keys)},
            'share':{'value':share,'numerator':expected,'denominator':sends,'baseMetric':'sends'} if metric in ('sends','answers','events','stop','contactPolicy') else None,
            'revision':analysis['revision'],'importedAt':document.get('created'),'referenceHash':document.get('referenceHash'),
            'plottedValue':expected,'recalculatedValue':calculated,'reconciled':matched,'rowCount':len(rows),'rows':records,'sampleLimit':200,
            'proof':proof,'referenceRows':reference_rows,'sourceFiles':document.get('files',[]),
            'note':'Значение сверено с полной совокупностью строк выбранной версии.' if matched else 'Сверка не сошлась: исходная архивная база может не содержать канонических строк. Не используйте значение до проверки источника.',
            'missing':not rows and metric!='plan'}
