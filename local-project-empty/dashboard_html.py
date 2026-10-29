"""Use the shipped V2 interface; replace its data and numeric content before serving."""
import html
import json
import re


def escape(value):
    return html.escape(str(value if value is not None else ''), quote=True)


def number(value):
    return format(value, ',').replace(',', '\u00a0') if value is not None else 'Нет данных'


def payload(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).replace('<', '\\u003c')


def replace_json(text, ident, value):
    pattern = r'(<script[^>]*id="' + re.escape(ident) + r'"[^>]*>)[\s\S]*?(</script>)'
    return re.sub(pattern, lambda match: match[1] + payload(value) + match[2], text)


def management(survey):
    event, meta = survey['event'], survey['meta']
    plan, actual = meta.get('plan'), meta['actual']
    target = plan*meta['elapsed']/meta['total'] if plan and meta['total'] else None
    risk = bool(plan and actual is not None and target and actual < target)
    return {'id': event['id'], 'name': meta['name'], 'channel': meta['channel'], 'isTop': event['isTop'], 'hasData': event['hasData'], 'plan': plan, 'actual': actual, 'answers': actual, 'delta': None, 'csi': meta['csi'], 'forecast': meta['forecast'], 'action': meta['action'], 'remaining': meta['remaining'], 'averageActual': meta['average'], 'planStatus': 'risk' if risk else 'ontrack' if plan and actual is not None else 'noplan', 'risk': risk, 'asOf': meta['sourceThrough'], 'events': event['latest'], 'sends': meta['sends'], 'planProgress': actual/plan*100 if plan and actual is not None else None, 'periodProgress': actual/target*100 if target and actual is not None else None, 'sourceMonth': meta['sourceMonth']}


def card(survey, rank):
    event, meta = survey['event'], survey['meta']
    row = management(survey)
    attrs = {'id': event['id'], 'survey-type': meta['surveyTypeKey'], 'search': '%s %s' % (event['id'], meta['name'].lower()), 'top': str(event['isTop']).lower(), 'rank': rank, 'channel': meta['channel'], 'has-data': str(event['hasData']).lower(), 'latest': (meta['actual'] or 0) if meta.get('plan') else event['latest'], 'change': -999999, 'plan-status': row['planStatus'], 'name': meta['name'], 'events': event['latest'], 'sends': meta['sends'] if meta['sends'] is not None else '', 'responses': meta['actual'] if meta['actual'] is not None else '', 'rate': meta['actual']/meta['sends']*100 if meta['sends'] and meta['actual'] is not None else '', 'csi': meta['csi'] if meta['csi'] is not None else '', 'plan-progress': row['planProgress'] if row['planProgress'] is not None else ''}
    attributes = ' '.join('data-%s="%s"' % (key, escape(value)) for key, value in attrs.items())
    # V2 adds its established metric grid, receipts and workspace buttons to this shell.
    volume = number(event['latest'])+' событий · '+meta['month'] if meta['hasCurrent'] else 'Нет наблюдений за '+meta['month']
    return '<a class="event-card%s" href="events/%s.html" %s><div class="event-card__top"><span class="event-id">#%s</span><div class="card-actions"><button class="compare-pick" type="button" aria-pressed="false">＋ Сравнить</button><button class="card-expand" type="button" aria-label="Развернуть карточку">Развернуть</button></div></div><h3>%s</h3><p class="local-card-volume">%s</p><p class="local-card-action">%s</p></a>' % (' event-card--top' if event['isTop'] else '', event['id'], attributes, event['id'], escape(meta['name']), escape(volume), escape(meta['action']))


def alerts(survey, months):
    event, meta = survey['event'], survey['meta']
    output = []
    for index in range(1, len(months)-1):
        before, after = months[index-1], months[index]
        if before not in meta['availableMonths'] or after not in meta['availableMonths']:
            continue
        for status in [{'code': 'Все события', 'description': 'Все события', 'values': event['totals']}, *event['statuses']]:
            old, new = status['values'][index-1:index+1]
            if not old or abs(new-old)/old <= .1:
                continue
            change = (new-old)/old*100
            output.append('<article class="alert-item alert-item--%s" data-alert-period="%s"><span class="status-chip">%s</span><div class="alert-item__content"><h3>%s</h3><p>%s → %s · %s → %s · %+.1f%%</p></div></article>' % ('up' if change > 0 else 'down', 'latest' if index == len(months)-2 else 'other', escape(status['code']), escape(status['description']), before, after, number(old), number(new), change))
    return '<section class="alert-panel" id="alerts"><header class="alert-panel__header"><h2>Изменения больше 10%%</h2><span class="alert-count">%s сигналов</span></header><p>Сравнения полных предыдущих месяцев. Последний месяц исключён как потенциально неполный.</p><div class="alert-summary"><button class="active" data-alert-filter="up">Рост</button><button class="active" data-alert-filter="down">Снижение</button><button class="active" data-alert-period-filter="latest">Последний полный месяц</button><button data-alert-period-filter="other">Остальные</button></div>%s</section>' % (len(output), ''.join(reversed(output)) or '<p>Сопоставимых изменений нет.</p>')


