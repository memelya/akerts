"""Validated model plans and UI components; executable content is never accepted."""
import math,re
from analysis_evidence import criteria,CORE,PRIORITY
from genui_query import validate_spec

def obj(value,keys,label):
    if not isinstance(value,dict) or set(value)-set(keys):raise ValueError('Неподдерживаемые поля: '+label)
    return value
def phrase(value,label,limit=400,numbers=True,plain=False):
    if not isinstance(value,str) or not value.strip() or len(value)>limit or (not plain and ('<' in value or '>' in value)):raise ValueError('Некорректный текст: '+label)
    if not numbers and re.search(r'\d',value):raise ValueError('Не вписывайте числа в текст '+label+': используйте factRefs, значения добавит сервер.')
    if re.search(r'вызван|доказан[а-я]*\s+причин|из-за|причиной\s+явля|денежн[а-я]*\s+ущерб|потер[а-я]*\s+выруч',value,re.I):raise ValueError('Причинная связь или денежный ущерб не подтверждены данными. Укажите гипотезу и проверку.')
    return value.strip()

def plan(value):
    obj(value,('kind','title','scope','period','criteria','criteriaReason','goal','sustained','maxItems','audience','question','options','spec','search','ranking','answersTarget'),'план')
    kind=value.get('kind')
    if kind=='clarify':
        options=value.get('options',[])
        if not isinstance(options,list) or len(options)>3:raise ValueError('Допустимо до трёх вариантов уточнения.')
        return {'kind':kind,'question':phrase(value.get('question'),'уточнение'),'options':[phrase(v,'вариант',200) for v in options]}
    if kind=='catalog_search':return {'kind':kind,'search':phrase(value.get('search'),'поиск',160)}
    if kind=='chart':return {'kind':kind,'spec':validate_spec(value.get('spec'))}
    if kind not in ('workspace','research','selection'):raise ValueError('Модель должна выбрать workspace, research, selection, chart или clarify.')
    scope=obj(value.get('scope'),('ids','product','channel','top','type','triggerGroup'),'отбор');ids=scope.get('ids',[])
    if not isinstance(ids,list) or len(ids)>200 or any(type(i) is not int or not 1<=i<=9999999 for i in ids):raise ValueError('Некорректные ID отбора.')
    normalized={'ids':list(dict.fromkeys(ids))}
    for k,v in scope.items():
        if k=='ids' or v in ('',None):continue
        if k=='top':
            if type(v) is not bool:raise ValueError('Приоритет Топ — логическое значение.')
        elif k=='channel':
            if v not in ('communication','success_screen'):raise ValueError('Неизвестный канал.')
        elif k=='type':
            if v not in ('Общий','Триггерный'):raise ValueError('Неизвестный тип опроса.')
        else:v=phrase(v,'фильтр',200)
        normalized[k]=v
    period=obj(value.get('period'),('grain','days','months','comparison','startMonth','endMonth','startDate','endDate'),'период');grain=period.get('grain');p={'grain':grain,'comparison':period.get('comparison','previous')}
    if grain not in ('day','month') or p['comparison'] not in ('previous','weekday'):raise ValueError('Укажите день/месяц и previous/weekday.')
    if grain=='day':
        n=period.get('days',7)
        if type(n) is not int or not 1<=n<=366:raise ValueError('Выберите от одного до 366 дней.')
        if period.get('startMonth') or period.get('endMonth'):raise ValueError('Для фиксированного месячного периода используйте grain=month.')
        p['days']=n
        if period.get('startDate') or period.get('endDate'):
            import datetime as dt
            try:
                start=dt.date.fromisoformat(period['startDate']);end=dt.date.fromisoformat(period['endDate'])
            except (ValueError,TypeError,KeyError):raise ValueError('Для дневного окна укажите startDate и endDate в формате YYYY-MM-DD.') from None
            if not 0<=(end-start).days<366:raise ValueError('Дневное окно должно содержать от одного до 366 дней.')
            p.update(startDate=start.isoformat(),endDate=end.isoformat())
    else:
        n=period.get('months',1)
        if type(n) is not int or not 1<=n<=12:raise ValueError('Выберите от одного до двенадцати месяцев.')
        p['months']=n
        for k in ('startMonth','endMonth'):
            v=period.get(k)
            if v:
                if not isinstance(v,str) or not re.fullmatch(r'(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])',v):raise ValueError('Месяц должен иметь формат YYYY-MM.')
                p[k]=v
        if p.get('endMonth') and not p.get('startMonth'):raise ValueError('Нужна начальная дата периода.')
        if p.get('endMonth','9999')<p.get('startMonth',''):raise ValueError('Конец периода раньше начала.')
    goal=value.get('goal','anomalies');sustained=value.get('sustained',False);max_items=value.get('maxItems',5);audience=value.get('audience','analyst')
    if goal not in ('anomalies','high_volume_declining_quality','investigate') or type(sustained) is not bool or type(max_items) is not int or not 1<=max_items<=15 or audience not in ('analyst','product_owner','executive'):raise ValueError('Некорректная цель, роль или размер очереди.')
    target=value.get('answersTarget')
    if target is not None:
        obj(target,('metric','value','grain','source'),'план ответов из запроса')
        if target.get('metric')!='answers' or type(target.get('value')) is not int or not 1<=target['value']<=1000000000 or target.get('grain')!='day' or target.get('source')!='user':raise ValueError('Нужен явный пользовательский дневной план ответов.')
    ranking=value.get('ranking')
    if ranking is not None:
        obj(ranking,('metric','limit','order'),'рейтинг')
        if ranking.get('metric') not in CORE or type(ranking.get('limit')) is not int or not 1<=ranking['limit']<=500 or ranking.get('order')!='desc':raise ValueError('Рейтинг: известный показатель, limit от 1 до 500, order=desc.')
    return dict({'kind':kind,'title':phrase(value.get('title'),'заголовок',160),'scope':normalized,'period':p,'criteria':criteria(value.get('criteria',{})),'criteriaReason':phrase(value.get('criteriaReason','Пороги предложены для первичной проверки.'),'обоснование порогов',400,False),'goal':goal,'sustained':sustained,'maxItems':max_items,'audience':audience},**({'ranking':dict(ranking)} if ranking else {}),**({'answersTarget':dict(target)} if target else {}))

