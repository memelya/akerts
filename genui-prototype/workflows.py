"""Persistent local scenarios, successful-run baselines and launch calendar."""
import copy,datetime as dt,hashlib,json,re,uuid
from analytics_db import encoded
from genui_query import validate_spec

def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def text(value,label,limit,required=True):
    if not isinstance(value,str) or len(value)>limit or required and not value.strip():raise ValueError('Проверьте поле «'+label+'».')
    return value.strip()
def definition(value):
    if not isinstance(value,dict) or set(value)-{'format','version','name','charts','comparison'}:raise ValueError('Файл должен содержать только настройки сценария.')
    if value.get('format','genui-scenario')!='genui-scenario' or value.get('version',1)!=1:raise ValueError('Неизвестный формат сценария.')
    charts=value.get('charts')
    if not isinstance(charts,list) or not 1<=len(charts)<=12:raise ValueError('Выберите от 1 до 12 графиков.')
    result=[]
    for chart in charts:
        if not isinstance(chart,dict) or set(chart)-{'query','queries','spec','visual'}:raise ValueError('Некорректная настройка графика.')
        visual=chart.get('visual') or {'type':'line','theme':'default'}
        if not isinstance(visual,dict) or set(visual)-{'type','theme'} or visual.get('type','line') not in ('line','bars','area') or visual.get('theme','default') not in ('default','presentation'):raise ValueError('Неизвестный тип или цветовая схема графика.')
        query=text(chart.get('query',''),'Запрос',1200,False);queries=chart.get('queries',[query] if query else [])
        if not isinstance(queries,list) or len(queries)>12:raise ValueError('Сценарий хранит до 12 сообщений для каждого графика.')
        result.append({'query':query,'queries':[text(q,'Сообщение',1200) for q in queries],'spec':validate_spec(chart.get('spec')),'visual':visual})
    comparison=value.get('comparison','aligned')
    if comparison not in ('aligned','weekday','previous'):raise ValueError('Неизвестная база сравнения.')
    return {'format':'genui-scenario','version':1,'name':text(value.get('name'),'Название',120),'charts':result,'comparison':comparison}

def compact(result):
    return {k:copy.deepcopy(v) for k,v in result.items() if k not in ('details','analysisId')}

def changes(before,after):
    output=[]
    for i,result in enumerate(after):
        prior=before[i] if i<len(before) else None;old={(b['id'],b['metric']):b for b in prior['totals']} if prior else {}
        values=[]
        for b in result['totals']:
            previous=old.get((b['id'],b['metric']),{}).get('value');current=b['value'];delta=current-previous if current is not None and previous is not None else None
            values.append({'id':b['id'],'metric':b['metric'],'label':b['label'],'current':current,'previous':previous,'delta':delta,'percent':delta/previous*100 if delta is not None and previous else None})
        previous_cells={(b['id'],b['metric'],p):v for b in prior['blocks'] for p,v in zip(prior['months'],b['values'])} if prior else {}
        cells={(b['id'],b['metric'],p):v for b in result['blocks'] for p,v in zip(result['months'],b['values'])}
        common=set(previous_cells)&set(cells)
        output.append({'chart':i,'firstRun':prior is None,'periodChanged':bool(prior and (prior['months']!=result['months'] or prior.get('periodLabel')!=result.get('periodLabel'))),'newPeriods':sorted(set(result['months'])-set(prior['months'] if prior else [])),'removedPeriods':sorted(set(prior['months'] if prior else [])-set(result['months'])),'changedCells':sum(previous_cells[k]!=cells[k] for k in common),'matchedCells':len(common),'totals':values})
    return output

