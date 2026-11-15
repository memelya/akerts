"""Configure an installed GigaCode using its own --help; no credentials stored."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def resolve_command(name):
    executable = shutil.which(name)
    if not executable:
        raise ValueError('GigaCode не найдена в PATH. Укажите --executable с полным путём.')
    shim = Path(executable)
    if shim.suffix.lower() not in ('.cmd','.bat','.ps1'):
        return [executable]
    # Standard npm Windows shim: invoke Node and its JS entry directly.
    content = shim.read_text(encoding='utf-8-sig')
    entries = re.findall(r'["\'](?:%~dp0|%dp0%|\$basedir)[\\/]+([^"\'\r\n]+\.m?js)["\']',content)
    for entry in entries:
        script = (shim.parent/entry.replace('\\',os.sep)).resolve()
        if script.is_relative_to(shim.parent.resolve()) and script.is_file():
            node = shim.parent/'node.exe'
            node = str(node) if node.exists() else shutil.which('node')
            if node:
                return [node,str(script)]
    raise ValueError('Не удалось определить JS entrypoint CLI. Используйте --node-entry с полным путём к её JS файлу.')


def configure(root, executable='gigacode', node_entry=None):
    if node_entry:
        node = shutil.which('node')
        if not node or not Path(node_entry).is_file():
            raise ValueError('Нужны установленный Node и существующий JS файл CLI.')
        command = [node,str(Path(node_entry).resolve())]
    else:
        command = resolve_command(executable)
    result = subprocess.run(command+['--help'],capture_output=True,encoding='utf-8',errors='replace',timeout=20,shell=False,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    help_text = result.stdout+'\n'+result.stderr
    if result.returncode or not re.search(r'--prompt\b', help_text):
        raise ValueError('В --help не найден --prompt. Не удалось подтвердить однократный вызов этой версии GigaCode.')
    if '--approval-mode' not in help_text or not re.search(r'\bplan\b',help_text):
        raise ValueError('В --help не подтверждён --approval-mode plan. Пришлите вывод помощи для настройки вашей версии.')
    command += ['--prompt','{prompt}','--approval-mode','plan']
    if '--output-format' in help_text and re.search(r'\btext\b',help_text):
        command += ['--output-format','text']
    config = {'command':command,'input':'argument','timeoutSeconds':120,'planningTimeoutSeconds':120,'codeTimeoutSeconds':240,'responsePath':''}
    directory = Path(root)/'.local-data'
    directory.mkdir(exist_ok=True)
    file = directory/'ai-config.json'
    if file.exists():
        raise ValueError('ai-config.json уже существует. Сохраните его копию и удалите, если хотите настроить другую CLI.')
    file.write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf-8')
    return config


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Configure installed GigaCode CLI')
    parser.add_argument('--executable',default='gigacode')
    parser.add_argument('--node-entry')
    args=parser.parse_args()
    try:
        configure(Path(__file__).resolve().parent,args.executable,args.node_entry)
        print('GigaCode command configured. Run START_LOCAL.cmd; select GigaCode CLI.')
    except (ValueError,OSError,subprocess.TimeoutExpired) as error:
        print(str(error))
        raise SystemExit(1)
