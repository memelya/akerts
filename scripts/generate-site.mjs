import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/generate-site.mjs <path-to-pasted-text>');
  process.exit(1);
}

const root = process.cwd();
const dist = path.join(root, 'dist');
const eventsDir = path.join(dist, 'events');
const assetsDir = path.join(dist, 'assets');
const dataDir = path.join(root, 'data');

for (const directory of [dist, eventsDir, assetsDir, dataDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const statusDescriptions = {
  '-1': 'За определённый срок не было взято в обработку и было удалено',
  '0': 'По событию после всех проверок совершена коммуникация с клиентом',
  '1': 'Синхронизация с CRM: Ошибка тайм-аута CRM. Детальный статус не был присвоен.',
  '10': 'За определённый срок не стало применимым и было удалено',
  '100': 'Синхронизация с CRM: Неверный формат запроса',
  '1001': 'Время жизни события истекло',
  '1002': 'Интеграция со стоплистами массперс: Найден в стоплисте',
  '1003': 'Проверка по УК внутри ППРБ: Недавно участвовал в опросе',
  '1004': 'Интеграция с ЕПК: Не найден в ЕПК',
  '1005': 'Интеграция с ЕПК: Нет номера МБК',
  '1006': 'Интеграция с ЕПК: Не соответствует сегменту',
  '1007': 'Синхронизация с CRM: Ошибка тайм-аута CRM',
  '1008': 'Событие было не применимо на данный момент',
  '1009': 'Текст с персональными тегами не может быть подготовлен',
  '1010': 'Проверка по УК внутри ППРБ: Недавно участвовал в опросе (spec)',
  '1011': 'Проверка УК по групповой политике: Недавно участвовал в опросе группы',
  '1012': 'Интеграция с ЕПК: Нет эл. почты',
  '1013': 'Интеграция с ЕПК: Не соответствует выбранной опции «последний вход в СБОЛ»',
  '1014': 'Интеграция с ЕПК: Не тот сегмент B2C',
  '1015': 'Дубликат по epk id и event type id',
  '1016': 'Политика коммуникаций по подгруппам не пройдена (ThirdGroup)',
  '1017': 'Сегмент исключен (ThirdGroup)',
  '1018': 'Недавно опрошен по сегменту (ThirdGroup)',
  '1019': 'Канал исключен (ThirdGroup)',
  '1020': 'Политика коммуникаций по группам не пройдена (SecondGroup)',
  '1021': 'Сегмент исключен (SecondGroup)',
  '1022': 'Недавно опрошен по сегменту (SecondGroup)',
  '1023': 'Канал исключен (SecondGroup)',
  '1024': 'Не пройдена ПК по каналу коммуникации (FirstGroup)',
  '1025': 'Отключена коммуникация по телефону'
};

const sourceText = fs.readFileSync(inputPath, 'utf8');
const marker = sourceText.toLowerCase().indexOf('источник данных:');
if (marker < 0) throw new Error('Маркер «источник данных:» не найден');

const rows = [];
for (const line of sourceText.slice(marker).split(/\r?\n/)) {
  const match = line.trim().match(/^(\d{4}-\d{2})\s+(\d+)\s+(-?\d+)\s+(\d+)$/);
  if (!match) continue;
  rows.push({
    month: match[1],
    eventTypeId: Number(match[2]),
    status: Number(match[3]),
    count: Number(match[4])
  });
}

if (!rows.length) throw new Error('Строки данных не найдены');

const months = [...new Set(rows.map((row) => row.month))].sort();
const monthIndex = new Map(months.map((month, index) => [month, index]));
const grouped = new Map();

for (const row of rows) {
  if (!grouped.has(row.eventTypeId)) grouped.set(row.eventTypeId, new Map());
  const statusMap = grouped.get(row.eventTypeId);
  if (!statusMap.has(row.status)) statusMap.set(row.status, Array(months.length).fill(0));
  statusMap.get(row.status)[monthIndex.get(row.month)] += row.count;
}

const events = [...grouped.entries()]
  .map(([id, statusMap]) => {
    const statuses = [...statusMap.entries()]
      .map(([code, values]) => ({
        code,
        description: statusDescriptions[String(code)] || 'Описание не предоставлено в исходных данных',
        values,
        total: values.reduce((sum, value) => sum + value, 0),
        latest: values.at(-1) || 0
      }))
      .sort((a, b) => a.code === 0 ? -1 : b.code === 0 ? 1 : a.code - b.code);
    const totals = months.map((_, index) => statuses.reduce((sum, status) => sum + status.values[index], 0));
    const latest = totals.at(-1) || 0;
    const previous = totals.at(-2) || 0;
    const change = previous ? ((latest - previous) / previous) * 100 : null;
    const communicated = statusMap.get(0)?.at(-1) || 0;
    return {
      id,
      statuses,
      totals,
      latest,
      previous,
      change,
      communicated,
      communicationShare: latest ? (communicated / latest) * 100 : 0
    };
  })
  .sort((a, b) => a.id - b.id);

const dataset = {
  months,
  rowCount: rows.length,
  statusDescriptions,
  events: events.map(({ id, statuses, totals }) => ({ id, statuses, totals }))
};

fs.writeFileSync(path.join(dataDir, 'events.json'), JSON.stringify(dataset));
fs.writeFileSync(
  path.join(dataDir, 'source.tsv'),
  ['month\tevent_type_id\tstatus_det\tcnt', ...rows.map((row) => `${row.month}\t${row.eventTypeId}\t${row.status}\t${row.count}`)].join('\n') + '\n'
);

const numberFormat = new Intl.NumberFormat('ru-RU');
const percent = (value) => value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1).replace('.', ',')}%`;
const esc = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const overallTotals = months.map((_, index) => events.reduce((sum, event) => sum + event.totals[index], 0));
const latestMonth = months.at(-1);
const overallLatest = overallTotals.at(-1);
const overallPrevious = overallTotals.at(-2);
const overallChange = overallPrevious ? ((overallLatest - overallPrevious) / overallPrevious) * 100 : null;
const observedStatuses = [...new Set(rows.map((row) => row.status))].sort((a, b) => a - b);

function miniSpark(values, width = 160, height = 48) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 5 - ((value - min) / range) * (height - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${points}" /></svg>`;
}