class Workflows:
    def __init__(self,engine):
        self.engine=engine;self.store=engine.store
        with self.store.connect() as db:db.executescript('''CREATE TABLE IF NOT EXISTS scenarios(id TEXT PRIMARY KEY,definition TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,last_error TEXT);
        CREATE TABLE IF NOT EXISTS scenario_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,scenario_id TEXT NOT NULL,created TEXT NOT NULL,revision TEXT NOT NULL,settings_hash TEXT NOT NULL,result TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS scenario_runs_recent ON scenario_runs(scenario_id,seq DESC);
        CREATE TABLE IF NOT EXISTS calendar_events(id TEXT PRIMARY KEY,document TEXT NOT NULL);''')

    def list(self):
        with self.store.connect() as db:
            scenarios=[]
            for row in db.execute('SELECT * FROM scenarios ORDER BY updated DESC'):
                d=json.loads(row['definition']);run=db.execute('SELECT created,revision FROM scenario_runs WHERE scenario_id=? ORDER BY seq DESC LIMIT 1',(row['id'],)).fetchone()
                scenarios.append({'id':row['id'],'name':d['name'],'chartCount':len(d['charts']),'created':row['created'],'updated':row['updated'],'lastError':row['last_error'],'lastRun':dict(run) if run else None,'stale':bool(run and run['revision']!=self.engine.document.get('revision'))})
            events=[json.loads(row[0]) for row in db.execute('SELECT document FROM calendar_events')]
        return {'scenarios':scenarios,'events':sorted(events,key=lambda e:e['from'],reverse=True),'revision':self.engine.document.get('revision')}

    def open(self,ident):
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM scenarios WHERE id=?',(ident,)).fetchone()
            if row is None:raise ValueError('Сценарий не найден.')
            runs=[dict(r) for r in db.execute('SELECT created,revision,result FROM scenario_runs WHERE scenario_id=? ORDER BY seq DESC LIMIT 2',(ident,))]
        run=None
        if runs:run={k:v for k,v in runs[0].items() if k!='result'};run.update(json.loads(runs[0]['result']))
        return {'id':ident,'definition':json.loads(row['definition']),'lastError':row['last_error'],'run':run,'previousRunAt':runs[1]['created'] if len(runs)>1 else None}

    def save(self,value,ident=None):
        d=definition(value);ident=ident or uuid.uuid4().hex[:24]
        with self.store.connect() as db:
            if not db.execute('SELECT 1 FROM scenarios WHERE id=?',(ident,)).fetchone() and db.execute('SELECT COUNT(*) FROM scenarios').fetchone()[0]>=50:raise ValueError('Доступно до 50 сценариев. Удалите ненужные.')
            db.execute('INSERT INTO scenarios VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,updated=excluded.updated,last_error=NULL',(ident,encoded(d),now(),now()))
        try:self.run(ident)
        except ValueError:pass
        return self.open(ident)

    def run(self,ident):
        with self.store.connect() as db:
            row=db.execute('SELECT definition FROM scenarios WHERE id=?',(ident,)).fetchone()
            if row is None:raise ValueError('Сценарий не найден.')
            d=json.loads(row[0]);digest=hashlib.sha256(encoded(d).encode()).hexdigest()
            prior=db.execute('SELECT * FROM scenario_runs WHERE scenario_id=? ORDER BY seq DESC LIMIT 1',(ident,)).fetchone()
        revision=self.engine.document.get('revision')
        if prior and prior['revision']==revision and prior['settings_hash']==digest:return self.open(ident)
        try:
            if not revision:raise ValueError('Сначала загрузите CSV. Настройки сценария сохранены.')
            results=[]
            for chart in d['charts']:
                data=self.engine.execute_saved(chart['spec'],chart['query'],register=False);data['visual']=chart['visual'];results.append(compact(data))
            before=json.loads(prior['result'])['charts'] if prior else []
            value={'charts':results,'changes':changes(before,results),'settingsChanged':bool(prior and prior['settings_hash']!=digest),'previousRevision':prior['revision'] if prior else None}
            with self.store.connect() as db:
                db.execute('INSERT INTO scenario_runs(scenario_id,created,revision,settings_hash,result) VALUES(?,?,?,?,?)',(ident,now(),revision,digest,encoded(value)))
                db.execute('DELETE FROM scenario_runs WHERE scenario_id=? AND seq NOT IN(SELECT seq FROM scenario_runs WHERE scenario_id=? ORDER BY seq DESC LIMIT 5)',(ident,ident));db.execute('UPDATE scenarios SET last_error=NULL WHERE id=?',(ident,))
        except (ValueError,OSError) as error:
            with self.store.connect() as db:db.execute('UPDATE scenarios SET last_error=? WHERE id=?',(str(error),ident))
            raise
        return self.open(ident)

    def recalculate_all(self):
        for row in self.list()['scenarios']:
            try:self.run(row['id'])
            except (ValueError,OSError):pass

    def delete(self,ident):
        with self.store.connect() as db:db.execute('DELETE FROM scenario_runs WHERE scenario_id=?',(ident,));db.execute('DELETE FROM scenarios WHERE id=?',(ident,))
        return self.list()

    def save_event(self,event):
        if not isinstance(event,dict) or set(event)-{'id','title','from','to','kind','owner','note','ids','channel','product'}:raise ValueError('Некорректное событие календаря.')
        start=dt.date.fromisoformat(event.get('from',''));end=dt.date.fromisoformat(event.get('to') or event.get('from',''))
        if end<start:raise ValueError('Конец события раньше начала.')
        ids=event.get('ids',[])
        if not isinstance(ids,list) or len(ids)>200 or any(type(i) is not int or not 1<=i<=9999999 for i in ids):raise ValueError('Укажите до 200 номеров опросов.')
        channel=event.get('channel','');kind=event.get('kind','other')
        if channel not in ('','communication','success_screen') or kind not in ('campaign','policy','incident','other'):raise ValueError('Проверьте канал и тип события.')
        ident=event.get('id') or uuid.uuid4().hex[:24]
        if not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{24}',ident):raise ValueError('Некорректный номер события.')
        doc={'id':ident,'title':text(event.get('title'),'Название',160),'from':start.isoformat(),'to':end.isoformat(),'kind':kind,'owner':text(event.get('owner',''),'Владелец',120,False),'note':text(event.get('note',''),'Заметка',2000,False),'ids':list(dict.fromkeys(ids)),'channel':channel,'product':text(event.get('product',''),'Продукт',200,False),'updated':now()}
        with self.store.connect() as db:
            if not db.execute('SELECT 1 FROM calendar_events WHERE id=?',(ident,)).fetchone() and db.execute('SELECT COUNT(*) FROM calendar_events').fetchone()[0]>=2000:raise ValueError('Доступно до 2000 событий календаря.')
            db.execute('INSERT OR REPLACE INTO calendar_events VALUES(?,?)',(ident,encoded(doc)))
        return doc

    def delete_event(self,ident):
        with self.store.connect() as db:db.execute('DELETE FROM calendar_events WHERE id=?',(ident,))
        return self.list()

    def events_for(self,start,end,members):
        result=[]
        for event in self.list()['events']:
            if event['from']>end or event['to']<start:continue
            if any((not event['ids'] or s['event']['id'] in event['ids']) and (not event['channel'] or s['meta']['channel']==event['channel']) and (not event['product'] or event['product'].casefold() in [p.casefold() for p in s['meta'].get('products',[])]) for s in members):result.append(event)
        return result

    def action(self,request):
        action=request.get('action');ident=request.get('id')
        if action=='save':return self.save(request.get('definition'),ident)
        if action=='open':return self.open(ident)
        if action=='run':return self.run(ident)
        if action=='delete':return self.delete(ident)
        if action=='export':return self.open(ident)['definition']
        if action=='import':return self.save(request.get('definition'))
        if action=='event.save':return self.save_event(request.get('event'))
        if action=='event.delete':return self.delete_event(ident)
        if action=='chart':
            d=self.open(ident)['definition'];index=request.get('index')
            if type(index) is not int or not 0<=index<len(d['charts']):raise ValueError('Выберите график сценария.')
            chart=d['charts'][index];data=self.engine.execute_saved(chart['spec'],chart['query']);data['visual']=chart['visual'];data['investigationSettings']={'mode':d['comparison']};data['scenarioQueries']=chart.get('queries',[]);return data
        raise ValueError('Неизвестное действие сценария.')
