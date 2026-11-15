"""Bounded JSON calls to configured CLI. No shell or model-provided execution."""
import json,os,re,subprocess,tempfile,time
from datetime import datetime,timezone
from pathlib import Path
from gigachat_bridge import load_config,LOCK,LOG_LOCK

class Cancelled(ValueError):pass

class ModelOutputError(ValueError):code="model_json"

class CLIExitError(ValueError):code="cli_exit"

class ModelTimeout(ValueError):
    def __init__(self,stage,seconds):
        self.stage=stage;self.seconds=seconds
        super().__init__('GigaCode не завершила '+('исправление пояснений' if stage=='creative-metadata-repair' else 'генерацию интерфейса' if stage.startswith('creative-') and stage not in ('creative-plan','creative-plan-repair') else 'ответ модели')+' за '+str(seconds)+' с. Процесс остановлен. Это превышение времени ожидания; причина авторизации не установлена.')

def parse_json(value,path=''):
    value=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',value).strip()
    def invalid(_):raise ModelOutputError('JSON не должен содержать NaN или Infinity.')
    def pairs(items):
        result={}
        for key,item in items:
            if key in result:raise ModelOutputError('Повтор поля JSON: '+key)
            result[key]=item
        return result
    decoder=json.JSONDecoder(parse_constant=invalid,object_pairs_hook=pairs)
    def decode(text):
        try:return decoder.decode(text)
        except (ValueError,TypeError):pass
        # Accept prose/Markdown around exactly one complete object. Never repair
        # JSON syntax or choose among multiple objects; bundle validation follows.
        found=[];cursor=0
        for _ in range(64):
            offsets=[i for i in (text.find('{',cursor),text.find('[',cursor)) if i>=0]
            if not offsets:break
            begin=min(offsets)
            try:item,end=decoder.raw_decode(text,begin)
            except ValueError:
                raise ModelOutputError('Ответ содержит повреждённый JSON. Нужен один полный JSON-объект.') from None
            found.append(item);cursor=end
            if len(found)>1:raise ModelOutputError('Ответ содержит несколько JSON-объектов. Нужен один однозначный результат.')
        if len(found)==1 and isinstance(found[0],dict):return found[0]
        raise ModelOutputError('Модель должна вернуть один JSON-объект без служебных сообщений.')
    for depth in range(3):
        match=re.fullmatch(r'```(?:json)?\s*([\s\S]*?)\s*```',value)
        if match:value=match[1]
        result=decode(value)
        if depth==0:
            try:
                for key in path.split('.') if path else []:result=result[key]
            except (KeyError,TypeError):raise ModelOutputError('В ответе CLI отсутствует настроенное поле responsePath.') from None
        if not isinstance(result,str):return result
        value=result
    raise ModelOutputError('Слишком много вложенных JSON-оболочек.')

def append_log(root,entry):
    from model_policy import minimize_log
    entry=dict(entry);minimize_log(root,entry)
    with LOG_LOCK:
        try:
            file=Path(root)/'.local-data/gigacode-log.json';rows=json.loads(file.read_text(encoding='utf-8')) if file.exists() else []
            file.parent.mkdir(parents=True,exist_ok=True);temporary=file.with_suffix('.tmp');temporary.write_text(json.dumps((rows+[entry])[-200:],ensure_ascii=False),encoding='utf-8');temporary.replace(file)
        except (OSError,ValueError):pass

def call_json(root,instructions,payload,stage,query,session,cancel,timeout_seconds=None,log_entry=None):
    entry=log_entry if log_entry is not None else {}
    entry.update(time=datetime.now(timezone.utc).isoformat(),query=query,mode='cli',stage=stage,session=session,invoked=False,status='ok');started=time.monotonic();acquired=False
    try:
        if cancel.is_set():raise Cancelled('Анализ остановлен пользователем.')
        from model_policy import prepare_payload, validate_command
        payload=prepare_payload(root,stage,payload)
        config=load_config(root);prompt=instructions+'\nAGENT_CONTEXT_JSON\n'+json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)
        validate_command(root,config['command'])
        if len(prompt)>25000:raise ValueError('Контекст анализа слишком велик для однократного вызова CLI. Уточните продукт или сузьте период.')
        budget=config['timeoutSeconds'] if timeout_seconds is None else timeout_seconds
        if type(budget) is not int or not 1<=budget<=300:raise ValueError('Время ожидания: от 1 до 300 секунд.')
        entry['timeoutSeconds']=budget;entry['prompt']=prompt
        if not LOCK.acquire(blocking=False):raise ValueError('CLI уже обрабатывает другой запрос. Дождитесь завершения.')
        acquired=True
        with tempfile.TemporaryDirectory(prefix='genui-agent-') as directory:
            prompt_file=Path(directory)/'prompt.txt';prompt_file.write_text(prompt,encoding='utf-8')
            command=[arg.replace('{prompt}',prompt).replace('{prompt_file}',str(prompt_file)) for arg in config['command']]
            if config['input']=='argument' and sum(len(a) for a in command)>28000:raise ValueError('Контекст не помещается в аргумент Windows. Используйте настроенный input: file или stdin.')
            with tempfile.TemporaryFile() as output,tempfile.TemporaryFile() as errors:
                process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=output,stderr=errors,cwd=directory,shell=False,env=dict(os.environ,PYTHONIOENCODING='utf-8',PYTHONUTF8='1',NO_COLOR='1'),creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                entry['invoked']=True;begin=time.monotonic()
                try:
                    try:process.communicate(input=prompt.encode('utf-8') if config['input']=='stdin' else b'',timeout=.25)
                    except subprocess.TimeoutExpired:
                        while True:
                            if cancel.is_set():raise Cancelled('Анализ остановлен пользователем.')
                            if time.monotonic()-begin>budget:raise ModelTimeout(stage,budget)
                            try:process.communicate(timeout=.25);break
                            except subprocess.TimeoutExpired:pass
                    if cancel.is_set():raise Cancelled('Анализ остановлен пользователем.')
                    if process.returncode:
                        errors.seek(0);entry['exitCode']=process.returncode;entry['stderr']=errors.read(8192).decode('utf-8',errors='replace')
                        raise CLIExitError('GigaCode завершилась с кодом '+str(process.returncode)+'. Причина завершения не установлена. Проверьте настройки CLI.')
                    if output.tell()>262144:raise ValueError('Ответ модели слишком большой. Нужна только спецификация интерфейса.')
                    output.seek(0);response=output.read().decode('utf-8-sig');entry['response']=response
                    return parse_json(response,config['responsePath'])
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:process.communicate(timeout=2)
                        except subprocess.TimeoutExpired:process.kill();process.communicate()
    except (ValueError,OSError,UnicodeError) as error:
        error.modelInvoked=entry.get('invoked',False)
        if isinstance(error,ModelTimeout):entry['errorCode']='timeout'
        elif getattr(error,'code',None):entry['errorCode']=error.code
        entry.update(status='cancelled' if isinstance(error,Cancelled) else 'error',error=str(error) if not isinstance(error,OSError) else 'Не удалось запустить настроенную CLI.')
        if isinstance(error,OSError):raise ValueError('Не удалось запустить настроенную CLI. Проверьте полный путь и зависимости.') from None
        raise
    finally:
        if acquired:LOCK.release()
        entry['durationMs']=round((time.monotonic()-started)*1000)
        if log_entry is None:append_log(root,entry)
        else:
            from model_policy import minimize_log
            minimize_log(root,entry)
