"""Monthly answer dashboards. Full scope aggregated in SQLite, no model calls."""
from collections import defaultdict
import datetime as dt
from metric_registry import calculate

CATEGORIES={'top':'Топ опросы','communication':'Опросы пуш + СМС','success_screen':'Опросы экраны успеха'}

def total(values):
    known=[v for v in values if v is not None]
    return sum(known) if known else None

def change(values):
    if len(values)<6 or any(v is None for v in values[:3]+values[-3:]):return None
    first=sum(values[:3]);last=sum(values[-3:])
    return (last-first)/first*100 if first else None

def overview(engine,request):
    category=request.get('category')
    if category not in CATEGORIES:raise ValueError('Неизвестная категория опросов.')
    metric=request.get('metric','answers')
    if metric not in ('answers','sends'):raise ValueError('Показатель: answers или sends.')
    with engine.lock:
        state,status=engine.refresh()
        if status.get('error'):raise ValueError('CSV не приняты: '+status['error'])
        revision=engine.document.get('revision')
        selected=[s for s in state['surveys'] if s['event'].get('isTop')] if category=='top' else [s for s in state['surveys'] if s['meta']['channel']==category]
        available=sorted({m for s in selected for m in s['meta']['availableMonths']})
        years=sorted({m[:4] for m in available},reverse=True)
        year=str(request.get('year') or (years[0] if years else dt.date.today().year))
        if len(year)!=4 or not year.isdigit() or not 1900<=int(year)<=2199:raise ValueError('Укажите год от 1900 до 2199.')
        end=max((int(m[5:7]) for m in available if m[:4]==year),default=0)
        months=[year+'-'+str(m).zfill(2) for m in range(1,end+1)]
        keys=[(s['meta']['channel'],s['event']['id']) for s in selected]
        rows=engine.store.monthly_records(revision,keys,year+'-01',year+'-12-31') if revision and keys and months else []
        grouped=defaultdict(list)
        for row in rows:grouped[row['channel'],row['id'],row['date'][:7]].append(row)
        items=[]
        for survey in selected:
            ident=survey['event']['id'];meta=survey['meta'];channel=meta['channel']
            sources=[grouped[channel,ident,m] for m in months]
            if not any(sources):continue
            answers=[calculate(v,'answers') for v in sources];csi=[calculate(v,'csi') for v in sources];values=[calculate(v,metric) for v in sources]
            bases=[calculate(v,'sends' if metric=='answers' else 'events') for v in sources]
            ratios=[v/base*100 if v is not None and base is not None and base>0 else None for v,base in zip(values,bases)]
            items.append({'ratioBases':bases,'ratios':ratios,'key':channel+':'+str(ident),'id':ident,'name':meta.get('name') or 'Опрос '+str(ident),'channel':channel,'products':meta.get('products',[]),'answers':answers,'csi':csi,'values':values,'total':total(values),'growth':change(values)})
        answers=[total([s['values'][i] for s in items]) for i in range(len(months))]
        overall=total(answers)
        bases=[total([s['ratioBases'][i] for s in items]) for i in range(len(months))]
        ratios=[v/base*100 if v is not None and base is not None and base>0 else None for v,base in zip(answers,bases)]
        for item in items:item['share']=item['total']/overall*100 if item['total'] is not None and overall else None
        ranked=sorted(items,key=lambda s:-(s['total'] or 0));last=next((m for m,v in reversed(list(zip(months,answers))) if v is not None),None)
        return {'ratios':ratios,'ratioBaseMetric':'sends' if metric=='answers' else 'events','metric':metric,'metricLabel':'Ответы' if metric=='answers' else 'Отправки','category':category,'title':CATEGORIES[category],'year':year,'years':years,'months':months,'answers':answers,'values':answers,'items':items,'totalValue':overall,'totalAnswers':overall,'surveyCount':len(items),'top1Share':ranked[0]['share'] if ranked else None,'top10Share':sum(s['total'] or 0 for s in ranked[:10])/overall*100 if overall else None,'growth':change(answers),'lastMonth':last,'revision':revision,'refreshedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'held':bool(engine.document.get('heldFingerprint')),'method':'Карточка соответствует паре номер опроса + канал; одинаковые номера разных каналов не объединяются. Отправки экранов успеха учитывают только SENDED; для пуш + СМС используется sends. Ответы суммируются; CSI взвешен по числу событий с оценкой 1–5. Оценка 0 исключена только из CSI. Пустой месяц — нет наблюдений, не ноль. Прирост: последние 3 месяца к первым 3; нужен период минимум 6 месяцев и наблюдения во всех 6 сравниваемых месяцах. При нулевой базе прирост не вычисляется.'}
