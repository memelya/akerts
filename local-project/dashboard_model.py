"""Recalculate the existing V2 payloads from local canonical records."""
import copy
import datetime as dt
from collections import defaultdict
from csv_data import DataError, merge_records

POLICY = [1003, 1011, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024]


def valid_csi(value):
    return value if value is not None and 1 <= value <= 5 else None


def work_dates(month, through=None):
    date = dt.date.fromisoformat(month + '-01')
    end = dt.date.fromisoformat(through) if through else (date.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    values = []
    while date <= end:
        if date.weekday() < 5:
            values.append(date.isoformat())
        date += dt.timedelta(days=1)
    return values


def daily_models(ident, channel, month, rows, latest, has_stop, has_policy):
    source = [row for row in rows if row['date'].startswith(month)]
    screen = channel == 'success_screen'
    period = {'id': ident, 'month': month, 'channel': channel, 'dailyAvailable': bool(source), 'through': None, 'summary': {'sends': None if screen else latest['sends'], 'answers': latest['answers'], 'csi': latest['csi']}, 'days': [], 'weeks': [], 'csiMethod': 'cnt' if screen else 'ratings', 'missingDates': []}
    if not source:
        return period, [], [], None, None
    observed = {}
    for row in source:
        day = observed.setdefault(row['date'], {'events': 0, 'sends': 0, 'answers': 0, 'stop': 0 if has_stop else None, 'contactPolicy': 0 if has_policy else None, '_weight': 0, '_numerator': 0})
        for key in ('events', 'sends', 'answers'):
            day[key] += row[key]
        if has_stop and row['status'] == 1002:
            day['stop'] += row['events']
        if has_policy and row['status'] in POLICY:
            day['contactPolicy'] += row['events']
        score = valid_csi(row.get('csi'))
        if score is not None:
            day['_weight'] += row['events']
            day['_numerator'] += row['events'] * score
    first, through = min(observed), max(observed)
    period['through'] = through
    days, weeks = [], {}
    date = dt.date.fromisoformat(month + '-01')
    end = dt.date.fromisoformat(through)
    while date <= end:
        key = date.isoformat()
        value = observed.get(key)
        if date.weekday() < 5 or value:
            item = {'key': key, 'date': key, 'missing': value is None, **(value or {k: None for k in ('events', 'sends', 'answers', 'stop', 'contactPolicy')})}
            item['csi'] = value['_numerator'] / value['_weight'] if value and value['_weight'] else None
            days.append(item)
            monday = date - dt.timedelta(days=date.weekday())
            week = weeks.setdefault(monday.isoformat(), {'key': monday.isoformat(), 'start': max(month + '-01', monday.isoformat()), 'end': min(through, (monday + dt.timedelta(days=6)).isoformat()), 'observedDays': 0, 'expectedDays': 0, 'missingDates': [], 'events': 0, 'sends': 0, 'answers': 0, 'stop': 0 if has_stop else None, 'contactPolicy': 0 if has_policy else None, '_weight': 0, '_numerator': 0})
            week['expectedDays'] += 1
            if value:
                week['observedDays'] += 1
                for metric in ('events', 'sends', 'answers', 'stop', 'contactPolicy', '_weight', '_numerator'):
                    if week[metric] is not None:
                        week[metric] += value[metric]
            else:
                week['missingDates'].append(key)
                period['missingDates'].append(key)
        date += dt.timedelta(days=1)
    clean = lambda row: {key: value for key, value in row.items() if not key.startswith('_')}
    overview_days = [{key: value for key, value in clean(row).items() if key != 'csi'} for row in days]
    period['days'] = [{key: row.get(key) for key in ('key', 'date', 'missing', 'sends', 'answers', 'csi')} for row in days]
    if screen:
        for day in period['days']:
            day['sends'] = None
    overview_weeks = []
    for row in weeks.values():
        csi = row['_numerator'] / row['_weight'] if row['_weight'] else None
        public = clean(row)
        if not row['observedDays']:
            public.update({key: None for key in ('events', 'sends', 'answers', 'stop', 'contactPolicy')})
            public['missing'] = True
        overview_weeks.append({key: value for key, value in public.items() if key != 'missingDates'})
        period['weeks'].append({key: value for key, value in public.items() if key not in ('events', 'stop', 'contactPolicy', 'missing')} | {'sends': None if screen else public['sends'], 'csi': csi})
    numerator = sum(row['_numerator'] for row in observed.values())
    weight = sum(row['_weight'] for row in observed.values())
    proof = {'numerator': numerator, 'denominator': weight} if weight else None
    return period, overview_days, overview_weeks, first, proof


def aggregate(surveys, months):
    groups = []
    for channel in ('communication', 'success_screen'):
        members = [survey for survey in surveys if survey['meta']['channel'] == channel]
        rows = []
        for index, month in enumerate(months):
            row = {'key': month, 'events': 0, 'sends': 0, 'answers': 0, 'surveyCount': 0, 'sourceDates': [], 'missingSendIds': [], 'missingAnswerIds': []}
            for survey in members:
                event, meta = survey['event'], survey['meta']
                if month not in meta['availableMonths']:
                    continue
                row['surveyCount'] += 1
                row['events'] += event['totals'][index]
                row['sends'] += event['sendTotals'][index] or 0
                answers = event['responseTotals'][index]
                if answers is None:
                    row['missingAnswerIds'].append(event['id'])
                else:
                    row['answers'] += answers
                if meta.get('sourceThrough', '') and meta['sourceThrough'].startswith(month):
                    row['sourceDates'].append({'id': event['id'], 'from': meta['sourceFrom'], 'through': meta['sourceThrough'], 'missingDates': meta['missingDates']})
            row['missing'] = not row['surveyCount']
            if row['missing']:
                row.update(events=None, sends=None, answers=None)
            elif len(row['missingAnswerIds']) == row['surveyCount']:
                row['answers'] = None
            ratio = lambda a, b: row[a] / row[b] * 100 if row[a] is not None and row[b] else None
            row.update(sendRate=ratio('sends', 'events'), answerRate=ratio('answers', 'sends'), overallRate=ratio('answers', 'events'))
            rows.append(row)
        groups.append({'channel': channel, 'surveyCount': sum(bool(s['meta']['availableMonths']) for s in members), 'rows': rows})
    return groups


def build_general(surveys, months):
    def pack(members):
        return {'channels': aggregate(members, months), 'topCommunication': aggregate([s for s in members if s['event']['isTop']], months)[0]}
    def types(members):
        return {kind: pack([s for s in members if s['meta']['surveyTypeKey'] == kind]) for kind in ('csi', 'csat')}
    labels = sorted({s['meta']['triggerGroup'] for s in surveys}, key=lambda value: (value == 'без группы', value))
    result = pack(surveys) | {'typeGroups': types(surveys), 'groupOptions': labels}
    result['triggerGroups'] = {label: pack([s for s in surveys if s['meta']['triggerGroup'] == label]) | {'typeGroups': types([s for s in surveys if s['meta']['triggerGroup'] == label])} for label in labels}
    result['top30'] = {'months': months, 'defaultMonth': months[-2] if len(months) > 1 else months[-1], 'surveys': []}
    for survey in surveys:
        event, meta = survey['event'], survey['meta']
        if meta['channel'] == 'success_screen':
            continue
        result['top30']['surveys'].append({key: meta.get(key) for key in ('id', 'name', 'triggerGroup', 'surveyType', 'surveyTypeKey')} | {'from': meta['sourceFrom'], 'through': meta['sourceThrough'], 'values': [event['sendTotals'][i] if month in meta['availableMonths'] else None for i, month in enumerate(months)]})
    return result


def build_analysis(surveys, months):
    records = []
    for survey in surveys:
        event, meta = survey['event'], survey['meta']
        if meta['channel'] == 'success_screen':
            continue
        rows = []
        for index, month in enumerate(months):
            if month not in meta['availableMonths']:
                continue
            count = lambda codes: sum(s['values'][index] for s in event['statuses'] if s['code'] in codes)
            rows.append({'month': month, 'events': event['totals'][index], 'sends': event['sendTotals'][index], 'answers': event['responseTotals'][index], 'stop': count([1002]), 'policy': count([1011]), 'contactPolicy': count(POLICY)})
        records.append({'id': event['id'], 'name': meta['name'], 'rows': rows})
    targets = [r for ident in (1007, 3155) for r in records if r['id'] == ident]
    comparable = [month for month in months[:-1] if all(any(r['month'] == month for r in t['rows']) for t in targets)]
    context = []
    for month in months:
        rows = [r | {'id': record['id']} for record in records for r in record['rows'] if r['month'] == month]
        context.append({'month': month, **{key: sum(r[key] for r in rows) for key in ('events', 'sends', 'stop', 'policy', 'contactPolicy')}, 'targetSends': sum(r['sends'] for r in rows if r['id'] in (1007, 3155)), 'probe193': next((r['sends'] for r in rows if r['id'] == 193), None), 'otherSends': sum(r['sends'] for r in rows if r['id'] not in (1007, 3155, 193)), 'surveyCount': len(rows)})
    daily = []
    for ident in (1007, 3155):
        survey = next(s for s in surveys if s['event']['id'] == ident)
        overview = survey['overview']
        daily.append({'id': ident, 'month': survey['meta']['sourceMonth'], 'through': overview['through'], 'missingDates': overview['missingDates'], 'days': [dict(row, policy=sum(r['events'] for r in survey['dailyRows'] if r['date'] == row['date'] and r['status'] == 1011) if not row['missing'] else None) for row in overview['days']]})
    return {'months': months, 'comparableMonths': comparable, 'from': '2026-07' if '2026-07' in comparable else comparable[max(0, len(comparable)-2)] if comparable else None, 'to': comparable[-1] if comparable else None, 'targets': targets, 'others': [{'id': r['id'], 'name': r['name'], 'sends': [{'month': row['month'], 'value': row['sends']} for row in r['rows']]} for r in records if r['id'] not in (1007, 3155)], 'context': context, 'daily': daily}


def build_state(baseline, updates):
    records = {item['event']['id']: copy.deepcopy(item) for item in baseline['surveys']}
    days = merge_records(baseline['daily'], [r for r in updates if r['grain'] == 'day'])
    monthly_updates = [r for r in updates if r['grain'] == 'month']
    monthly_groups = {(r['id'], r['date']) for r in monthly_updates}
    days = [r for r in days if (r['id'], r['date'][:7]) not in monthly_groups]
    day_groups = defaultdict(list)
    for row in days:
        day_groups[(row['id'], row['date'][:7])].append(row)
    months = sorted(set(baseline['months']) | {r['date'][:7] for r in updates})
    for row in updates:
        ident = row['id']
        if ident in records and records[ident]['meta']['channel'] != row['channel']:
            raise DataError('Опрос %s уже находится в другом канале. Один ID нельзя неявно объединить между пуш/СМС и экранами успеха.' % ident)
        if ident not in records:
            records[ident] = {'event': {'id': ident, 'channel': row['channel'], 'statuses': [], 'months': months, 'totals': [0]*len(months), 'isTop': False, 'hasData': True}, 'meta': {'id': ident, 'name': row.get('name') or 'Опрос %s' % ident, 'channel': row['channel'], 'plan': None, 'availableMonths': []}}
        if row.get('name'):
            records[ident]['meta']['name'] = row['name']
    by_id_days = defaultdict(list)
    for row in days:
        by_id_days[row['id']].append(row)
    surveys = []
    for ident in sorted(records):
        original = records[ident]
        event, meta = original['event'], original['meta']
        screen = meta['channel'] == 'success_screen'
        old_months = event['months']
        cells = {}
        for status in event['statuses']:
            for month in meta['availableMonths']:
                index = old_months.index(month)
                cells[(month, status['code'])] = {'events': status['values'][index], 'answers': (status.get('qaValues') or [None]*len(old_months))[index], 'sends': status['values'][index] if screen and str(status['code']).upper() == 'SENDED' else 0 if screen or status['code'] != 0 else (status.get('sendValues') or status['values'])[index], 'csi': (status.get('csiValues') or [None]*len(old_months))[index], 'description': status['description']}
        for row in monthly_updates:
            if row['id'] == ident:
                cells[(row['date'], row['status'])] = row | {'description': baseline['statusDescriptions'].get(str(row['status']), str(row['status']))}
        proofs = {}
        for (event_id, month), rows in day_groups.items():
            if event_id != ident:
                continue
            cells = {key: cell for key, cell in cells.items() if key[0] != month}
            grouped = defaultdict(list)
            for row in rows:
                grouped[row['status']].append(row)
            for status, values in grouped.items():
                rated = [r for r in values if valid_csi(r.get('csi')) is not None]
                weight = sum(r['events'] for r in rated)
                numerator = sum(r['events']*r['csi'] for r in rated)
                cells[(month, status)] = {key: sum(r[key] for r in values) for key in ('events', 'sends', 'answers')} | {'csi': numerator/weight if weight else None, 'description': baseline['statusDescriptions'].get(str(status), str(status))}
            rated = [r for r in rows if valid_csi(r.get('csi')) is not None]
            proofs[month] = {'numerator': sum(r['events']*r['csi'] for r in rated), 'denominator': sum(r['events'] for r in rated)}
        available = sorted({month for month, status in cells})
        statuses = []
        codes = sorted({status for month, status in cells}, key=lambda value: (value != 0, str(value)))
        for code in codes:
            values = [cells.get((month, code), {}).get('events', 0) for month in months]
            qa = [cells.get((month, code), {}).get('answers') for month in months]
            csi = [valid_csi(cells.get((month, code), {}).get('csi')) for month in months]
            sends = [cells.get((month, code), {}).get('sends', 0) for month in months]
            statuses.append({'code': code, 'description': next(cell['description'] for (month, status), cell in cells.items() if status == code), 'values': values, 'qaValues': qa if screen or code == 0 else None, 'csiValues': csi if screen or code == 0 else None, 'sendValues': sends if not screen and code == 0 else None, 'total': sum(values), 'latest': values[-1]})
        totals, sends, answers, csis, weights = [], [], [], [], []
        for month in months:
            selected = [cell for (m, status), cell in cells.items() if m == month]
            totals.append(sum(cell['events'] for cell in selected))
            sends.append(sum(cell['sends'] for cell in selected))
            known_answers = [cell['answers'] for cell in selected if cell['answers'] is not None]
            answers.append(sum(known_answers) if known_answers else 0 if screen or selected and (month, 0) not in cells else None)
            if month in proofs:
                proof = proofs[month]
                csis.append(proof['numerator']/proof['denominator'] if proof['denominator'] else None)
                weights.append(proof['denominator'])
            elif screen:
                rated = [cell for cell in selected if valid_csi(cell['csi']) is not None]
                weight = sum(cell['events'] for cell in rated)
                csis.append(sum(cell['events']*cell['csi'] for cell in rated)/weight if weight else None)
                weights.append(weight)
            else:
                csis.append(valid_csi(cells.get((month, 0), {}).get('csi')))
                weights.append(None)
        latest_month = available[-1] if available else months[-1]
        source_index = months.index(latest_month)
        current = latest_month == months[-1]
        event.update(months=months, statuses=statuses, totals=totals, sendTotals=sends, responseTotals=answers, csiValues=csis, latest=totals[-1], previous=totals[-2] if len(totals)>1 else 0, change=None, communicated=0 if screen else sends[-1], communicationShare=sends[-1]/totals[-1]*100 if totals[-1] else 0, channel=meta['channel'], statusModel='mp_status' if screen else 'status_det', hasData=bool(available))
        if screen:
            event['csiWeights'] = weights
        has_stop = not screen and 1002 in codes
        has_policy = not screen and any(code in POLICY for code in codes)
        latest = {'sends': sends[source_index], 'answers': answers[source_index], 'csi': csis[source_index]}
        period, day_rows, week_rows, source_from, proof = daily_models(ident, meta['channel'], latest_month, by_id_days[ident], latest, has_stop, has_policy)
        if screen and proof is None:
            rated = [cell for (month, status), cell in cells.items() if month == latest_month and valid_csi(cell['csi']) is not None]
            weight = sum(cell['events'] for cell in rated)
            proof = {'numerator': sum(cell['events']*cell['csi'] for cell in rated), 'denominator': weight} if weight else None
        monthly = []
        for index, month in enumerate(months):
            missing = month not in available
            count = lambda codes: sum(s['values'][index] for s in statuses if s['code'] in codes)
            monthly.append({'key': month, 'month': month, 'missing': True} | {key: None for key in ('events', 'sends', 'answers', 'stop', 'contactPolicy')} if missing else {'key': month, 'month': month, 'events': totals[index], 'sends': sends[index], 'answers': answers[index], 'stop': count([1002]) if has_stop else None, 'contactPolicy': count(POLICY) if has_policy else None})
        overview = {'id': ident, 'channel': meta['channel'], 'monthly': monthly, 'latest': next((row for row in reversed(monthly) if not row.get('missing')), None), 'hasStop': has_stop, 'hasPolicy': has_policy, 'policyCodes': POLICY, 'dailyAvailable': period['dailyAvailable'], 'through': period['through'], 'missingDates': period['missingDates'], 'days': day_rows, 'weeks': week_rows}
        through = period['through']
        calendar = through if current and through else meta.get('calendarThrough') if current and meta.get('month') == months[-1] else None
        total = len(work_dates(months[-1]))
        elapsed = len(work_dates(months[-1], calendar)) if calendar else 0
        plan = meta.get('plan')
        actual = answers[-1] if current else None
        previous = answers[-4:-1]
        average = sum(previous)/3 if len(previous) == 3 and all(value is not None for value in previous) and all(m in available for m in months[-4:-1]) else None
        type_label = baseline['surveyTypes'].get(str(ident), meta.get('surveyType', 'Триггерный (CSAT)'))
        meta.update(month=months[-1], sourceMonth=latest_month, sourceFrom=source_from, sourceThrough=through, availableMonths=available, hasCurrent=current, actual=actual, sends=None if screen or not current else sends[-1], csi=csis[-1] if current else None, latest=period['summary'], dailyAvailable=period['dailyAvailable'], missingDates=period['missingDates'], elapsed=elapsed, total=total, calendarThrough=calendar, average=average, remaining=max(0, plan-actual) if plan and actual is not None else None, csiProof=proof, surveyType=type_label, surveyTypeKey='csi' if type_label == 'Общий (CSI)' else 'csat', triggerGroup=baseline['triggerGroups'].get(str(ident), 'без группы'))
        meta['forecast'] = round(actual/elapsed*total) if actual is not None and elapsed and not meta['missingDates'] else None
        meta['action'] = 'Неполная дневная выборка: в месячном итоге только переданные даты.' if meta['missingDates'] else 'Месячный план не задан.' if not plan else 'Оцените выполнение плана по текущим данным.'
        if through:
            event['dailySource'] = {'from': source_from, 'through': through, 'dates': sorted({r['date'] for r in by_id_days[ident] if r['date'].startswith(latest_month)}), 'missingBusinessDates': period['missingDates'], 'file': 'date/push-sms.csv' if not screen else 'date/success-screen.csv'}
        else:
            event.pop('dailySource', None)
        surveys.append({'event': event, 'meta': meta, 'period': period, 'overview': overview, 'dailyRows': [r for r in by_id_days[ident] if r['date'].startswith(latest_month)]})
    return {'surveys': surveys, 'months': months, 'general': build_general(surveys, months), 'analysis': build_analysis(surveys, months)}
