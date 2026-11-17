"""Local boundary for model payloads and executable visualization stages."""
import json
import re
from pathlib import Path

from genui_query import validate_spec

VERSION = '1'
BLOCKED = {'creative-code', 'creative-schema-repair', 'creative-runtime-repair', 'creative-metadata-repair'}
SYNTHETIC = {'startup-check', 'diagnostic-json', 'diagnostic-plan', 'diagnostic-code', 'evaluation-plan'}
PLANNING = {'chart-plan', 'agent-plan', 'agent-catalog', 'creative-plan', 'creative-plan-repair'}
REVIEW = {'agent-review', 'agent-repair'}


def profile(root):
    path = Path(root) / '.local-data' / 'model-policy.json'
    try:
        return 'development' if json.loads(path.read_text(encoding='utf-8-sig')) == {'profile': 'development'} else 'protected'
    except (ValueError, OSError):
        return 'protected'


def project(value, keys):
    return {key: value[key] for key in keys if key in value} if isinstance(value, dict) else {}


def scrub(text):
    if not isinstance(text, str):
        return text
    text = re.sub(r'(?i)\b(?:bearer\s+|(?:api[_ -]?key|token|password|пароль|токен)\s*[:=]\s*)[^\s,;]+', '[секрет скрыт]', text)
    text = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', '[адрес скрыт]', text)
    parts = re.split(r'(\b(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?\b|\b\d{2}\.\d{2}\.(?:19|20|21)\d{2}\b)', text)
    for index in range(0,len(parts),2):
        parts[index]=re.sub(r'(?<![\w.])(?:\+?\d[ ()-]*){9,}\d(?!\w)|\b\d{10,}\b','[идентификатор скрыт]',parts[index])
    return ''.join(parts)


def metadata(value):
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, list):
        return [metadata(item) for item in value]
    if isinstance(value, dict):
        return {key: metadata(item) for key, item in value.items()}
    return value


def prepare_payload(root, stage, payload):
    if profile(root) == 'development':
        return payload
    if stage in SYNTHETIC:
        if payload.get('synthetic') is not True:
            raise ValueError('Диагностический вызов допускает только синтетические данные.')
        return payload
    if stage in BLOCKED:
        raise ValueError('Защищённый режим: откройте рассчитанные данные без генерации кода.')
    if stage in PLANNING:
        result = project(payload, ('phase', 'userQuery', 'search', 'searchAlreadyUsed', 'repair', 'availableIds', 'totalSurveys', 'catalogTruncated', 'products', 'months', 'hasDaily', 'metricDefinitions'))
        result['catalog'] = [project(row, ('id', 'name', 'channel', 'products', 'grains')) for row in payload.get('catalog', [])[:24]]
        for field in ('previous', 'previousChart'):
            if payload.get(field):
                result[field] = validate_spec(payload[field])
        for field in ('previousAgent', 'previousAnalysis'):
            if payload.get(field):
                from agent_schema import plan
                result[field] = plan(payload[field])
        return metadata(result)
    if stage in REVIEW:
        result = project(payload, ('phase', 'userQuery', 'plan', 'callsRemaining', 'validationError'))
        evidence = payload.get('evidence', {})
        result['evidence'] = project(evidence, ('revision', 'period', 'goal', 'criteria', 'factColumns', 'facts', 'aggregateRefs', 'signalRef', 'totalSurveys', 'totalCandidates', 'listedCandidates', 'notes', 'trends'))
        result['evidence']['events'] = [project(row, ('ref', 'from', 'to', 'kind')) for row in evidence.get('events', [])]
        result['evidence']['candidates'] = [project(row, ('key', 'id', 'name', 'channel', 'top', 'flags', 'score', 'maxPriority', 'coverage', 'comparisonCoverage', 'strongRefs', 'businessSignals')) for row in evidence.get('candidates', [])]
        return metadata(result)
    if stage == 'chart-conversation':
        result = project(payload, ('scope', 'period', 'previousChart', 'contributorsShown', 'contributorsTotal', 'warning', 'userQuery'))
        result['facts'] = {key: project(value, ('label', 'value', 'unit')) for key, value in payload.get('facts', {}).items()}
        result['contributors'] = [project(row, ('key', 'id', 'name', 'channel', 'current', 'baseline', 'delta', 'state', 'refs')) for row in payload.get('contributors', [])[:20]]
        return metadata(result)
    if stage in ('signal-checks','committee-draft'):
        return metadata({'facts':[project(row,('ref','label','baseline','current','delta','period','unit')) for row in payload.get('facts',[])[:30]],
                         'options':[project(row,('id','label','refs')) for row in payload.get('options',[])[:12]]})
    if stage == 'incident-investigator':
        return {'facts':[project(row,('ref','kind','metric','baseline','current','impact','pairs','surveys','comparedSurveys','days',
                                     'category','relation','from','to','through','factor')) for row in payload.get('facts',[])[:24]],
                'options':[project(row,('id','label','refs')) for row in payload.get('options',[])[:6]]}
    if stage in ('pulse-brief', 'pulse-explain'):
        result = {'facts': [project(row, ('ref', 'label', 'value', 'unit', 'period')) for row in payload.get('facts', [])[:30]]}
        if stage == 'pulse-explain':
            result['options'] = [project(row, ('id', 'label', 'refs')) for row in payload.get('options', [])[:8]]
            result['memory'] = [project(row, ('title', 'cause')) for row in payload.get('memory', [])[:3]]
        return metadata(result)
    if stage == 'pulse-whatif':
        return metadata({'userQuery': payload.get('userQuery', ''), 'products': list(payload.get('products', []))[:60]})
    if stage == 'pulse-canvas':
        return metadata({'userQuery': payload.get('userQuery', ''), 'products': list(payload.get('products', []))[:60],
                         'surveys': [project(row, ('id', 'name', 'channel')) for row in payload.get('surveys', [])[:40]]})
    if stage == 'pulse-route':
        return metadata({'userQuery': payload.get('userQuery', ''), 'options': [project(row, ('id', 'label')) for row in payload.get('options', [])[:40]]})
    raise ValueError('Этап модели не разрешён политикой проекта.')


