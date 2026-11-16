"""Пульс дня: проактивный брифинг, сдвиги уровня, похожие инциденты, «что если»,
память расследований, черновик встречи и загрузка CSV.

Все числа считаются локально по дневным строкам SQLite. Модель (GigaCode CLI)
используется только для формулировок и разбора вопросов; её ответ проходит
проверку ссылок на факты и не может добавить новых чисел.
"""
import calendar
import datetime as dt
import json
import math
import re
import threading
import time
import uuid
from collections import defaultdict
from pathlib import Path

from metric_registry import POLICY

VERSION = '1'
WINDOW_DAYS = 56
MIN_SIDE = 7
CHANNELS = ('communication', 'success_screen')
CHANNEL_LABELS = {'communication': 'Пуш + СМС', 'success_screen': 'Экран успеха'}
METRICS = {
    'sends': {'label': 'Отправки', 'unit': 'в день', 'floor': 20, 'kind': 'count'},
    'answers': {'label': 'Ответы', 'unit': 'в день', 'floor': 5, 'kind': 'count'},
    'events': {'label': 'События', 'unit': 'в день', 'floor': 50, 'kind': 'count'},
    'csi': {'label': 'CSI', 'unit': 'балла', 'floor': 0, 'kind': 'score'},
}
UPLOADS = {
    'push-sms.csv': ['day_part', 'event_type_id', 'status_det', 'answer_csi', 'events', 'sends', 'answers'],
    'success-screen.csv': ['day_part', 'event_type_id', 'mp_status', 'answer_csi', 'sends', 'answers'],
    'products.csv': ['Опрос', 'Продукт'],
}
NUMBER = re.compile(r'(?<![\w])[-+−]?\d+(?:[.,]\d+)?')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def clean_text(value, label, limit, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValueError(label + ': нужен текст.')
    value = value.strip()
    if required and not value:
        raise ValueError(label + ': заполните поле.')
    if len(value) > limit:
        raise ValueError(label + ': не длиннее ' + str(limit) + ' символов.')
    return value


def number_or_none(value, label, low, high):
    if value in (None, ''):
        return None
    if type(value) not in (int, float) or isinstance(value, bool) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(label + ': число от ' + str(low) + ' до ' + str(high) + '.')
    return float(value)


# ---------------------------------------------------------------- series ---

def day_value(row, metric):
    if metric == 'csi':
        return row['csiWeight'] / row['csiSample'] if row.get('csiSample') else None
    if metric == 'responseRate':
        return row['answers'] / row['sends'] * 100 if row.get('sends') else None
    value = row.get(metric)
    return float(value) if value is not None else None


def series_by_survey(rows):
    grouped = defaultdict(dict)
    for row in rows:
        grouped[row['channel'], row['survey_id']][row['date']] = row
    return grouped


def mean(values):
    return sum(values) / len(values) if values else None


def variance(values, centre):
    return sum((v - centre) ** 2 for v in values) / (len(values) - 1) if len(values) > 1 else 0.0


def weighted_csi(rows):
    sample = sum(r.get('csiSample') or 0 for r in rows)
    return (sum(r.get('csiWeight') or 0 for r in rows) / sample, sample) if sample else (None, 0)


def detect_shift(days, metric):
    """Ищет одну устойчивую ступень в дневном ряду (пропуски не считаются нулями)."""
    spec = METRICS[metric]
    points = [(date, day_value(row, metric), row) for date, row in sorted(days.items())]
    points = [p for p in points if p[1] is not None]
    if metric == 'csi':
        points = [p for p in points if (p[2].get('csiSample') or 0) >= 5]
    if len(points) < 2 * MIN_SIDE + 3:
        return None
    values = [p[1] for p in points]
    best = None
    for k in range(MIN_SIDE, len(points) - MIN_SIDE + 1):
        before, after = values[:k], values[k:]
        mb, ma = mean(before), mean(after)
        noise = math.sqrt(variance(before, mb) / len(before) + variance(after, ma) / len(after)) or 1e-9
        score = abs(ma - mb) / noise
        if best is None or score > best[0]:
            best = (score, k, mb, ma)
    score, k, mb, ma = best
    tail = values[-MIN_SIDE:]
    if metric == 'csi':
        csi_b, sample_b = weighted_csi([p[2] for p in points[:k]])
        csi_a, sample_a = weighted_csi([p[2] for p in points[k:]])
        if csi_b is None or csi_a is None or min(sample_b, sample_a) < 100:
            return None
        delta = csi_a - csi_b
        persist = mean(tail) - csi_b
        if abs(delta) < .25 or score < 4 or persist * delta <= 0 or abs(persist) < .2:
            return None
        before_value, after_value, relative = csi_b, csi_a, None
        severity = 'high' if abs(delta) >= .4 else 'medium'
    else:
        if mb < spec['floor'] and ma < spec['floor']:
            return None
        base = max(mb, 1e-9)
        relative = (ma - mb) / base
        persist = (mean(tail) - mb) / base
        if abs(relative) < .25 or score < 5 or persist * relative <= 0 or abs(persist) < .2:
            return None
        before_value, after_value, delta = mb, ma, ma - mb
        severity = 'high' if abs(relative) >= .4 else 'medium'
    return {
        'metric': metric, 'label': spec['label'], 'unit': spec['unit'],
        'date': points[k][0], 'lastBefore': points[k - 1][0],
        'before': round(before_value, 4), 'after': round(after_value, 4), 'delta': round(delta, 4),
        'relative': round(relative * 100, 1) if relative is not None else None,
        'direction': 'down' if delta < 0 else 'up', 'score': round(score, 1), 'severity': severity,
        'daysBefore': k, 'daysAfter': len(points) - k,
        'series': [[p[0], round(p[1], 3)] for p in points],
    }


# --------------------------------------------------------------- the core ---

class Pulse:
    def __init__(self, engine):
        self.engine = engine
        self.root = Path(engine.root)
        self.db = engine.store.connect
        self.lock = threading.RLock()
        self.computing = False
        self.error = None
        self.stop_event = threading.Event()
        self.thread = None
        self.local = threading.local()
        self.jobs = {}
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS pulse_briefs(revision TEXT PRIMARY KEY, created TEXT NOT NULL, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS pulse_notes(id TEXT PRIMARY KEY, created TEXT NOT NULL, document TEXT NOT NULL);
            ''')

    # -- settings ---------------------------------------------------------
    @property
    def settings_path(self):
        return self.root / '.local-data' / 'pulse-settings.json'

    def settings(self):
        try:
            value = json.loads(self.settings_path.read_text(encoding='utf-8'))
            return {'autoNarrate': value.get('autoNarrate') is True}
        except (OSError, ValueError, AttributeError):
            return {'autoNarrate': False}

    def save_settings(self, request):
        from data_trust import atomic_json
        value = request.get('autoNarrate')
        if type(value) is not bool:
            raise ValueError('Укажите, готовить ли AI-резюме заранее.')
        atomic_json(self.settings_path, {'autoNarrate': value})
        return self.settings()

    def model_ready(self):
        from gigachat_bridge import cli_status
        return bool(cli_status(self.root).get('configured'))

    # -- data access ------------------------------------------------------
    def snapshot(self):
        engine = self.engine
        with engine.lock:
            state, status = engine.refresh()
            revision = engine.document.get('revision')
        if status.get('error'):
            raise ValueError(status['error'])
        return state, revision

    def surveys(self, state, channel=None, ident=None, product=None):
        result = []
        for survey in state['surveys']:
            meta = survey['meta']
            if channel and meta['channel'] != channel:
                continue
            if ident is not None and survey['event']['id'] != ident:
                continue
            if product and product.casefold() not in {p.casefold() for p in meta.get('products', [])}:
                continue
            result.append(survey)
        return result

    def daily(self, revision, keys, start, end):
        if not revision or not keys:
            return []
        return self.engine.store.feedback_days(revision, start, end, POLICY, keys)

    def last_day(self, revision, keys):
        return self.engine.store.last_daily(revision, keys) if revision and keys else None

    # -- level shifts -----------------------------------------------------
    def shifts(self, state, revision, channel=None, ident=None):
        found = []
        for current in ([channel] if channel else CHANNELS):
            selected = self.surveys(state, current, ident)
            keys = [(current, s['event']['id']) for s in selected]
            latest = self.last_day(revision, keys)
            if not latest:
                continue
            end = dt.date.fromisoformat(latest)
            rows = self.daily(revision, keys, (end - dt.timedelta(days=WINDOW_DAYS - 1)).isoformat(), latest)
            grouped = series_by_survey(rows)
            meta = {s['event']['id']: s['meta'] for s in selected}
            for (ch, sid), days in grouped.items():
                for metric in ('sends', 'answers', 'csi'):
                    shift = detect_shift(days, metric)
                    if not shift:
                        continue
                    info = meta.get(sid, {})
                    shift.update(
                        key=f'shift:{ch}:{sid}:{metric}:{shift["direction"]}', channel=ch, channelLabel=CHANNEL_LABELS[ch],
                        id=sid, name=info.get('name', 'Опрос ' + str(sid)), products=info.get('products', []),
                        through=latest,
                        hiddenFromWeekly=dt.date.fromisoformat(shift['date']) <= end - dt.timedelta(days=13))
                    found.append(shift)
        found.sort(key=lambda s: (s['direction'] != 'down', s['severity'] != 'high',
                                  -(abs(s['relative']) if s['relative'] is not None else abs(s['delta']) * 100)))
        return found

    @staticmethod
    def clusters(shifts):
        """Объединяет однотипные сдвиги разных опросов в пределах ±2 дней."""
        groups = []
        for shift in sorted(shifts, key=lambda s: s['date']):
            date = dt.date.fromisoformat(shift['date'])
            for group in groups:
                if group['metric'] == shift['metric'] and group['direction'] == shift['direction'] \
                        and group['channel'] == shift['channel'] and abs((date - group['_anchor']).days) <= 2:
                    group['members'].append(shift)
                    break
            else:
                groups.append({'metric': shift['metric'], 'direction': shift['direction'], 'channel': shift['channel'],
                               '_anchor': date, 'members': [shift]})
        result = []
        for group in groups:
            members = group['members']
            if len({m['id'] for m in members}) < 2:
                continue
            dates = sorted(m['date'] for m in members)
            products = defaultdict(int)
            for member in members:
                for product in member['products'] or ['без продукта']:
                    products[product] += 1
            label = METRICS[group['metric']]['label']
            result.append({
                'key': 'cluster:' + group['channel'] + ':' + group['metric'] + ':' + group['direction'] + ':' + dates[0],
                'metric': group['metric'], 'label': label, 'direction': group['direction'], 'channel': group['channel'],
                'channelLabel': CHANNEL_LABELS[group['channel']], 'from': dates[0], 'to': dates[-1],
                'members': [{'id': m['id'], 'name': m['name'], 'date': m['date'], 'relative': m['relative'],
                             'delta': m['delta'], 'products': m['products']} for m in members],
                'products': sorted(products.items(), key=lambda kv: -kv[1]),
                'title': ('Групповое снижение' if group['direction'] == 'down' else 'Групповой рост') + ': ' + label.lower()
                         + ' у ' + str(len(members)) + ' опросов',
                'hint': 'Одновременное изменение у нескольких опросов чаще указывает на общую причину '
                        '(стоп-лист, загрузка, интеграция), чем на независимые инциденты. Это гипотеза для проверки.',
            })
        result.sort(key=lambda c: (c['direction'] != 'down', -len(c['members'])))
        return result

    # -- weekly KPIs ------------------------------------------------------
    def kpis(self, state, revision):
        output = []
        for channel in CHANNELS:
            keys = [(channel, s['event']['id']) for s in self.surveys(state, channel)]
            latest = self.last_day(revision, keys)
            if not latest:
                continue
            end = dt.date.fromisoformat(latest)
            rows = self.daily(revision, keys, (end - dt.timedelta(days=13)).isoformat(), latest)
            cut = (end - dt.timedelta(days=6)).isoformat()
            windows = [[r for r in rows if r['date'] < cut], [r for r in rows if r['date'] >= cut]]
            values = []
            for part in windows:
                sends = sum(r['sends'] or 0 for r in part)
                answers = sum(r['answers'] or 0 for r in part)
                csi, sample = weighted_csi(part)
                values.append({'sends': sends, 'answers': answers, 'responseRate': answers / sends * 100 if sends else None,
                               'csi': csi, 'csiSample': sample, 'days': len({r['date'] for r in part})})
            output.append({'channel': channel, 'label': CHANNEL_LABELS[channel], 'through': latest,
                           'baseline': values[0], 'current': values[1],
                           'window': [(end - dt.timedelta(days=6)).isoformat(), latest]})
        return output

    # -- brief ------------------------------------------------------------
    def compute_brief(self):
        state, revision = self.snapshot()
        if not revision or not state['surveys']:
            return {'revision': revision, 'empty': True, 'generatedAt': now(), 'version': VERSION}
        signals = []
        for channel in CHANNELS:
            try:
                monitor = self.engine.committee.monitor({'channel': channel, 'survey': None, 'product': '', 'top': False, 'topProducts': False})
            except ValueError:
                continue
            for signal in monitor.get('signals', []):
                signals.append({'key': 'signal:' + channel + ':' + str(signal['id']), 'id': signal['id'], 'name': signal['name'],
                                'channel': channel, 'channelLabel': CHANNEL_LABELS[channel], 'severity': signal['severity'],
                                'reasons': signal['reasons'], 'through': signal['through'],
                                'answers': [signal['baseline'].get('answers'), signal['current'].get('answers')],
                                'sendShare': [signal['baseline'].get('sendShare'), signal['current'].get('sendShare')]})
        shifts = self.shifts(state, revision)
        clusters = self.clusters(shifts)
        for shift in shifts:
            shift['memory'] = self.recall(shift)
        brief = {'version': VERSION, 'revision': revision, 'generatedAt': now(), 'empty': False,
                 'kpis': self.kpis(state, revision), 'signals': signals, 'shifts': shifts[:60], 'shiftTotal': len(shifts),
                 'clusters': clusters[:12], 'narrative': None}
        previous = self.previous_brief(revision)
        brief['changes'] = self.diff(previous, brief) if previous else None
        brief['previousAt'] = previous.get('generatedAt') if previous else None
        return brief

    def previous_brief(self, revision):
        with self.db() as db:
            row = db.execute('SELECT document FROM pulse_briefs WHERE revision<>? ORDER BY created DESC LIMIT 1', (revision,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def diff(previous, current):
        def index(brief):
            items = {}
            for signal in brief.get('signals', []):
                items[signal['key']] = {'title': '#' + str(signal['id']) + ' · ' + signal['name'], 'kind': 'Сигнал мониторинга',
                                        'detail': ' · '.join(signal['reasons']), 'rank': 2 if signal['severity'] == 'urgent' else 1}
            for shift in brief.get('shifts', []):
                size = abs(shift['relative']) if shift['relative'] is not None else abs(shift['delta']) * 100
                items[shift['key']] = {'title': '#' + str(shift['id']) + ' · ' + shift['name'], 'kind': 'Сдвиг уровня · ' + shift['label'],
                                       'detail': shift_sentence(shift), 'rank': 2 if shift['severity'] == 'high' else 1, 'size': size}
            return items
        old, new = index(previous), index(current)
        added = [dict(new[k], key=k) for k in new.keys() - old.keys()]
        resolved = [dict(old[k], key=k) for k in old.keys() - new.keys()]
        worse = [dict(new[k], key=k) for k in new.keys() & old.keys()
                 if new[k]['rank'] > old[k]['rank'] or new[k].get('size', 0) > old[k].get('size', 0) + 10]
        order = lambda rows: sorted(rows, key=lambda r: (-r['rank'], r['title']))
        return {'added': order(added)[:30], 'resolved': order(resolved)[:30], 'worse': order(worse)[:30],
                'counts': {'added': len(added), 'resolved': len(resolved), 'worse': len(worse)}}

    def store_brief(self, brief):
        if not brief.get('revision'):
            return
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO pulse_briefs VALUES(?,?,?)',
                       (brief['revision'], brief['generatedAt'], json.dumps(brief, ensure_ascii=False, allow_nan=False)))
            db.execute('DELETE FROM pulse_briefs WHERE revision NOT IN (SELECT revision FROM pulse_briefs ORDER BY created DESC LIMIT 10)')

    def cached_brief(self, revision):
        with self.db() as db:
            row = db.execute('SELECT document FROM pulse_briefs WHERE revision=?', (revision,)).fetchone()
        return json.loads(row[0]) if row else None

    def ensure_brief(self, force=False):
        with self.lock:
            _, revision = self.snapshot()
            brief = None if force else self.cached_brief(revision)
            if brief is None:
                self.computing = True
                try:
                    brief = self.compute_brief()
                    if force:
                        old = self.cached_brief(revision)
                        if old and old.get('narrative'):
                            brief['narrative'] = old['narrative']
                    self.store_brief(brief)
                    self.error = None
                finally:
                    self.computing = False
            return brief

    def brief_response(self, force=False):
        brief = self.ensure_brief(force)
        demo = self.demo()
        return dict(brief, settings=self.settings(), modelReady=self.model_ready(), demo=bool(demo), demoStories=(demo or {}).get('stories'))

    # -- background preparation --------------------------------------------
    def start(self, interval=30):
        if self.thread:
            return

        def loop():
            try:
                self.demo_seed()
            except Exception as error:
                self.error = str(error)
            while not self.stop_event.is_set():
                try:
                    brief = self.ensure_brief()
                    if self.settings()['autoNarrate'] and not brief.get('empty') and not brief.get('narrative') and self.model_ready():
                        try:
                            self.narrate({})
                        except Exception as error:  # модель недоступна — бриф остаётся без резюме
                            self.error = 'AI-резюме не подготовлено: ' + str(error)
                except Exception as error:
                    self.error = str(error)
                self.stop_event.wait(interval)

        self.thread = threading.Thread(target=loop, name='pulse-brief', daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()

    # -- model helpers ----------------------------------------------------
    def call_model(self, stage, instructions, payload, query):
        if not self.model_ready():
            raise ValueError('GigaCode CLI не настроена. Подключите её через START_GIGACODE.cmd или используйте локальный расчёт.')
        from model_client import call_json
        return call_json(self.root, instructions, payload, stage, query, None, threading.Event())

    @staticmethod
    def check_text(text, facts, label):
        if not isinstance(text, str) or not text.strip() or len(text) > 600:
            raise ValueError(label + ': модель вернула пустой или слишком длинный текст.')
        allowed = set()
        for value in facts_numbers(facts):
            allowed.add(value)
        for token in NUMBER.findall(text):
            if normalise_number(token) not in allowed:
                raise ValueError(label + ': модель добавила число «' + token + '», которого нет в фактах. Ответ отклонён.')
        return text.strip()

    def narrate(self, request):
        return self.with_fallback(lambda: self.narrate_live(request), self.narrate_canned)

    def narrate_canned(self):
        brief = self.ensure_brief()
        if brief.get('empty'):
            raise ValueError('Нет данных для резюме.')
        facts = brief_facts(brief)
        narrative = canned_narrative(brief, facts)
        narrative.update(facts=facts, generatedAt=now(), revision=brief['revision'],
                         trust={'facts': len(facts), 'refs': sum(len(b['refs']) for b in narrative['bullets']), 'rejected': 0})
        self.save_narrative(brief['revision'], narrative)
        return narrative

    def save_narrative(self, revision, narrative):
        with self.lock:
            current = self.cached_brief(revision)
            if current:
                current['narrative'] = narrative
                self.store_brief(current)

    def narrate_live(self, request):
        brief = self.ensure_brief()
        if brief.get('empty'):
            raise ValueError('Нет данных для резюме.')
        facts = brief_facts(brief)
        self.stage('Отправляю факты в GigaCode')
        result = self.call_model('pulse-brief',
            'Ты аналитик мониторинга опросов. По facts составь утреннее резюме руководителю на русском языке. '
            'Верни один JSON {"headline":"...","bullets":[{"text":"...","refs":["F1"]}]}: headline до 160 символов, '
            'от 2 до 5 bullets до 220 символов, в каждом refs — ссылки на использованные факты. '
            'Используй только числа из facts, ничего не вычисляй, не утверждай причины — только гипотезы для проверки.',
            {'facts': facts}, 'Утреннее резюме')
        self.stage('Проверяю ссылки и числа по фактам')
        refs = {f['ref'] for f in facts}
        if not isinstance(result, dict) or set(result) - {'headline', 'bullets'} or not isinstance(result.get('bullets'), list) or not 1 <= len(result['bullets']) <= 6:
            raise ValueError('Ответ модели не соответствует формату резюме.')
        bullets = []
        for bullet in result['bullets']:
            if not isinstance(bullet, dict) or not isinstance(bullet.get('refs'), list) or not bullet['refs'] or any(r not in refs for r in bullet['refs']):
                raise ValueError('Модель сослалась на несуществующий факт. Резюме отклонено.')
            used = [f for f in facts if f['ref'] in bullet['refs']]
            bullets.append({'text': self.check_text(bullet.get('text'), used, 'Пункт резюме'), 'refs': bullet['refs']})
        narrative = {'headline': self.check_text(result.get('headline'), facts, 'Заголовок резюме'), 'bullets': bullets,
                     'facts': facts, 'generatedAt': now(), 'revision': brief['revision'],
                     'source': 'GigaCode CLI · числа проверены по фактам',
                     'trust': {'facts': len(facts), 'refs': sum(len(b['refs']) for b in bullets), 'rejected': 0}}
        self.save_narrative(brief['revision'], narrative)
        return narrative

    def explain(self, request):
        state, revision = self.snapshot()
        channel, ident, metric = request.get('channel'), request.get('id'), request.get('metric')
        if channel not in CHANNELS or type(ident) is not int or metric not in METRICS:
            raise ValueError('Выберите сдвиг для объяснения.')
        shift = next((s for s in self.shifts(state, revision, channel, ident) if s['metric'] == metric), None)
        if not shift:
            raise ValueError('Сдвиг больше не обнаруживается в текущей версии данных.')
        self.stage('Собираю факты по сдвигу')
        facts = shift_facts(self, state, revision, shift)
        notes = self.recall(shift)
        options = [{'id': 'C' + str(i + 1), 'label': label, 'refs': refs} for i, (label, refs) in enumerate(check_options(facts))]
        return self.with_fallback(lambda: self.model_explain(facts, options, notes, 'Объяснить сдвиг #' + str(ident)),
                                  lambda: canned_explain(facts, options, notes))

    def explain_local(self, request):
        state, revision = self.snapshot()
        channel, ident, metric = request.get('channel'), request.get('id'), request.get('metric')
        if channel not in CHANNELS or type(ident) is not int or metric not in METRICS:
            raise ValueError('Выберите сдвиг для объяснения.')
        shift = next((s for s in self.shifts(state, revision, channel, ident) if s['metric'] == metric), None)
        if not shift:
            raise ValueError('Сдвиг больше не обнаруживается в текущей версии данных.')
        facts = shift_facts(self, state, revision, shift)
        return {'facts': facts, 'checks': [{'id': 'C' + str(i + 1), 'label': label, 'refs': refs} for i, (label, refs) in enumerate(check_options(facts))],
                'source': 'Локальный расчёт без модели'}

    # -- similar ------------------------------------------------------------
    def similar(self, request):
        state, revision = self.snapshot()
        channel, ident, metric, date = request.get('channel'), request.get('id'), request.get('metric'), request.get('date')
        if channel not in CHANNELS or metric not in METRICS or not isinstance(date, str):
            raise ValueError('Выберите опрос, показатель и дату.')
        anchor = dt.date.fromisoformat(date[:10])
        selected = self.surveys(state, channel)
        keys = [(channel, s['event']['id']) for s in selected]
        rows = self.daily(revision, keys, (anchor - dt.timedelta(days=14)).isoformat(), (anchor + dt.timedelta(days=13)).isoformat())
        grouped = series_by_survey(rows)
        meta = {s['event']['id']: s['meta'] for s in selected}
        reference = None
        output = []
        for (ch, sid), days in grouped.items():
            before = [d for k, d in days.items() if k < date]
            after = [d for k, d in days.items() if k >= date]
            if len(before) < 4 or len(after) < 4:
                continue
            if metric == 'csi':
                b, sb = weighted_csi(before)
                a, sa = weighted_csi(after)
                if b is None or a is None or min(sb, sa) < 50:
                    continue
                change, relative = a - b, None
            else:
                b = mean([day_value(d, metric) or 0 for d in before])
                a = mean([day_value(d, metric) or 0 for d in after])
                if b < METRICS[metric]['floor']:
                    continue
                change, relative = a - b, (a - b) / b * 100
            row = {'id': sid, 'name': meta.get(sid, {}).get('name', str(sid)), 'products': meta.get(sid, {}).get('products', []),
                   'before': round(b, 3), 'after': round(a, 3), 'delta': round(change, 3),
                   'relative': round(relative, 1) if relative is not None else None}
            if sid == ident:
                reference = row
            else:
                output.append(row)
        if reference is None:
            raise ValueError('У выбранного опроса недостаточно дней вокруг даты для сравнения.')
        sign = 1 if reference['delta'] > 0 else -1
        threshold = .2 if metric != 'csi' else .2
        matches = [r for r in output if r['delta'] * sign > 0 and
                   ((abs(r['relative']) >= threshold * 100) if r['relative'] is not None else abs(r['delta']) >= threshold)]
        matches.sort(key=lambda r: -(abs(r['relative']) if r['relative'] is not None else abs(r['delta']) * 100))
        products = defaultdict(int)
        for row in matches:
            for product in row['products'] or ['без продукта']:
                products[product] += 1
        return {'reference': reference, 'matches': matches[:30], 'total': len(matches), 'compared': len(output) + 1,
                'metric': metric, 'label': METRICS[metric]['label'], 'date': date, 'channel': channel,
                'products': sorted(products.items(), key=lambda kv: -kv[1]),
                'window': 'до 14 дней до и после ' + date + '; пропуски не считаются нулями'}

    # -- what if --------------------------------------------------------------
    def whatif(self, request):
        state, revision = self.snapshot()
        channel = request.get('channel') or 'communication'
        if channel not in CHANNELS:
            raise ValueError('Выберите канал.')
        ident = request.get('id')
        if ident is not None and (type(ident) is not int or not 1 <= ident <= 9999999):
            raise ValueError('Некорректный номер опроса.')
        product = clean_text(request.get('product'), 'Продукт', 200) or None
        selected = self.surveys(state, channel, ident, product)
        if not selected:
            raise ValueError('Нет опросов по выбранному отбору в канале «' + CHANNEL_LABELS[channel] + '».')
        keys = [(channel, s['event']['id']) for s in selected]
        latest = self.last_day(revision, keys)
        if not latest:
            raise ValueError('Для прогноза нужны дневные строки выбранных опросов.')
        end = dt.date.fromisoformat(latest)
        month_start = end.replace(day=1)
        month_days = calendar.monthrange(end.year, end.month)[1]
        remaining = month_days - end.day
        rows = self.daily(revision, keys, min(month_start, end - dt.timedelta(days=13)).isoformat(), latest)
        mtd = [r for r in rows if r['date'] >= month_start.isoformat()]
        recent = [r for r in rows if r['date'] >= (end - dt.timedelta(days=13)).isoformat()]
        last7 = sorted({r['date'] for r in recent})[-7:]
        sends_by_day = defaultdict(float)
        for row in recent:
            if row['date'] in last7:
                sends_by_day[row['date']] += row['sends'] or 0
        base_sends = mean(list(sends_by_day.values())) or 0.0
        recent_sends = sum(r['sends'] or 0 for r in recent)
        base_rate = sum(r['answers'] or 0 for r in recent) / recent_sends * 100 if recent_sends else None
        answers_mtd = sum(r['answers'] or 0 for r in mtd)
        plans = [s['meta'].get('plan') for s in selected]
        reference_plan = sum(p for p in plans if p) if any(plans) else None
        plan = number_or_none(request.get('plan'), 'План ответов на месяц', 1, 1e9) or reference_plan
        rate = number_or_none(request.get('responseRate'), 'Отклик', 0.01, 100)
        sends = number_or_none(request.get('sendsPerDay'), 'Отправки в день', 0, 1e9)
        change = number_or_none(request.get('sendsChangePct'), 'Изменение отправок', -100, 1000)
        scenario_rate = rate if rate is not None else base_rate
        scenario_sends = sends if sends is not None else base_sends * (1 + (change or 0) / 100)
        if scenario_rate is None:
            raise ValueError('Нет отправок за последние 14 дней: задайте отклик вручную.')
        daily_answers = scenario_sends * scenario_rate / 100
        forecast = answers_mtd + remaining * daily_answers
        baseline_forecast = answers_mtd + remaining * base_sends * (base_rate or 0) / 100
        required_sends = required_rate = None
        if plan and remaining:
            gap = max(plan - answers_mtd, 0)
            required_sends = gap / remaining / (scenario_rate / 100) if scenario_rate else None
            required_rate = gap / remaining / scenario_sends * 100 if scenario_sends else None
        cumulative, total = [], 0
        answers_day = defaultdict(float)
        for row in mtd:
            answers_day[row['date']] += row['answers'] or 0
        for day in range(1, end.day + 1):
            date = end.replace(day=day).isoformat()
            if date in answers_day:
                total += answers_day[date]
                cumulative.append([date, round(total, 1)])
        projection = [[end.isoformat(), round(answers_mtd, 1)]] + [
            [end.replace(day=day).isoformat(), round(answers_mtd + (day - end.day) * daily_answers, 1)] for day in range(end.day + 1, month_days + 1)]
        plan_line = [[month_start.replace(day=day).isoformat(), round(plan * day / month_days, 1)] for day in range(1, month_days + 1)] if plan else []
        verdict = None
        if plan:
            verdict = 'План будет выполнен' if forecast >= plan else 'План не будет выполнен'
        return {'scope': {'channel': channel, 'channelLabel': CHANNEL_LABELS[channel], 'id': ident, 'product': product,
                          'surveys': len(selected), 'names': [s['meta']['name'] for s in selected[:6]]},
                'through': latest, 'month': end.strftime('%Y-%m'), 'monthDays': month_days, 'remainingDays': remaining,
                'answersToDate': answers_mtd, 'plan': plan, 'planSource': 'сценарий' if request.get('plan') else 'справочник' if plan else None,
                'baseline': {'sendsPerDay': base_sends, 'responseRate': base_rate, 'forecast': baseline_forecast},
                'scenario': {'sendsPerDay': scenario_sends, 'responseRate': scenario_rate, 'answersPerDay': daily_answers, 'forecast': forecast},
                'requiredSendsPerDay': required_sends, 'requiredResponseRate': required_rate, 'verdict': verdict,
                'completion': forecast / plan * 100 if plan else None,
                'series': {'actual': cumulative, 'projection': projection, 'plan': plan_line},
                'method': 'База — средние отправки за последние 7 дней с данными и отклик за 14 дней. Прогноз = ответы с начала месяца + '
                          'оставшиеся календарные дни × отправки в день × отклик. План распределён по календарным дням. Пропуски не считаются нулями.'}

    def whatif_parse(self, request):
        query = clean_text(request.get('query'), 'Вопрос', 400, True)
        state, _ = self.snapshot()
        parsed = parse_whatif(query, state)
        parsed['source'] = 'Локальный разбор'
        if parsed['understood'] or not request.get('useModel') or not self.model_ready():
            return parsed
        products = sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=str.casefold)[:60]
        result = self.call_model('pulse-whatif',
            'Переведи вопрос «что если» в параметры сценария. Верни один JSON {"id":null|int,"product":null|"...","channel":"communication"|"success_screen",'
            '"responseRate":null|number,"sendsPerDay":null|number,"sendsChangePct":null|number,"plan":null|number}. '
            'product выбирай только из products. Ничего не вычисляй.',
            {'userQuery': query, 'products': products}, query)
        allowed = {'id', 'product', 'channel', 'responseRate', 'sendsPerDay', 'sendsChangePct', 'plan'}
        if not isinstance(result, dict) or set(result) - allowed:
            raise ValueError('Ответ модели не соответствует формату сценария.')
        if result.get('product') is not None and result['product'] not in products:
            raise ValueError('Модель выбрала продукт, которого нет в справочнике.')
        if result.get('channel') not in (None, *CHANNELS):
            raise ValueError('Модель выбрала неизвестный канал.')
        params = {k: result.get(k) for k in allowed}
        params['channel'] = params['channel'] or 'communication'
        return {'params': params, 'understood': True, 'source': 'GigaCode CLI · параметры проверены', 'notes': []}

    # -- memory -----------------------------------------------------------
    def notes(self, request=None):
        with self.db() as db:
            rows = db.execute('SELECT document FROM pulse_notes ORDER BY created DESC LIMIT 500').fetchall()
        items = [json.loads(r[0]) for r in rows]
        ident = (request or {}).get('id')
        if type(ident) is int:
            items = [n for n in items if n.get('surveyId') == ident]
        return {'notes': items}

    def add_note(self, request):
        metric = request.get('metric')
        if metric not in (*METRICS, 'responseRate', 'other'):
            metric = 'other'
        ident = request.get('surveyId')
        if ident is not None and (type(ident) is not int or not 1 <= ident <= 9999999):
            raise ValueError('Некорректный номер опроса.')
        direction = request.get('direction') if request.get('direction') in ('up', 'down') else None
        channel = request.get('channel') if request.get('channel') in CHANNELS else None
        date = request.get('date')
        if date:
            dt.date.fromisoformat(clean_text(date, 'Дата', 10))
        note = {'id': uuid.uuid4().hex, 'created': now(), 'author': clean_text(request.get('author'), 'Автор', 80),
                'surveyId': ident, 'channel': channel, 'metric': metric, 'direction': direction, 'date': date or None,
                'products': [clean_text(p, 'Продукт', 200) for p in (request.get('products') or [])[:10]],
                'title': clean_text(request.get('title'), 'Заголовок', 160, True),
                'cause': clean_text(request.get('cause'), 'Причина', 1000, True),
                'action': clean_text(request.get('resolution'), 'Что помогло', 1000)}
        with self.db() as db:
            db.execute('INSERT INTO pulse_notes VALUES(?,?,?)', (note['id'], note['created'], json.dumps(note, ensure_ascii=False)))
        self.refresh_memory()
        return note

    def delete_note(self, request):
        ident = request.get('noteId')
        if not isinstance(ident, str) or not re.fullmatch(r'[0-9a-f]{32}', ident):
            raise ValueError('Запись не найдена.')
        with self.db() as db:
            db.execute('DELETE FROM pulse_notes WHERE id=?', (ident,))
        self.refresh_memory()
        return {'deleted': ident}

    def refresh_memory(self):
        with self.lock:
            try:
                _, revision = self.snapshot()
            except ValueError:
                return
            brief = self.cached_brief(revision)
            if brief and not brief.get('empty'):
                for shift in brief.get('shifts', []):
                    shift['memory'] = self.recall(shift)
                self.store_brief(brief)

    def recall(self, shift):
        scored = []
        products = {p.casefold() for p in shift.get('products', [])}
        for note in self.notes()['notes']:
            if note.get('direction') and shift.get('direction') and note['direction'] != shift['direction']:
                continue
            score = 0
            if note.get('surveyId') == shift.get('id'):
                score += 3
            if note.get('metric') == shift.get('metric'):
                score += 2
            if note.get('direction') and note.get('direction') == shift.get('direction'):
                score += 1
            if products & {p.casefold() for p in note.get('products', [])}:
                score += 2
            if score >= 4:
                scored.append((score, note))
        scored.sort(key=lambda pair: pair[1]['created'], reverse=True)
        scored.sort(key=lambda pair: -pair[0])
        return [dict(note, match=score) for score, note in scored[:3]]

    # -- meeting -------------------------------------------------------------
    def meeting(self, request):
        brief = self.ensure_brief()
        if brief.get('empty'):
            raise ValueError('Нет данных для встречи.')
        product = clean_text(request.get('product'), 'Продукт', 200) or None

        def keep(products):
            return not product or product.casefold() in {p.casefold() for p in products}

        slides = []
        seen_groups = set()
        for cluster in brief.get('clusters', []):
            members = [m for m in cluster['members'] if keep(m['products'])]
            group = (cluster['channel'], cluster['direction'], frozenset(m['id'] for m in members))
            if len(members) < 2 or group in seen_groups:
                continue
            seen_groups.add(group)
            slides.append({'kind': 'cluster', 'title': cluster['title'],
                           'subtitle': cluster['channelLabel'] + ' · ' + cluster['from'] + (' — ' + cluster['to'] if cluster['to'] != cluster['from'] else ''),
                           'kpis': [['Опросов', str(len(members))],
                                    ['Продукты', ', '.join(p for p, _ in cluster['products'][:3])]],
                           'bullets': ['#' + str(m['id']) + ' · ' + m['name'] + ' · ' + change_label(m) + ' с ' + m['date'] for m in members[:6]],
                           'conclusion': 'Проверить общую причину: стоп-листы, интеграции, загрузку данных за ' + cluster['from'] + '.',
                           'series': None})
        by_survey = {}
        for shift in brief.get('shifts', []):
            if shift['direction'] != 'down' or not keep(shift['products']):
                continue
            by_survey.setdefault((shift['channel'], shift['id']), []).append(shift)
        for group in by_survey.values():
            shift = group[0]
            memory = next((s['memory'] for s in group if s.get('memory')), [])
            slides.append({'kind': 'shift', 'title': '#' + str(shift['id']) + ' · ' + shift['name'],
                           'subtitle': shift['channelLabel'] + ' · устойчивое снижение: ' + ', '.join(s['label'].lower() for s in group) + ' с ' + shift['date'],
                           'kpis': [[shift['label'] + ' до', fmt_value(shift['before'], shift['metric'])], [shift['label'] + ' после', fmt_value(shift['after'], shift['metric'])],
                                    ['Изменение', change_label(shift)]],
                           'bullets': [shift_sentence(s) for s in group]
                                      + (['Недельный мониторинг этот сдвиг уже не показывает: он старше сравниваемых недель.'] if shift['hiddenFromWeekly'] else [])
                                      + ['Похожий прошлый случай: ' + n['title'] + ' — ' + n['cause'] for n in memory[:1]],
                           'conclusion': 'Назначить проверку и записать вывод в память расследований.',
                           'series': shift['series'], 'metric': shift['metric'], 'marker': shift['date']})
        for signal in brief.get('signals', []):
            if signal['severity'] != 'urgent':
                continue
            slides.append({'kind': 'signal', 'title': '#' + str(signal['id']) + ' · ' + signal['name'],
                           'subtitle': signal['channelLabel'] + ' · срочный сигнал по ' + signal['through'],
                           'kpis': [], 'bullets': signal['reasons'], 'conclusion': 'Проверить запуск коммуникаций сегодня.', 'series': None})
        limit = request.get('limit', 5)
        if type(limit) is not int or not 1 <= limit <= 10:
            limit = 5
        slides = slides[:limit]
        kpi_lines = []
        for kpi in brief.get('kpis', []):
            kpi_lines.append([kpi['label'] + ' · ответы за 7 дней', fmt_int(kpi['current']['answers']) + ' (' + pct_change(kpi['baseline']['answers'], kpi['current']['answers']) + ')'])
        cover = {'kind': 'cover', 'title': 'Мониторинг опросов' + (' · ' + product if product else ''),
                 'subtitle': 'Данные по ' + max((k['through'] for k in brief.get('kpis', [])), default='—') + ' · версия ' + str(brief['revision'])[:8],
                 'kpis': kpi_lines, 'bullets': ['Тем для обсуждения: ' + str(len(slides))]
                 + ([brief['narrative']['headline']] if brief.get('narrative') else []),
                 'conclusion': '', 'series': None}
        return {'slides': [cover] + slides, 'revision': brief['revision'], 'product': product,
                'note': 'Черновик собран из сигналов пульса. Тексты можно править перед выгрузкой; числа взяты из локального расчёта.'}

    # -- upload --------------------------------------------------------------
    def upload(self, request):
        name = request.get('name')
        if name not in UPLOADS:
            raise ValueError('Выберите файл push-sms.csv, success-screen.csv или products.csv.')
        content = request.get('content')
        if not isinstance(content, str) or not content.strip():
            raise ValueError('Файл пустой.')
        text = content.lstrip('﻿')
        header = text.splitlines()[0] if text else ''
        delimiter = max(';,\t', key=header.count)
        columns = [c.strip().strip('"') for c in header.split(delimiter)]
        expected = UPLOADS[name]
        if [c.casefold() for c in columns] != [c.casefold() for c in expected]:
            raise ValueError('Заголовок не совпадает с форматом ' + name + ': нужен «' + ';'.join(expected) + '», получен «' + header[:200] + '».')
        target = self.root / 'date' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.upload.tmp')
        temporary.write_text('﻿' + text, encoding='utf-8', newline='')
        temporary.replace(target)
        rows = max(len(text.splitlines()) - 1, 0)
        return {'saved': name, 'rows': rows, 'message': name + ' сохранён в папку date: строк ' + fmt_int(rows) + '.'}


    # -- demo mode ------------------------------------------------------------
    def demo(self):
        try:
            value = json.loads((self.root / '.local-data' / 'demo.json').read_text(encoding='utf-8'))
            return value if value.get('demo') is True else None
        except (OSError, ValueError, AttributeError):
            return None

    def demo_seed(self):
        """Календарь и память для демо-папки. Ничего не делает в рабочем проекте."""
        marker = self.demo()
        if not marker:
            return
        from demo_data import MEMORY, calendar_events
        try:
            existing = {e.get('title') for e in self.engine.workflows.list().get('events', [])}
            for event in calendar_events(marker):
                if event['title'] not in existing:
                    self.engine.workflows.save_event(event)
        except (ValueError, OSError, KeyError):
            pass
        if not self.notes()['notes']:
            for note in MEMORY:
                try:
                    self.add_note(dict(note))
                except ValueError:
                    pass

    def demo_reset(self, request):
        marker = self.demo()
        if not marker:
            raise ValueError('Сброс доступен только в демо-папке. Рабочие данные не изменены.')
        from demo_data import generate
        with self.engine.lock:
            generate(self.root, dt.date.fromisoformat(marker['anchor']))
            with self.db() as db:
                db.execute('DELETE FROM pulse_notes')
                db.execute('DELETE FROM pulse_briefs')
            self.settings_path.unlink(missing_ok=True)
        self.demo_seed()
        return self.brief_response(True)

    def stage(self, text):
        job = getattr(self.local, 'job', None)
        if job is not None:
            job['stages'].append({'text': text, 'at': round(time.monotonic() - job['started'], 2)})

    def with_fallback(self, live, canned):
        """В демо-папке при недоступной модели показывает сохранённый ответ с явной пометкой."""
        if not self.demo():
            return live()
        reason, rejected = 'модель не вызывалась', 0
        try:
            if self.model_ready():
                return live()
        except Exception as error:  # в демо показ не должен срываться из-за CLI
            rejected = 1 if 'отклон' in str(error).lower() else 0
            reason = ('ответ GigaCode не принят проверкой — ' if rejected else 'GigaCode недоступна — ') + str(error)[:160]
        for text in ('Отправляю факты в GigaCode', 'Проверяю ссылки и числа по фактам'):
            self.stage(text)
            time.sleep(.6)
        result = canned()
        result['source'] = 'Демо: сохранённый ответ, ' + reason
        result['canned'] = True
        if isinstance(result.get('trust'), dict):
            result['trust']['rejected'] = rejected
        return result

    # -- jobs: пошаговый статус --------------------------------------------------
    JOB_ACTIONS = ('explain', 'point', 'narrate', 'whatif-parse', 'route')

    def job_start(self, request):
        job_request = request.get('job')
        if not isinstance(job_request, dict) or job_request.get('action') not in self.JOB_ACTIONS:
            raise ValueError('Это действие не поддерживает пошаговый статус.')
        ident = uuid.uuid4().hex
        job = {'id': ident, 'stages': [], 'done': False, 'result': None, 'error': None, 'started': time.monotonic()}
        with self.lock:
            self.jobs = {k: v for k, v in getattr(self, 'jobs', {}).items() if time.monotonic() - v['started'] < 900}
            self.jobs[ident] = job

        def run():
            self.local.job = job
            try:
                self.stage('Понял запрос')
                job['result'] = self.action(job_request)
                self.stage('Готово')
            except (ValueError, TypeError, KeyError, OSError, IndexError) as error:
                job['error'] = str(error)
            except Exception as error:  # ошибки модели и CLI показываем пользователю как есть
                job['error'] = str(error) or error.__class__.__name__
            finally:
                job['done'] = True
        threading.Thread(target=run, name='pulse-job', daemon=True).start()
        return {'id': ident}

    def job_status(self, request):
        job = getattr(self, 'jobs', {}).get(request.get('id'))
        if not job:
            raise ValueError('Задача не найдена. Повторите запрос.')
        return {'id': job['id'], 'stages': job['stages'], 'done': job['done'], 'result': job['result'] if job['done'] else None,
                'error': job['error'], 'elapsed': round(time.monotonic() - job['started'], 1)}

    # -- compare ------------------------------------------------------------------
    def compare(self, request):
        state, revision = self.snapshot()
        metric = request.get('metric', 'answers')
        if metric not in ('sends', 'answers', 'events', 'csi', 'responseRate'):
            raise ValueError('Выберите показатель для сравнения.')
        days = request.get('days', 60)
        if days not in (14, 30, 60, 90):
            raise ValueError('Период: 14, 30, 60 или 90 дней.')
        items = request.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= 5:
            raise ValueError('Добавьте от одного до пяти объектов сравнения.')
        resolved = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError('Некорректный объект сравнения.')
            channel = item.get('channel') or 'communication'
            if channel not in CHANNELS:
                raise ValueError('Выберите канал.')
            ident, product = item.get('id'), clean_text(item.get('product'), 'Продукт', 200) or None
            if ident is not None and (type(ident) is not int or not 1 <= ident <= 9999999):
                raise ValueError('Некорректный номер опроса.')
            selected = self.surveys(state, channel, ident, product)
            if not selected:
                raise ValueError('Нет данных: ' + ('опрос #' + str(ident) if ident else product or CHANNEL_LABELS[channel]) + ' · ' + CHANNEL_LABELS[channel])
            label = ('#' + str(ident) + ' · ' + selected[0]['meta']['name']) if ident else (product or 'Все опросы · ' + CHANNEL_LABELS[channel])
            resolved.append({'label': label, 'channel': channel, 'id': ident, 'product': product,
                             'keys': [(channel, s['event']['id']) for s in selected], 'surveys': len(selected)})
        latest = max((self.last_day(revision, r['keys']) or '' for r in resolved), default='')
        if not latest:
            raise ValueError('Для сравнения нужны дневные строки.')
        end = dt.date.fromisoformat(latest)
        start = (end - dt.timedelta(days=days - 1)).isoformat()
        output = []
        for r in resolved:
            by_day = defaultdict(list)
            for row in self.daily(revision, r['keys'], start, latest):
                by_day[row['date']].append(row)
            series = []
            for date in sorted(by_day):
                value = aggregate(by_day[date], metric)
                if value is not None:
                    series.append([date, round(value, 3)])
            rows = [row for part in by_day.values() for row in part]
            cut = (end - dt.timedelta(days=6)).isoformat()
            prior_cut = (end - dt.timedelta(days=13)).isoformat()
            current = aggregate([x for x in rows if x['date'] >= cut], metric, True)
            previous = aggregate([x for x in rows if prior_cut <= x['date'] < cut], metric, True)
            if metric in ('csi', 'responseRate'):
                delta, relative = (current - previous if current is not None and previous is not None else None), None
            else:
                delta = current - previous if current is not None and previous is not None else None
                relative = (current - previous) / previous * 100 if previous else None
            dates = sorted(by_day)
            first = aggregate([x for x in rows if x['date'] in set(dates[:7])], metric, True)
            last = aggregate([x for x in rows if x['date'] in set(dates[-7:])], metric, True)
            if metric in ('csi', 'responseRate'):
                period_delta, period_relative = (last - first if last is not None and first is not None else None), None
            else:
                period_delta = last - first if last is not None and first is not None else None
                period_relative = (last - first) / first * 100 if first else None
            output.append({'label': r['label'], 'channel': r['channel'], 'id': r['id'], 'product': r['product'], 'surveys': r['surveys'],
                           'series': series, 'total': aggregate(rows, metric, True), 'current': current, 'previous': previous,
                           'delta': delta, 'relative': relative, 'periodDelta': period_delta, 'periodRelative': period_relative})
        ranked = [o for o in output if (o['periodRelative'] if o['periodRelative'] is not None else o['periodDelta']) is not None]
        conclusion = ''
        if ranked:
            key = lambda o: o['periodRelative'] if o['periodRelative'] is not None else o['periodDelta'] * 100
            show = lambda o: (signed_pct(o['periodRelative']) if o['periodRelative'] is not None else signed_num(o['periodDelta']))
            worst, best = min(ranked, key=key), max(ranked, key=key)
            span = 'За ' + str(days) + ' дней (последняя неделя к первой) '
            if len(ranked) == 1:
                conclusion = span + '«' + worst['label'] + '»: ' + show(worst) + '.'
            elif key(worst) < 0:
                conclusion = span + 'сильнее всего просел «' + worst['label'] + '» (' + show(worst) + '), лучше всех — «' + best['label'] + '» (' + show(best) + ').'
            else:
                conclusion = span + 'снижений нет: минимум у «' + worst['label'] + '» (' + show(worst) + '), максимум у «' + best['label'] + '» (' + show(best) + ').'
        return {'metric': metric, 'label': METRIC_LABELS[metric], 'days': days, 'from': start, 'to': latest, 'items': output,
                'conclusion': conclusion,
                'method': 'Дневные значения за ' + str(days) + ' дней по ' + latest + '. «За период» — последние 7 дней с данными к первым 7; «за неделю» — к предыдущим 7. Пропуски не считаются нулями.'}

    # -- point ----------------------------------------------------------------------
    def point_facts(self, state, revision, channel, ident, product, metric, date):
        selected = self.surveys(state, channel, ident, product)
        if not selected:
            raise ValueError('Нет данных по выбранному объекту.')
        keys = [(channel, s['event']['id']) for s in selected]
        anchor = dt.date.fromisoformat(date)
        rows = self.daily(revision, keys, (anchor - dt.timedelta(days=14)).isoformat(), date)
        today = [r for r in rows if r['date'] == date]
        if not today:
            raise ValueError('За ' + date + ' нет наблюдений.')
        week = [r for r in rows if (anchor - dt.timedelta(days=7)).isoformat() <= r['date'] < date]
        same_weekday = [r for r in rows if r['date'] == (anchor - dt.timedelta(days=7)).isoformat()]
        facts = []

        def add(label, value, unit='', period=''):
            if value is not None:
                facts.append({'ref': 'F' + str(len(facts) + 1), 'label': label, 'value': round(value, 2) if isinstance(value, float) else value, 'unit': unit, 'period': period})

        name = METRIC_LABELS[metric]
        value = aggregate(today, metric)
        base = aggregate(week, metric, False, True)
        add(name + ' за день', value, '', date)
        add(name + ': среднее за 7 предыдущих дней', base)
        if value is not None and base:
            if metric in ('csi', 'responseRate'):
                add('Изменение к среднему', signed_num(value - base))
            else:
                add('Изменение к среднему', signed_pct((value - base) / base * 100))
        add(name + ' в тот же день недели неделей раньше', aggregate(same_weekday, metric))
        if channel == 'communication':
            for key, label in (('events', 'События'), ('stop', 'Стоп-лист 1002'), ('contactPolicy', 'Политика контактов')):
                if key == metric:
                    continue
                now_value = aggregate(today, key)
                base_value = aggregate(week, key, False, True)
                if now_value is not None and base_value is not None:
                    add(label + ' за день', now_value, '', date)
                    add(label + ': среднее за 7 предыдущих дней', base_value)
        try:
            events = self.engine.workflows.list().get('events', [])
        except Exception:
            events = []
        ids = {k[1] for k in keys}
        for item in events[:300]:
            start, end = str(item.get('from') or '')[:10], str(item.get('to') or item.get('from') or '')[:10]
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', end):
                continue
            if item.get('ids') and not ids & set(item['ids']):
                continue
            if dt.date.fromisoformat(start) - dt.timedelta(days=3) <= anchor <= dt.date.fromisoformat(end) + dt.timedelta(days=3):
                add('Событие календаря запусков рядом с датой (совпадение — не доказательство причины)', str(item.get('title') or 'событие')[:120], '', start)
        return facts

    def point(self, request):
        state, revision = self.snapshot()
        channel, ident, metric, date = request.get('channel'), request.get('id'), request.get('metric'), request.get('date')
        product = clean_text(request.get('product'), 'Продукт', 200) or None
        if channel not in CHANNELS or metric not in METRIC_LABELS or not isinstance(date, str) or (ident is not None and type(ident) is not int):
            raise ValueError('Выберите точку на графике.')
        self.stage('Собираю факты за ' + date)
        facts = self.point_facts(state, revision, channel, ident, product, metric, date[:10])
        options = [{'id': 'C' + str(i + 1), 'label': label, 'refs': refs} for i, (label, refs) in enumerate(point_checks(facts))]
        base = {'facts': facts, 'checks': options, 'date': date[:10], 'source': 'Локальный расчёт без модели'}
        if not request.get('useModel'):
            return base
        query = 'Объяснить точку ' + date[:10]
        return self.with_fallback(lambda: self.model_explain(facts, options, [], query), lambda: canned_explain(facts, options))

    def model_explain(self, facts, options, notes, query):
        payload = {'facts': facts, 'options': options, 'memory': [{'title': n['title'], 'cause': n['cause']} for n in notes[:3]]}
        self.stage('Отправляю факты в GigaCode')
        result = self.call_model('pulse-explain',
            'Объясни изменение показателя опроса. Верни один JSON {"summary":"...","hypotheses":[{"text":"...","refs":["F1"]}],"checks":["C1"]}. '
            'summary до 300 символов, 1–3 hypotheses до 240 символов со ссылками refs на facts, checks — до трёх ID из options. '
            'Если в memory есть похожий прошлый случай, упомяни его как гипотезу. Используй только числа из facts. Причины — только гипотезы.',
            payload, query)
        self.stage('Проверяю ссылки и числа по фактам')
        refs = {f['ref'] for f in facts}
        allowed = {o['id']: o for o in options}
        if not isinstance(result, dict) or not isinstance(result.get('hypotheses'), list) or not isinstance(result.get('checks'), list):
            raise ValueError('Ответ модели не соответствует формату объяснения.')
        hypotheses = []
        for item in result['hypotheses'][:3]:
            if not isinstance(item, dict) or not isinstance(item.get('refs'), list) or not item['refs'] or any(r not in refs for r in item['refs']):
                raise ValueError('Модель сослалась на несуществующий факт. Объяснение отклонено.')
            hypotheses.append({'text': self.check_text(item.get('text'), [f for f in facts if f['ref'] in item['refs']], 'Гипотеза'), 'refs': item['refs']})
        checks = [allowed[c] for c in dict.fromkeys(result['checks']) if isinstance(c, str) and c in allowed][:3]
        return {'summary': self.check_text(result.get('summary'), facts, 'Объяснение'), 'hypotheses': hypotheses, 'checks': checks,
                'facts': facts, 'source': 'GigaCode CLI · проверено по фактам',
                'trust': {'facts': len(facts), 'refs': sum(len(h['refs']) for h in hypotheses), 'rejected': 0}}

    # -- dispatcher ------------------------------------------------------------
    def action(self, request):
        action = request.get('action')
        if action == 'brief':
            return self.brief_response(bool(request.get('force')))
        if action == 'settings':
            return self.save_settings(request)
        if action == 'narrate':
            return self.narrate(request)
        if action == 'explain':
            return self.explain(request) if request.get('useModel') else self.explain_local(request)
        if action == 'similar':
            return self.similar(request)
        if action == 'whatif':
            return self.whatif(request)
        if action == 'whatif-parse':
            return self.whatif_parse(request)
        if action == 'notes':
            return self.notes(request)
        if action == 'note-add':
            return self.add_note(request)
        if action == 'note-delete':
            return self.delete_note(request)
        if action == 'meeting':
            return self.meeting(request)
        if action == 'route':
            return self.route(request)
        if action == 'catalog':
            return self.catalog()
        if action == 'compare':
            return self.compare(request)
        if action == 'point':
            return self.point(request)
        if action == 'job-start':
            return self.job_start(request)
        if action == 'job-status':
            return self.job_status(request)
        if action == 'demo-reset':
            return self.demo_reset(request)
        raise ValueError('Неизвестное действие пульса.')

    def catalog(self):
        state, _ = self.snapshot()
        return {'surveys': [{'id': s['event']['id'], 'name': s['meta']['name'], 'channel': s['meta']['channel'],
                             'products': s['meta'].get('products', []), 'top': bool(s['event'].get('isTop'))} for s in state['surveys']],
                'products': sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=str.casefold)}

    def route(self, request):
        query = clean_text(request.get('query'), 'Запрос', 400, True)
        options = request.get('options')
        if not isinstance(options, list) or not 1 <= len(options) <= 40:
            raise ValueError('Нет разделов для выбора.')
        allowed = {}
        for option in options:
            if not isinstance(option, dict) or not isinstance(option.get('id'), str) or not isinstance(option.get('label'), str):
                raise ValueError('Некорректный список разделов.')
            allowed[option['id'][:80]] = option['label'][:120]
        result = self.call_model('pulse-route',
            'Выбери раздел интерфейса, который лучше всего отвечает на запрос пользователя. Верни один JSON {"id":"..."|null,"ask":true|false}. '
            'id — только из options. ask=true, если это вопрос к данным, который лучше задать в диалоге.',
            {'userQuery': query, 'options': [{'id': k, 'label': v} for k, v in allowed.items()]}, query)
        if not isinstance(result, dict) or result.get('id') not in (None, *allowed) or type(result.get('ask', False)) is not bool:
            raise ValueError('Ответ модели не прошёл проверку списка разделов.')
        return {'id': result.get('id'), 'ask': result.get('ask', False)}


# ---------------------------------------------------------------- helpers ---

def fmt_int(value):
    return '—' if value is None else f'{round(value):,}'.replace(',', ' ')


def fmt_value(value, metric):
    if value is None:
        return '—'
    if metric == 'csi':
        return f'{value:.2f}'.replace('.', ',')
    return fmt_int(value)


def change_label(item):
    if item.get('relative') is not None:
        return ('+' if item['relative'] > 0 else '') + f"{item['relative']:.1f}".replace('.', ',') + '%'
    return ('+' if item['delta'] > 0 else '') + f"{item['delta']:.2f}".replace('.', ',') + ' балла'


def pct_change(before, after):
    if not before or after is None:
        return 'нет базы'
    value = (after - before) / before * 100
    return ('+' if value > 0 else '') + f'{value:.1f}'.replace('.', ',') + '%'


def shift_sentence(shift):
    unit = ' ' + shift['unit'] if shift['metric'] != 'csi' else ''
    return (shift['label'] + ': ' + fmt_value(shift['before'], shift['metric']) + unit + ' → '
            + fmt_value(shift['after'], shift['metric']) + unit + ' (' + change_label(shift) + ') с ' + shift['date']
            + ' · дней до/после: ' + str(shift['daysBefore']) + '/' + str(shift['daysAfter']))


def normalise_number(token):
    token = token.replace('−', '-').replace(',', '.').lstrip('+')
    try:
        value = float(token)
    except ValueError:
        return token
    return str(int(value)) if value == int(value) else f'{value:.2f}'.rstrip('0').rstrip('.')


def facts_numbers(facts):
    allowed = set()

    def add(value):
        if isinstance(value, bool) or value is None:
            return
        if isinstance(value, (int, float)):
            for variant in (value, round(value), round(value, 1), round(value, 2), abs(value), round(abs(value), 1), round(abs(value), 2)):
                allowed.add(normalise_number(str(variant)))
        elif isinstance(value, str):
            for token in NUMBER.findall(value):
                allowed.add(normalise_number(token))
                allowed.add(normalise_number(token.lstrip('-−+')))
            for match in re.findall(r'(\d{4})-(\d{2})-(\d{2})', value):
                allowed.update({match[0], str(int(match[1])), str(int(match[2])), match[1], match[2],
                                normalise_number(match[2] + '.' + match[1])})
        elif isinstance(value, dict):
            for item in value.values():
                add(item)
        elif isinstance(value, list):
            for item in value:
                add(item)
    add(facts)
    for small in range(0, 11):
        allowed.add(str(small))
    return allowed


def brief_facts(brief):
    facts = []

    def add(label, value, unit='', period=''):
        facts.append({'ref': 'F' + str(len(facts) + 1), 'label': label, 'value': value, 'unit': unit, 'period': period})

    for kpi in brief.get('kpis', []):
        period = kpi['window'][0] + ' — ' + kpi['window'][1]
        add(kpi['label'] + ': ответы за 7 дней', kpi['current']['answers'], 'ответов', period)
        add(kpi['label'] + ': ответы за предыдущие 7 дней', kpi['baseline']['answers'], 'ответов')
        if kpi['current']['csi'] is not None:
            add(kpi['label'] + ': CSI за 7 дней', round(kpi['current']['csi'], 2), 'балла', period)
    changes = brief.get('changes') or {}
    if changes:
        add('Новых сигналов с прошлого брифинга', changes['counts']['added'])
        add('Закрытых сигналов с прошлого брифинга', changes['counts']['resolved'])
    for cluster in brief.get('clusters', [])[:3]:
        add(cluster['title'], len(cluster['members']), 'опросов', cluster['from'] + ' — ' + cluster['to'])
    for shift in brief.get('shifts', [])[:6]:
        add('#' + str(shift['id']) + ' ' + shift['name'] + ': ' + shift['label'] + ' до сдвига', round(shift['before'], 2), shift['unit'])
        add('#' + str(shift['id']) + ' ' + shift['name'] + ': ' + shift['label'] + ' после сдвига с ' + shift['date'],
            round(shift['after'], 2), shift['unit'], 'изменение ' + change_label(shift))
    urgent = [s for s in brief.get('signals', []) if s['severity'] == 'urgent']
    add('Срочных сигналов мониторинга', len(urgent))
    for signal in urgent[:3]:
        add('#' + str(signal['id']) + ' ' + signal['name'], ' · '.join(signal['reasons']))
    return facts[:30]


def shift_facts(pulse, state, revision, shift):
    facts = []

    def add(label, value, unit='', period=''):
        facts.append({'ref': 'F' + str(len(facts) + 1), 'label': label, 'value': value, 'unit': unit, 'period': period})

    add(shift['label'] + ' до сдвига', round(shift['before'], 2), shift['unit'], 'до ' + shift['lastBefore'])
    add(shift['label'] + ' после сдвига', round(shift['after'], 2), shift['unit'], 'с ' + shift['date'])
    add('Изменение', change_label(shift))
    if shift['channel'] == 'communication':
        start = (dt.date.fromisoformat(shift['date']) - dt.timedelta(days=14)).isoformat()
        rows = pulse.daily(revision, [(shift['channel'], shift['id'])], start, shift['through'])
        before = [r for r in rows if r['date'] < shift['date']]
        after = [r for r in rows if r['date'] >= shift['date']]
        for key, label in (('events', 'События в день'), ('stop', 'Стоп-лист 1002 в день'), ('contactPolicy', 'Политика контактов в день')):
            b = mean([r[key] for r in before if r.get(key) is not None])
            a = mean([r[key] for r in after if r.get(key) is not None])
            if b is not None and a is not None:
                add(label + ' до', round(b), 'в день')
                add(label + ' после', round(a), 'в день')
    others = [s for s in pulse.shifts(state, revision, shift['channel']) if s['id'] != shift['id'] and s['metric'] == shift['metric']
              and s['direction'] == shift['direction'] and abs((dt.date.fromisoformat(s['date']) - dt.date.fromisoformat(shift['date'])).days) <= 2]
    add('Опросов с таким же сдвигом ±2 дня', len(others))
    try:
        events = pulse.engine.workflows.list().get('events', [])
    except Exception:
        events = []
    anchor = dt.date.fromisoformat(shift['date'])
    for item in events[:300]:
        start, end = str(item.get('from') or '')[:10], str(item.get('to') or item.get('from') or '')[:10]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', end):
            continue
        ids = item.get('ids') or []
        if ids and shift['id'] not in ids:
            continue
        if dt.date.fromisoformat(start) - dt.timedelta(days=3) <= anchor <= dt.date.fromisoformat(end) + dt.timedelta(days=3):
            add('Событие календаря запусков рядом с датой сдвига (совпадение — не доказательство причины)',
                str(item.get('title') or item.get('name') or item.get('note') or 'запуск')[:120], '', start + ' — ' + end)
    return facts


def check_options(facts):
    labels = {f['label'] for f in facts}
    options = []
    if 'Стоп-лист 1002 в день до' in labels:
        options.append(('Сверить изменение отсечения по стоп-листу 1002 и дату обновления стоп-листа', [f['ref'] for f in facts if 'Стоп-лист' in f['label']]))
    if 'Политика контактов в день до' in labels:
        options.append(('Проверить правила политики контактов и частоты коммуникаций', [f['ref'] for f in facts if 'Политика' in f['label']]))
    if 'События в день до' in labels:
        options.append(('Проверить входящий поток событий и интеграцию с источником', [f['ref'] for f in facts if f['label'].startswith('События')]))
    options.append(('Сравнить с другими опросами продукта и найти общий источник', [f['ref'] for f in facts if f['label'].startswith('Опросов с таким')]))
    options.append(('Проверить полноту выгрузки за дату сдвига', [facts[1]['ref']]))
    return options


WHATIF_CHANNEL = re.compile(r'экран', re.I)


def parse_whatif(query, state):
    q = query.lower().replace('ё', 'е')
    params = {'id': None, 'product': None, 'channel': 'success_screen' if WHATIF_CHANNEL.search(q) else 'communication',
              'responseRate': None, 'sendsPerDay': None, 'sendsChangePct': None, 'plan': None}
    notes = []
    match = re.search(r'опрос[а-я]*\s*[#№]?\s*(\d{1,7})', q)
    if match:
        params['id'] = int(match[1])
    products = sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=len, reverse=True)
    for product in products:
        if product.lower().replace('ё', 'е') in q:
            params['product'] = product
            break
    match = re.search(r'отклик[а-я]*\D{0,20}?(\d+(?:[.,]\d+)?)\s*%', q)
    if match:
        params['responseRate'] = float(match[1].replace(',', '.'))
    match = re.search(r'отправ[а-я]*\D{0,25}?([+-−]?\s*\d+(?:[.,]\d+)?)\s*%', q)
    if match:
        value = float(match[1].replace(' ', '').replace('−', '-').replace(',', '.'))
        if re.search(r'(упад|сниз|сократ|уменьш|меньше|минус)', q) and value > 0:
            value = -value
        params['sendsChangePct'] = value
    else:
        match = re.search(r'(\d[\d\s]{0,12})\s*отправ[а-я]*\s*(?:в|за)\s*день', q)
        if match:
            params['sendsPerDay'] = float(re.sub(r'\s', '', match[1]))
    match = re.search(r'план[а-я]*\D{0,15}?(\d[\d\s]{0,12}\d|\d)', q)
    if match:
        params['plan'] = float(re.sub(r'\s', '', match[1]))
    understood = any(params[k] is not None for k in ('responseRate', 'sendsPerDay', 'sendsChangePct', 'plan', 'id', 'product'))
    if params['id'] is None and params['product'] is None:
        notes.append('Опрос или продукт не указан — сценарий считается по всем опросам канала.')
    return {'params': params, 'understood': understood, 'notes': notes}


METRIC_LABELS = {'sends': 'Отправки', 'answers': 'Ответы', 'events': 'События', 'csi': 'CSI', 'responseRate': 'Отклик, %',
                 'stop': 'Стоп-лист 1002', 'contactPolicy': 'Политика контактов'}


def aggregate(rows, metric, total=False, per_day=False):
    """Сумма (или взвешенное значение) по строкам feedback_days; per_day — среднее на день с данными."""
    if not rows:
        return None
    if metric == 'csi':
        return weighted_csi(rows)[0]
    if metric == 'responseRate':
        sends = sum(r.get('sends') or 0 for r in rows)
        return sum(r.get('answers') or 0 for r in rows) / sends * 100 if sends else None
    values = [r[metric] for r in rows if r.get(metric) is not None]
    if not values:
        return None
    amount = float(sum(values))
    if per_day:
        return amount / max(len({r['date'] for r in rows}), 1)
    return amount


def signed_pct(value):
    return ('+' if value > 0 else '') + f'{value:.1f}'.replace('.', ',') + '%'


def signed_num(value):
    return ('+' if value > 0 else '') + f'{value:.2f}'.replace('.', ',')


def point_checks(facts):
    labels = [f['label'] for f in facts]
    options = []
    if any(l.startswith('Стоп-лист') for l in labels):
        options.append(('Сверить отсечение по стоп-листу 1002 в этот день', [f['ref'] for f in facts if f['label'].startswith('Стоп-лист')]))
    if any(l.startswith('Политика') for l in labels):
        options.append(('Проверить срабатывание политики контактов', [f['ref'] for f in facts if f['label'].startswith('Политика')]))
    if any(l.startswith('События') for l in labels):
        options.append(('Проверить входящий поток событий', [f['ref'] for f in facts if f['label'].startswith('События')]))
    if any(l.startswith('Событие календаря') for l in labels):
        options.append(('Уточнить у владельца события календаря, что именно менялось', [f['ref'] for f in facts if f['label'].startswith('Событие календаря')]))
    options.append(('Проверить полноту выгрузки за этот день', [facts[0]['ref']]))
    return options


def fact_value(fact):
    value = fact['value']
    text = fmt_int(value) if isinstance(value, (int, float)) and abs(value) >= 100 else (str(value).replace('.', ',') if isinstance(value, float) else str(value))
    return text + (' ' + fact['unit'] if fact.get('unit') else '')


def canned_explain(facts, options, notes=()):
    """Сохранённый ответ демо: собирается из тех же фактов, чисел сверх фактов не содержит."""
    by = {f['label']: f for f in facts}
    change = next((f for f in facts if f['label'].startswith('Изменение')), None)
    stop = [f for f in facts if f['label'].startswith('Стоп-лист')]
    events = [f for f in facts if f['label'].startswith('События')]
    calendar = [f for f in facts if f['label'].startswith('Событие календаря')]
    hypotheses = []
    if len(stop) >= 2 and isinstance(stop[0]['value'], (int, float)) and isinstance(stop[1]['value'], (int, float)):
        first, second = stop[0]['value'], stop[1]['value']
        low, high = min(first, second), max(first, second)
        if low and high / low >= 1.3:
            hypotheses.append({'text': 'Отсечение по стоп-листу 1002 заметно изменилось: ' + fact_value(stop[0]) + ' против ' + fact_value(stop[1])
                               + '. Вероятно, изменение связано со стоп-листом.', 'refs': [f['ref'] for f in stop[:2]]})
    if len(events) >= 2 and not hypotheses and isinstance(events[0]['value'], (int, float)) and isinstance(events[1]['value'], (int, float)) \
            and min(events[0]['value'], events[1]['value']) and max(events[0]['value'], events[1]['value']) / min(events[0]['value'], events[1]['value']) >= 1.3:
        hypotheses.append({'text': 'Входящий поток событий: ' + fact_value(events[0]) + ' против ' + fact_value(events[1])
                           + '. Стоит проверить источник событий.', 'refs': [f['ref'] for f in events[:2]]})
    if calendar:
        hypotheses.append({'text': 'Рядом с датой в календаре есть событие «' + str(calendar[0]['value']) + '». Совпадение по времени — гипотеза, не доказательство.',
                           'refs': [calendar[0]['ref']]})
    if notes:
        hypotheses.append({'text': 'Похожий прошлый случай из памяти расследований: ' + notes[0]['title'] + '.', 'refs': [facts[0]['ref']]})
    if not hypotheses:
        hypotheses.append({'text': 'Сопутствующие показатели изменились слабо — вероятна локальная причина этого опроса.', 'refs': [facts[0]['ref']]})
    summary = facts[0]['label'] + ': ' + fact_value(facts[0]) + ('; ' + facts[1]['label'].lower() + ': ' + fact_value(facts[1]) if len(facts) > 1 else '') \
        + ('. Изменение: ' + str(change['value']) if change else '') + '.'
    return {'summary': summary[:300], 'hypotheses': hypotheses[:3], 'checks': options[:3], 'facts': facts,
            'trust': {'facts': len(facts), 'refs': sum(len(h['refs']) for h in hypotheses[:3]), 'rejected': 0}}


def canned_narrative(brief, facts):
    down = [s for s in brief.get('shifts', []) if s['direction'] == 'down']
    urgent = [s for s in brief.get('signals', []) if s['severity'] == 'urgent']
    clusters = brief.get('clusters', [])
    parts = []
    if urgent:
        parts.append('срочных сигналов: ' + str(len(urgent)))
    if clusters:
        parts.append('групповых инцидентов: ' + str(len(clusters)))
    if down:
        parts.append('устойчивых снижений: ' + str(len(down)))
    headline = ('В фокусе — ' + ', '.join(parts) + '.') if parts else 'Существенных отклонений нет, показатели стабильны.'
    bullets = []
    for fact in facts:
        if fact['label'].startswith('Групповое') and len(bullets) < 2:
            bullets.append({'text': fact['label'] + ': вероятна общая причина, проверьте её один раз.', 'refs': [fact['ref']]})
    for fact in facts:
        if 'после сдвига' in fact['label'] and len(bullets) < 4:
            bullets.append({'text': fact['label'] + ' — ' + fact_value(fact) + ' (' + fact.get('period', '') + ').', 'refs': [fact['ref']]})
    for fact in facts:
        if fact['label'].startswith('#') and isinstance(fact['value'], str) and len(bullets) < 5:
            bullets.append({'text': fact['label'] + ': ' + fact['value'], 'refs': [fact['ref']]})
    if not bullets:
        bullets.append({'text': facts[0]['label'] + ': ' + fact_value(facts[0]) + '.', 'refs': [facts[0]['ref']]})
    return {'headline': headline, 'bullets': bullets, 'source': 'Демо: сохранённый ответ, модель не вызывалась', 'canned': True}
