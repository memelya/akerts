"""Offline release updater. CSV/config/history are never replaced by the ZIP."""
import argparse,datetime as dt,hashlib,json,os,shutil,sqlite3,uuid,zipfile
from contextlib import closing
from pathlib import Path,PurePosixPath
from project_lock import ProjectLock

PROTECTED={'date','.local-data','.updates','__pycache__'}
def apply_update(root,archive):
    root=Path(root).resolve();archive=Path(archive).resolve()
    with ProjectLock(root),zipfile.ZipFile(archive) as package:
        entries={};names=set()
        for info in package.infolist():
            if info.is_dir():continue
            path=PurePosixPath(info.filename)
            if '\\' in info.filename or ':' in info.filename or path.is_absolute() or '..' in path.parts or len(path.parts)<2 or path.parts[0]!='genui-prototype':raise ValueError('Архив содержит недопустимый путь.')
            rel=PurePosixPath(*path.parts[1:]).as_posix()
            if rel.casefold() in names:raise ValueError('Повтор файла в архиве.')
            names.add(rel.casefold())
            entries[rel]=info
        if 'release.json' not in entries:raise ValueError('Нужен новый архив проекта с release.json.')
        manifest=json.loads(package.read(entries['release.json']))
        if not isinstance(manifest,dict) or manifest.get('format')!=1 or manifest.get('databaseSchema')!=1:raise ValueError('Несовместимый формат выпуска.')
        expected=manifest.get('files',{})
        if not isinstance(expected,dict):raise ValueError('Некорректный манифест файлов.')
        if set(entries)-{'release.json'}!=set(expected):raise ValueError('Состав архива не соответствует манифесту.')
        for name,digest in expected.items():
            if hashlib.sha256(package.read(entries[name])).hexdigest()!=digest:raise ValueError('Повреждён файл: '+name)
        for required in ('start_local.py','launch_local.py','analytics_db.py','genui/index.html'):
            if required not in expected:raise ValueError('В архиве не хватает '+required)
        version=manifest.get('build','unknown');backup=root/'.updates'/('backup-'+dt.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
        if not backup.resolve().is_relative_to(root):raise ValueError('Папка резервных копий должна находиться внутри проекта.')
        backup.mkdir(parents=True)
        # A full user-file backup is retained beside the application backup.
        if (root/'date').exists():shutil.copytree(root/'date',backup/'date')
        if (root/'.local-data').exists():
            shutil.copytree(root/'.local-data',backup/'.local-data',ignore=shutil.ignore_patterns('analytics.sqlite3*','server.lock','server.json','*.tmp'))
            database=root/'.local-data/analytics.sqlite3'
            if database.exists():
                with closing(sqlite3.connect(database)) as source,closing(sqlite3.connect(backup/'.local-data/analytics.sqlite3')) as target:source.backup(target)
        changed=[]
        try:
            for name in sorted(entries):
                rel=PurePosixPath(name)
                if rel.parts[0].casefold() in PROTECTED:continue
                if any((root/Path(*rel.parts[:i])).is_symlink() for i in range(1,len(rel.parts)+1)):raise ValueError('Обновление через символическую ссылку запрещено: '+name)
                destination=(root/Path(*rel.parts)).resolve()
                if not destination.is_relative_to(root):raise ValueError('Путь выходит из папки проекта.')
                if destination.exists() and not destination.is_file():raise ValueError('Файл занят папкой: '+name)
                old=backup/'application'/Path(*rel.parts)
                if destination.exists():old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(destination,old)
                destination.parent.mkdir(parents=True,exist_ok=True);temp=destination.with_name(destination.name+'.update-tmp')
                temp.write_bytes(package.read(entries[name]));os.replace(temp,destination);changed.append((destination,old))
        except (OSError,ValueError) as error:
            failures=[]
            if 'temp' in locals():
                try:temp.unlink(missing_ok=True)
                except OSError:pass
            for destination,old in reversed(changed):
                try:
                    if old.exists():shutil.copy2(old,destination)
                    else:destination.unlink(missing_ok=True)
                except OSError:failures.append(str(destination))
            raise ValueError('Обновление отменено: '+str(error)+'. Резервная копия: '+str(backup)+('. Не удалось вернуть: '+', '.join(failures) if failures else '. Прежние файлы приложения восстановлены.')) from None
        (backup/'update-result.json').write_text(json.dumps({'build':version,'files':len(changed),'userFilesPreserved':True},ensure_ascii=False),encoding='utf-8')
        return {'build':version,'backup':str(backup),'files':len(changed)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--archive');args=parser.parse_args()
    archive=args.archive or input('Path to downloaded genui-gigacode.zip: ').strip().strip('"')
    try:
        result=apply_update(Path(__file__).resolve().parent,archive);print('Updated to '+result['build']+'\nCSV, database, references and CLI settings preserved.\nBackup: '+result['backup']+'\nRun START_LOCAL.cmd.')
    except (ValueError,OSError,zipfile.BadZipFile) as error:print(str(error));return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
