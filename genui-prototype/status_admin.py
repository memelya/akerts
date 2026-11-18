"""Справочник статусов status_det: группы, коды, алиасы, порядок и отображение в дашбордах.

Хранение — локальная SQLite (.local-data/status-admin.sqlite3), отдельно от выгрузок:
справочник переживает перезагрузку данных и переносится вместе с папкой проекта.
Числа по статусам считает платформа по строкам выгрузки (analytics_db); справочник
задаёт только группировку, подписи, цвета и порядок.
"""
import csv
import datetime as dt
import io
import json
import re
import sqlite3
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 1
CACHE_TTL = 300  # секунд; при любом изменении кэш сбрасывается сразу
CODE_MIN, CODE_MAX = -99999, 99999999
ROLES = ('admin', 'analyst', 'viewer')
AGGREGATIONS = {'sum': 'Сумма событий', 'share': 'Доля от событий, %', 'avg': 'Среднее в день'}
FUNNEL_ROLES = {'delivered': 'Успешная отправка (шаг «Отправки»)', 'loss': 'Отсечение в воронке', 'neutral': 'Не участвует в воронке'}
UNASSIGNED_MODES = {'group': 'Показывать в группе «Без группы»', 'hide': 'Скрывать из легенды и фильтров'}
UNGROUPED_SLUG = 'ungrouped'
COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{1,47}$')
ICONS = ('check', 'gear', 'clock', 'shield', 'ban', 'filter', 'users', 'alert', 'mail', 'circle')

DDL = '''
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS status_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    slug        TEXT    NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 48),
    description TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 600),
    color       TEXT    NOT NULL DEFAULT '#8a8a8a' CHECK (color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
    icon        TEXT    NOT NULL DEFAULT 'circle',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
    funnel_role TEXT    NOT NULL DEFAULT 'loss' CHECK (funnel_role IN ('delivered', 'loss', 'neutral')),
    aggregation TEXT    NOT NULL DEFAULT 'sum' CHECK (aggregation IN ('sum', 'share', 'avg')),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS status_groups_name ON status_groups (name);
CREATE TABLE IF NOT EXISTS status_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        INTEGER NOT NULL UNIQUE CHECK (code BETWEEN -99999 AND 99999999),
    description TEXT    NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 600),
    group_id    INTEGER NOT NULL REFERENCES status_groups (id) ON DELETE RESTRICT,
    alias       TEXT    CHECK (alias IS NULL OR length(alias) BETWEEN 1 AND 80),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS status_codes_group ON status_codes (group_id, sort_order);
CREATE TABLE IF NOT EXISTS status_dashboard_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS status_audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    role    TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}'
);
'''

SEED = [
    ('success', 'Успешная отправка события', '#3f9f6b', 'check', 'delivered', 'Коммуникация с клиентом состоялась.',
     [(0, 'По событию после всех проверок совершена коммуникация с клиентом', 'Отправлено')]),
    ('technical', 'Техническая обработка', '#8a94a6', 'gear', 'loss', 'Событие не дошло до проверок по техническим причинам.',
     [(-1, 'За определённый срок не было взято в обработку и было удалено', 'Не взято в обработку'),
      (900, 'Отправка в @900: интеграционная ошибка взаимодействия с сервисом', 'Ошибка интеграции @900'),
      (1001, 'Время жизни события истекло', 'Истёк срок жизни'),
      (1015, 'Дубликат по epk id и event type id', 'Дубликат')]),
    ('old-policy', 'Старая политика', '#d39b45', 'clock', 'loss', 'Проверки контактной политики прежней версии и ЕПК.',
     [(1011, 'Проверка УК по групповой политике: Недавно участвовал в опросе группы', 'УК группы: недавно в опросе'),
      (1006, 'Интеграция с ЕПК: Не соответствует сегменту', 'ЕПК: не тот сегмент'),
      (1003, 'Проверка по УК внутри ППРБ: Недавно участвовал в опросе', 'УК ППРБ: недавно в опросе'),
      (1004, 'Интеграция с ЕПК: Не найден в ЕПК', 'Нет в ЕПК'),
      (1009, 'Текст с персональными тегами не может быть подготовлен', 'Ошибка персонализации текста')]),
    ('stop-lists', 'Стоп-листы', '#e2675b', 'ban', 'loss', 'Клиент найден в стоп-листе массовых персональных коммуникаций.',
     [(1002, 'Интеграция со стоплистами массперс: Найден в стоплисте', 'Стоп-лист')]),
    ('new-policy', 'Новая политика', '#9b7fd1', 'shield', 'loss', 'Политика коммуникаций по группам, сегментам, каналам и времени.',
     [(1024, 'Не пройдена ПК по каналу коммуникации (FirstGroup)', 'ПК канала (First)'),
      (1023, 'Канал исключен (SecondGroup)', 'Канал исключён (Second)'),
      (1020, 'Политика коммуникаций по группам не пройдена (SecondGroup)', 'ПК групп (Second)'),
      (1021, 'Сегмент исключен (SecondGroup)', 'Сегмент исключён (Second)'),
      (1019, 'Канал исключен (ThirdGroup)', 'Канал исключён (Third)'),
      (1016, 'Политика коммуникаций по подгруппам не пройдена (ThirdGroup)', 'ПК подгрупп (Third)'),
      (9898, 'Не пройдена проверка времени рассылки (будни/выходные)', 'Время рассылки'),
      (1008, 'Событие было не применимо на данный момент', 'Не применимо сейчас'),
      (1010, 'Проверка по УК внутри ППРБ: Недавно участвовал в опросе(spec)', 'УК ППРБ (spec)'),
      (1017, 'Сегмент исключен (ThirdGroup)', 'Сегмент исключён (Third)')]),
]


class StatusError(ValueError):
    """Ошибка с HTTP-статусом и ошибками по полям для формы."""
    def __init__(self, message, status=400, fields=None):
        super().__init__(message)
        self.status = status
        self.fields = fields or {}


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def text(value, label, limit, required=False, field=None):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise StatusError(label + ': нужен текст.', fields={field or label: 'Нужен текст'})
    value = ' '.join(value.split()) if '\n' not in value else value.strip()
    if required and not value:
        raise StatusError(label + ': заполните поле.', fields={field or label: 'Обязательное поле'})
    if len(value) > limit:
        raise StatusError(label + ': не длиннее ' + str(limit) + ' символов.', fields={field or label: 'Не длиннее ' + str(limit)})
    return value