def banner(status, prefix):
    error = status.get('error')
    body = '<b>Локальные данные</b><span>CSV перечитаны при открытии страницы. Совпадающие записи заменяются. Ранее принятые даты сохраняются в истории проекта.</span>'
    for file in status.get('files', []):
        body += '<span>%s · %s строк · %s%s</span>' % (escape(file['file']), number(file.get('rows', 0)), escape(file.get('modified', 'файл не найден')), ' · повторов: %s, использована последняя строка' % file['duplicates'] if file.get('duplicates') else '')
    if error:
        body += '<strong role="alert">CSV не применены: %s. Показаны последние успешно принятые данные.</strong>' % escape(error)
    body += '<div><button type="button" onclick="location.reload()">Обновить данные</button><a href="%sREADME.html">Как обновлять CSV</a></div>' % prefix
    return '<section class="local-source-banner%s" aria-label="Локальные источники">%s</section>' % (' local-source-error' if error else '', body)


def attention_items(surveys):
    items = []
    for survey in surveys:
        event, meta = survey['event'], survey['meta']
        row = management(survey)
        actual, progress = meta['actual'], row['periodProgress']
        if meta.get('plan') and (not meta['hasCurrent'] or actual is None):
            kind, description = 'Нет данных', 'Нет наблюдений по ответам за '+meta['month']+'. Выполнение плана не оценивается.'
        elif progress is not None and progress < 100:
            kind, description = 'Дефицит к плану', 'План за период выполнен на %.1f%%.' % progress
        elif actual is not None and actual < 30:
            kind, description = 'Маленькая выборка', 'Учтено %s ответов за %s.' % (number(actual), meta['month'])
        else:
            continue
        if meta['missingDates']:
            description += ' Выборка неполная: в месячном итоге только переданные даты.'
        items.append('<article class="attention-item attention-item--critical" data-type="%s" data-plan="%s" data-csi-drop="0" data-rate-drop="0" data-events-drop="0" data-sample="%s"><span class="attention-rank">%s</span><div class="attention-copy"><small>%s</small><h3>#%s · %s</h3><p>%s</p></div><a href="events/%s.html">Открыть опрос →</a></article>' % (kind, progress if progress is not None else 0, actual if actual is not None else 0, len(items)+1, kind, event['id'], escape(meta['name']), escape(description), event['id']))
    return ''.join(items)


