"""Deterministic evidence, sample checks and bounded anomaly screening for AI."""
import calendar,copy,datetime as dt,math,re
from collections import defaultdict
from metric_registry import calculate,weighted_csi,LABELS,VERSION
from genui_extended import select_surveys,execute_query

CORE=('sends','answers','events','stop','contactPolicy','csi')
DEFAULTS={'minAnswers':30,'answerDropPct':20,'sendChangePct':30,'csiDrop':.3,'minCsiSample':30,'cutoffGrowthPct':30,'minCutoffDelta':20,'minCoverage':.7,'planGapPct':20}
LIMITS={'minAnswers':(1,1000000000),'answerDropPct':(1,100),'sendChangePct':(1,1000),'csiDrop':(.01,4),'minCsiSample':(1,100000),'cutoffGrowthPct':(1,1000),'minCutoffDelta':(1,1000000000),'minCoverage':(.1,1),'planGapPct':(1,100)}
PRIORITY={'low':0,'medium':1,'high':2,'critical':3}

def criteria(value):
    if not isinstance(value,dict) or set(value)-set(DEFAULTS):raise ValueError('Неизвестные пороги анализа.')
    result=dict(DEFAULTS)
    for key,number in value.items():
        low,high=LIMITS[key]
        if type(number) not in (int,float) or not math.isfinite(number) or not low<=number<=high:raise ValueError('Порог '+key+' вне допустимого диапазона.')
        result[key]=number
    return result

def shift_month(date,months):
    n=date.year*12+date.month-1-months;y,m=n//12,n%12+1
    if date.day>calendar.monthrange(y,m)[1]:return None
    return dt.date(y,m,date.day)
def month_start(date):return date.replace(day=1)
def last_day(month):
    y,m=map(int,month.split('-'));return dt.date(y,m,calendar.monthrange(y,m)[1])
def day_list(start,end):return [start+dt.timedelta(days=i) for i in range((end-start).days+1)]
def key(s):return s['meta']['channel']+':'+str(s['event']['id'])
def scalar(value):return round(value,6) if isinstance(value,float) and math.isfinite(value) else value

