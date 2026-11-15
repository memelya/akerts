"""Configure, validate one real CLI response, detach server and open this project."""
import argparse,hashlib,json,os,subprocess,sys,threading,time,webbrowser
from pathlib import Path
from urllib.request import urlopen
from app_version import BUILD

class ServerStarting(ValueError):pass

def server_loading(root):
    from project_lock import ProjectLock
    try:
        with ProjectLock(root):return False
    except ValueError:return True

def wait_ready(root,process=None,timeout=180,clock=time.monotonic,sleep=time.sleep):
    started=clock();notice=started
    while True:
        running=active(root)
        if running:return running
        held=server_loading(root)
        if process is not None and process.poll() is not None and not held:
            raise ValueError('Процесс сервера завершился с кодом '+str(process.returncode)+'. Подробности: .local-data/server-output.log.')
        if process is None and not held:
            raise ValueError('Ожидаемый процесс запуска больше не удерживает блокировку проекта. Проверьте .local-data/server-output.log.')
        elapsed=clock()-started
        if elapsed>=timeout:
            raise ServerStarting('Сервер ещё не подтвердил готовность за '+str(timeout)+' с. Процесс продолжает запуск; это не подтверждённый сбой. Повторите bootstrap_project.py для ожидания этого же сервера. Подробности: .local-data/server-output.log и startup-status.json.')
        if clock()-notice>=5:
            print('Ожидаю готовности: '+str(round(elapsed))+' с. Идёт загрузка CSV/SQLite; второй сервер не запускается.',flush=True);notice=clock()
        sleep(.25)

def active(root):
    try:
        saved=json.loads((root/'.local-data/server.json').read_text(encoding='utf-8'))
        port=int(saved['port'])
        if not 1024<=port<=65535:return None
        url='http://127.0.0.1:'+str(port)
        with urlopen(url+'/api/health',timeout=2) as response:health=json.load(response)
        root_id=hashlib.sha256(str(root.resolve()).casefold().encode()).hexdigest()
        if health.get('rootId')==root_id and health.get('instance')==saved.get('instance'):return url,health
    except (OSError,ValueError,KeyError,TypeError):pass
    return None

def setup(root,port=8015,open_browser=True,startup_timeout=180):
    from diagnostics import inspect,print_report
    from gigachat_bridge import load_config
    from configure_gigacode import configure
    from model_client import call_json
    root=Path(root).resolve();folder=root/'.local-data';folder.mkdir(exist_ok=True)
    running=active(root);waiting=not running and server_loading(root)
    if waiting:
        print('Сервер этой папки уже запускается. Ожидаю его без повторной проверки модели и создания второго процесса.',flush=True)
        model_check='not_rechecked';running=wait_ready(root,timeout=startup_timeout)
    else:
        print('1/4 Проверка Python, CSV и хранилища...',flush=True)
        report=inspect(root,port,False);print_report(report)
        if not report['ok']:raise ValueError('Проверка проекта не пройдена. Исправьте перечисленные ошибки CSV/окружения. Файлы не изменены.')
        print('2/4 Настройка подключения к установленной GigaCode...',flush=True)
        if not (folder/'ai-config.json').exists():configure(root)
        config=load_config(root)
        print('3/4 Один реальный запрос к модели на синтетических данных...',flush=True)
        answer=call_json(root,'Верни ровно один JSON {"ok":true}. Без пояснений и других полей.',{'phase':'startup-check','synthetic':True},'startup-check','Проверка подключения при запуске',None,threading.Event(),timeout_seconds=config['planningTimeoutSeconds'])
        if answer!={'ok':True}:raise ValueError('CLI ответила, но контрольный JSON не совпал. Запустите python diagnose_project.py --probe-model. Сервер не запускался.')
        model_check='passed'
    print('4/4 Запуск сервера...',flush=True)
    running=active(root)
    if running and running[1].get('build')!=BUILD:raise ValueError('В этой папке запущен сервер другой версии. Завершите его обычным способом и повторите запуск.')
    process=None
    if not running:
        with (folder/'server-output.log').open('a',encoding='utf-8') as output:
            options={'creationflags':subprocess.CREATE_NO_WINDOW|subprocess.DETACHED_PROCESS} if os.name=='nt' else {'start_new_session':True}
            # Preflight already parsed these CSVs. Avoid a second full preflight
            # in launch_local; start_local still validates and imports the data.
            process=subprocess.Popen([sys.executable,str(root/'start_local.py'),'--port',str(port),'--no-browser'],cwd=root,stdin=subprocess.DEVNULL,stdout=output,stderr=output,env=dict(os.environ,PYTHONIOENCODING='utf-8',PYTHONUTF8='1'),**options)
        running=wait_ready(root,process,startup_timeout)
    url=running[0]+'/genui/'
    result={'build':BUILD,'url':url,'serverHealth':'passed','modelJsonCheck':model_check,'generatedUi':'not_tested','reusedServer':process is None}
    previous={}
    try:previous=json.loads((folder/'startup-result.json').read_text(encoding='utf-8'))
    except (OSError,ValueError):pass
    result['serverInstance']=running[1].get('instance');result['browserOpened']=False;result['browserOpenAction']='not_requested'
    if previous.get('serverInstance')==result['serverInstance'] and previous.get('browserOpened'):
        result['browserOpened']=True;result['browserOpenAction']='already_requested'
    elif open_browser:
        try:result['browserOpened']=bool(webbrowser.open(url))
        except webbrowser.Error:result['browserOpened']=False
        result['browserOpenAction']='requested' if result['browserOpened'] else 'failed'
    from data_trust import atomic_json
    atomic_json(folder/'startup-result.json',result)
    print('Сайт: '+url,flush=True)
    print(('Подключение CLI проверено.' if model_check=='passed' else 'Модель повторно не вызывалась: ожидался ранее запущенный сервер.')+' Генерация произвольного интерфейса этим тестом не подтверждена.',flush=True)
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=8015);parser.add_argument('--no-browser',action='store_true');parser.add_argument('--startup-timeout',type=int,default=180);args=parser.parse_args()
    if not 1024<=args.port<=65526:parser.error('port: 1024–65526')
    if not 1<=args.startup_timeout<=900:parser.error('startup-timeout: 1–900 секунд')
    try:setup(Path(__file__).resolve().parent,args.port,not args.no_browser,args.startup_timeout)
    except ServerStarting as error:
        print('ЗАПУСК ПРОДОЛЖАЕТСЯ: '+str(error),flush=True)
        raise SystemExit(2)
    except (ValueError,OSError,subprocess.TimeoutExpired) as error:
        print('ЗАПУСК ОСТАНОВЛЕН: '+str(error),flush=True)
        print('Не меняйте код проекта для обхода проверки. При ошибке модели: python diagnose_project.py --probe-model',flush=True)
        raise SystemExit(1)
