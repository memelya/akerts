"""Explain observed changes using comparable observations and user context."""
import calendar,datetime as dt
from collections import defaultdict
from metric_registry import calculate,LABELS,weighted_csi
from genui_extended import select_surveys

METRICS=('sends','answers','events','stop','contactPolicy','csi')
def month_before(month):
    y,m=map(int,month.split('-'));n=y*12+m-2
    return f'{n//12:04d}-{n%12+1:02d}'
def dates(month,through):return [dt.date.fromisoformat(month+'-01')+dt.timedelta(days=i) for i in range(through)]
def scaled(rows,weight):return [dict(r,**{k:r[k]*weight for k in ('events','sends','answers')}) for r in rows]
def diff(current,before):return current-before if current is not None and before is not None else None

def investigate(engine,analysis,period,mode='aligned',metric='sends'):
    if period not in analysis['months']:raise ValueError('Выберите период этого графика.')
    if mode not in ('aligned','weekday','previous') or metric not in METRICS:raise ValueError('Неподдерживаемое сравнение.')
    revision=analysis['revision'];doc=engine.store.snapshot(revision,include_records=False)
    state=engine._build(engine.store.summary(revision),doc.get('products',{}),doc.get('reference'))
    members=select_surveys(state,analysis['spec']);keys=[(s['meta']['channel'],s['event']['id']) for s in members]
    week=next((window for window in analysis.get('periods',[]) if window['start']==period),None) if analysis['spec'].get('grain')=='week' else None
    day=len(period)==10;month=period[:7];first=dt.date.fromisoformat(month+'-01') if not day else dt.date.fromisoformat(period)
    end=dt.date(first.year,first.month,calendar.monthrange(first.year,first.month)[1]) if not day else first
    if week:end=dt.date.fromisoformat(week['end'])
    previous=month_before(month);start=dt.date.fromisoformat(previous+'-01') if not day else first-dt.timedelta(days=28)
    records=engine.store.records(revision,keys,start.isoformat() if day else previous,end.isoformat())
    current=[r for r in records if (r['grain']=='day' and period<=r['date']<=end.isoformat() if day else r['date'][:7]==month)]
    daily=[r for r in current if r['grain']=='day'];through=max((r['date'] for r in daily),default=end.isoformat())
    cutoff=int(through[-2:]);warnings=[];monthly=any(r['grain']=='month' for r in records)
    if not current:warnings.append('В выбранном периоде нет строк. Отсутствие наблюдений не означает ноль.')
    if not day and daily and cutoff<end.day:warnings.append('Месяц неполный: последние дневные наблюдения — '+through+'. Факт и сопоставимая часть показаны отдельно.')
    comparable=day or not (mode!='previous' and monthly)
    if not comparable:warnings.append('Есть месячная выгрузка без дневных строк. Для выбранного сравнения нужна дневная детализация; доступен режим «Предыдущий период».')
    mapping=[]
    if week:
        offsets=(7,14,21,28) if mode=='weekday' else (7,)
        for offset in range((end-first).days+1):
            actual=first+dt.timedelta(days=offset)
            mapping.append((actual,[actual-dt.timedelta(days=i) for i in offsets]))
    elif day:
        mapping=[(first,[first-dt.timedelta(days=i) for i in ((7,14,21,28) if mode=='weekday' else (1,))])]
    elif mode=='weekday':
        cur=dates(month,cutoff);old=dates(previous,min(cutoff,calendar.monthrange(int(previous[:4]),int(previous[5:]))[1]))
        for weekday in range(7):mapping.extend((a,[b]) for a,b in zip([d for d in cur if d.weekday()==weekday],[d for d in old if d.weekday()==weekday]))
    elif mode=='aligned':
        mapping=[(d,[dt.date.fromisoformat(previous+f'-{d.day:02d}')]) for d in dates(month,min(cutoff,calendar.monthrange(int(previous[:4]),int(previous[5:]))[1]))]
    grouped=defaultdict(list)
    for row in records:grouped[(row['channel'],row['id'])].append(row)
    paired_current={m:[] for m in METRICS};paired_before={m:[] for m in METRICS};contributors=[];expected_pairs=len(mapping)
    for survey in members:
        ident=survey['event']['id'];channel=survey['meta']['channel'];rows=grouped[(channel,ident)]
        now=[r for r in rows if r['date'][:7]==month] if not day else [r for r in rows if r['grain']=='day' and period<=r['date']<=end.isoformat()]
        by_date=defaultdict(list)
        for row in rows:
            if row['grain']=='day':by_date[row['date']].append(row)
        details={}
        for key in METRICS:
            cur_rows=[];old_rows=[];pairs=0;observations=0
            if comparable and mode=='previous' and not day:
                before=[r for r in rows if r['date'][:7]==previous]
                if calculate(now,key) is not None and calculate(before,key) is not None:cur_rows=now;old_rows=before;pairs=1
            elif comparable:
                for date,references in mapping:
                    actual=by_date[date.isoformat()];before=[by_date[d.isoformat()] for d in references]
                    before=[r for r in before if calculate(r,key) is not None]
                    if calculate(actual,key) is None or not before:continue
                    cur_rows.extend(actual)
                    for group in before:old_rows.extend(scaled(group,1/len(before)))
                    pairs+=1;observations+=len(before)
            fact=calculate(now,key);a=calculate(cur_rows,key);b=calculate(old_rows,key)
            paired_current[key].extend(cur_rows);paired_before[key].extend(old_rows)
            details[key]={'actual':fact,'comparableActual':a,'baseline':b,'delta':diff(a,b),'pairedDays':pairs,'baselineObservations':observations}
            if key=='csi':details[key]['currentProof']=weighted_csi(cur_rows);details[key]['baselineProof']=weighted_csi(old_rows)
        main=details[metric]
        contributors.append({'id':ident,'channel':channel,'name':survey['meta']['name'],'products':survey['meta'].get('products',[]),**main,'metrics':details})
    values=[]
    for key in METRICS:
        a=calculate(paired_current[key],key);b=calculate(paired_before[key],key);change=diff(a,b)
        values.append({'metric':key,'label':LABELS[key],'actual':calculate(current,key),'comparableActual':a,'baseline':b,'delta':change,'percent':change/b*100 if change is not None and b else None,'comparableSurveys':sum(r['metrics'][key]['delta'] is not None for r in contributors)})
    main=next(v for v in values if v['metric']==metric)
    current_weight=weighted_csi(paired_current['csi'])['denominator'];before_weight=weighted_csi(paired_before['csi'])['denominator']
    for row in contributors:
        row['contribution']=row['delta']
        if metric=='csi' and row['delta'] is not None and current_weight and before_weight:
            a=row['metrics']['csi']['currentProof'];b=row['metrics']['csi']['baselineProof'];center=main['baseline']
            row['contribution']=(a['numerator']-center*a['denominator'])/current_weight-(b['numerator']-center*b['denominator'])/before_weight
        row['shareOfDelta']=row['contribution']/main['delta']*100 if row['contribution'] is not None and main['delta'] else None
    contributors.sort(key=lambda r:abs(r['contribution'] or 0),reverse=True)
    notes=engine.workflows.events_for(first.isoformat(),through if daily and not any(r['grain']=='month' for r in current) else end.isoformat(),members)
    reference_from=min((d.isoformat() for _,refs in mapping for d in refs),default=previous+'-01')
    reference_to=max((d.isoformat() for _,refs in mapping for d in refs),default=previous+f'-{calendar.monthrange(int(previous[:4]),int(previous[5:]))[1]:02d}')
    if mode=='previous' and not day:reference_from=previous+'-01';reference_to=previous+f'-{calendar.monthrange(int(previous[:4]),int(previous[5:]))[1]:02d}'
    baseline_notes=engine.workflows.events_for(reference_from,reference_to,members)
    warnings.append('Сравнение использует только пары с наблюдениями с обеих сторон. Пропуски не подменяются нулём. Изменения CSI отдельных опросов не складываются; вклад в общий CSI учитывает веса валидных оценок и изменение состава.')
    if notes or baseline_notes:warnings.append('События календаря внесены пользователем. Совпадение по времени и опросам не доказывает причинную связь.')
    method={'aligned':'Одинаковые календарные дни предыдущего месяца; для дня — предыдущий день.','weekday':'Одинаковые дни недели и их порядковые вхождения в сопоставимой части предыдущего месяца; для дня — среднее четырёх предыдущих одноимённых дней недели.','previous':'Предыдущий календарный месяц целиком; для дня — предыдущий день.'}[mode]
    if week:method='Среднее по доступным одноимённым дням четырёх предыдущих недель.' if mode=='weekday' else 'Те же дни недели за семь дней до выбранного периода.'
    return {'revision':revision,'period':period+' — '+week['end'] if week else period,'mode':mode,'metric':metric,'currentThrough':through if daily else None,'referenceFrom':reference_from,'referenceTo':reference_to,'expectedPairs':expected_pairs,'memberCount':len(members),'contributors':contributors[:100],'truncated':len(contributors)>100,'metrics':values,'events':notes,'baselineEvents':baseline_notes,'warnings':warnings,'method':method}
