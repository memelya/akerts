"""Transactional CSV imports and canonical query plans for the local application."""
import copy,hashlib,json,secrets,threading,time
import datetime as dt
from pathlib import Path
from csv_data import DataError,parse_csv,merge_records
from products import parse_products
from dashboard_model import build_state
from data_trust import TrustStore,REFERENCE_KEYS,quality_report
from analytics_db import AnalyticsStore
from genui_extended import select_surveys
from query_contract import compile_query,Clarification
from genui_extended import execute_query

FILES=(('push-sms.csv','communication'),('success-screen.csv','success_screen'))

class ImportProgress:
    """Прогресс первого (тяжёлого) импорта CSV для экрана загрузки. Читается без блокировки движка."""
    PHASES=(('read','Читаем CSV с диска'),('parse','Проверяем строки'),('merge','Объединяем с историей'),('quality','Сверяем качество данных'),('write','Записываем в локальную базу'),('build','Готовим показатели'))
    WEIGHTS={'read':4,'parse':30,'merge':6,'quality':7,'write':43,'build':10}
    DEFAULT_RATE=.6  # секунд на мегабайт CSV, пока нет собственного замера

    def __init__(self,directory):
        self.path=Path(directory)/'import-speed.json';self.guard=threading.Lock();self.state={'active':False}

    def rate(self):
        try:return max(.05,min(10.0,float(json.loads(self.path.read_text(encoding='utf-8'))['secondsPerMB'])))
        except (OSError,ValueError,KeyError,TypeError):return self.DEFAULT_RATE

    def begin(self,files,first_run):
        size=sum(f['size'] for f in files)
        with self.guard:self.state={'active':True,'started':time.time(),'phase':'read','fraction':0.0,'detail':'','files':files,'firstRun':first_run,'bytes':size,'estimate':round(size/1048576*self.rate(),1)}

    def phase(self,key,fraction=0.0,detail=''):
        with self.guard:
            if self.state.get('active'):self.state.update(phase=key,fraction=max(0.0,min(1.0,fraction)),detail=detail)

    def file(self,name,**values):
        with self.guard:
            for item in self.state.get('files',[]):
                if item['name']==name:item.update(values)

    def finish(self,error=None):
        with self.guard:
            state=self.state
            if not state.get('active'):return
            seconds=time.time()-state['started']
            self.state={'active':False,'finishedAt':time.time(),'seconds':round(seconds,1),'error':error,'files':state.get('files',[])}
        if not error and state.get('bytes',0)>2*1048576:
            try:self.path.write_text(json.dumps({'secondsPerMB':round(seconds/(state['bytes']/1048576),3)}),encoding='utf-8')
            except OSError:pass

    def snapshot(self):
        with self.guard:state=copy.deepcopy(self.state)
        if not state.get('active'):return state
        keys=[k for k,_ in self.PHASES];index=keys.index(state['phase']);total=sum(self.WEIGHTS.values())
        done=sum(self.WEIGHTS[k] for k in keys[:index])+self.WEIGHTS[state['phase']]*state['fraction']
        state.update(elapsed=round(time.time()-state['started'],1),percent=round(100*done/total,1),step=index+1,steps=len(keys),
                     label=dict(self.PHASES)[state['phase']],phases=[{'key':k,'label':l,'state':'done' if i<index else 'active' if i==index else 'wait'} for i,(k,l) in enumerate(self.PHASES)])
        return state

