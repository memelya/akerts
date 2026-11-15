"""Local diagnostics without credentials or calls to the language model."""
import json,os,re,shutil,socket,sqlite3,subprocess,sys,platform
from pathlib import Path
from urllib.parse import quote
from csv_data import parse_csv
from products import parse_products
from app_version import BUILD

def cli_probe(root):
    from configure_gigacode import resolve_command
    from gigachat_bridge import load_config
    configured=(Path(root)/'.local-data/ai-config.json').exists()
    try:
        if configured:
            config=load_config(root);command=config['command'];cut=next((i for i,p in enumerate(command) if '{prompt}' in p or p.startswith('--')),len(command));base=command[:cut]
            if not base:raise ValueError('Некорректная команда CLI')
        else:base=resolve_command('gigacode')
        result=subprocess.run(base+['--help'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=15,shell=False,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        help_text=result.stdout+'\n'+result.stderr
        compatible=result.returncode==0 and all(x in help_text for x in ('--prompt','--approval-mode','plan'))
        version=subprocess.run(base+['--version'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=10,shell=False,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        match=re.search(r'\bv?\d{1,3}\.\d{1,3}\.\d{1,5}\b',version.stdout+' '+version.stderr)
        return {'ok':compatible,'configured':configured,'version':match[0] if match else 'не определена','message':'Однократный режим и режим plan подтверждены справкой CLI. Авторизация не проверялась.' if compatible else 'Справка CLI не подтверждает --prompt и --approval-mode plan. Локальный разбор доступен.'}
    except (ValueError,OSError,subprocess.TimeoutExpired):return {'ok':False,'configured':configured,'version':None,'message':'CLI не найдена, недоступна или не ответила вовремя. Запустите configure_gigacode.py; локальный разбор работает без CLI.'}

def inspect(root,port=8015,probe_cli=False):
    root=Path(root).resolve();checks=[]
    def add(name,ok,message):checks.append({'name':name,'ok':ok,'message':message})
    add('Python',sys.version_info>=(3,10),platform.python_version()+' · требуется 3.10 или новее')
    add('Версия проекта',True,BUILD)
    try:
        folder=root/'.local-data';folder.mkdir(exist_ok=True);test=folder/'diagnostic-write.tmp'
        with test.open('x',encoding='utf-8') as stream:stream.write('ok')
        test.unlink();add('Запись на диск',True,'Папка проекта доступна для записи')
    except OSError:add('Запись на диск',False,'Нет доступа к записи в .local-data. Распакуйте проект в доступную локальную папку.')
    try:
        with socket.socket() as listener:listener.bind(('127.0.0.1',port))
        add('Порт',True,str(port)+' свободен')
    except OSError:add('Порт',False,str(port)+' занят. При запуске будет выбран следующий свободный порт; используйте адрес из окна сервера.')
    for name,channel in (('push-sms.csv','communication'),('success-screen.csv','success_screen'),('products.csv','reference')):
        path=root/'date'/name
        try:
            if not path.exists():add(name,True,'Файл пока не добавлен');continue
            rows,stats=parse_products(path.read_bytes()) if channel=='reference' else parse_csv(path.read_bytes(),channel,'date/'+name)
            count=stats if channel=='reference' else stats['rows'];add(name,True,str(count)+' строк · файл проверен')
        except (ValueError,OSError) as error:add(name,False,str(error))
    database=root/'.local-data/analytics.sqlite3'
    if database.exists():
        try:
            db=sqlite3.connect('file:'+quote(database.as_posix(),safe='/:')+'?mode=ro',uri=True,timeout=3)
            try:result=db.execute('PRAGMA quick_check').fetchone()[0];schema=db.execute('PRAGMA user_version').fetchone()[0]
            finally:db.close()
            add('SQLite',result=='ok' and schema==1,'Проверка: '+result+' · схема '+str(schema))
        except sqlite3.Error:add('SQLite',False,'База недоступна. Сохраните .local-data; проверьте резервную копию обновления.')
    else:add('SQLite',True,'Будет создана при запуске. JSON-история переносится автоматически, исходники сохраняются.')
    cli=cli_probe(root) if probe_cli else {'ok':None,'configured':(root/'.local-data/ai-config.json').exists(),'message':'Проверка CLI не запускалась. DIAGNOSTICS.cmd проверяет установленную версию без запроса к модели.'}
    add('GigaCode',cli.get('ok'),cli['message'])
    return {'build':BUILD,'python':platform.python_version(),'checks':checks,'cli':cli,'ok':all(c['ok'] is not False for c in checks if c['name'] not in ('Порт','GigaCode'))}

def print_report(report):
    for check in report['checks']:print(('OK' if check['ok'] is True else 'INFO' if check['ok'] is None else 'CHECK')+' | '+check['name']+' | '+check['message'])
