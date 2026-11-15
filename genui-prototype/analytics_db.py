"""Indexed, transactional SQLite history. Standard library; no external service."""
import datetime as dt
import hashlib
import json
import re
import sqlite3
import uuid
from contextlib import contextmanager,closing
from pathlib import Path
from csv_data import DataError,record_key

SCHEMA=1
def encoded(value):return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'))

class AnalyticsStore:
    def __init__(self,directory):
        self.directory=Path(directory);self.directory.mkdir(parents=True,exist_ok=True);self.cache=self.directory/'analytics.sqlite3'
        with self.connect() as db:
            version=db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0,SCHEMA):raise DataError('Эта база создана более новой версией приложения. Обновите проект; база не изменена.')
            db.executescript('''CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,revision TEXT UNIQUE NOT NULL,document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records(key TEXT NOT NULL,valid_from INTEGER NOT NULL,valid_to INTEGER,
              channel TEXT NOT NULL,grain TEXT NOT NULL,date TEXT NOT NULL,survey_id INTEGER NOT NULL,status TEXT NOT NULL,rating INTEGER NOT NULL,
              events INTEGER NOT NULL,sends INTEGER NOT NULL,answers INTEGER NOT NULL,csi REAL,name TEXT,PRIMARY KEY(key,valid_from));
            CREATE INDEX IF NOT EXISTS records_scope_date ON records(channel,survey_id,date,valid_from,valid_to);
            CREATE INDEX IF NOT EXISTS records_date ON records(date,valid_from,valid_to);
            CREATE UNIQUE INDEX IF NOT EXISTS records_current_key ON records(key) WHERE valid_to IS NULL;
            CREATE TABLE IF NOT EXISTS import_errors(seq INTEGER PRIMARY KEY AUTOINCREMENT,document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chart_analyses(id TEXT PRIMARY KEY,revision TEXT NOT NULL REFERENCES revisions(revision) ON DELETE CASCADE,document TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS chart_analyses_revision ON chart_analyses(revision);''')
            db.execute('PRAGMA user_version=1')
        self._migrate()

    @contextmanager
    def connect(self):
        db=None
        try:
            db=sqlite3.connect(self.cache,timeout=15);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
            with db:yield db
        except sqlite3.Error as error:raise DataError('Ошибка SQLite: '+str(error)+'. База не перезаписана. Запустите DIAGNOSTICS.cmd.') from None
        finally:
            if db is not None:db.close()

    def _migrate(self):
        legacy=self.directory/'updates.json'
        with self.connect() as db:
            if db.execute('SELECT 1 FROM revisions LIMIT 1').fetchone() or not legacy.exists():return
            try:
                current=json.loads(legacy.read_text(encoding='utf-8-sig'))
                if current.get('version')!=1 or not isinstance(current.get('records'),list):raise ValueError('Неизвестный формат истории')
                documents=[]
                for revision in current.get('history',[])[-10:]:
                    if not re.fullmatch(r'[a-f0-9]{24}',revision):raise ValueError('Некорректная версия JSON-истории')
                    file=self.directory/'imports'/(revision+'.json')
                    if file.exists():documents.append(json.loads(file.read_text(encoding='utf-8-sig')))
                if not documents or documents[-1].get('revision')!=current.get('revision'):documents.append(current)
                for doc in documents:
                    rows=doc.get('records',[])
                    if not isinstance(rows,list):raise ValueError('Некорректные строки истории')
                    doc=dict(doc,revision=doc.get('revision') or uuid.uuid4().hex[:24],created=doc.get('created') or dt.datetime.now(dt.timezone.utc).isoformat(),reason=doc.get('reason','migration'),mode=doc.get('mode','merge'))
                    self._write(db,rows,doc)
                db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',('migration',encoded({'source':'updates.json','rows':len(current['records']),'time':dt.datetime.now(dt.timezone.utc).isoformat()})))
            except (ValueError,KeyError,TypeError,sqlite3.Error) as error:
                db.rollback();raise DataError('Миграция JSON в SQLite отменена: '+str(error)+'. Исходные JSON и CSV сохранены.') from None

    def _write(self,db,rows,document):
        doc={k:v for k,v in document.items() if k not in ('records','history')}
        seq=db.execute('INSERT INTO revisions(revision,document) VALUES(?,?)',(doc['revision'],encoded(doc))).lastrowid
        db.execute('CREATE TEMP TABLE IF NOT EXISTS incoming_keys(key TEXT PRIMARY KEY)');db.execute('DELETE FROM incoming_keys')
        old={r['key']:r for r in db.execute('SELECT * FROM records WHERE valid_to IS NULL')}
        added=changed=unchanged=0
        for row in rows:
            key=encoded(record_key(row));db.execute('INSERT OR IGNORE INTO incoming_keys VALUES(?)',(key,))
            values=(row['channel'],row['grain'],row['date'],row['id'],str(row['status']),-1 if row.get('rating') is None else row['rating'],row['events'],row['sends'],row['answers'],row.get('csi'),row.get('name'))
            prior=old.get(key)
            if prior and values==tuple(prior[k] for k in ('channel','grain','date','survey_id','status','rating','events','sends','answers','csi','name')):unchanged+=1;continue
            if prior:db.execute('UPDATE records SET valid_to=? WHERE key=? AND valid_to IS NULL',(seq,key));changed+=1
            else:added+=1
            db.execute('INSERT INTO records VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?)',(key,seq,*values))
        removed=db.execute('UPDATE records SET valid_to=? WHERE valid_to IS NULL AND NOT EXISTS(SELECT 1 FROM incoming_keys i WHERE i.key=records.key)',(seq,)).rowcount
        doc['storageChanges']={'inserted':added,'updated':changed,'unchanged':unchanged,'removed':removed}
        db.execute('UPDATE revisions SET document=? WHERE seq=?',(encoded(doc),seq));db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',('active',str(seq)))
        keep=[r[0] for r in db.execute('SELECT seq FROM revisions ORDER BY seq DESC LIMIT 10')]
        db.execute('DELETE FROM revisions WHERE seq<?',(min(keep),));db.execute('DELETE FROM records WHERE valid_to<=?',(min(keep),))
        return doc

    def load(self,include_records=True):
        with self.connect() as db:
            row=db.execute('SELECT * FROM revisions ORDER BY seq DESC LIMIT 1').fetchone()
            if row is None:return {'version':1,'records':[],'products':{},'history':[],'mode':'merge'}
            doc=json.loads(row['document']);doc['history']=[r[0] for r in db.execute('SELECT revision FROM revisions ORDER BY seq')]
        if include_records:doc['records']=self.records(doc['revision'])
        return doc

    def snapshot(self,revision,history=None,include_records=True):
        with self.connect() as db:row=db.execute('SELECT document FROM revisions WHERE revision=?',(revision,)).fetchone()
        if row is None:raise DataError('Версия данных недоступна в истории.')
        doc=json.loads(row[0])
        if include_records:doc['records']=self.records(revision)
        return doc

    def save_analysis(self,ident,analysis):
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO chart_analyses VALUES(?,?,?)',(ident,analysis['revision'],encoded(analysis)))

    def analysis(self,ident):
        if not isinstance(ident,str) or not re.fullmatch(r'[\w-]{32}',ident):return None
        with self.connect() as db:
            row=db.execute('SELECT document FROM chart_analyses WHERE id=?',(ident,)).fetchone()
        return json.loads(row[0]) if row else None

    def _selection(self,db,revision,keys=None,start=None,end=None):
        row=db.execute('SELECT seq FROM revisions WHERE revision=?',(revision,)).fetchone()
        if row is None:raise DataError('Версия данных недоступна в истории.')
        seq=row[0];where=['valid_from<=?','(valid_to IS NULL OR valid_to>?)'];args=[seq,seq]
        if keys is not None:
            db.execute('CREATE TEMP TABLE selected(channel TEXT,survey_id INTEGER,PRIMARY KEY(channel,survey_id))');db.executemany('INSERT OR IGNORE INTO selected VALUES(?,?)',keys)
            where.append('(channel,survey_id) IN(SELECT channel,survey_id FROM selected)')
        if start:where.append('date>=?');args.append(start)
        if end:where.append('date<=?');args.append(end)
        return ' AND '.join(where),args

    def records(self,revision=None,keys=None,start=None,end=None,limit=None):
        revision=revision or self.load(False).get('revision')
        if not revision:return []
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start,end)
            if limit is not None:
                if type(limit) is not int or limit<1:raise ValueError('Некорректный лимит чтения.')
                args.append(limit)
            rows=db.execute('SELECT * FROM records WHERE '+where+' ORDER BY date,channel,survey_id,status,rating'+(' LIMIT ?' if limit is not None else ''),args)
            return [self._row(r) for r in rows]

    def feedback_days(self,revision,start,end,policy,keys=None):
        policy_codes=','.join('?' for _ in policy)
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start,end)
            sql=f"""SELECT channel,survey_id,date,SUM(events) events,SUM(answers) answers,
                SUM(CASE WHEN channel='communication' THEN sends WHEN UPPER(status)='SENDED' THEN events ELSE 0 END) sends,
                SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events ELSE 0 END) csiSample,
                SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events*csi ELSE 0 END) csiWeight,
                SUM(CASE WHEN channel='communication' AND status='1002' THEN events END) stop,
                SUM(CASE WHEN channel='communication' AND status IN ({policy_codes}) THEN events END) contactPolicy
                FROM records WHERE {where} AND grain='day' GROUP BY channel,survey_id,date"""
            return [dict(row) for row in db.execute(sql,(*map(str,policy),*args))]

    def monitoring_records(self,revision,keys,start,end):
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start,end)
            rows=db.execute("""SELECT channel, 'day' grain, date, survey_id, status, -1 rating, csi, NULL name,
                SUM(events) events, SUM(sends) sends, SUM(answers) answers FROM records
                WHERE """+where+""" AND grain='day' GROUP BY channel,survey_id,date,status,csi""",args)
            return [self._row(row) for row in rows]

    def grains(self,revision,keys,start=None,end=None):
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start,end);result={}
            for row in db.execute('SELECT DISTINCT channel,survey_id,grain FROM records WHERE '+where,args):result.setdefault((row['channel'],row['survey_id']),[]).append(row['grain'])
        return {k:sorted(v) for k,v in result.items()}

    @staticmethod
    def _row(r):
        value={'channel':r['channel'],'grain':r['grain'],'date':r['date'],'id':r['survey_id'],'status':int(r['status']) if r['channel']=='communication' else r['status'],'rating':None if r['rating']==-1 else r['rating'],'events':r['events'],'sends':r['sends'],'answers':r['answers'],'csi':r['csi']}
        if r['name']:value['name']=r['name']
        return value

    def ranking(self,revision,keys,start,end,ranking,daily_only=False):
        # Expressions are a fixed allowlist; model text never becomes SQL.
        from metric_registry import POLICY
        expressions={
            'sends':"SUM(CASE WHEN channel='success_screen' THEN CASE WHEN UPPER(status)='SENDED' THEN events ELSE 0 END ELSE sends END)",
            'answers':'SUM(answers)','events':'SUM(events)',
            'csi':'1.0*SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events*csi ELSE 0 END)/NULLIF(SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events ELSE 0 END),0)',
            'stop':"SUM(CASE WHEN channel='communication' AND status='1002' THEN events END)",
            'contactPolicy':"SUM(CASE WHEN channel='communication' AND status IN ("+','.join("'"+str(n)+"'" for n in POLICY)+") THEN events END)"}
        metric=ranking['metric'];limit=ranking['limit']
        if metric not in expressions or type(limit) is not int or not 1<=limit<=500:raise ValueError('Некорректный рейтинг.')
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start,end)
            if daily_only:where+=" AND grain='day'"
            sample=",SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events ELSE 0 END) ratings" if metric=='csi' else ''
            rows=db.execute('SELECT channel,survey_id,COUNT(*) sourceRows,'+expressions[metric]+' value'+sample+' FROM records WHERE '+where+' GROUP BY channel,survey_id ORDER BY value DESC,channel,survey_id',args)
            observed=known=source_rows=0;winners=[]
            for row in rows:
                observed+=1;source_rows+=row['sourceRows']
                if row['value'] is not None:
                    known+=1
                    if len(winners)<limit:
                        winner={'channel':row['channel'],'id':row['survey_id'],'value':row['value']}
                        if metric=='csi':winner['ratings']=row['ratings']
                        winners.append(winner)
            return dict(ranking,winners=winners,observed=observed,eligible=known,sourceRows=source_rows,tieBreak='channel,id',identity='channel,id')

    def digest_records(self,revision,keys,start,end):
        import calendar
        year,month=map(int,end[:7].split('-'))
        first_month=start[:7] if start.endswith('-01') else start
        last_month=end[:7] if int(end[8:])==calendar.monthrange(year,month)[1] else (dt.date.fromisoformat(end).replace(day=1)-dt.timedelta(days=1)).strftime('%Y-%m')
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start[:7],end)
            rows=db.execute("""SELECT channel,'month' grain,substr(date,1,7) date,survey_id,status,rating,
                SUM(events) events,SUM(sends) sends,SUM(answers) answers,csi,MAX(name) name
                FROM records WHERE """+where+""" AND ((grain='day' AND date>=?) OR (grain='month' AND date>=? AND date<=?))
                GROUP BY channel,survey_id,substr(date,1,7),status,rating,csi""",(*args,start,first_month,last_month))
            return [self._row(row) for row in rows]

    def monthly_records(self,revision,keys,start,end):
        # Aggregate all matching rows in SQLite without loading source rows into Python.
        # Group by CSI as well: null/invalid ratings must never inflate valid CSI weights.
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,start,end)
            rows=db.execute("SELECT channel,'month' grain,substr(date,1,7) date,survey_id,status,rating,SUM(events) events,SUM(sends) sends,SUM(answers) answers,csi,MAX(name) name FROM records WHERE "+where+' GROUP BY channel,survey_id,substr(date,1,7),status,rating,csi ORDER BY date,channel,survey_id',args)
            return [self._row(r) for r in rows]

    def summary(self,revision=None):
        revision=revision or self.load(False).get('revision')
        if not revision:return []
        with self.connect() as db:
            where,args=self._selection(db,revision)
            rows=db.execute("SELECT channel,'month' grain,substr(date,1,7) date,survey_id,status,rating,SUM(events) events,SUM(sends) sends,SUM(answers) answers, SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events*csi ELSE 0 END)/NULLIF(SUM(CASE WHEN csi BETWEEN 1 AND 5 THEN events ELSE 0 END),0) csi,MAX(name) name FROM records WHERE "+where+' GROUP BY channel,survey_id,substr(date,1,7),status,rating',args)
            return [self._row(r) for r in rows]

    def last_daily(self,revision,keys,end=None):
        with self.connect() as db:
            where,args=self._selection(db,revision,keys,end=end)
            return db.execute("SELECT MAX(date) FROM records WHERE grain='day' AND "+where,args).fetchone()[0]

    def commit(self,records,products,reference,files,mode,fingerprint,report,reason='import',restored_from=None,hold=False):
        doc={'version':1,'products':products,'reference':reference,'revision':uuid.uuid4().hex[:24],'created':dt.datetime.now(dt.timezone.utc).isoformat(),'mode':mode,'fingerprint':fingerprint,'heldFingerprint':fingerprint if hold else None,'files':files,'report':report,'reason':reason,'restoredFrom':restored_from,'referenceHash':hashlib.sha256(encoded(reference).encode()).hexdigest()}
        with self.connect() as db:self._write(db,records,doc)
        return self.load(False)

    def error(self,message,files):
        with self.connect() as db:
            db.execute('INSERT INTO import_errors(document) VALUES(?)',(encoded({'time':dt.datetime.now(dt.timezone.utc).isoformat(),'message':message,'files':files}),));db.execute('DELETE FROM import_errors WHERE seq NOT IN(SELECT seq FROM import_errors ORDER BY seq DESC LIMIT 20)')

    def status(self):
        current=self.load(False)
        with self.connect() as db:
            versions=[{k:doc.get(k) for k in ('revision','created','mode','reason','restoredFrom','report','storageChanges')} for doc in (json.loads(r[0]) for r in db.execute('SELECT document FROM revisions ORDER BY seq DESC'))]
            errors=[json.loads(r[0]) for r in db.execute('SELECT document FROM import_errors ORDER BY seq')]
            rows=db.execute('SELECT COUNT(*) FROM records WHERE valid_to IS NULL').fetchone()[0]
        return {'revision':current.get('revision'),'mode':current.get('mode','merge'),'report':current.get('report'),'restoredHold':bool(current.get('heldFingerprint')),'versions':versions,'errors':errors,'retention':10,'files':current.get('files',[]),'storage':{'engine':'SQLite','schema':SCHEMA,'file':'.local-data/analytics.sqlite3','bytes':self.cache.stat().st_size,'activeRows':rows}}

    def check(self):
        with self.connect() as db:return db.execute('PRAGMA quick_check').fetchone()[0]

    def backup(self,destination):
        with self.connect() as source,closing(sqlite3.connect(destination)) as target:source.backup(target)
