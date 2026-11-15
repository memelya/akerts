#!/usr/bin/env python3
"""Собирает genui-prototype в архив, совместимый с update_local.py: release.json + genui-prototype/…"""
import datetime as dt, hashlib, json, re, sys, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
project = root / 'genui-prototype'
output = root / 'downloads' / (sys.argv[1] if len(sys.argv) > 1 else 'genui-gigacode-ux.zip')
skip_dirs = {'__pycache__', '.updates'}
local_keep = {'.local-data/baseline.json', '.local-data/reference.json'}
build = re.search(r"BUILD='([^']+)'", (project / 'app_version.py').read_text(encoding='utf-8'))[1]
files = {}
for path in sorted(project.rglob('*')):
    if not path.is_file():
        continue
    rel = path.relative_to(project).as_posix()
    if rel == 'release.json' or skip_dirs & set(path.parts) or path.suffix in ('.pyc', '.tmp'):
        continue
    if rel.startswith('.local-data/') and rel not in local_keep:
        continue
    files[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
manifest = {'format': 1, 'build': build, 'builtAt': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
            'databaseSchema': 1, 'files': files}
(project / 'release.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for rel in [*files, 'release.json']:
        archive.write(project / rel, 'genui-prototype/' + rel)
print(output, len(files), 'files, build', build)
