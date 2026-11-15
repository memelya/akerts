"""Typed model proposals plus explicit, auditable user scope rules."""
import copy,re
from agent_schema import plan as validate_plan
from products import product_from_query
from metric_registry import LABELS

class CreativeLimit(ValueError):
    def __init__(self,message,scope=False):
        super().__init__(message)
        self.recovery={'message':message,'options':[{'label':'Обзор без временной детализации','suffix':' Без временной детализации, одна точка на опрос. Сохрани все опросы продукта.'},{'label':'Последний загруженный месяц','suffix':' Используй только последний загруженный месяц, без временной детализации. Сохрани все опросы продукта.'},{'label':'Изменить условия','edit':True}]}
        if scope:self.recovery['options']=[{'label':'Уточнить продукт или номера опросов','edit':True}]

def temporal(query,year=None):
    q=query.lower().replace('ё','е');names=['январ','феврал','март','апрел','ма','июн','июл','август','сентябр','октябр','ноябр','декабр']
    if re.search(r'последн\w*\s+загруженн\w*\s+месяц',q):return {'grain':'month','months':1,'comparison':'previous'}
    for i,name in enumerate(names,1):
        stem=name if i!=5 else r'ма[йяею]'
        m=re.search(r'\b'+stem+r'\w*\s+((?:19|20|21)\d{2})',q)
        if m:return {'grain':'month','months':1,'comparison':'previous','startMonth':f'{m[1]}-{i:02d}','endMonth':f'{m[1]}-{i:02d}'}
        if year and re.search(r'\b(?:за|в|на)\s+'+stem+r'\w*\b',q):return {'grain':'month','months':1,'comparison':'previous','startMonth':f'{year}-{i:02d}','endMonth':f'{year}-{i:02d}'}
    m=re.search(r'(?:последн\w*\s+|за\s+)(\d{1,3})\s*(?:дн\w*|день)',q)
    if m:return {'grain':'day','days':int(m[1]),'comparison':'previous'}
    m=re.search(r'(?:последн\w*\s+|за\s+)(\d{1,2})\s*месяц',q)
    if m:return {'grain':'month','months':int(m[1]),'comparison':'previous'}
    m=re.search(r'за\s+((?:19|20|21)\d{2})\s*год',q)
    if m:return {'grain':'month','months':12,'comparison':'previous','startMonth':m[1]+'-01','endMonth':m[1]+'-12'}
    return None

def requested_ranking(query):
    q=query.lower().replace('ё','е');match=re.search(r'\b(?:топ\s*[-–]?\s*|top\s+)(\d{1,4})\b',q)
    if not match:match=re.search(r'\b(\d{1,4})\s+опрос[а-я]*\s+с\s+(?:наибольш|максимальн|самым\s+больш)[а-я]*\s+(?:количеств|числ|объем)[а-я]*',q)
    if not match:match=re.search(r'\b(\d{1,4})\s+(?:самых\s+)?(?:больш[а-я]*|крупн[а-я]*|крупнейш[а-я]*)\s+опрос[а-я]*\b',q)
    if not match:return None
    n=int(match[1])
    if not 1<=n<=500:raise ValueError('Для рейтинга выберите от одного до 500 опросов.')
    metrics=[m for m,pattern in [('sends',r'отправ'),('answers',r'ответ'),('events',r'событ'),('csi',r'\bcsi\b'),('stop',r'стоп'),('contactPolicy',r'политик\w*\s+контакт')] if re.search(pattern,q)]
    # One explicit sorting metric. Extra displayed metrics can be added later.
    metric=metrics[0] if len(metrics)==1 else None
    if metric is None:raise ValueError('Уточните один показатель рейтинга: например «топ 10 опросов по отправкам».')
    return {'limit':n,'metric':metric,'order':'desc'}