class Engine:
    def __init__(self,root):
        self.root=Path(root);self.directory=self.root/'.local-data';self.directory.mkdir(parents=True,exist_ok=True)
        baseline_file=self.directory/'baseline.json';text=baseline_file.read_text(encoding='utf-8-sig').strip() if baseline_file.exists() else ''
        self.baseline=json.loads(text) if text else {'version':1,'months':[],'surveys':[],'daily':[],'ranks':{},'statusDescriptions':{},'surveyTypes':{},'triggerGroups':{},'management':{'period':None,'issueIds':[],'rows':[]}}
        reference_file=self.directory/'reference.json'
        if reference_file.exists():
            reference=json.loads(reference_file.read_text(encoding='utf-8-sig'))
            if reference.get('version')!=1:raise DataError('Неизвестный формат справочника reference.json')
            self.baseline.update({key:reference.get(key,{}) for key in REFERENCE_KEYS})
        self.store=AnalyticsStore(self.directory);self.cache=self.store.cache;self.lock=threading.RLock();self.progress=ImportProgress(self.directory);self.plans={};self.previews={};self.analyses={};self.cache_error=None
        try:self.document=self.store.load(False)
        except (ValueError,OSError,TypeError) as error:
            self.document={'version':1,'records':[],'products':{}};self.cache_error='Не удалось прочитать .local-data/updates.json: '+str(error)+'. Сохранённый файл не перезаписан.'
        self.signature=None;self.fingerprint=self.document.get('fingerprint');self.state=self._build(self.store.summary(),self.document.get('products',{}),self.document.get('reference'))
        self.status={'files':self.document.get('files',[]),'error':self.cache_error}
        from workflows import Workflows
        self.workflows=Workflows(self)
        from committee import Committee
        self.committee=Committee(self)
        from ai_agent import Agent
        self.agent=Agent(self)
        from chart_assistant import ChartAssistant
        self.chart_assistant=ChartAssistant(self)

    @property
    def updates(self):return self.store.records()

    def full_state(self):
        return self._build(self.updates,self.document.get('products',{}),self.document.get('reference'))

    def _signature(self):
        values=[]
        for name in ('push-sms.csv','success-screen.csv','products.csv'):
            file=self.root/'date'/name;stat=file.stat() if file.exists() else None
            values.append((name,stat.st_size if stat else None,stat.st_mtime_ns if stat else None))
        return tuple(values)

    def _build(self,records,products,reference=None):
        base=copy.deepcopy(self.baseline)
        if reference:base.update(reference)
        state=build_state(base,records);state['rawRecords']=records;state['productNames']=sorted({p for values in products.values() for p in values})
        for survey in state['surveys']:survey['meta']['products']=products.get(str(survey['event']['id']),['без продукта'])
        return state

    def _read(self):
        digest=hashlib.sha256();documents=[];files=[]
        for name,channel in (*FILES,('products.csv','reference')):
            file=self.root/'date'/name;raw=file.read_bytes() if file.exists() else b'';stat=file.stat() if file.exists() else None
            digest.update(name.encode());digest.update(raw);digest.update(str(stat.st_mtime_ns if stat else '').encode())
            documents.append((name,channel,raw));files.append({'file':'date/'+name,'rows':0,'modified':dt.datetime.fromtimestamp(stat.st_mtime).strftime('%d.%m.%Y %H:%M:%S') if stat else 'файл не найден'})
        return documents,files,digest.hexdigest()

    def _candidate(self,mode,progress=None):
        if mode not in ('merge','replace'):raise DataError('Режим загрузки: merge или replace.')
        if self.cache_error:raise DataError(self.cache_error)
        track=progress.phase if progress else (lambda *a,**k:None);note=progress.file if progress else (lambda *a,**k:None)
        signature=self._signature();documents,files,fingerprint=self._read();incoming=[];products={}
        sizes={name:max(1,len(raw)) for name,channel,raw in documents if channel!='reference'};total=sum(sizes.values());passed=0
        track('parse',0.0)
        for index,(name,channel,raw) in enumerate(documents):
            if channel=='reference':
                products,count=parse_products(raw);files[index]['rows']=count;note(name,rows=count,done=True)
            else:
                share=sizes[name]/total;base=passed/total
                def report(fraction,rows,name=name,base=base,share=share):
                    note(name,rows=rows,fraction=fraction);track('parse',base+share*fraction,name)
                note(name,active=True)
                rows,stats=parse_csv(raw,channel,'date/'+name,report if progress else None);incoming.extend(rows);files[index].update(stats)
                passed+=sizes[name];note(name,rows=len(rows),fraction=1,done=True,active=False)
        track('merge',0.0,'строк: '+format(len(incoming),',').replace(',','\u00a0'))
        previous=self.updates
        records=merge_records(previous if mode=='merge' else [],incoming)
        track('quality',0.0)
        reference={key:self.baseline.get(key,{}) for key in REFERENCE_KEYS}
        report=quality_report(previous,records,self.document.get('products',{}),products,files,reference,incoming)
        if signature!=self._signature():raise DataError('CSV изменился во время чтения. Сохраните файл и повторите загрузку.')
        return {'records':records,'products':products,'reference':reference,'files':files,'fingerprint':fingerprint,'report':report,'mode':mode,'signature':signature}

    def _commit(self,candidate,reason='import',restored_from=None,hold=False,progress=None):
        write=(lambda fraction,detail='':progress.phase('write',fraction,detail)) if progress else None
        if progress:progress.phase('write',0.0,'строк: '+format(len(candidate['records']),',').replace(',','\u00a0'))
        document=self.store.commit(**{k:candidate[k] for k in ('records','products','reference','files','mode','fingerprint','report')},reason=reason,restored_from=restored_from,hold=hold,progress=write)
        if progress:progress.phase('build',0.0)
        self.document=document;self.state=self._build(self.store.summary(),candidate['products'],candidate['reference']);self.fingerprint=candidate['fingerprint'];self.signature=candidate.get('signature');self.cache_error=None
        self.status={'files':candidate['files'],'error':None}
        if progress:progress.phase('build',.5,'пересчитываем мониторинг')
        self.workflows.recalculate_all()
        return document

    def needs_import(self):
        """Быстрая проверка без чтения CSV: изменились ли размеры или даты файлов с последней сверки."""
        try:return self.signature!=self._signature()
        except OSError:return True

    def importing(self):
        return bool(self.progress.state.get('active'))

    def refresh(self):
        with self.lock:
            try:
                signature=self._signature()
                if self.signature==signature:return self.state,self.status
                _,files,fingerprint=self._read()
                if self.fingerprint==fingerprint:self.signature=signature;return self.state,self.status
                progress=self.progress
                progress.begin([{'name':f['file'].split('/')[-1],'size':(self.root/f['file']).stat().st_size if (self.root/f['file']).exists() else 0,'rows':0,'done':False} for f in files],not self.document.get('revision'))
                candidate=self._candidate(self.document.get('mode','merge'),progress)
                if candidate['mode']=='replace' and self.document.get('report',{}).get('recordCount') and not candidate['records']:raise DataError('Пустая полная замена требует просмотра в центре качества данных. Текущая версия сохранена.')
                if candidate['records'] or candidate['products'] or self.document.get('revision'):self._commit(candidate,progress=progress)
                else:
                    self.state=self._build([],candidate['products'],candidate['reference']);self.fingerprint=fingerprint;self.signature=signature;self.status={'files':candidate['files'],'error':None}
                progress.finish()
            except (ValueError,OSError,KeyError,TypeError) as error:
                self.progress.finish(str(error))
                self.status={'files':locals().get('files',[]),'error':str(error)}
                try:self.store.error(str(error),self.status['files'])
                except OSError:pass
                try:self.fingerprint=self._read()[2];self.signature=self._signature()
                except OSError:self.fingerprint=None
            return self.state,self.status

    def preview_import(self,mode):
        with self.lock:
            try:candidate=self._candidate(mode)
            except (ValueError,OSError) as error:
                try:self.store.error(str(error),[])
                except OSError:pass
                raise
            token=secrets.token_urlsafe(24)
            self.previews={token:{'fingerprint':candidate['fingerprint'],'revision':self.document.get('revision'),'mode':mode,'time':time.monotonic()}}
            return {'token':token,'mode':mode,'report':candidate['report'],'files':candidate['files'],'message':'Предварительный расчёт. Данные ещё не изменены.'}

    def apply_import(self,token):
        with self.lock:
            preview=self.previews.get(token)
            if not preview or time.monotonic()-preview['time']>300:raise DataError('Предпросмотр устарел. Выполните проверку ещё раз.')
            candidate=self._candidate(preview['mode'])
            if candidate['fingerprint']!=preview['fingerprint'] or self.document.get('revision')!=preview['revision']:raise DataError('CSV или версия данных изменились. Повторите предпросмотр.')
            self._commit(candidate,reason='manual');self.previews.clear();return self.store.status()

    def restore(self,revision):
        with self.lock:
            doc=self.store.snapshot(revision);_,_,fingerprint=self._read();reference=doc.get('reference') or {k:self.baseline.get(k,{}) for k in REFERENCE_KEYS};products=doc.get('products',{})
            report=quality_report(self.updates,doc['records'],self.document.get('products',{}),products,doc.get('files',[]),reference)
            report['issues'].insert(0,'Восстановлена версия '+revision+'. CSV на диске не изменены. Они будут импортированы после изменения файлов или явного применения предпросмотра.')
            candidate={'records':doc['records'],'products':products,'reference':reference,'files':doc.get('files',[]),'mode':doc.get('mode','merge'),'fingerprint':fingerprint,'report':report}
            self._commit(candidate,reason='restore',restored_from=revision,hold=True);return self.store.status()

    def prepare(self,request):
        request=dict(request);request.pop('targetBrief',None)
        if request.get('source','local')!='local':raise DataError('Доступны только CSV из папки date.')
        with self.lock:
            state,status=self.refresh()
            revision=self.document.get('revision')
        if status.get('error') or not state['surveys']:
            error=DataError(status.get('error') or 'Данные ещё не загружены. Добавьте выгрузки в папку date.')
            error.code='data_import' if status.get('error') else 'no_data'
            raise error
        from agent_routing import needs_agent
        from query_contract import normalize_text
        query=normalize_text(request.get('query'));provider=request.get('provider','local')
        if provider not in ('auto','local','gigacode'):raise DataError('Неизвестный обработчик запроса.')
        import re
        from target_plan import target_from_query,prepare_target
        target=target_from_query(query)
        if target:
            brief=prepare_target(self,dict(request,query=query),state,revision,target)
            return self.agent.start(dict(request,query=query,mode='creative',targetBrief=brief),state,revision)
        if re.search(r'(?:созда|придума|сгенери|сдела)[а-я]*.*нов[а-я]*\s+(?:визуализац|интерфейс|ui)',query,re.I):request=dict(request,mode='creative')
        if request.get('mode')=='creative' and request.get('previous') and re.fullmatch(r'добавь\s+csi(?:\s+и\s+объедини(?:\s+на\s+одном\s+графике)?)?[.!]?',query,re.I):
            from model_policy import profile
            from genui_query import validate_spec
            from creative_plan import proposal
            from creative_ui import VIS_METRICS
            previous=validate_spec(request['previous'])
            if profile(self.root)=='protected' and previous['ids'] and not previous.get('series') and not previous.get('plan') and all(metric in VIS_METRICS for metric in previous['metrics']):
                scope={'ids':previous['ids'],**previous.get('filters',{})}
                raw={'analysis':{'kind':'workspace','title':'Динамика опросов · CSI и текущие показатели','scope':scope,
                                 'period':{'grain':'month','months':1,'comparison':'previous'},'goal':'investigate','maxItems':5},
                     'metrics':['csi'],'includeTrend':True}
                brief=proposal(raw,{'query':query,'state':state,'previousChart':previous},VIS_METRICS)
                return self.agent.start(dict(request,query=query,chartBrief=brief),state,revision)
        from creative_plan import requested_ranking
        ranking=requested_ranking(query)
        if ranking and provider!='gigacode' and request.get('mode')!='creative':
            from creative_plan import temporal
            from genui_query import bind_explicit_chart_request
            from genui_extended import requested_group
            from products import product_from_query
            import calendar
            from datetime import date,timedelta
            filters={}
            if re.search(r'пуш|смс',query,re.I):filters['channel']='communication'
            if re.search(r'экран',query,re.I):filters['channel']='success_screen'
            if product:=product_from_query(query,state.get('productNames',[])):filters['product']=product
            if group:=requested_group(query):filters['triggerGroup']=group
            if re.search(r'триггерн',query,re.I):filters['type']='Триггерный'
            if re.search(r'приоритет\w*\s+топ',query,re.I):filters['top']=True
            members=select_surveys(state,{'filters':filters})
            keys=[(s['meta']['channel'],s['event']['id']) for s in members]
            if not keys:raise Clarification('В выбранном отборе нет опросов.')
            period=temporal(query) or {}
            bound,_=bind_explicit_chart_request({},query)
            last=max(m for s in members for m in s['meta']['availableMonths'])
            end_month=bound.get('endMonth') or period.get('endMonth') or last
            y,m=map(int,end_month.split('-'))
            n=y*12+m-period.get('months',3)
            start=bound.get('startDate') or bound.get('startMonth') or period.get('startMonth') or f'{n//12:04d}-{n%12+1:02d}'
            end=bound.get('endDate') or f'{end_month}-{calendar.monthrange(y,m)[1]:02d}'
            if period.get('grain')=='day' and not bound.get('startDate'):
                end=self.store.last_daily(revision,keys)
                if not end:raise Clarification('Для рейтинга по дням нужны дневные строки.')
                start=(date.fromisoformat(end)-timedelta(days=period['days']-1)).isoformat()
            if start>end:raise Clarification('Конец периода должен быть не раньше начала.')
            plan=self.remember_plan({'kind':'ranking-plan','ranking':ranking,'keys':keys,'start':start,'end':end,
                                     'dailyOnly':period.get('grain')=='day' or bool(bound.get('startDate')),
                                     'filters':filters,'provider':provider,'planner':'rules','interpretation':'Рейтинг по выбранному показателю'},revision)
            return {key:value for key,value in plan.items() if key!='keys'}
        if ranking:request=dict(request,mode='creative')
        complex_query=needs_agent(query,request.get('previousAgent'),state.get('productNames',[]))
        if request.get('mode')=='creative' and provider=='local':raise Clarification('Новая визуализация требует модели. Выберите Авто или GigaCode CLI.')
        if provider in ('gigacode','auto') and (complex_query or request.get('mode')=='creative'):
            return self.agent.start(dict(request,query=query),state,revision)
        if provider=='local' and complex_query:
            raise Clarification('Для исследования, качественного поиска и мониторинга выберите Авто или GigaCode CLI. Локальные правила не заменяют модель.')
        contract=compile_query(self.root,query,request.get('previous'),state,provider,lambda spec:self.query_state(spec,revision))
        return self.remember_plan(contract,revision)

    def remember_plan(self,contract,revision):
        token=secrets.token_urlsafe(24)
        with self.lock:
            self.plans={k:v for k,v in self.plans.items() if time.monotonic()-v['time']<300}
            if len(self.plans)>=40:self.plans.pop(next(iter(self.plans)))
            self.plans[token]={'contract':contract,'revision':revision,'time':time.monotonic()}
        return dict(contract,planId=token,dataRevision=revision)

    def run(self,request):
        plan_id=request.get('planId')
        if not plan_id:
            prepared=self.prepare(request)
            if prepared.get('kind')=='agent-job':return prepared
            plan_id=prepared['planId']
        with self.lock:
            plan=self.plans.get(plan_id)
            if not plan or time.monotonic()-plan['time']>300:raise DataError('План запроса устарел. Повторите запрос.')
            state,status=self.refresh()
            if status.get('error'):raise DataError(status['error'])
            if self.document.get('revision')!=plan['revision']:raise DataError('Данные изменились после понимания запроса. Повторите запрос для новой версии.')
            contract=plan['contract']
            if contract.get('kind')=='ranking-plan':
                from metric_registry import LABELS
                ranking=self.store.ranking(plan['revision'],contract['keys'],contract['start'],contract['end'],contract['ranking'],contract['dailyOnly'])
                names={(s['meta']['channel'],s['event']['id']):s['meta']['name'] for s in state['surveys']}
                for item in ranking['winners']:item['name']=names[(item['channel'],item['id'])]
                metric=ranking['metric']
                return {'kind':'local-ranking','ranking':ranking,'label':LABELS[metric],
                        'periodLabel':contract['start']+('-01' if len(contract['start'])==7 else '')+' — '+contract['end'],'dataRevision':plan['revision'],
                        'spec':{'ids':[],'metrics':[metric],'filters':contract['filters'],'layout':'separate'},
                        'totals':[],'months':[],'blocks':[]}
            if 'chartEdits' in request:
                from query_contract import describe_chart
                from genui_query import validate_spec
                edited=request['chartEdits']
                fields={'ids','metrics','channel','grain','startMonth','endMonth','monthsCount'}
                if not isinstance(edited,dict) or not fields<=set(edited) or set(edited)-fields-{'startDate','endDate'}:
                    raise DataError('Некорректные изменения плана.')
                original=contract['spec'];spec=copy.deepcopy(original)
                spec.update({key:edited[key] for key in ('ids','metrics','grain','monthsCount')})
                for key in ('startMonth','endMonth','startDate','endDate'):
                    if edited.get(key):spec[key]=edited[key]
                    else:spec.pop(key,None)
                filters=spec.get('filters',{})
                if edited['channel']:filters['channel']=edited['channel']
                else:filters.pop('channel',None)
                if filters:spec['filters']=filters
                else:spec.pop('filters',None)
                if spec['grain']!='day' or edited.get('startDate') or any(edited[key]!=original.get(key,'') for key in ('startMonth','endMonth')):
                    spec.pop('daysCount',None)
                if any(spec[key]!=original[key] for key in ('ids','metrics')):spec.pop('series',None)
                if 'plan' not in spec['metrics']:spec.pop('plan',None)
                spec=validate_spec(spec)
                contract=describe_chart(contract['query'],spec,state,contract['provider'],contract['planner'],lambda s:self.query_state(s,plan['revision']))
                contract['editedByUser']={'grain':'month',**spec}!={'grain':'month',**original}
            state=self.query_state(contract['spec'],plan['revision'])
            result=execute_query(state,contract['spec'],'Ваши CSV · date/push-sms.csv и date/success-screen.csv')
            return self.register_result(result,contract,plan['revision'])

    def register_result(self,result,contract,revision,register=True):
        result['provider']=contract['provider'];result['contract']=dict(contract,resolvedPeriod=result['periodLabel'],dataRevision=revision)
        if register:
            analysis_id=secrets.token_urlsafe(24);self.analyses[analysis_id]={'revision':revision,'spec':contract['spec'],'blocks':[{k:b.get(k) for k in ('id','metric','values')} for b in result['blocks']],'months':result['months'],'periods':result.get('periods',[])}
            if contract['provider']=='gigacode' or contract['spec'].get('grain')=='week':
                from workflows import compact
                self.analyses[analysis_id]['reportChart']=compact(result)
            if len(self.analyses)>40:self.analyses.pop(next(iter(self.analyses)))
            result['analysisId']=analysis_id
        return result

    def retain_analysis(self,analysis_id):
        with self.lock:
            analysis=self.analyses.get(analysis_id)
            if not analysis or not analysis['revision']:return {'saved':False}
            self.store.save_analysis(analysis_id,analysis)
            return {'saved':True}

    def execute_saved(self,spec,query='',register=True):
        from genui_query import validate_spec
        spec=validate_spec(copy.deepcopy(spec));members=select_surveys(self.state,spec)
        if not members:raise ValueError('Нет загруженных данных по условиям сценария. Предыдущий успешный результат сохранён.')
        if spec['ids'] and len({s['event']['id'] for s in members})<len(members):raise ValueError('ID сценария встречается в обоих каналах. Укажите канал и сохраните сценарий заново.')
        if set(spec['ids'])-{s['event']['id'] for s in members}:raise ValueError('Часть опросов сценария отсутствует в текущей выгрузке. Предыдущий результат сохранён.')
        revision=self.document.get('revision');result=execute_query(self.query_state(spec,revision),spec,'Ваши CSV · сохранённый сценарий')
        return self.register_result(result,{'provider':'local','planner':'scenario','spec':spec,'interpretation':query or 'Сохранённые параметры сценария'},revision,register)

    def investigate(self,request):
        from investigation import investigate
        with self.lock:
            analysis=self.analyses.get(request.get('analysisId')) or self.store.analysis(request.get('analysisId'))
            if not analysis:raise ValueError('Откройте график заново: контекст расследования недоступен после перезапуска.')
            if request.get('action')=='chart':
                from investigation import METRICS
                period=request.get('period');ident=request.get('id');channel=request.get('channel');metric=request.get('metric')
                if period not in analysis['months'] or metric not in METRICS:raise ValueError('Выберите период и показатель расследования.')
                document=self.store.snapshot(analysis['revision'],include_records=False)
                state=self._build(self.store.summary(analysis['revision']),document.get('products',{}),document.get('reference'))
                members=[s for s in select_surveys(state,analysis['spec']) if s['event']['id']==ident and s['meta']['channel']==channel]
                if not members:raise ValueError('Опрос отсутствует в отборе расследования.')
                month=period[:7];rows=self.store.records(analysis['revision'],[(channel,ident)],month,month+'-31')
                spec={'ids':[ident],'metrics':[metric],'monthsCount':1,'layout':'separate','startMonth':month,'endMonth':month,'filters':{'channel':channel}}
                window=next((item for item in analysis.get('periods',[]) if item['start']==period),None) if analysis['spec'].get('grain')=='week' else None
                if window:
                    rows=self.store.records(analysis['revision'],[(channel,ident)],period,window['end'])
                    spec.pop('startMonth');spec.pop('endMonth');spec.update(grain='day',startDate=period,endDate=window['end'])
                elif any(r['grain']=='day' for r in rows):spec['grain']='day'
                state=dict(state,surveys=members,rawRecords=rows)
                result=execute_query(state,spec,'Зафиксированная версия расследования')
                return self.register_result(result,{'provider':'local','planner':'investigation','spec':spec,'interpretation':'Детализация опроса '+str(ident)},analysis['revision'])
            return investigate(self,analysis,request.get('period'),request.get('mode','aligned'),request.get('metric','sends'))

    def workflow_action(self,request):
        with self.lock:
            if request.get('action') in ('save','run','import','chart'):
                _,status=self.refresh()
                if status.get('error') and request.get('action') in ('run','chart'):raise ValueError(status['error'])
            return self.workflows.action(request)

    def query_state(self,spec,revision,state=None):
        from datetime import date,timedelta
        state=self.state if state is None else state
        selected=select_surveys(state,spec);keys=[(s['meta']['channel'],s['event']['id']) for s in selected]
        last=max((m for s in selected for m in s['meta']['availableMonths']),default=None)
        weekly_latest=None
        if spec.get('grain')=='week' and keys:
            from weekly_query import bounds
            weekly_latest=self.store.last_daily(revision,keys)
            start,end=(day.isoformat() for day in bounds(spec,weekly_latest))
        elif spec.get('grain')=='day':
            anchor=self.store.last_daily(revision,keys)
            if spec.get('startDate'):
                start,end=spec['startDate'],spec['endDate']
            elif spec.get('daysCount') and anchor:
                end=anchor;start=(date.fromisoformat(end)-timedelta(days=spec['daysCount']-1)).isoformat()
            else:start=(spec.get('startMonth') or (anchor or last or '')[:7]);end=spec.get('endMonth') or start;end+='-31'
        else:
            end=spec.get('endMonth') or last
            if not end:return dict(state,rawRecords=[])
            y,m=map(int,end.split('-'));n=y*12+m-spec['monthsCount']
            start=spec.get('startMonth') or f'{n//12:04d}-{n%12+1:02d}';end+='-31'
        records=self.store.records(revision,keys,start,end)
        surveys=state['surveys']
        if spec.get('ids'):
            from collections import Counter
            counts=Counter(s['event']['id'] for s in selected);present={(r['channel'],r['id']) for r in records}
            surveys=[s for s in surveys if counts[s['event']['id']]<2 or (s['meta']['channel'],s['event']['id']) in present]
        return dict(state,surveys=surveys,rawRecords=records,weeklyLatest=weekly_latest)

    def evidence(self,analysis_id,series,period,saved=None):
        from metric_evidence import evidence
        with self.lock:
            analysis=self.analyses.get(analysis_id) or self.store.analysis(analysis_id)
            if not analysis:
                from genui_query import validate_spec
                if not isinstance(saved,dict):raise DataError('Откройте сохранённый график и повторите сверку.')
                revision=saved.get('revision')
                if not isinstance(revision,str):raise DataError('В сохранённом графике нет версии данных для сверки.')
                spec=validate_spec(saved.get('spec'))
                document=self.store.snapshot(revision,include_records=False)
                state=self._build(self.store.summary(revision),document.get('products',{}),document.get('reference'))
                result=execute_query(self.query_state(spec,revision,state),spec,'Зафиксированная версия данных',False)
                if period not in result['months'] or type(series) is not int or not 0<=series<len(result['blocks']):
                    raise DataError('Сохранённый ряд отсутствует в исходной версии данных.')
                block=result['blocks'][series]
                if (block['id'],block['metric'],block['values'][result['months'].index(period)])!=(saved.get('id'),saved.get('metric'),saved.get('value')):
                    raise DataError('Сохранённая цифра отличается от пересчёта исходной версии.')
                analysis={'revision':revision,'spec':spec,'blocks':result['blocks'],'months':result['months'],'periods':result.get('periods',[])}
            if period not in analysis['months']:raise DataError('Период отсутствует на этом графике.')
            document=self.store.snapshot(analysis['revision'],include_records=False) if analysis['revision'] else self.document
            state=self._build(self.store.summary(analysis['revision']),document.get('products',{}),document.get('reference'))
            keys=[(s['meta']['channel'],s['event']['id']) for s in select_surveys(state,analysis['spec'])]
            window=next((item for item in analysis['periods'] if item['start']==period),None)
            state['rawRecords']=self.store.records(analysis['revision'],keys,period,window['end'] if window else period if len(period)==10 else period+'-31')
            return evidence(analysis,state,series,period,document)
