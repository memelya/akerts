#!/usr/bin/env python3
"""Run the dashboard offline: python start_local.py (no third-party packages)."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser

from csv_data import DataError, parse_csv, merge_records
from dashboard_model import build_state
from dashboard_html import render_page

ROOT = Path(__file__).resolve().parent
FILES = (('push-sms.csv', 'communication'), ('success-screen.csv', 'success_screen'))


def empty_baseline():
    return {'version': 1, 'months': [], 'surveys': [], 'daily': [], 'ranks': {},
            'statusDescriptions': {}, 'surveyTypes': {}, 'triggerGroups': {},
            'management': {'period': None, 'issueIds': [], 'rows': []}}


class Engine:
    def __init__(self, root):
        self.root = Path(root)
        self.directory = self.root / '.local-data'
        self.directory.mkdir(parents=True, exist_ok=True)
        baseline_file = self.directory / 'baseline.json'
        baseline_text = baseline_file.read_text(encoding='utf-8-sig').strip() if baseline_file.exists() else ''
        self.baseline = json.loads(baseline_text) if baseline_text else empty_baseline()
        self.cache = self.directory / 'updates.json'
        self.lock = threading.RLock()
        self.fingerprint = None
        self.updates = []
        self.cache_error = None
        if self.cache.exists():
            try:
                saved = json.loads(self.cache.read_text(encoding='utf-8'))
                if saved.get('version') != 1 or not isinstance(saved.get('records'), list):
                    raise DataError('Неизвестный формат локальной истории')
                self.updates = saved['records']
                self.state = build_state(self.baseline, self.updates)
            except (ValueError, KeyError, TypeError) as error:
                self.updates = []
                self.cache_error = 'Не удалось прочитать .local-data/updates.json: %s. Сохранённый файл не перезаписан.' % error
        if not hasattr(self, 'state'):
            self.state = build_state(self.baseline, [])
        self.status = {'files': [], 'error': self.cache_error}

    def refresh(self):
        with self.lock:
            documents, descriptions = [], []
            digest = hashlib.sha256()
            for name, channel in FILES:
                file = self.root / 'date' / name
                try:
                    raw = file.read_bytes() if file.exists() else b''
                    stat = file.stat() if file.exists() else None
                except OSError as error:
                    self.status = {'files': descriptions, 'error': 'Не удалось прочитать date/%s: %s. Закройте файл в редакторе и обновите страницу.' % (name, error)}
                    self.fingerprint = None
                    return self.state, self.status
                digest.update(name.encode())
                digest.update(raw)
                digest.update(str(stat.st_mtime_ns if stat else '').encode())
                documents.append((name, channel, raw))
                descriptions.append({'file': 'date/'+name, 'rows': 0, 'modified': dt.datetime.fromtimestamp(stat.st_mtime).strftime('%d.%m.%Y %H:%M:%S') if stat else 'файл не найден'})
            fingerprint = digest.hexdigest()
            if self.fingerprint == fingerprint:
                return self.state, self.status
            self.fingerprint = fingerprint
            try:
                if self.cache_error:
                    raise DataError(self.cache_error)
                incoming = []
                for index, (name, channel, raw) in enumerate(documents):
                    rows, stats = parse_csv(raw, channel, 'date/'+name)
                    incoming.extend(rows)
                    descriptions[index].update(stats)
                merged = merge_records(self.updates, incoming)
                candidate = build_state(self.baseline, merged)
                if merged != self.updates:
                    temporary = self.cache.with_suffix('.tmp')
                    encoded = json.dumps({'version': 1, 'records': merged}, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
                    with temporary.open('w', encoding='utf-8', newline='\n') as handle:
                        handle.write(encoded)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if self.cache.exists():
                        backup = self.cache.with_suffix('.json.bak')
                        backup.write_bytes(self.cache.read_bytes())
                    os.replace(temporary, self.cache)
                self.updates, self.state = merged, candidate
                self.status = {'files': descriptions, 'error': None}
            except (DataError, ValueError, OSError) as error:
                self.status = {'files': descriptions, 'error': str(error)}
            return self.state, self.status


def make_handler(engine):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(engine.root), **kwargs)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store, max-age=0')
            self.send_header('X-Content-Type-Options', 'nosniff')
            super().end_headers()

        def do_GET(self):
            self.respond(False)

        def do_HEAD(self):
            self.respond(True)

        def respond(self, head):
            route = unquote(urlsplit(self.path).path)
            if route in ('/', '/index.html'):
                self.send_response(302)
                self.send_header('Location', '/v2/index.html')
                self.end_headers()
                return
            if route == '/v2/':
                route += 'index.html'
            if any(part.startswith('.') for part in route.split('/') if part) or route.endswith('.py'):
                self.send_error(404)
                return
            file = (engine.root / route.lstrip('/')).resolve()
            if engine.root.resolve() not in file.parents:
                self.send_error(404)
                return
            if route == '/local-data-status.json':
                state, status = engine.refresh()
                data = json.dumps(status, ensure_ascii=False).encode('utf-8')
                self.send_bytes(data, 'application/json; charset=utf-8', head)
                return
            if route.startswith('/v2/') and route.endswith('.html'):
                state, status = engine.refresh()
                if not file.is_file() and re.fullmatch(r'/v2/events/\d+\.html', route):
                    ident = int(Path(route).stem)
                    if not any(s['event']['id'] == ident for s in state['surveys']):
                        self.send_error(404, 'Survey is not present in the CSV files')
                        return
                    file = engine.root / 'v2/events/template.html'
                    if not file.is_file():
                        file = engine.root / 'v2/events/625.html'
                if file.is_file():
                    data = render_page(file.read_text(encoding='utf-8'), route, state, status, engine.baseline).encode('utf-8')
                    self.send_bytes(data, 'text/html; charset=utf-8', head)
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


def main():
    parser = argparse.ArgumentParser(description='Offline Events dashboard with CSV updates')
    parser.add_argument('--port', type=int, default=8010)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    engine = Engine(ROOT)
    engine.refresh()
    for port in range(args.port, args.port+10):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), make_handler(engine))
            break
        except OSError:
            continue
    else:
        raise SystemExit('Ports are busy. Choose another port: python start_local.py --port 8020')
    url = 'http://127.0.0.1:%s/v2/' % port
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
        server.server_close()


if __name__ == '__main__':
    main()
