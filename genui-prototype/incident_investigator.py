"""Build evidence-linked incident hypotheses and let the model prioritize checks."""
import datetime as dt
import json
from threading import Event

from feedback_overview import FACTORS
from model_client import call_json, load_config


CHECKS = {
    'events': ('Изменился объём загрузки событий',
               'Сверить входящие события с журналом загрузок по дням, продуктам и опросам. Проверить, совпало ли изменение с датой сбоя или запуска.',
               ('campaign', 'incident')),
    'sendShare': ('Часть событий перестала доходить до отправки',
                  'Сверить журналы отправки и отсечений по одинаковым дням. Проверить изменение по затронутым опросам и контрольной группе.',
                  ('policy', 'incident')),
    'responseRate': ('После отправки клиенты стали реже отвечать',
                     'Сравнить отклик по версиям сообщения, времени отправки и опросам. Проверить доставку и работу формы в затронутый период.',
                     ('campaign', 'incident')),
    'stop': ('Могли измениться отсечения по стоп-листам',
             'Сверить статус 1002 и версию стоп-листа с журналом изменений. Проверить затронутые сегменты и дату первого изменения.',
             ('policy', 'incident')),
    'contactPolicy': ('Могла повлиять политика контактов',
                      'Сверить доли статусов политики контактов и версии правил. Проверить, затронуло ли изменение те же опросы и даты.',
                      ('policy', 'incident')),
    'coverage': ('Снижение может быть связано с неполной выгрузкой',
                 'Сверить полноту дневной выгрузки с журналом импорта и повторить сравнение после получения отсутствующих дней.',
                 ('incident',)),
}


def prior_checks(committee, scope, members):
    keys = {(s['meta']['channel'],s['event']['id']) for s in members}
    with committee.db() as db:
        entries = db.execute('SELECT document FROM monitoring_tasks ORDER BY rowid DESC')
        matches = []
        for entry in entries:
            task = json.loads(entry['document'])
            prior = task['signal']
            same_scope = ((scope['kind']=='bank' or (prior['kind'],prior['name'])==(scope['kind'],scope['name']))
                          if prior.get('kind') else (prior.get('channel'),prior.get('id')) in keys)
            if task['status'] != 'resolved' or not same_scope or prior['through'] >= scope['windows']['current']['start']:
                continue
            matches.append(task)
            if len(matches) == 4:
                break
    return matches


def calculate_report(committee, scope, members):
    span = scope['windows']
    facts = {'answers': {'kind':'metric', 'metric':'answers', 'baseline':scope['baseline']['answers'], 'current':scope['current']['answers']},
             'coverage': {'kind':'coverage', 'pairs':scope['pairCount'], 'surveys':scope['surveyCount'],
                          'comparedSurveys':scope['comparedSurveys'], 'days':len(scope['pairedDays'])}}
    for key in FACTORS:
        baseline,current=scope['baseline'][key],scope['current'][key]
        if baseline is not None and current is not None:
            facts[key] = {'kind':'metric','metric':key,'baseline':baseline,'current':current,
                          'impact':scope['factors'][key] if scope['factors'] is not None else None}
    for cutoff in scope['cutoffs']:
        if cutoff['shares'] and None not in cutoff['shares']:
            facts[cutoff['metric']] = {'kind':'metric','metric':cutoff['metric'],
                                      'baseline':cutoff['shares'][0],'current':cutoff['shares'][1]}
    events = committee.engine.workflows.events_for(span['previous']['start'],span['current']['end'],members)
    events.sort(key=lambda row:(row['to']>=span['current']['start'],row['from'],row['id']),reverse=True)
    for i,event in enumerate(events[:8],1):
        relation = 'оба окна' if event['from']<=span['previous']['end'] and event['to']>=span['current']['start'] else 'текущее окно' if event['to']>=span['current']['start'] else 'база'
        facts[f'event-{i}'] = {**{key:event[key] for key in ('title','from','to')},
                               'kind':'calendar','category':event['kind'],'relation':relation}
    for i,task in enumerate(prior_checks(committee,scope,members),1):
        facts[f'check-{i}'] = {'kind':'history','through':task['signal']['through'],
                               'title':task['signal']['name'],'result':task['history'][-1]['note'][:500],
                               'factor':task.get('incidentFactor')}

    candidates = []
    for key,(title,check,event_types) in CHECKS.items():
        if key not in facts:
            continue
        fact = facts[key]
        if key == 'coverage':
            score = 0 if scope['observedSurveyDays']!=scope['pairCount']*2 or scope['pairCount']<scope['surveyCount']*7 else None
        elif key in FACTORS:
            impact=fact['impact']
            score = (-impact if impact < -0.005 else None) if impact is not None else (0 if fact['current']<fact['baseline'] else None)
        else:
            change = fact['current']-fact['baseline']
            score = 0 if change > 0 and scope['current']['sendShare'] is not None and scope['baseline']['sendShare'] is not None and scope['current']['sendShare']<scope['baseline']['sendShare'] else None
        if score is None:
            continue
        refs = [key]
        refs.extend(ref for ref,f in facts.items() if f['kind']=='history' and f['factor']==key)
        refs.extend(ref for ref,f in facts.items() if f['kind']=='calendar' and f['relation']=='текущее окно' and f['category'] in event_types)
        candidates.append({'id':key,'title':title,'check':check,'refs':refs[:4],'score':score})
    candidates.sort(key=lambda h:(-h['score'],h['id']=='coverage',h['id']))
    return {'facts':facts,'candidates':candidates,'windows':span}