def minimize_log(root, entry):
    if profile(root) == 'protected':
        for key in ('prompt', 'response', 'stderr', 'details', 'previous'):
            entry.pop(key, None)
        for key in ('query', 'detail', 'error'):
            if key in entry:
                entry[key] = scrub(entry[key])
        entry['policy'] = VERSION


def validate_command(root, command):
    if profile(root) == 'development':
        return
    modes = [arg.split('=', 1)[1] if '=' in arg else command[i+1] if i+1 < len(command) else ''
             for i, arg in enumerate(command) if arg == '--approval-mode' or arg.startswith('--approval-mode=')]
    if modes != ['plan'] or any(arg in ('--yolo', '--auto-approve', '--allow-all') for arg in command):
        raise ValueError('Для защищённого режима настройте CLI с единственным параметром --approval-mode plan.')


def validate_scope(query, scope, chart=False, previous=None):
    text = query.lower().replace('ё', 'е')
    explicit = set()
    for match in re.finditer(r'опрос[а-я]*\s*[#№]?\s*(\d{1,7}(?:\s*(?:,|\bи\b)\s*[#№]?\s*\d{1,7})*)', text):
        explicit.update(int(value) for value in re.findall(r'\d+', match[1]))
    if explicit and previous and re.search(r'\bдобав|дополни',text):
        explicit.update(previous.get('ids', []))
    if explicit and set(scope.get('ids', [])) != explicit:
        raise ValueError('Модель изменила явно указанные ID опросов. Уточните отбор или выберите локальный расчёт.')
    channel = 'communication' if re.search(r'пуш|смс', text) and 'экран' not in text else 'success_screen' if 'экран' in text and not re.search(r'пуш|смс', text) else None
    filters = scope.get('filters', {}) if chart else scope
    if channel and filters.get('channel') != channel:
        raise ValueError('Модель изменила явно указанный канал. Повторите запрос или выберите локальный расчёт.')
    if channel and not explicit and re.search(r'(?:все|всем|всех)\s+опрос',text) and not re.search(r'групп|продукт|приоритет|\bтоп\b|триггер|общий|кроме|исключ',text):
        if scope.get('ids') or any(key in filters for key in ('product','top','type','triggerGroup')):
            raise ValueError('Модель сузила явно выбранный отбор всех опросов канала.')
