"""Prototype query planner. No model calls or arbitrary code execution.

Phase two can replace plan_query with a DeepSeek adapter returning the same
validated specification. Calculations and rendering remain deterministic.
"""
import re
from datetime import date
from metric_registry import POLICY,LABELS,calculate,response_rate

METRICS = {key:value for key,value in LABELS.items() if key!='plan'}
MONTH_NAMES = 'январ феврал март апрел ма июн июл август сентябр октябр ноябр декабр'.split()
WEEK_REQUEST = r'по\s+неделям|понедельн(?:о|ая|ую|ой|ые|ых|ым)\b|еженедельн\w*'


MONTH_PATTERN = '('+'|'.join(stem if stem!='ма' else r'ма[йяею]' for stem in MONTH_NAMES)+r')\w*\b'
YEAR = r'((?:19|20|21)\d{2})'

class CalendarError(ValueError):
    code='calendar_period'


def calendar_phrase(text):
    def month(stem):
        return MONTH_NAMES.index('ма' if stem.startswith('ма') and stem not in ('март',) else stem)+1

    daily=re.search(r'\bс\s+(\d{1,2})\s+по\s+(\d{1,2})\s+'+MONTH_PATTERN+r'(?:\s+'+YEAR+r')?',text)
    if daily:
        if not daily[4]:raise CalendarError('Укажите год для диапазона дат.')
        year,number=int(daily[4]),month(daily[3])
        try:start,end=(date(year,number,int(daily[i])).isoformat() for i in (1,2))
        except ValueError:raise CalendarError('Укажите существующие даты начала и конца.') from None
        return daily,{'grain':'day','startDate':start,'endDate':end}
    span=re.search(r'\bс\s+'+MONTH_PATTERN+r'(?:\s+'+YEAR+r')?\s+по\s+'+MONTH_PATTERN+r'(?:\s+'+YEAR+r')?',text)
    if span:
        if not(span[2] or span[4]):raise CalendarError('Укажите год для диапазона месяцев.')
        return span,{'startMonth':f'{span[2] or span[4]}-{month(span[1]):02d}',
                     'endMonth':f'{span[4] or span[2]}-{month(span[3]):02d}'}
    single=re.search(r'\b(с|за)\s+'+MONTH_PATTERN+r'(?:\s+'+YEAR+r')?',text)
    if not single:return None
    if not single[3]:raise CalendarError('Укажите год для выбранного месяца, например «за сентябрь 2026».')
    key=f'{single[3]}-{month(single[2]):02d}'
    return single,{'startMonth':key,**({'endMonth':key} if single[1]=='за' else {})}


def normalize_rate_phrase(text):
    return re.sub(r'(?:процент|дол[яюи]|уровень)\s+(?:ответ|отклик)\w*', 'отклик', text)


