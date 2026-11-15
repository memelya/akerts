"""Monthly status evidence for UI-only composition of communication events."""
from collections import defaultdict
from metric_registry import POLICY


def summarize(rows, descriptions):
    cells = defaultdict(lambda: defaultdict(lambda: {'events': 0, 'sends': 0}))
    for row in rows:
        if row['channel'] != 'communication':
            continue
        cell = cells[row['date'][:7]][str(row['status'])]
        cell['events'] += row['events']
        cell['sends'] += row['sends']
    result = {}
    for month, statuses in sorted(cells.items()):
        result[month] = []
        for code, values in sorted(statuses.items(), key=lambda item: int(item[0])):
            bucket = 'stop' if code == '1002' else 'contactPolicy' if int(code) in POLICY else None
            # Sending quantities are already included in the sending bar. Only
            # the positive unallocated remainder can be assigned by the UI.
            residual = values['events'] - values['sends'] - (values['events'] if bucket else 0)
            result[month].append(dict(values, code=code, label=descriptions.get(code, 'Статус '+code), bucket=bucket, residual=residual))
    return result
