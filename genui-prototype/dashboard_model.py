"""Build the survey lookup and monthly fallback from local canonical records."""
import copy
import datetime as dt
from collections import defaultdict
from csv_data import merge_records

from metric_registry import valid_csi,weighted_csi


def missing_workdays(month, rows):
    observed = {row['date'] for row in rows}
    if not observed:
        return []
    start = dt.date.fromisoformat(month + '-01')
    end = dt.date.fromisoformat(max(observed))
    days = (start + dt.timedelta(days=i) for i in range((end-start).days+1))
    return [day.isoformat() for day in days if day.weekday() < 5 and day.isoformat() not in observed]


def build_state(baseline, updates):
    records = {(item['meta']['channel'], item['event']['id']): copy.deepcopy(item) for item in baseline['surveys']}
    days = merge_records(baseline['daily'], [r for r in updates if r['grain'] == 'day'])
    monthly_updates = [r for r in updates if r['grain'] == 'month']
    monthly_groups = {(r['channel'], r['id'], r['date']) for r in monthly_updates}
    days = [r for r in days if (r['channel'], r['id'], r['date'][:7]) not in monthly_groups]
    day_groups = defaultdict(list)
    for row in days:
        day_groups[(row['channel'], row['id'], row['date'][:7])].append(row)
    months = sorted(set(baseline['months']) | {r['date'][:7] for r in updates})
    for row in updates:
        ident = row['id']
        record_key = (row['channel'], ident)
        if record_key not in records:
            reference = baseline.get('surveyCatalog', {}).get(str(ident), {})
            if reference.get('channel', row['channel']) != row['channel']:
                reference = {}
            records[record_key] = {'event': {'id': ident, 'channel': row['channel'], 'statuses': [], 'months': months, 'totals': [0]*len(months), 'isTop': reference.get('isTop', False), 'hasData': True}, 'meta': {'id': ident, 'name': row.get('name') or reference.get('name') or 'Опрос %s' % ident, 'channel': row['channel'], 'plan': reference.get('plan'), 'surveyType': reference.get('surveyType', 'Триггерный (CSAT)'), 'availableMonths': []}}
        if row.get('name'):
            records[record_key]['meta']['name'] = row['name']
    surveys = []
    for channel, ident in sorted(records):
        original = records[(channel, ident)]
        event, meta = original['event'], original['meta']
        screen = meta['channel'] == 'success_screen'
        old_months = event['months']
        cells = {}
        for status in event['statuses']:
            for month in meta['availableMonths']:
                index = old_months.index(month)
                cells[(month, status['code'])] = {'events': status['values'][index], 'answers': (status.get('qaValues') or [None]*len(old_months))[index], 'sends': status['values'][index] if screen and str(status['code']).upper() == 'SENDED' else 0 if screen or status['code'] != 0 else (status.get('sendValues') or status['values'])[index], 'csi': (status.get('csiValues') or [None]*len(old_months))[index], 'description': status['description']}
        for row in monthly_updates:
            if row['id'] == ident and row['channel'] == channel:
                cells[(row['date'], row['status'])] = row | {'description': baseline['statusDescriptions'].get(str(row['status']), str(row['status']))}
        proofs = {}
        for (event_channel, event_id, month), rows in day_groups.items():
            if event_id != ident or event_channel != channel:
                continue
            cells = {key: cell for key, cell in cells.items() if key[0] != month}
            grouped = defaultdict(list)
            for row in rows:
                grouped[row['status']].append(row)
            for status, values in grouped.items():
                weighted=weighted_csi(values)
                cells[(month, status)] = {key: sum(r[key] for r in values) for key in ('events', 'sends', 'answers')} | {'csi': weighted['value'], 'description': baseline['statusDescriptions'].get(str(status), str(status))}
            proofs[month] = weighted_csi(rows)
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
                weighted=weighted_csi(selected)
                csis.append(weighted['value'])
                weights.append(weighted['denominator'])
            else:
                csis.append(valid_csi(cells.get((month, 0), {}).get('csi')))
                weights.append(None)
        latest_month = available[-1] if available else months[-1]
        event.update(months=months, statuses=statuses, totals=totals, sendTotals=sends,
                     responseTotals=answers, csiValues=csis, channel=channel,
                     statusModel='mp_status' if screen else 'status_det', hasData=bool(available))
        if screen:
            event['csiWeights'] = weights
        meta.update(availableMonths=available,
                    missingDates=missing_workdays(latest_month, day_groups.get((channel, ident, latest_month), ())),
                    surveyType=baseline['surveyTypes'].get(str(ident), meta.get('surveyType', 'Триггерный (CSAT)')),
                    triggerGroup=baseline['triggerGroups'].get(str(ident), 'без группы'))
        surveys.append({'event': event, 'meta': meta})
    return {'surveys': surveys, 'months': months}

