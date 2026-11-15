"""Release gate for analytical and model contracts on synthetic data."""
import argparse
import json
import tempfile
import threading
from datetime import date, timedelta
from pathlib import Path

from genui_query import bind_explicit_chart_request, validate_spec
from metric_ratios import ratio
from metric_registry import calculate, weighted_csi
from model_policy import prepare_payload, validate_command, validate_scope
from committee import signals
from model_client import parse_json


def require(condition):
    if not condition:
        raise ValueError('Результат отличается от эталона.')


def rejects(action):
    try:
        action()
    except ValueError:
        return
    raise ValueError('Опасный или некорректный запрос был принят.')


def sample(day='2026-11-09', ident=1007, status=0, csi=None, events=100, sends=50, answers=10):
    return dict(id=ident, channel='communication', grain='day', date=day, status=status, events=events, sends=sends, answers=answers, csi=csi)


def run(root=None, live=False):
    cases = []
    def check(name, action, layer='offline'):
        try:
            action()
            cases.append(dict(name=name, layer=layer, ok=True))
        except (ValueError, KeyError, TypeError, OSError) as error:
            cases.append(dict(name=name, layer=layer, ok=False, detail=str(error)))

    with tempfile.TemporaryDirectory() as isolated:
        check('Нулевая и неизвестная база', lambda: require(ratio(7, 0) is None and ratio(7, None) is None and ratio(0, 7) == 0))
        check('Отсутствующий статус и переданный ноль', lambda: require(calculate([sample(status=1002, events=0)], 'stop') == 0 and calculate([sample(status=1011)], 'stop') is None))
        check('Взвешенный CSI без оценки 0', lambda: require(weighted_csi([sample(csi=5, events=3), sample(csi=1, events=1), sample(csi=0, events=99)])['value'] == 4))
        check('Сопоставимые дни и неполный период', lambda: _paired_check())
        check('Явно заданный год и канал', lambda: _calendar_check())
        check('Недельный запрос с августа и сверка границ', lambda: _weekly_check())
        check('Месяц без года, диапазоны месяцев и дней', lambda: _calendar_phrase_check())
        check('Подмена опроса или канала в плане модели', lambda: rejects(lambda: validate_scope('Отправки по опросу 1007 пуш+СМС', {'ids': [193], 'filters': {'channel': 'success_screen'}}, True)))
        check('Два JSON и неподдерживаемое действие модели', lambda: (rejects(lambda: parse_json('{"ok":true} {"ok":false}')), rejects(lambda: validate_spec({'ids':[1007],'metrics':['sends'],'monthsCount':1,'action':'send'}))))
        check('Чужие исходные строки, заметки и секреты исключаются', lambda: _payload_check(isolated))
        check('Запрет генерации кода и команд с автоодобрением', lambda: (rejects(lambda: prepare_payload(isolated, 'creative-code', {})), rejects(lambda: validate_command(isolated, ['gigacode', '--approval-mode', 'plan', '--yolo']))))
    if live:
        from model_client import call_json
        for ident, channel in ((514, 'communication'), (193, 'success_screen')):
            def verify(ident=ident, channel=channel):
                question = f'Отправки опроса {ident} за октябрь 2026, канал '+('пуш+СМС' if channel=='communication' else 'экран успеха')
                prompt = 'Верни только JSON параметров графика: ids, metrics, monthsCount, layout, startMonth, endMonth, filters.channel. Каналы communication и success_screen. Метрика отправок sends.'
                output = call_json(root, prompt, {'synthetic': True, 'userQuery': question}, 'evaluation-plan', 'Синтетическая проверка модели', None, threading.Event())
                spec = validate_spec(output)
                validate_scope(question, spec, True)
                require(spec['metrics'] == ['sends'] and spec.get('startMonth') == spec.get('endMonth') == '2026-10')
            check('Синтетический план '+str(ident), verify, 'live')
    return {'ok': all(case['ok'] for case in cases), 'cases': cases, 'liveModel': live}


def _paired_check():
    end = date(2026, 11, 9)
    rows = [sample((end-timedelta(days=i)).isoformat(), sends=20 if i<7 else 50) for i in range(14) if i not in (1, 9)]
    found = signals(rows, end, 'communication')
    require(len(found) == 1 and len(found[0]['pairedDays']) == 5 and found[0]['delta']['sendShare'] == -30)
    require(not signals(rows[1:], end, 'communication'))


def _weekly_check():
    from weekly_query import execute_weekly
    spec,_=bind_explicit_chart_request({'ids':[1007],'metrics':['sends'],'monthsCount':1,'endMonth':'2026-10'},
                                      'Покажи опрос 1007 с августа 2026 по неделям')
    spec=validate_spec(spec)
    require(spec['grain']=='week' and spec['startMonth']=='2026-08' and 'endMonth' not in spec)
    rows=[sample(day,sends=value) for day,value in [('2026-07-31',900),('2026-08-01',50),('2026-08-02',60),('2026-08-17',40)]]
    chosen=[{'event':{'id':1007},'meta':{'channel':'communication','name':'Синтетический опрос'}}]
    result=execute_weekly({'rawRecords':rows},spec,'Проверка',chosen)
    require(result['blocks'][1]['values']==[110,None,None,40] and result['periods'][0]['end']=='2026-08-02')
    closed=execute_weekly({'rawRecords':rows},dict(spec,endMonth='2026-08'),'Проверка',chosen)
    require(closed['anchor']=='2026-08-17' and closed['periods'][-1]['end']=='2026-08-31' and closed['blocks'][1]['values'][-1] is None)


def _calendar_phrase_check():
    from genui_extended import plan_query
    rejects(lambda: plan_query('Покажи ответы по опросу 1007 за сентябрь'))
    weeks=plan_query('Покажи отправки по опросу 1007 с августа по октябрь 2026 по неделям')
    require((weeks['ids'],weeks['grain'],weeks['startMonth'],weeks['endMonth'])==([1007],'week','2026-08','2026-10'))
    days=plan_query('Покажи отправки по опросу 1007 с 1 по 7 октября 2026')
    require((days['ids'],days['grain'],days['startDate'],days['endDate'])==([1007],'day','2026-10-01','2026-10-07'))


def _calendar_check():
    spec, _ = bind_explicit_chart_request({'ids':[1007],'metrics':['sends'],'monthsCount':1}, 'По всем опросам пуш+смс по месяцам за 2026 год')
    require(validate_spec(spec)['ids'] == [] and spec['monthsCount'] == 12 and spec['endMonth'] == '2026-12')


def _payload_check(root):
    safe = prepare_payload(root, 'agent-review', {'userQuery':'Почта a@example.org, пароль: secret', 'rawRecords':[sample()], 'evidence':{'events':[{'ref':'E1','kind':'policy','note':'private'}], 'facts':[['F1','events',10000000000]],'rawRecords':[sample()]}})
    serialized = json.dumps(safe, ensure_ascii=False)
    require(all(value not in serialized for value in ('rawRecords', 'private', 'secret', 'example.org')) and safe['evidence']['facts'][0][-1] == 10000000000)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', action='store_true', help='Два вызова настроенной CLI только с синтетическими запросами.')
    parser.add_argument('--quiet', action='store_true', help='Показать отчёт только при ошибке.')
    args = parser.parse_args()
    result = run(Path(__file__).resolve().parent, args.model)
    if not args.quiet or not result['ok']:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ok'] else 1)
