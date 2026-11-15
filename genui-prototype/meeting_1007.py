"""Weekly dashboard for survey 1007, derived only from original daily rows."""
import datetime as dt
from collections import defaultdict
from metric_registry import calculate, LABELS, weighted_csi
from metric_ratios import ratio

TITLE = 'Динамика по общебанку'
METRICS = ('events', 'sends', 'answers', 'stop', 'contactPolicy', 'stopAndPolicy', 'csi')
DEFAULT = ('events', 'sends', 'answers')
LABELS = LABELS | {'events': 'События', 'stopAndPolicy': 'Стоп-листы + политика контактов'}
METHOD = 'Неделя — понедельник–воскресенье, обрезанная по выбранным датам. Количества суммируются по дневным строкам опроса 1007. CSI взвешен по events с оценкой 1–5, оценка 0 исключена. Ответы / отправки — отклик; отправки и отсечения / все события — доля. Пустая неделя не заменяется нулём. Наличие строк не подтверждает полноту выгрузки.'


def _date(value, name):
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError(name + ': нужна дата ГГГГ-ММ-ДД.')
    try:
        date = dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError(name + ': некорректная дата.') from None
    if date.year != 2026:
        raise ValueError('Для встречи выберите период внутри 2026 года.')
    return date


def dashboard(engine, request):
    if set(request) - {'startDate', 'endDate', 'channel'}:
        raise ValueError('Неизвестный фильтр дашборда 1007.')
    choice = request.get('channel', 'auto')
    if choice not in ('auto', 'communication', 'success_screen'):
        raise ValueError('Неизвестный канал опроса 1007.')
    start = _date(request.get('startDate', '2026-08-01'), 'Начало периода')
    requested_end = _date(request['endDate'], 'Конец периода') if request.get('endDate') else None
    if requested_end and requested_end < start:
        raise ValueError('Начало периода должно быть не позже конца.')
    with engine.lock:
        _, status = engine.refresh()
        if status.get('error'):
            raise ValueError('CSV не приняты: ' + status['error'])
        revision = engine.document.get('revision')
        cache = getattr(engine, '_meeting_1007_weeks', None)
        if cache is None or cache['revision'] != revision:
            rows = engine.store.records(revision, [('communication', 1007), ('success_screen', 1007)], '2026-01', '2026-12-31') if revision else []
            daily = [r for r in rows if r['grain'] == 'day']
            cache = {'revision': revision, 'rows': daily, 'monthly': any(r['grain'] != 'day' for r in rows)}
            engine._meeting_1007_weeks = cache
        rows = cache['rows']
        candidate = [r for r in rows if choice == 'auto' or r['channel'] == choice]
        latest = max((r['date'] for r in candidate), default=start.isoformat())
        end = requested_end or max(start, dt.date.fromisoformat(latest))
        scoped = [r for r in candidate if start.isoformat() <= r['date'] <= end.isoformat()]
        period_channels = sorted({r['channel'] for r in scoped})
        available_channels = period_channels
        if not available_channels:
            available_channels = sorted({r['channel'] for r in candidate})
        channel = available_channels[0] if choice == 'auto' and len(available_channels) == 1 else choice
        selected = [r for r in rows if r['channel'] == channel]
        if requested_end is None and selected:
            end = max(start, dt.date.fromisoformat(max(r['date'] for r in selected)))
        metadata_rows = selected if channel != 'auto' else candidate
        available_dates = sorted({r['date'] for r in metadata_rows})
        base = {'title': TITLE, 'kind': 'weekly', 'id': 1007, 'channel': channel, 'revision': revision,
                'range': {'start': start.isoformat(), 'end': end.isoformat()},
                'availableStart': available_dates[0] if available_dates else None,
                'availableEnd': available_dates[-1] if available_dates else None,
                'availableMonths': sorted({d[:7] for d in available_dates}),
                'channels': available_channels, 'held': bool(engine.document.get('heldFingerprint'))}
        if choice == 'auto' and len(period_channels) > 1:
            return dict(base, status='clarification', message='В выбранном периоде опрос 1007 есть в обоих каналах. Выберите канал для этого дашборда; значения не объединены.')
        scoped = [r for r in selected if start.isoformat() <= r['date'] <= end.isoformat()]
        if not scoped:
            message = 'Нет дневных строк опроса 1007 в выбранном периоде и канале. Измените фильтр или добавьте дневную выгрузку в date.'
            if cache['monthly']:
                message += ' В источнике есть месячные строки: их нельзя достоверно разложить по неделям.'
            return dict(base, status='empty', message=message)
        groups = defaultdict(list)
        for row in scoped:
            day = dt.date.fromisoformat(row['date'])
            monday = day - dt.timedelta(days=day.weekday())
            groups[monday].append(row)
        periods, series = [], {m: [] for m in METRICS}
        for monday, week in sorted(groups.items()):
            sunday = monday + dt.timedelta(days=6)
            first, last = max(start, monday), min(end, sunday)
            observed = len({r['date'] for r in week})
            partial = first != monday or last != sunday
            short = first.strftime('%d.%m') + '–' + last.strftime('%d.%m')
            label = first.strftime('%d.%m.%Y') + ' — ' + last.strftime('%d.%m.%Y')
            weights=weighted_csi(week)
            periods.append({'csiNumerator':weights['numerator'],'csiDenominator':weights['denominator'],'start': first.isoformat(), 'end': last.isoformat(), 'calendarStart': monday.isoformat(),
                            'label': label + (' · часть недели' if partial else ''), 'short': short,
                            'partial': partial, 'observedDays': observed, 'expectedDays': (last-first).days+1,
                            'coverage': f'Дней со строками: {observed} из {(last-first).days+1}'})
            for metric in METRICS:
                if metric == 'stopAndPolicy':
                    values = [calculate(week, m) for m in ('stop', 'contactPolicy')]
                    series[metric].append(sum(v for v in values if v is not None) if any(v is not None for v in values) else None)
                else:
                    series[metric].append(calculate(week, metric))
        blocks, totals, table = [], [], []
        for metric in METRICS:
            values = series[metric]
            value = calculate(scoped, metric) if metric != 'stopAndPolicy' else sum(v for v in values if v is not None) if any(v is not None for v in values) else None
            block = {'id': 1007, 'name': TITLE, 'metric': metric, 'label': LABELS[metric], 'values': values,
                     'enabled': metric in DEFAULT, 'optional': metric not in DEFAULT, 'available': any(v is not None for v in values),
                     'reason': 'Нет исходных значений в выбранном периоде' if metric == 'csi' else 'В выбранном периоде нет строк нужных статусов'}
            if metric != 'csi':
                denominator = series['sends' if metric == 'answers' else 'events']
                total_base = sum(v for v in denominator if v is not None)
                complete = all(v is not None for v, d in zip(values, denominator) if d is not None)
                block['ratio'] = {'baseMetric': 'sends' if metric == 'answers' else 'events', 'baseValues': denominator,
                                  'values': [ratio(v, d) for v, d in zip(values, denominator)], 'totalBase': total_base,
                                  'total': ratio(value, total_base) if complete else None, 'method': METHOD}
            blocks.append(block)
            totals.append(dict(block, value=value, note='За выбранный период'))
            table.extend({'id': 1007, 'name': TITLE, 'month': p['start'], 'periodEnd': p['end'], 'metric': LABELS[metric], 'value': v,
                          'sendRatio': block.get('ratio', {}).get('values', [None]*len(periods))[i]} for i, (p, v) in enumerate(zip(periods, values)))
        data = {'spec': {'ids': [1007], 'filters': {'channel': channel}, 'grain': 'week', 'layout': 'combined'},
                'months': [p['start'] for p in periods], 'periods': periods, 'periodLabel': start.isoformat()+' — '+end.isoformat(),
                'source': 'Ваши CSV · дневные строки 1007', 'blocks': blocks, 'totals': totals, 'table': table,
                'meetingPercentages': True, 'meetingTitle': TITLE, 'methods': [METHOD], 'warnings': [], 'dataRevision': revision}
        return dict(base, status='ok', memberCount=1, data=data)