def parse_code(value):
    """status_det — целое число, допускаются отрицательные (-1). Строки «-1», «1002» тоже принимаются."""
    if isinstance(value, bool):
        raise StatusError('Код статуса должен быть целым числом.', fields={'code': 'Целое число'})
    if isinstance(value, str) and re.fullmatch(r'\s*[-−]?\d{1,8}\s*', value):
        value = int(value.strip().replace('−', '-'))
    if not isinstance(value, int):
        raise StatusError('Код статуса должен быть целым числом, например 1002 или -1.', fields={'code': 'Целое число'})
    if not CODE_MIN <= value <= CODE_MAX:
        raise StatusError('Код статуса вне допустимого диапазона.', fields={'code': 'От ' + str(CODE_MIN) + ' до ' + str(CODE_MAX)})
    return value


def flag(value, label):
    if isinstance(value, bool):
        return int(value)
    if value in (0, 1):
        return value
    raise StatusError(label + ': нужно да или нет.', fields={label: 'да/нет'})


def slugify(name):
    table = str.maketrans({'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y',
                           'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
                           'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'})
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower().translate(table)).strip('-')[:40]
    return slug if len(slug) >= 2 else 'group'


class StatusDirectory:
    def __init__(self, root, store=None):
        self.root = Path(root)
        self.path = self.root / '.local-data' / 'status-admin.sqlite3'
        self.store = store
        self.lock = threading.RLock()
        self._cache = None
        self._prepare()

    # -- хранение -----------------------------------------------------------------------
    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys = ON')
        connection.create_function('ru_lower', 1, lambda v: v.casefold().replace('ё', 'е') if isinstance(v, str) else v, deterministic=True)
        try:
            with connection:
                yield connection
        except sqlite3.IntegrityError as error:
            raise StatusError(self.integrity_message(str(error)), 409) from None
        finally:
            connection.close()

    @staticmethod
    def integrity_message(message):
        if 'status_codes.code' in message:
            return 'Такой код статуса уже есть в справочнике.'
        if 'status_groups.slug' in message:
            return 'Группа с таким идентификатором уже есть.'
        if 'status_groups.name' in message:
            return 'Группа с таким названием уже есть.'
        if 'FOREIGN KEY' in message:
            return 'Нельзя удалить группу, пока в ней есть коды.'
        return 'Нарушено ограничение справочника: ' + message

    def _prepare(self):
        with self.lock, self.db() as db:
            db.executescript(DDL)
            if db.execute('SELECT COUNT(*) FROM status_groups').fetchone()[0]:
                return
            stamp = now()
            descriptions = self.reference_descriptions()
            for order, (slug, name, color, icon, role, description, codes) in enumerate(SEED):
                gid = db.execute('INSERT INTO status_groups (name, slug, description, color, icon, sort_order, is_active, is_system, funnel_role,'
                                 ' aggregation, created_at, updated_at) VALUES (?,?,?,?,?,?,1,1,?,?,?,?)',
                                 (name, slug, description, color, icon, (order + 1) * 10, role, 'sum', stamp, stamp)).lastrowid
                for position, (code, text_value, alias) in enumerate(codes):
                    source = descriptions.get(str(code))
                    if source and not source.startswith('Описание не предоставлено'):
                        text_value = text_value or source
                    db.execute('INSERT INTO status_codes (code, description, group_id, alias, sort_order, is_active, is_system, created_at, updated_at)'
                               ' VALUES (?,?,?,?,?,1,1,?,?)', (code, text_value, gid, alias, (position + 1) * 10, stamp, stamp))
            db.execute('INSERT INTO status_groups (name, slug, description, color, icon, sort_order, is_active, is_system, funnel_role, aggregation,'
                       ' created_at, updated_at) VALUES (?,?,?,?,?,?,1,1,?,?,?,?)',
                       ('Без группы', UNGROUPED_SLUG, 'Коды без группы и коды удалённых групп.', '#6f6f6f', 'circle', 1000, 'loss', 'sum', stamp, stamp))
            for key, value in (('unassigned_mode', 'group'), ('drill_down', '1'), ('default_aggregation', 'sum'), ('revision', '1'),
                               ('schema_version', str(SCHEMA_VERSION))):
                db.execute('INSERT OR REPLACE INTO status_dashboard_settings VALUES (?,?)', (key, value))

    def reference_descriptions(self):
        for name in ('reference.json', 'baseline.json'):
            try:
                value = json.loads((self.root / '.local-data' / name).read_text(encoding='utf-8')).get('statusDescriptions') or {}
                if value:
                    return value
            except (OSError, ValueError, AttributeError):
                continue
        return {}

    # -- права доступа ------------------------------------------------------------------
    def role(self):
        """Роль задаётся на компьютере, где запущен сервер: .local-data/access.json {"statusAdmin": "admin|analyst|viewer"}.
        По умолчанию локальный владелец — admin. Браузер роль не выбирает и не может её подменить."""
        try:
            value = json.loads((self.root / '.local-data' / 'access.json').read_text(encoding='utf-8')).get('statusAdmin')
            return value if value in ROLES else 'admin'
        except (OSError, ValueError, AttributeError):
            return 'admin'

    def require(self, level):
        role = self.role()
        if level == 'write' and role != 'admin':
            raise StatusError('Изменять справочник может только роль admin. Ваша роль: ' + role + '.', 403)
        if level == 'read' and role == 'viewer':
            raise StatusError('Роль viewer видит только дашборды. Админка статусов недоступна.', 403)
        return role

    # -- служебное ----------------------------------------------------------------------
    def bump(self, db, action, target, details=None):
        revision = int(db.execute("SELECT value FROM status_dashboard_settings WHERE key='revision'").fetchone()[0]) + 1
        db.execute("UPDATE status_dashboard_settings SET value=? WHERE key='revision'", (str(revision),))
        db.execute('INSERT INTO status_audit (at, role, action, target, details) VALUES (?,?,?,?,?)',
                   (now(), self.role(), action, target, json.dumps(details or {}, ensure_ascii=False)))
        db.execute('DELETE FROM status_audit WHERE id NOT IN (SELECT id FROM status_audit ORDER BY id DESC LIMIT 500)')
        self._cache = None  # инвалидация кэша дерева
        return revision

    @staticmethod
    def group_row(row, counts=None):
        item = {k: row[k] for k in ('id', 'name', 'slug', 'description', 'color', 'icon', 'sort_order', 'funnel_role', 'aggregation', 'created_at', 'updated_at')}
        item.update(is_active=bool(row['is_active']), is_system=bool(row['is_system']))
        if counts is not None:
            item['codes_count'] = counts.get(row['id'], 0)
        return item

    @staticmethod
    def code_row(row):
        item = {k: row[k] for k in ('id', 'code', 'description', 'group_id', 'alias', 'sort_order', 'created_at', 'updated_at')}
        item.update(is_active=bool(row['is_active']), is_system=bool(row['is_system']))
        return item

    def settings(self, db=None):
        def read(connection):
            return {r['key']: r['value'] for r in connection.execute('SELECT key, value FROM status_dashboard_settings')}
        if db is not None:
            return read(db)
        with self.db() as connection:
            return read(connection)

    def check_version(self, row, request):
        expected = request.get('expected_updated_at')
        if expected is not None and expected != row['updated_at']:
            raise StatusError('Запись уже изменили (в другой вкладке или импортом). Обновите экран и повторите.', 409)

    @staticmethod
    def name_taken(db, name, exclude=None):
        """SQLite lower() не знает кириллицу — сравниваем в Python без учёта регистра и ё/е."""
        key = name.casefold().replace('ё', 'е')
        return any(r['id'] != exclude and r['name'].casefold().replace('ё', 'е') == key for r in db.execute('SELECT id, name FROM status_groups'))

    def ungrouped_id(self, db):
        return db.execute('SELECT id FROM status_groups WHERE slug=?', (UNGROUPED_SLUG,)).fetchone()[0]

    # -- группы -------------------------------------------------------------------------
    def list_groups(self):
        self.require('read')
        with self.db() as db:
            counts = {r[0]: r[1] for r in db.execute('SELECT group_id, COUNT(*) FROM status_codes GROUP BY group_id')}
            return {'items': [self.group_row(r, counts) for r in db.execute('SELECT * FROM status_groups ORDER BY sort_order, id')],
                    'role': self.role(), 'settings': self.public_settings(db)}

    def group_fields(self, request, partial, current=None):
        values, errors = {}, {}
        def guard(key, fn):
            try:
                if key in request or not partial:
                    values[key] = fn(request.get(key))
            except StatusError as error:
                errors[key] = next(iter(error.fields.values()), str(error))
        guard('name', lambda v: text(v, 'Название группы', 120, True, 'name'))
        guard('description', lambda v: text(v, 'Описание группы', 600, False, 'description'))
        def color(v):
            v = v or (current['color'] if current else '#8a8a8a')
            if not isinstance(v, str) or not COLOR.match(v):
                raise StatusError('Цвет', fields={'color': 'Цвет в формате #RRGGBB'})
            return v.lower()
        guard('color', color)
        def icon(v):
            v = v or (current['icon'] if current else 'circle')
            if v not in ICONS:
                raise StatusError('Иконка', fields={'icon': 'Выберите иконку из списка'})
            return v
        guard('icon', icon)
        def role(v):
            v = v or (current['funnel_role'] if current else 'loss')
            if v not in FUNNEL_ROLES:
                raise StatusError('Роль', fields={'funnel_role': 'delivered, loss или neutral'})
            return v
        guard('funnel_role', role)
        def aggregation(v):
            v = v or (current['aggregation'] if current else 'sum')
            if v not in AGGREGATIONS:
                raise StatusError('Агрегация', fields={'aggregation': 'sum, share или avg'})
            return v
        guard('aggregation', aggregation)
        if 'is_active' in request or not partial:
            try:
                values['is_active'] = flag(request.get('is_active', True), 'is_active')
            except StatusError:
                errors['is_active'] = 'да/нет'
        if 'slug' in request or not partial:
            slug = request.get('slug') or (current['slug'] if current else slugify(values.get('name') or ''))
            if not isinstance(slug, str) or not SLUG.match(slug):
                errors['slug'] = 'Латиница, цифры и дефис, 2–48 символов'
            else:
                values['slug'] = slug
        if errors:
            raise StatusError('Проверьте поля группы.', 400, errors)
        return values

    def create_group(self, request):
        self.require('write')
        values = self.group_fields(request, False)
        with self.lock, self.db() as db:
            if self.name_taken(db, values['name']):
                raise StatusError('Группа с таким названием уже есть.', 409, {'name': 'Название занято'})
            base, n = values['slug'], 2
            while db.execute('SELECT 1 FROM status_groups WHERE slug=?', (values['slug'],)).fetchone():
                if 'slug' in request and request['slug']:
                    raise StatusError('Идентификатор группы занят.', 409, {'slug': 'Уже используется'})
                values['slug'] = base[:44] + '-' + str(n)
                n += 1
            order = db.execute("SELECT COALESCE(MAX(sort_order),0) FROM status_groups WHERE slug<>?", (UNGROUPED_SLUG,)).fetchone()[0] + 10
            stamp = now()
            gid = db.execute('INSERT INTO status_groups (name, slug, description, color, icon, sort_order, is_active, is_system, funnel_role, aggregation,'
                             ' created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)',
                             (values['name'], values['slug'], values['description'], values['color'], values['icon'], order, values['is_active'],
                              values['funnel_role'], values['aggregation'], stamp, stamp)).lastrowid
            self.bump(db, 'group-create', values['name'])
            return self.group_row(db.execute('SELECT * FROM status_groups WHERE id=?', (gid,)).fetchone(), {})

    def update_group(self, gid, request):
        self.require('write')
        with self.lock, self.db() as db:
            row = db.execute('SELECT * FROM status_groups WHERE id=?', (gid,)).fetchone()
            if not row:
                raise StatusError('Группа не найдена.', 404)
            self.check_version(row, request)
            values = self.group_fields(request, True, row)
            if row['is_system'] and 'slug' in values and values['slug'] != row['slug']:
                raise StatusError('Идентификатор системной группы менять нельзя.', 409, {'slug': 'Системная группа'})
            if row['slug'] == UNGROUPED_SLUG and values.get('funnel_role') == 'delivered':
                raise StatusError('«Без группы» не может быть успешной отправкой.', 409, {'funnel_role': 'Недопустимо'})
            if 'name' in values and self.name_taken(db, values['name'], gid):
                raise StatusError('Группа с таким названием уже есть.', 409, {'name': 'Название занято'})
            if not values:
                return self.group_row(row)
            values['updated_at'] = now()
            db.execute('UPDATE status_groups SET ' + ', '.join(k + '=?' for k in values) + ' WHERE id=?', (*values.values(), gid))
            self.bump(db, 'group-update', row['name'], {k: v for k, v in values.items() if k != 'updated_at'})
            counts = {gid: db.execute('SELECT COUNT(*) FROM status_codes WHERE group_id=?', (gid,)).fetchone()[0]}
            return self.group_row(db.execute('SELECT * FROM status_groups WHERE id=?', (gid,)).fetchone(), counts)

    def delete_group(self, gid, request):
        """Системные группы не удаляются. Коды обычной группы переносятся в «Без группы» (move_to — в другую группу)."""
        self.require('write')
        with self.lock, self.db() as db:
            row = db.execute('SELECT * FROM status_groups WHERE id=?', (gid,)).fetchone()
            if not row:
                raise StatusError('Группа не найдена.', 404)
            if row['is_system']:
                raise StatusError('Системную группу «' + row['name'] + '» удалить нельзя — её можно скрыть из дашбордов.', 409)
            target = request.get('move_to')
            if target is None:
                target = self.ungrouped_id(db)
            elif type(target) is not int or target == gid or not db.execute('SELECT 1 FROM status_groups WHERE id=?', (target,)).fetchone():
                raise StatusError('Выберите существующую группу для переноса кодов.', 400, {'move_to': 'Группа не найдена'})
            moved = db.execute('UPDATE status_codes SET group_id=?, updated_at=? WHERE group_id=?', (target, now(), gid)).rowcount
            db.execute('DELETE FROM status_groups WHERE id=?', (gid,))
            self.bump(db, 'group-delete', row['name'], {'moved': moved, 'to': target})
            return {'ok': True, 'moved': moved, 'move_to': target}

    def reorder_groups(self, request):
        self.require('write')
        ids = request.get('ids')
        if not isinstance(ids, list) or not ids or any(type(i) is not int for i in ids) or len(set(ids)) != len(ids):
            raise StatusError('Передайте полный список id групп в новом порядке.', 400, {'ids': 'Список целых id без повторов'})
        with self.lock, self.db() as db:
            existing = {r[0] for r in db.execute('SELECT id FROM status_groups')}
            if set(ids) != existing:
                raise StatusError('Список групп устарел: обновите экран и повторите.', 409)
            stamp = now()
            for position, gid in enumerate(ids):
                db.execute('UPDATE status_groups SET sort_order=?, updated_at=? WHERE id=?', ((position + 1) * 10, stamp, gid))
            self.bump(db, 'group-reorder', 'группы', {'ids': ids})
        return self.list_groups()

    # -- коды ---------------------------------------------------------------------------
    def list_codes(self, query):
        self.require('read')
        try:
            page = max(1, int(query.get('page', 1)))
            size = min(500, max(1, int(query.get('page_size', 100))))
        except (TypeError, ValueError):
            raise StatusError('page и page_size — целые числа.', 400)
        where, args = [], []
        if query.get('group_id') not in (None, ''):
            try:
                where.append('group_id=?')
                args.append(int(query['group_id']))
            except ValueError:
                raise StatusError('group_id — целое число.', 400)
        if query.get('q'):
            term = '%' + str(query['q']).strip().casefold().replace('ё', 'е') + '%'
            where.append('(CAST(code AS TEXT) LIKE ? OR ru_lower(description) LIKE ? OR ru_lower(COALESCE(alias, \'\')) LIKE ?)')
            args += [term, term, term]
        clause = ' WHERE ' + ' AND '.join(where) if where else ''
        with self.db() as db:
            total = db.execute('SELECT COUNT(*) FROM status_codes' + clause, args).fetchone()[0]
            rows = db.execute('SELECT * FROM status_codes' + clause + ' ORDER BY sort_order, code LIMIT ? OFFSET ?', (*args, size, (page - 1) * size)).fetchall()
        return {'items': [self.code_row(r) for r in rows], 'total': total, 'page': page, 'page_size': size,
                'pages': max(1, -(-total // size)), 'role': self.role()}

    def code_fields(self, request, partial, current=None):
        values, errors = {}, {}
        if 'code' in request or not partial:
            try:
                values['code'] = parse_code(request.get('code'))
            except StatusError as error:
                errors['code'] = next(iter(error.fields.values()))
        for key, label, limit, required in (('description', 'Описание', 600, True), ('alias', 'Алиас', 80, False)):
            if key in request or not partial:
                try:
                    values[key] = text(request.get(key), label, limit, required, key) or (None if key == 'alias' else '')
                except StatusError as error:
                    errors[key] = next(iter(error.fields.values()))
        if 'group_id' in request or not partial:
            if type(request.get('group_id')) is not int:
                errors['group_id'] = 'Выберите группу'
            else:
                values['group_id'] = request['group_id']
        if 'is_active' in request:
            try:
                values['is_active'] = flag(request['is_active'], 'is_active')
            except StatusError:
                errors['is_active'] = 'да/нет'
        if 'sort_order' in request:
            if type(request['sort_order']) is not int or not 0 <= request['sort_order'] <= 1_000_000:
                errors['sort_order'] = 'Целое число от 0'
            else:
                values['sort_order'] = request['sort_order']
        if errors:
            raise StatusError('Проверьте поля кода.', 400, errors)
        return values

    def create_code(self, request):
        self.require('write')
        values = self.code_fields(request, False)
        with self.lock, self.db() as db:
            if not db.execute('SELECT 1 FROM status_groups WHERE id=?', (values['group_id'],)).fetchone():
                raise StatusError('Группа не найдена.', 400, {'group_id': 'Группа не найдена'})
            if db.execute('SELECT 1 FROM status_codes WHERE code=?', (values['code'],)).fetchone():
                raise StatusError('Код ' + str(values['code']) + ' уже есть в справочнике.', 409, {'code': 'Код уже используется'})
            order = values.get('sort_order') or db.execute('SELECT COALESCE(MAX(sort_order),0) FROM status_codes WHERE group_id=?', (values['group_id'],)).fetchone()[0] + 10
            stamp = now()
            cid = db.execute('INSERT INTO status_codes (code, description, group_id, alias, sort_order, is_active, is_system, created_at, updated_at)'
                             ' VALUES (?,?,?,?,?,?,0,?,?)', (values['code'], values['description'], values['group_id'], values['alias'], order,
                                                          values.get('is_active', 1), stamp, stamp)).lastrowid
            self.bump(db, 'code-create', str(values['code']))
            return self.code_row(db.execute('SELECT * FROM status_codes WHERE id=?', (cid,)).fetchone())

    def update_code(self, cid, request):
        self.require('write')
        with self.lock, self.db() as db:
            row = db.execute('SELECT * FROM status_codes WHERE id=?', (cid,)).fetchone()
            if not row:
                raise StatusError('Код не найден.', 404)
            self.check_version(row, request)
            values = self.code_fields(request, True, row)
            if row['is_system'] and 'code' in values and values['code'] != row['code']:
                raise StatusError('Числовой код системного статуса менять нельзя — он приходит из выгрузки.', 409, {'code': 'Системный код'})
            if 'code' in values and db.execute('SELECT 1 FROM status_codes WHERE code=? AND id<>?', (values['code'], cid)).fetchone():
                raise StatusError('Код ' + str(values['code']) + ' уже есть в справочнике.', 409, {'code': 'Код уже используется'})
            if 'group_id' in values and not db.execute('SELECT 1 FROM status_groups WHERE id=?', (values['group_id'],)).fetchone():
                raise StatusError('Группа не найдена.', 400, {'group_id': 'Группа не найдена'})
            if not values:
                return self.code_row(row)
            values['updated_at'] = now()
            db.execute('UPDATE status_codes SET ' + ', '.join(k + '=?' for k in values) + ' WHERE id=?', (*values.values(), cid))
            self.bump(db, 'code-update', str(row['code']), {k: v for k, v in values.items() if k != 'updated_at'})
            return self.code_row(db.execute('SELECT * FROM status_codes WHERE id=?', (cid,)).fetchone())

    def move_code(self, cid, request):
        self.require('write')
        target = request.get('group_id')
        if type(target) is not int:
            raise StatusError('Выберите группу, в которую перенести код.', 400, {'group_id': 'Выберите группу'})
        with self.lock, self.db() as db:
            row = db.execute('SELECT * FROM status_codes WHERE id=?', (cid,)).fetchone()
            if not row:
                raise StatusError('Код не найден.', 404)
            group = db.execute('SELECT * FROM status_groups WHERE id=?', (target,)).fetchone()
            if not group:
                raise StatusError('Группа не найдена.', 400, {'group_id': 'Группа не найдена'})
            if row['group_id'] == target:
                return self.code_row(row)
            order = db.execute('SELECT COALESCE(MAX(sort_order),0) FROM status_codes WHERE group_id=?', (target,)).fetchone()[0] + 10
            db.execute('UPDATE status_codes SET group_id=?, sort_order=?, updated_at=? WHERE id=?', (target, order, now(), cid))
            self.bump(db, 'code-move', str(row['code']), {'from': row['group_id'], 'to': target})
            return self.code_row(db.execute('SELECT * FROM status_codes WHERE id=?', (cid,)).fetchone())

    def delete_code(self, cid):
        self.require('write')
        with self.lock, self.db() as db:
            row = db.execute('SELECT * FROM status_codes WHERE id=?', (cid,)).fetchone()
            if not row:
                raise StatusError('Код не найден.', 404)
            if row['is_system']:
                raise StatusError('Системный код ' + str(row['code']) + ' удалить нельзя — его можно выключить или перенести.', 409)
            db.execute('DELETE FROM status_codes WHERE id=?', (cid,))
            self.bump(db, 'code-delete', str(row['code']))
            return {'ok': True}

    def reorder_codes(self, request):
        self.require('write')
        gid, ids = request.get('group_id'), request.get('ids')
        if type(gid) is not int or not isinstance(ids, list) or any(type(i) is not int for i in ids) or len(set(ids)) != len(ids):
            raise StatusError('Передайте group_id и полный список id кодов группы в новом порядке.', 400)
        with self.lock, self.db() as db:
            existing = {r[0] for r in db.execute('SELECT id FROM status_codes WHERE group_id=?', (gid,))}
            if set(ids) != existing:
                raise StatusError('Список кодов группы устарел: обновите экран и повторите.', 409)
            stamp = now()
            for position, cid in enumerate(ids):
                db.execute('UPDATE status_codes SET sort_order=?, updated_at=? WHERE id=?', ((position + 1) * 10, stamp, cid))
            self.bump(db, 'code-reorder', 'группа ' + str(gid), {'ids': ids})
        return self.list_codes({'group_id': gid, 'page_size': 500})

    # -- настройки отображения ----------------------------------------------------------
    def public_settings(self, db=None):
        raw = self.settings(db)
        return {'unassigned_mode': raw.get('unassigned_mode', 'group'), 'drill_down': raw.get('drill_down', '1') == '1',
                'default_aggregation': raw.get('default_aggregation', 'sum'), 'revision': int(raw.get('revision', '1')),
                'options': {'unassigned_mode': UNASSIGNED_MODES, 'aggregation': AGGREGATIONS, 'funnel_role': FUNNEL_ROLES, 'icons': ICONS}}

    def update_settings(self, request):
        self.require('write')
        changes = {}
        if 'unassigned_mode' in request:
            if request['unassigned_mode'] not in UNASSIGNED_MODES:
                raise StatusError('Режим для кодов без группы: group или hide.', 400, {'unassigned_mode': 'group или hide'})
            changes['unassigned_mode'] = request['unassigned_mode']
        if 'drill_down' in request:
            changes['drill_down'] = '1' if flag(request['drill_down'], 'drill_down') else '0'
        if 'default_aggregation' in request:
            if request['default_aggregation'] not in AGGREGATIONS:
                raise StatusError('Агрегация: sum, share или avg.', 400, {'default_aggregation': 'sum, share или avg'})
            changes['default_aggregation'] = request['default_aggregation']
        with self.lock, self.db() as db:
            for key, value in changes.items():
                db.execute('INSERT OR REPLACE INTO status_dashboard_settings VALUES (?,?)', (key, value))
            if changes:
                self.bump(db, 'settings', 'отображение', changes)
            return self.public_settings(db)

    def audit(self, limit=30):
        self.require('read')
        with self.db() as db:
            return {'items': [dict(r, details=json.loads(r['details'])) for r in
                              db.execute('SELECT * FROM status_audit ORDER BY id DESC LIMIT ?', (max(1, min(200, limit)),))]}

    # -- дерево для дашбордов (кэш) -----------------------------------------------------
    def tree(self, include_inactive=False):
        """Группы → коды по sort_order. Кэш в памяти процесса (TTL 5 минут), сбрасывается при любом изменении."""
        cached = self._cache
        if cached and not include_inactive and time.monotonic() - cached[0] < CACHE_TTL:
            return cached[1]
        with self.db() as db:
            settings = self.public_settings(db)
            groups = db.execute('SELECT * FROM status_groups ORDER BY sort_order, id').fetchall()
            codes = defaultdict(list)
            for row in db.execute('SELECT * FROM status_codes ORDER BY sort_order, code'):
                codes[row['group_id']].append(row)
        result = []
        for group in groups:
            if not include_inactive and not group['is_active']:
                continue
            if group['slug'] == UNGROUPED_SLUG and settings['unassigned_mode'] == 'hide' and not include_inactive:
                continue
            items = [{'code': c['code'], 'label': c['alias'] or c['description'], 'description': c['description'], 'alias': c['alias'],
                      'active': bool(c['is_active'])} for c in codes[group['id']] if include_inactive or c['is_active']]
            result.append({'id': group['id'], 'slug': group['slug'], 'name': group['name'], 'color': group['color'], 'icon': group['icon'],
                           'description': group['description'], 'funnel_role': group['funnel_role'], 'aggregation': group['aggregation'],
                           'active': bool(group['is_active']), 'system': bool(group['is_system']), 'codes': items})
        tree = {'revision': settings['revision'], 'settings': {k: settings[k] for k in ('unassigned_mode', 'drill_down', 'default_aggregation')},
                'groups': result, 'cachedAt': now(), 'ttl': CACHE_TTL}
        if not include_inactive:
            self._cache = (time.monotonic(), tree)
        return tree

    def classifier(self):
        """code → группа для расчётов. Неактивные группы и коды не теряются: в расчёте они уходят в «Без группы»,
        чтобы сумма шагов воронки всегда сходилась с событиями."""
        tree = self.tree(include_inactive=True)
        settings = tree['settings']
        ungrouped = next(g for g in tree['groups'] if g['slug'] == UNGROUPED_SLUG)
        mapping = {}
        for group in tree['groups']:
            for code in group['codes']:
                visible = group['active'] and code['active']
                mapping[code['code']] = (group if visible else ungrouped, code)
        return mapping, tree['groups'], ungrouped, settings

    # -- импорт / экспорт ---------------------------------------------------------------
    def export(self, fmt='json'):
        self.require('read')
        tree = self.tree(include_inactive=True)
        if fmt == 'csv':
            out = io.StringIO()
            writer = csv.writer(out, delimiter=';', lineterminator='\n')
            writer.writerow(['code', 'description', 'group', 'group_slug', 'alias', 'sort_order', 'is_active'])
            for group in tree['groups']:
                for position, code in enumerate(group['codes']):
                    writer.writerow([code['code'], code['description'], group['name'], group['slug'], code['alias'] or '', (position + 1) * 10,
                                     1 if code['active'] else 0])
            return '﻿' + out.getvalue()
        return {'format': 'genui-status-directory', 'version': 1, 'exportedAt': now(), 'settings': tree['settings'],
                'groups': [{'slug': g['slug'], 'name': g['name'], 'description': g['description'], 'color': g['color'], 'icon': g['icon'],
                            'funnel_role': g['funnel_role'], 'aggregation': g['aggregation'], 'is_active': g['active'],
                            'codes': [{'code': c['code'], 'description': c['description'], 'alias': c['alias'], 'is_active': c['active']}
                                      for c in g['codes']]} for g in tree['groups']]}

    def parse_import(self, request):
        fmt, content = request.get('format'), request.get('content')
        if fmt == 'json':
            data = content if isinstance(content, dict) else json.loads(content) if isinstance(content, str) else None
            if not isinstance(data, dict) or data.get('format') != 'genui-status-directory' or not isinstance(data.get('groups'), list):
                raise StatusError('Нужен JSON, выгруженный из этой админки (format: genui-status-directory).', 400)
            groups = []
            for g in data['groups'][:100]:
                if not isinstance(g, dict) or not isinstance(g.get('codes', []), list):
                    raise StatusError('Некорректная группа в JSON.', 400)
                groups.append(g)
            return groups
        if fmt == 'csv':
            if not isinstance(content, str) or len(content) > 2_000_000:
                raise StatusError('CSV пустой или больше 2 МБ.', 400)
            sample = content.lstrip('﻿')
            dialect = ';' if sample.split('\n', 1)[0].count(';') >= sample.split('\n', 1)[0].count(',') else ','
            reader = csv.DictReader(io.StringIO(sample), delimiter=dialect)
            if not reader.fieldnames or not {'code', 'description'} <= {f.strip().lower() for f in reader.fieldnames}:
                raise StatusError('В CSV нужны столбцы code и description; group, alias, sort_order, is_active — по желанию.', 400)
            groups = {}
            for line, raw in enumerate(reader, start=2):
                row = {str(k).strip().lower(): (v or '').strip() for k, v in raw.items() if k}
                name = row.get('group') or 'Без группы'
                group = groups.setdefault(name.lower(), {'name': name, 'slug': row.get('group_slug') or None, 'codes': []})
                group['codes'].append({'code': row.get('code'), 'description': row.get('description'), 'alias': row.get('alias') or None,
                                       'is_active': row.get('is_active', '1') not in ('0', 'нет', 'false'), 'line': line})
            return list(groups.values())
        raise StatusError('Формат импорта: json или csv.', 400)

    def import_config(self, request):
        """mode=merge — добавить и обновить; mode=replace — дополнительно выключить коды, которых нет в файле.
        dry_run=true — только показать план изменений. Ничего не удаляется."""
        self.require('write')
        mode = request.get('mode', 'merge')
        if mode not in ('merge', 'replace'):
            raise StatusError('Режим импорта: merge или replace.', 400)
        dry = bool(request.get('dry_run', True))
        groups = self.parse_import(request)
        plan = {'groups_create': [], 'groups_update': [], 'codes_create': [], 'codes_update': [], 'codes_move': [], 'codes_disable': [], 'errors': []}
        with self.lock, self.db() as db:
            by_slug = {r['slug']: r for r in db.execute('SELECT * FROM status_groups')}
            by_name = {r['name'].casefold(): r for r in by_slug.values()}
            codes = {r['code']: r for r in db.execute('SELECT * FROM status_codes')}
            seen, stamp = set(), now()
            for g in groups:
                try:
                    name = text(g.get('name'), 'Название группы', 120, True)
                except StatusError as error:
                    plan['errors'].append(str(error))
                    continue
                current = by_slug.get(g.get('slug') or '') or by_name.get(name.casefold())
                fields = {k: g[k] for k in ('description', 'color', 'icon', 'funnel_role', 'aggregation') if g.get(k) is not None}
                if 'color' in fields and not COLOR.match(str(fields['color'])) or fields.get('icon', 'circle') not in ICONS \
                        or fields.get('funnel_role', 'loss') not in FUNNEL_ROLES or fields.get('aggregation', 'sum') not in AGGREGATIONS:
                    plan['errors'].append('Группа «' + name + '»: некорректный цвет, иконка, роль или агрегация.')
                    continue
                if current is None:
                    slug = g.get('slug') if isinstance(g.get('slug'), str) and SLUG.match(g['slug']) and g['slug'] not in by_slug else slugify(name)
                    while slug in by_slug:
                        slug = slug[:44] + '-' + str(len(by_slug))
                    plan['groups_create'].append(name)
                    if not dry:
                        order = max([r['sort_order'] for r in by_slug.values() if r['slug'] != UNGROUPED_SLUG] or [0]) + 10
                        gid = db.execute('INSERT INTO status_groups (name, slug, description, color, icon, sort_order, is_active, is_system, funnel_role,'
                                         ' aggregation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)',
                                         (name, slug, fields.get('description', ''), fields.get('color', '#8a8a8a'), fields.get('icon', 'circle'), order,
                                          int(g.get('is_active', True) is not False), fields.get('funnel_role', 'loss'), fields.get('aggregation', 'sum'),
                                          stamp, stamp)).lastrowid
                        current = db.execute('SELECT * FROM status_groups WHERE id=?', (gid,)).fetchone()
                        by_slug[slug] = current
                        by_name[name.casefold()] = current
                    else:
                        current = {'id': -len(plan['groups_create']), 'name': name}
                elif fields and any(current[k] != v for k, v in fields.items()):
                    plan['groups_update'].append(name)
                    if not dry:
                        db.execute('UPDATE status_groups SET ' + ', '.join(k + '=?' for k in fields) + ', updated_at=? WHERE id=?',
                                   (*fields.values(), stamp, current['id']))
                for position, c in enumerate(g.get('codes', [])):
                    where = 'Группа «' + name + '»' + (', строка ' + str(c['line']) if isinstance(c, dict) and c.get('line') else '')
                    try:
                        if not isinstance(c, dict):
                            raise StatusError('некорректная запись кода')
                        code = parse_code(c.get('code'))
                        description = text(c.get('description'), 'Описание', 600, True)
                        alias = text(c.get('alias'), 'Алиас', 80) or None
                    except StatusError as error:
                        plan['errors'].append(where + ': ' + str(error))
                        continue
                    if code in seen:
                        plan['errors'].append(where + ': код ' + str(code) + ' встречается в файле дважды.')
                        continue
                    seen.add(code)
                    active = int(c.get('is_active', True) is not False)
                    existing = codes.get(code)
                    if existing is None:
                        plan['codes_create'].append(code)
                        if not dry:
                            db.execute('INSERT INTO status_codes (code, description, group_id, alias, sort_order, is_active, is_system, created_at, updated_at)'
                                       ' VALUES (?,?,?,?,?,?,0,?,?)', (code, description, current['id'], alias, (position + 1) * 10, active, stamp, stamp))
                        continue
                    if existing['group_id'] != current['id']:
                        plan['codes_move'].append(code)
                    if (existing['description'], existing['alias'], existing['is_active']) != (description, alias, active):
                        plan['codes_update'].append(code)
                    if not dry and (existing['group_id'] != current['id'] or (existing['description'], existing['alias'], existing['is_active']) != (description, alias, active)):
                        db.execute('UPDATE status_codes SET group_id=?, description=?, alias=?, is_active=?, sort_order=?, updated_at=? WHERE id=?',
                                   (current['id'], description, alias, active, (position + 1) * 10, stamp, existing['id']))
            if mode == 'replace':
                for code, row in codes.items():
                    if code not in seen and row['is_active']:
                        plan['codes_disable'].append(code)
                        if not dry:
                            db.execute('UPDATE status_codes SET is_active=0, updated_at=? WHERE id=?', (stamp, row['id']))
            if plan['errors'] and not dry:
                raise StatusError('Импорт не выполнен: исправьте ошибки в файле (' + str(len(plan['errors'])) + ').', 400, {'errors': plan['errors'][:20]})
            changed = sum(len(v) for k, v in plan.items() if k != 'errors')
            if not dry and changed:
                self.bump(db, 'import', request.get('format', ''), {k: len(v) for k, v in plan.items()})
            if not dry:
                self._cache = None
        return {'dry_run': dry, 'mode': mode, 'plan': plan, 'changes': changed}

    # -- аналитика по статусам ----------------------------------------------------------
    def unknown_codes(self, rows):
        mapping, *_ = self.classifier()
        totals = defaultdict(int)
        for row in rows:
            try:
                code = int(row['status'])
            except (TypeError, ValueError):
                continue
            if code not in mapping:
                totals[code] += row['events'] or 0
        return [{'code': c, 'events': v} for c, v in sorted(totals.items(), key=lambda i: -i[1])]

    def breakdown(self, rows, group_by='group', grain='total'):
        """rows: строки status_days (date, survey_id, status, events, sends, answers) канала пуш+СМС."""
        mapping, groups, ungrouped, settings = self.classifier()
        if group_by not in ('group', 'code'):
            raise StatusError('group_by: group или code.', 400)
        if grain not in ('total', 'month', 'day'):
            raise StatusError('grain: total, month или day.', 400)
        period = (lambda d: 'total') if grain == 'total' else (lambda d: d[:7]) if grain == 'month' else (lambda d: d)
        events_total = defaultdict(int)
        cells = defaultdict(lambda: defaultdict(lambda: {'events': 0, 'sends': 0, 'days': set()}))
        meta = {}
        for row in rows:
            key_period = period(row['date'])
            events_total[key_period] += row['events'] or 0
            try:
                code = int(row['status'])
            except (TypeError, ValueError):
                continue
            group, code_info = mapping.get(code, (ungrouped, None))
            if group_by == 'group':
                key = group['slug']
                meta[key] = {'key': key, 'groupSlug': group['slug'], 'label': group['name'], 'color': group['color'], 'funnel_role': group['funnel_role'],
                             'aggregation': group['aggregation'], 'sort': next((i for i, g in enumerate(groups) if g['slug'] == key), 999)}
            else:
                key = str(code)
                meta[key] = {'key': key, 'groupSlug': group['slug'], 'code': code, 'label': (code_info or {}).get('label') or ('Код ' + str(code) + ' · нет в справочнике'),
                             'group': group['name'], 'color': group['color'], 'aggregation': group['aggregation'],
                             'sort': (next((i for i, g in enumerate(groups) if g['slug'] == group['slug']), 999), code)}
            cell = cells[key][key_period]
            cell['events'] += row['events'] or 0
            cell['sends'] += row['sends'] or 0
            cell['days'].add(row['date'])
        hide_ungrouped = settings['unassigned_mode'] == 'hide'
        series = []
        for key, item in sorted(meta.items(), key=lambda kv: kv[1]['sort']):
            if hide_ungrouped and item['groupSlug'] == UNGROUPED_SLUG:
                continue
            points = []
            for p in sorted(events_total):
                cell = cells[key].get(p, {'events': 0, 'sends': 0, 'days': set()})
                share = cell['events'] / events_total[p] * 100 if events_total[p] else None
                avg = cell['events'] / len(cell['days']) if cell['days'] else None
                value = {'sum': cell['events'], 'share': share, 'avg': avg}[item['aggregation']]
                points.append({'period': p, 'events': cell['events'], 'share': share, 'avgPerDay': avg, 'value': value})
            series.append({k: v for k, v in item.items() if k != 'sort'} | {'points': points})
        return {'group_by': group_by, 'grain': grain, 'periods': sorted(events_total), 'eventsTotal': [events_total[p] for p in sorted(events_total)],
                'series': series, 'unknown': self.unknown_codes(rows), 'revision': self.tree()['revision'], 'settings': settings,
                'method': 'События каждого status_det выгрузки пуш+СМС сгруппированы по справочнику статусов. Доля — от всех событий периода. '
                          'Коды без группы, а также выключенные коды и группы, попадают в «Без группы», чтобы сумма сходилась с событиями.'}


# -- HTTP ---------------------------------------------------------------------------------
ROUTES = (
    ('GET', r'/api/status-groups'), ('POST', r'/api/status-groups'), ('PATCH', r'/api/status-groups/reorder'),
    ('PATCH', r'/api/status-groups/(\d+)'), ('DELETE', r'/api/status-groups/(\d+)'),
    ('GET', r'/api/status-codes'), ('POST', r'/api/status-codes'), ('PATCH', r'/api/status-codes/reorder'),
    ('PATCH', r'/api/status-codes/(\d+)/move'), ('PATCH', r'/api/status-codes/(\d+)'), ('DELETE', r'/api/status-codes/(\d+)'),
    ('GET', r'/api/status-tree'), ('GET', r'/api/status-settings'), ('PATCH', r'/api/status-settings'), ('GET', r'/api/status-audit'),
    ('GET', r'/api/status-config/export'), ('POST', r'/api/status-config/import'), ('GET', r'/api/analytics/status-breakdown'),
)


def handles(path):
    return path.startswith(('/api/status-', '/api/analytics/status-breakdown'))


def dispatch(directory, engine, method, path, query, body):
    """Возвращает (http_status, payload, content_type). payload — dict или str (CSV)."""
    for verb, pattern in ROUTES:
        match = re.fullmatch(pattern, path)
        if not match:
            continue
        if verb != method:
            continue
        arg = int(match.group(1)) if match.groups() else None
        if path == '/api/status-groups':
            return (200, directory.list_groups(), None) if method == 'GET' else (201, directory.create_group(body), None)
        if path == '/api/status-groups/reorder':
            return 200, directory.reorder_groups(body), None
        if path.startswith('/api/status-groups/'):
            return (200, directory.update_group(arg, body), None) if method == 'PATCH' else (200, directory.delete_group(arg, body or {}), None)
        if path == '/api/status-codes':
            return (200, directory.list_codes(query), None) if method == 'GET' else (201, directory.create_code(body), None)
        if path == '/api/status-codes/reorder':
            return 200, directory.reorder_codes(body), None
        if path.endswith('/move'):
            return 200, directory.move_code(arg, body), None
        if path.startswith('/api/status-codes/'):
            return (200, directory.update_code(arg, body), None) if method == 'PATCH' else (200, directory.delete_code(arg), None)
        if path == '/api/status-tree':
            tree = directory.tree(include_inactive=query.get('include_inactive') == '1')
            if query.get('include_inactive') == '1':
                directory.require('read')
            return 200, tree, None
        if path == '/api/status-settings':
            if method == 'GET':
                directory.require('read')
                return 200, directory.public_settings(), None
            return 200, directory.update_settings(body), None
        if path == '/api/status-audit':
            return 200, directory.audit(int(query.get('limit', 30)) if str(query.get('limit', '30')).isdigit() else 30), None
        if path == '/api/status-config/export':
            fmt = query.get('format', 'json')
            if fmt not in ('json', 'csv'):
                raise StatusError('format: json или csv.', 400)
            payload = directory.export(fmt)
            return 200, payload, 'text/csv; charset=utf-8' if fmt == 'csv' else None
        if path == '/api/status-config/import':
            return 200, directory.import_config(body), None
        if path == '/api/analytics/status-breakdown':
            return 200, breakdown_request(directory, engine, query), None
    if any(re.fullmatch(pattern, path) for _, pattern in ROUTES):
        raise StatusError('Метод не поддерживается для этого адреса.', 405)
    raise StatusError('Адрес не найден.', 404)


def breakdown_request(directory, engine, query):
    date_from, date_to = query.get('date_from'), query.get('date_to')
    for value, label in ((date_from, 'date_from'), (date_to, 'date_to')):
        if value is not None and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise StatusError(label + ': дата ГГГГ-ММ-ДД.', 400, {label: 'ГГГГ-ММ-ДД'})
    if date_from and date_to and date_from > date_to:
        raise StatusError('date_from позже date_to.', 400)
    ids = None
    if query.get('ids'):
        try:
            ids = [int(v) for v in str(query['ids']).split(',') if v.strip()][:600]
        except ValueError:
            raise StatusError('ids: номера опросов через запятую.', 400)
    state, revision = engine.pulse.snapshot()
    surveys = [s for s in state['surveys'] if s['meta']['channel'] == 'communication' and (ids is None or s['event']['id'] in ids)]
    if not surveys:
        raise StatusError('Нет опросов пуш+СМС для выбранных условий.', 404)
    rows = engine.store.status_days(revision, [('communication', s['event']['id']) for s in surveys], date_from, date_to)
    result = directory.breakdown(rows, query.get('group_by', 'group'), query.get('grain', 'total'))
    result.update(date_from=min((r['date'] for r in rows), default=None), date_to=max((r['date'] for r in rows), default=None), surveys=len(surveys))
    return result
