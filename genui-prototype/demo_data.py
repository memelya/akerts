"""Обезличенный демо-набор: синтетические дневные ряды с заложенными сюжетами.

Данные не связаны с реальными выгрузками. Генерация детерминирована: один и тот же
якорный день даёт одни и те же файлы, поэтому «Сбросить демо» возвращает исходное состояние.
"""
import datetime as dt
import json
import random
from pathlib import Path

PRODUCTS = {
    'Вклады и сбережения': [514, 895],
    'Кредиты': [578, 1805, 794],
    'Платежи и переводы': [1427, 1428, 589],
    'Премьер': [32, 278],
    'Общебанк': [1007],
    'Экраны успеха': [3434, 480, 1598],
}
# id: (ответов в день, отклик %, CSI)
PUSH = {514: (190, 4.2, 4.72), 895: (55, 3.6, 4.61), 578: (175, 4.0, 4.58), 1805: (70, 3.8, 4.66), 794: (36, 3.5, 4.49),
        1427: (300, 4.4, 4.81), 1428: (290, 4.1, 4.77), 589: (120, 3.9, 4.69), 32: (210, 4.6, 4.88), 278: (34, 3.7, 4.74),
        1007: (2100, 4.3, 4.63)}
SCREEN = {3434: (520, 4.05), 480: (36, 4.42), 1598: (30, 3.92)}
DAYS = 100


def stories(anchor):
    d = lambda n: anchor - dt.timedelta(days=n)
    return {
        'stoplist': d(24),      # 1427, 1428: стоп-лист вырос, отправки −40%
        'csi': d(16),           # 578: CSI −0,45
        'weekly': d(5),         # 514: отклик −30% за последние дни
        'halt': min(anchor.replace(day=1), d(7)),  # 794: отправок нет
        'growth': d(20),        # 589: кампания, отправки +45%
    }


def csi_split(total, target, rnd):
    """Распределяет ответы по оценкам 5..1 так, чтобы среднее было около target."""
    share5 = max(0.05, min(0.95, (target - 2.6) / 2.4))
    weights = [share5, (1 - share5) * .45, (1 - share5) * .25, (1 - share5) * .15, (1 - share5) * .15]
    counts = [int(total * w * rnd.uniform(.94, 1.06)) for w in weights]
    return list(zip((5, 4, 3, 2, 1), counts))


def generate(root, anchor=None):
    root = Path(root)
    anchor = anchor or (dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).date() - dt.timedelta(days=1))
    story = stories(anchor)
    rnd = random.Random(20261116)
    push = ['day_part;event_type_id;status_det;answer_csi;events;sends;answers']
    screen = ['day_part;event_type_id;mp_status;answer_csi;sends;answers']
    for offset in range(DAYS - 1, -1, -1):
        day = anchor - dt.timedelta(days=offset)
        stamp = day.strftime('%d.%m.%Y')
        season = .72 if day.weekday() >= 5 else 1.0
        for ident, (answers, rate, csi) in PUSH.items():
            noise = rnd.uniform(.93, 1.07)
            sends = answers / (rate / 100) * season * noise
            events = sends / .36
            stop_share, policy_share = .22, .14
            if ident in (1427, 1428) and day >= story['stoplist']:
                sends *= .6
                stop_share = .47
            if ident == 589 and day >= story['growth']:
                sends *= 1.45
                events *= 1.45
            if ident == 794 and day >= story['halt']:
                sends = 0
                stop_share = .58
            if ident == 578 and day >= story['csi']:
                csi -= .45
            if ident == 514 and day >= story['weekly']:
                rate *= .68
            sends = int(sends)
            events = int(events)
            answered = int(sends * rate / 100 * rnd.uniform(.9, 1.1))
            used = 0
            for score, count in csi_split(answered, csi, rnd):
                if count:
                    push.append(f'{stamp};{ident};0;{score};{count};{count};{count}')
                    used += count
            if sends - used > 0:
                push.append(f'{stamp};{ident};0;;{sends - used};{sends - used};0')
            push.append(f'{stamp};{ident};1002;;{int(events * stop_share)};0;0')
            push.append(f'{stamp};{ident};1011;;{int(events * policy_share)};0;0')
        for ident, (answers, csi) in SCREEN.items():
            trend = 1 + (DAYS - offset) / DAYS * .25 if ident == 480 else 1
            got = int(answers * season * trend * rnd.uniform(.92, 1.08))
            shown = int(got / .11)
            screen.append(f'{stamp};{ident};SENDED;;{shown};0')
            for score, count in csi_split(got, csi, rnd):
                if count:
                    screen.append(f'{stamp};{ident};CLOSE_FORM;{score};{count};{count}')
            screen.append(f'{stamp};{ident};CLOSE_WIDGET;;{int(shown * .62)};0')
    products = ['Опрос;Продукт'] + [f'{ident};{name}' for name, ids in PRODUCTS.items() for ident in ids]
    folder = root / 'date'
    folder.mkdir(parents=True, exist_ok=True)
    for name, lines in (('push-sms.csv', push), ('success-screen.csv', screen), ('products.csv', products)):
        (folder / name).write_text('﻿' + '\n'.join(lines) + '\n', encoding='utf-8', newline='')
    marker = {'demo': True, 'anchor': anchor.isoformat(), 'stories': {k: v.isoformat() for k, v in story.items()}}
    (root / '.local-data').mkdir(parents=True, exist_ok=True)
    (root / '.local-data' / 'demo.json').write_text(json.dumps(marker, ensure_ascii=False), encoding='utf-8')
    return marker


def calendar_events(marker):
    s = marker['stories']
    return [
        {'title': 'Обновление стоп-листа массовых коммуникаций', 'from': s['stoplist'], 'to': s['stoplist'], 'kind': 'policy',
         'ids': [1427, 1428], 'channel': 'communication', 'note': 'Демо-событие: расширен стоп-лист 1002.'},
        {'title': 'Новая версия анкеты по потребительским кредитам', 'from': s['csi'], 'to': s['csi'], 'kind': 'other',
         'ids': [578], 'channel': 'communication', 'note': 'Демо-событие: изменён порядок вопросов.'},
        {'title': 'Кампания SberPay: расширение аудитории', 'from': s['growth'], 'to': s['growth'], 'kind': 'campaign',
         'ids': [589], 'channel': 'communication', 'note': 'Демо-событие.'},
    ]


MEMORY = [{'surveyId': 1427, 'channel': 'communication', 'metric': 'sends', 'direction': 'down', 'products': ['Платежи и переводы'],
           'title': 'Переводы: падение отправок после обновления стоп-листа',
           'cause': 'Весной после расширения стоп-листа 1002 отправки упали на треть: в стоп-лист попали активные клиенты.',
           'resolution': 'Сегмент исключили из стоп-листа, отправки восстановились за три дня.', 'author': 'Демо'}]
