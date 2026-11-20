"""Atomic local dataset revisions, import differences and quality reports."""
import copy,datetime as dt,hashlib,json,os,re,uuid
from collections import defaultdict
from pathlib import Path
from csv_data import DataError,record_key

REFERENCE_KEYS=('surveyCatalog','ranks','statusDescriptions','surveyTypes','triggerGroups')

def atomic_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix('.tmp')
    with temporary.open('w',encoding='utf-8',newline='\n') as stream:
        json.dump(value,stream,ensure_ascii=False,allow_nan=False,separators=(',',':'));stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)

def quality_report(previous,records,old_products,products,files,reference,incoming=None):
    # Один проход по строкам: на миллионе строк каждый лишний проход стоит секунды.
    if previous:
        before={record_key(r):r for r in previous};after={record_key(r):r for r in records}
        shared=before.keys()&after.keys();updated=sum(before[k]!=after[k] for k in shared)
        added,removed,unchanged=len(after.keys()-before.keys()),len(before.keys()-after.keys()),len(shared)-updated
    else:added,removed,updated,unchanged=len({record_key(r) for r in records}),0,0,0
    changes={'added':added,'removed':removed,'updated':updated,'unchanged':unchanged,
             'productLinksChanged':sum(old_products.get(k)!=products.get(k) for k in set(old_products)|set(products))}
    days=defaultdict(set);channels=defaultdict(set);catalog=reference.get('surveyCatalog',{})
    ids=set();no_product=set();mismatched=set();zero=daily=monthly=0;first_date=last_date=None
    for row in records:
        ident=row['id'];channel=row['channel'];date=row['date']
        if ident not in ids:
            ids.add(ident);linked=products.get(str(ident))
            if not linked or linked==['без продукта']:no_product.add(ident)
        channels[channel].add(ident)
        if catalog.get(str(ident),{}).get('channel',channel)!=channel:mismatched.add(ident)
        if row['grain']=='day':daily+=1;days[(channel,ident)].add(date)
        elif row['grain']=='month':monthly+=1
        if row.get('csi')==0:zero+=1
        if first_date is None or date<first_date:first_date=date
        if last_date is None or date>last_date:last_date=date
    gaps=[]
    for (channel,ident),dates in days.items():
        first,last=min(dates),max(dates);count=(dt.date.fromisoformat(last)-dt.date.fromisoformat(first)).days+1-len(dates)
        if count:gaps.append({'id':ident,'channel':channel,'from':first,'to':last,'unobservedDays':count})
    duplicates=sum(f.get('duplicates',0) for f in files)
    product_rows=next((f.get('rows',0) for f in files if f['file'].endswith('products.csv')),0)
    product_duplicates=max(0,product_rows-sum(len(v) for v in products.values()))
    mismatches=sorted(mismatched)
    cross=sorted(channels['communication']&channels['success_screen'])
    issues=[]
    if duplicates:issues.append('Повторяющихся ключей строк: %s. Для одинакового ключа принята последняя строка.'%duplicates)
    if product_duplicates:issues.append('Повторяющихся связей опрос → продукт: %s. Связь учтена один раз.'%product_duplicates)
    if gaps:issues.append('У %s опросов есть дни без строк внутри наблюдаемого интервала. Это не доказывает ошибку выгрузки; выходные также включены.'%len(gaps))
    if mismatches:issues.append('Канал CSV отличается от справочника у %s ID. Используется канал файла; данные каналов разделены.'%len(mismatches))
    if cross:issues.append('%s ID встречаются в обоих каналах. Для запроса конкретного ID потребуется выбрать канал.'%len(cross))
    if zero:issues.append('Строк с оценкой 0: %s. Ответы сохранены; строки исключены из CSI.'%zero)
    from_history=bool(records and incoming is not None and not incoming)
    if from_history:issues.insert(0,'Текущие CSV не содержат строк событий. Используется сохранённая локальная история.')
    return {'changes':changes,'recordCount':len(records),'surveyIds':len(ids),
            'dailyRows':daily,'monthlyRows':monthly,'from':first_date,'to':last_date,
            'duplicates':duplicates,'productDuplicates':product_duplicates,'withoutProduct':len(no_product),
            'zeroRatingRows':zero,'gapCount':len(gaps),'gaps':sorted(gaps,key=lambda g:g['unobservedDays'],reverse=True)[:30],
            'channelMismatches':mismatches[:30],'crossChannelIds':cross[:30],'fromHistory':from_history,'issues':issues}

