"""Comparable feedback collection metrics for the executive start page."""
import datetime as dt
from collections import defaultdict
from itertools import permutations
from math import prod

from metric_registry import POLICY

CHANNELS = {'communication': 'Пуш + СМС', 'success_screen': 'Экраны успеха'}
FACTORS = ('events', 'sendShare', 'responseRate')
WEEK = dt.timedelta(days=7)


def windows(end):
    end = dt.date.fromisoformat(end)
    return {
        'previous': {'start': (end-dt.timedelta(days=13)).isoformat(), 'end': (end-WEEK).isoformat()},
        'current': {'start': (end-dt.timedelta(days=6)).isoformat(), 'end': end.isoformat()},
    }


def divide(a, b):
    return a / b if b else None


def summarize(rows):
    if not rows:
        return dict.fromkeys(('events', 'sends', 'answers', 'csi', 'csiSample', 'sendShare', 'responseRate'))
    totals = {key: sum(row[key] for row in rows) for key in ('events', 'sends', 'answers', 'csiSample')}
    csi = divide(sum(row['csiWeight'] for row in rows), totals['csiSample'])
    return dict(totals, csi=csi, sendShare=divide(totals['sends'], totals['events']),
                responseRate=divide(totals['answers'], totals['sends']))


def explain(previous, current):
    a, b = [[period[key] for key in FACTORS] for period in (previous, current)]
    if any(value is None for value in a+b):
        return None
    # Average across the six orders in which the three factors can change.
    contributions = dict.fromkeys(FACTORS, 0.0)
    for order in permutations(range(3)):
        values = a.copy()
        for index in order:
            before = prod(values)
            values[index] = b[index]
            contributions[FACTORS[index]] += (prod(values)-before)/6
    return contributions


def cutoffs(before, after):
    if not before or not after:
        return []
    results = []
    for status in ('stop', 'contactPolicy'):
        counts = [sum(row[status] is not None for row in rows) for rows in (before, after)]
        totals = [sum(row[status] or 0 for row in rows) if n else None for rows,n in zip((before,after),counts)]
        events = [sum(row['events'] for row in rows) for rows in (before,after)]
        shares = [divide(value, base) if value is not None else None for value,base in zip(totals,events)]
        complete = counts == [len(before),len(after)]
        results.append({'metric': status, 'counts': totals, 'observed': counts, 'expected': len(before),
                        'shares': shares if complete else None})
    return results


def compare_scope(keys, day_index, cohorts, span):
    pairs = [pair for key in sorted(keys) for pair in cohorts[key]]
    before,after = [list(part) for part in zip(*pairs)] if pairs else ([],[])
    baseline,current = summarize(before),summarize(after)
    actual=summarize([row for key in sorted(keys) for date,row in day_index[key].items() if date>=span['current']['start']])
    communication = [(a,b) for a,b in pairs if a['channel']=='communication']
    stop_before,stop_after = [list(part) for part in zip(*communication)] if communication else ([],[])
    return {'windows':span,'baseline':baseline,'current':current,'actual':actual,
            'pairCount':len(pairs),'observedSurveyDays':sum(len(day_index[key]) for key in keys),
            'surveyCount':len(keys),'comparedSurveys':sum(bool(cohorts[key]) for key in keys),
            'pairedDays':sorted({row['date'] for row in after}),
            'loss':max(0,baseline['answers']-current['answers']) if pairs else None,
            'factors':explain(baseline,current),'cutoffs':cutoffs(stop_before,stop_after)}


def paired_rows(daily, end):
    dates=[dt.date.fromisoformat(end)-dt.timedelta(days=i) for i in range(6,-1,-1)]
    return [(daily[prior],daily[now]) for day in dates
            if (prior:=(day-WEEK).isoformat()) in daily and (now:=day.isoformat()) in daily]


def answer_selection(surveys, selection):
    if not isinstance(selection,dict) or set(selection)-{'id','product','channel','top'}:
        raise ValueError('Проверьте отбор для недельного разбора.')
    ident,product,channel,top=(selection.get('id'),selection.get('product',''),
                               selection.get('channel',''),selection.get('top',False))
    if (ident is not None and (type(ident) is not int or not 1<=ident<=9999999)
            or not isinstance(product,str) or len(product)>200 or channel not in ('',*CHANNELS)
            or type(top) is not bool):
        raise ValueError('Проверьте номер опроса, продукт и канал.')
    return [s for s in surveys if (ident is None or s['event']['id']==ident)
            and (not channel or s['meta']['channel']==channel)
            and (not product or product in s['meta'].get('products',[]))
            and (not top or s['event'].get('isTop'))]


