"""CSV ingestion for the offline dashboard. Python standard library only."""
import csv
import datetime as dt
import io
import re

MAX_INT = 9007199254740991
ALIASES = {
    'event_type_id': ('event_type_id', 'eventtypeid', 'опрос', 'id опроса', 'survey_id'),
    'day_part': ('day_part', 'date', 'day', 'дата'),
    'month': ('month', 'месяц'),
    'status_det': ('status_det', 'statusdet'),
    'mp_status': ('mp_status', 'mpstatus'),
    'events': ('events', 'cnt', 'count', 'события'),
    'sends': ('sends', 'send_count', 'отправки'),
    'answers': ('answers', 'qa_cnt', 'ответы'),
    'answer_csi': ('answer_csi', 'оценка'),
    'csi': ('csi',),
    'name': ('survey_name', 'event_name', 'название опроса'),
}


class DataError(ValueError):
    pass


def decode_csv(raw):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        return raw.decode('utf-16')
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('cp1251')


def date_value(text):
    text = text.strip()
    for fmt in ('%d.%m.%Y', '%Y-%m-%d', '%Y-%m-%d %H:%M:%S', '%d.%m.%Y %H:%M:%S'):
        try:
            return dt.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    raise DataError('Некорректная дата: ' + text)


def month_value(text):
    text = text.strip()
    for fmt in ('%Y-%m', '%m.%Y', '%Y-%m-%d', '%d.%m.%Y'):
        try:
            return dt.datetime.strptime(text, fmt).strftime('%Y-%m')
        except ValueError:
            pass
    raise DataError('Некорректный месяц: ' + text)


def count_value(text, field, optional=False):
    text = text.strip().replace('\u00a0', '').replace('\u202f', '').replace(' ', '')
    if optional and not text:
        return None
    if not re.fullmatch(r'\d+(?:[.,]0+)?', text):
        raise DataError('Поле ' + field + ': требуется целое неотрицательное число')
    value = int(re.split('[.,]', text)[0])
    if value > MAX_INT:
        raise DataError('Слишком большое число в ' + field)
    return value


def score_value(text, field, rating=False):
    if not text.strip():
        return None
    try:
        value = float(text.strip().replace(',', '.'))
    except ValueError:
        raise DataError('Поле ' + field + ': требуется число')
    if not rating and value == 0:
        return None
    if not 1 <= value <= 5 or rating and not value.is_integer():
        raise DataError('Поле ' + field + ': допустимы оценки от 1 до 5')
    return int(value) if rating else value


def parse_csv(raw, channel, filename):
    text = decode_csv(raw).lstrip('\ufeff').strip()
    if not text:
        return [], {'file': filename, 'rows': 0, 'duplicates': 0, 'format': 'пустой файл'}
    if text.splitlines()[0].lower().startswith('sep='):
        text = '\n'.join(text.splitlines()[1:])
    header_line = text.splitlines()[0]
    delimiter = max((';', ',', '\t'), key=header_line.count)
    try:
        reader = csv.reader(io.StringIO(text), delimiter=delimiter, strict=True)
        headers = [h.strip().lower() for h in next(reader)]
        if len(headers) != len(set(headers)):
            raise DataError('Повторяющиеся названия колонок')
        lookup = {}
        for field, aliases in ALIASES.items():
            for alias in aliases:
                if alias in headers:
                    lookup[field] = headers.index(alias)
                    break
        # In the rated daily screen export, sends is the count of records in each
        # mp_status/answer_csi bucket. It is not push delivery across all statuses.
        screen_count = channel == 'success_screen' and 'events' not in lookup and 'sends' in lookup
        required = ['event_type_id', 'sends' if screen_count else 'events', 'answers']
        grain = 'day' if 'day_part' in lookup else 'month'
        required.append('day_part' if grain == 'day' else 'month')
        required.append('mp_status' if channel == 'success_screen' else 'status_det')
        if channel == 'communication':
            required.append('sends' if grain == 'day' else 'answers')
        missing = sorted(set(required) - lookup.keys())
        if missing:
            raise DataError('Нет колонок: ' + ', '.join(missing))
        records, keys, duplicates = [], set(), 0
        for line_number, cells in enumerate(reader, 2):
            if not any(cell.strip() for cell in cells):
                continue
            try:
                if len(cells) != len(headers):
                    raise DataError('Ожидается %s колонок, получено %s' % (len(headers), len(cells)))
                get = lambda field: cells[lookup[field]].strip() if field in lookup else ''
                ident = count_value(get('event_type_id'), 'event_type_id')
                if not ident:
                    raise DataError('ID опроса должен быть больше нуля')
                date = date_value(get('day_part')) if grain == 'day' else month_value(get('month'))
                status = get('mp_status' if channel == 'success_screen' else 'status_det')
                if channel == 'communication':
                    if not re.fullmatch(r'-?\d+', status):
                        raise DataError('Некорректный status_det')
                    status = int(status)
                elif not re.fullmatch(r'[A-Za-z_]+', status):
                    raise DataError('Некорректный mp_status')
                count_field = 'sends' if screen_count else 'events'
                events = count_value(get(count_field), count_field)
                answers = count_value(get('answers'), 'answers')
                sends = (events if str(status).upper() == 'SENDED' else 0) if channel == 'success_screen' else count_value(get('sends'), 'sends') if 'sends' in lookup else events if status == 0 else 0
                rating = None
                if grain == 'day' and 'answer_csi' in lookup:
                    raw_rating = get('answer_csi')
                    if channel == 'success_screen' and re.fullmatch(r'0(?:[.,]0+)?', raw_rating):
                        raw_rating = ''
                    rating = score_value(raw_rating, 'answer_csi', True)
                csi = score_value(get('csi'), 'csi') if 'csi' in lookup else rating
                record = {'channel': channel, 'grain': grain, 'date': date, 'id': ident, 'status': status, 'rating': rating, 'events': events, 'sends': sends, 'answers': answers, 'csi': csi}
                if get('name'):
                    record['name'] = get('name')
                key = record_key(record)
                if key in keys:
                    duplicates += 1
                keys.add(key)
                records.append(record)
            except DataError as error:
                raise DataError('%s, строка %s: %s' % (filename, line_number, error))
    except (csv.Error, StopIteration) as error:
        raise DataError(filename + ': ошибка CSV: ' + str(error))
    except DataError as error:
        if str(error).startswith(filename):
            raise
        raise DataError(filename + ': ' + str(error))
    return records, {'file': filename, 'rows': len(records), 'duplicates': duplicates, 'format': 'дневной' if grain == 'day' else 'месячный'}


def record_key(row):
    return (row['channel'], row['grain'], row['date'], row['id'], str(row['status']), row.get('rating'))


def merge_records(previous, incoming):
    """Last row wins. A new grain explicitly replaces the old grain for its survey/month."""
    grains = {(row['channel'], row['id'], row['date'][:7]): row['grain'] for row in previous}
    by_key = {record_key(row): row for row in previous}
    for row in incoming:
        group = (row['channel'], row['id'], row['date'][:7])
        if group in grains and grains[group] != row['grain']:
            by_key = {key: old for key, old in by_key.items() if (old['channel'], old['id'], old['date'][:7]) != group}
        grains[group] = row['grain']
        by_key[record_key(row)] = row
    return list(by_key.values())