def bind_explicit_chart_request(spec,query,previous=None):
    """Explicit calendar/scope in user text outranks a model's guessed fields."""
    if not isinstance(spec,dict):return spec,[]
    spec=dict(spec);text=query.lower().replace('ё','е');notes=[]
    calendar=calendar_phrase(text)
    if calendar:
        for key in ('startMonth','endMonth','startDate','endDate','daysCount'):spec.pop(key,None)
        spec.update(calendar[1]);notes.append('Явный период закреплён по запросу.')
    year=re.search(r'\bза\s+((?:19|20|21)\d{2})\s*год',text)
    if year and not re.search(r'\d+\s*(?:месяц|дн|день)|последн',text):
        fields={'monthsCount':12,'startMonth':year[1]+'-01','endMonth':year[1]+'-12'}
        if any(spec.get(k)!=v for k,v in fields.items()):notes.append('Явно заданный год закреплён сервером: январь–декабрь, двенадцать месяцев.')
        spec.update(fields)
    if re.search(r'по\s+месяцам',text):
        spec['grain']='month';spec.pop('daysCount',None)
    if previous and previous.get('grain')=='week' and re.search(r'добав|убер|остав',text) and not re.search(r'\bза\s|\bс\s+(?:начала|\d)|месяц|по\s+дням|'+WEEK_REQUEST,text) and not calendar:
        for key in ('grain','startMonth','endMonth','monthsCount'):
            if key in previous:spec[key]=previous[key]
            else:spec.pop(key,None)
        spec.pop('daysCount',None)
        notes.append('Недельный период сохранён при изменении кривых.')
    if re.search(WEEK_REQUEST,text):
        spec['grain']='week';spec.pop('daysCount',None)
        if re.search(r'опрос[а-я]*\s*[#№]?\s*\d+',text) and not re.search(r'отправ|ответ|отклик|событ|csi|оценк|стоп|политик|план|добав|убер',text):
            spec.update(metrics=['events','sends','answers'],layout='combined')
            spec.pop('series',None)
    all_surveys=bool(re.search(r'(?:всем|все|всех)\s+опрос',text))
    channel='communication' if re.search(r'пуш|смс',text) else 'success_screen' if re.search(r'экран',text) else None
    # Unambiguous whole-channel request: stale individual IDs/extra model filters
    # must not narrow the requested population. More specific filters stay typed.
    if all_surveys and channel and not re.search(r'опрос[а-я]*\s*[#№]?\s*\d+',text) and not re.search(r'продукт|групп|приоритет|\bтоп\b|триггер|общий|кроме|исключ',text):
        if spec.get('ids')!=[] or spec.get('filters')!={'channel':channel}:notes.append('Все опросы явно указанного канала: прежние ID и лишние фильтры модели сняты.')
        spec['ids']=[];spec['filters']={'channel':channel};spec.pop('series',None)
    return spec,notes


