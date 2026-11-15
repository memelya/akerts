"""Calendar-week charts based exclusively on daily observations."""
import calendar
from collections import defaultdict
from datetime import date, timedelta

from metric_registry import LABELS, calculate, cutoff_rows, plan_for_day, response_proof, valid_csi, weighted_csi


def bounds(spec, latest):
    if spec.get('startDate'):
        return date.fromisoformat(spec['startDate']),date.fromisoformat(spec['endDate'])
    if not latest:
        raise ValueError('Для недельного графика нужны дневные строки по выбранным опросам.')
    end = date.fromisoformat(latest)
    if spec.get('endMonth'):
        year, month = map(int, spec['endMonth'].split('-'))
        end = date(year, month, calendar.monthrange(year, month)[1])
    offset = end.year * 12 + end.month - spec['monthsCount']
    start = date.fromisoformat(spec['startMonth']+'-01') if spec.get('startMonth') else date(offset // 12, offset % 12 + 1, 1)
    if start > end:
        raise ValueError('Нет дневных наблюдений в выбранном недельном периоде.')
    if (end-start).days > 731:
        raise ValueError('Выберите недельный период не длиннее 24 месяцев.')
    return start, end


def execute_weekly(state, spec, source, chosen):
    keys = {(s['meta']['channel'], s['event']['id']) for s in chosen}
    rows = [r for r in state['rawRecords'] if r['grain'] == 'day' and (r['channel'], r['id']) in keys]
    start, end = bounds(spec, state.get('weeklyLatest') or max((r['date'] for r in rows), default=None))
    start_key, end_key = start.isoformat(), end.isoformat()
    groups = defaultdict(list)
    for row in rows:
        if start_key <= row['date'] <= end_key:
            day = date.fromisoformat(row['date'])
            groups[max(start, day-timedelta(days=day.weekday())).isoformat()].append(row)
    if not groups:
        raise ValueError('Нет дневных наблюдений в выбранном недельном периоде.')
    periods, current = [], start
    while current <= end:
        finish = min(end, current+timedelta(days=6-current.weekday()))
        key = current.isoformat()
        observed = len({row['date'] for row in groups.get(key, ())})
        expected=(finish-current).days+1
        periods.append({'start':key,'end':finish.isoformat(),'short':f'{current:%d.%m}–{finish:%d.%m}',
                        'observedDays':observed,'expectedDays':expected,'partial':observed < expected})
        current = finish+timedelta(days=1)
    dates = [p['start'] for p in periods]
    by_id = {survey['event']['id']:survey['meta'] for survey in chosen}
    pairs = spec.get('series') or [{'id':i,'metric':metric} for i in (spec['ids'] or [None]) for metric in spec['metrics']]
    if spec['metrics'] == ['unique_surveys']:
        pairs = [{'id':None,'metric':'unique_surveys'}]
    if spec.get('plan'):
        pairs = [*pairs, {'id':None,'metric':'plan'}]
        spec = dict(spec, metrics=[*spec['metrics'], 'plan'])
    blocks, totals, table = [], [], []
    for pair in pairs:
        ident, metric = pair['id'], pair['metric']
        if metric == 'csi' and ident is None:
            raise ValueError('Для недельного CSI укажите конкретный опрос.')
        name = by_id[ident]['name'] if ident is not None else 'Выбранные опросы'
        per_week = [[r for r in groups.get(key, ()) if ident is None or r['id'] == ident] for key in dates]
        if metric == 'plan':
            plans = [s['meta']['plan'] for s in chosen if s['meta'].get('plan') is not None]
            values = [sum(plan_for_day(sum(plans), (date.fromisoformat(p['start'])+timedelta(days=i)).isoformat())
                          for i in range((date.fromisoformat(p['end'])-date.fromisoformat(p['start'])).days+1)) if plans else None for p in periods]
        else:
            values = [calculate(group,metric,'day') for group in per_week]
        block = {'id':ident,'name':name,'metric':metric,'label':LABELS[metric],'values':values}
        if metric == 'csi':
            block['proofs'] = [weighted_csi(group) for group in per_week]
        if metric == 'responseRate':
            block['proofs'] = [response_proof(group) for group in per_week]
        coverage=[]
        for period,group in zip(periods,per_week):
            observed=len({r['date'] for r in group})
            eligible=cutoff_rows(group,metric) if metric in ('stop','contactPolicy') else [r for r in group if valid_csi(r['csi']) is not None and r['events']>0] if metric=='csi' else None
            coverage.append({'observedDays':observed,'expectedDays':period['expectedDays'],
                             'metricDays':len({r['date'] for r in eligible}) if eligible is not None else None})
        block['weeklyCoverage']=coverage
        blocks.append(block)
        known = [value for value in values if value is not None]
        total = calculate([row for group in per_week for row in group],metric,'day') if metric in ('unique_surveys','responseRate') else values[-1] if metric=='csi' else sum(known) if known else None
        totals.append({**block,'value':total,'note':'Последняя неделя' if metric=='csi' else 'За выбранный период'})
        table.extend({'id':ident,'name':name,'month':key,'metric':LABELS[metric],'metricKey':metric,'value':value,'coverage':span}
                     for key,value,span in zip(dates,values,coverage))
    result = {'spec':spec,'source':source,'months':dates,'periods':periods,'blocks':blocks,'totals':totals,'table':table,
              'periodLabel':start_key+' — '+end_key,'anchor':max(row['date'] for group in groups.values() for row in group),
              'methods':['Недели с понедельника по воскресенье. CSI взвешен по количеству оценок.'],
              'warnings':['Границы периода и пропуски могут дать неполные недели. Месячные строки исключены.']}
    from metric_ratios import attach_send_ratios
    return attach_send_ratios(result, dict(state,rawRecords=rows), chosen)
