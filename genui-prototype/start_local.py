#!/usr/bin/env python3
"""Run the dashboard offline: python start_local.py (no third-party packages)."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser

from gigachat_bridge import cli_status, read_dialogue_log

ROOT = Path(__file__).resolve().parent

def startup_stage(phase):
    from data_trust import atomic_json
    try:atomic_json(ROOT/'.local-data/startup-status.json',{'phase':phase,'pid':os.getpid(),'build':__import__('app_version').BUILD,'time':dt.datetime.now(dt.timezone.utc).isoformat()})
    except OSError:pass



from data_engine import Engine
from query_contract import Clarification
from metric_registry import catalog
from app_version import BUILD

def build_metadata():
    try:
        manifest=json.loads((ROOT/'release.json').read_text(encoding='utf-8'))
        stamp=manifest.get('builtAt') if manifest.get('build')==BUILD else None
        parsed=dt.datetime.fromisoformat(stamp)
        return {'build':BUILD,'builtAt':stamp if parsed.tzinfo else None}
    except (OSError,AttributeError,TypeError,ValueError):
        return {'build':BUILD,'builtAt':None}

BUILD_METADATA=build_metadata()
from project_lock import ProjectLock


def make_handler(engine):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(engine.root), **kwargs)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store, max-age=0')
            self.send_header('X-Content-Type-Options', 'nosniff')
            super().end_headers()

        def do_GET(self):
            if self.status_route():
                return
            self.respond(False)

        def do_PATCH(self):
            if not self.status_route():
                self.send_error(404)

        def do_DELETE(self):
            if not self.status_route():
                self.send_error(404)

        def status_route(self):
            """REST справочника статусов: /api/status-*, /api/analytics/status-breakdown."""
            import status_admin
            from urllib.parse import parse_qsl
            parts = urlsplit(self.path)
            if not status_admin.handles(parts.path):
                return False
            code, payload, kind = 500, {'error': 'Внутренняя ошибка справочника статусов.'}, None
            try:
                body = {}
                if self.command in ('POST', 'PATCH', 'DELETE'):
                    origin = self.headers.get('Origin')
                    if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                        raise status_admin.StatusError('Запрос разрешён только со страницы локального проекта.', 403)
                    size = int(self.headers.get('Content-Length', '0') or 0)
                    if size > 4_000_000:
                        raise status_admin.StatusError('Файл импорта больше 4 МБ.', 413)
                    if size:
                        body = json.loads(self.rfile.read(size))
                        if not isinstance(body, dict):
                            raise status_admin.StatusError('Нужен JSON объект запроса.', 400)
                    elif self.command != 'DELETE':
                        raise status_admin.StatusError('Пустой запрос.', 400)
                query = dict(parse_qsl(parts.query))
                code, payload, kind = status_admin.dispatch(engine.statuses, engine, self.command, parts.path, query, body)
            except status_admin.StatusError as error:
                code, payload = error.status, {'error': str(error), 'fields': error.fields}
            except json.JSONDecodeError:
                code, payload = 400, {'error': 'Некорректный JSON.'}
            except (ValueError, OSError) as error:
                code, payload = 400, {'error': str(error)}
            data = payload.encode('utf-8') if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', kind or 'application/json; charset=utf-8')
            if kind and 'csv' in kind:
                self.send_header('Content-Disposition', 'attachment; filename="status-directory.csv"')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return True

        def do_HEAD(self):
            self.respond(True)

        def do_POST(self):
            if self.status_route():
                return
            if self.path=='/api/pulse/upload':
                return self.pulse_upload()
            if self.path not in ('/api/pulse','/api/genui','/api/genui/plan','/api/genui/evidence','/api/data/preview','/api/data/apply','/api/data/restore','/api/diagnostics/cli','/api/investigate','/api/workflows','/api/committee','/api/ai','/api/creative','/api/survey-sections','/api/chart-assistant','/api/meeting-20261105','/api/meeting-1007','/api/digest'):
                self.send_error(404)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= (262144 if self.path=='/api/workflows' else 16000):
                    raise ValueError('Запрос слишком большой или пустой.')
                origin = self.headers.get('Origin')
                if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                    raise ValueError('Запрос разрешён только со страницы локального проекта.')
                request = json.loads(self.rfile.read(size))
                if not isinstance(request,dict):
                    raise ValueError('Нужен JSON объект запроса.')
                if self.path=='/api/pulse':result=engine.pulse.action(request)
                elif self.path=='/api/creative':result=engine.agent.creative.action(request)
                elif self.path=='/api/digest':
                    from digest import action
                    result=action(engine,request)
                elif self.path=='/api/ai':result=engine.agent.action(request)
                elif self.path=='/api/chart-assistant':result=engine.chart_assistant.action(request)
                elif self.path=='/api/meeting-1007':
                    from meeting_1007 import dashboard
                    result=dashboard(engine,request)
                elif self.path=='/api/meeting-20261105':
                    from meeting_page import meeting
                    result=meeting(engine,request)
                elif self.path=='/api/survey-sections':
                    from survey_sections import overview
                    result=overview(engine,request)
                elif self.path=='/api/investigate':result=engine.investigate(request)
                elif self.path=='/api/workflows':result=engine.workflow_action(request)
                elif self.path=='/api/committee':result=engine.committee.action(request)
                elif self.path=='/api/diagnostics/cli':
                    from diagnostics import cli_probe
                    result=cli_probe(engine.root)
                elif self.path=='/api/data/preview':result=engine.preview_import(request.get('mode','merge'))
                elif self.path=='/api/data/apply':result=engine.apply_import(request.get('token'))
                elif self.path=='/api/data/restore':result=engine.restore(request.get('revision'))
                elif self.path=='/api/genui/evidence':
                    if request.get('action')=='retain':result=engine.retain_analysis(request.get('analysisId'))
                    else:result=engine.evidence(request.get('analysisId'),request.get('series'),request.get('period'),request.get('saved'))
                elif self.path=='/api/genui/plan':result=engine.prepare(request)
                else:result=engine.run(request)
                self.send_bytes(json.dumps(result,ensure_ascii=False,allow_nan=False).encode('utf-8'),'application/json; charset=utf-8',False)
                return
            except (ValueError, TypeError, KeyError, OSError, IndexError) as error:
                payload={'error':str(error)}
                if hasattr(error,'code'):payload['code']=error.code
                if hasattr(error,'diagnosis'):payload['diagnosis']=error.diagnosis
                if isinstance(error,Clarification):payload['clarification']={'message':str(error),'options':error.options}
                data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
                self.send_response(400)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        def pulse_upload(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 200*1024*1024:
                    raise ValueError('Файл слишком большой (до 200 МБ) или пустой.')
                origin = self.headers.get('Origin')
                if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                    raise ValueError('Загрузка разрешена только со страницы локального проекта.')
                request = json.loads(self.rfile.read(size))
                if not isinstance(request,dict):
                    raise ValueError('Нужен JSON объект запроса.')
                with engine.lock:
                    result = engine.pulse.upload(request)
                self.send_bytes(json.dumps(result,ensure_ascii=False).encode('utf-8'),'application/json; charset=utf-8',False)
            except (ValueError, TypeError, KeyError, OSError) as error:
                data = json.dumps({'error':str(error)}, ensure_ascii=False).encode('utf-8')
                self.send_response(400)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        def respond(self, head):
            route = unquote(urlsplit(self.path).path)
            if route=='/api/workflows':
                try:
                    with engine.lock:
                        _,status=engine.refresh();result=engine.workflows.list();result['dataError']=status.get('error')
                except (ValueError,OSError) as error:result={'error':str(error)}
                self.send_bytes(json.dumps(result,ensure_ascii=False).encode('utf-8'),'application/json; charset=utf-8',head);return
            if route=='/api/loading':
                # Без блокировок: экран загрузки опрашивает этот адрес, пока импорт CSV и брифинг готовятся в фоне.
                pulse=getattr(engine,'pulse',None)
                result=pulse.pending()['loading'] if pulse and pulse.busy() else {'active':False}
                self.send_bytes(json.dumps(result,ensure_ascii=False).encode('utf-8'),'application/json; charset=utf-8',head);return
            if route=='/api/health':
                self.send_bytes(json.dumps(dict(getattr(engine,'runtime',{}),**BUILD_METADATA)).encode('utf-8'),'application/json; charset=utf-8',head);return
            if route=='/api/diagnostics':
                from diagnostics import inspect
                result=inspect(engine.root,self.server.server_address[1]);result['storage']=engine.store.status()['storage']
                for check in result['checks']:
                    if check['name']=='Порт':check.update(ok=True,message='Сервер этого проекта работает на порту '+str(self.server.server_address[1])+'. Используйте текущий адрес браузера.')
                self.send_bytes(json.dumps(result,ensure_ascii=False).encode('utf-8'),'application/json; charset=utf-8',head);return
            if route in ('/api/data/trust','/api/metrics'):
                try:result=engine.store.status() if route=='/api/data/trust' else catalog()
                except (ValueError,OSError) as error:result={'error':str(error)}
                self.send_bytes(json.dumps(result,ensure_ascii=False).encode('utf-8'),'application/json; charset=utf-8',head)
                return
            if route == '/api/genui/log':
                data = json.dumps(read_dialogue_log(engine.root),ensure_ascii=False).encode('utf-8')
                self.send_bytes(data,'application/json; charset=utf-8',head)
                return
            if route in ('/', '/index.html'):
                self.send_response(302)
                self.send_header('Location', '/genui/')
                self.end_headers()
                return
            if route == '/api/genui/status':
                state, status = engine.refresh()
                result = cli_status(engine.root)
                result['build']=BUILD
                result['data'] = {'surveys':len(state['surveys']), 'months':state['months'], 'files':status.get('files',[]), 'error':status.get('error')}
                result['data'].update(quality=engine.document.get('report'),revision=engine.document.get('revision'),restoredHold=bool(engine.document.get('heldFingerprint')))
                data = json.dumps(result,ensure_ascii=False).encode('utf-8')
                self.send_bytes(data,'application/json; charset=utf-8',head)
                return
            if any(part.startswith('.') for part in route.split('/') if part) or route.endswith('.py'):
                self.send_error(404)
                return
            root = engine.root.resolve()
            file = (root / route.lstrip('/')).resolve()
            if root not in file.parents:
                self.send_error(404)
                return
            if file.relative_to(root).parts[0].casefold() in ('v2','local-data-status.json','survey-reference.csv'):
                self.send_error(404)
                return
            if head:
                super().do_HEAD()
            else:
                super().do_GET()

        def send_bytes(self, data, kind, head):
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if not head:
                self.wfile.write(data)

    return Handler


def serve():
    parser = argparse.ArgumentParser(description='Offline Events dashboard with CSV updates')
    parser.add_argument('--port', type=int, default=8010)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    startup_stage("loading_csv_sqlite")
    engine = Engine(ROOT)
    from pulse import Pulse
    engine.pulse = Pulse(engine)
    from status_admin import StatusDirectory
    engine.statuses = StatusDirectory(ROOT, engine.store)
    engine.pulse.statuses = engine.statuses
    engine.pulse.start()
    startup_stage("binding_port")
    for port in range(args.port, args.port+10):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), make_handler(engine))
            break
        except OSError:
            continue
    else:
        raise SystemExit('Ports are busy. Choose another port: python start_local.py --port 8020')
    import secrets
    from data_trust import atomic_json
    engine.runtime={'port':port,'pid':os.getpid(),'rootId':hashlib.sha256(str(ROOT.resolve()).casefold().encode()).hexdigest(),'instance':secrets.token_hex(16)}
    atomic_json(ROOT/'.local-data/server.json',engine.runtime)
    startup_stage('ready')
    url = 'http://127.0.0.1:%s/genui/' % port
    print('LOCAL DASHBOARD: '+url, flush=True)
    print('CSV folder: '+str(ROOT / 'date'), flush=True)
    print('Replace CSV files, then refresh the page. Press Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.pulse.close()
        engine.agent.close()
        server.server_close()
        (ROOT/'.local-data/server.json').unlink(missing_ok=True)
        startup_stage('stopped')


def main():
    try:
        with ProjectLock(ROOT):
            try:serve()
            except Exception:
                startup_stage('failed')
                raise
    except ValueError as error:raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
