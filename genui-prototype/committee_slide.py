"""Build and revalidate an editable committee slide from an incident snapshot."""
import math

from incident_investigator import incident_context


def draft(committee, request):
    scope,report = incident_context(committee,request)
    return slide_from_report(scope,report,request)


def slide_from_report(scope,report,request):
    before,after = scope['baseline']['answers'],scope['current']['answers']
    delta = after-before
    hypothesis_id = request.get('hypothesis')
    hypotheses = report['candidates'] if 'selection' not in scope or delta<0 else []
    chosen = next((item for item in hypotheses if item['id']==hypothesis_id),None)
    if hypothesis_id is not None and chosen is None:
        raise ValueError('Гипотеза изменилась. Откройте разбор заново.')
    if chosen is None and hypotheses:
        chosen = hypotheses[0]
    facts = report['facts']
    if facts['answers']['baseline']!=before or facts['answers']['current']!=after:
        raise ValueError('Числа слайда не совпали с исходным расчётом.')
    factors = scope['factors']
    if factors is not None and not math.isclose(sum(factors.values()),delta,abs_tol=1e-7):
        raise ValueError('Сумма вкладов не совпала с изменением ответов.')
    refs = ['answers','coverage']
    if chosen:
        refs.extend(chosen['refs'])
    if any(ref not in facts for ref in refs):
        raise ValueError('Источник гипотезы недоступен. Откройте разбор заново.')
    leading = min(factors,key=factors.get) if factors and min(factors.values()) < -0.005 else None
    result = {'scope':scope['name'],'revision':scope['revision'],'windows':scope['windows'],
              'baseline':before,'current':after,'delta':delta,'factors':factors,'leading':leading,
              'facts':{ref:facts[ref] for ref in dict.fromkeys(refs)},
              'hypothesis':{key:chosen[key] for key in ('id','title','check')} if chosen else None}
    if 'comparisonCoverage' in scope:
        result['comparisonCoverage']=scope['comparisonCoverage']
        result['contributors']=scope['contributors']
        result['excludedSurveys']=scope['excludedSurveys']
        result['observedMetrics']={name:{key:scope[name][key] for key in ('events','sends','answers','sendShare','responseRate')}
                                   for name in ('baseline','current')}
    from committee import digest
    signature = digest(result)
    if request.get('signature') is not None and request['signature']!=signature:
        raise ValueError('Данные или источники изменились. Откройте предпросмотр заново.')
    return dict(result,signature=signature)
