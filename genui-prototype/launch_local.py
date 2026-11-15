"""Single launcher for diagnostics, local mode and configured GigaCode."""
import argparse,json,sys,webbrowser,subprocess
from pathlib import Path
from urllib.request import urlopen

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');parser.add_argument('--gigacode',action='store_true');parser.add_argument('--port',type=int,default=8015);parser.add_argument('--no-browser',action='store_true');args=parser.parse_args()
    if sys.version_info<(3,10):print('Python 3.10+ required. Install Python and run START_LOCAL.cmd again.');return 1
    root=Path(__file__).resolve().parent
    from diagnostics import inspect,print_report
    report=inspect(root,args.port,args.check or args.gigacode);print_report(report)
    if args.check:return 0 if report['ok'] else 1
    if args.gigacode and not (root/'.local-data/ai-config.json').exists():
        try:
            from configure_gigacode import configure
            configure(root)
        except (ValueError,OSError,subprocess.TimeoutExpired) as error:print('GigaCode: '+str(error)+'\nLocal mode remains available.')
    runtime=root/'.local-data/server.json'
    try:
        saved=json.loads(runtime.read_text(encoding='utf-8'));url='http://127.0.0.1:'+str(int(saved['port']))
        with urlopen(url+'/api/health',timeout=2) as response:active=json.load(response)
        if active.get('instance')==saved.get('instance') and active.get('rootId')==saved.get('rootId'):
            print('Project already running: '+url+'/genui/')
            if not args.no_browser:webbrowser.open(url+'/genui/')
            return 0
    except (OSError,ValueError,KeyError):pass
    print('CSV errors do not overwrite accepted history. Use Quality of data in the interface.')
    from start_local import main as start
    sys.argv=[str(root/'start_local.py'),'--port',str(args.port)]+(['--no-browser'] if args.no_browser else [])
    try:start()
    except (ValueError,OSError,SystemExit) as error:print('START FAILED: '+str(error)+'\nRun DIAGNOSTICS.cmd. Keep date and .local-data.');return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
