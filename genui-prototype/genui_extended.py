"""Calendar detail and reference-based selections for GEN UI."""
import calendar
import copy
import re
from datetime import date as calendar_date, timedelta
from genui_query import plan_query as base_plan, execute_query as base_execute
from genui_query import METRICS, WEEK_REQUEST, bind_explicit_chart_request, calendar_phrase, normalize_rate_phrase, validate_spec
from products import product_from_query
from metric_registry import calculate,plan_for_day,response_proof,response_rate,weighted_csi

def requested_group(query):
    text=query.lower().replace('ё','е')
    match=re.search(r'свободн\w*\s+групп\w*\s*[№#]?\s*(\d+)',text)
    if match: return 'Свободная группа '+str(int(match[1]))
    if re.search(r'без\s+групп\w*',text): return 'без группы'
    return None

def plan_query(query, previous=None, product_names=()):
    text=query.lower().replace('ё','е')
    days=re.search(r'(?:последн\w*\s+|за\s+)(\d{1,3})\s*(?:дн\w*|день)',text)
    unique=bool(re.search(r'количество\s+(?:уникальн\w*\s+)?опрос|число\s+опрос|event_type_id',text))
    if unique:
        query+=' уникальные опросы'
        previous=None
    filters={}
    product=product_from_query(query,product_names)
    if product:filters['product']=product
    group=requested_group(query)
    if group: filters['triggerGroup']=group
    if re.search(r'\bтоп\b',text): filters['top']=True
    if 'триггерн' in text: filters['type']='Триггерный'
    if 'пуш' in text or 'смс' in text: filters['channel']='communication'
    if 'экран' in text: filters['channel']='success_screen'
    day=bool(days or re.search(r'по дням|дневн',text))
    week=bool(re.search(WEEK_REQUEST,text))
    selected=calendar_phrase(text)
    if selected:
        match,fields=selected
        query=query[:match.start()]+' '+query[match.end():]
        day=day or fields.get('grain')=='day'
    clean=re.sub(r'по дням|дневн\w*|'+WEEK_REQUEST,'',query,flags=re.I)
    if days:clean=re.sub(r'(?:последн\w*\s+|за\s+)\d{1,3}\s*(?:дн\w*|день)','',clean,flags=re.I)
    if product:clean=re.sub(re.escape(product),'',clean,flags=re.I)
    clean=re.sub(r'свободн\w*\s+групп\w*\s*[№#]?\s*\d+','',clean,flags=re.I)
    old={k:v for k,v in (previous or {}).items() if k not in ('filters','grain','plan','visualSuggestions','daysCount','series','startDate','endDate')}
    if old: old['metrics']=[m for m in old['metrics'] if m!='plan']
    if old and not old['ids']: old['ids']=[1]
    # IDs may be written as «по 1007», without the word «опрос».
    # Period counts and years must never be mistaken for survey IDs.
    id_text=re.sub(r'\d+\s*месяц\w*','',clean,flags=re.I)
    id_text=re.sub(r'(?:за\s+|с\s*(?:начала\s+)?)(?:19|20|21)\d{2}(?:\s*год\w*)?','',id_text,flags=re.I)
    explicit_ids=bool(re.search(r'(?<!\d)\d{1,7}(?!\d)',id_text))
    all_days=bool(days and not explicit_ids and not (previous or {}).get('ids') and not filters and not (previous or {}).get('filters'))
    following=bool(previous and re.search(r'добав|теперь|убер|убра|остав|сравн',text))
    keep_filtered_ids=bool(following and previous.get('ids') and set(filters)<={'channel'})
    if ((filters and not keep_filtered_ids) or all_days) and not explicit_ids:clean+=' опрос 1'
    if 'план' in text and not re.search(r'отправ|событ|csi|ответ',text): clean+=' ответы'
    spec=base_plan(clean,old or None)
    if filters:
        keep_ids=bool(following and previous.get('ids') and set(filters)<={'channel'})
        if not explicit_ids and not keep_ids:spec['ids']=[]
        spec['filters']={**copy.deepcopy(previous.get('filters',{})),**filters} if keep_ids else filters
    elif previous and previous.get('filters') and (not explicit_ids or following):
        spec['filters']=copy.deepcopy(previous['filters'])
        if not previous['ids']:spec['ids']=[]
    if all_days:spec['ids']=[]
    if previous and previous.get('grain')=='week' and not day and not re.search(r'по\s+месяцам',text):spec['grain']='week'
    if day or previous and previous.get('grain')=='day' and 'по месяцам' not in text: spec['grain']='day'
    if days:
        spec['daysCount']=int(days[1]);spec['grain']='day'
        spec.pop('startMonth',None);spec.pop('endMonth',None)
    elif previous and previous.get('daysCount') and spec.get('grain')=='day' and not selected and not re.search(r'месяц|\d{4}\s*год',text):spec['daysCount']=previous['daysCount']
    if previous and previous.get('startDate') and not (selected or days) and spec.get('grain') in ('day','week') and not re.search(r'месяц|\d{4}\s*год',text):
        spec.update(startDate=previous['startDate'],endDate=previous['endDate'])
    if previous and (days or day or re.search(r'добав|теперь|убер|убра|остав',text)) and spec['metrics']!=['unique_surveys']:
        prior=previous.get('series') or [{'id':i,'metric':m} for i in previous['ids'] for m in previous['metrics'] if m!='plan']
        if re.search(r'добав',text) and explicit_ids:
            requested=base_plan(clean,None)
            if previous.get('filters') and not previous.get('ids'):raise ValueError('Чтобы добавить кривую конкретного опроса к общему отбору, сначала выберите отдельные опросы.')
            pairs=prior+[{'id':i,'metric':m} for i in requested['ids'] for m in requested['metrics']]
        elif re.search(r'убер|убра',text) and explicit_ids:
            requested=base_plan(clean,None)
            pairs=[p for p in prior if not (p['id'] in requested['ids'] and p['metric'] in requested['metrics'])]
            if not pairs:raise ValueError('На графике должна остаться хотя бы одна кривая.')
            spec['ids']=list(dict.fromkeys(p['id'] for p in pairs));spec['metrics']=list(dict.fromkeys(p['metric'] for p in pairs))
        elif re.search(r'добав',text):
            requested_metrics=[m for m,p in [('sends',r'отправ'),('answers',r'ответ'),('responseRate',r'отклик'),('events',r'событ'),('csi',r'csi|оценк'),('stop',r'стоп'),('contactPolicy',r'политик')] if re.search(p,normalize_rate_phrase(text)) and m in spec['metrics']]
            pairs=prior+[{'id':i,'metric':m} for i in spec['ids'] for m in requested_metrics]
        else:pairs=[p for p in prior if p['metric'] in spec['metrics'] and p['id'] in spec['ids']]
        if pairs:spec['series']=[dict(id=i,metric=m) for i,m in dict.fromkeys((p['id'],p['metric']) for p in pairs)];spec['layout']='combined'
    if 'план' in text or previous and previous.get('plan'): spec['plan']=True
    spec,_=bind_explicit_chart_request(spec,text)
    return validate_spec(spec)

