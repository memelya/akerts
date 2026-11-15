"""Local, opt-in real CLI diagnostics. Report excludes CSVs, prompts and responses."""
import argparse,collections,datetime,json,platform,sys,threading,time
from pathlib import Path
from app_version import BUILD
from failure_diagnosis import diagnose

def history(root):
    file=root/'.local-data/gigacode-log.json'
    if not file.exists():return {'entries':0,'sessions':0,'appliedSessions':0,'note':'Лог отсутствует; работа модели не подтверждена.'}
    try:rows=json.loads(file.read_text(encoding='utf-8-sig'))
    except (OSError,ValueError):return {'error':'Не удалось прочитать журнал.'}
    if not isinstance(rows,list):return {'error':'Журнал должен содержать список записей.'}
    rows=[r for r in rows if isinstance(r,dict)]
    groups=collections.defaultdict(list)
    for row in rows:
        if row.get('session'):groups[row['session']].append(row)
    counts=collections.Counter((str(r.get('stage','unknown')),str(r.get('status','unknown'))) for r in rows)
    return {'entries':len(rows),'sessions':len(groups),'appliedSessions':sum(any(r.get('stage')=='creative-apply' and r.get('status')=='ok' for r in group) for group in groups.values()),'stages':[{'stage':s,'status':v,'count':n} for (s,v),n in sorted(counts.items())],'note':'Только последние 200 записей. Ответ CLI, валидация, предпросмотр и применение — разные события. Наличие ответа не доказывает готовый график.'}

def run(root,probe=False):
    from gigachat_bridge import load_config
    report={'build':BUILD,'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':{'os':platform.system(),'osRelease':platform.release(),'python':platform.python_version(),'processDirectory':'isolated temporary directory','projectGigacodeConfigPresent':(root/'.gigacode').exists()},'history':history(root),'checks':[],'browserPreview':'not_tested','productionData':'not_read','realModelRequested':probe}
    try:
        cfg=load_config(root)
        report['configuration']={'valid':True,'input':cfg['input'],'responsePathConfigured':bool(cfg['responsePath']),'planningTimeoutSeconds':cfg['planningTimeoutSeconds'],'codeTimeoutSeconds':cfg['codeTimeoutSeconds'],'executableType':Path(cfg['command'][0]).suffix or 'binary','modelIdentity':'not_confirmed'}
    except (ValueError,OSError) as error:
        report['configuration']={'valid':False};report['checks'].append({'stage':'configuration','status':'failed','diagnosis':diagnose(error)});return report
    if not probe:return report
    from model_client import call_json
    from genui_query import validate_spec
    from creative_ui import validate_bundle
    tests=[('diagnostic-json','Верни ровно JSON {"ok":true}, без других полей.',{},lambda v: v=={'ok':True}),
           ('diagnostic-plan','Верни JSON параметров графика для запроса: отправки опроса 514 за октябрь 2026. Поля ids=[514], metrics=["sends"], monthsCount=1, startMonth="2026-10", endMonth="2026-10", layout="combined". Только JSON.',{},lambda v: validate_spec(v)['ids']==[514] and v.get('metrics')==['sends'] and v.get('startMonth')=='2026-10' and v.get('endMonth')=='2026-10'),
           ('diagnostic-code','Верни один JSON {title,description,designRationale,html,css,javascript,factRefs,interactions,limitations}. Создай минимальную карточку синтетического факта F1: отправки 100. javascript должен вызвать ui.render с HTML, содержащим <span data-fact-ref="F1"></span>. Без библиотек, DOM и сети. title до 140, пояснения до 4000 символов. factRefs=["F1"], interactions=[], limitations=["Синтетическая проверка, не отчёт"]. Код суммарно до 10000 символов. Только JSON.',{'synthetic':True,'fact':{'ref':'F1','actual':100}},lambda v: bool(validate_bundle(v,{'F1':{'actual':100}})))]
    session='diagnostic-'+str(int(time.time()))
    for stage,prompt,data,validate in tests:
        started=time.monotonic()
        try:
            answer=call_json(root,prompt,dict(data,phase=stage,synthetic=True),stage,'Проверка совместимости CLI на синтетических данных',session,threading.Event(),timeout_seconds=cfg['codeTimeoutSeconds'] if stage=='diagnostic-code' else cfg['planningTimeoutSeconds'])
            if not validate(answer):raise ValueError('Ответ JSON не соответствует контрольному заданию.')
            report['checks'].append({'stage':stage,'status':'passed','durationSeconds':round(time.monotonic()-started,1),'scope':'server_contract_only' if stage=='diagnostic-code' else 'cli_and_json_contract'})
        except Exception as error:
            report['checks'].append({'stage':stage,'status':'failed','durationSeconds':round(time.monotonic()-started,1),'diagnosis':diagnose(error,{'activeModelStage':stage})})
            break
    report['conclusion']='Контракты CLI прошли; выполнение кода в браузере и работа с реальными CSV ещё не подтверждены.' if len(report['checks'])==3 and all(c['status']=='passed' for c in report['checks']) else 'Совместимость модели не подтверждена. Исправьте первый проваленный этап перед сложными запросами.'
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--probe-model',action='store_true',help='До трёх настоящих вызовов CLI с синтетическими данными. Может расходовать квоту модели.');args=parser.parse_args()
    root=Path(__file__).resolve().parent;report=run(root,args.probe_model);out=root/'diagnostics-report.json';out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Report: '+str(out));print(report.get('conclusion','Проверка окружения завершена; модель не вызывалась.' if not args.probe_model else 'Настройка CLI не прошла проверку.'))
    raise SystemExit(1 if not report.get('configuration',{}).get('valid') or any(c['status']=='failed' for c in report['checks']) else 0)