def answer_change(store,revision,surveys,selection,through=None):
    members=answer_selection(surveys,selection)
    ident=selection.get('id')
    product=selection.get('product','')
    channel=selection.get('channel','')
    selected={(s['meta']['channel'],s['event']['id']):s for s in members}
    keys=sorted(selected)
    if through is not None:
        try:
            if dt.date.fromisoformat(through).isoformat()!=through:raise ValueError()
        except (TypeError,ValueError):
            raise ValueError('Укажите конец окна в формате ГГГГ-ММ-ДД.') from None
    if ident and not channel and revision:
        available=[key[0] for key in keys if store.last_daily(revision,[key],through)]
        if len(available)>1:
            return {'name':'Опрос '+str(ident),'choices':available,'selection':selection}
        if available:
            channel=available[0]
            keys=[key for key in keys if key[0]==channel]
            selection={**selection,'channel':channel}
    latest=store.last_daily(revision,keys,through) if revision and keys else None
    if not latest:
        return {'unavailable':'В выбранном отборе нет дневных строк CSV. Для разбора нужны данные по дням.'}
    end=through or latest
    span=windows(end)
    day_index={key:{} for key in keys}
    for row in store.feedback_days(revision,span['previous']['start'],end,POLICY,keys):
        day_index[row['channel'],row['survey_id']][row['date']]=row
    pairs={key:paired_rows(daily,end) for key,daily in day_index.items()}
    cohorts={key:group if len(group)>=5 else [] for key,group in pairs.items()}
    scope=compare_scope(keys,day_index,cohorts,span)
    coverage={name:{'missing':set(),'missingSurveyDays':0,'excludedAnswers':0}
              for name in span}
    contributors,excluded_surveys=[],[]
    for key in keys:
        base={'id':key[1],'channel':key[0],'name':selected[key]['meta']['name']}
        selected_pairs=cohorts[key]
        if selected_pairs:
            before,after=map(summarize,zip(*selected_pairs))
            factors=explain(before,after)
            leading=min(factors,key=factors.get) if factors and min(factors.values()) < -0.005 else None
            contributors.append(dict(base,baseline=before['answers'],current=after['answers'],
                                     delta=after['answers']-before['answers'],pairs=len(selected_pairs),leading=leading))
        excluded_by_window=[]
        for index,(name,period) in enumerate(span.items()):
            start=dt.date.fromisoformat(period['start'])
            dates=[(start+dt.timedelta(days=i)).isoformat() for i in range(7)]
            used={pair[index]['date'] for pair in selected_pairs}
            daily=day_index[key]
            excluded=sum(daily[date]['answers'] for date in dates if date in daily and date not in used)
            missing={date for date in dates if date not in daily}
            coverage[name]['missing'].update(missing)
            coverage[name]['missingSurveyDays']+=len(missing)
            coverage[name]['excludedAnswers']+=excluded
            excluded_by_window.append(excluded)
        if not selected_pairs:
            excluded_surveys.append(dict(base,baseline=excluded_by_window[0],current=excluded_by_window[1],pairs=len(pairs[key]),
                baselineObserved=any(date<=span['previous']['end'] for date in day_index[key])))
    for value in coverage.values():
        value['missing']=sorted(value['missing'])
    contributors.sort(key=lambda row:(row['delta'],row['id'],row['channel']))
    excluded_surveys.sort(key=lambda row:(-row['baseline'],row['id'],row['channel']))
    title=('Опрос '+str(ident) if ident else product or ('По банку' if not channel else CHANNELS[channel]))
    if channel and (ident or product):title+=' · '+CHANNELS[channel]
    if selection.get('top'):title+=' · топ-опросы'
    scope_id=('survey:'+str(ident)+':'+channel if ident else 'product:'+product if product else 'channel:'+channel if channel else 'bank:all')
    return dict(scope,key=scope_id,kind='survey' if ident else 'analysis',id=ident,channel=channel,name=title,
                through=end,latest=latest,revision=revision,selection=selection,
                availablePairs=sum(map(len,pairs.values())),comparisonCoverage=coverage,
                contributors=contributors,excludedSurveys=excluded_surveys)


def build(store, revision, surveys):
    channels = [(channel, [(channel,s['event']['id']) for s in surveys if s['meta']['channel']==channel]) for channel in CHANNELS]
    latest = {channel: store.last_daily(revision, keys) if keys and revision else None for channel,keys in channels}
    end = max(filter(None,latest.values()), default=None)
    if end is None:
        return {'revision':revision,'latest':latest,'overview':None,'channels':[],'signals':[]}
    span=windows(end)
    rows = store.feedback_days(revision, span['previous']['start'], end, POLICY)
    day_index = defaultdict(dict)
    for row in rows:
        day_index[row['channel'],row['survey_id']][row['date']] = row
    members = {('bank','all'): set(day_index)}
    for channel in CHANNELS:
        members['channel',channel] = {key for key in day_index if key[0]==channel}
    for survey in surveys:
        key = survey['meta']['channel'], survey['event']['id']
        if key in day_index:
            for product in set(survey['meta'].get('products') or ['без продукта']):
                members.setdefault(('product',product),set()).add(key)
    cohorts = {}
    for key, daily in day_index.items():
        pairs = paired_rows(daily,end)
        cohorts[key] = pairs if len(pairs)>=5 else []
    scopes = {}
    for (kind,name), keys in members.items():
        scope_id=kind+':'+name
        title='По банку' if kind=='bank' else CHANNELS[name] if kind=='channel' else name
        scopes[scope_id]=dict(compare_scope(keys,day_index,cohorts,span),key=scope_id,kind=kind,
                              name=title,through=end,revision=revision)
    overview = scopes['bank:all']
    # Bank and channel KPIs remain visible above the ranked list.
    ranked = sorted((scope for scope in scopes.values() if scope['kind']!='bank' and (scope['loss'] or 0)>0),
                    key=lambda scope:(-scope['loss'],scope['kind']!='channel',scope['name'].casefold()))
    selected, seen = [], set()
    for scope in ranked:
        kind,name=scope['key'].split(':',1)
        signature=frozenset(key for key in members[kind,name] if cohorts[key])
        if signature not in seen:
            selected.append(scope)
            seen.add(signature)
        if len(selected)==3:
            break
    return {'revision':revision,'latest':latest,'overview':overview,'channels':[scopes['channel:'+key] for key in CHANNELS],
            'signals':selected}