class Evidence:
    def __init__(self,engine,revision,state,plan):
        self.engine=engine;self.store=engine.store;self.revision=revision;self.state=state;self.plan=copy.deepcopy(plan);self.criteria=criteria(plan.get('criteria',{}));self.facts={};self.members={};self.candidates={};self.events={};self.exposed=set();self.tool_history=[]
        scope=plan['scope'];filters={k:v for k,v in scope.items() if k!='ids' and v not in ('',None)};spec={'ids':scope.get('ids',[]),'filters':filters}
        selected=select_surveys(state,spec)
        if not selected:raise ValueError('По выбранному моделью отбору нет данных. Уточните продукт, канал или опросы.')
        requested=set(scope.get('ids',[]));found={s['event']['id'] for s in selected}
        if requested-found:raise ValueError('В выбранном отборе нет части указанных опросов.')
        self.selected=selected;keys=[(s['meta']['channel'],s['event']['id']) for s in selected]
        latest_month=max(m for s in selected for m in s['meta']['availableMonths']);anchor=self.store.last_daily(revision,keys);p=plan['period'];self.grain=p['grain']
        if self.grain=='day':
            if not anchor:raise ValueError('Для этого отбора нет дневных строк. Попросите анализ по месяцам.')
            end=min(dt.date.fromisoformat(anchor),dt.date.fromisoformat(p['endDate'])) if p.get('endDate') else dt.date.fromisoformat(anchor);start=dt.date.fromisoformat(p['startDate']) if p.get('startDate') else end-dt.timedelta(days=p['days']-1)
            if start>end:raise ValueError('Нет загруженных дневных наблюдений за указанный период.')
            p['days']=(end-start).days+1;step=p['days'] if p['comparison']=='previous' else math.ceil(p['days']/7)*7
            self.pairs=[(date,date-dt.timedelta(days=step),date-dt.timedelta(days=step*2)) for date in day_list(start,end)]
        else:
            end_month=min(p.get('endMonth') or latest_month,latest_month);end=last_day(end_month)
            if anchor and anchor.startswith(end_month) and self._all_daily(keys,end_month):end=dt.date.fromisoformat(anchor)
            if p.get('startMonth'):start=dt.date.fromisoformat(p['startMonth']+'-01')
            else:start=shift_month(month_start(end),p['months']-1)
            if start>end:raise ValueError('В данных ещё нет выбранного моделью периода.')
            months=(end.year-start.year)*12+end.month-start.month+1
            if months>12:raise ValueError('Для AI-анализа выберите не больше двенадцати месяцев.')
            self.pairs=[(date,shift_month(date,months),shift_month(date,months*2)) for date in day_list(start,end)]
            if p['comparison']=='weekday':
                before_start=shift_month(start,months);before_end=shift_month(end,months) or last_day(shift_month(month_start(end),months).strftime('%Y-%m'));older_start=shift_month(start,months*2);older_end=shift_month(end,months*2) or last_day(shift_month(month_start(end),months*2).strftime('%Y-%m'))
                self.pairs=[]
                for weekday in range(7):
                    a=[d for d in day_list(start,end) if d.weekday()==weekday];b=[d for d in day_list(before_start,before_end) if d.weekday()==weekday];c=[d for d in day_list(older_start,older_end) if d.weekday()==weekday]
                    self.pairs.extend((d,b[i] if i<len(b) else None,c[i] if i<len(c) else None) for i,d in enumerate(a))
                self.pairs.sort()
        self.start=start;self.end=end;self.dates=day_list(start,end)
        references=[d for group in self.pairs for d in group if d];self.read_start=min(references)
        ranking=plan.get('ranking')
        self.ranking=None
        if ranking:
            self.ranking=self.store.ranking(revision,keys,start.strftime('%Y-%m') if self.grain=='month' else start.isoformat(),end.isoformat(),ranking)
            winners={(r['channel'],r['id']) for r in self.ranking['winners']}
            if not winners:raise ValueError('Нет наблюдений с выбранным показателем для рейтинга за этот период.')
            selected=[s for s in selected if (s['meta']['channel'],s['event']['id']) in winners]
            order={(r['channel'],r['id']):i for i,r in enumerate(self.ranking['winners'])};selected.sort(key=lambda s:order[s['meta']['channel'],s['event']['id']])
            self.selected=selected;keys=[(s['meta']['channel'],s['event']['id']) for s in selected]
        records=self.store.monthly_records(revision,keys,self.read_start.strftime('%Y-%m'),end.isoformat()) if ranking and self.grain=='month' else self.store.records(revision,keys,self.read_start.strftime('%Y-%m') if self.grain=='month' else self.read_start.isoformat(),end.isoformat(),limit=200001)
        if len(records)>200000:raise ValueError('Для анализа нужно больше двухсот тысяч строк. Уточните продукт или сократите период; данные не усекались.')
        if requested and len(found)<len(selected):
            active={(r['channel'],r['id']) for r in records if (start.isoformat()<=r['date']<=end.isoformat() if r['grain']=='day' else start.strftime('%Y-%m')<=r['date']<=end.strftime('%Y-%m'))}
            resolved=[]
            for survey_id in requested:
                candidates=[s for s in selected if s['event']['id']==survey_id]
                present=[s for s in candidates if (s['meta']['channel'],survey_id) in active]
                if len(present)>1:
                    error=ValueError('Опрос '+str(survey_id)+' содержит наблюдения в обоих каналах за '+start.isoformat()+' — '+end.isoformat()+'. Выберите канал; значения не объединялись.')
                    error.recovery={'options':[{'label':'Пуш + СМС','suffix':'. Канал: пуш + смс'},{'label':'Экран успеха','suffix':'. Канал: экран успеха'}]}
                    raise error
                if len(candidates)>1 and not present:raise ValueError('По опросу '+str(survey_id)+' нет наблюдений за выбранный период ни в одном канале.')
                resolved.extend(present or candidates)
            selected=resolved;self.selected=selected;keys=[(s['meta']['channel'],s['event']['id']) for s in selected]
            channels={channel for channel,_ in keys}
            if len(channels)==1:self.plan['scope']['channel']=next(iter(channels))
            records=[r for r in records if (r['channel'],r['id']) in set(keys)]
        if self.grain=='day' and any(r['grain']=='month' and r['date']>=start.strftime('%Y-%m') for r in records):raise ValueError('В отборе есть месячные строки без дневной детализации. Выберите месяцы или отдельный канал.')
        groups=defaultdict(list)
        for row in records:groups[row['channel']+':'+str(row['id'])].append(row)
        aggregate={m:[[],[]] for m in CORE};self.eligible=[]
        for survey in selected:
            ident=key(survey);rows=groups[ident];member={'key':ident,'id':survey['event']['id'],'channel':survey['meta']['channel'],'name':survey['meta']['name'],'products':survey['meta'].get('products',[]),'top':bool(survey['event'].get('isTop')),'plan':survey['meta'].get('plan')};self.members[ident]=member
            now=[r for r in rows if (start.isoformat()<=r['date']<=end.isoformat() if r['grain']=='day' else start.strftime('%Y-%m')<=r['date']<=end.strftime('%Y-%m'))]
            monthly=any(r['grain']=='month' for r in rows);by_date=defaultdict(list)
            for r in rows:by_date[r['date'][:7] if monthly else r['date']].append(r)
            pairs=list(dict.fromkeys((a.strftime('%Y-%m') if monthly else a.isoformat(),b.strftime('%Y-%m') if monthly and b else b.isoformat() if b else None,c.strftime('%Y-%m') if monthly and c else c.isoformat() if c else None) for a,b,c in self.pairs))
            if monthly:
                if p['comparison']=='weekday':raise ValueError('Сравнение одинаковых дней недели требует дневной выгрузки. Для месячных строк выберите предыдущее окно.')
                # Days such as October 31 have no September counterpart. They must
                # not create a second copy of an otherwise complete monthly pair.
                buckets={}
                for a,b,c in pairs:
                    if a not in buckets or buckets[a][1] is None and b is not None:buckets[a]=(a,b,c)
                pairs=list(buckets.values())
                # A monthly total and daily observations are not comparable windows.
                if any(r['grain']=='day' for r in rows):pairs=[]
            coverage=min(1,len({r['date'][:7] if monthly else r['date'] for r in now})/max(1,len(pairs)));stats={};proofs={}
            for metric in CORE:
                a=[];b=[];older=[]
                for d,ref,old in pairs:
                    if calculate(by_date[d],metric) is not None and ref and calculate(by_date[ref],metric) is not None:a.extend(by_date[d]);b.extend(by_date[ref])
                    if old and calculate(by_date[old],metric) is not None:older.extend(by_date[old])
                # A month bucket appears once even when day->month shifts differ.
                aa={id(r):r for r in a};bb={id(r):r for r in b};a=list(aa.values());b=list(bb.values())
                cur=calculate(a,metric);base=calculate(b,metric);actual=calculate(now,metric);delta=cur-base if cur is not None and base is not None else None
                sample=weighted_csi(a)['denominator'] if metric=='csi' else calculate(a,'answers');previous_sample=weighted_csi(b)['denominator'] if metric=='csi' else calculate(b,'answers')
                older=list({id(r):r for r in older}.values());value={'key':ident,'metric':metric,'unit':'балл' if metric=='csi' else 'шт.','actual':actual,'current':cur,'baseline':base,'delta':delta,'percent':delta/base*100 if delta is not None and base else None,'sample':sample,'baselineSample':previous_sample,'coverage':coverage,'pairedPeriods':len({r['date'][:7] if monthly else r['date'] for r in a}),'older':calculate(older,metric),'comparison':p['comparison'],'from':start.isoformat(),'through':end.isoformat()}
                ref=self.add_fact(value);stats[metric]=self.facts[ref];aggregate[metric][0].extend(a);aggregate[metric][1].extend(b)
                if metric=='csi':proofs={'current':weighted_csi(a),'baseline':weighted_csi(b)};self.facts[ref]['proof']=proofs
            reply=None
            if member['channel']=='communication' and stats['sends']['actual'] and stats['answers']['actual'] is not None:reply=stats['answers']['actual']/stats['sends']['actual']*100
            stats['replyRatio']=self.facts[self.add_fact({'key':ident,'metric':'replyRatio','unit':'%','actual':reply,'current':reply,'baseline':None,'delta':None,'coverage':coverage,'sample':stats['answers']['actual'],'baselineSample':None,'percent':None,'older':None,'note':'Ответы/отправки одного периода; не когортная конверсия. Для экранов успеха не рассчитывается.'})]
            expected=plan['answersTarget']['value']*len(self.dates) if plan.get('answersTarget') else sum(member['plan']/calendar.monthrange(d.year,d.month)[1] for d in self.dates) if member['plan'] is not None else None
            stats['planExpected']=self.facts[self.add_fact({'key':ident,'metric':'planExpected','unit':'шт.','actual':expected,'current':expected,'baseline':None,'delta':None,'coverage':coverage,'sample':None,'baselineSample':None,'percent':None,'older':None,'note':'Пользовательский план на календарный день × число дней окна; справочник не изменён.' if plan.get('answersTarget') else 'Известный месячный план, равномерно распределённый по календарным дням окна.'})]
            flags=[];c=self.criteria;comparison_coverage=min(coverage,stats['answers']['pairedPeriods']/max(1,len(pairs)));enough=comparison_coverage>=c['minCoverage'];known=stats['answers']['current'] is not None and stats['answers']['baseline'] is not None
            def flag(code,refs,impact):flags.append({'code':code,'refs':[stats[m]['ref'] for m in refs],'impact':min(40,max(0,impact))})
            if known and enough and stats['answers']['baseline']>=c['minAnswers'] and (stats['answers']['percent'] or 0)<=-c['answerDropPct']:flag('answers_drop',['answers'],abs(stats['answers']['percent'])*.4)
            if stats['sends']['percent'] is not None and enough and abs(stats['sends']['percent'])>=c['sendChangePct'] and max(stats['sends']['baseline'],stats['sends']['current'])>=c['minAnswers']:flag('send_change',['sends'],abs(stats['sends']['percent'])*.15)
            if known and enough and (stats['sends']['percent'] or 0)>c['sendChangePct'] and (stats['answers']['percent'] or 0)<-c['answerDropPct']:flag('send_answer_mismatch',['sends','answers'],25)
            rated=stats['csi']['sample'] or 0;old_rated=stats['csi']['baselineSample'] or 0
            if enough and min(rated,old_rated)>=c['minCsiSample'] and stats['csi']['delta'] is not None and stats['csi']['delta']<=-c['csiDrop']:flag('csi_drop',['csi'],abs(stats['csi']['delta'])*35)
            for metric in ('stop','contactPolicy'):
                f=stats[metric]
                if enough and f['delta'] is not None and f['delta']>=c['minCutoffDelta'] and (f['baseline']==0 or (f['percent'] or 0)>=c['cutoffGrowthPct']):flag(metric+'_increase',[metric],20+math.log10(f['delta']+1)*3)
            if enough and expected and stats['answers']['actual'] is not None and expected>=c['minAnswers'] and stats['answers']['actual']<expected*(1-c['planGapPct']/100):flag('plan_gap',['answers','planExpected'],20)
            business=list(flags)
            if not now:flag('no_observations',['answers'],5)
            elif coverage<c['minCoverage']:flag('incomplete_window',['answers'],8)
            if min(rated,old_rated)<max(c['minCsiSample'],30):flag('limited_csi_sample',['csi'],5)
            if not known:flag('missing_baseline',['answers'],5)
            if monthly and any(r['grain']=='day' for r in rows):flag('mixed_grain',['answers'],5)
            strong=[]
            for f in business:
                code=f['code'];adequate=False
                if code in ('answers_drop','send_answer_mismatch'):adequate=max(stats['answers']['current'] or 0,stats['answers']['baseline'] or 0)>=30
                elif code=='csi_drop':adequate=min(rated,old_rated)>=max(30,c['minCsiSample']) and stats['csi']['pairedPeriods']/max(1,len(pairs))>=c['minCoverage']
                elif code.endswith('_increase'):
                    m=code.removesuffix('_increase');adequate=max(stats[m]['current'] or 0,stats[m]['baseline'] or 0)>=100 and stats[m]['pairedPeriods']/max(1,len(pairs))>=c['minCoverage']
                elif code=='send_change':adequate=max(stats['sends']['current'] or 0,stats['sends']['baseline'] or 0)>=100 and abs(stats['sends']['delta'] or 0)>=30
                elif code=='plan_gap':adequate=expected>=30
                if adequate:strong.extend(f['refs'])
            score=min(100,sum(f['impact'] for f in business)+(10 if member['top'] and business else 0));ceiling='medium'
            if strong and enough and not any(f['code']=='mixed_grain' for f in flags):ceiling='critical' if score>=80 and max(stats['answers']['current'] or 0,stats['answers']['baseline'] or 0)>=100 else 'high'
            if not business and not flags:ceiling='low'
            row={**member,'flags':flags,'score':round(score,1),'maxPriority':ceiling,'coverage':coverage,'comparisonCoverage':comparison_coverage,'strongRefs':list(dict.fromkeys(strong)),'facts':{m:f['ref'] for m,f in stats.items()},'businessSignals':len(business)};self.candidates[ident]=row
            qualifies=stats['answers']['actual'] is not None and stats['answers']['actual']>=c['minAnswers'] and any(f['code']=='csi_drop' for f in flags)
            if plan.get('sustained'):
                older_dates={old for _,_,old in pairs if old and calculate(by_date[old],'csi') is not None}
                older_rows=[r for d in older_dates for r in by_date[d]]
                qualifies=qualifies and stats['csi']['older'] is not None and stats['csi']['baseline']<stats['csi']['older'] and len(older_dates)/max(1,len(pairs))>=c['minCoverage'] and weighted_csi(older_rows)['denominator']>=max(30,c['minCsiSample'])
            if plan['goal']!='high_volume_declining_quality' and flags or plan['goal']=='high_volume_declining_quality' and qualifies:self.eligible.append(ident)
        self.eligible.sort(key=lambda k:(-self.candidates[k]['score'],-self.candidates[k]['businessSignals'],k))
        self.aggregate=[]
        for metric,(a,b) in aggregate.items():
            # Each source row contributes once to an aggregate comparison.
            a=list({id(r):r for r in a}.values());b=list({id(r):r for r in b}.values());cur=calculate(a,metric);old=calculate(b,metric)
            self.aggregate.append(self.add_fact({'key':None,'metric':metric,'unit':'балл' if metric=='csi' else 'шт.','actual':cur,'current':cur,'baseline':old,'delta':cur-old if cur is not None and old is not None else None,'percent':(cur-old)/old*100 if cur is not None and old else None,'sample':weighted_csi(a)['denominator'] if metric=='csi' else calculate(a,'answers'),'baselineSample':weighted_csi(b)['denominator'] if metric=='csi' else calculate(b,'answers'),'coverage':None,'older':None,'note':'Сумма сопоставимых наблюдений; для CSI — взвешенное среднее.'}))
        self.signal_ref=self.add_fact({'key':None,'metric':'signals','unit':'опрос','actual':len(self.eligible),'current':len(self.eligible),'baseline':None,'delta':None,'note':'Количество отобранных кандидатов по показанным порогам; это сигналы для проверки.'})
        all_notes=engine.workflows.events_for(self.read_start.isoformat(),end.isoformat(),selected)
        for i,event in enumerate(all_notes[:30],1):
            matches=[key(s) for s in selected if (not event['ids'] or s['event']['id'] in event['ids']) and (not event['channel'] or s['meta']['channel']==event['channel']) and (not event['product'] or event['product'].casefold() in [v.casefold() for v in s['meta'].get('products',[])])]
            self.events['E'+str(i)]={**event,'scopeKeys':matches,'ref':'E'+str(i)}

    def _all_daily(self,keys,month):
        return all(grains==['day'] for grains in self.store.grains(self.revision,keys,month,month+'-31').values())

    def add_fact(self,value):
        ref='F'+str(len(self.facts)+1);self.facts[ref]={k:scalar(v) for k,v in dict(value,ref=ref).items()};return ref

    def packet(self,keys=None):
        keys=self.eligible[:12] if keys is None else keys;refs=list(self.aggregate)+[self.signal_ref]
        for ident in keys:refs.extend(self.candidates[ident]['facts'].values())
        self.exposed.update(refs)
        columns=['ref','key','metric','actual','current','baseline','delta','percent','sample','baselineSample','coverage','older']
        events=[{k:v for k,v in e.items() if k!='scopeKeys'} for e in self.events.values() if any(k in e['scopeKeys'] for k in keys)][:10]
        return {'revision':self.revision,'period':self.start.isoformat()+' — '+self.end.isoformat(),'goal':self.plan['goal'],'criteria':self.criteria,'factColumns':columns,'facts':[[self.facts[r].get(c) for c in columns] for r in refs],'candidates':[{k:v for k,v in self.candidates[i].items() if k not in ('facts','plan','products')} for i in keys],'aggregateRefs':self.aggregate,'signalRef':self.signal_ref,'totalSurveys':len(self.selected),'totalCandidates':len(self.eligible),'listedCandidates':len(keys),'events':events,'notes':'Календарь — пользовательский контекст, не доказанная причина. Приоритеты ограничены maxPriority. Нет строк — не ноль. replyRatio не является когортной конверсией.'}

    def inspect(self,keys):
        if not isinstance(keys,list) or not 1<=len(keys)<=3 or len(set(keys))!=len(keys) or any(k not in self.members for k in keys):raise ValueError('Инспекция доступна для одного–трёх опросов текущего отбора.')
        result=self.packet(keys);trends=[]
        records=self.store.records(self.revision,[(self.members[k]['channel'],self.members[k]['id']) for k in keys],self.read_start.strftime('%Y-%m') if self.grain=='month' else self.read_start.isoformat(),self.end.isoformat(),limit=20001)
        if len(records)>20000:raise ValueError('Для детализации слишком много строк; сократите период.')
        for ident in keys:
            member=self.members[ident];rows=[r for r in records if r['channel']==member['channel'] and r['id']==member['id']];dates=sorted({r['date'] for r in rows});stride=max(1,math.ceil(len(dates)/28));sample=dates[::stride]
            if dates and dates[-1] not in sample:sample.append(dates[-1])
            trends.append({'key':ident,'columns':['date',*CORE],'observations':len(dates),'sampledDates':len(sample),'values':[[d,*[scalar(calculate([r for r in rows if r['date']==d],m)) for m in CORE]] for d in sample],'sampling':'Показан каждый '+str(stride)+'-й наблюдаемый период; это не полная временная последовательность.' if stride>1 else 'Все наблюдаемые периоды.'})
        result['trends']=trends;self.tool_history.append({'tool':'inspect','keys':keys});return result

    def chart(self,keys,metrics,style='line',theme='default'):
        if not isinstance(keys,list) or not 1<=len(keys)<=4 or any(k not in self.members for k in keys) or len({self.members[k]['id'] for k in keys})!=len(keys):raise ValueError('Для графика выберите до четырёх разных ID, с явным каналом для совпадающих номеров.')
        if not isinstance(metrics,list) or not 1<=len(metrics)<=6 or any(m not in CORE for m in metrics):raise ValueError('Неизвестные показатели графика.')
        chosen=[s for s in self.selected if key(s) in keys];channels={s['meta']['channel'] for s in chosen};spec={'ids':[s['event']['id'] for s in chosen],'metrics':metrics,'monthsCount':self.plan['period'].get('months',1),'layout':'combined' if len(metrics)>1 else 'separate'}
        if len(channels)==1:spec['filters']={'channel':next(iter(channels))}
        if self.grain=='day':spec.update(grain='day',daysCount=len(self.dates))
        else:spec.update(startMonth=self.start.strftime('%Y-%m'),endMonth=self.end.strftime('%Y-%m'))
        raw=self.store.records(self.revision,[(s['meta']['channel'],s['event']['id']) for s in chosen],self.start.strftime('%Y-%m') if self.grain=='month' else self.start.isoformat(),self.end.isoformat())
        data=execute_query(dict(self.state,surveys=chosen,rawRecords=raw),spec,'Версия данных AI-анализа',False,[d.isoformat() for d in self.dates] if self.grain=='day' else None);data['visual']={'type':style,'theme':theme}
        with self.engine.lock:return self.engine.register_result(data,{'provider':'gigacode','planner':'model-evidence','spec':spec,'interpretation':'Динамика выбранного сигнала'},self.revision)
