"""One validated query contract for local rules and CLI suggestions."""
import copy,re
from genui_extended import plan_query,select_surveys
from genui_query import validate_spec
from metric_registry import LABELS,VERSION

class Clarification(ValueError):
    def __init__(self,message,options=()):
        super().__init__(message);self.options=list(options)

def normalize_text(query):
    if not isinstance(query,str) or not query.strip() or len(query)>1200:raise Clarification('Введите запрос длиной до 1200 символов.')
    query=re.sub(r'\s+',' ',query).strip().replace('ё','е').replace('Ё','Е')
    query=re.sub(r'(?:за\s+)?(?:последн\w*\s+)?неделю\b','за последние 7 дней',query,flags=re.I)
    return query

def compile_query(root,query,previous,state,provider,scoped_state=None):
    query=normalize_text(query)
    if provider not in ('auto','local','gigacode'):raise Clarification('Неизвестный обработчик запроса.')
    previous=validate_spec(previous) if previous else None
    planner='rules'
    try:
        if provider!='gigacode':spec=plan_query(query,previous,state.get('productNames',[]))
        else:
            from gigachat_bridge import plan_with_cli
            spec=plan_with_cli(root,query,previous,state,force=True);planner='gigacode'
        spec=validate_spec(spec)
    except ValueError as error:
        if provider=='gigacode' and planner=='rules':
            from gigachat_bridge import record_rule_plan
            record_rule_plan(root,query,previous,error=error)
        options=[]
        if 'номеров опросов' in str(error) or 'корректных ID' in str(error):
            options=[{'label':'Опрос '+str(s['event']['id']),'query':query+' по опросу '+str(s['event']['id'])} for s in state['surveys'][:3]]
        clarified=Clarification(str(error),options)
        if hasattr(error,'code'):clarified.code=error.code
        if provider=='gigacode':
            from failure_diagnosis import diagnose
            clarified.diagnosis=diagnose(error,{'stage':'chart-parameters'})
        raise clarified from None
    return describe_chart(query,spec,state,provider,planner,scoped_state)


def describe_chart(query,spec,state,provider,planner,scoped_state=None):
    selected=select_surveys(scoped_state(spec) if scoped_state else state,spec)
    if not selected:raise Clarification('Нет данных по выбранным опросам или условиям. Проверьте ID, продукт и загруженные CSV.')
    if spec['ids'] and len({s['event']['id'] for s in selected})<len(selected):
        raise Clarification('Этот номер есть в обоих каналах. Выберите канал.',[{'label':label,'query':query+' '+label} for label in ('пуш+смс','экран успеха')])
    missing=set(spec['ids'])-{s['event']['id'] for s in selected}
    if missing:raise Clarification('Нет данных по опросам '+', '.join(map(str,sorted(missing)))+'. Добавьте их строки в CSV.')
    scope='Опросы '+', '.join(map(str,spec['ids'])) if spec['ids'] else 'Все опросы выбранного отбора'
    if spec.get('filters'):
        names={'product':'Продукт','triggerGroup':'Группа','type':'Тип','top':'Приоритет Топ','channel':'Канал'}
        scope+=' · '+' · '.join(names[k]+': '+('да' if v is True else 'нет' if v is False else 'экран успеха' if v=='success_screen' else 'пуш+СМС' if v=='communication' else str(v)) for k,v in spec['filters'].items())
    if spec.get('startDate'):period=spec['startDate']+' — '+spec['endDate']
    elif spec.get('daysCount'):period='Последние %s календарных дней от последней дневной записи выбранных опросов'%spec['daysCount']
    elif spec.get('startMonth'):period=spec['startMonth']+' — '+spec.get('endMonth','последняя дневная дата' if spec.get('grain')=='week' else 'последний загруженный месяц')
    else:period='Последние %s календарных месяца'%spec['monthsCount']
    pairs=spec.get('series') or [{'id':i,'metric':m} for i in spec['ids'] for m in spec['metrics'] if m!='plan']
    return {'version':1,'metricVersion':VERSION,'spec':copy.deepcopy(spec),'planner':planner,'provider':provider,'query':query,
            'interpretation':scope+' · '+', '.join(LABELS[m] for m in spec['metrics'])+' · '+period+' · '+{'day':'по дням','week':'по неделям','month':'по месяцам'}[spec.get('grain','month')],
            'surveyCount':len(selected),'curves':[{'id':p['id'],'metric':p['metric'],'label':LABELS[p['metric']]} for p in pairs],
            'channels':sorted({s['meta']['channel'] for s in selected})}
