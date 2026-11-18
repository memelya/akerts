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
LOOSEST = 0.6   # кандидаты сдвигов ищутся при самом мягком пороге; отбор по чувствительности — в apply_sensitivity
SENSITIVITY_RANGE = (0.6, 2.0)
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
NUMBER = re.compile(r'(?<![\w])[-+−]?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?')


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
    n = len(values)
    s1, s2 = [0.0], [0.0]
    for v in values:  # накопленные суммы: поиск точки разрыва за O(n)
        s1.append(s1[-1] + v)
        s2.append(s2[-1] + v * v)
    best = None
    for k in range(MIN_SIDE, n - MIN_SIDE + 1):
        nb, na = k, n - k
        mb, ma = s1[k] / nb, (s1[n] - s1[k]) / na
        vb = max((s2[k] - nb * mb * mb) / (nb - 1), 0.0)
        va = max((s2[n] - s2[k] - na * ma * ma) / (na - 1), 0.0)
        noise = math.sqrt(vb / nb + va / na) or 1e-9
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
        if persist * delta <= 0:
            return None
        strength = min(abs(delta) / .25, score / 4, abs(persist) / .2)
        before_value, after_value, relative = csi_b, csi_a, None
        severity = 'high' if abs(delta) >= .4 else 'medium'
    else:
        if mb < spec['floor'] and ma < spec['floor']:
            return None
        base = max(mb, 1e-9)
        relative = (ma - mb) / base
        persist = (mean(tail) - mb) / base
        if persist * relative <= 0:
            return None
        strength = min(abs(relative) / .25, score / 5, abs(persist) / .2)
        before_value, after_value, delta = mb, ma, ma - mb
        severity = 'high' if abs(relative) >= .4 else 'medium'
    if strength < LOOSEST:
        return None
    return {
        'metric': metric, 'label': spec['label'], 'unit': spec['unit'],
        'date': points[k][0], 'lastBefore': points[k - 1][0],
        'before': round(before_value, 4), 'after': round(after_value, 4), 'delta': round(delta, 4),
        'relative': round(relative * 100, 1) if relative is not None else None,
        'direction': 'down' if delta < 0 else 'up', 'score': round(score, 1), 'severity': severity,
        'daysBefore': k, 'daysAfter': len(points) - k, 'strength': round(strength, 3),
        'series': [[p[0], round(p[1], 3)] for p in points],
    }


def sensitivity_for(shift, levels):
    """Порог чувствительности: настройка продукта сдвига (самая мягкая из его продуктов) или общая."""
    own = [levels[p] for p in shift.get('products', []) if p in levels]
    return min(own) if own else levels.get('', 1.0)


