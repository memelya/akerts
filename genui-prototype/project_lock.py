"""A process-held project lock; stale lock files do not block restart."""
import os
from pathlib import Path

class ProjectLock:
    def __init__(self,root):self.path=Path(root)/'.local-data/server.lock';self.stream=None
    def __enter__(self):
        self.path.parent.mkdir(parents=True,exist_ok=True);self.stream=self.path.open('a+b');self.stream.seek(0)
        if not self.path.stat().st_size:self.stream.write(b'0');self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.stream.close();self.stream=None;raise ValueError('Проект уже запущен. Откройте его адрес; перед обновлением закройте окно сервера.') from None
        return self
    def __exit__(self,*args):
        if self.stream:self.stream.close();self.stream=None
