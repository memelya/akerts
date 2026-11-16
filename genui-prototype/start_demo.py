#!/usr/bin/env python3
"""Демо-режим: отдельная папка рядом с проектом, обезличенные данные, ваши CSV не затрагиваются.

python start_demo.py            — открыть демо (создаётся при первом запуске)
python start_demo.py --fresh    — пересоздать демо с данными по вчерашний день
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fresh', action='store_true')
    parser.add_argument('--port', type=int, default=8040)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    demo = root.parent / (root.name + '-demo')
    if args.fresh and demo.exists():
        shutil.rmtree(demo)
    manifest = json.loads((root / 'release.json').read_text(encoding='utf-8'))
    created = not (demo / '.local-data' / 'demo.json').exists()
    for rel in [*manifest['files'], 'release.json']:
        if rel.startswith('date/') and not created:
            continue
        source, target = root / rel, demo / rel
        if not source.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    config = root / '.local-data' / 'ai-config.json'
    if config.exists():  # то же подключение GigaCode, что и в основном проекте
        shutil.copy2(config, demo / '.local-data' / 'ai-config.json')
    if created:
        sys.path.insert(0, str(root))
        from demo_data import generate
        marker = generate(demo)
        print('Демо-данные созданы по ' + marker['anchor'] + ': ' + str(demo))
    else:
        print('Демо уже создано: ' + str(demo) + ' (пересоздать: --fresh)')
    if args.prepare_only:
        return 0
    command = [sys.executable, str(demo / 'launch_local.py'), '--port', str(args.port)] + (['--no-browser'] if args.no_browser else [])
    return subprocess.call(command, cwd=str(demo))


if __name__ == '__main__':
    raise SystemExit(main())