def apply_sensitivity(shifts, levels):
    return [s for s in shifts if s['strength'] >= sensitivity_for(s, levels) - 1e-9]


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
                CREATE TABLE IF NOT EXISTS pulse_journal(id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, document TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS pulse_journal_kind ON pulse_journal(kind, at);
                CREATE TABLE IF NOT EXISTS pulse_skills(id TEXT PRIMARY KEY, created TEXT NOT NULL, document TEXT NOT NULL);
            ''')

    # -- settings ---------------------------------------------------------
    @property
    def settings_path(self):
        return self.root / '.local-data' / 'pulse-settings.json'

    BASELINE_FIELDS = {'detectDays': (0, 365), 'closeDays': (0, 365), 'meetingHours': (0, 200),
                       'checkHoursPerDay': (0, 24), 'meetingsPerMonth': (0, 100), 'people': (0, 500)}

    def settings(self):
        try:
            value = json.loads(self.settings_path.read_text(encoding='utf-8'))
            if not isinstance(value, dict):
                raise ValueError
        except (OSError, ValueError):
            value = {}
        levels = value.get('sensitivity') if isinstance(value.get('sensitivity'), dict) else {}
        levels = {k: float(v) for k, v in levels.items() if isinstance(k, str) and type(v) in (int, float)
                  and SENSITIVITY_RANGE[0] <= v <= SENSITIVITY_RANGE[1]}
        levels.setdefault('', 1.0)
        baseline = value.get('baseline') if isinstance(value.get('baseline'), dict) else {}
        baseline = {k: float(v) for k, v in baseline.items() if k in self.BASELINE_FIELDS and type(v) in (int, float)}
        return {'autoNarrate': value.get('autoNarrate') is True, 'sensitivity': levels, 'baseline': baseline,
                'baselineDemo': value.get('baselineDemo') is True}

    def save_settings(self, request):
        from data_trust import atomic_json
        current = self.settings()
        recompute = False
        if 'autoNarrate' in request:
            if type(request['autoNarrate']) is not bool:
                raise ValueError('Укажите, готовить ли AI-резюме заранее.')
            current['autoNarrate'] = request['autoNarrate']
        if 'sensitivity' in request:
            level = number_or_none(request['sensitivity'], 'Чувствительность', *SENSITIVITY_RANGE)
            product = clean_text(request.get('product'), 'Продукт', 200)
            if level is None or request.get('reset'):
                if product:
                    current['sensitivity'].pop(product, None)
                else:
                    current['sensitivity'] = {'': 1.0}
            else:
                current['sensitivity'][product] = round(level, 2)
            recompute = True
        if 'baseline' in request:
            raw = request['baseline']
            if not isinstance(raw, dict):
                raise ValueError('Базовые значения: нужен набор полей.')
            baseline = {}
            for key, (low, high) in self.BASELINE_FIELDS.items():
                value = number_or_none(raw.get(key), 'Базовое значение', low, high)
                if value is not None:
                    baseline[key] = value
            current['baseline'] = baseline
            current['baselineDemo'] = False
        atomic_json(self.settings_path, current)
        if recompute:
            self.ensure_brief(True)
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
                    answered = [r.get('answers') or 0 for r in days.values()]
                    shift['avgAnswers'] = round(sum(answered) / len(answered), 2) if answered else 0
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
        started = time.monotonic()
        candidates = self.shifts(state, revision)
        settings = self.settings()
        shifts = apply_sensitivity(candidates, settings['sensitivity'])
        clusters = self.clusters(shifts)
        notes = self.notes()['notes']
        for shift in candidates[:150]:
            shift['memory'] = self.recall(shift, notes)
        brief = {'version': VERSION, 'revision': revision, 'generatedAt': now(), 'empty': False,
                 'kpis': self.kpis(state, revision), 'signals': signals, 'shifts': shifts[:60], 'shiftTotal': len(shifts),
                 'candidates': candidates[:150], 'candidateTotal': len(candidates), 'sensitivity': settings['sensitivity'],
                 'clusters': clusters[:12], 'narrative': None, 'events': self.calendar_marks()}
        focus = self.focus_keys(state)
        favorites = {tuple(k) for k in self.focus_store()['favorites']}
        for item in candidates[:150] + signals:
            key = (item['channel'], item['id'])
            item['inFocus'] = key in focus
            item['favorite'] = key in favorites
        brief['problems'] = build_problems(shifts, signals, focus, favorites)
        brief['focus'] = {'total': len(focus), 'top': sum(1 for s in state['surveys'] if s['event'].get('isTop')),
                          'favorites': len(favorites), 'minAnswers': MIN_FOCUS_ANSWERS}
        brief['bank'] = self.bank_status(state, revision)
        brief['computeSeconds'] = round(time.monotonic() - started + 0.0, 2)
        self.journal_detected(brief)
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
            parts = re.split(r'[ \u00a0\u202f]', token)
            if normalise_number(token) not in allowed and not (len(parts) > 1 and all(normalise_number(x) in allowed for x in parts)):
                raise ValueError(label + ': модель добавила число «' + token + '», которого нет в фактах. Ответ отклонён.')
        return text.strip()

    def narrate(self, request):
        return self.with_fallback(lambda: self.narrate_live(request), self.narrate_canned)

    def checked(self, live):
        """Журнал проверок: каждый ответ модели принят или отклонён проверкой фактов."""
        try:
            result = live()
        except Exception as error:
            if 'отклон' in str(error).lower():
                self.log('model-check', outcome='rejected', reason=str(error)[:240])
            raise
        self.log('model-check', outcome='accepted')
        return result

    def narrative_items(self, brief):
        items = [p for p in brief.get('problems', []) if p['inFocus'] and not p['lowVolume'] and p['kind'] != 'growth'][:5]
        facts = [{'ref': 'I' + str(i + 1), 'label': p['title'] + ' — ' + p['line'], 'value': p['kindLabel'], 'unit': '', 'period': p.get('since') or ''}
                 for i, p in enumerate(items)]
        return items, facts

    def narrate_canned(self):
        brief = self.ensure_brief()
        if brief.get('empty'):
            raise ValueError('Нет данных для резюме.')
        items, facts = self.narrative_items(brief)
        narrative = {'status': canned_status(brief, items), 'items': [{'ref': f['ref'], 'key': p['key'], 'note': p['hint']} for f, p in zip(facts, items)],
                     'facts': facts, 'generatedAt': now(), 'revision': brief['revision'], 'source': 'Демо: сохранённый ответ, модель не вызывалась',
                     'canned': True, 'trust': {'facts': len(facts), 'refs': len(facts), 'rejected': 0, 'platformNumbers': True}}
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
        items, facts = self.narrative_items(brief)
        if not facts:
            narrative = {'status': canned_status(brief, items), 'items': [], 'facts': [], 'generatedAt': now(), 'revision': brief['revision'],
                         'source': 'Проблем в фокусе нет — модель не вызывалась', 'trust': {'facts': 0, 'refs': 0, 'rejected': 0, 'platformNumbers': True}}
            self.save_narrative(brief['revision'], narrative)
            return narrative
        self.stage('Отправляю темы в GigaCode')
        result = self.call_model('pulse-brief',
            'Ты помощник руководителя. В facts — проблемы опросов из его фокуса (I1…). Верни один JSON '
            '{"status":"...","items":[{"ref":"I1","note":"..."}]}. status — одна фраза до 110 символов: общий вывод для руководителя. '
            'items — те же ref в порядке важности, note — до 110 символов: что это скорее всего значит и что проверить, как гипотеза. '
            'НЕ ПИШИ НИКАКИХ ЦИФР, дат, номеров и названий опросов: их подставит платформа. Без вступлений.',
            {'facts': facts}, 'Утреннее резюме')
        self.stage('Проверяю ответ: ссылки и отсутствие цифр')
        refs = {f['ref']: p for f, p in zip(facts, items)}
        if not isinstance(result, dict) or set(result) - {'status', 'items'} or not isinstance(result.get('items'), list):
            raise ValueError('Ответ модели не соответствует формату резюме.')
        def words(text, label, limit):
            if not isinstance(text, str) or not text.strip() or len(text) > limit:
                raise ValueError(label + ': модель вернула пустой или слишком длинный текст. Ответ отклонён.')
            if re.search(r'\d', text):
                raise ValueError(label + ': модель написала число, хотя числа подставляет платформа. Ответ отклонён.')
            return text.strip()
        ordered, seen = [], set()
        for item in result['items']:
            if not isinstance(item, dict) or item.get('ref') not in refs or item['ref'] in seen:
                raise ValueError('Модель сослалась на несуществующую тему. Резюме отклонено.')
            seen.add(item['ref'])
            ordered.append({'ref': item['ref'], 'key': refs[item['ref']]['key'], 'note': words(item.get('note'), 'Комментарий', 160)})
        for ref, problem in refs.items():
            if ref not in seen:
                ordered.append({'ref': ref, 'key': problem['key'], 'note': problem['hint']})
        narrative = {'status': words(result.get('status'), 'Вывод', 160), 'items': ordered, 'facts': facts, 'generatedAt': now(),
                     'revision': brief['revision'], 'source': 'GigaCode CLI · числа подставлены платформой',
                     'trust': {'facts': len(facts), 'refs': len(ordered), 'rejected': 0, 'platformNumbers': True}}
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
        self.log('note', surveyId=ident, metric=metric, direction=direction, channel=channel, noteId=note['id'])
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

    def recall(self, shift, notes=None):
        scored = []
        products = {p.casefold() for p in shift.get('products', [])}
        for note in (self.notes()['notes'] if notes is None else notes):
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
                 + ([brief['narrative'].get('status') or brief['narrative'].get('headline')] if brief.get('narrative') and (brief['narrative'].get('status') or brief['narrative'].get('headline')) else []),
                 'conclusion': '', 'series': None}
        self.log('meeting-built', slides=len(slides) + 1, product=product)
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
        self.demo_baseline()
        if not self.focus_path.exists():
            from data_trust import atomic_json
            from demo_data import FAVORITES
            atomic_json(self.focus_path, {'favorites': FAVORITES})
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
                db.execute('DELETE FROM pulse_journal')
                db.execute('DELETE FROM pulse_skills')
            self.settings_path.unlink(missing_ok=True)
            self.screen_path.unlink(missing_ok=True)
            self.focus_path.unlink(missing_ok=True)
            try:
                for event in self.engine.workflows.list().get('events', []):
                    self.engine.workflows.delete_event(event['id'])
            except (AttributeError, ValueError, KeyError):
                pass
        self.demo_seed()
        return self.brief_response(True)

    def stage(self, text):
        job = getattr(self.local, 'job', None)
        if job is not None:
            job['stages'].append({'text': text, 'at': round(time.monotonic() - job['started'], 2)})

    def with_fallback(self, live, canned):
        """В демо-папке при недоступной модели показывает сохранённый ответ с явной пометкой."""
        if not self.demo():
            return self.checked(live)
        reason, rejected = 'модель не вызывалась', 0
        try:
            if self.model_ready():
                return self.checked(live)
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
        if days not in (14, 30, 60, 90, 180, 365):
            raise ValueError('Период: 14, 30, 60, 90, 180 или 365 дней.')
        grain = request.get('grain') or 'day'
        if grain not in ('day', 'week', 'month'):
            raise ValueError('Группировка: по дням, неделям или месяцам.')
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
        def bucket(date):
            if grain == 'day':
                return date
            d = dt.date.fromisoformat(date)
            return (d - dt.timedelta(days=d.weekday())).isoformat() if grain == 'week' else d.replace(day=1).isoformat()
        def bounds(key):
            first = dt.date.fromisoformat(key)
            last = first + dt.timedelta(days=6) if grain == 'week' else first.replace(day=calendar.monthrange(first.year, first.month)[1])
            return first, last
        output = []
        for r in resolved:
            by_day = defaultdict(list)
            for row in self.daily(revision, r['keys'], start, latest):
                by_day[row['date']].append(row)
            by_period = defaultdict(list)
            for date, part in by_day.items():
                by_period[bucket(date)].extend(part)
            series = []
            for date in sorted(by_period):
                value = aggregate(by_period[date], metric, grain != 'day')
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
            if grain == 'day':
                dates = sorted(by_day)
                first = aggregate([x for x in rows if x['date'] in set(dates[:7])], metric, True)
                last = aggregate([x for x in rows if x['date'] in set(dates[-7:])], metric, True)
            else:  # первый и последний полные периоды (неполные края не сравниваем)
                full = [k for k in sorted(by_period) if bounds(k)[0].isoformat() >= start and bounds(k)[1].isoformat() <= latest]
                first = aggregate(by_period[full[0]], metric, True) if len(full) > 1 else None
                last = aggregate(by_period[full[-1]], metric, True) if len(full) > 1 else None
            if metric in ('csi', 'responseRate'):
                period_delta, period_relative = (last - first if last is not None and first is not None else None), None
            else:
                period_delta = last - first if last is not None and first is not None else None
                period_relative = (last - first) / first * 100 if first else None
            partial = [k for k in sorted(by_period) if grain != 'day' and (bounds(k)[0].isoformat() < start or bounds(k)[1].isoformat() > latest)]
            output.append({'label': r['label'], 'channel': r['channel'], 'id': r['id'], 'product': r['product'], 'surveys': r['surveys'],
                           'series': series, 'partial': partial, 'total': aggregate(rows, metric, True), 'current': current, 'previous': previous,
                           'delta': delta, 'relative': relative, 'periodDelta': period_delta, 'periodRelative': period_relative})
        ranked = [o for o in output if (o['periodRelative'] if o['periodRelative'] is not None else o['periodDelta']) is not None]
        conclusion = ''
        if ranked:
            key = lambda o: o['periodRelative'] if o['periodRelative'] is not None else o['periodDelta'] * 100
            show = lambda o: (signed_pct(o['periodRelative']) if o['periodRelative'] is not None else signed_num(o['periodDelta']))
            worst, best = min(ranked, key=key), max(ranked, key=key)
            span = 'За ' + str(days) + ' дней (' + {'day': 'последняя неделя к первой', 'week': 'последняя полная неделя к первой', 'month': 'последний полный месяц к первому'}[grain] + ') '
            if len(ranked) == 1:
                conclusion = span + '«' + worst['label'] + '»: ' + show(worst) + '.'
            elif key(worst) < 0:
                conclusion = span + 'сильнее всего просел «' + worst['label'] + '» (' + show(worst) + '), лучше всех — «' + best['label'] + '» (' + show(best) + ').'
            else:
                conclusion = span + 'снижений нет: минимум у «' + worst['label'] + '» (' + show(worst) + '), максимум у «' + best['label'] + '» (' + show(best) + ').'
        return {'metric': metric, 'label': METRIC_LABELS[metric], 'days': days, 'grain': grain, 'from': start, 'to': latest, 'items': output,
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


    # -- журнал эффекта --------------------------------------------------------------
    def log(self, kind, **document):
        document.update(kind=kind, at=now())
        try:
            with self.db() as db:
                db.execute('INSERT INTO pulse_journal VALUES(?,?,?,?)', (uuid.uuid4().hex, document['at'], kind, json.dumps(document, ensure_ascii=False, default=str)))
        except Exception:
            pass

    def journal(self, kinds=None, limit=5000):
        with self.db() as db:
            if kinds:
                rows = db.execute('SELECT document FROM pulse_journal WHERE kind IN (%s) ORDER BY at DESC LIMIT ?' % ','.join('?' * len(kinds)), (*kinds, limit)).fetchall()
            else:
                rows = db.execute('SELECT document FROM pulse_journal ORDER BY at DESC LIMIT ?', (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def journal_detected(self, brief):
        """Первое появление каждого сдвига и сигнала: с этой минуты отклонение известно команде."""
        seen = {row['key'] for row in self.journal(['detected'])}
        self.log('brief', revision=brief['revision'], computeSeconds=brief.get('computeSeconds'), shifts=brief['shiftTotal'], signals=len(brief['signals']))
        for shift in brief['shifts']:
            key = shift['key'] + ':' + shift['date']
            if key not in seen:
                self.log('detected', key=key, source='shift', id=shift['id'], channel=shift['channel'], metric=shift['metric'],
                         direction=shift['direction'], startDate=shift['date'], dataThrough=shift['through'], name=shift['name'])
        for signal in brief['signals']:
            key = signal['key'] + ':' + signal['through']
            if key not in seen:
                self.log('detected', key=key, source='signal', id=signal['id'], channel=signal['channel'], metric='answers',
                         direction='down', startDate=None, dataThrough=signal['through'], name=signal['name'])

    def journal_add(self, request):
        kind = request.get('kind')
        if kind == 'meeting-exported':
            seconds = number_or_none(request.get('seconds'), 'Время', 0, 86400)
            self.log(kind, seconds=seconds, format=clean_text(request.get('format'), 'Формат', 20))
        elif kind in ('canvas-shown', 'canvas-exported'):
            self.log(kind, format=clean_text(request.get('format'), 'Формат', 20))
        elif kind == 'ai-verdict':
            verdict = request.get('verdict')
            if verdict not in ('accepted', 'edited', 'rejected'):
                raise ValueError('Оценка разбора: принять, исправить или отклонить.')
            self.log(kind, verdict=verdict, target=clean_text(request.get('target'), 'Объект', 160), canned=bool(request.get('canned')),
                     comment=clean_text(request.get('comment'), 'Комментарий', 500))
        else:
            raise ValueError('Неизвестное событие журнала.')
        return {'ok': True}

    def effect(self, request=None):
        settings = self.settings()
        rows = self.journal()
        detected = [r for r in rows if r['kind'] == 'detected']
        notes = [r for r in rows if r['kind'] == 'note']
        briefs = [r for r in rows if r['kind'] == 'brief']
        built = [r for r in rows if r['kind'] == 'meeting-built']
        exported = [r for r in rows if r['kind'] == 'meeting-exported' and r.get('seconds') is not None]
        verdicts = [r for r in rows if r['kind'] == 'ai-verdict']
        checks = [r for r in rows if r['kind'] == 'model-check' and not r.get('synthetic')]
        protection = sum(1 for r in rows if r['kind'] == 'model-check' and r.get('synthetic'))
        median = lambda values: sorted(values)[len(values) // 2] if values else None
        age = []
        for row in detected:
            if row.get('startDate'):
                found = dt.datetime.fromisoformat(row['at']).date()
                through = dt.date.fromisoformat(row['dataThrough'])
                age.append(((min(found, through) if through else found) - dt.date.fromisoformat(row['startDate'])).days)
        closures = []
        for row in detected:
            match = [n for n in notes if n.get('surveyId') == row.get('id') and n['at'] >= row['at']
                     and (n.get('metric') in (row.get('metric'), 'other') or row.get('source') == 'signal')]
            if match:
                first = min(match, key=lambda n: n['at'])
                closures.append((dt.datetime.fromisoformat(first['at']) - dt.datetime.fromisoformat(row['at'])).total_seconds() / 3600)
        accepted = sum(v['verdict'] == 'accepted' for v in verdicts)
        result = {
            'baseline': settings['baseline'], 'baselineDemo': settings['baselineDemo'],
            'detection': {'count': len(detected), 'shifts': sum(r.get('source') == 'shift' for r in detected),
                          'medianAgeDays': median(age), 'computeSeconds': median([b['computeSeconds'] for b in briefs if b.get('computeSeconds') is not None]),
                          'briefs': len(briefs)},
            'closure': {'closed': len(closures), 'open': len(detected) - len(closures), 'medianHours': median(closures),
                        'share': len(closures) / len(detected) * 100 if detected else None},
            'meeting': {'built': len(built), 'exported': len(exported), 'medianMinutes': (median([e['seconds'] for e in exported]) or 0) / 60 if exported else None},
            'ai': {'verdicts': len(verdicts), 'accepted': accepted, 'edited': sum(v['verdict'] == 'edited' for v in verdicts),
                   'rejected': sum(v['verdict'] == 'rejected' for v in verdicts), 'acceptedShare': accepted / len(verdicts) * 100 if verdicts else None,
                   'checksAccepted': sum(c.get('outcome') == 'accepted' for c in checks), 'checksRejected': sum(c.get('outcome') == 'rejected' for c in checks),
                   'protectionTests': protection},
            'since': rows[-1]['at'] if rows else None,
            'method': 'Все значения «стало» считаются по журналу этой папки: появление сдвигов и сигналов в брифинге, записи выводов, '
                      'сборка и выгрузка встреч, оценки AI-разборов и проверки ответов модели. Значения «было» вводятся вручную.',
        }
        base = settings['baseline']
        saved = None
        if base.get('meetingHours') and result['meeting']['medianMinutes'] is not None and base.get('meetingsPerMonth'):
            saved = max(base['meetingHours'] - result['meeting']['medianMinutes'] / 60, 0) * base['meetingsPerMonth']
        result['savedMeetingHoursPerMonth'] = saved
        return result

    def demo_baseline(self):
        """Пример базовых значений для демо-папки с явной пометкой. В рабочем проекте их нет."""
        from data_trust import atomic_json
        current = self.settings()
        if current['baseline'] or not self.demo():
            return
        current['baseline'] = {'detectDays': 14, 'closeDays': 10, 'meetingHours': 6, 'checkHoursPerDay': 3, 'meetingsPerMonth': 4, 'people': 3}
        current['baselineDemo'] = True
        atomic_json(self.settings_path, current)

    # -- события на графиках ----------------------------------------------------------
    def calendar_marks(self):
        try:
            events = self.engine.workflows.list().get('events', [])
        except Exception:
            return []
        marks = []
        for item in events[:500]:
            start = str(item.get('from') or '')[:10]
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start):
                continue
            marks.append({'id': item.get('id'), 'date': start, 'to': str(item.get('to') or start)[:10], 'title': item.get('title') or 'Событие',
                          'kind': item.get('kind') or 'other', 'ids': item.get('ids') or [], 'channel': item.get('channel') or '',
                          'product': item.get('product') or '', 'note': (item.get('note') or '')[:300]})
        return sorted(marks, key=lambda m: m['date'])

    def event_add(self, request):
        title = clean_text(request.get('title'), 'Название', 160, True)
        date = clean_text(request.get('date'), 'Дата', 10, True)
        dt.date.fromisoformat(date)
        ident = request.get('id')
        ids = [ident] if type(ident) is int else []
        kind = request.get('kind') if request.get('kind') in ('campaign', 'policy', 'incident', 'other') else 'other'
        channel = request.get('channel') if request.get('channel') in CHANNELS else ''
        event = self.engine.workflows.save_event({'title': title, 'from': date, 'to': date, 'kind': kind, 'ids': ids, 'channel': channel,
                                                  'note': clean_text(request.get('note'), 'Заметка', 500)})
        brief = self.ensure_brief()
        with self.lock:
            current = self.cached_brief(brief['revision'])
            if current:
                current['events'] = self.calendar_marks()
                self.store_brief(current)
        return {'event': event, 'events': self.calendar_marks()}

    def event_impact(self, request):
        state, revision = self.snapshot()
        date = clean_text(request.get('date'), 'Дата', 10, True)
        anchor = dt.date.fromisoformat(date)
        ids = request.get('ids') or []
        if not isinstance(ids, list) or any(type(i) is not int for i in ids):
            raise ValueError('Некорректный список опросов события.')
        channel = request.get('channel') if request.get('channel') in CHANNELS else None
        selected = [s for s in state['surveys'] if (not ids or s['event']['id'] in ids) and (not channel or s['meta']['channel'] == channel)]
        if not selected:
            raise ValueError('Нет опросов, к которым относится событие.')
        keys = [(s['meta']['channel'], s['event']['id']) for s in selected]
        rows = self.daily(revision, keys, (anchor - dt.timedelta(days=7)).isoformat(), (anchor + dt.timedelta(days=6)).isoformat())
        grouped = defaultdict(list)
        for row in rows:
            grouped[row['channel'], row['survey_id']].append(row)
        meta = {(s['meta']['channel'], s['event']['id']): s['meta'] for s in selected}
        output = []
        for key, items in grouped.items():
            before = [r for r in items if r['date'] < date]
            after = [r for r in items if r['date'] >= date]
            if len(before) < 3 or len(after) < 3:
                continue
            for metric in ('sends', 'answers', 'csi'):
                b = aggregate(before, metric, False, metric != 'csi')
                a = aggregate(after, metric, False, metric != 'csi')
                if b is None or a is None:
                    continue
                if metric == 'csi':
                    if min(weighted_csi(before)[1], weighted_csi(after)[1]) < 50:
                        continue
                    change, relative, strong = a - b, None, abs(a - b) >= .15
                else:
                    if b < METRICS[metric]['floor']:
                        continue
                    change, relative = a - b, (a - b) / b * 100
                    strong = abs(relative) >= 15
                output.append({'id': key[1], 'channel': key[0], 'name': meta[key]['name'], 'metric': metric, 'label': METRIC_LABELS[metric],
                               'before': round(b, 3), 'after': round(a, 3), 'delta': round(change, 3),
                               'relative': round(relative, 1) if relative is not None else None, 'strong': strong,
                               'daysBefore': len({r['date'] for r in before}), 'daysAfter': len({r['date'] for r in after})})
        output.sort(key=lambda r: (not r['strong'], -(abs(r['relative']) if r['relative'] is not None else abs(r['delta']) * 100)))
        strong = [r for r in output if r['strong']]
        summary = ('После ' + date + ' заметно изменились ' + str(len(strong)) + ' показателей у '
                   + str(len({(r['channel'], r['id']) for r in strong})) + ' опросов.') if strong else 'После ' + date + ' заметных изменений нет.'
        return {'date': date, 'rows': output[:40], 'total': len(output), 'strong': len(strong), 'summary': summary,
                'scope': 'опросы события: ' + ', '.join('#' + str(i) for i in ids) if ids else 'все опросы' + (' канала ' + CHANNEL_LABELS[channel] if channel else ''),
                'method': '7 дней до даты события против 7 дней начиная с неё (среднее за день с данными; CSI — взвешенный). '
                          'Заметно: от 15% для объёмов, от 0,15 балла для CSI. Совпадение по времени — не доказательство причины.'}

    # -- проверка защиты: выдуманное число ----------------------------------------------
    def trust_demo(self, request):
        state, revision = self.snapshot()
        channel, ident, metric = request.get('channel'), request.get('id'), request.get('metric')
        if channel not in CHANNELS or type(ident) is not int or metric not in METRICS:
            raise ValueError('Выберите сдвиг для проверки.')
        shift = next((s for s in self.shifts(state, revision, channel, ident) if s['metric'] == metric), None)
        if not shift:
            raise ValueError('Сдвиг не найден в текущей версии данных.')
        facts = shift_facts(self, state, revision, shift)
        honest = facts[0]['label'] + ': ' + fact_value(facts[0]) + ', ' + facts[1]['label'].lower() + ': ' + fact_value(facts[1]) + '.'
        base = facts[1]['value'] if isinstance(facts[1]['value'], (int, float)) else 100
        invented = round(base * 1.37 + 3)
        fake = facts[1]['label'] + ': ' + fmt_int(invented) + ' ' + (facts[1].get('unit') or '') + '. Это втрое хуже, чем у конкурентов.'
        result = {'facts': facts, 'honest': {'text': honest}, 'tampered': {'text': fake}}
        try:
            self.check_text(honest, facts, 'Ответ')
            result['honest']['outcome'] = 'accepted'
        except ValueError as error:
            result['honest'].update(outcome='rejected', reason=str(error))
        try:
            self.check_text(fake, facts, 'Ответ')
            result['tampered']['outcome'] = 'accepted'
        except ValueError as error:
            result['tampered'].update(outcome='rejected', reason=str(error))
        self.log('model-check', outcome=result['tampered']['outcome'], reason='проверка защиты: подставлено число ' + str(invented), synthetic=True)
        return result

    # -- скилы ----------------------------------------------------------------------------
    ROLES = ('Руководитель', 'Аналитик', 'Владелец опроса', 'Все')

    def skills(self, request=None):
        with self.db() as db:
            rows = db.execute('SELECT document FROM pulse_skills ORDER BY created DESC LIMIT 300').fetchall()
        return {'skills': [json.loads(r[0]) for r in rows]}

    def skill_save(self, request):
        role = request.get('role') if request.get('role') in self.ROLES else 'Все'
        skill = {'id': uuid.uuid4().hex, 'created': now(), 'name': clean_text(request.get('name'), 'Название', 120, True),
                 'query': clean_text(request.get('query'), 'Запрос', 1200, True), 'role': role,
                 'author': clean_text(request.get('author'), 'Автор', 80), 'runs': 0, 'kind': 'dialog'}
        with self.db() as db:
            db.execute('INSERT INTO pulse_skills VALUES(?,?,?)', (skill['id'], skill['created'], json.dumps(skill, ensure_ascii=False)))
        self.log('skill-saved', skillId=skill['id'])
        return skill

    def skill_delete(self, request):
        ident = request.get('skillId')
        if not isinstance(ident, str) or not re.fullmatch(r'[0-9a-f]{32}', ident):
            raise ValueError('Скил не найден.')
        with self.db() as db:
            db.execute('DELETE FROM pulse_skills WHERE id=?', (ident,))
        return {'deleted': ident}

    def skill_run(self, request):
        ident = request.get('skillId')
        if isinstance(ident, str) and re.fullmatch(r'[0-9a-f]{32}', ident):
            with self.db() as db:
                row = db.execute('SELECT document FROM pulse_skills WHERE id=?', (ident,)).fetchone()
                if row:
                    skill = json.loads(row[0])
                    skill['runs'] = skill.get('runs', 0) + 1
                    skill['lastRun'] = now()
                    db.execute('UPDATE pulse_skills SET document=? WHERE id=?', (json.dumps(skill, ensure_ascii=False), ident))
        self.log('skill-run', skillId=ident if isinstance(ident, str) else None, builtin=clean_text(request.get('builtin'), 'Шаблон', 120))
        return {'ok': True}

    # -- мой экран ---------------------------------------------------------------------------
    TILE_KINDS = ('kpi', 'chart', 'signals', 'forecast', 'shifts', 'note')

    @property
    def screen_path(self):
        return self.root / '.local-data' / 'pulse-screen.json'

    def screen_get(self, request=None):
        try:
            value = json.loads(self.screen_path.read_text(encoding='utf-8'))
            if isinstance(value, dict) and isinstance(value.get('tiles'), list):
                return value
        except (OSError, ValueError):
            pass
        return {'tiles': None}

    def screen_save(self, request):
        from data_trust import atomic_json
        tiles = request.get('tiles')
        if not isinstance(tiles, list) or len(tiles) > 24:
            raise ValueError('На экране может быть до 24 плиток.')
        clean = []
        for tile in tiles:
            if not isinstance(tile, dict) or tile.get('kind') not in self.TILE_KINDS:
                raise ValueError('Некорректная плитка.')
            item = {'kind': tile['kind'], 'wide': bool(tile.get('wide'))}
            for key, limit in (('title', 120), ('product', 200), ('metric', 20), ('channel', 20), ('text', 600)):
                if tile.get(key) is not None:
                    item[key] = clean_text(tile.get(key), 'Поле плитки', limit)
            if tile.get('id') is not None:
                if type(tile['id']) is not int or not 1 <= tile['id'] <= 9999999:
                    raise ValueError('Некорректный номер опроса в плитке.')
                item['id'] = tile['id']
            if tile.get('days') is not None:
                if tile['days'] not in (14, 30, 60, 90):
                    raise ValueError('Период плитки: 14, 30, 60 или 90 дней.')
                item['days'] = tile['days']
            clean.append(item)
        value = {'tiles': clean, 'saved': now(), 'name': clean_text(request.get('name'), 'Название экрана', 80) or 'Мой экран'}
        atomic_json(self.screen_path, value)
        return value


    # -- воронка: события → политика контактов → стоп-листы → отправки → ответы → отклик ----
    def funnel(self, request):
        state, revision = self.snapshot()
        channel = request.get('channel') or 'communication'
        if channel not in CHANNELS:
            raise ValueError('Выберите канал воронки.')
        ids = request.get('ids')
        if ids is not None and (not isinstance(ids, list) or len(ids) > 600 or any(type(i) is not int or not 1 <= i <= 9999999 for i in ids)):
            raise ValueError('Некорректный список опросов.')
        product = clean_text(request.get('product'), 'Продукт', 200) or None
        grain = request.get('grain') or 'month'
        if grain not in ('month', 'week', 'day'):
            raise ValueError('Группировка воронки: месяц, неделя или день.')
        start, end = request.get('start'), request.get('end')
        if not isinstance(start, str) or not isinstance(end, str) or not re.fullmatch(r'\d{4}-\d{2}(-\d{2})?', start) or not re.fullmatch(r'\d{4}-\d{2}(-\d{2})?', end):
            raise ValueError('Укажите период воронки.')
        first = dt.date.fromisoformat(start if len(start) == 10 else start + '-01')
        last = dt.date.fromisoformat(end) if len(end) == 10 else dt.date(int(end[:4]), int(end[5:7]), calendar.monthrange(int(end[:4]), int(end[5:7]))[1])
        if grain == 'week' and len(end) == 10:
            last = last + dt.timedelta(days=6)
        selected = [s for s in self.surveys(state, channel, None, product) if ids is None or s['event']['id'] in set(ids)]
        if not selected:
            raise ValueError('Нет опросов для воронки в канале «' + CHANNEL_LABELS[channel] + '».')
        names = {s['event']['id']: s['meta']['name'] for s in selected}
        keys = [(channel, s['event']['id']) for s in selected]
        rows = self.daily(revision, keys, first.isoformat(), last.isoformat())
        if not rows:
            raise ValueError('Для воронки нужны дневные строки выгрузки за выбранный период.')
        def period_of(date):
            if grain == 'day':
                return date
            if grain == 'week':
                d = dt.date.fromisoformat(date)
                return (d - dt.timedelta(days=d.weekday())).isoformat()
            return date[:7]
        cutoffs = channel == 'communication'
        # Шаги отсечений берутся из справочника статусов (админка): активные группы с ролью «отсечение» по порядку.
        statuses = getattr(self, 'statuses', None)
        if statuses is None:
            from status_admin import StatusDirectory
            statuses = self.statuses = StatusDirectory(self.engine.root, self.engine.store)
        mapping, groups, ungrouped, status_settings = statuses.classifier()
        loss_groups = [g for g in groups if g['funnel_role'] == 'loss' and (g['active'] or g['slug'] == ungrouped['slug'])] if cutoffs else []
        loss_slugs = {g['slug'] for g in loss_groups}
        status_rows = self.engine.store.status_days(revision, keys, first.isoformat(), last.isoformat()) if cutoffs else []
        by_period, by_survey = defaultdict(list), defaultdict(list)
        for row in rows:
            by_period[period_of(row['date'])].append(row)
            by_survey[row['survey_id']].append(row)
        loss_period, loss_survey = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
        code_period, code_survey = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
        neutral = defaultdict(int)
        for row in status_rows:
            try:
                code = int(row['status'])
            except (TypeError, ValueError):
                continue
            group = mapping.get(code, (ungrouped, None))[0]
            if group['funnel_role'] == 'delivered':
                continue
            lost = (row['events'] or 0) - (row['sends'] or 0)  # отправленная часть уже в шаге «Отправки»
            if lost <= 0:
                continue
            slug = group['slug'] if group['slug'] in loss_slugs else ungrouped['slug']
            if group['funnel_role'] == 'neutral':
                neutral[period_of(row['date'])] += lost
                continue
            loss_period[period_of(row['date'])][slug] += lost
            loss_survey[row['survey_id']][slug] += lost
            code_period[period_of(row['date'])][code] += lost
            code_survey[row['survey_id']][code] += lost
        def steps(items, losses=None, codes=None):
            total = lambda key: sum(r.get(key) or 0 for r in items)
            events, sends, answers = total('events'), total('sends'), total('answers')
            share = lambda v: v / events * 100 if v is not None and events else None
            result = {'events': events, 'sends': sends, 'answers': answers, 'sendShare': share(sends), 'answerShare': share(answers),
                      'response': answers / sends * 100 if sends else None, 'days': len({r['date'] for r in items})}
            if cutoffs:
                losses = losses or {}
                result['groups'] = {g['slug']: {'events': losses.get(g['slug'], 0), 'share': share(losses.get(g['slug'], 0))} for g in loss_groups}
                result['codes'] = {str(c): {'events': v, 'share': share(v)} for c, v in sorted((codes or {}).items(), key=lambda i: -i[1])}
                assigned = sends + sum(losses.values())
                result['unexplained'] = events - assigned if events - assigned > 0 else 0
            else:
                result['groups'], result['codes'] = {}, {}
                result['unexplained'] = max(0, events - sends)
            result['unexplainedShare'] = share(result['unexplained'])
            # совместимость с прежними полями (стоп-лист и политика контактов — утверждённые показатели)
            result.update(stop=total('stop') if cutoffs else None, contactPolicy=total('contactPolicy') if cutoffs else None)
            return result
        def merge(maps):
            out = defaultdict(int)
            for m in maps:
                for k, v in m.items():
                    out[k] += v
            return out
        total_losses, total_codes = merge(loss_period.values()), merge(code_period.values())
        surveys = sorted(({'id': ident, 'name': names.get(ident, 'Опрос ' + str(ident)), **steps(items, loss_survey.get(ident), code_survey.get(ident))}
                          for ident, items in by_survey.items()), key=lambda r: -(r['events'] or 0))[:40]
        labels = {}
        for g in groups:
            for c in g['codes']:
                labels[str(c['code'])] = {'label': c['label'], 'description': c['description'], 'group': g['slug']}
        return {'channel': channel, 'channelLabel': CHANNEL_LABELS[channel], 'grain': grain, 'cutoffs': cutoffs,
                'from': min(r['date'] for r in rows), 'to': max(r['date'] for r in rows),
                'lossGroups': [{'slug': g['slug'], 'name': g['name'], 'color': g['color'], 'description': g['description'],
                                'codes': [c['code'] for c in g['codes']]} for g in loss_groups],
                'codeLabels': labels, 'statusRevision': statuses.tree()['revision'], 'drillDown': status_settings['drill_down'],
                'total': steps(rows, total_losses, total_codes),
                'periods': [{'key': key, **steps(by_period[key], loss_period.get(key), code_period.get(key))} for key in sorted(by_period)],
                'surveys': surveys, 'surveyCount': len(by_survey), 'unknownCodes': statuses.unknown_codes(status_rows)[:20],
                'method': ('Воронка по дневным строкам выгрузки. События = 100%. Шаги отсечений — активные группы справочника статусов '
                           '(Администрирование → Статусы) с ролью «отсечение», в их порядке и с их названиями; неотправленная часть событий '
                           'каждого status_det относится к группе своего кода. Коды без группы, выключенные коды и группы — в «Без группы». '
                           'Отправки и ответы — доля от событий; отклик = ответы / отправки.')
                          if cutoffs else
                          'Воронка по дневным строкам выгрузки. События = 100%; отправки — события со статусом SENDED; ответы — доля от событий; '
                          'отклик = ответы / отправки. Статусы status_det и их группы относятся к пуш+СМС; для экранов успеха отсечений нет.'}

    # -- холсты: один объект вместо разделов -------------------------------------------
    BLOCK_KINDS = ('status', 'problems', 'kpi', 'chart', 'compare', 'forecast', 'signals', 'shifts', 'portfolio', 'note')
    BLOCK_METRICS = ('sends', 'answers', 'events', 'csi', 'responseRate')
    BLOCK_SPANS = (3, 4, 6, 8, 12)

    @property
    def canvases_path(self):
        return self.root / '.local-data' / 'pulse-canvases.json'

    def canvas_read(self):
        try:
            value = json.loads(self.canvases_path.read_text(encoding='utf-8'))
            if isinstance(value, dict) and isinstance(value.get('canvases'), list):
                return value
        except (OSError, ValueError):
            pass
        value = {'canvases': [], 'active': None}
        legacy = self.screen_get()
        if legacy.get('tiles'):
            blocks = []
            for tile in legacy['tiles']:
                try:
                    block = dict(tile)
                    block['span'] = 12 if tile.get('wide') else (3 if tile.get('kind') == 'kpi' else 6)
                    blocks.append(self.clean_block(block))
                except ValueError:
                    continue
            canvas = {'id': uuid.uuid4().hex[:10], 'name': legacy.get('name') or 'Мой экран', 'blocks': blocks,
                      'created': legacy.get('saved') or now(), 'updated': legacy.get('saved') or now(), 'template': 'legacy'}
            value = {'canvases': [canvas], 'active': canvas['id']}
        return value

    def clean_target(self, target):
        if not isinstance(target, dict):
            raise ValueError('Некорректный объект блока.')
        channel = target.get('channel') or 'communication'
        if channel not in CHANNELS:
            raise ValueError('Неизвестный канал в блоке.')
        ident = target.get('id')
        if ident is not None and (type(ident) is not int or not 1 <= ident <= 9999999):
            raise ValueError('Некорректный номер опроса в блоке.')
        product = clean_text(target.get('product'), 'Продукт', 200) or None
        return {'channel': channel, 'id': ident, 'product': None if ident is not None else product}

    def clean_block(self, block):
        if not isinstance(block, dict) or block.get('kind') not in self.BLOCK_KINDS:
            raise ValueError('Некорректный блок холста.')
        uid = block.get('uid')
        item = {'kind': block['kind'], 'uid': uid if isinstance(uid, str) and re.fullmatch(r'[a-z0-9]{4,16}', uid) else uuid.uuid4().hex[:10],
                'span': block['span'] if block.get('span') in self.BLOCK_SPANS else 6}
        for key, limit in (('title', 120), ('product', 200), ('text', 1200), ('question', 400)):
            if block.get(key) is not None:
                value = clean_text(block.get(key), 'Поле блока', limit)
                if value:
                    item[key] = value
        if block.get('channel') is not None:
            if block['channel'] not in CHANNELS:
                raise ValueError('Неизвестный канал в блоке.')
            item['channel'] = block['channel']
        if block.get('metric') is not None:
            if block['metric'] not in self.BLOCK_METRICS:
                raise ValueError('Неизвестный показатель в блоке.')
            item['metric'] = block['metric']
        if block.get('id') is not None:
            if type(block['id']) is not int or not 1 <= block['id'] <= 9999999:
                raise ValueError('Некорректный номер опроса в блоке.')
            item['id'] = block['id']
            item.pop('product', None)
        if block.get('days') is not None:
            if block['days'] not in (14, 30, 60, 90, 180, 365):
                raise ValueError('Период блока: 14, 30, 60, 90, 180 или 365 дней.')
            item['days'] = block['days']
        if block.get('grain') in ('week', 'month'):
            item['grain'] = block['grain']
        if block.get('labels') in ('none', 'key', 'all'):
            item['labels'] = block['labels']
        if block.get('index'):
            item['index'] = True
        if block['kind'] == 'compare':
            items = block.get('items')
            if not isinstance(items, list) or not 1 <= len(items) <= 5:
                raise ValueError('В блоке сравнения — от одного до пяти объектов.')
            item['items'] = [self.clean_target(t) for t in items]
        if block.get('bind'):
            item['bind'] = True  # блок берёт объект и период из параметров холста
        if block['kind'] == 'portfolio' and block.get('groupBy') in self.GROUPINGS:
            item['groupBy'] = block['groupBy']
        return item

    def clean_params(self, params):
        """Параметры холста: объект (опрос или продукт), период и группировка. Пустые — блоки используют свои значения."""
        if params is None:
            return {}
        if not isinstance(params, dict):
            raise ValueError('Некорректные параметры холста.')
        clean = {}
        if params.get('target'):
            target = self.clean_target(params['target'])
            if target['id'] is None and target['product'] is None:
                raise ValueError('Параметр холста: выберите опрос или продукт.')
            clean['target'] = target
        if params.get('days') is not None:
            if params['days'] not in (14, 30, 60, 90, 180, 365):
                raise ValueError('Период холста: 14, 30, 60, 90, 180 или 365 дней.')
            clean['days'] = params['days']
        if params.get('grain') in ('day', 'week', 'month'):
            clean['grain'] = params['grain']
        return clean

    # -- шаблоны команды: файл в папке проекта, переносится вместе с ней ------------------------
    @property
    def templates_path(self):
        return self.root / '.local-data' / 'canvas-templates.json'

    def canvas_templates(self, request=None):
        try:
            value = json.loads(self.templates_path.read_text(encoding='utf-8'))
            items = value.get('templates', []) if isinstance(value, dict) else []
        except (OSError, ValueError):
            items = []
        return {'templates': items}

    def canvas_template_save(self, request):
        from data_trust import atomic_json
        template = request.get('template')
        if not isinstance(template, dict):
            raise ValueError('Нет шаблона для сохранения.')
        blocks = template.get('blocks')
        if not isinstance(blocks, list) or not 1 <= len(blocks) <= 30:
            raise ValueError('В шаблоне должен быть хотя бы один блок (до 30).')
        name = clean_text(template.get('name'), 'Название шаблона', 80, True)
        params = self.clean_params(template.get('params'))
        if not template.get('keepTarget'):
            params.pop('target', None)  # шаблон — для любого объекта; объект выбирают при создании
        clean = {'id': uuid.uuid4().hex[:10], 'name': name, 'description': clean_text(template.get('description'), 'Описание шаблона', 300),
                 'author': clean_text(template.get('author'), 'Автор', 80), 'created': now(), 'params': params,
                 'blocks': [{k: v for k, v in self.clean_block(b).items() if k != 'question'} for b in blocks]}
        clean['needsTarget'] = any(b.get('bind') for b in clean['blocks']) and 'target' not in params
        items = [t for t in self.canvas_templates()['templates'] if t.get('name', '').casefold() != name.casefold()]
        if len(items) >= 50:
            raise ValueError('Шаблонов может быть до 50 — удалите ненужный.')
        items.append(clean)
        atomic_json(self.templates_path, {'version': 1, 'templates': items})
        self.log('canvas-template-saved')
        return {'templates': items, 'template': clean}

    def canvas_template_delete(self, request):
        from data_trust import atomic_json
        items = self.canvas_templates()['templates']
        rest = [t for t in items if t.get('id') != request.get('id')]
        if len(rest) == len(items):
            raise ValueError('Шаблон не найден.')
        atomic_json(self.templates_path, {'version': 1, 'templates': rest})
        return {'templates': rest}

    # -- сборка холста по задаче --------------------------------------------------------------
    PLAN_KINDS = ('status', 'problems', 'kpi', 'chart', 'compare', 'forecast', 'signals', 'shifts', 'portfolio', 'note')

    def canvas_plan(self, request):
        """Задача словами → план холста (блоки, объект, период). Модель выбирает только блоки и объекты из справочника;
        числа считает платформа. Без модели — локальный планировщик по ключевым словам."""
        query = clean_text(request.get('query'), 'Задача', 600, True)
        state, _ = self.snapshot()
        local = plan_canvas(query, state)
        local['source'] = 'Локальный планировщик'
        if not request.get('useModel') or not self.model_ready():
            return self.finish_plan(local)
        try:
            return self.finish_plan(self.checked(lambda: self.canvas_plan_model(query, state)))
        except Exception as error:  # сборка не должна срываться из-за CLI
            local['notes'].append('GigaCode не собрала план (' + str(error)[:140] + ') — показан локальный план.')
            return self.finish_plan(local)

    def finish_plan(self, plan):
        plan['blocks'] = [self.clean_block(b) for b in plan['blocks'][:12]]
        plan['params'] = self.clean_params(plan.get('params'))
        self.log('canvas-plan', source='model' if plan['source'].startswith('GigaCode') else 'local', blocks=len(plan['blocks']))
        return plan

    def canvas_plan_model(self, query, state):
        products = sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=str.casefold)[:60]
        stems = lambda text: {w[:5] for w in re.findall(r'[а-яa-z]{4,}', text.lower().replace('ё', 'е'))}
        asked, numbers = stems(query), {int(n) for n in re.findall(r'\d{2,7}', query)}
        surveys = [{'id': s['event']['id'], 'name': s['meta']['name'], 'channel': s['meta']['channel']} for s in state['surveys']
                   if s['event']['id'] in numbers or asked & stems(s['meta']['name'])][:40]
        result = self.call_model('pulse-canvas-plan',
            'Собери план холста-дашборда под задачу руководителя. Верни один JSON {"name":"короткое название без цифр",'
            '"target":null|{"id":int}|{"product":"..."},"days":null|14|30|60|90|180|365,"grain":null|"day"|"week"|"month",'
            '"blocks":[{"kind":"status|problems|kpi|chart|compare|forecast|signals|shifts|portfolio|note","metric":null|"sends|answers|events|csi|responseRate",'
            '"bind":true|false,"targets":[{"id":int}|{"product":"..."}],"text":"только для note, без цифр"}]}. '
            'От 3 до 10 блоков. bind=true — блок следует за target холста. Опросы — только из surveys, продукты — только из products. '
            'Ничего не вычисляй и не пиши чисел в text.',
            {'userQuery': query, 'products': products, 'surveys': surveys, 'kinds': list(self.PLAN_KINDS)}, query)
        if not isinstance(result, dict) or not isinstance(result.get('blocks'), list) or not 1 <= len(result['blocks']) <= 12:
            raise ValueError('Ответ модели не соответствует формату плана.')
        known = {s['id']: s['channel'] for s in surveys}
        def target_of(t):
            if isinstance(t, dict) and type(t.get('id')) is int and t['id'] in known:
                return {'channel': known[t['id']], 'id': t['id'], 'product': None}
            if isinstance(t, dict) and t.get('product') in products:
                return {'channel': 'communication', 'id': None, 'product': t['product']}
            raise ValueError('Модель выбрала опрос или продукт, которого нет в справочнике.')
        params = {}
        if result.get('target'):
            params['target'] = target_of(result['target'])
        if result.get('days') in (14, 30, 60, 90, 180, 365):
            params['days'] = result['days']
        if result.get('grain') in ('week', 'month'):
            params['grain'] = result['grain']
        blocks = []
        for item in result['blocks']:
            if not isinstance(item, dict) or item.get('kind') not in self.PLAN_KINDS:
                raise ValueError('Модель предложила неизвестный тип блока.')
            if item['kind'] == 'note':
                note = clean_text(item.get('text'), 'Заметка', 300) or 'Вывод: '
                if re.search(r'\d', note):
                    raise ValueError('Модель добавила числа в текст заметки. План отклонён.')
                blocks.append({'kind': 'note', 'span': 6, 'text': note})
                continue
            targets = [target_of(t) for t in (item.get('targets') or [])[:5]]
            block = build_canvas_block(item['kind'] if item['kind'] in ('chart', 'compare', 'forecast', 'problems', 'signals', 'shifts', 'portfolio', 'status') else 'chart',
                                       item.get('metric'), None, (targets[0]['channel'] if targets else 'communication'), targets)
            if item['kind'] == 'kpi':
                block = {'kind': 'kpi', 'metric': item.get('metric') if item.get('metric') in ('answers', 'sends', 'csi', 'responseRate') else 'answers', 'span': 3,
                         'channel': 'communication'}
            if item.get('bind') or (not targets and item['kind'] in BINDABLE):
                block['bind'] = True
            blocks.append(block)
        name = clean_text(result.get('name'), 'Название', 80) or 'Холст по задаче'
        if re.search(r'\d', name):
            name = re.sub(r'\d+', '', name).strip(' ·-') or 'Холст по задаче'
        return {'name': name, 'blocks': blocks, 'params': params, 'notes': [], 'query': query,
                'source': 'GigaCode CLI · блоки и объекты проверены по справочнику, чисел от модели нет'}

    def canvas_list(self, request=None):
        return self.canvas_read()

    def canvas_save(self, request):
        from data_trust import atomic_json
        canvas = request.get('canvas')
        if not isinstance(canvas, dict):
            raise ValueError('Нет холста для сохранения.')
        blocks = canvas.get('blocks')
        if not isinstance(blocks, list) or len(blocks) > 30:
            raise ValueError('На холсте может быть до 30 блоков.')
        name = clean_text(canvas.get('name'), 'Название холста', 80, True)
        value = self.canvas_read()
        ident = canvas.get('id')
        found = next((c for c in value['canvases'] if c['id'] == ident), None) if isinstance(ident, str) else None
        clean = {'id': found['id'] if found else uuid.uuid4().hex[:10], 'name': name, 'blocks': [self.clean_block(b) for b in blocks],
                 'created': found['created'] if found else now(), 'updated': now(),
                 'template': clean_text(canvas.get('template'), 'Шаблон', 40) or (found or {}).get('template'),
                 'params': self.clean_params(canvas.get('params'))}
        if found:
            value['canvases'][value['canvases'].index(found)] = clean
        else:
            if len(value['canvases']) >= 30:
                raise ValueError('Холстов может быть до 30 — удалите ненужный.')
            value['canvases'].append(clean)
            self.log('canvas-created', template=clean['template'])
        value['active'] = clean['id']
        atomic_json(self.canvases_path, value)
        return {**value, 'canvas': clean}

    def canvas_open(self, request):
        from data_trust import atomic_json
        value = self.canvas_read()
        if not any(c['id'] == request.get('id') for c in value['canvases']):
            raise ValueError('Холст не найден.')
        value['active'] = request['id']
        atomic_json(self.canvases_path, value)
        return value

    def canvas_delete(self, request):
        from data_trust import atomic_json
        value = self.canvas_read()
        before = len(value['canvases'])
        value['canvases'] = [c for c in value['canvases'] if c['id'] != request.get('id')]
        if len(value['canvases']) == before:
            raise ValueError('Холст не найден.')
        if value.get('active') == request.get('id'):
            value['active'] = value['canvases'][0]['id'] if value['canvases'] else None
        atomic_json(self.canvases_path, value)
        return value

    def canvas_ask(self, request):
        """Вопрос → описание блока. Числа блок потом считает платформа; модель (если нужна) выбирает только тип и объекты."""
        query = clean_text(request.get('query'), 'Вопрос', 400, True)
        state, _ = self.snapshot()
        parsed = parse_canvas_query(query, state)
        parsed['source'] = 'Локальный разбор вопроса'
        if parsed['understood'] or not request.get('useModel') or not self.model_ready():
            parsed['block'] = self.clean_block(parsed['block'])
            self.log('canvas-ask', source='local', block=parsed['block']['kind'])
            return parsed
        try:
            return self.checked(lambda: self.canvas_ask_model(query, state))
        except Exception as error:  # вопрос не должен срываться из-за CLI: показываем локальный разбор
            parsed['block'] = self.clean_block(parsed['block'])
            parsed['notes'].append('GigaCode не помогла разобрать вопрос (' + str(error)[:140] + ') — показан локальный разбор.')
            return parsed

    def canvas_ask_model(self, query, state):
        products = sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=str.casefold)[:60]
        stems = lambda text: {w[:5] for w in re.findall(r'[а-яa-z]{4,}', text.lower().replace('ё', 'е'))}
        asked = stems(query)
        surveys = [{'id': s['event']['id'], 'name': s['meta']['name'], 'channel': s['meta']['channel']} for s in state['surveys']
                   if asked & stems(s['meta']['name'])][:40]
        result = self.call_model('pulse-canvas',
            'Переведи вопрос руководителя в блок холста. Верни один JSON {"kind":"chart"|"compare"|"forecast"|"problems"|"signals"|"shifts"|"portfolio"|"status",'
            '"metric":null|"sends"|"answers"|"events"|"csi"|"responseRate","days":null|14|30|60|90,"channel":"communication"|"success_screen",'
            '"targets":[{"id":int}|{"product":"..."}]}. Опросы — только из surveys, продукты — только из products, не больше пяти. Ничего не вычисляй.',
            {'userQuery': query, 'products': products, 'surveys': surveys}, query)
        if not isinstance(result, dict) or set(result) - {'kind', 'metric', 'days', 'channel', 'targets'}:
            raise ValueError('Ответ модели не соответствует формату блока.')
        targets = result.get('targets') or []
        if not isinstance(targets, list) or len(targets) > 5:
            raise ValueError('Модель вернула некорректный список объектов.')
        known = {s['id']: s['channel'] for s in surveys}
        channel = result.get('channel') if result.get('channel') in CHANNELS else 'communication'
        clean_targets = []
        for t in targets:
            if isinstance(t, dict) and type(t.get('id')) is int and t['id'] in known:
                clean_targets.append({'channel': known[t['id']], 'id': t['id'], 'product': None})
            elif isinstance(t, dict) and t.get('product') in products:
                clean_targets.append({'channel': channel, 'id': None, 'product': t['product']})
            else:
                raise ValueError('Модель выбрала опрос или продукт, которого нет в справочнике.')
        block = build_canvas_block(result.get('kind'), result.get('metric'), result.get('days'), channel, clean_targets)
        block['question'] = query
        self.log('canvas-ask', source='model', block=block['kind'])
        return {'block': self.clean_block(block), 'understood': True, 'notes': [], 'source': 'GigaCode CLI · тип блока и объекты проверены по справочнику'}


    # -- мой фокус: топ + избранные ---------------------------------------------------
    @property
    def focus_path(self):
        return self.root / '.local-data' / 'pulse-focus.json'

    def focus_store(self):
        try:
            value = json.loads(self.focus_path.read_text(encoding='utf-8'))
            favorites = [[c, i] for c, i in value.get('favorites', []) if c in CHANNELS and type(i) is int]
            return {'favorites': favorites}
        except (OSError, ValueError, AttributeError, TypeError):
            return {'favorites': []}

    def focus_keys(self, state):
        favorites = {tuple(k) for k in self.focus_store()['favorites']}
        return {(s['meta']['channel'], s['event']['id']) for s in state['surveys']
                if s['event'].get('isTop') or (s['meta']['channel'], s['event']['id']) in favorites}

    def focus_get(self, request=None):
        state, _ = self.snapshot()
        favorites = {tuple(k) for k in self.focus_store()['favorites']}
        rows = [{'channel': s['meta']['channel'], 'channelLabel': CHANNEL_LABELS[s['meta']['channel']], 'id': s['event']['id'], 'name': s['meta']['name'],
                 'products': s['meta'].get('products', []), 'top': bool(s['event'].get('isTop')),
                 'favorite': (s['meta']['channel'], s['event']['id']) in favorites}
                for s in state['surveys'] if s['event'].get('isTop') or (s['meta']['channel'], s['event']['id']) in favorites]
        rows.sort(key=lambda r: (not r['favorite'], r['channel'], r['id']))
        return {'surveys': rows, 'favorites': len(favorites), 'top': sum(r['top'] for r in rows)}

    def focus_toggle(self, request):
        from data_trust import atomic_json
        channel, ident = request.get('channel'), request.get('id')
        if channel not in CHANNELS or type(ident) is not int:
            raise ValueError('Выберите опрос для избранного.')
        store = self.focus_store()
        key = [channel, ident]
        on = request.get('on')
        present = key in store['favorites']
        if on is None:
            on = not present
        if on and not present:
            store['favorites'].append(key)
        if not on and present:
            store['favorites'].remove(key)
        atomic_json(self.focus_path, store)
        self.ensure_brief(True)
        return {'favorite': bool(on), 'favorites': len(store['favorites'])}

    # -- статус банка: показываем, только если есть серьёзная проблема -------------------------
    BANK_ANSWERS_ALERT = -10.0
    BANK_CSI_ALERT = -0.1

    def bank_status(self, state, revision):
        output = []
        for channel in CHANNELS:
            keys = [(channel, s['event']['id']) for s in self.surveys(state, channel)]
            latest = self.last_day(revision, keys)
            if not latest:
                continue
            end = dt.date.fromisoformat(latest)
            rows = self.daily(revision, keys, (end - dt.timedelta(days=27)).isoformat(), latest)
            cut = (end - dt.timedelta(days=13)).isoformat()
            current = [r for r in rows if r['date'] >= cut]
            previous = [r for r in rows if r['date'] < cut]
            a_now = sum(r['answers'] or 0 for r in current)
            a_prev = sum(r['answers'] or 0 for r in previous)
            csi_now, _ = weighted_csi(current)
            csi_prev, _ = weighted_csi(previous)
            answers_change = (a_now - a_prev) / a_prev * 100 if a_prev else None
            csi_change = csi_now - csi_prev if csi_now is not None and csi_prev is not None else None
            reasons = []
            if answers_change is not None and answers_change <= self.BANK_ANSWERS_ALERT:
                reasons.append('ответы ' + signed_pct(answers_change))
            if csi_change is not None and csi_change <= self.BANK_CSI_ALERT:
                reasons.append('CSI ' + signed_num(csi_change))
            output.append({'channel': channel, 'label': CHANNEL_LABELS[channel], 'through': latest, 'surveys': len(keys),
                           'answers': a_now, 'answersPrevious': a_prev, 'answersChange': answers_change,
                           'csi': csi_now, 'csiChange': csi_change, 'alert': bool(reasons), 'reasons': reasons,
                           'window': [(end - dt.timedelta(days=13)).isoformat(), latest]})
        return output

    # -- портфель групп --------------------------------------------------------------------
    GROUPINGS = {'product': 'Продукт', 'surveyType': 'Тип опроса', 'triggerGroup': 'Группа триггеров', 'top': 'Топ / остальные'}

    def portfolio(self, request):
        state, revision = self.snapshot()
        channel = request.get('channel') or 'communication'
        group_by = request.get('groupBy') or 'product'
        if channel not in CHANNELS or group_by not in self.GROUPINGS:
            raise ValueError('Выберите канал и группировку.')
        selected = self.surveys(state, channel)
        keys = [(channel, s['event']['id']) for s in selected]
        latest = self.last_day(revision, keys)
        if not latest:
            raise ValueError('Нет дневных данных по каналу «' + CHANNEL_LABELS[channel] + '».')
        end = dt.date.fromisoformat(latest)
        month_start = end.replace(day=1)
        month_days = calendar.monthrange(end.year, end.month)[1]
        start = min(month_start, end - dt.timedelta(days=13))
        rows = self.daily(revision, keys, start.isoformat(), latest)
        by_survey = defaultdict(list)
        for row in rows:
            by_survey[row['survey_id']].append(row)
        cut, prior = (end - dt.timedelta(days=6)).isoformat(), (end - dt.timedelta(days=13)).isoformat()
        brief = self.cached_brief(revision) or {}
        shift_ids = defaultdict(int)
        for shift in brief.get('shifts', []):
            if shift['channel'] == channel and shift['direction'] == 'down':
                shift_ids[shift['id']] += 1
        signal_ids = {s['id'] for s in brief.get('signals', []) if s['channel'] == channel}
        favorites = {tuple(k) for k in self.focus_store()['favorites']}
        members = []
        for survey in selected:
            ident, meta = survey['event']['id'], survey['meta']
            items = by_survey.get(ident, [])
            now_rows = [r for r in items if r['date'] >= cut]
            prev_rows = [r for r in items if prior <= r['date'] < cut]
            mtd = [r for r in items if r['date'] >= month_start.isoformat()]
            csi_now, sample_now = weighted_csi(now_rows)
            csi_prev, sample_prev = weighted_csi(prev_rows)
            members.append({'id': ident, 'name': meta['name'], 'products': meta.get('products', []) or ['без продукта'],
                            'surveyType': meta.get('surveyType') or 'без типа', 'triggerGroup': meta.get('triggerGroup') or 'без группы',
                            'top': bool(survey['event'].get('isTop')), 'favorite': (channel, ident) in favorites,
                            'observed': bool(items), 'answers': sum(r['answers'] or 0 for r in now_rows),
                            'answersPrevious': sum(r['answers'] or 0 for r in prev_rows), 'sends': sum(r['sends'] or 0 for r in now_rows),
                            'csiWeight': sum(r.get('csiWeight') or 0 for r in now_rows), 'csiSample': sample_now,
                            'csiWeightPrevious': sum(r.get('csiWeight') or 0 for r in prev_rows), 'csiSamplePrevious': sample_prev,
                            'csi': csi_now, 'csiPrevious': csi_prev, 'mtdAnswers': sum(r['answers'] or 0 for r in mtd),
                            'plan': meta.get('plan'), 'shifts': shift_ids.get(ident, 0), 'signal': ident in signal_ids})
        def keys_of(member):
            if group_by == 'product':
                return member['products']
            if group_by == 'top':
                return ['Топ-опросы' if member['top'] else 'Остальные']
            return [member[group_by]]
        groups = defaultdict(list)
        for member in members:
            for key in keys_of(member):
                groups[key].append(member)
        elapsed = end.day / month_days
        output = []
        for name, items in groups.items():
            answers = sum(m['answers'] for m in items)
            previous = sum(m['answersPrevious'] for m in items)
            sample = sum(m['csiSample'] for m in items)
            sample_prev = sum(m['csiSamplePrevious'] for m in items)
            csi = sum(m['csiWeight'] for m in items) / sample if sample else None
            csi_prev = sum(m['csiWeightPrevious'] for m in items) / sample_prev if sample_prev else None
            planned = [m for m in items if m['plan']]
            expected = sum(m['plan'] * elapsed for m in planned)
            pace = sum(m['mtdAnswers'] for m in planned) / expected * 100 if expected else None
            change = (answers - previous) / previous * 100 if previous else None
            csi_delta = csi - csi_prev if csi is not None and csi_prev is not None else None
            problems = sum(1 for m in items if m['shifts'] or m['signal'])
            level = 'ok'
            if (change is not None and change <= -15) or (csi_delta is not None and csi_delta <= -.1) or (pace is not None and pace < 75):
                level = 'bad'
            elif (change is not None and change <= -5) or (csi_delta is not None and csi_delta <= -.05) or (pace is not None and pace < 90) or problems:
                level = 'warn'
            output.append({'name': name, 'surveys': len(items), 'observed': sum(m['observed'] for m in items), 'answers': answers,
                           'answersPrevious': previous, 'answersChange': change, 'sends': sum(m['sends'] for m in items),
                           'responseRate': answers / sum(m['sends'] for m in items) * 100 if sum(m['sends'] for m in items) else None,
                           'csi': csi, 'csiChange': csi_delta, 'planPace': pace, 'planned': len(planned), 'problems': problems,
                           'level': level, 'members': sorted(items, key=lambda m: (-(m['shifts'] + m['signal']), -m['answers']))})
        output.sort(key=lambda g: ({'bad': 0, 'warn': 1, 'ok': 2}[g['level']], -g['answers']))
        return {'channel': channel, 'channelLabel': CHANNEL_LABELS[channel], 'groupBy': group_by, 'groupLabel': self.GROUPINGS[group_by],
                'groupings': self.GROUPINGS, 'through': latest, 'window': [cut, latest], 'previousWindow': [prior, (end - dt.timedelta(days=7)).isoformat()],
                'month': end.strftime('%Y-%m'), 'groups': output, 'surveys': len(members),
                'method': 'Ответы — последние 7 дней к предыдущим 7 по ' + latest + '. CSI — средневзвешенный по оценкам 1–5. '
                          'Темп плана — ответы с начала месяца к плану, распределённому по календарным дням (только опросы с планом). '
                          'Красный: ответы −15% и хуже, CSI −0,1 и хуже или темп плана ниже 75%. Жёлтый: ответы −5%, CSI −0,05, темп ниже 90% или есть проблемы.'}

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
        if action == 'effect':
            return self.effect(request)
        if action == 'focus-get':
            return self.focus_get(request)
        if action == 'focus-toggle':
            return self.focus_toggle(request)
        if action == 'portfolio':
            return self.portfolio(request)
        if action == 'journal-add':
            return self.journal_add(request)
        if action == 'event-add':
            return self.event_add(request)
        if action == 'event-impact':
            return self.event_impact(request)
        if action == 'trust-demo':
            return self.trust_demo(request)
        if action == 'skills':
            return self.skills(request)
        if action == 'skill-save':
            return self.skill_save(request)
        if action == 'skill-delete':
            return self.skill_delete(request)
        if action == 'skill-run':
            return self.skill_run(request)
        if action == 'screen-get':
            return self.screen_get(request)
        if action == 'screen-save':
            return self.screen_save(request)
        if action == 'funnel':
            return self.funnel(request)
        if action == 'canvas-list':
            return self.canvas_list(request)
        if action == 'canvas-save':
            return self.canvas_save(request)
        if action == 'canvas-open':
            return self.canvas_open(request)
        if action == 'canvas-delete':
            return self.canvas_delete(request)
        if action == 'canvas-plan':
            return self.canvas_plan(request)
        if action == 'canvas-templates':
            return self.canvas_templates(request)
        if action == 'canvas-template-save':
            return self.canvas_template_save(request)
        if action == 'canvas-template-delete':
            return self.canvas_template_delete(request)
        if action == 'canvas-ask':
            return self.canvas_ask(request)
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
    token = re.sub(r'[ \u00a0\u202f]', '', token).replace('−', '-').replace(',', '.').lstrip('+')
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



CANVAS_KINDS = (
    ('forecast', r'прогноз|план[аеуо]?\b|темп|выполн'),
    ('portfolio', r'портфел|по группам|групп[аы]? опрос'),
    ('signals', r'сигнал'),
    ('shifts', r'сдвиг|устойчив'),
    ('problems', r'проблем|требу[ею]т решени|что горит|что сломал'),
    ('status', r'статус|сводк|как дела|общая картина'),
)
CANVAS_METRICS = (
    ('responseRate', r'отклик|конверси'),
    ('csi', r'\bcsi\b|ксай|оценк|удовлетвор'),
    ('sends', r'отправ|рассыл'),
    ('events', r'событи'),
    ('answers', r'ответ'),
)


def build_canvas_block(kind, metric, days, channel, targets):
    kind = kind if kind in ('chart', 'compare', 'forecast', 'problems', 'signals', 'shifts', 'portfolio', 'status') else 'chart'
    if kind == 'chart' and len(targets) > 1:
        kind = 'compare'
    block = {'kind': kind, 'channel': channel}
    if kind in ('chart', 'compare'):
        block['metric'] = metric or 'answers'
        block['days'] = days if days in (14, 30, 60, 90, 180, 365) else 60
        block['span'] = 12
        if kind == 'compare':
            block['items'] = targets or [{'channel': channel, 'id': None, 'product': None}]
        elif targets:
            block['id'], block['product'], block['channel'] = targets[0]['id'], targets[0]['product'], targets[0]['channel']
    elif kind in ('forecast', 'shifts') and targets:
        block['id'], block['product'], block['channel'] = targets[0]['id'], targets[0]['product'], targets[0]['channel']
        block['span'] = 4 if kind == 'forecast' else 6
    else:
        block['span'] = {'status': 12, 'problems': 8, 'portfolio': 6, 'signals': 6, 'shifts': 6, 'forecast': 4}[kind]
    return block


BINDABLE = ('chart', 'compare', 'forecast', 'kpi', 'problems', 'signals', 'shifts', 'portfolio')
PLAN_INTENTS = (
    ('committee', r'комитет|встреч|совет|правлен|отчет|отчёт|презентац'),
    ('incident', r'почему|причин|просел|просад|упал|паден|снизил|инцидент|разбор|расслед|что случилось'),
    ('plan', r'план|прогноз|выполн|темп'),
    ('portfolio', r'портфел|по группам|по продуктам'),
    ('morning', r'утр|обзор|сводк|статус|ежедневн|мониторинг'),
)


def period_from(q):
    match = re.search(r'(\d{1,3})\s*(?:дн|день|дня)', q)
    if match:
        return min((14, 30, 60, 90, 180, 365), key=lambda d: abs(d - int(match[1])))
    for pattern, days in ((r'\bгод\b|за год|12 месяц', 365), (r'полгода|пол года|6 месяц', 180), (r'квартал|3 месяц|три месяц', 90),
                          (r'2 месяц|два месяц', 60), (r'месяц', 30), (r'недел', 14)):
        if re.search(pattern, q):
            return days
    return None


def plan_canvas(query, state):
    """Локальный планировщик: намерения по ключевым словам + объекты и период из вопроса."""
    parsed = parse_canvas_query(query, state)
    q = query.lower().replace('ё', 'е')
    targets = parsed['block'].get('items') or ([{'channel': parsed['block'].get('channel', 'communication'), 'id': parsed['block'].get('id'),
                                                 'product': parsed['block'].get('product')}] if parsed['block'].get('id') or parsed['block'].get('product') else [])
    intents = [k for k, pattern in PLAN_INTENTS if re.search(pattern, q)] or ['morning']
    metric = parsed['block'].get('metric') if any(re.search(p, q) for _, p in CANVAS_METRICS) else None
    days = period_from(q)
    grain = 'week' if re.search(r'по недел|понедельн|еженедел', q) else 'month' if re.search(r'по месяц|помесячн|ежемесячн', q) else None
    params = {}
    if len(targets) == 1:
        params['target'] = targets[0]
    if days and days != 60:
        params['days'] = days
    if grain:
        params['grain'] = grain
    bound = lambda block: dict(block, bind=True)
    blocks, notes = [], []
    if 'committee' in intents or 'morning' in intents:
        blocks.append({'kind': 'status', 'span': 12})
    if 'committee' in intents:
        compact = len(intents) > 1  # несколько задач сразу — меньше показателей, чтобы холст оставался обозримым
        blocks += [bound({'kind': 'kpi', 'metric': m, 'channel': 'communication', 'span': 6 if compact else 3})
                   for m in (('answers', 'csi') if compact else ('answers', 'sends', 'responseRate', 'csi'))]
    if len(targets) > 1:
        blocks += [{'kind': 'compare', 'metric': m, 'days': days or 60, 'index': True, 'items': targets, 'span': 12, **({'grain': grain} if grain else {})}
                   for m in ([metric] if metric else ['sends', 'answers'])]
    if 'incident' in intents:
        for m in ([metric] if metric else (['sends', 'answers'] if len(intents) > 1 else ['sends', 'answers', 'csi'])):
            blocks.append(bound({'kind': 'chart', 'metric': m, 'days': days or 60, 'channel': 'communication', 'span': 6}))
        blocks += [bound({'kind': 'shifts', 'span': 6}), bound({'kind': 'problems', 'span': 12}),
                   {'kind': 'note', 'span': 6, 'text': 'Гипотеза: '}, {'kind': 'note', 'span': 6, 'text': 'Что проверить и кто: '}]
    elif metric and len(targets) <= 1:
        blocks.append(bound({'kind': 'chart', 'metric': metric, 'days': days or 60, 'channel': 'communication', 'span': 12}))
    if 'plan' in intents:
        if targets or len({p for s in state['surveys'] for p in s['meta'].get('products', [])}) == 0:
            blocks.append(bound({'kind': 'forecast', 'channel': 'communication', 'span': 4}))
        else:
            products = sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=str.casefold)[:4]
            blocks += [{'kind': 'forecast', 'channel': 'communication', 'product': p, 'span': 3} for p in products]
    if 'portfolio' in intents or 'committee' in intents or 'morning' in intents:
        blocks.append(bound({'kind': 'portfolio', 'span': 6 if 'morning' in intents else 12}))
    if 'morning' in intents and 'incident' not in intents:
        blocks += [bound({'kind': 'problems', 'span': 8}), bound({'kind': 'forecast', 'channel': 'communication', 'span': 4})]
        if not metric:
            blocks.append(bound({'kind': 'chart', 'metric': 'answers', 'days': days or 60, 'channel': 'communication', 'span': 6}))
    if 'committee' in intents:
        blocks += [bound({'kind': 'problems', 'span': 12}), {'kind': 'note', 'span': 12, 'text': 'Решения и владельцы: '}]
    seen, unique = set(), []
    for block in blocks:
        key = json.dumps({k: v for k, v in block.items() if k not in ('span', 'text')}, sort_keys=True, ensure_ascii=False)
        if key in seen and block['kind'] != 'note':
            continue
        seen.add(key)
        unique.append(block)
    labels = {'committee': 'Комитет', 'incident': 'Разбор', 'plan': 'План', 'portfolio': 'Портфель', 'morning': 'Обзор'}
    target = params.get('target')
    subject = ('#' + str(target['id'])) if target and target.get('id') else (target or {}).get('product') or ('сравнение' if len(targets) > 1 else '')
    name = ' · '.join([' + '.join(labels[i] for i in intents[:2])] + ([subject] if subject else []))
    if not targets:
        notes.append('Опрос или продукт в задаче не найден — выберите объект в параметрах холста, и связанные блоки пересчитаются для него.')
    unique = [b for b in unique if b['kind'] != 'note'][:10] + [b for b in unique if b['kind'] == 'note'][:2]
    return {'name': name[:80], 'blocks': unique, 'params': params, 'intents': intents, 'notes': notes, 'query': query}

def parse_canvas_query(query, state):
    """Разбирает вопрос без модели: опросы по номерам, продукты по названиям, показатель, период и тип блока."""
    q = query.lower().replace('ё', 'е')
    channel = 'success_screen' if WHATIF_CHANNEL.search(q) else 'communication'
    channels = defaultdict(set)
    for s in state['surveys']:
        channels[s['event']['id']].add(s['meta']['channel'])
    targets, notes = [], []
    for token in re.findall(r'(?<![\d.,])#?(\d{2,7})(?![\d%.,])', q):
        ident = int(token)
        if ident in channels and not any(t['id'] == ident for t in targets):
            targets.append({'channel': channel if channel in channels[ident] else sorted(channels[ident])[0], 'id': ident, 'product': None})
    products = sorted({p for s in state['surveys'] for p in s['meta'].get('products', [])}, key=len, reverse=True)
    rest = q
    for product in products:
        words = re.findall(r'\w+', product.lower().replace('ё', 'е'))
        if not words:
            continue
        pattern = r'\b' + r'\W+'.join(re.escape(w[:-2]) + r'\w*' if len(w) >= 5 else re.escape(w) + r'\b' for w in words)
        match = re.search(pattern, rest)
        if match:
            targets.append({'channel': channel, 'id': None, 'product': product})
            rest = rest[:match.start()] + ' ' + rest[match.end():]
    targets = targets[:5]
    metric = next((m for m, pattern in CANVAS_METRICS if re.search(pattern, q)), None)
    days = None
    match = re.search(r'(\d{1,3})\s*(?:дн|день|дня)', q)
    if match:
        days = min((14, 30, 60, 90, 180, 365), key=lambda d: abs(d - int(match[1])))
    elif re.search(r'\bгод\b|за год|12 месяц|двенадцать месяц', q):
        days = 365
    elif re.search(r'полгода|пол года|6 месяц|шесть месяц', q):
        days = 180
    elif re.search(r'квартал|3 месяц|три месяц|90', q):
        days = 90
    elif re.search(r'2 месяц|два месяц', q):
        days = 60
    elif re.search(r'месяц', q):
        days = 30
    elif re.search(r'недел', q):
        days = 14
    kind = next((k for k, pattern in CANVAS_KINDS if re.search(pattern, q)), None)
    if kind is None and re.search(r'сравн|против|vs\b|и контрол', q):
        kind = 'compare'
    understood = bool(kind or targets or metric)
    block = build_canvas_block(kind or 'chart', metric, days, channel, targets)
    block['question'] = query
    if block['kind'] in ('chart', 'compare'):
        if re.search(r'по недел|понедельн|еженедел', q):
            block['grain'] = 'week'
        elif re.search(r'по месяц|помесячн|ежемесячн', q):
            block['grain'] = 'month'
    if not understood:
        notes.append('В вопросе нет опроса, продукта, показателя или типа блока — показан общий график. Свободный вопрос к данным лучше задать в «Диалоге».')
    elif block['kind'] in ('chart', 'compare') and not targets:
        notes.append('Опрос или продукт не найден в вопросе — блок построен по всем опросам канала «' + CHANNEL_LABELS[channel] + '».')
    return {'block': block, 'understood': understood, 'notes': notes}

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


MIN_FOCUS_ANSWERS = 5   # опросы с меньшим числом ответов в день не выносятся руководителю


def compact(value, metric=''):
    """Число для руководителя: без лишних знаков, крупные — в тыс. и млн."""
    if value is None:
        return '—'
    if metric == 'csi':
        return f'{value:.2f}'.replace('.', ',')
    magnitude = abs(value)
    if magnitude >= 1_000_000:
        return f'{value / 1_000_000:.1f}'.replace('.', ',').replace(',0', '') + ' млн'
    if magnitude >= 10_000:
        return f'{value / 1000:.0f} тыс.'
    if magnitude >= 1000:
        return f'{value / 1000:.1f}'.replace('.', ',').replace(',0', '') + ' тыс.'
    if magnitude >= 10:
        return str(round(value))
    return f'{value:.1f}'.replace('.', ',').replace(',0', '')


MONTHS_GENITIVE = ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']


def human_date(value):
    if not value:
        return ''
    date = dt.date.fromisoformat(value[:10])
    return str(date.day) + ' ' + MONTHS_GENITIVE[date.month - 1]


def short_pct(value):
    return ('+' if value > 0 else '−' if value < 0 else '') + str(abs(round(value))) + '%'


def build_problems(shifts, signals, focus, favorites):
    """Одна проблема на опрос: сдвиги и сигналы одного опроса объединяются."""
    by_key = {}
    for shift in shifts:
        key = (shift['channel'], shift['id'])
        by_key.setdefault(key, {'shifts': [], 'signals': [], 'name': shift['name'], 'products': shift.get('products', []),
                                'avgAnswers': shift.get('avgAnswers')})['shifts'].append(shift)
    for signal in signals:
        key = (signal['channel'], signal['id'])
        by_key.setdefault(key, {'shifts': [], 'signals': [], 'name': signal['name'], 'products': [], 'avgAnswers': None})['signals'].append(signal)
    output = []
    for (channel, ident), group in by_key.items():
        down = [s for s in group['shifts'] if s['direction'] == 'down']
        urgent = [s for s in group['signals'] if s['severity'] == 'urgent']
        main = None
        if down:
            main = max(down, key=lambda s: (s['metric'] == 'answers', abs(s['relative'] if s['relative'] is not None else s['delta'] * 100)))
        score, kind, line, since, hint = 0, '', '', None, ''
        if urgent:
            score, kind = 100, 'urgent'
            line = urgent[0]['reasons'][0]
            hint = 'Похоже на остановку коммуникаций — проверьте запуск и стоп-листы.'
        if main:
            change = short_pct(main['relative']) if main['relative'] is not None else signed_num(main['delta']).replace('-', '−') + ' балла'
            shift_line = main['label'] + ' ' + change + ' с ' + human_date(main['date']) + ' (' + compact(main['before'], main['metric']) + ' → ' + compact(main['after'], main['metric']) + (' в день' if main['metric'] != 'csi' else '') + ')'
            if not kind:
                score = (80 if main['severity'] == 'high' else 55) + min(abs(main['relative'] or main['delta'] * 100), 100) / 10
                kind = 'shift'
                line, since = shift_line, main['date']
                if main['relative'] is not None and main['relative'] <= -90:
                    hint = 'Почти полная остановка — проверьте, не выключен ли опрос или триггер.'
                elif main['metric'] == 'csi':
                    hint = 'Снизилась оценка — проверьте изменения в продукте или анкете в эту дату.'
                elif main['metric'] == 'sends':
                    hint = 'Меньше отправок — проверьте стоп-листы, политику контактов и входящий поток событий.'
                else:
                    hint = 'Меньше ответов — проверьте отправки и отклик, затем запуск коммуникаций.'
            else:
                line += ' · ' + shift_line
                since = main['date']
        if not kind and group['signals']:
            score, kind = 40, 'weekly'
            line = group['signals'][0]['reasons'][0]
            hint = 'Свежее изменение за неделю — посмотрите динамику по дням.'
        if not kind:
            up = group['shifts'][0]
            score, kind = 5, 'growth'
            line = up['label'] + ' ' + (short_pct(up['relative']) if up['relative'] is not None else signed_num(up['delta'])) + ' с ' + human_date(up['date'])
            since, hint = up['date'], 'Рост — убедитесь, что он ожидаем (кампания, новый триггер).'
        avg = group['avgAnswers']
        low = avg is not None and avg < MIN_FOCUS_ANSWERS and kind != 'urgent'
        output.append({'key': 'problem:' + channel + ':' + str(ident), 'channel': channel, 'channelLabel': CHANNEL_LABELS[channel], 'id': ident,
                       'name': group['name'], 'title': '#' + str(ident) + ' · ' + group['name'], 'products': group['products'],
                       'kind': kind, 'kindLabel': {'urgent': 'срочно', 'shift': 'устойчивый сдвиг', 'weekly': 'изменение недели', 'growth': 'рост'}[kind],
                       'score': round(score, 1), 'line': line, 'since': since, 'hint': hint,
                       'inFocus': (channel, ident) in focus, 'favorite': (channel, ident) in favorites, 'lowVolume': low,
                       'avgAnswers': avg, 'shiftKeys': [s['key'] for s in group['shifts']], 'metrics': sorted({s['metric'] for s in group['shifts']})})
    output.sort(key=lambda p: (-p['score'], p['id']))
    return output


def canned_status(brief, items):
    focus = [p for p in brief.get('problems', []) if p['inFocus'] and not p['lowVolume'] and p['kind'] != 'growth']
    bank = [b for b in brief.get('bank', []) if b['alert']]
    head = ('В вашем фокусе требуют решения ' + str(len(focus)) + ' ' + plural(len(focus), 'опрос', 'опроса', 'опросов')) if focus else 'В вашем фокусе проблем нет'
    tail = '; по банку — ' + ', '.join(b['label'] + ': ' + ', '.join(b['reasons']) for b in bank) if bank else '; по банку существенных изменений нет'
    return head + tail + '.'


def plural(n, one, few, many):
    n = abs(n) % 100
    if 11 <= n <= 14:
        return many
    n %= 10
    return one if n == 1 else few if 2 <= n <= 4 else many
