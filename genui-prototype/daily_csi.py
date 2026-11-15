"""Daily original-rating distributions. Monthly averages cannot reconstruct them."""
import calendar
from collections import defaultdict

MONTHS = {7: 'июль', 8: 'август', 9: 'сентябрь', 10: 'октябрь', 11: 'ноябрь'}


def meeting_charts(engine, revision, choice='auto'):
    """One SQL slice for all five months, retained until an explicit refresh."""
    cache = getattr(engine, '_meeting_daily_csi', None)
    if cache is None or cache['revision'] != revision:
        rows = engine.store.records(revision, [('communication', 1007), ('success_screen', 1007)], '2026-07-01', '2026-11-30') if revision else []
        grouped = defaultdict(list)
        for row in rows:
            if row['grain'] == 'day':
                grouped[row['date'][:7]].append(row)
        cache = {'revision': revision, 'months': grouped}
        engine._meeting_daily_csi = cache
    return [_month_chart(cache['months'].get(f'2026-{month:02d}', []), revision, month, choice) for month in MONTHS]


def _month_chart(rows, revision, month, choice):
    period = f'2026-{month:02d}'
    label = MONTHS[month] + ' 2026'
    base = {'kind': 'daily-csi', 'id': 1007, 'month': period, 'title': 'CSI по дням · 1007 · ' + label}
    channels = sorted({row['channel'] for row in rows})
    if choice == 'auto' and len(channels) > 1:
        return dict(base, status='clarification', channels=channels, message=f'За {label} есть дневные строки в обоих каналах. Выберите канал для CSI.')
    channel = channels[0] if choice == 'auto' and channels else choice
    selected = [row for row in rows if row['channel'] == channel]
    if not selected:
        return dict(base, status='empty', message=f'Нет дневных строк опроса 1007 за {label} в выбранном канале. Для распределения нужны дневные строки с answer_csi (или answers_csi) и числом событий по оценке. Из месячного среднего доли восстановить нельзя.')
    grouped = defaultdict(list)
    for row in selected:
        grouped[row['date']].append(row)
    days = []
    for day in range(1, calendar.monthrange(2026, month)[1] + 1):
        date = f'{period}-{day:02d}'
        counts = {score: 0 for score in range(1, 6)}
        zero = unknown = 0
        for row in grouped[date]:
            rating, weight = row.get('rating'), row['events']
            if rating in counts:
                counts[int(rating)] += weight
            elif rating == 0:
                zero += weight
            else:
                unknown += weight
        total = sum(counts.values())
        csi = sum(score * count for score, count in counts.items()) / total if total else None
        days.append({'date': date, 'csi': csi, 'count': total, 'hasRows': bool(grouped[date]), 'zeroCount': zero, 'unclassifiedCount': unknown, 'ratings': [{'score': score, 'count': counts[score], 'percent': counts[score] / total * 100 if total else None} for score in counts]})
    return dict(base, status='ok', channel=channel, data={
        'days': days, 'revision': revision, 'channel': channel, 'title': base['title'], 'month': period, 'monthLabel': label,
        'method': 'CSI дня = сумма (оценка × events) / сумма events по исходным оценкам 1–5. «Всего» внутри столбца — число оценок 1–5 за этот день; доли оценок считаются от того же числа. Высота столбца — CSI; подписи внутри — состав оценок, не слагаемые высоты. Оценка 0, пустые и неклассифицируемые оценки в CSI и знаменатель долей не входят. Нет валидных оценок — нет столбца, а не CSI = 0.'})
