"""Authoritative metric vocabulary and record-level arithmetic. No AI arithmetic."""
import calendar

VERSION='1.0'
POLICY=[1003,1011,1016,1017,1018,1019,1020,1021,1022,1023,1024]
METRICS={
 'sends':{'label':'Отправки','unit':'шт.','aggregation':'sum','communication':'Σ sends по строкам периода.','success_screen':'Σ events только для mp_status = SENDED.','fields':['sends','events','status'],'note':'Отправки и ответы могут относиться к разным статусам; их нельзя складывать в число уникальных клиентов.'},
 'answers':{'label':'Ответы','unit':'шт.','aggregation':'sum','communication':'Σ answers по строкам периода.','success_screen':'Σ answers (qa_cnt) по всем переданным mp_status.','fields':['answers'],'note':'Оценка 0 сохраняется в ответах, но не участвует в CSI.'},
 'responseRate':{'label':'Отклик','unit':'%','aggregation':'ratio','communication':'Σ answers / Σ sends × 100.','success_screen':'Σ answers / Σ events по статусу SENDED × 100.','fields':['answers','sends','events','status'],'note':'Отношение объёмов за тот же период. При нулевой базе отклик не рассчитывается.'},
 'events':{'label':'События','unit':'шт.','aggregation':'sum','communication':'Σ events по всем status_det.','success_screen':'Σ events (cnt; в дневном формате — sends как размер группы статуса).','fields':['events'],'note':'Это число записей событий, а не число людей или уникальных опросов.'},
 'csi':{'label':'CSI','unit':'балл','aggregation':'weighted_mean','communication':'Σ(events × оценка) / Σ events по строкам с оценкой от 1 до 5.','success_screen':'Σ(events × csi) / Σ events по строкам с валидным CSI от 1 до 5.','fields':['events','csi'],'note':'Оценка 0 и пустые оценки исключены. Средние дневные CSI не усредняются без весов. Итоговая карточка показывает CSI последнего периода графика.'},
 'stop':{'label':'Стоп-листы','unit':'шт.','aggregation':'sum','communication':'Σ events, где status_det = 1002.','success_screen':None,'fields':['events','status'],'note':'Без переданных строк нужного статуса значение не подтверждено. Явная строка с events = 0 означает ноль.'},
 'contactPolicy':{'label':'Политика контактов','unit':'шт.','aggregation':'sum','communication':'Σ events по status_det: '+', '.join(map(str,POLICY))+'.','success_screen':None,'fields':['events','status'],'note':'Отсечения входят в общее число событий. Они не прибавляются к нему повторно.'},
 'unique_surveys':{'label':'Уникальные опросы','unit':'опрос','aggregation':'distinct','communication':'COUNT DISTINCT event_type_id среди строк периода после фильтров.','success_screen':'COUNT DISTINCT event_type_id среди строк периода после фильтров.','fields':['id'],'note':'Один ID в обоих каналах считается один раз. Итог за период не равен сумме уникальных ID по месяцам.'},
 'plan':{'label':'План ответов','unit':'шт.','aggregation':'reference','communication':'Сумма известных месячных планов выбранных опросов.','success_screen':'Сумма известных месячных планов выбранных опросов.','fields':['plan'],'note':'Неизвестный план не равен нулю. Дневной план равномерно распределяется по календарным дням соответствующего месяца.'},
}
LABELS={key:value['label'] for key,value in METRICS.items()}

def valid_csi(value):
    return value if value is not None and 1<=value<=5 else None

def weighted_csi(rows):
    rated=[r for r in rows if valid_csi(r.get('csi')) is not None]
    denominator=sum(r['events'] for r in rated)
    numerator=sum(r['events']*r['csi'] for r in rated)
    return {'value':numerator/denominator if denominator else None,'numerator':numerator,'denominator':denominator,'ratedRows':len(rated),'excludedRows':len(rows)-len(rated)}

def response_rate(answers,sends):
    return answers/sends*100 if answers is not None and sends else None

def response_proof(rows):
    answers,sends=calculate(rows,'answers'),calculate(rows,'sends')
    return {'value':response_rate(answers,sends),'numerator':answers,'denominator':sends}

def cutoff_rows(rows,metric):
    codes=(1002,) if metric=='stop' else POLICY
    return [r for r in rows if r['channel']=='communication' and r['status'] in codes]

def calculate(rows,metric,grain='day'):
    if not rows:return None
    if metric=='csi':return weighted_csi(rows)['value']
    if metric=='responseRate':return response_proof(rows)['value']
    if metric=='unique_surveys':return len({r['id'] for r in rows})
    if metric in ('stop','contactPolicy'):
        eligible=cutoff_rows(rows,metric)
        return sum(r['events'] for r in eligible) if eligible else None
    if metric=='sends':return sum(r['events'] if r['channel']=='success_screen' and str(r['status']).upper()=='SENDED' else 0 if r['channel']=='success_screen' else r['sends'] for r in rows)
    if metric in ('answers','events'):return sum(r[metric] for r in rows)
    raise ValueError('Неизвестный показатель.')

def plan_for_day(monthly,date):
    return monthly/calendar.monthrange(int(date[:4]),int(date[5:7]))[1] if monthly is not None else None

def catalog():
    return {'version':VERSION,'metrics':[dict(key=key,**value) for key,value in METRICS.items()],'missing':'Пустое значение означает отсутствие наблюдения; ноль — переданное или вычисленное нулевое значение.'}