class TrustStore:
    def __init__(self,directory):
        self.directory=Path(directory);self.cache=self.directory/'updates.json';self.snapshots=self.directory/'imports'
    def load(self):
        if not self.cache.exists():return {'version':1,'records':[],'products':{},'history':[],'mode':'merge'}
        value=json.loads(self.cache.read_text(encoding='utf-8'))
        if value.get('version')!=1 or not isinstance(value.get('records'),list):raise DataError('Неизвестный формат локальной истории')
        return value
    def snapshot(self,revision,history=None):
        if not isinstance(revision,str) or not re.fullmatch(r'[a-f0-9]{24}',revision):raise DataError('Некорректная версия данных.')
        allowed=self.load().get('history',[]) if history is None else history
        if revision not in allowed:raise DataError('Версия данных недоступна в истории.')
        return json.loads((self.snapshots/(revision+'.json')).read_text(encoding='utf-8'))
    def commit(self,records,products,reference,files,mode,fingerprint,report,reason='import',restored_from=None,hold=False):
        current=self.load();history=list(current.get('history',[]))
        if current.get('records') and not current.get('revision'):
            migrated=dict(current,revision=uuid.uuid4().hex[:24],created=dt.datetime.now(dt.timezone.utc).isoformat(),reason='migration',mode='merge',files=[],report={'recordCount':len(current['records']),'issues':['Сохранённая история предыдущей версии проекта.']})
            atomic_json(self.snapshots/(migrated['revision']+'.json'),migrated);history.append(migrated['revision'])
        revision=uuid.uuid4().hex[:24]
        document={'version':1,'records':records,'products':products,'reference':reference,'revision':revision,
                  'created':dt.datetime.now(dt.timezone.utc).isoformat(),'mode':mode,'fingerprint':fingerprint,
                  'heldFingerprint':fingerprint if hold else None,'files':files,'report':report,'reason':reason,
                  'restoredFrom':restored_from,'referenceHash':hashlib.sha256(json.dumps(reference,sort_keys=True,ensure_ascii=False).encode()).hexdigest(),
                  'history':(history+[revision])[-10:]}
        atomic_json(self.snapshots/(revision+'.json'),document)
        if self.cache.exists():atomic_json(self.cache.with_suffix('.json.bak'),current)
        atomic_json(self.cache,document)
        # Only generated, unreferenced snapshot files inside this store are pruned.
        allowed=set(document['history'])
        for file in self.snapshots.glob('*.json'):
            if re.fullmatch(r'[a-f0-9]{24}',file.stem) and file.stem not in allowed and file.resolve().parent==self.snapshots.resolve():file.unlink(missing_ok=True)
        return document
    def error(self,message,files):
        path=self.directory/'import-errors.json'
        try:rows=json.loads(path.read_text(encoding='utf-8')) if path.exists() else []
        except (ValueError,OSError):rows=[]
        atomic_json(path,(rows+[{'time':dt.datetime.now(dt.timezone.utc).isoformat(),'message':message,'files':files}])[-20:])
    def status(self):
        current=self.load();versions=[]
        for revision in reversed(current.get('history',[])):
            try:
                doc=self.snapshot(revision,current.get('history',[]))
                versions.append({k:doc.get(k) for k in ('revision','created','mode','reason','restoredFrom','report')})
            except (ValueError,OSError):continue
        errors=self.directory/'import-errors.json'
        return {'revision':current.get('revision'),'mode':current.get('mode','merge'),'report':current.get('report'),
                'restoredHold':bool(current.get('heldFingerprint')),'versions':versions,
                'errors':json.loads(errors.read_text(encoding='utf-8')) if errors.exists() else [],
                'retention':10,'files':current.get('files',[])}