def proposal(raw,job,metrics_allowed):
    if not isinstance(raw,dict) or set(raw)-{'analysis','metrics','includeTrend','maxSurveys'}:raise ValueError('Нужны analysis, metrics, includeTrend и необязательный maxSurveys. Не добавляйте другие поля.')
    raw=copy.deepcopy(raw);analysis=raw.get('analysis')
    if not isinstance(analysis,dict) or not isinstance(analysis.get('scope'),dict):raise ValueError('analysis.scope должен быть объектом отбора.')
    scope=analysis['scope'];query=job['query'];ranking=requested_ranking(query);q=query.lower().replace('ё','е');base=job.get('creativeBase');notes=[]
    previous=job.get('previousChart') or {}
    chart_followup=bool(previous.get('ids') and not ranking and re.match(r'\s*(?:добав|убер|объедин|остав|измени\s+оформ)',q))
    explicit_product=product_from_query(query,job['state'].get('productNames',[]))
    explicit_ids=[int(n) for n in re.findall(r'опрос[а-я]*\s*[#№]?\s*(\d+)',q)]
    continuation=bool(base and re.search(r'измени|добав|убери|перекрас|легенд|оформ|подпиш|формат|уточн',q))
    if not ranking and continuation and base['agentPlan'].get('ranking'):ranking=copy.deepcopy(base['agentPlan']['ranking'])
    top_requested=bool(re.search(r'приоритет\w*.*\bтоп\b|приоритет\w*\s+друг|только\s+(?:опрос\w*\s+)?топ\b|\bтоп\s+опрос|опрос\w*\s+топ\b|(?:без|кроме)\s+(?:опрос\w*\s+)?топ\b',q)) or bool(continuation and 'top' in base['agentPlan']['scope'])
    if re.search(r'все\s+приоритет',q):top_requested=False
    if 'priorityTopOnly' in scope:
        if 'top' in scope:raise ValueError('Не дублируйте priorityTopOnly и устаревшее top.')
        scope['top']=scope.pop('priorityTopOnly')
    if ranking:
        for field,explicit in [('product',bool(explicit_product)),('channel',bool(re.search(r'пуш|смс|экран',q))),('type',bool(re.search(r'триггер|общий',q))),('triggerGroup',bool(re.search(r'групп',q))),('top',top_requested)]:
            if field in scope and not explicit:
                scope.pop(field);notes.append('Пользователь не ограничивал '+{'product':'продукт','channel':'канал','type':'тип опроса','triggerGroup':'группу триггеров','top':'приоритет'}[field]+': это ограничение модели снято.')
        if top_requested and 'top' not in scope:scope['top']=not bool(re.search(r'друг|(?:без|кроме).*топ',q))
    if 'top' in scope and scope['top'] is not None:
        if type(scope['top']) is not bool:raise ValueError('priorityTopOnly принимает только true/false, не число 30 и не строку. Это фильтр приоритета, не размер выборки. Если пользователь не просил приоритет, удалите поле.')
        if not top_requested:raise ValueError('Пользователь не просил фильтр приоритета. Удалите priorityTopOnly/top, чтобы сохранить все приоритеты.')
    max_surveys=raw.get('maxSurveys',500)
    if ranking and type(max_surveys) is int and 1<=max_surveys<=1000000:max_surveys=500
    if type(max_surveys) is not int or not 1<=max_surveys<=500:raise ValueError('maxSurveys — целое число от одного до 500; это предел ресурса, а не фильтр приоритета. Нельзя выбирать первые N опросов.')
    if explicit_product:
        if scope.get('product')!=explicit_product or scope.get('ids') and not explicit_ids:notes.append('Явно названный продукт заменяет прежний отбор по номерам опросов.')
        if (job.get('previousChart') or {}).get('ids') and not explicit_ids and not notes:notes.append('Номера опросов предыдущего графика не ограничивают явно названный продукт.')
        scope['product']=explicit_product
        if not explicit_ids:scope['ids']=[]
        if scope.get('channel') and not re.search(r'пуш|смс|экран',q) and not continuation:raise ValueError('Для всего продукта пользователь не ограничил канал. Удалите channel, чтобы включить оба канала.')
    elif continuation and not explicit_ids and not re.search(r'приоритет|\bтоп\b|пуш|смс|экран|групп|триггер|общий|все\s+опрос',q):
        analysis['scope']=copy.deepcopy(base['agentPlan']['scope']);notes.append('Отбор сохранён из изменяемой визуализации; оформление не меняет состав расчёта.')
    elif chart_followup and not explicit_ids and not explicit_product and not re.search(r'приоритет|\bтоп\b|пуш|смс|экран|групп|триггер|общий|все\s+опрос',q):
        analysis['scope']={'ids':previous['ids'],**previous.get('filters',{})}
        notes.append('Опросы и фильтры взяты из текущего графика.')
    if re.search(r'канал:\s*экран успеха',q):analysis['scope']['channel']='success_screen'
    elif re.search(r'канал:\s*пуш\s*\+\s*смс',q):analysis['scope']['channel']='communication'
    available=[m for s in job['state']['surveys'] if not explicit_product or explicit_product in s['meta'].get('products',[]) for m in s['meta']['availableMonths']]
    requested_period=temporal(query,max(available)[:4] if available else None)
    if requested_period:analysis['period']=requested_period
    elif continuation:
        analysis['period']=copy.deepcopy(base['agentPlan']['period']);notes.append('Период сохранён из изменяемой визуализации.')
    elif chart_followup and (previous.get('grain')=='week' or previous.get('startDate')):
        raise ValueError('Для этого периода сохраните недельный или дневной график обычным запросом. Для нового дашборда явно укажите месяц или число дней.')
    elif chart_followup and previous.get('startMonth') and previous.get('endMonth'):
        start,end=previous['startMonth'],previous['endMonth']
        y,m=map(int,start.split('-'));ey,em=map(int,end.split('-'))
        months=(ey-y)*12+em-m+1
        if months>12:raise ValueError('Для нового дашборда выберите до 12 месяцев. Текущий график сохранён.')
        analysis['period']={'grain':'month','months':months,'comparison':'previous','startMonth':start,'endMonth':end}
        notes.append('Месяцы взяты из текущего графика.')
    elif chart_followup and previous.get('daysCount'):
        analysis['period']={'grain':'day','days':previous['daysCount'],'comparison':'previous'}
        notes.append('Дневной период взят из текущего графика.')
    elif chart_followup:
        if previous['monthsCount']>12:raise ValueError('Для нового дашборда выберите до 12 месяцев. Текущий график сохранён.')
        analysis['period']={'grain':'month','months':previous['monthsCount'],'comparison':'previous'}
        if previous.get('startMonth'):
            end=max((month for survey in job['state']['surveys'] if survey['event']['id'] in previous['ids']
                     for month in survey['meta']['availableMonths']),default=previous['startMonth'])
            start=previous['startMonth']
            y,m=map(int,start.split('-'));ey,em=map(int,end.split('-'))
            months=(ey-y)*12+em-m+1
            if not 1<=months<=12:raise ValueError('Для нового дашборда явно укажите период до 12 месяцев.')
            analysis['period'].update(months=months,startMonth=start,endMonth=end)
        notes.append('Период взят из текущего графика.')
    else:
        analysis['period']={'grain':'month','months':1,'comparison':'previous'};notes.append('Период не указан: предложен последний загруженный месяц выбранного отбора. Перед генерацией его можно проверить.')
    if continuation and base['agentPlan'].get('answersTarget'):
        analysis['answersTarget']=copy.deepcopy(base['agentPlan']['answersTarget']);notes.append('Дневной план сохранён из изменяемой визуализации.')
    metrics=raw.get('metrics');trend=raw.get('includeTrend',False)
    if not isinstance(metrics,list) or not 1<=len(metrics)<=4 or any(m not in metrics_allowed for m in metrics) or type(trend) is not bool:raise ValueError('Нужны от одного до четырёх известных показателей и includeTrend true/false.')
    if chart_followup and re.match(r'\s*добав',q) and re.search(r'\bcsi\b',q):
        metrics=list(dict.fromkeys([m for m in previous['metrics'] if m in metrics_allowed]+['csi']))
        if len(metrics)>4:raise ValueError('Дашборд поддерживает до четырёх показателей. Уточните, какие из них оставить вместе с CSI.')
    if re.search(r'csi|сиэса',q) and re.search(r'выполн\w*\s+план',q):
        if not {'csi','planCompletion'}<=set(metrics):raise ValueError('Запрошены CSI и выполнение плана: нужны csi и planCompletion.')
        allowed={'csi','planCompletion'}
        for metric,pattern in [('sends',r'отправ'),('answers',r'(?:число|количество|факт\w*|собранн\w*)\s+ответ|(?:и|добавь|покажи)\s+ответ'),('events',r'событ'),('stop',r'стоп'),('contactPolicy',r'политик'),('replyRatio',r'отношен\w*\s+ответ|конверси'),('planExpected',r'(?:отдельн\w*|добавь|и)\s+план\w*\s+ответ|планов\w*\s+ответ')]:
            if re.search(pattern,q):allowed.add(metric)
        if any(m not in allowed for m in metrics):metrics=[m for m in metrics if m in allowed];notes.append('Оставлены явно запрошенные показатели; дополнительные линии не добавлялись.')
    explicit_trend=bool(re.search(r'по\s+дням|по\s+месяцам|динамик|тренд|временн\w*\s+(?:график|ряд)|как.*менял|(?:объедин|на\s+одном\s+графике)',q))
    if re.search(r'без\s+временн\w*\s+детализац|одна\s+точка\s+на\s+опрос',q):trend=False
    elif explicit_trend or chart_followup:
        trend=True
    elif not continuation:
        if trend:notes.append('Временная динамика не запрашивалась: предложено сравнение опросов за окно.')
        trend=False
    if ranking:
        analysis['ranking']=ranking;analysis.update(criteria={},criteriaReason='Рейтинг по сумме показателя за выбранный период, без порогов аномалий.',goal='investigate',sustained=False,maxItems=min(15,ranking['limit']),audience='analyst');metrics=[ranking['metric']];analysis['title']='Топ '+str(ranking['limit'])+' опросов · '+{'sends':'Отправки','answers':'Ответы','events':'События','csi':'CSI','stop':'Стоп-листы','contactPolicy':'Политика контактов'}[ranking['metric']]
        if not explicit_ids and not continuation:analysis['scope']['ids']=[]
        notes.append('Топ '+str(ranking['limit'])+' определяется локально по показателю «'+LABELS[ranking['metric']]+'» за выбранный период среди всего отбора. Это рейтинг, а не приоритет Топ и не первые строки файла.')
    elif analysis.get('ranking'):raise ValueError('Рейтинг не запрошен пользователем. Удалите ranking.')
    if analysis.get('answersTarget'):
        inherited=base['agentPlan'].get('answersTarget') if continuation and base else None
        if not inherited or analysis['answersTarget']!=inherited:raise ValueError('Не добавляйте дневной план, который пользователь не задавал. Удалите answersTarget.')
    plan=validate_plan(analysis)
    if plan['kind'] not in ('workspace','research','selection'):raise ValueError('Нужен план данных workspace/research/selection, не готовый chart.')
    return plan,list(dict.fromkeys(metrics)),trend,notes

