"""Deterministic monitoring and versioned committee workflow for a local project."""
import datetime as dt
import hashlib
import json
import threading
import uuid
from collections import defaultdict

from analytics_db import encoded
from metric_registry import VERSION, POLICY, calculate, weighted_csi
from workflows import changes, compact, now, text
from feedback_overview import build as build_feedback, windows


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def select_checks(root, stage, facts, options):
    from model_client import call_json
    result = call_json(root, 'Выбери до трёх ID из options по переданным facts. Верни один JSON {"selected":["ID"]}. Никакого текста и вычислений.',
                       {'facts':facts,'options':options},stage,stage,None,threading.Event())
    ids = result.get('selected')
    allowed = {option['id']:option for option in options}
    if set(result)!={'selected'} or not isinstance(ids,list) or not 1<=len(ids)<=3 or any(not isinstance(i,str) or i not in allowed for i in ids):
        raise ValueError('Ответ модели не прошёл проверку ссылок на факты.')
    return [allowed[i] for i in dict.fromkeys(ids)]


def observation(rows, channel):
    result = {key: calculate(rows, key) for key in ('events', 'sends', 'answers', 'csi', 'stop', 'contactPolicy')}
    result['csiSample'] = weighted_csi(rows)['denominator']
    events, sends = result['events'], result['sends']
    result['sendShare'] = sends / events * 100 if events and sends is not None else None
    result['responseRate'] = result['answers'] / sends * 100 if sends else None
    counts = [result[key] for key in ('sends', 'stop', 'contactPolicy')]
    result['other'] = events - sum(counts) if channel == 'communication' and events is not None and all(value is not None for value in counts) else None
    for key in ('stop', 'contactPolicy', 'other'):
        result[key + 'Share'] = result[key] / events * 100 if events and result[key] is not None else None
    return result


def remaining_statuses(current, prior):
    buckets = []
    for rows in (current, prior):
        counts = defaultdict(int)
        for row in rows:
            if row['status'] not in (1002, *POLICY):
                counts[str(row['status'])] += row['events'] - row['sends']
        buckets.append(counts)
    a, b = buckets
    result = [{'status': code, 'current': a.get(code), 'baseline': b.get(code),
               'delta': a[code] - b[code] if code in a and code in b else None} for code in a.keys() | b.keys()]
    return sorted(result, key=lambda row: (-abs(row['delta'] or 0), row['status']))[:20]


def signals(records, end, channel, calendars=()):
    groups = defaultdict(list)
    for row in records:
        if row['grain'] == 'day' and row['channel'] == channel:
            groups[row['id'], row['date']].append(row)
    output = []
    by_id = {calendar['id']:calendar for calendar in calendars}
    for ident in sorted({key[0] for key in groups} | by_id.keys()):
        current, prior = [], []
        days = []
        for offset in range(6, -1, -1):
            date = end - dt.timedelta(days=offset)
            a, b = date.isoformat(), (date - dt.timedelta(days=7)).isoformat()
            if groups.get((ident, a)) and groups.get((ident, b)):
                current.extend(groups[ident, a]);prior.extend(groups[ident, b]);days.append(a)
        if len(days) < 5:
            current,prior,days=[],[],[]
        a, b = observation(current, channel), observation(prior, channel)
        delta = {key: a[key] - b[key] if a[key] is not None and b[key] is not None else None for key in a}
        reasons = []
        if delta['sendShare'] is not None and delta['sendShare'] <= -5 and (b['events'] or 0) >= 100 and (a['events'] or 0) >= 100:
            reasons.append('Доля отправок снизилась минимум на 5 п.п.')
        if (b['answers'] or 0) >= 30 and a['answers'] is not None and a['answers'] <= .8 * b['answers']:
            reasons.append('Ответов стало меньше минимум на 20%')
        if min(a['csiSample'], b['csiSample']) >= 30 and delta['csi'] is not None and delta['csi'] <= -.3 + 1e-10:
            reasons.append('CSI снизился минимум на 0,3 балла')
        calendar = by_id.get(ident)
        urgent = bool(calendar and calendar['observed'] and calendar['observed']==len(calendar['days']) and not calendar['sent'])
        if urgent:
            reasons.insert(0,'С начала месяца отправок не было ни в один день.')
        elif calendar and calendar['days'][-1]['sends']==0:
            reasons.insert(0,'В последний проверяемый день отправок не было.')
        elif calendar and calendar['observed'] and not calendar['sent']:
            reasons.insert(0,'В наблюдаемые дни отправок не было. Часть дней без данных.')
        if reasons:
            output.append({'key': f'{channel}:{ident}:{end.isoformat()}', 'id': ident, 'channel': channel,
                           'through': end.isoformat(), 'pairedDays': days, 'current': a, 'baseline': b, 'delta': delta, 'reasons': reasons,
                           'severity':'urgent' if urgent else 'attention','activity':calendar,
                           'remainingStatuses': remaining_statuses(current, prior) if channel == 'communication' else []})
    return sorted(output, key=lambda row: (row['severity']!='urgent',-len(row['reasons']),row['delta']['sendShare'] or 0,row['id']))