def select_surveys(state,spec):
    chosen=[s for s in state['surveys'] if not spec.get('ids') or s['event']['id'] in spec['ids']]
    filters=spec.get('filters',{})
    if filters.get('product'):chosen=[s for s in chosen if filters['product'].casefold() in [p.casefold() for p in s['meta'].get('products',['без продукта'])]]
    chosen=[s for s in chosen if (not filters.get('top') or s['event'].get('isTop')) and (not filters.get('type') or filters['type'] in s['meta'].get('surveyType','')) and (not filters.get('channel') or filters['channel']==s['meta']['channel'])]
    if filters.get('triggerGroup'):
        chosen=[s for s in chosen if s['meta'].get('triggerGroup','без группы').strip().casefold()==filters['triggerGroup'].strip().casefold()]
    return chosen

def execute_query(state,spec,source,include_details=True,day_dates=None):
    spec=dict(spec)
    spec['metrics']=[m for m in spec['metrics'] if m!='plan']
    chosen=select_surveys(state,spec)
    filters=spec.get('filters',{})
    if not chosen: raise ValueError('Нет загруженных данных по выбранным условиям.')
    if spec.get('ids') and len({s['event']['id'] for s in chosen}) != len(chosen):
        raise ValueError('Этот номер есть в обоих каналах. Уточните в запросе: «пуш+смс» или «экран успеха».')
    if spec.get('grain')=='week':
        from weekly_query import execute_weekly
        return execute_weekly(state,spec,source,chosen)
    core={k:v for k,v in spec.items() if k not in ('filters','grain','plan','visualSuggestions','daysCount','series','startDate','endDate')}
    dates=day_dates
    if spec.get('startDate'):
        start=calendar_date.fromisoformat(spec['startDate']);end=calendar_date.fromisoformat(spec['endDate'])
        dates=[(start+timedelta(days=i)).isoformat() for i in range((end-start).days+1)]
        core.update(startMonth=dates[0][:7],endMonth=dates[-1][:7])
    if spec.get('daysCount'):
        keys={(s['meta']['channel'],s['event']['id']) for s in chosen}
        daily=[r for r in state.get('rawRecords',[]) if r['grain']=='day' and (r['channel'],r['id']) in keys]
        if not daily and dates is None:raise ValueError('Для последних дней нужны дневные строки в CSV. Месячная выгрузка не содержит дневной детализации.')
        if dates is None:
            end=calendar_date.fromisoformat(max(r['date'] for r in daily));start=end-timedelta(days=spec['daysCount']-1)
            dates=[(start+timedelta(days=i)).isoformat() for i in range(spec['daysCount'])]
        core.update(startMonth=dates[0][:7],endMonth=dates[-1][:7])
    if core['metrics']==['unique_surveys'] and spec.get('grain')!='day':
        distinct={}
        for survey in chosen:
            ident=survey['event']['id']
            if ident not in distinct: distinct[ident]=copy.deepcopy(survey)
            else: distinct[ident]['meta']['availableMonths']=sorted(set(distinct[ident]['meta']['availableMonths'])|set(survey['meta']['availableMonths']))
        result=base_execute(dict(state,surveys=list(distinct.values())),dict(core,ids=[]),source)
        result['spec']=spec
        if filters: result['warnings'].append('Фильтры: '+str(filters))
        return result
    results=[]
    record_groups={}
    for row in state.get('rawRecords',[]):record_groups.setdefault((row['channel'],row['id']),[]).append(row)
    if (filters or len(chosen)>1) and 'startMonth' not in core:
        last=max(m for s in chosen for m in s['meta']['availableMonths'])
        y,m=map(int,last.split('-'));n=y*12+m-core['monthsCount']
        core.update(startMonth=f'{n//12:04d}-{n%12+1:02d}',endMonth=last)
    if (filters or len(chosen)>1) and 'endMonth' not in core:core['endMonth']=max(m for s in chosen for m in s['meta']['availableMonths'])
    for s in chosen:
        one=dict(core,ids=[s['event']['id']])
        if spec.get('series'):
            one['metrics']=list(dict.fromkeys(p['metric'] for p in spec['series'] if p['id']==s['event']['id']))
            if not one['metrics']:continue
        results.append(base_execute(dict(state,surveys=[s],rawRecords=record_groups.get((s['meta']['channel'],s['event']['id']),[])),one,source))
    result=copy.deepcopy(results[0])
    result['blocks']=[copy.deepcopy(b) for r in results for b in r['blocks']]
    if not spec['ids']:
        result['blocks']=[];result['totals']=[];result['table']=[]
        for metric in core['metrics']:
            blocks=[b for r in results for b in r['blocks'] if b['metric']==metric]
            if metric=='csi': raise ValueError('Для CSI укажите конкретный опрос; общий CSI требует взвешивания.')
            values=[sum(b['values'][j] for b in blocks if b['values'][j] is not None) if any(b['values'][j] is not None for b in blocks) else None for j in range(len(result['months']))]
            result['blocks'].append(dict(blocks[0] if blocks else {'metric':metric,'label':METRICS[metric]},id=None,name=filters.get('product','Выбранные опросы'),values=values))
    if spec.get('grain')=='day':
        if dates is None:
            if not spec.get('startMonth'):
                daily_dates=[r['date'] for r in state.get('rawRecords',[]) if r['grain']=='day' and any(r['id']==s['event']['id'] and r['channel']==s['meta']['channel'] for s in chosen)]
                if not daily_dates:raise ValueError('Нет дневных записей по выбранным опросам. Загрузите дневной CSV.')
                last_day=max(daily_dates);year,month_number=map(int,last_day[:7].split('-'))
                start=calendar_date(year,month_number,1);end=calendar_date.fromisoformat(last_day)
                dates=[(start+timedelta(days=i)).isoformat() for i in range((end-start).days+1)]
                result['warnings'].append('Без указания периода показан последний месяц дневной выгрузки до '+last_day+'.')
        if dates is None:
            if not spec.get('startMonth') or spec.get('startMonth')!=spec.get('endMonth'): raise ValueError('Для дневного графика укажите месяц и год или последние 7 дней.')
            month=spec['startMonth'];y,m=map(int,month.split('-'))
            dates=[f'{month}-{d:02d}' for d in range(1,calendar.monthrange(y,m)[1]+1)]
        ids={(s['meta']['channel'],s['event']['id']) for s in chosen}
        rows=[r for r in state.get('rawRecords',[]) if r['grain']=='day' and (r['channel'],r['id']) in ids and dates[0]<=r['date']<=dates[-1]]
        if not rows and day_dates is None: raise ValueError('Нет дневных записей за выбранный период. Загрузите дневной CSV.')
        for b in result['blocks']:
            values=[]
            for date in dates:
                subset=[r for r in rows if r['date']==date and (b['id'] is None or r['id']==b['id'])]
                key=b['metric']; value=None
                if subset:
                    value=calculate(subset,key,'day')
                values.append(value)
            b['values']=values
        result['months']=dates
        result['periodLabel']=dates[0]+' — '+dates[-1]
        result['anchor']=max((row['date'] for row in rows),default=None)
        if spec.get('daysCount'):result['warnings'].append('Последние %s календарных дней по последней дневной дате выбранных опросов: %s. Пропуски не считаются нулями.'%(spec['daysCount'],dates[-1]))
    if spec.get('plan'):
        plans=[s['meta'].get('plan') for s in chosen]
        known=[p for p in plans if p is not None]
        if len(known)!=len(plans): result['warnings'].append('Для части опросов план неизвестен; линия содержит только известные планы.')
        value=sum(known) if known else None
        if spec.get('grain')=='day' and value is not None:
            # Monthly plans are distributed using the actual calendar length.
            value=[plan_for_day(value,d) for d in result['months']]
            result['warnings'].append('Дневной план распределён равномерно по календарным дням месяца.')
        result['blocks'].append(dict(id=None,name='План ответов',metric='plan',label='План ответов',values=value if isinstance(value,list) else [value]*len(result['months'])))
        spec['metrics']=list(dict.fromkeys(spec['metrics']+['plan']))
    proof_blocks=[block for block in result['blocks'] if block['metric'] in ('csi','responseRate')]
    if proof_blocks:
        from collections import defaultdict
        by_period=defaultdict(list);keys={(s['meta']['channel'],s['event']['id']) for s in chosen}
        valid_periods=set(result['months']);daily=spec.get('grain')=='day'
        for row in state.get('rawRecords',[]):
            period=row['date'] if daily else row['date'][:7]
            if period in valid_periods and (row['channel'],row['id']) in keys and (not daily or row['grain']=='day'):
                by_period[period].append(row)
        for block in proof_blocks:
            proof=weighted_csi if block['metric']=='csi' else response_proof
            block['proofs']=[proof([row for row in by_period[period] if block['id'] is None or row['id']==block['id']]) for period in result['months']]
            if block['metric']=='responseRate':
                block['values']=[item['value'] for item in block['proofs']]
                block['periodRate']=response_rate(sum(item['numerator'] or 0 for item in block['proofs']),
                                                  sum(item['denominator'] or 0 for item in block['proofs']))
    result['totals']=[];result['table']=[]
    for b in result['blocks']:
        known=[v for v in b['values'] if v is not None]
        result['totals'].append(dict(b,value=b['values'][-1] if b['metric']=='csi' else b['periodRate'] if b['metric']=='responseRate' else sum(known) if known else None,note='За выбранный период'))
        result['table'].extend(dict(id=b['id'],name=b['name'],month=d,metric=b['label'],metricKey=b['metric'],value=v) for d,v in zip(result['months'],b['values']))
    result['spec']=spec
    if spec.get('series'):
        present={(p['id'],p['metric']) for p in spec['series']}
        result['optionalSeries']=[{'label':METRICS[m]+' · #'+str(i),'query':'Добавь '+METRICS[m]+' по опросу '+str(i)} for i in spec['ids'] for m in spec['metrics'] if m in METRICS and (i,m) not in present][:3]
    if filters:
        result['members']=[{'id':s['event']['id'],'name':s['meta']['name'],'channel':s['meta']['channel'],'products':s['meta'].get('products',['без продукта'])} for s in chosen]
        if 'sends' in spec['metrics'] and any(s['meta']['channel']=='success_screen' for s in chosen):result['warnings'].append('Для экранов успеха отправки учитывают только статус SENDED; для пуш+СМС используется поле sends.')
        if include_details:
            result['details']=[execute_query(dict(state,surveys=[s]),dict(core,ids=[s['event']['id']],**({k:spec[k] for k in ('grain','daysCount') if k in spec})),source,False,dates) for s in chosen]
    from metric_ratios import attach_send_ratios
    attach_send_ratios(result,state,chosen)
    return result