def compact(data,budget=7000):
    """Examples for designing UI only. Runtime retains every survey and fact."""
    import json
    facts={r[0]:dict(zip(data['factColumns'],r)) for r in data['facts']};chosen=[]
    def add(s):
        if s and s not in chosen:chosen.append(s)
    for metric in data['labels']:
        ordered=sorted((s for s in data['surveys'] if facts[s['refs'][metric]]['actual'] is not None),key=lambda s:facts[s['refs'][metric]]['actual'])
        if ordered:add(ordered[0]);add(ordered[-1])
    for s in data['surveys']:add(s)
    chosen=chosen[:5];stats={}
    for metric in data['labels']:
        values=[facts[s['refs'][metric]]['actual'] for s in data['surveys']];known=[v for v in values if v is not None]
        stats[metric]={'known':len(known),'missing':len(values)-len(known),'min':min(known) if known else None,'max':max(known) if known else None}
    result={k:data[k] for k in ('title','period','factColumns','labels')}
    if data.get('answersTarget'):result['answersTarget']=dict(data['answersTarget'])
    if data.get('ranking'):result['ranking']={k:v for k,v in data['ranking'].items() if k!='winners'}
    result.update(sampleOnly=True,fullRuntimeData=True,totalSurveys=len(data['surveys']),totalFacts=len(data['facts']),totalSeries=len(data['series']),ranges=stats,samplePurpose='Примеры только для проектирования интерфейса, а не отбор расчёта. ui.data в браузере содержит ВСЕ опросы, значения и ряды. Не ограничивайте UI примерами; используйте перебор ui.data.surveys и ui.data.series, для большого набора — страницы или фильтр отображения.')
    while True:
        keys={s['key'] for s in chosen};refs={r for s in chosen for r in s['refs'].values()};series=[]
        for item in data['series']:
            if item['key'] in keys and len(series)<2:
                indices=sorted({0,len(item['points'])//2,len(item['points'])-1});points=[item['points'][i] for i in indices if i>=0];refs.update(r for _,r in points);series.append(dict(item,points=points,sampledPoints=True,totalPoints=len(item['points'])))
        result.update(surveys=[dict(s,name=s['name'][:90]) for s in chosen],facts=[r for r in data['facts'] if r[0] in refs],series=series)
        if len(json.dumps(result,ensure_ascii=False,separators=(',',':')))<=budget or len(chosen)<=1:return result
        chosen.pop()