def validate_spec(spec):
    if isinstance(spec,dict) and any(k in spec for k in ('filters','grain','plan','visualSuggestions','daysCount','series','startDate','endDate')):
        extra={k:spec[k] for k in ('filters','grain','plan','visualSuggestions','daysCount','series','startDate','endDate') if k in spec}
        if 'startDate' in extra or 'endDate' in extra:
            try:
                start,end=(date.fromisoformat(extra[k]) for k in ('startDate','endDate'))
                if any(extra[k]!=v.isoformat() for k,v in (('startDate',start),('endDate',end))):raise ValueError()
            except (KeyError,TypeError,ValueError):raise ValueError('Задайте обе даты в формате ГГГГ-ММ-ДД.') from None
            if not 0<=(end-start).days<366 or extra.get('grain') not in ('day','week') or 'daysCount' in extra or 'startMonth' in spec or 'endMonth' in spec:
                raise ValueError('Выберите интервал до 366 дней и группировку по дням или неделям.')
        if 'daysCount' in extra and (type(extra['daysCount']) is not int or not 1<=extra['daysCount']<=366):raise ValueError('Выберите от 1 до 366 дней.')
        if 'series' in extra:
            pairs=extra['series']
            if not isinstance(pairs,list) or not 1<=len(pairs)<=24 or any(not isinstance(p,dict) or set(p)!={'id','metric'} or type(p['id']) is not int or p['id'] not in spec.get('ids',[]) or p['metric'] not in spec.get('metrics',[]) for p in pairs):raise ValueError('Некорректный состав кривых.')
        if 'visualSuggestions' in extra and (not isinstance(extra['visualSuggestions'],list) or not 2<=len(extra['visualSuggestions'])<=3 or any(v not in ('bars','area','presentation','panels') for v in extra['visualSuggestions'])): raise ValueError('Некорректные варианты визуализации.')
        filters=extra.get('filters',{})
        if not isinstance(filters,dict) or set(filters)-{'top','type','channel','triggerGroup','product'}: raise ValueError('Некорректные фильтры.')
        if 'product' in filters and (not isinstance(filters['product'],str) or not 1<=len(filters['product'])<=200):raise ValueError('Некорректный продукт.')
        if 'triggerGroup' in filters and (not isinstance(filters['triggerGroup'],str) or not filters['triggerGroup'].strip() or len(filters['triggerGroup'])>120): raise ValueError('Некорректная группа триггеров.')
        if 'top' in filters and type(filters['top']) is not bool: raise ValueError('Некорректный приоритет.')
        if 'type' in filters and filters['type'] not in ('Триггерный','Общий'): raise ValueError('Некорректный тип опроса.')
        if 'channel' in filters and filters['channel'] not in ('communication','success_screen'): raise ValueError('Некорректный канал.')
        if 'grain' in extra and extra['grain'] not in ('day','week','month'): raise ValueError('Некорректная детализация.')
        if extra.get('grain')=='week' and extra.get('daysCount'):raise ValueError('Для недельного графика задайте месяцы начала и конца.')
        if 'plan' in extra and type(extra['plan']) is not bool: raise ValueError('Некорректный план.')
        core={k:v for k,v in spec.items() if k not in extra}
        if extra.get('plan') and isinstance(core.get('metrics'),list): core['metrics']=[m for m in core['metrics'] if m!='plan']
        original_ids=core.get('ids')
        if (filters or extra.get('daysCount')) and original_ids==[]: core['ids']=[1]
        result=validate_spec(core)
        result['ids']=original_ids
        return result|extra

    if not isinstance(spec, dict):
        raise ValueError('Модель должна вернуть объект параметров графика.')
    if set(spec)-{'ids', 'metrics', 'monthsCount', 'layout', 'startMonth', 'endMonth'}:
        raise ValueError('В ответе модели есть неподдерживаемые параметры.')
    ids, metrics, count = spec.get('ids'), spec.get('metrics'), spec.get('monthsCount')
    aggregate = metrics == ['unique_surveys']
    if not isinstance(ids, list) or not (0 if aggregate else 1) <= len(ids) <= 4 or any(type(i) is not int or not 1 <= i <= 9999999 for i in ids):
        raise ValueError('Укажите от 1 до 4 корректных ID опросов.')
    if not isinstance(metrics, list) or not 1 <= len(metrics) <= 6 or any(not isinstance(m, str) or m not in METRICS for m in metrics):
        raise ValueError('Доступны отправки, ответы, события, CSI, стоп-листы, политика контактов и уникальные опросы.')
    if 'unique_surveys' in metrics and not aggregate:
        raise ValueError('Количество уникальных опросов запрашивайте отдельным графиком.')
    if type(count) is not int or not 1 <= count <= 24:
        raise ValueError('Выберите период от 1 до 24 месяцев.')
    layout = spec.get('layout', 'combined' if len(metrics)>1 else 'separate')
    if layout not in ('combined', 'separate'):
        raise ValueError('Режим графика: combined или separate.')
    result = {'ids':list(dict.fromkeys(ids)), 'metrics':list(dict.fromkeys(metrics)), 'monthsCount':count, 'layout':layout}
    for key in ('startMonth', 'endMonth'):
        if key in spec:
            value = spec[key]
            if not isinstance(value, str) or not re.fullmatch(r'(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])', value):
                raise ValueError('Период должен содержать месяцы в формате YYYY-MM (1900–2199).')
            result[key] = value
    if 'endMonth' in result and ('startMonth' not in result or result['endMonth'] < result['startMonth']):
        raise ValueError('Конец периода должен быть не раньше начала.')
    return result