def validate_selection(response, candidates):
    selected = response.get('selected') if isinstance(response,dict) and set(response)=={'selected'} else None
    allowed = {item['id']:item for item in candidates}
    if not isinstance(selected,list) or len(selected)!=min(3,len(allowed)) or any(not isinstance(key,str) or key not in allowed for key in selected) or len(set(selected))!=len(selected):
        raise ValueError('Модель вернула неподтверждённый список гипотез.')
    return [allowed[key] for key in selected]


def survey_members(committee,scope):
    if 'selection' in scope:
        from feedback_overview import answer_selection
        return answer_selection(committee.engine.state['surveys'],scope['selection'])
    return [s for s in committee.engine.state['surveys'] if s['event']['id']==scope['id'] and s['meta']['channel']==scope['channel']]


def incident_context(committee, request):
    with committee.engine.lock:
        scope = committee.feedback_signal(request)
        if 'selection' in scope or scope['kind']=='survey':
            return scope,calculate_report(committee,scope,survey_members(committee,scope))
        name = request['key'].split(':',1)[1]
        members = [s for s in committee.engine.state['surveys'] if scope['kind']=='bank'
                   or scope['kind']=='channel' and s['meta']['channel']==name
                   or scope['kind']=='product' and name in s['meta'].get('products',[])]
        return scope, calculate_report(committee,scope,members)


def run(committee, request):
    _,report = incident_context(committee,request)
    candidates = report.pop('candidates')
    selected, origin, warning = candidates[:3], 'local', ''
    if request.get('useModel') is True and candidates:
        root = committee.engine.root
        try:
            budget = min(30, load_config(root)['timeoutSeconds'])
            fields=('kind','metric','baseline','current','impact','pairs','surveys','comparedSurveys','days',
                    'category','relation','from','to','through','factor')
            payload = {'facts':[{key:fact[key] for key in fields if key in fact}|{'ref':ref} for ref,fact in report['facts'].items()],
                       'options':[{'id':h['id'],'label':h['title'],'refs':h['refs']} for h in candidates]}
            response = call_json(root,
                'Упорядочи до трёх предложенных гипотез для проверки потери ответов. Верни один JSON {"selected":["ID"]}. '
                'Выбери ровно min(3, число options) разных ID из options. Приоритизируй размер отрицательного вклада, '
                'качество сравнения, релевантность календаря и завершённые проверки сходного фактора. Совпадение по дате не доказывает причину.',
                payload,'incident-investigator','Приоритет гипотез инцидента',None,Event(),timeout_seconds=budget)
            selected = validate_selection(response,candidates)
            origin = 'gigacode'
        except (ValueError,OSError) as error:
            warning = 'GigaCode не определила приоритет. Показан локальный порядок. '+str(error)
    return dict(report, hypotheses=selected, origin=origin, warning=warning)