def render_page(text, route, state, status, baseline):
    text = re.sub(r'<!--local-static-warning:start-->[\s\S]*?<!--local-static-warning:end-->', '', text)
    surveys, months = state['surveys'], state['months']
    by_id = {s['event']['id']: s for s in surveys}
    detail = re.search(r'/events/(\d+)\.html$', route)
    prefix = '../../' if detail else '../'
    css_prefix = '../' if detail else ''
    text = text.replace('</head>', '<link rel="stylesheet" href="'+css_prefix+'assets/local-data.css"></head>')
    text = re.sub(r'(<main\b[^>]*>)', lambda match: match[1] + banner(status, prefix), text, count=1)
    meta = {str(s['event']['id']): s['meta'] for s in surveys}
    text = replace_json(text, 'generalData', state['general'])
    text = replace_json(text, 'analysisData', state['analysis'])
    rows = [management(s) for s in surveys]
    risk_ids = [r['id'] for r in rows if r['risk']]
    text = replace_json(text, 'managementData', {'period': months[-1] if months else None, 'issueIds': risk_ids, 'rows': rows})
    text = re.sub(r'(<span class="period-pill">)[\s\S]*?(</span>)', lambda m: m[1]+(months[0]+' — '+months[-1] if months else 'Данные не загружены')+m[2], text)
    if not surveys:
        notice = '<section class="local-empty" role="status"><h2>Данные пока не загружены</h2><p>Добавьте свои выгрузки в date/push-sms.csv и date/success-screen.csv, затем нажмите «Обновить данные» или F5. Встроенной истории в этой версии нет.</p></section>'
        text = re.sub(r'(<main\b[^>]*>)', lambda m: m[1]+notice, text, count=1)
    text = re.sub(r'(<a[^>]*class="attention-link"[^>]*>[\s\S]*?<b>)[\s\S]*?(</b>)', lambda m: m[1]+str(len(risk_ids))+m[2], text)
    if detail:
        ident = int(detail[1])
        if ident not in by_id:
            return '<!doctype html><meta charset="utf-8"><h1>Опрос %s не найден</h1><p>Добавьте его строки в CSV и обновите страницу.</p><a href="../index.html">К опросам</a>' % ident
        survey = by_id[ident]
        event, item = survey['event'], survey['meta']
        text = re.sub(r'window\.EVENT_DATA=[\s\S]*?;</script>', lambda m: 'window.EVENT_DATA='+payload(event)+';</script>', text)
        text = replace_json(text, 'v2Meta', item)
        text = replace_json(text, 'currentPeriodData', survey['period'])
        text = replace_json(text, 'surveyOverviewData', survey['overview'])
        text = re.sub(r'<title>[\s\S]*?</title>', lambda m: '<title>Опрос %s · %s</title>' % (ident, escape(item['name'])), text, count=1)
        text = re.sub(r'(<section class="event-hero">[\s\S]*?<h1>)[\s\S]*?(</h1>)', lambda m: m[1]+str(ident)+m[2], text, count=1)
        text = re.sub(r'(<h2 class="survey-detail-name">)[\s\S]*?(</h2>)', lambda m: m[1]+escape(item['name'])+m[2], text)
        text = re.sub(r'<div class="hero-stamp">[\s\S]*?</div>', lambda m: '<div class="hero-stamp"><span>АКТУАЛЬНЫЙ ПЕРИОД</span><b>%s</b><small>%s событий</small></div>' % (months[-1], number(event['latest'])), text)
        screen = item['channel'] == 'success_screen'
        kpi = '<section class="kpi-grid" aria-label="Показатели опроса">'
        for title, value, note in [('События за '+months[-1], event['latest'] if item['hasCurrent'] else None, 'Сумма всех статусов'), ('Изменение к прошлому месяцу', 'Не считается', 'Последний месяц может быть неполным'), ('Ответы ЭУ' if screen else 'Отправки', item['actual'] if screen else item['sends'], 'По актуальной выборке'), ('CSI', ('%.2f' % item['csi']).replace('.', ',') if item['csi'] is not None else None, 'Средняя оценка от 1 до 5')]:
            kpi += '<article><span>%s</span><b>%s</b><small>%s</small></article>' % (escape(title), number(value) if isinstance(value, (int, float)) else escape(value) if value is not None else 'Нет данных', note)
        kpi += '</section>'
        text = re.sub(r'<section class="kpi-grid"[\s\S]*?</section>', lambda m: kpi, text, count=1)
        text = re.sub(r'<p class="source-note"[\s\S]*?</p>', '', text)
        text = re.sub(r'<section class="alert-panel"[\s\S]*?</section>', lambda m: alerts(survey, months), text, count=1)
        text = re.sub(r'<section class="status-section"[\s\S]*?</section>', '', text)
        text = re.sub(r'<section class="status-table-section"[\s\S]*?</section>', '', text)
        text = re.sub(r'(<div class="sidebar-note">)[\s\S]*?(</div>)', lambda m: m[1]+'<span>Период данных</span><b>'+months[0]+' — '+months[-1]+'</b><small>'+str(len(months))+' месяцев · '+str(len(event['statuses']))+' статусов</small>'+m[2], text)
        text = re.sub(r'\d+ отдельных графиков', str(len(event['statuses'])+3)+' отдельных графиков', text)
        if screen:
            text = text.replace('>STATUS_DET<', '>MP_STATUS<')
        text = re.sub(r'<footer>[\s\S]*?</footer>', '<footer><span>Локальный проект · CSV из папки date</span><span>Пропуски не считаются нулями</span><a href="../index.html">К опросам</a></footer>', text)
    else:
        text = replace_json(text, 'v2Meta', meta if route.endswith(('index.html', 'top.html', 'others.html')) else {})
        if route.endswith('attention.html'):
            text = re.sub(r'(<section class="attention-list"[^>]*>)[\s\S]*?(</section>)', lambda match: match[1]+attention_items(surveys)+match[2], text)
            text = text.replace('Приоритетная очередь проблем: от максимального влияния к минимальному.', 'План и полнота текущей выборки пересчитаны по локальным CSV. Неполные периоды отмечены явно.')
        if re.search(r'<a class="event-card', text) or '<!--local-cards-->' in text:
            selected = surveys if route.endswith('index.html') else [s for s in surveys if s['event']['isTop'] == route.endswith('top.html')]
            ranks = {row['event']['id']: baseline.get('ranks', {}).get(str(row['event']['id']), 999999+row['event']['id']) for row in surveys}
            cards = ''.join(card(s, ranks[s['event']['id']]) for s in selected)
            text = text.replace('<!--local-cards-->', cards)
            first = True
            def insert(match):
                nonlocal first
                if first:
                    first = False
                    return cards
                return ''
            text = re.sub(r'<a class="event-card\b[^>]*>[\s\S]*?</a>', insert, text)
        text = re.sub(r'(<button[^>]*data-scope="(top|all)"[^>]*>[\s\S]*?<span>)[\s\S]*?(</span>)', lambda m: m[1]+str(sum(s['event']['isTop'] for s in surveys) if m[2]=='top' else len(surveys))+m[3], text)
    # The selector contains dynamically added survey IDs too.
    event_list = [{'id': s['event']['id'], 'latest': s['event']['latest'], 'hasData': s['event']['hasData'], 'isTop': s['event']['isTop']} for s in surveys]
    text = re.sub(r'<script[^>]*src="[^"]*events-list\.js[^>]*></script>', lambda m: '<script>window.EVENT_LIST='+payload(event_list)+';</script>', text)
    return text