def plan_query(query, previous=None):
    if not isinstance(query, str) or not query.strip() or len(query) > 1200:
        raise ValueError('Введите запрос длиной до 1200 символов.')
    text = query.lower().replace('ё', 'е')
    if re.search(r'почему|причин|предска|прогноз', text):
        raise ValueError('Сначала постройте график показателей. Затем откройте «Расследовать отклонение» или спросите «Почему выросли отправки?». Вклад опросов и события календаря помогают проверить причины, но не доказывают их.')
    if re.search(r'по дням|по неделям', text):
        raise ValueError('В прототипе доступна группировка по месяцам. Укажите период в месяцах.')
    previous = validate_spec(previous) if previous else {}
    year_match = re.search(r'(?:за\s+|с\s*начала\s+|с\s+)((?:19|20|21)\d{2})(?:\s*год\w*)?', text)
    id_text = re.sub(r'\d+\s*месяц\w*', '', text)
    if year_match:
        id_text = re.sub(r'(?<!\d)'+year_match[1]+r'(?!\d)', '', id_text)
    ids = [int(x) for x in re.findall(r'(?<!\d)(\d{1,7})(?!\d)', id_text)]
    ids = list(dict.fromkeys(ids))
    followup = bool(re.search(r'добав|сравн|еще|теперь|остав|убер', text))
    if followup and re.search(r'добав|сравн', text):
        ids = list(dict.fromkeys(previous.get('ids', []) + ids))
    unique = bool(re.search(r'уникальн\w*\s+опрос|опрос\w*\s+уникальн', text))
    ids = ids or ([] if unique else previous.get('ids', []))
    if (not ids and not unique and previous.get('metrics') != ['unique_surveys']) or len(ids) > 4:
        raise ValueError('Укажите от 1 до 4 номеров опросов. Например: «Сравни отправки опросов 193 и 1007».')
    metric_text=normalize_rate_phrase(text)
    metrics = ['unique_surveys'] if unique else [key for key, pattern in [('sends', r'отправ|коммуникац'), ('answers', r'ответ'), ('responseRate',r'отклик'), ('events', r'событ'), ('csi', r'csi|оценк'), ('stop', r'стоп[\s-]*лист'), ('contactPolicy', r'политик\w*\s+контакт')] if re.search(pattern, metric_text)]
    if re.search(r'убер|убра|исключ', text) and previous:
        metrics = [m for m in previous['metrics'] if m not in metrics]
        if not metrics:
            raise ValueError('На графике должен остаться хотя бы один показатель.')
    elif re.search(r'добав', text) and not unique:
        metrics = list(dict.fromkeys(previous.get('metrics', []) + metrics))
    metrics = metrics or previous.get('metrics', ['sends'])
    match = re.search(r'(?:последн\w*|за)\s+(\d{1,2})\s*месяц', text)
    count = int(match[1]) if match else previous.get('monthsCount', 3)
    if re.search(r'весь период|все месяцы', text):
        count = 24
    if not isinstance(count, int) or not 1 <= count <= 24:
        raise ValueError('Выберите период от 1 до 24 месяцев.')
    layout = previous.get('layout', 'combined' if len(metrics)>1 else 'separate')
    if re.search(r'на одном|один график|объедин|совмест|вместе', text):
        layout = 'combined'
    elif re.search(r'отдельн|раздельн|разным график', text):
        layout = 'separate'
    elif len(metrics)>1 and ('layout' not in previous or not followup or re.search(r'добав', text)):
        layout = 'combined'
    result = {'ids': ids, 'metrics': metrics, 'monthsCount': count, 'layout':layout}
    if year_match:
        result['startMonth'] = year_match[1]+'-01'
        if not re.search(r'с\s*(?:начала\s+)?'+year_match[1], text):
            result['endMonth'] = year_match[1]+'-12'
    elif not match and not re.search(r'весь период|все месяцы', text):
        result.update({k: previous[k] for k in ('startMonth', 'endMonth') if k in previous})
    result,_=bind_explicit_chart_request(result,query)
    return validate_spec(result)


