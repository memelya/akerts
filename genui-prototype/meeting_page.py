"""Fixed meeting charts from a single revision; no model calls."""
import datetime as dt
from copy import deepcopy
from collections import defaultdict
from metric_registry import calculate,LABELS
from metric_ratios import ratio
from status_composition import summarize

METRICS=("sends","answers","events","stop","contactPolicy","stopAndPolicy")
MEETING_LABELS=LABELS|{"events":"Загруженные события","stopAndPolicy":"Стоп-листы + политика контактов"}
METHOD="События — сумма events по всем статусам выбранного отбора. Ответы / отправки × 100 — отклик; отправки, стоп-листы, политика контактов и их сумма / события × 100 — доля событий. Для событий — 100% собственной базы. При нулевой или неизвестной базе процент не вычисляется. Пропуски не равны нулю. Отношения объёмов не являются когортной конверсией."
CUTOFF_METHOD="Отсечения — сумма events по найденным строкам нужных статусов. Отсутствие статуса у другого опроса не скрывает эту сумму и не подменяется нулём. Если нужных строк нет ни у одного опроса месяца, значение неизвестно. Наличие статусов по опросам показано отдельно; оно не доказывает полноту выгрузки."

GROUP='Свободная группа 1'
TITLES=[
 'График отправок и ответов по опросу 1007',
 'График отправок и ответов по опросу 3155',
 'График отправок коммуникаций по каналу пуш+СМС и ответов',
 'График отправок по пуш+СМС · Свободная группа 1',
 'График отправок по пуш+СМС · все группы, кроме Свободной группы 1',
]