def refs(values,evidence,key=None):
    if not isinstance(values,list) or not 1<=len(values)<=12 or len(set(values))!=len(values) or any(not isinstance(r,str) or r not in evidence.exposed for r in values):raise ValueError('Используйте только выданные сервером factRefs.')
    if key is not None and not any(evidence.facts[r].get('key')==key for r in values):raise ValueError('Основание карточки должно относиться к её опросу.')
    return values

def view(value,evidence):
    obj(value,('action','kind','title','summary','summaryRefs','components','keys','question','options'),'экран')
    action=value.get('action')
    if action=='inspect':
        keys=value.get('keys')
        if not isinstance(keys,list) or not 1<=len(keys)<=3 or len(set(keys))!=len(keys) or any(k not in evidence.members for k in keys):raise ValueError('Инспекция доступна только для опросов текущего отбора.')
        return {'action':'inspect','keys':keys}
    if action=='clarify':
        options=value.get('options',[])
        if not isinstance(options,list) or len(options)>3:raise ValueError('Допустимо до трёх вариантов уточнения.')
        return {'action':'clarify','question':phrase(value.get('question'),'уточнение'),'options':[phrase(x,'вариант',200) for x in options]}
    if action!='render' or value.get('kind') not in ('workspace','research','selection'):raise ValueError('Ожидается render со спецификацией экрана.')
    components=value.get('components')
    if not isinstance(components,list) or not 2<=len(components)<=8:raise ValueError('Экран должен содержать от двух до восьми блоков.')
    result={'action':'render','kind':value['kind'],'title':phrase(value.get('title'),'заголовок',160),'summary':phrase(value.get('summary'),'вывод',800,False),'summaryRefs':refs(value.get('summaryRefs'),evidence),'components':[]};queue_count=0
    for component in components:
        obj(component,('type','title','items','refs','keys','metrics','style','theme','eventRefs'),'компонент');kind=component.get('type');c={'type':kind,'title':phrase(component.get('title'),'заголовок блока',120)}
        if kind=='priority_queue':
            queue_count+=1;items=component.get('items');seen=set()
            if not isinstance(items,list) or len(items)>evidence.plan['maxItems']:raise ValueError('Очередь превышает выбранный размер.')
            c['items']=[]
            for item in items:
                obj(item,('key','priority','reason','factRefs','checks','hypotheses'),'приоритет');key=item.get('key');priority=item.get('priority')
                if not isinstance(key,str) or key not in evidence.eligible or key in seen or priority not in PRIORITY:raise ValueError('Приоритет назначается только отобранным опросам, без повторов.')
                seen.add(key);candidate=evidence.candidates[key];fact_refs=refs(item.get('factRefs'),evidence,key)
                if PRIORITY[priority]>PRIORITY[candidate['maxPriority']]:raise ValueError('Приоритет выше подтверждённого полнотой и выборкой: '+key)
                if PRIORITY[priority]>=PRIORITY['high'] and not set(fact_refs)&set(candidate['strongRefs']):raise ValueError('Высокий приоритет требует ссылки на достаточно надёжный сигнал.')
                checks=item.get('checks',[])
                if not isinstance(checks,list) or not 1<=len(checks)<=3:raise ValueError('Укажите от одной до трёх проверок.')
                hypotheses=item.get('hypotheses',[])
                if not isinstance(hypotheses,list) or len(hypotheses)>2:raise ValueError('Не больше двух гипотез на опрос.')
                hs=[]
                for h in hypotheses:
                    obj(h,('text','factRefs','eventRefs'),'гипотеза');ev=h.get('eventRefs',[])
                    if not isinstance(ev,list) or len(ev)>3 or any(e not in evidence.events or key not in evidence.events[e]['scopeKeys'] for e in ev):raise ValueError('Событие не соответствует отбору гипотезы.')
                    hs.append({'text':phrase(h.get('text'),'гипотеза',300,False),'factRefs':refs(h.get('factRefs'),evidence,key),'eventRefs':ev})
                c['items'].append({'key':key,'priority':priority,'reason':phrase(item.get('reason'),'приоритет',400,False),'factRefs':fact_refs,'checks':[phrase(x,'проверка',240,False) for x in checks],'hypotheses':hs})
            c['items'].sort(key=lambda i:-PRIORITY[i['priority']])
        elif kind in ('kpis','comparison'):c['refs']=refs(component.get('refs'),evidence)
        elif kind=='trend':
            keys=component.get('keys');metrics=component.get('metrics');style=component.get('style','line');theme=component.get('theme','default')
            if not isinstance(keys,list) or not 1<=len(keys)<=4 or len(set(keys))!=len(keys) or any(k not in evidence.members for k in keys) or len({evidence.members[k]['id'] for k in keys})!=len(keys):raise ValueError('График должен ссылаться на разные выданные ID; совпадающие номера разных каналов разделите.')
            if not isinstance(metrics,list) or not 1<=len(metrics)<=6 or any(m not in CORE for m in metrics) or style not in ('line','bars','area') or theme not in ('default','presentation'):raise ValueError('Неподдерживаемый показатель или оформление графика.')
            c.update(keys=keys,metrics=metrics,style=style,theme=theme)
        elif kind=='context':
            ev=component.get('eventRefs',[])
            if not isinstance(ev,list) or len(ev)>10 or any(e not in evidence.events for e in ev):raise ValueError('Неизвестное событие календаря.')
            c['eventRefs']=ev
        elif kind=='next_steps':
            items=component.get('items')
            if not isinstance(items,list) or not 1<=len(items)<=5:raise ValueError('Нужно от одного до пяти следующих действий.')
            c['items']=[]
            for item in items:
                obj(item,('text','factRefs'),'действие');c['items'].append({'text':phrase(item.get('text'),'действие',300,False),'factRefs':refs(item.get('factRefs'),evidence)})
        else:raise ValueError('Неизвестный тип компонента.')
        result['components'].append(c)
    if queue_count!=1 or result['components'][0]['type']!='priority_queue':raise ValueError('Первый блок — единственная очередь приоритетных проверок.')
    if evidence.eligible and not result['components'][0]['items']:raise ValueError('Есть сигналы: включите хотя бы один в очередь или запросите инспекцию.')
    return result