def execute_query(state, spec, source):
    spec = validate_spec(spec)
    ids, metrics = spec['ids'], spec['metrics']
    if any(not isinstance(i, int) or isinstance(i, bool) for i in ids) or any(k not in METRICS for k in metrics):
        raise ValueError('Некорректные параметры запроса.')
    by_id = {s['event']['id']: s for s in state['surveys']}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise ValueError('Нет данных по опросам '+', '.join(map(str, missing))+'. Добавьте их строки в date/push-sms.csv или date/success-screen.csv и повторите запрос.')
    selected = ids or list(by_id)
    if not selected:
        raise ValueError('Нет загруженных данных для построения графика.')
    last = max(m for i in selected for m in by_id[i]['meta']['availableMonths'])
    year, month = map(int, last.split('-'))
    end = year*12+month-1
    start = end-spec['monthsCount']+1
    if 'startMonth' in spec:
        y, m = map(int, spec['startMonth'].split('-'))
        start = y*12+m-1
        y, m = map(int, spec.get('endMonth', last).split('-'))
        end = y*12+m-1
    if end < start:
        raise ValueError('В загруженных данных ещё нет месяцев выбранного периода.')
    if end-start >= 120:
        raise ValueError('Выберите период не длиннее 120 месяцев.')
    months = ['%04d-%02d' % (n//12, n%12+1) for n in range(start, end+1)]
    blocks, totals, table, warnings = [], [], [], []
    methods = ['Пропущенные месяцы не заменяются нулями. CSI — средняя по допустимым оценкам 1–5; оценка 0 сохраняется, но не входит в CSI.']
    if 'stop' in metrics:
        methods.append('Стоп-листы: число событий со status_det = 1002.')
    if 'contactPolicy' in metrics:
        methods.append('Политика контактов: число событий со status_det из списка '+', '.join(map(str, POLICY))+'.')
    if metrics == ['unique_surveys']:
        methods.append('Уникальные опросы: число различных ID с наблюдениями в каждом месяце, независимо от объёма событий. Справочник без наблюдений не учитывается. Итог — различные ID за весь период, а не сумма месяцев.')
        values = [sum(m in by_id[i]['meta']['availableMonths'] for i in selected) or None for m in months]
        blocks.append({'id':None, 'name':'Уникальные опросы', 'metric':'unique_surveys', 'label':METRICS['unique_surveys'], 'values':values})
        totals.append({'id':None, 'name':'Уникальные опросы', 'metric':'unique_surveys', 'label':METRICS['unique_surveys'], 'value':sum(any(m in by_id[i]['meta']['availableMonths'] for m in months) for i in selected) if any(v is not None for v in values) else None, 'note':'Различных ID за выбранный период'})
        table.extend({'id':None, 'name':'Все выбранные опросы', 'month':m, 'metric':METRICS['unique_surveys'], 'value':v} for m,v in zip(months,values))
    for ident in ([] if metrics == ['unique_surveys'] else ids):
        survey = by_id[ident]
        event, meta = survey['event'], survey['meta']
        record_months={}
        for row in state.get('rawRecords',[]):
            if row['id']==ident and row['channel']==meta['channel']:record_months.setdefault(row['date'][:7],[]).append(row)
        for metric in metrics:
            values = []
            for m in months:
                index = event['months'].index(m) if m in event['months'] else None
                value = None
                if index is not None and m in meta['availableMonths']:
                    if metric in ('stop', 'contactPolicy'):
                        codes = [1002] if metric == 'stop' else POLICY
                        statuses = [s for s in event['statuses'] if s['code'] in codes]
                        if meta['channel'] != 'success_screen' and statuses:
                            value = sum(s['values'][index] for s in statuses)
                    elif metric=='responseRate':
                        value=response_rate(event['responseTotals'][index],event['sendTotals'][index])
                    else:
                        field = {'sends':'sendTotals','answers':'responseTotals','events':'totals','csi':'csiValues'}[metric]
                        value = event.get(field, [None]*len(event['months']))[index]
                    if record_months.get(m):value=calculate(record_months[m],metric,'month')
                values.append(value)
                table.append({'id':ident, 'name':meta['name'], 'month':m, 'metric':METRICS[metric], 'value':value})
            known = [v for v in values if v is not None]
            value = values[-1] if metric == 'csi' else sum(known) if known else None
            totals.append({'id':ident, 'name':meta['name'], 'metric':metric, 'label':METRICS[metric], 'value':value, 'note':'Последний месяц · средняя оценка' if metric=='csi' else '%s из %s месяцев с данными' % (len(known),len(months))})
            blocks.append({'id':ident, 'name':meta['name'], 'metric':metric, 'label':METRICS[metric], 'values':values})
            if metric in ('stop', 'contactPolicy') and not known:
                warnings.append('#%s: нет подходящих status_det для показателя «%s». Для экранов успеха эти отсечения не применяются; без строк статусов значение не подтверждено.' % (ident, METRICS[metric]))
        if meta.get('missingDates'):
            warnings.append('#%s: дневная выборка неполная; в месячном итоге только переданные даты.' % ident)
    warnings.append('Последний месяц (%s) может быть неполным. Отсутствующие месяцы показаны как «Нет данных».' % last)
    return {'spec':spec, 'source':source, 'months':months, 'blocks':blocks, 'totals':totals, 'table':table, 'warnings':warnings, 'methods':methods, 'periodLabel':months[0]+' — '+months[-1], 'anchor':last}