function baseHead(title, description, relative = '') {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#11251f">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="${relative}assets/styles.css">
</head>`;
}

const cards = events.map((event) => {
  const changeClass = event.change === null ? 'neutral' : event.change >= 0 ? 'up' : 'down';
  const searchText = `event ${event.id} ${event.statuses.map((status) => `${status.code} ${status.description}`).join(' ')}`;
  return `<a class="event-card" href="events/${event.id}.html" data-id="${event.id}" data-latest="${event.latest}" data-change="${event.change ?? -999999}" data-search="${esc(searchText.toLowerCase())}">
    <div class="event-card__top"><span class="event-id">#${event.id}</span><span class="trend ${changeClass}">${percent(event.change)}</span></div>
    ${miniSpark(event.totals)}
    <div class="event-card__value">${numberFormat.format(event.latest)}</div>
    <div class="event-card__meta"><span>${event.statuses.length} статусов</span><span>${latestMonth}</span></div>
  </a>`;
}).join('\n');

const indexHtml = `${baseHead('Дашборд статусов событий', 'Помесячная аналитика событий по event_type_id и status_det.')}
<body class="overview-page">
  <header class="site-header">
    <a class="brand" href="index.html" aria-label="Главная">
      <span class="brand__mark"><i></i><i></i><i></i></span>
      <span><b>Events</b><small>status monitor</small></span>
    </a>
    <span class="period-pill">${months[0]} — ${months.at(-1)}</span>
  </header>
  <main>
    <section class="overview-hero">
      <div class="overview-hero__copy">
        <p class="eyebrow">ОБЗОР ПОТОКА СОБЫТИЙ</p>
        <h1>Где меняется<br><em>динамика</em></h1>
        <p class="lede">Помесячная картина обработки событий: от успешной коммуникации до каждой причины отсева.</p>
      </div>
      <div class="overview-hero__pulse">
        <div class="pulse-header"><span>Все события · ${latestMonth}</span><span class="trend ${overallChange >= 0 ? 'up' : 'down'}">${percent(overallChange)}</span></div>
        <strong>${numberFormat.format(overallLatest)}</strong>
        ${miniSpark(overallTotals, 420, 110)}
        <div class="month-row">${months.map((month) => `<span>${month.slice(5)}</span>`).join('')}</div>
      </div>
    </section>

    <section class="metric-strip" aria-label="Сводные показатели">
      <div><span>Типов событий</span><b>${events.length}</b></div>
      <div><span>Статусов в данных</span><b>${observedStatuses.length}</b></div>
      <div><span>Строк источника</span><b>${numberFormat.format(rows.length)}</b></div>
      <div><span>Месяцев</span><b>${months.length}</b></div>
    </section>

    <section class="catalogue" id="catalogue">
      <div class="section-heading">
        <div><p class="eyebrow">КАТАЛОГ</p><h2>Выберите event_type_id</h2></div>
        <span id="resultCount">${events.length} событий</span>
      </div>
      <div class="catalogue-tools">
        <label class="search-box"><span>⌕</span><input id="eventSearch" type="search" placeholder="Найти ID или статус…" autocomplete="off"></label>
        <label class="sort-box"><span>Сортировка</span><select id="eventSort"><option value="latest">По объёму</option><option value="id">По ID</option><option value="change">По динамике</option></select></label>
      </div>
      <div class="event-grid" id="eventGrid">${cards}</div>
      <div class="empty-state" id="emptyState" hidden><b>Ничего не найдено</b><span>Попробуйте другой ID или код статуса.</span></div>
    </section>
  </main>
  <footer><span>Источник: предоставленная агрегированная выборка</span><span>Пропуски по месяцам отображаются как 0</span></footer>
  <script src="assets/index.js"></script>
</body>
</html>`;

fs.writeFileSync(path.join(dist, 'index.html'), indexHtml);

const eventList = events.map((event) => ({ id: event.id, latest: event.latest }));
fs.writeFileSync(path.join(assetsDir, 'events-list.js'), `window.EVENT_LIST=${JSON.stringify(eventList)};`);

for (const event of events) {
  const changeClass = event.change === null ? 'neutral' : event.change >= 0 ? 'up' : 'down';
  const eventPayload = {
    id: event.id,
    months,
    statuses: event.statuses,
    totals: event.totals,
    latest: event.latest,
    previous: event.previous,
    change: event.change,
    communicated: event.communicated,
    communicationShare: event.communicationShare
  };
  const page = `${baseHead(`Событие ${event.id} — динамика статусов`, `Графики status_det по event_type_id ${event.id}.`, '../')}
<body class="detail-page">
  <aside class="sidebar">
    <a class="brand brand--light" href="../index.html">
      <span class="brand__mark"><i></i><i></i><i></i></span>
      <span><b>Events</b><small>status monitor</small></span>
    </a>
    <nav>
      <a href="../index.html"><span>⌂</span> Обзор</a>
      <a class="active" href="#top"><span>⌁</span> Динамика</a>
      <a href="#charts"><span>⌗</span> Статусы</a>
    </nav>
    <div class="sidebar-note"><span>Период данных</span><b>${months[0]} — ${months.at(-1)}</b><small>${months.length} месяцев · ${event.statuses.length} статусов</small></div>
  </aside>
  <main class="detail-main" id="top">
    <div class="detail-topbar">
      <a class="back-link" href="../index.html">← Все события</a>
      <label class="event-jump"><span>Перейти к ID</span><select id="eventJump" aria-label="Перейти к другому event_type_id"></select></label>
    </div>
    <section class="event-hero">
      <div>
        <p class="eyebrow">EVENT_TYPE_ID</p>
        <h1>${event.id}</h1>
        <p>Детальная динамика обработки по каждому статусу.</p>
      </div>
      <div class="hero-stamp"><span>АКТУАЛЬНЫЙ ПЕРИОД</span><b>${latestMonth}</b><small>${numberFormat.format(event.latest)} событий</small></div>
    </section>
    <section class="kpi-grid" aria-label="Показатели события">
      <article><span>Всего за ${latestMonth}</span><b>${numberFormat.format(event.latest)}</b><small>сумма всех статусов</small></article>
      <article><span>Изменение к ${months.at(-2)}</span><b class="${changeClass}">${percent(event.change)}</b><small>${numberFormat.format(event.previous)} ранее</small></article>
      <article><span>Коммуникации</span><b>${numberFormat.format(event.communicated)}</b><small>${event.communicationShare.toFixed(1).replace('.', ',')}% от объёма</small></article>
      <article><span>Активных статусов</span><b>${event.statuses.length}</b><small>за весь период</small></article>
    </section>
    <section class="chart-section" id="charts">
      <div class="section-heading section-heading--charts"><div><p class="eyebrow">STATUS_DET</p><h2>Кривые изменения</h2></div><span>${event.statuses.length} отдельных графиков</span></div>
      <div class="chart-grid" id="chartGrid" aria-live="polite"></div>
    </section>
    <footer><span>event_type_id ${event.id}</span><span>Пропуски по месяцам отображаются как 0</span></footer>
  </main>
  <div class="chart-tooltip" id="chartTooltip" hidden></div>
  <script>window.EVENT_DATA=${JSON.stringify(eventPayload)};</script>
  <script src="../assets/events-list.js"></script>
  <script src="../assets/dashboard.js"></script>
</body>
</html>`;
  fs.writeFileSync(path.join(eventsDir, `${event.id}.html`), page);
}

const styles = `
:root{--ink:#10221d;--muted:#687771;--paper:#f3f1e9;--card:#fffef9;--line:#dcded7;--lime:#c9ff57;--mint:#64d7ac;--coral:#ff826f;--blue:#5f8dff;--shadow:0 18px 50px rgba(29,47,41,.09);font-family:Inter,"Segoe UI",Arial,sans-serif;color:var(--ink);background:var(--paper);font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-width:320px}a{color:inherit;text-decoration:none}button,input,select{font:inherit}::selection{background:var(--lime);color:var(--ink)}
.site-header{height:86px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(24px,5vw,78px);border-bottom:1px solid rgba(16,34,29,.1)}
.brand{display:flex;align-items:center;gap:12px;text-transform:uppercase;letter-spacing:.08em}.brand>span:last-child{display:flex;flex-direction:column}.brand b{font-size:15px;line-height:1}.brand small{font-size:8px;letter-spacing:.18em;margin-top:4px;color:var(--muted)}
.brand__mark{width:34px;height:34px;border-radius:50%;background:var(--ink);display:flex;align-items:flex-end;justify-content:center;gap:3px;padding:9px}.brand__mark i{display:block;width:3px;border-radius:3px;background:var(--lime)}.brand__mark i:nth-child(1){height:8px}.brand__mark i:nth-child(2){height:15px}.brand__mark i:nth-child(3){height:11px}
.period-pill{padding:9px 14px;border:1px solid rgba(16,34,29,.15);border-radius:999px;font-size:12px;color:var(--muted);letter-spacing:.05em}
.overview-page main{max-width:1460px;margin:0 auto;padding:0 clamp(24px,5vw,78px)}
.overview-hero{display:grid;grid-template-columns:minmax(280px,.8fr) minmax(440px,1.2fr);gap:clamp(36px,7vw,110px);align-items:center;padding:clamp(70px,10vw,135px) 0 70px}
.eyebrow{font-size:11px;letter-spacing:.2em;font-weight:800;color:#4b6d61;margin:0 0 18px}.overview-hero h1{font-size:clamp(58px,8vw,116px);line-height:.82;letter-spacing:-.07em;margin:0;font-weight:750}.overview-hero h1 em{font-family:Georgia,serif;font-weight:400;color:#3f7868}.lede{max-width:480px;color:var(--muted);font-size:17px;line-height:1.65;margin:32px 0 0}
.overview-hero__pulse{background:var(--ink);color:#fff;border-radius:30px;padding:clamp(28px,4vw,48px);box-shadow:0 30px 80px rgba(16,34,29,.22);overflow:hidden;position:relative}.overview-hero__pulse:before{content:"";position:absolute;inset:-70% -20% auto 45%;aspect-ratio:1;border-radius:50%;background:rgba(201,255,87,.08)}.pulse-header{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#a6b4ae;text-transform:uppercase;letter-spacing:.1em}.overview-hero__pulse>strong{display:block;font-size:clamp(40px,5vw,76px);letter-spacing:-.05em;margin:25px 0 12px}.spark{display:block;width:100%;height:auto;overflow:visible}.spark polyline{fill:none;stroke:var(--lime);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.month-row{display:flex;justify-content:space-between;font-size:9px;color:#81918a;margin-top:7px}
.trend{font-size:11px;font-weight:800;letter-spacing:.02em}.trend.up,.up{color:#207f5e}.trend.down,.down{color:#c84b44}.overview-hero__pulse .trend.up{color:var(--lime)}.overview-hero__pulse .trend.down{color:#ff9e8e}.neutral{color:var(--muted)}
.metric-strip{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:110px}.metric-strip>div{padding:30px 25px;border-right:1px solid var(--line)}.metric-strip>div:first-child{padding-left:0}.metric-strip>div:last-child{border:0}.metric-strip span{display:block;color:var(--muted);font-size:12px;margin-bottom:9px}.metric-strip b{font-size:30px;letter-spacing:-.04em}
.catalogue{padding-bottom:80px}.section-heading{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:28px}.section-heading h2{font-size:clamp(32px,4vw,54px);letter-spacing:-.05em;margin:0}.section-heading>span{font-size:12px;color:var(--muted);padding-bottom:8px}.catalogue-tools{display:flex;gap:12px;margin-bottom:24px}.search-box,.sort-box{height:52px;background:var(--card);border:1px solid var(--line);border-radius:14px;display:flex;align-items:center}.search-box{flex:1;gap:10px;padding:0 18px}.search-box span{font-size:24px;transform:rotate(-15deg);color:var(--muted)}.search-box input{border:0;outline:0;background:transparent;width:100%;color:var(--ink)}.sort-box{padding:0 14px;gap:12px}.sort-box>span{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.sort-box select,.event-jump select{border:0;background:transparent;color:var(--ink);font-weight:700;outline:0}
.event-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.event-card{background:var(--card);border:1px solid transparent;border-radius:19px;padding:21px;min-height:214px;display:flex;flex-direction:column;transition:transform .2s,border-color .2s,box-shadow .2s}.event-card:hover{transform:translateY(-4px);border-color:#bbd1c8;box-shadow:var(--shadow)}.event-card__top{display:flex;justify-content:space-between;align-items:center}.event-id{font-weight:800;font-size:14px;letter-spacing:.02em}.event-card .spark{height:48px;margin:20px 0 13px}.event-card .spark polyline{stroke:#3e806d;stroke-width:2}.event-card__value{font-size:27px;font-weight:750;letter-spacing:-.04em}.event-card__meta{display:flex;justify-content:space-between;color:var(--muted);font-size:10px;margin-top:auto}.empty-state{text-align:center;padding:90px 20px;border:1px dashed #bac5bf;border-radius:20px}.empty-state b,.empty-state span{display:block}.empty-state span{color:var(--muted);margin-top:8px}
footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:11px}.overview-page>footer{margin:0 clamp(24px,5vw,78px)}
.sidebar{position:fixed;inset:0 auto 0 0;width:248px;background:var(--ink);color:white;padding:30px 24px;display:flex;flex-direction:column;z-index:5}.brand--light .brand__mark{background:var(--lime)}.brand--light .brand__mark i{background:var(--ink)}.brand--light small{color:#8fa29b}.sidebar nav{display:flex;flex-direction:column;gap:6px;margin-top:74px}.sidebar nav a{padding:13px 15px;border-radius:11px;color:#9eb0aa;font-size:13px;display:flex;gap:12px;align-items:center}.sidebar nav a span{font-size:18px}.sidebar nav a:hover,.sidebar nav a.active{background:rgba(255,255,255,.08);color:white}.sidebar nav a.active:after{content:"";margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--lime)}.sidebar-note{margin-top:auto;padding:18px;border:1px solid rgba(255,255,255,.1);border-radius:14px;display:flex;flex-direction:column}.sidebar-note span{font-size:9px;letter-spacing:.14em;color:#8fa29b}.sidebar-note b{font-size:13px;margin:9px 0}.sidebar-note small{font-size:10px;color:#8fa29b}
.detail-main{margin-left:248px;min-height:100vh;padding:0 clamp(24px,5vw,70px)}.detail-topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.back-link{font-size:12px;color:var(--muted)}.back-link:hover{color:var(--ink)}.event-jump{display:flex;align-items:center;gap:12px}.event-jump>span{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.event-jump select{min-width:110px;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:9px 12px}
.event-hero{display:flex;justify-content:space-between;align-items:flex-end;padding:64px 0 48px}.event-hero h1{font-size:clamp(72px,10vw,142px);line-height:.75;letter-spacing:-.07em;margin:0}.event-hero>div:first-child>p:last-child{color:var(--muted);margin:28px 0 0}.hero-stamp{min-width:210px;border-left:3px solid var(--lime);padding:7px 0 7px 18px;display:flex;flex-direction:column}.hero-stamp span{font-size:9px;letter-spacing:.14em;color:var(--muted)}.hero-stamp b{font-size:24px;margin:6px 0}.hero-stamp small{font-size:11px;color:var(--muted)}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);background:var(--card);border:1px solid var(--line);border-radius:20px;margin-bottom:84px}.kpi-grid article{padding:25px;border-right:1px solid var(--line)}.kpi-grid article:last-child{border-right:0}.kpi-grid span,.kpi-grid small{display:block;color:var(--muted);font-size:10px}.kpi-grid b{display:block;font-size:29px;letter-spacing:-.04em;margin:12px 0 8px}
.section-heading--charts{padding-bottom:22px;border-bottom:1px solid var(--line)}.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:28px 0 90px}.chart-card{background:var(--card);border:1px solid rgba(16,34,29,.08);border-radius:20px;padding:24px;box-shadow:0 4px 16px rgba(16,34,29,.025)}.chart-card__header{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px}.status-chip{flex:none;padding:7px 9px;border-radius:9px;background:var(--ink);color:white;font-size:11px;font-weight:800}.chart-card__title{min-width:0}.chart-card__title h3{font-size:14px;margin:0 0 7px}.chart-card__title p{color:var(--muted);font-size:10px;line-height:1.45;margin:0;min-height:28px}.chart-card__latest{margin-left:auto;text-align:right;white-space:nowrap}.chart-card__latest b{display:block;font-size:18px}.chart-card__latest small{font-size:9px;color:var(--muted)}.chart-wrap{position:relative}.status-chart{display:block;width:100%;height:auto;overflow:visible}.status-chart text{font-family:Inter,"Segoe UI",Arial,sans-serif}.grid-line{stroke:#e4e6df;stroke-width:1}.axis-label{fill:#84918c;font-size:9px}.point-label{fill:var(--ink);font-size:8px;font-weight:700;paint-order:stroke;stroke:var(--card);stroke-width:4px;stroke-linejoin:round}.chart-line{fill:none;stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round}.chart-area{opacity:.09}.chart-point{stroke:var(--card);stroke-width:3;cursor:pointer;transition:r .15s}.chart-point:hover{r:6}.data-table{margin-top:12px;border-top:1px solid var(--line);padding-top:12px}.data-table summary{cursor:pointer;color:var(--muted);font-size:10px}.data-table table{width:100%;border-collapse:collapse;margin-top:12px;font-size:10px}.data-table td,.data-table th{padding:6px;border-bottom:1px solid #ecece7;text-align:right}.data-table th:first-child,.data-table td:first-child{text-align:left}.chart-tooltip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:white;border-radius:9px;padding:9px 11px;font-size:11px;box-shadow:0 10px 30px rgba(16,34,29,.25)}.chart-tooltip b{display:block;margin-top:3px;color:var(--lime)}
@media(max-width:1100px){.event-grid{grid-template-columns:repeat(3,1fr)}.chart-grid{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(2,1fr)}.kpi-grid article:nth-child(2){border-right:0}.kpi-grid article:nth-child(-n+2){border-bottom:1px solid var(--line)}}
@media(max-width:800px){.overview-hero{grid-template-columns:1fr;padding-top:65px}.overview-hero__pulse{order:-1}.event-grid{grid-template-columns:repeat(2,1fr)}.metric-strip{grid-template-columns:repeat(2,1fr)}.metric-strip>div:nth-child(2){border-right:0}.metric-strip>div:nth-child(-n+2){border-bottom:1px solid var(--line)}.sidebar{position:static;width:auto;height:72px;padding:0 20px;flex-direction:row;align-items:center}.sidebar nav{margin:0 0 0 auto;flex-direction:row}.sidebar nav a{padding:9px}.sidebar nav a span,.sidebar nav a:after,.sidebar nav a:not(.active){display:none}.sidebar-note{display:none}.detail-main{margin-left:0}.event-hero{padding-top:48px}}
@media(max-width:560px){.site-header{height:70px}.period-pill{display:none}.overview-page main{padding:0 18px}.overview-hero h1{font-size:62px}.overview-hero__pulse{padding:25px;border-radius:22px}.metric-strip{margin-bottom:72px}.catalogue-tools{flex-direction:column}.sort-box{justify-content:space-between}.event-grid{grid-template-columns:1fr 1fr;gap:8px}.event-card{padding:16px;min-height:185px}.event-card__value{font-size:21px}.event-card .spark{margin:14px 0}.event-card__meta span:first-child{display:none}.detail-main{padding:0 16px}.detail-topbar{height:66px}.event-jump>span{display:none}.event-hero{display:block}.event-hero h1{font-size:90px}.hero-stamp{margin-top:38px}.kpi-grid{grid-template-columns:1fr 1fr}.kpi-grid article{padding:18px}.kpi-grid b{font-size:23px}.chart-card{padding:16px}.chart-card__header{flex-wrap:wrap}.chart-card__latest{width:100%;text-align:left;margin-left:47px}.section-heading--charts{align-items:flex-start;gap:10px}.section-heading--charts>span{max-width:90px;text-align:right}.overview-page>footer,footer{flex-direction:column}.sidebar nav a.active{font-size:0}.sidebar nav a.active span{display:block;font-size:20px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;
fs.writeFileSync(path.join(assetsDir, 'styles.css'), styles.trim() + '\n');

const indexJs = `
const grid=document.getElementById('eventGrid');
const cards=[...grid.querySelectorAll('.event-card')];
const search=document.getElementById('eventSearch');
const sort=document.getElementById('eventSort');
const count=document.getElementById('resultCount');
const empty=document.getElementById('emptyState');
const plural=n=>{const d=n%10,h=n%100;return h>=11&&h<=14?'событий':d===1?'событие':d>=2&&d<=4?'события':'событий'};
function update(){
  const query=search.value.trim().toLowerCase();
  let visible=cards.filter(card=>!query||card.dataset.search.includes(query));
  const key=sort.value;
  visible.sort((a,b)=>key==='id'?Number(a.dataset.id)-Number(b.dataset.id):key==='change'?Number(b.dataset.change)-Number(a.dataset.change):Number(b.dataset.latest)-Number(a.dataset.latest));
  cards.forEach(card=>card.hidden=true);
  visible.forEach(card=>{card.hidden=false;grid.append(card)});
  count.textContent=visible.length+' '+plural(visible.length);
  empty.hidden=visible.length!==0;
}
search.addEventListener('input',update);sort.addEventListener('change',update);update();
`;
fs.writeFileSync(path.join(assetsDir, 'index.js'), indexJs.trim() + '\n');

const dashboardJs = `
const data=window.EVENT_DATA;
const nf=new Intl.NumberFormat('ru-RU');
const compact=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
const monthNames=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
const monthLabel=value=>{const [year,month]=value.split('-');return monthNames[Number(month)-1]+' '+year.slice(2)};
const jump=document.getElementById('eventJump');
window.EVENT_LIST.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent='#'+item.id+(item.id===data.id?' · текущий':'');option.selected=item.id===data.id;jump.append(option)});
jump.addEventListener('change',()=>location.href=jump.value+'.html');
const tooltip=document.getElementById('chartTooltip');
const colorFor=code=>{if(code===0)return '#2ca77c';let n=Math.abs(Number(code));return ['#5f8dff','#f17665','#8a6fe8','#df9b39','#32a4b8','#cc5c8d'][n%6]};
function smoothPath(points){if(points.length<2)return points.length?'M'+points[0][0]+','+points[0][1]:'';let d='M'+points[0][0]+','+points[0][1];for(let i=0;i<points.length-1;i++){const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;const c1=[p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6];const c2=[p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6];d+=' C'+c1[0].toFixed(1)+','+c1[1].toFixed(1)+' '+c2[0].toFixed(1)+','+c2[1].toFixed(1)+' '+p2[0].toFixed(1)+','+p2[1].toFixed(1)}return d}
function niceMax(value){if(value<=0)return 1;const power=10**Math.floor(Math.log10(value));const ratio=value/power;const nice=ratio<=1?1:ratio<=2?2:ratio<=5?5:10;return nice*power}
function renderChart(status){
  const width=720,height=270,pad={top:45,right:20,bottom:38,left:62};
  const plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const max=niceMax(Math.max(...status.values));
  const points=status.values.map((value,index)=>[pad.left+(index/(status.values.length-1))*plotW,pad.top+plotH-(value/max)*plotH]);
  const line=smoothPath(points),area=line+' L'+points.at(-1)[0]+','+(pad.top+plotH)+' L'+points[0][0]+','+(pad.top+plotH)+' Z';
  const color=colorFor(status.code);
  const ticks=[0,.25,.5,.75,1].map(f=>{const y=pad.top+plotH-f*plotH;return '<line class="grid-line" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"/><text class="axis-label" x="'+(pad.left-10)+'" y="'+(y+3)+'" text-anchor="end">'+compact.format(max*f)+'</text>'}).join('');
  const months=data.months.map((month,index)=>'<text class="axis-label" x="'+points[index][0]+'" y="'+(height-10)+'" text-anchor="middle">'+monthLabel(month)+'</text>').join('');
  const pointEls=points.map((point,index)=>'<g><circle class="chart-point" data-index="'+index+'" cx="'+point[0]+'" cy="'+point[1]+'" r="4" fill="'+color+'"/><text class="point-label" x="'+point[0]+'" y="'+Math.max(point[1]-11,14)+'" text-anchor="middle">'+nf.format(status.values[index])+'</text></g>').join('');
  const rows=data.months.map((month,index)=>'<tr><td>'+month+'</td><td>'+nf.format(status.values[index])+'</td></tr>').join('');
  const card=document.createElement('article');card.className='chart-card';
  card.innerHTML='<header class="chart-card__header"><span class="status-chip">'+status.code+'</span><div class="chart-card__title"><h3>Статус '+status.code+'</h3><p>'+status.description+'</p></div><div class="chart-card__latest"><b>'+nf.format(status.latest)+'</b><small>'+data.months.at(-1)+'</small></div></header><div class="chart-wrap"><svg class="status-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Динамика статуса '+status.code+'">'+ticks+months+'<path class="chart-area" d="'+area+'" fill="'+color+'"/><path class="chart-line" d="'+line+'" stroke="'+color+'"/>'+pointEls+'</svg></div><details class="data-table"><summary>Показать таблицу значений</summary><table><thead><tr><th>Месяц</th><th>Количество</th></tr></thead><tbody>'+rows+'</tbody></table></details>';
  card.querySelectorAll('.chart-point').forEach(point=>{point.addEventListener('pointerenter',event=>{const index=Number(point.dataset.index);tooltip.innerHTML=data.months[index]+'<b>'+nf.format(status.values[index])+'</b>';tooltip.hidden=false;const rect=event.target.getBoundingClientRect();tooltip.style.left=Math.min(rect.left,innerWidth-130)+'px';tooltip.style.top=Math.max(8,rect.top-58)+'px'});point.addEventListener('pointerleave',()=>tooltip.hidden=true)});
  return card;
}
const chartGrid=document.getElementById('chartGrid');
data.statuses.forEach(status=>chartGrid.append(renderChart(status)));
`;
fs.writeFileSync(path.join(assetsDir, 'dashboard.js'), dashboardJs.trim() + '\n');

console.log(JSON.stringify({ rows: rows.length, events: events.length, statuses: observedStatuses.length, months, output: dist }, null, 2));