def meeting(engine,request):
    choices=request.get('channels',{})
    if not isinstance(choices,dict) or set(choices)-{'1007','3155'} or any(v not in ('auto','communication','success_screen') for v in choices.values()):raise ValueError('Неизвестный канал графика встречи.')
    with engine.lock:
        _,status=engine.refresh()
        if status.get('error'):raise ValueError('CSV не приняты: '+status['error'])
        revision=engine.document.get('revision');doc=engine.document
        cached=getattr(engine,'_meeting_months',None)
        if not cached or cached['revision']!=revision:
            rows=engine.store.monthly_records(revision,None,'2026-01','2026-12-31') if revision else []
            grouped=defaultdict(list)
            for row in rows:grouped[row['channel'],row['id'],row['date'][:7]].append(row)
            cells={key:{metric:calculate(values,metric) for metric in ('sends','answers','events','stop','contactPolicy')} for key,values in grouped.items()}
            status_composition=summarize(rows,(engine.document.get('reference') or engine.baseline).get('statusDescriptions',{}))
            cached={'statusComposition':status_composition,'revision':revision,'cells':cells,'keys':{(k[0],k[1]) for k in cells}};engine._meeting_months=cached
        cells=cached['cells'];state={'surveys':[s for s in engine.state['surveys'] if (s['meta']['channel'],s['event']['id']) in cached['keys']]}

        charts=[]
        for i,title in enumerate(TITLES):
            spec={'ids':[],'metrics':['sends','answers'] if i<3 else ['sends'],'monthsCount':12,'startMonth':'2026-01','endMonth':'2026-12','grain':'month','layout':'combined'}
            selected=state['surveys'];note=''
            if i<2:
                ident=(1007,3155)[i];spec['ids']=[ident];selected=[s for s in selected if s['event']['id']==ident]
                available=sorted({s['meta']['channel'] for s in selected});choice=choices.get(str(ident),'auto')
                if choice=='auto' and len(available)>1:
                    charts.append({'title':title,'status':'clarification','id':ident,'channels':available,'message':'За 2026 год опрос встречается в обоих каналах. Выберите канал; значения не объединены.'});continue
                channel=available[0] if choice=='auto' and available else choice
                if channel!='auto':spec['filters']={'channel':channel};selected=[s for s in selected if s['meta']['channel']==channel]
            else:
                spec['filters']={'channel':'communication'};selected=[s for s in selected if s['meta']['channel']=='communication']
                if i in (3,4):
                    def same(s):return ' '.join((s['meta'].get('triggerGroup') or 'без группы').split()).casefold()==GROUP.casefold()
                    selected=[s for s in selected if same(s)==(i==3)]
                    note='Отбор по справочнику: '+('группа «Свободная группа 1».' if i==3 else 'все группы, кроме «Свободная группа 1»; «без группы» включена.')
            if not selected:
                charts.append({'title':title,'status':'empty','message':'Нет наблюдений за 2026 год по выбранным условиям. Проверьте CSV'+(' и справочник групп.' if i>=3 else '.'),'note':note});continue
            default_metrics=spec['metrics']+['events'];spec['metrics']=default_metrics+['stop','contactPolicy','stopAndPolicy']
            months=[f'2026-{m:02d}' for m in range(1,13)];blocks=[];totals=[];table=[]
            series={};coverage={};coverage_table=[]
            for metric in ('sends','answers','events','stop','contactPolicy'):
                values=[];observations=[]
                for month in months:
                    members=[s for s in selected if (s['meta']['channel'],s['event']['id'],month) in cells]
                    known=[cells[s['meta']['channel'],s['event']['id'],month][metric] for s in members]
                    if metric in ('stop','contactPolicy'):
                        found=[v for v in known if v is not None]
                        values.append(sum(found) if found else None)
                        present=len(found);count=len(members)
                        missing=[s['event']['id'] for s in members if cells[s['meta']['channel'],s['event']['id'],month][metric] is None]
                        coverage_state='not_applicable' if selected[0]['meta']['channel']=='success_screen' else 'no_month' if not count else 'no_status' if not present else 'some_observed' if present<count else 'all_observed'
                        item={'status':coverage_state,'observedSurveys':count,'withStatus':present,'withoutStatus':count-present,'missingIds':missing[:20]}
                        observations.append(item);coverage_table.append(dict(item,month=month,metric=metric,label=MEETING_LABELS[metric]))
                    else:values.append(sum(known) if known and all(v is not None for v in known) else None)
                series[metric]=values
                if observations:coverage[metric]=observations
            series['stopAndPolicy']=[sum(v for v in (a,b) if v is not None) if a is not None or b is not None else None for a,b in zip(series['stop'],series['contactPolicy'])]
            coverage['stopAndPolicy']=[{'status':'not_applicable' if a['status']=='not_applicable' else 'no_month' if a['status']=='no_month' else 'no_status' if v is None else 'all_observed' if a['status']==b['status']=='all_observed' else 'some_observed'} for a,b,v in zip(coverage['stop'],coverage['contactPolicy'],series['stopAndPolicy'])]
            for metric in spec['metrics']:
                denominator=series['sends' if metric=='answers' else 'events'];base=sum(v for v in denominator if v is not None) if any(v is not None for v in denominator) else None
                values=series[metric];value=sum(v for v in values if v is not None) if any(v is not None for v in values) else None
                # A year share cannot use partial cutoff observations against a full-year denominator.
                complete=all(v is not None for v,d in zip(values,denominator) if d is not None)
                info={'baseMetric':'sends' if metric=='answers' else 'events','baseValues':denominator,'values':[ratio(v,d) for v,d in zip(values,denominator)],'totalBase':base,'total':ratio(value,base) if complete else None,'method':METHOD}
                available=metric in default_metrics or any(v is not None for v in values)
                block={'id':spec['ids'][0] if spec['ids'] else None,'name':selected[0]['meta']['name'] if spec['ids'] else 'Все выбранные опросы','metric':metric,'label':MEETING_LABELS[metric],'values':values,'ratio':info,'enabled':metric in default_metrics,'available':available,'reason':'Не применимо к экранам успеха' if selected[0]['meta']['channel']=='success_screen' else 'В выбранной выгрузке нет полного набора нужных статусов'}
                if metric in coverage:block.update(coverage=coverage[metric],observedOnly=selected[0]['meta']['channel']=='communication')
                blocks.append(block);totals.append(dict(block,value=value,note='За 2026 год'))
                table.extend({'id':block['id'],'name':block['name'],'month':m,'metric':block['label'],'value':v,'sendRatio':ratio(v,d),'ratioBase':d,'ratioBaseMetric':info['baseMetric']} for m,v,d in zip(months,values,denominator))
            notices=[f"{row['month']} · {row['label']}: сумма найденных строк; статусы есть у {row['withStatus']} из {row['observedSurveys']} опросов." for row in coverage_table if row['status']=='some_observed']
            unknown=[f"{row['month']} · {row['label']}: нужные строки не найдены." for row in coverage_table if row['status']=='no_status']
            data={'spec':spec,'months':months,'periodLabel':'2026-01 — 2026-12','source':'Ваши CSV · Встреча 05.11.2026','blocks':blocks,'totals':totals,'table':table,'cutoffCoverage':coverage_table,'warnings':([note] if note else [])+(['Статусы отсечений есть не у всех опросов. Суммы найденных строк показаны; наличие статусов и примеры ID — в таблице под графиком.'] if notices else [])+(['В отдельных месяцах нужных строк отсечений нет; эти значения оставлены неизвестными.'] if unknown else []),'methods':['Количество суммируется по строкам месяца. Для экранов успеха отправки учитывают только SENDED.',METHOD,CUTOFF_METHOD],'meetingPercentages':True,'meetingTitle':title,'dataRevision':revision}
            charts.append({'title':title,'status':'ok','id':(1007,3155)[i] if i<2 else None,'channel':selected[0]['meta']['channel'] if i<2 else 'communication','memberCount':len(selected),'note':note,'data':data})
        from daily_csi import meeting_charts
        charts.extend(meeting_charts(engine,revision,choices.get('1007','auto')))
        breakdown=deepcopy(charts[2])
        breakdown.update(kind='events-breakdown',title='Отправки по событиям пуш+СМС')
        if breakdown['status']=='ok':
            data=breakdown['data'];data['meetingTitle']=breakdown['title']
            events=next(b['values'] for b in data['blocks'] if b['metric']=='events')
            base=sum(v for v in events if v is not None) if any(v is not None for v in events) else None
            method='Отправки, стоп-листы и политика контактов / загруженные события того же месяца × 100. Линия — количество отправок. Три доли не нормируются до 100%; пропуски не заменяются нулями.'
            data['methods']=[method,CUTOFF_METHOD];data['breakdownBase']='events';data['breakdownLineMetric']='sends';data['breakdownParts']=['sends','stop','contactPolicy'];data['statusComposition']=deepcopy(cached['statusComposition'])
            for block in data['blocks']:
                values=block['values'];value=sum(v for v in values if v is not None) if any(v is not None for v in values) else None
                complete=all(v is not None for v,d in zip(values,events) if d is not None)
                block['ratio']={'baseMetric':'events','baseValues':events,'values':[ratio(v,d) for v,d in zip(values,events)],'totalBase':base,'total':ratio(value,base) if complete else None,'method':method}
            data['totals']=[dict(b,value=sum(v for v in b['values'] if v is not None) if any(v is not None for v in b['values']) else None,note='За 2026 год') for b in data['blocks']]
            data['table']=[{'id':None,'name':b['name'],'month':m,'metric':b['label'],'value':v,'sendRatio':ratio(v,d),'ratioBase':d,'ratioBaseMetric':'events'} for b in data['blocks'] for m,v,d in zip(data['months'],b['values'],events)]
        charts.append(breakdown)
        composition=deepcopy(breakdown)
        composition['title']='События по всем опросам пуш+СМС'
        if composition['status']=='ok':
            data=composition['data'];data['meetingTitle']=composition['title'];data['breakdownLineMetric']='events';data['compositionZeroMissing']=True
            data['methods']=['Линия — сумма events всех status_det всех опросов пуш+СМС. Столбцы — отправки, стоп-листы и политика контактов / события месяца. Состав принятой выгрузки, не уникальные клиенты.',CUTOFF_METHOD]
            for block in data['blocks']:
                if block['metric'] in ('stop','contactPolicy'):
                    block['values']=[0 if value is None and base is not None else value for value,base in zip(block['values'],events)]
            for block in data['blocks']:
                values=block['values'];value=sum(v for v in values if v is not None) if any(v is not None for v in values) else None
                block['ratio']['values']=[ratio(v,d) for v,d in zip(values,events)]
                block['ratio']['total']=ratio(value,base) if all(v is not None for v,d in zip(values,events) if d is not None) else None
            data['totals']=[dict(b,value=sum(v for v in b['values'] if v is not None) if any(v is not None for v in b['values']) else None,note='За 2026 год') for b in data['blocks']]
            data['table']=[{'id':None,'name':b['name'],'month':m,'metric':b['label'],'value':v,'sendRatio':ratio(v,d),'ratioBase':d,'ratioBaseMetric':'events'} for b in data['blocks'] for m,v,d in zip(data['months'],b['values'],events)]
        charts.append(composition)
        return {'title':'Встреча 05.11.2026','period':'2026-01 — 2026-12','revision':revision,'refreshedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'held':bool(doc.get('heldFingerprint')),'charts':charts}
