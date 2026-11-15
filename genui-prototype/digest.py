"""Portable presentation recipes and deterministic survey series."""
import calendar
import datetime as dt
import json
from collections import defaultdict
from uuid import uuid4

from metric_registry import LABELS, calculate, weighted_csi

METRICS=('csi','answers','sends','events','responseRate')


def inventory(state):
    return [{'id':s['event']['id'],'name':s['meta']['name'],'channel':s['meta']['channel'],
             'products':s['meta'].get('products',[]),'top':bool(s['event'].get('isTop')),
             'latest':max(s['meta']['availableMonths'],default=None)}
            for s in state['surveys']]


def validate(raw):
    fields={'name','start','end','metrics','channel','product','top','ids','layout','chart','theme','type','format'}
    if not isinstance(raw,dict) or set(raw)!=fields:
        raise ValueError('Некорректный шаблон дайджеста.')
    for key,maximum in [('name',120),('product',200),('ids',500)]:
        if not isinstance(raw[key],str) or len(raw[key])>maximum:
            raise ValueError('Проверьте поля шаблона.')
    try:
        start,end=(dt.date.fromisoformat(raw[k]) for k in ('start','end'))
    except (TypeError,ValueError):
        raise ValueError('Укажите даты начала и конца расчёта.') from None
    if not raw['name'].strip() or not 1900<=start.year<=end.year<=2199 or start>end or (end.year-start.year)*12+end.month-start.month>=24:
        raise ValueError('Введите название и выберите период до 24 календарных месяцев.')
    metrics=raw['metrics']
    if not isinstance(metrics,list) or not 1<=len(metrics)<=3 or any(m not in METRICS for m in metrics) or len(set(metrics))!=len(metrics):
        raise ValueError('Выберите от одного до трёх показателей.')
    if 'responseRate' in metrics and len(metrics)>1:
        raise ValueError('Для отклика выберите отдельный шаблон с процентной шкалой.')
    choices={'channel':('','communication','success_screen'),'layout':('1','2','4','6'),
             'chart':('line','bar'),'theme':('light','dark'),'type':('overview','detail','both'),
             'format':('pptx','png','xlsx')}
    if any(raw[key] not in allowed for key,allowed in choices.items()) or type(raw['top']) is not bool:
        raise ValueError('Проверьте оформление и фильтры шаблона.')
    ids=raw['ids'].replace(',',' ').replace(';',' ').split()
    if any(not i.isascii() or not i.isdigit() or not 1<=int(i)<=9999999 for i in ids):
        raise ValueError('Укажите номера опросов через запятую или пробел.')
    return dict(raw,name=raw['name'].strip(),start=start.isoformat(),end=end.isoformat(),ids=','.join(dict.fromkeys(str(int(i)) for i in ids)))


def calculate_digest(engine, definition, members, revision):
    start,end=definition['start'],definition['end']
    current=dt.date.fromisoformat(start).replace(day=1)
    periods=[]
    while current.isoformat()<=end:
        month=current.strftime('%Y-%m')
        last=current.replace(day=calendar.monthrange(current.year,current.month)[1]).isoformat()
        periods.append({'start':month,'short':month[5:]+'.'+month[2:4],'from':max(start,current.isoformat()),'end':min(end,last)})
        current=dt.date.fromisoformat(last)+dt.timedelta(days=1)
    keys=[(s['channel'],s['id']) for s in members]
    raw=engine.store.digest_records(revision,keys,start,end) if revision and keys else []
    grouped=defaultdict(list)
    all_rows=defaultdict(list)
    for row in raw:
        month=row['date'][:7]
        grouped[row['channel'],row['id'],month].append(row)
        all_rows[month].append(row)
    months=[p['start'] for p in periods]
    def chart(member):
        rows=[grouped[member['channel'],member['id'],m] if member else all_rows[m] for m in months]
        blocks=[]
        for metric in definition['metrics']:
            values=[calculate(group,metric,'month') for group in rows]
            block={'id':member['id'] if member else None,'metric':metric,'label':LABELS[metric],'values':values}
            if metric=='csi':
                block['proofs']=[weighted_csi(group) for group in rows]
            blocks.append(block)
        return {'survey':member,'blocks':blocks} if any(any(v is not None for v in b['values']) for b in blocks) else None
    detailed=[item for member in members if (item:=chart(member))] if definition['type']!='overview' else []
    overall=chart(None) if definition['type']!='detail' else None
    if not detailed and not overall:
        raise ValueError('За выбранный период нет значений по этому отбору. Для неполного месяца нужны дневные строки CSV.')
    capacity=int(definition['layout'])
    if len(detailed)>capacity*(30-int(overall is not None)):
        raise ValueError('Получается больше 30 страниц. Уточните отбор или выберите больше графиков на странице.')
    return {'revision':revision,'periods':periods,'months':months,'overall':overall,'items':detailed,
            'surveyCount':len({(r['channel'],r['id']) for r in raw}),
            'monthlyExcluded':any(p['from']!=p['start']+'-01' or int(p['end'][-2:])!=calendar.monthrange(*map(int,p['start'].split('-')))[1] for p in periods)}


def action(engine, request):
    operation=request.get('action')
    if operation=='validate':
        return validate(request.get('definition'))
    with engine.lock:
        state,status=engine.refresh()
        revision=engine.document.get('revision')
        surveys=inventory(state)
        if operation=='inventory':
            return {'surveys':surveys,'latest':max(state['months'],default=None)}
        if operation=='list':
            with engine.store.connect() as db:
                db.execute('CREATE TABLE IF NOT EXISTS digest_templates(id TEXT PRIMARY KEY, definition TEXT NOT NULL)')
                templates=[{'id':r['id'],**json.loads(r['definition'])} for r in db.execute('SELECT * FROM digest_templates ORDER BY rowid DESC')]
            return {'surveys':surveys,'templates':templates,'latest':max(state['months'],default=None)}
        if operation in ('save','delete'):
            with engine.store.connect() as db:
                db.execute('CREATE TABLE IF NOT EXISTS digest_templates(id TEXT PRIMARY KEY, definition TEXT NOT NULL)')
                ident=request.get('id')
                if ident is not None and (not isinstance(ident,str) or not db.execute('SELECT 1 FROM digest_templates WHERE id=?',(ident,)).fetchone()):
                    raise ValueError('Шаблон не найден.')
                if operation=='delete':
                    if not ident:raise ValueError('Выберите сохранённый шаблон.')
                    db.execute('DELETE FROM digest_templates WHERE id=?',(ident,))
                    return {'ok':True}
                definition=validate(request.get('definition'))
                if ident:
                    db.execute('UPDATE digest_templates SET definition=? WHERE id=?',(json.dumps(definition,ensure_ascii=False),ident))
                else:
                    ident=uuid4().hex
                    db.execute('INSERT INTO digest_templates VALUES (?,?)',(ident,json.dumps(definition,ensure_ascii=False)))
                return {'id':ident,**definition}
        if operation!='run':
            raise ValueError('Неизвестное действие дайджеста.')
        if status.get('error'):
            raise ValueError(status['error'])
        definition=validate(request.get('definition'))
        ids={int(i) for i in definition['ids'].split(',') if i}
        members=[s for s in surveys if (not ids or s['id'] in ids)
                 and (not definition['top'] or s['top'])
                 and (not definition['channel'] or s['channel']==definition['channel'])
                 and (not definition['product'] or definition['product'] in s['products'])]
        return calculate_digest(engine,definition,members,revision)