def send_calendars(surveys, rows, end):
    by_day={(row['survey_id'],row['date']):row['sends'] for row in rows}
    dates=[end.replace(day=day).isoformat() for day in range(1,end.day+1)]
    output=[]
    for survey in surveys:
        ident=survey['event']['id']
        days=[{'date':date,'sends':by_day.get((ident,date))} for date in dates]
        output.append({'id':ident,'name':survey['meta']['name'],'products':survey['meta'].get('products',[]),
                       'sent':sum((day['sends'] or 0)>0 for day in days),
                       'observed':sum(day['sends'] is not None for day in days),'days':days})
    return output


class Committee:
    def __init__(self, engine):
        self.engine = engine
        self.feedback_cache = None
        self.db = engine.store.connect
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS monitoring_tasks(id TEXT PRIMARY KEY, signal_key TEXT NOT NULL UNIQUE, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS committee_packs(id TEXT PRIMARY KEY, scenario TEXT NOT NULL, created TEXT NOT NULL, document TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS committee_packs_scenario ON committee_packs(scenario, created DESC);
            ''')

    def _load(self, db, table, ident):
        if table == 'monitoring_tasks':
            row = db.execute('SELECT document FROM monitoring_tasks WHERE id=?', (ident,)).fetchone()
        else:
            row = db.execute('SELECT document FROM committee_packs WHERE id=?', (ident,)).fetchone()
        if not row:
            raise ValueError('Запись не найдена.')
        return json.loads(row[0])

    def monitor(self, request):
        channel = request.get('channel', 'communication')
        ident = request.get('survey')
        product=request.get('product','')
        top=request.get('top',False)
        top_products=request.get('topProducts',False)
        if not isinstance(product,str) or len(product)>200 or type(top) is not bool or type(top_products) is not bool:
            raise ValueError('Проверьте фильтры продукта и топ-опросов.')
        if channel not in ('communication', 'success_screen') or ident is not None and (type(ident) is not int or not 1 <= ident <= 9999999):
            raise ValueError('Выберите канал и корректный номер опроса.')
        engine = self.engine
        with engine.lock:
            state, status = engine.refresh()
            revision = engine.document.get('revision')
            if status.get('error'):
                raise ValueError(status['error'])
            universe=state['surveys']
            unassigned='без продукта'
            products=sorted({p for s in universe for p in s['meta'].get('products',[])},key=str.casefold)
            priority={p.casefold() for s in universe if s['event'].get('isTop') for p in s['meta'].get('products',[]) if p.casefold()!=unassigned}
            if product and product.casefold() not in {p.casefold() for p in products}:
                raise ValueError('Продукт отсутствует в справочнике. Выберите другой продукт.')
            surveys=[]
            for survey in universe:
                survey_products={p.casefold() for p in survey['meta'].get('products',[])}
                if survey['meta']['channel']!=channel or (ident is not None and survey['event']['id']!=ident):
                    continue
                if top and not survey['event'].get('isTop') or product and product.casefold() not in survey_products:
                    continue
                if top_products and not (priority & survey_products or not priority and survey['event'].get('isTop')):
                    continue
                surveys.append(survey)
            keys=[(channel,s['event']['id']) for s in surveys]
            yesterday=dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).date()-dt.timedelta(days=1)
            explicit=request.get('through')
            as_of=explicit or request.get('asOf')
            calendar_end=dt.date.fromisoformat(text(as_of,'Дата',10)) if as_of else yesterday
            if calendar_end>yesterday:raise ValueError('Выберите завершившийся день по московскому времени.')
            latest=engine.store.last_daily(revision,keys,calendar_end.isoformat()) if revision and keys else None
            end=calendar_end if explicit else dt.date.fromisoformat(latest) if latest else calendar_end
            month_start=calendar_end.replace(day=1)
            records=engine.store.monitoring_records(revision,keys,(end-dt.timedelta(days=13)).isoformat(),end.isoformat()) if latest else []
            daily=engine.store.feedback_days(revision,month_start.isoformat(),calendar_end.isoformat(),POLICY,keys) if latest else []
            product_case=next((name for name in products if name.casefold()==product.casefold()),None) if product else None
            product_summary=None
            if product_case and not ident and latest:
                from feedback_overview import answer_change
                selection={'product':product_case,'channel':channel,'top':top}
                matched=answer_change(engine.store,revision,surveys,selection,end.isoformat())
                product_summary={key:matched[key] for key in ('name','baseline','current','pairCount','comparedSurveys','surveyCount','selection')}
        names = {survey['event']['id']: survey['meta']['name'] for survey in surveys}
        calendars=send_calendars(surveys,daily,calendar_end)
        found = signals(records, end, channel, calendars)
        for row in found:
            row.update(revision=revision, name=names.get(row['id'], str(row['id'])))
        span = windows(end.isoformat())
        for row in found:
            row['windows'] = span
        urgent_count=sum(row['severity']=='urgent' for row in found)
        return {'signals': found[:100], 'total': len(found), 'revision': revision, 'through': end.isoformat(),
                'latest': latest, 'windows': span,'calendars':calendars,'calendarThrough':calendar_end.isoformat(),
                'severityCounts':{'urgent':urgent_count,'attention':len(found)-urgent_count},
                'productSummary':product_summary,
                'products':products,'topProducts':[p for p in products if p.casefold() in priority],
                'topProductsFallback':top_products and not priority,'historical':bool(explicit),
                'message':'Нет опросов по выбранным фильтрам.' if not surveys else 'Нет дневных наблюдений по выбранному отбору.' if not latest else ''}

    def feedback(self):
        with self.engine.lock:
            state,status = self.engine.refresh()
            if status.get('error'):
                raise ValueError(status['error'])
            revision = self.engine.document.get('revision')
            if self.feedback_cache is None or self.feedback_cache['revision']!=revision:
                self.feedback_cache = build_feedback(self.engine.store,revision,state['surveys'])
            return self.feedback_cache

    def feedback_signal(self,request):
        key=request.get('key')
        selection=request.get('selection')
        if selection is not None or key in ('survey:1007:communication','survey:1007:success_screen'):
            if selection is None:
                selection={'id':1007,'channel':key.rsplit(':',1)[1]}
            scope=self.answer_change_scope(selection,request.get('through'))
            if scope.get('revision')!=request.get('revision'):
                raise ValueError('Данные обновились. Повторите запрос перед выгрузкой или назначением.')
            if not scope.get('pairCount'):
                raise ValueError('Для разбора нужно минимум пять сопоставимых пар дней.')
            if scope['key']!=key:
                raise ValueError('Отбор изменился. Повторите запрос.')
            # Preserve one task per canonical selection and reporting window.
            suffix=':top' if selection.get('top') else ''
            if selection.get('product') and selection.get('channel'):
                suffix+=':'+selection['channel']
            return dict(scope,key='feedback:'+key+suffix+':'+scope['through'])
        dashboard = self.feedback()
        if dashboard['revision']!=request.get('revision'):
            raise ValueError('Данные обновились. Обновите экран перед назначением.')
        scope = next((item for item in (dashboard['overview'],*dashboard['channels'],*dashboard['signals'])
                      if item and item['pairCount'] and item['key']==request.get('key')),None)
        if scope is None:
            raise ValueError('Срез недоступен. Обновите экран.')
        return dict(scope,key='feedback:'+scope['key']+':'+scope['through'])

    def answer_change_scope(self,selection,through=None):
        from feedback_overview import answer_change
        with self.engine.lock:
            state,status=self.engine.refresh()
            if status.get('error'):
                raise ValueError(status['error'])
            return answer_change(self.engine.store,self.engine.document.get('revision'),state['surveys'],selection,through)

    def current_signal(self, request):
        scan = self.monitor(request)
        if scan['revision'] != request.get('revision'):
            raise ValueError('Данные обновились. Пересчитайте очередь перед назначением.')
        signal = next((item for item in scan['signals'] if item['key'] == request.get('key')), None)
        if not signal:
            raise ValueError('Сигнал больше не входит в текущий результат. Пересчитайте очередь.')
        return signal

    def signal_review(self, request):
        signal = self.current_signal(request)
        titles = {'events':'События','sendShare':'Доля отправок','stopShare':'Доля стоп-листов','contactPolicyShare':'Доля политики контактов','answers':'Ответы','csi':'CSI'}
        facts = [{'ref':key,'label':label,'current':signal['current'][key],'baseline':signal['baseline'][key],
                  'delta':signal['delta'][key],'unit':'п.п.' if key.endswith('Share') else 'балла' if key=='csi' else 'шт.'} for key,label in titles.items()]
        options = [
            {'id':'coverage','label':'Сверить полноту выгрузки по дням и сопоставимость периода.','refs':['events']},
            {'id':'delivery','label':'Проверить журнал доставки и изменения объёма отправок.','refs':['sendShare','answers']},
        ]
        if signal.get('activity'):
            activity=signal['activity']
            facts.append({'ref':'sendDays','label':'Дни с отправками с начала месяца','current':activity['sent'],
                          'baseline':None,'delta':None,'unit':'дн.'})
            options[1]['refs'].insert(0,'sendDays')
        if signal['channel']=='communication':
            if signal['delta']['contactPolicyShare'] is not None:
                options.insert(0,{'id':'policy','label':'Проверить изменения правил контакта и версии настроек в журнале запусков.','refs':['contactPolicyShare','sendShare']})
            if signal['delta']['stopShare'] is not None:
                options.insert(0,{'id':'stop','label':'Сверить изменения состава стоп-листов с журналом обновлений.','refs':['stopShare','sendShare']})
        if signal['delta']['csi'] is not None:
            options.append({'id':'csi','label':'Сверить размер выборки CSI и распределение оценок.','refs':['csi','answers']})
        origin, warning = 'local',''
        if request.get('useModel') is True:
            try:
                options=select_checks(self.engine.root,'signal-checks',facts,options)
                origin='gigacode'
            except (OSError,ValueError) as error:
                warning='GigaCode: '+str(error)
        with self.engine.lock:
            members=[survey for survey in self.engine.state['surveys'] if survey['event']['id']==signal['id'] and survey['meta']['channel']==signal['channel']]
            start=(dt.date.fromisoformat(signal['through'])-dt.timedelta(days=13)).isoformat()
            calendar=[{key:event[key] for key in ('from','to','title')} for event in self.engine.workflows.events_for(start,signal['through'],members)][:12]
        return {'signal':signal,'facts':facts,'checks':options,'origin':origin,'warning':warning,'calendar':calendar}

    def assign(self, request):
        signal = self.feedback_signal(request) if request.get('scope')=='feedback' else self.current_signal(request)
        actor = text(request.get('actor'), 'Кто назначил', 120)
        owner = text(request.get('owner'), 'Ответственный', 120)
        due = dt.date.fromisoformat(text(request.get('due'), 'Срок', 10)).isoformat()
        task = {'id': uuid.uuid4().hex, 'version': 1, 'signal': signal, 'owner': owner, 'due': due, 'status': 'open',
                'check':text(request.get('check',''),'Что проверить',500,False),
                'history': [{'at': now(), 'actor': actor, 'status': 'open', 'note': ''}]}
        if request.get('scope')=='feedback' and 'incidentFactor' in request:
            from incident_investigator import CHECKS
            factor=request['incidentFactor']
            if not isinstance(factor,str) or factor not in CHECKS:
                raise ValueError('Выберите гипотезу из текущего разбора.')
            task['incidentFactor']=factor
        with self.db() as db:
            cursor = db.execute('INSERT OR IGNORE INTO monitoring_tasks VALUES(?,?,?)', (task['id'], signal['key'], encoded(task)))
            if not cursor.rowcount:
                raise ValueError('На это отклонение уже заведена задача.')
        return task

    def update_task(self, request):
        actor = text(request.get('actor'), 'Кто меняет статус', 120)
        note = text(request.get('note', ''), 'Результат проверки', 2000, request.get('status') == 'resolved')
        status = request.get('status')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            task = self._load(db, 'monitoring_tasks', request.get('id'))
            if request.get('version') != task['version']:
                raise ValueError('Задача уже изменена. Обновите список.')
            transitions = {'open': {'in_progress', 'resolved'}, 'in_progress': {'resolved'}, 'resolved': {'in_progress'}}
            if status not in transitions[task['status']]:
                raise ValueError('Недопустимый переход статуса.')
            task.update(status=status, version=task['version'] + 1)
            task['history'].append({'at': now(), 'actor': actor, 'status': status, 'note': note})
            db.execute('UPDATE monitoring_tasks SET document=? WHERE id=?', (encoded(task), task['id']))
        return task

    def packs(self, scenario, model=False):
        with self.db() as db:
            rows = db.execute('SELECT document FROM committee_packs WHERE scenario LIKE ? ORDER BY created DESC LIMIT 40', ('model:%',)) if model else db.execute(
                'SELECT document FROM committee_packs WHERE scenario=? ORDER BY created DESC LIMIT 40', (scenario,))
            return [{key: value for key, value in json.loads(row[0]).items() if key != 'snapshot'} for row in rows]

    def pack_source(self, request):
        if request.get('analysisId') or request.get('jobId'):
            return self.model_pack_source(request)
        scenario = request.get('scenario')
        with self.engine.lock:
            _, status = self.engine.refresh()
            data = self.engine.workflows.open(scenario)
            run = data.get('run')
            if status.get('error') or not run or data['lastError'] or run['revision'] != self.engine.document.get('revision'):
                raise ValueError('Для нового пакета нужен актуальный успешный запуск сценария.')
            source = {'name': data['definition']['name'], 'charts': run['charts'], 'revision': run['revision'], 'metricVersion': VERSION,
                      'scopeHash': digest([chart['spec'] for chart in data['definition']['charts']]),
                      'titles': [item['query'] for item in data['definition']['charts']]}
        return scenario, source

    def model_pack_source(self, request):
        with self.engine.lock:
            _,status=self.engine.refresh()
            revision=self.engine.document.get('revision')
            if status.get('error'):raise ValueError(status['error'])
            query=''
            if request.get('analysisId'):
                entry=self.engine.analyses.get(request['analysisId']) or self.engine.store.analysis(request['analysisId']) or {}
                chart=entry.get('reportChart')
                if not chart or entry['revision']!=revision:raise ValueError('Постройте график заново по актуальным данным.')
                charts=[chart]
                query=chart['contract'].get('query') or chart['contract']['interpretation']
            else:
                agent=self.engine.agent
                with agent.lock:
                    job=agent.jobs.get(request['jobId'],{})
                result=job.get('result',{})
                if job.get('status')!='done' or job['revision']!=revision or result.get('kind')!='ai-workspace':
                    raise ValueError('Повторите модельный анализ по актуальным данным.')
                components=result['view']['components']
                charts=[compact(component['chartData']) for component in components if component.get('chartData')]
                if not charts:
                    keys=list(dict.fromkeys(item['key'] for component in components if component['type']=='priority_queue' for item in component['items']))
                    if not keys:keys=list(result['members'])
                    if not keys:raise ValueError('В анализе нет опросов для отчёта.')
                    charts=[compact(job['evidence'].chart([keys[0]],['events','sends','answers']))]
                query=job['query']
            name='Динамика по общебанку' if len(charts)==1 and charts[0]['spec']['ids']==[1007] and charts[0]['spec'].get('grain')=='week' else query[:120]
            titles=[query[:160]] if len(charts)==1 else ['График анализа '+str(i+1) for i in range(len(charts))]
            composition_index=None
            if name=='Динамика по общебанку':
                from genui_extended import execute_query
                from genui_query import validate_spec
                spec=validate_spec({key:value for key,value in charts[0]['spec'].items() if key not in ('series','plan') } | {'metrics':['events','sends','stop','contactPolicy']})
                if spec.get('filters',{}).get('channel')!='success_screen':
                    composition=execute_query(self.engine.query_state(spec,revision),spec,'Ваши CSV · структура отсечений',False)
                    if composition['months']==charts[0]['months'] and any(value is not None for b in composition['blocks'] if b['metric'] in ('stop','contactPolicy') for value in b['values']):
                        composition_index=len(charts)
                        charts.append(composition);titles.append('Структура событий и отсечений')
            scope=digest([chart['spec'] for chart in charts])
            return 'model:'+scope, {'name':name,'charts':charts,'titles':titles,'revision':revision,'metricVersion':VERSION,'scopeHash':scope,'provider':charts[0].get('provider','gigacode'),'compositionIndex':composition_index}

    def pack_draft(self, request):
        _,source=self.pack_source(request)
        facts=[]
        for chart in source['charts']:
            for block in chart['blocks']:
                observed=[(i,v) for i,v in enumerate(block['values']) if v is not None]
                if len(observed)<2:continue
                weeks=chart.get('periods',[]) if chart['spec'].get('grain')=='week' else []
                complete=[(i,v) for i,v in observed if weeks and not weeks[i]['partial']]
                if len(complete)>=2:observed=complete
                first,last=observed[0],observed[-1]
                ref='F'+str(len(facts)+1)
                period=chart['months'][first[0]]+' → '+chart['months'][last[0]]
                if weeks:
                    a,b=weeks[first[0]],weeks[last[0]]
                    period=f"{a['start']}–{a['end']} → {b['start']}–{b['end']}"
                    if a['partial'] or b['partial']:period+='; есть неполные недели'
                facts.append({'ref':ref,'label':block['label'],'baseline':first[1],'current':last[1],'delta':last[1]-first[1],
                              'period':period,'unit':'балла' if block['metric']=='csi' else 'шт.'})
        facts=facts[:12]
        if not facts:raise ValueError('Для черновика вывода нужны минимум две точки одного показателя.')
        selected=select_checks(self.engine.root,'committee-draft',facts,[{'id':f['ref'],'label':f['label'],'refs':[f['ref']]} for f in facts])
        chosen={fact['ref']:fact for fact in facts}
        def localized(value):
            return f'{value:,.2f}'.rstrip('0').rstrip('.').replace(',', ' ').replace('.', ',')
        sentences=[]
        for option in selected:
            fact=chosen[option['id']]
            sentences.append(f"{fact['label']}: {localized(fact['baseline'])} → {localized(fact['current'])} {fact['unit']} ({fact['period']}).")
        return {'conclusion':' '.join(sentences),'sourceHash':digest(source)}

    def create_pack(self, request):
        author = text(request.get('actor'), 'Автор пакета', 120)
        scenario,source=self.pack_source(request)
        if request.get('sourceHash') and request['sourceHash']!=digest(source):
            raise ValueError('Источник черновика изменился. Подготовьте вывод повторно.')
        if not any(value is not None for chart in source['charts'] for block in chart['blocks'] for value in block['values']):
            raise ValueError('В источнике нет наблюдений для пакета. Уточните показатели или период.')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('SELECT document FROM committee_packs WHERE scenario=? ORDER BY created DESC', (scenario,))
            previous = next((doc for row in rows if (doc := json.loads(row[0]))['status'] == 'approved'), None)
            source['scopeChanged'] = bool(previous and previous['snapshot'].get('scopeHash') != source['scopeHash'])
            source['comparison'] = changes(previous['snapshot']['charts'] if previous and not source['scopeChanged'] else [], source['charts'])
            source['previousApproved'] = {'id': previous['id'], 'revision': previous['snapshot']['revision']} if previous else None
            source['conclusion'] = text(request.get('conclusion', ''), 'Вывод автора', 600, False)
            timestamp = now()
            pack = {'id': uuid.uuid4().hex, 'scenario': scenario, 'created': timestamp, 'status': 'draft', 'version': 1,
                    'author': author, 'hash': digest(source), 'revision': source['revision'], 'snapshot': source,
                    'history': [{'at': timestamp, 'actor': author, 'status': 'draft', 'note': ''}]}
            db.execute('INSERT INTO committee_packs VALUES(?,?,?,?)', (pack['id'], scenario, timestamp, encoded(pack)))
        return pack

    def review(self, request):
        actor = text(request.get('actor'), 'Участник согласования', 120)
        status = request.get('status')
        note = text(request.get('note', ''), 'Комментарий', 1200, status == 'rejected')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            pack = self._load(db, 'committee_packs', request.get('id'))
            if request.get('version') != pack['version'] or pack['hash'] != digest(pack['snapshot']):
                raise ValueError('Версия пакета изменилась или повреждена. Откройте список заново.')
            same_actor=' '.join(actor.split()).casefold() == ' '.join(pack['author'].split()).casefold()
            if status == 'review' and pack['status'] == 'draft' and same_actor:
                pass
            elif status in ('approved', 'rejected') and pack['status'] == 'review' and not same_actor:
                pass
            else:
                raise ValueError('Автор отправляет черновик. Утверждает или возвращает другой участник.')
            pack.update(status=status, version=pack['version'] + 1)
            pack['history'].append({'at': now(), 'actor': actor, 'status': status, 'note': note})
            db.execute('UPDATE committee_packs SET document=? WHERE id=?', (encoded(pack), pack['id']))
        return pack

    def action(self, request):
        if request.get('action') == 'feedback': return self.feedback()
        action = request.get('action')
        if action == 'answer-change':
            from incident_investigator import calculate_report, survey_members
            from committee_slide import slide_from_report
            with self.engine.lock:
                selection=request.get('selection')
                if selection is None and 'phrase' in request:
                    from answer_intent import resolve_scope
                    state,status=self.engine.refresh()
                    if status.get('error'):raise ValueError(status['error'])
                    selection,choices=resolve_scope(request['phrase'],state['surveys'],request.get('default',{'id':1007}))
                    if selection is None:
                        return {'scope':{'selectionChoices':choices,'name':'Сравнение ответов'}}
                if selection is None:
                    selection={'id':1007,'channel':request.get('channel','')}
                scope=self.answer_change_scope(selection,request.get('through'))
                if request.get('revision') is not None and scope.get('revision')!=request['revision']:
                    raise ValueError('Данные обновились. Пересчитайте сигналы.')
                if not scope.get('pairCount'):
                    return {'scope':scope}
                report=calculate_report(self,scope,survey_members(self,scope))
                draft=slide_from_report(scope,report,{})
                return {'scope':scope,'draft':draft,'report':{**report,'hypotheses':report['candidates'][:3]}}
        if action == 'incident-investigator':
            from incident_investigator import run
            return run(self,request)
        if action == 'committee-slide':
            from committee_slide import draft
            return draft(self,request)
        if action == 'monitor': return self.monitor(request)
        if action == 'signal-review': return self.signal_review(request)
        if action == 'assign': return self.assign(request)
        if action == 'task-update': return self.update_task(request)
        if action == 'tasks':
            with self.db() as db:
                return [json.loads(row[0]) for row in db.execute('SELECT document FROM monitoring_tasks ORDER BY rowid DESC')]
        if action == 'packs':
            return self.packs(self.pack_source(request)[0] if request.get('analysisId') or request.get('jobId') else request.get('scenario'))
        if action == 'packs-model': return self.packs(None,model=True)
        if action == 'pack-draft': return self.pack_draft(request)
        if action == 'pack-create': return self.create_pack(request)
        if action == 'pack-review': return self.review(request)
        if action in ('pack-open', 'pack-export'):
            with self.db() as db:
                pack = self._load(db, 'committee_packs', request.get('id'))
            if digest(pack['snapshot']) != pack['hash']:
                raise ValueError('Снимок пакета повреждён.')
            if action == 'pack-export' and pack['status'] != 'approved':
                raise ValueError('Экспорт доступен после утверждения пакета.')
            return pack
        if action == 'policy':
            from model_policy import profile, VERSION as policy_version
            return {'profile': profile(self.engine.root), 'version': policy_version}
        if action == 'evaluate':
            from release_eval import run
            return run()
        raise ValueError('Неизвестное действие рабочего контура.')
