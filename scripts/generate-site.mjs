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

// Приоритетный список опросов предоставлен заказчиком. Порядок значим:
// в режиме «Топ опросы» карточки идут именно в этой последовательности.
const topSurveyIds = [
  32, 35, 154, 155, 160, 217, 239, 240, 241, 244, 245, 273, 278, 298,
  317, 363, 364, 408, 413, 414, 448, 480, 514, 543, 544, 567, 568, 573,
  578, 582, 584, 585, 588, 589, 730, 731, 733, 738, 739, 741, 744, 745,
  746, 749, 772, 784, 794, 800, 895, 1007, 1412, 1427, 1428, 1434, 1593,
  1595, 1597, 1598, 1805, 2825, 3106, 3113, 3115, 3117, 3118, 3126,
  3127, 3129, 3130, 3131, 3133, 3135, 3136, 3141, 3142, 3149, 3155,
  3156, 3158, 3169, 3434, 4010, 4011, 4021, 4026, 4027, 4028, 4104,
  4153, 5008, 5009, 9845, 93139, 193, 192
];
const topSurveySet = new Set(topSurveyIds);
const topSurveyRank = new Map(topSurveyIds.map((id, index) => [id, index]));

const sourceText = fs.readFileSync(inputPath, 'utf8');
const isQaSupplement = /month,event_type_id,status_det,cnt,qa_cnt/i.test(sourceText);
const qaByKey = new Map();
let rows = [];

if (isQaSupplement) {
  for (const line of sourceText.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d{4}-\d{2}),(\d+),(-?\d+),(\d+),(\d+)$/);
    if (!match || Number(match[3]) !== 0) continue;
    qaByKey.set(`${match[1]}|${match[2]}|0`, Number(match[5]));
  }
  const baseSourcePath = path.join(dataDir, 'source.tsv');
  if (!fs.existsSync(baseSourcePath)) throw new Error('Для дополнения qa_cnt не найден базовый data/source.tsv');
  for (const line of fs.readFileSync(baseSourcePath, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d{4}-\d{2})\t(\d+)\t(-?\d+)\t(\d+)(?:\t(\d*))?$/);
    if (!match) continue;
    const status = Number(match[3]);
    rows.push({
      month: match[1], eventTypeId: Number(match[2]), status, count: Number(match[4]),
      qaCount: status === 0 ? (qaByKey.get(`${match[1]}|${match[2]}|0`) ?? (match[5] ? Number(match[5]) : null)) : null
    });
  }
} else {
  const marker = sourceText.toLowerCase().indexOf('источник данных:');
  if (marker < 0) throw new Error('Маркер «источник данных:» не найден');
  for (const line of sourceText.slice(marker).split(/\r?\n/)) {
    const match = line.trim().match(/^(\d{4}-\d{2})\s+(\d+)\s+(-?\d+)\s+(\d+)$/);
    if (!match) continue;
    rows.push({ month: match[1], eventTypeId: Number(match[2]), status: Number(match[3]), count: Number(match[4]), qaCount: null });
  }
}

if (!rows.length) throw new Error('Строки данных не найдены');

const months = [...new Set(rows.map((row) => row.month))].sort();
// Октябрь 2026 ещё не завершён, поэтому сравнения, где он является
// конечным месяцем, временно исключаются из процентов и алертов.
const excludedComparisonToMonth = '2026-10';
const isLatestComparisonExcluded = months.at(-1) === excludedComparisonToMonth;
const monthIndex = new Map(months.map((month, index) => [month, index]));
const grouped = new Map();
const qaGrouped = new Map();

for (const row of rows) {
  if (!grouped.has(row.eventTypeId)) grouped.set(row.eventTypeId, new Map());
  const statusMap = grouped.get(row.eventTypeId);
  if (!statusMap.has(row.status)) statusMap.set(row.status, Array(months.length).fill(0));
  statusMap.get(row.status)[monthIndex.get(row.month)] += row.count;
  if (row.status === 0 && row.qaCount !== null) {
    if (!qaGrouped.has(row.eventTypeId)) qaGrouped.set(row.eventTypeId, Array(months.length).fill(null));
    qaGrouped.get(row.eventTypeId)[monthIndex.get(row.month)] = row.qaCount;
  }
}

const events = [...grouped.entries()]
  .map(([id, statusMap]) => {
    const statuses = [...statusMap.entries()]
      .map(([code, values]) => ({
        code,
        description: statusDescriptions[String(code)] || 'Описание не предоставлено в исходных данных',
        values,
        qaValues: code === 0 ? (qaGrouped.get(id) || Array(months.length).fill(null)) : null,
        total: values.reduce((sum, value) => sum + value, 0),
        latest: values.at(-1) || 0
      }))
      .sort((a, b) => a.code === 0 ? -1 : b.code === 0 ? 1 : a.code - b.code);
    const totals = months.map((_, index) => statuses.reduce((sum, status) => sum + status.values[index], 0));
    const latest = totals.at(-1) || 0;
    const previous = totals.at(-2) || 0;
    const change = !isLatestComparisonExcluded && previous ? ((latest - previous) / previous) * 100 : null;
    const communicated = statusMap.get(0)?.at(-1) || 0;
    return {
      id,
      hasData: true,
      isTop: topSurveySet.has(id),
      topRank: topSurveyRank.get(id) ?? Number.MAX_SAFE_INTEGER,
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

const missingTopEvents = topSurveyIds
  .filter((id) => !grouped.has(id))
  .map((id) => ({
    id,
    hasData: false,
    isTop: true,
    topRank: topSurveyRank.get(id),
    statuses: [],
    totals: Array(months.length).fill(0),
    latest: 0,
    previous: 0,
    change: null,
    communicated: 0,
    communicationShare: 0
  }));
const catalogueEvents = [...events, ...missingTopEvents];

const dataset = {
  months,
  rowCount: rows.length,
  statusDescriptions,
  topSurveyIds,
  missingTopSurveyIds: missingTopEvents.map((event) => event.id),
  events: events.map(({ id, statuses, totals }) => ({ id, statuses, totals }))
};

fs.writeFileSync(path.join(dataDir, 'events.json'), JSON.stringify(dataset));
fs.writeFileSync(
  path.join(dataDir, 'source.tsv'),
  ['month\tevent_type_id\tstatus_det\tcnt\tqa_cnt', ...rows.map((row) => `${row.month}\t${row.eventTypeId}\t${row.status}\t${row.count}\t${row.qaCount ?? ''}`)].join('\n') + '\n'
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
const overallPeriodTotal = overallTotals.reduce((sum, value) => sum + value, 0);
const overallPrevious = overallTotals.at(-2);
const overallChange = !isLatestComparisonExcluded && overallPrevious ? ((overallLatest - overallPrevious) / overallPrevious) * 100 : null;
const compactNumber = (value) => value >= 1_000_000
  ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace('.', ',')} млн`
  : value >= 1_000
    ? `${Math.round(value / 1_000)} тыс.`
    : numberFormat.format(value);

const surveyPlanSource = `
Премьер (канал);Триггерный (CSAT);32;6000
ЦЗК;Триггерный (CSAT);35;40000
Чат;Триггерный (CSAT);154;150000
ВА;Триггерный (CSAT);155;500000
СберКидс;Общий (CSI);160;2000
НСЖ;Общий (CSI);217;300
ПДС;Общий (CSI);239;300
Дистанционное взыскание;Триггерный (CSAT);240;300
Урегулирование;Триггерный (CSAT);241;300
Дистанционное взыскание;Триггерный (CSAT);244;300
Урегулирование;Триггерный (CSAT);245;300
Инвестиционные рекомендации;Триггерный (CSAT);273;300
МВС в канале Премьер (общебанк);Общий (CSI);278;1000
ОПИФ;Общий (CSI);298;300
Клиентские документы;Общий (CSI);317;300
ПУ Премьер;Общий (CSI);363;300
ПУ Премьер;Общий (CSI);364;300
ПУ Премьер;Общий (CSI);408;300
ПУ Премьер;Общий (CSI);413;300
ПУ Премьер;Общий (CSI);414;300
ИСЖ;Общий (CSI);448;300
Выгода;Общий (CSI);480;1000
Вклады;Общий (CSI);514;5000
Кредитный потенциал;Общий (CSI);543;1000
Кредитный потенциал;Общий (CSI);544;1000
Ипотечное страхование недвижимости;Общий (CSI);567;300
Защита на любой случай;Общий (CSI);568;300
ОСАГО;Общий (CSI);573;300
ПК;Общий (CSI);578;5000
Зарплатный проект;Общий (CSI);582;5000
СберИнвестор;Общий (CSI);584;1000
Сбер ID;Общий (CSI);585;1000
Ипотечное страхование жизни;Общий (CSI);588;300
SberPay;Общий (CSI);589;4000
Справки;Триггерный (CSAT);730;1000
ГосУслуги;Триггерный (CSAT);731;1000
Справки;Триггерный (CSAT);733;1000
ГосУслуги;Триггерный (CSAT);738;1000
ГосУслуги;Триггерный (CSAT);739;300
Аресты и взыскания;Общий (CSI);741;1000
ГосУслуги;Триггерный (CSAT);744;1000
Уведомления;Общий (CSI);745;5000
Справки;Триггерный (CSAT);746;300
Доверенности;Триггерный (CSAT);749;300
Наследство;Триггерный (CSAT);772;1000
Транспортный эквайринг;Триггерный (CSAT);784;300
POS-кредиты;Общий (CSI);794;1000
Сейфы;Общий (CSI);800;1000
ОМС;Общий (CSI);895;1500
Общебанковский CSI;Общий (CSI);1007;60000
Фродмониторинг;Общий (CSI);1412;10000
Переводы;Общий (CSI);1427;8000
Платежи;Общий (CSI);1428;8000
Зарплатная карта;Общий (CSI);1434;5000
PFM;Триггерный (CSAT);1593;1000
PFM;Триггерный (CSAT);1595;1000
PFM;Триггерный (CSAT);1597;1000
PFM;Триггерный (CSAT);1598;1000
Автокредиты;Общий (CSI);1805;2000
Благотворительность;Триггерный (CSAT);2825;1000
Брокерское обслуживание;Общий (CSI);3106;1500
Конверсия;Общий (CSI);3113;2000
УС;Общий (CSI);3115;8000
Детская карта;Общий (CSI);3117;1500
Детская карта;Общий (CSI);3118;1500
СберБокс;Общий (CSI);3126;1000
Виртуальный ассистент;Общий (CSI);3127;3000
Социальные выплаты;Общий (CSI);3129;5000
Пенсионные выплаты;Общий (CSI);3130;5000
Самозанятые;Общий (CSI);3131;1000
Кредитная история;Общий (CSI);3133;2000
СалютТВ;Общий (CSI);3135;2000
Умный дом;Общий (CSI);3136;2000
Boom;Общий (CSI);3141;1000
Boom;Общий (CSI);3142;3000
ДКМ;Триггерный (CSAT);3149;2500
Спасибо;Общий (CSI);3155;10000
СберПрайм;Общий (CSI);3156;5000
GigaChat;Общий (CSI);3158;1000
ВА;Триггерный (CSAT);3169;1000
ЦЗК;Триггерный (CSAT);3434;15000
Премьер (канал);Триггерный (CSAT);4010;300
VIP клиенты вне канала;Общий (CSI);4011;300
Премьер (канал);Триггерный (CSAT);4021;1000
ПУ Премьер;Общий (CSI);4026;300
ПУ Премьер;Общий (CSI);4027;300
ПУ Премьер;Общий (CSI);4028;300
ДК;Общий (CSI);4104;5000
КК;Общий (CSI);4153;5000
МП;Общий (CSI);5008;5000
СБОЛ;Общий (CSI);5009;5000
Активные продажи;Общий (CSI);9845;1000
ТМ ЕРКЦ/ Робот;Триггерный (CSAT);93139;50000
ВСП;Триггерный (CSAT);190;1000000
ВСП;Триггерный (CSAT);193;600000
DSA;Триггерный (CSAT);191/192;20000`;
const surveyPlans = new Map();
surveyPlanSource.trim().split('\n').forEach((line) => {
  const [name, type, rawIds, rawPlan] = line.split(';');
  rawIds.split('/').forEach((rawId) => surveyPlans.set(Number(rawId.trim()), { name, type, plan: Number(rawPlan) }));
});
const buildDate = new Date();
const [latestYear, latestMonthNumber] = latestMonth.split('-').map(Number);
const isCurrentDataMonth = buildDate.getFullYear() === latestYear && buildDate.getMonth() + 1 === latestMonthNumber;
const currentDataDay = isCurrentDataMonth ? buildDate.getDate() : new Date(latestYear, latestMonthNumber, 0).getDate();
const daysInLatestMonth = new Date(latestYear, latestMonthNumber, 0).getDate();
const remainingBusinessDays = Array.from({ length: Math.max(0, daysInLatestMonth - currentDataDay) }, (_, index) => currentDataDay + index + 1)
  .filter((day) => {
    const weekday = new Date(latestYear, latestMonthNumber - 1, day).getDay();
    return weekday !== 0 && weekday !== 6;
  }).length;
const elapsedBusinessDays = Array.from({ length: currentDataDay }, (_, index) => index + 1)
  .filter((day) => {
    const weekday = new Date(latestYear, latestMonthNumber - 1, day).getDay();
    return weekday !== 0 && weekday !== 6;
  }).length;
const businessDayWord = (count) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  return mod100 >= 11 && mod100 <= 14 ? 'рабочих дней' : mod10 === 1 ? 'рабочий день' : mod10 >= 2 && mod10 <= 4 ? 'рабочих дня' : 'рабочих дней';
};

function miniSpark(values, labels = months, width = 180, height = 66, metric = 'событий') {
  if (!values.length) return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="5,33 ${width - 5},33" /></svg>`;
  const dataMax = Math.max(...values);
  const max = Math.max(dataMax, 1);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const pad = { top: 17, right: 5, bottom: 17, left: 5 };
  const points = values.map((value, index) => ({
    value,
    index,
    x: values.length === 1 ? width / 2 : pad.left + (index / (values.length - 1)) * (width - pad.left - pad.right),
    y: pad.top + (1 - ((value - min) / range)) * (height - pad.top - pad.bottom)
  }));
  const line = points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const latestIndex = values.length - 1;
  const lastFullIndex = Math.max(0, latestIndex - 1);
  const keyIndexes = [...new Set([lastFullIndex, latestIndex])];
  const markers = keyIndexes.map((index) => {
    const point = points[index];
    return `<g><circle class="spark__point" cx="${point.x}" cy="${point.y}" r="2.8"><title>${monthName(labels[index])}: ${numberFormat.format(point.value)} ${metric}</title></circle></g>`;
  }).join('');
  const title = metric === 'ответов' ? 'Динамика ответов по месяцам' : 'Динамика событий по месяцам';
  return `<div class="spark-block"><div class="spark-caption"><span>${title}</span><small><i></i>${monthNamesShort[Number(labels[lastFullIndex].slice(5)) - 1]} — полный <i></i>${monthNamesShort[Number(labels[latestIndex].slice(5)) - 1]} — неполный</small></div><svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}. Отмечены последний полный и текущий неполный месяцы"><polyline points="${line}" />${markers}</svg></div>`;
}

const monthNamesShort = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const monthNamesLong = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthNamesGenitive = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const monthNamesDative = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
const monthName = (month, form = 'short') => {
  const index = Number(month.slice(5)) - 1;
  const names = form === 'long' ? monthNamesLong : form === 'genitive' ? monthNamesGenitive : form === 'dative' ? monthNamesDative : monthNamesShort;
  const name = names[index];
  return `${name} ${month.slice(0, 4)}`;
};

const alertThreshold = 10;
function buildEventAlerts(event) {
  if (!event.hasData) return [];
  const metrics = [
    { label: 'Сумма всех событий', code: null, values: event.totals },
    ...event.statuses.map((status) => ({
      label: status.code === 0 ? 'Коммуникации с клиентом' : status.description,
      code: status.code,
      values: status.values
    }))
  ];
  const alerts = [];
  for (const metric of metrics) {
    for (let index = 1; index < months.length; index += 1) {
      if (months[index] === excludedComparisonToMonth) continue;
      const previous = metric.values[index - 1] || 0;
      const current = metric.values[index] || 0;
      if (previous <= 0) continue;
      const change = ((current - previous) / previous) * 100;
      if (Math.abs(change) <= alertThreshold) continue;
      alerts.push({
        metric: metric.label,
        code: metric.code,
        previous,
        current,
        change,
        direction: change > 0 ? 'up' : 'down',
        from: months[index - 1],
        to: months[index],
        toIndex: index
      });
    }
  }
  return alerts.sort((a, b) => b.toIndex - a.toIndex || Math.abs(b.change) - Math.abs(a.change));
}

function renderAlertPanel(event) {
  const alerts = buildEventAlerts(event);
  const lastFullMonthIndex = months.findIndex((month) => month === excludedComparisonToMonth) - 1;
  const increases = alerts.filter((alert) => alert.direction === 'up').length;
  const decreases = alerts.length - increases;
  const items = alerts.map((alert) => {
    const movement = alert.direction === 'up' ? 'Рост' : 'Снижение';
    const arrow = alert.direction === 'up' ? '↑' : '↓';
    const statusNote = alert.code === null ? 'общий объём' : `статус ${alert.code}`;
    const periodGroup = alert.toIndex === lastFullMonthIndex ? 'latest' : 'other';
    return `<article class="alert-item alert-item--${alert.direction}" data-alert-period="${periodGroup}">
      <span class="alert-item__icon" aria-hidden="true">${arrow}</span>
      <div class="alert-item__content">
        <div class="alert-item__top"><b>${esc(alert.metric)}</b><strong>${percent(alert.change)}</strong></div>
        <p>${movement} на ${Math.abs(alert.change).toFixed(1).replace('.', ',')}%: с ${monthName(alert.from, 'genitive')} года к ${monthName(alert.to, 'dative')} года.</p>
        <small>${numberFormat.format(alert.previous)} → ${numberFormat.format(alert.current)} событий · ${statusNote}</small>
      </div>
    </article>`;
  }).join('');
  return `<section class="alert-panel${event.hasData ? '' : ' alert-panel--empty'}" id="alerts" aria-labelledby="alerts-title">
    <header class="alert-panel__header">
      <div><p class="eyebrow">ПАНЕЛЬ АЛЕРТОВ</p><h2 id="alerts-title">Изменения больше ${alertThreshold}%</h2></div>
      <span class="alert-count">${event.hasData ? `${alerts.length} алертов` : 'нет данных'}</span>
    </header>
    ${event.hasData ? `<div class="alert-summary"><div class="alert-filter-group" aria-label="Направление изменения"><button class="alert-summary__down active" type="button" data-alert-filter="down" aria-pressed="true">↓ ${decreases} снижений</button><button class="alert-summary__up active" type="button" data-alert-filter="up" aria-pressed="true">↑ ${increases} ростов</button></div><div class="alert-filter-group alert-filter-group--period" aria-label="Период сравнения"><button class="active" type="button" data-alert-period-filter="latest" aria-pressed="true">Последний полный месяц</button><button type="button" data-alert-period-filter="other" aria-pressed="false">Остальное</button></div><small>Последний полный месяц: август → сентябрь</small></div>
    ${alerts.length ? `<div class="alert-list">${items}</div>` : '<div class="alert-panel__message">За период не найдено изменений больше 10%.</div>'}` : '<div class="alert-panel__message">Алерты появятся после добавления строк по этому опросу в исходные данные.</div>'}
  </section>`;
}

function overviewChart(values, labels, width = 560, height = 210, additionalSeries = []) {
  const pad = { top: 30, right: 16, bottom: 34, left: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxValue = Math.max(...values, 1);
  const step = 25_000_000;
  const max = Math.max(step, Math.ceil(maxValue / step) * step);
  const points = values.map((value, index) => {
    const x = pad.left + (index / Math.max(values.length - 1, 1)) * plotW;
    const y = pad.top + plotH - (value / max) * plotH;
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L ${points.at(-1)[0].toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${points[0][0].toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;
  const compact = (value) => value === 0 ? '0' : `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0).replace('.', ',')} млн`;
  const ticks = [0, .25, .5, .75, 1].map((fraction) => {
    const value = max * fraction;
    const y = pad.top + plotH - fraction * plotH;
    return `<line class="overview-grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"/><text class="overview-axis-label" x="${pad.left - 9}" y="${y + 3}" text-anchor="end">${compact(value)}</text>`;
  }).join('');
  const monthLabels = labels.map((month, index) => `<text class="overview-axis-label" x="${points[index][0]}" y="${height - 10}" text-anchor="middle">${monthNamesShort[Number(month.slice(5)) - 1]}</text>`).join('');
  const pointEls = points.map(([x, y], index) => {
    const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    const labelY = y < pad.top + 16 ? y + 19 : y - 10;
    return `<g><circle class="overview-chart-point" cx="${x}" cy="${y}" r="4"><title>${monthName(labels[index])}: ${numberFormat.format(values[index])} событий</title></circle><text class="overview-point-label" x="${x}" y="${labelY}" text-anchor="${anchor}">${compact(values[index])}</text></g>`;
  }).join('');
  const secondary = additionalSeries.map((series, seriesIndex) => {
    const seriesMax = series.ownScale ? Math.max(...series.values, 1) : max;
    const seriesPoints = series.values.map((value, index) => {
      const x = pad.left + (index / Math.max(values.length - 1, 1)) * plotW;
      const y = pad.top + plotH - (value / seriesMax) * plotH;
      return [x, y];
    });
    const seriesLine = seriesPoints.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const dots = seriesPoints.map(([x, y], index) => {
      const labelY = y < pad.top + 12 ? y + 14 : y - 7;
      return `<g><circle class="overview-secondary-point overview-secondary-point--${seriesIndex}" cx="${x}" cy="${y}" r="3"><title>${series.label}, ${monthName(labels[index])}: ${numberFormat.format(series.values[index])}</title></circle><text class="overview-secondary-label overview-secondary-label--${seriesIndex}" x="${x}" y="${labelY}" text-anchor="middle">${compact(series.values[index])}</text></g>`;
    }).join('');
    return `<path class="overview-secondary-line overview-secondary-line--${seriesIndex}" d="${seriesLine}"/>${dots}`;
  }).join('');
  const responseSeries = additionalSeries.find((series) => series.ownScale);
  const responseAxis = responseSeries ? [0, .5, 1].map((fraction) => {
    const value = Math.max(...responseSeries.values, 1) * fraction;
    const y = pad.top + plotH - fraction * plotH;
    return `<text class="overview-response-axis" x="${width - 2}" y="${y + 3}" text-anchor="end">${compact(value)}</text>`;
  }).join('') : '';
  const legend = additionalSeries.length ? `<g class="overview-legend"><line class="overview-chart-line" x1="${pad.left}" y1="12" x2="${pad.left + 22}" y2="12"/><text x="${pad.left + 28}" y="15">Все события</text>${additionalSeries.map((series, index) => `<line class="overview-secondary-line overview-secondary-line--${index}" x1="${pad.left + 108 + index * 112}" y1="12" x2="${pad.left + 130 + index * 112}" y2="12"/><text x="${pad.left + 136 + index * 112}" y="15">${series.label}</text>`).join('')}</g>` : '';
  const seriesNames = additionalSeries.map((series) => series.label.toLowerCase()).join(' и ');
  return `<svg class="overview-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Динамика всех событий${seriesNames ? ` и ${seriesNames}` : ''} по месяцам"><title>Динамика событий по месяцам</title><desc>Основная кривая показывает все события${seriesNames ? `, дополнительная — ${seriesNames}` : ''}.</desc>${legend}${ticks}${responseAxis}${monthLabels}<path class="overview-chart-area" d="${area}"/><path class="overview-chart-line" d="${line}"/>${secondary}${pointEls}</svg>`;
}

function responseChart(values, labels, width = 560, height = 126) {
  const pad = { top: 22, right: 16, bottom: 28, left: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxValue = Math.max(...values, 1);
  const max = Math.ceil(maxValue / 250_000) * 250_000;
  const points = values.map((value, index) => [
    pad.left + (index / Math.max(values.length - 1, 1)) * plotW,
    pad.top + plotH - (value / max) * plotH
  ]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const ticks = [0, .5, 1].map((fraction) => {
    const y = pad.top + plotH - fraction * plotH;
    return `<line class="response-grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"/><text class="response-axis-label" x="${pad.left - 8}" y="${y + 3}" text-anchor="end">${compactNumber(max * fraction)}</text>`;
  }).join('');
  const monthLabels = labels.map((month, index) => `<text class="response-axis-label" x="${points[index][0]}" y="${height - 8}" text-anchor="middle">${monthNamesShort[Number(month.slice(5)) - 1]}</text>`).join('');
  const dots = points.map(([x, y], index) => {
    const labelY = y < pad.top + 12 ? y + 14 : y - 7;
    return `<g><circle class="response-chart-point" cx="${x}" cy="${y}" r="3.2"><title>${monthName(labels[index])}: ${numberFormat.format(values[index])} ответов</title></circle><text class="response-point-label" x="${x}" y="${labelY}" text-anchor="middle">${compactNumber(values[index])}</text></g>`;
  }).join('');
  return `<div class="response-chart-block"><div class="response-chart-title"><b>Динамика ответов</b><span>Количество полученных ответов по месяцам</span></div><svg class="response-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Динамика количества ответов по месяцам"><title>Динамика ответов</title>${ticks}${monthLabels}<path class="response-chart-line" d="${line}"/>${dots}</svg></div>`;
}

function funnelStageChart({ label, kicker, values, labels, colorClass, width = 960, height = 138 }) {
  const pad = { top: 28, right: 18, bottom: 28, left: 18 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => [
    pad.left + (index / Math.max(values.length - 1, 1)) * plotW,
    pad.top + plotH - (value / max) * plotH
  ]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L ${points.at(-1)[0].toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${points[0][0].toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;
  const monthLabels = labels.map((month, index) => `<text class="funnel-stage__month" x="${points[index][0]}" y="${height - 6}" text-anchor="middle">${monthNamesShort[Number(month.slice(5)) - 1]}</text>`).join('');
  const dots = points.map(([x, y], index) => {
    const labelY = y < pad.top + 13 ? y + 16 : y - 8;
    const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    return `<g><circle class="funnel-stage__point" cx="${x}" cy="${y}" r="3.4"><title>${label}, ${monthName(labels[index])}: ${numberFormat.format(values[index])}</title></circle><text class="funnel-stage__value" x="${x}" y="${labelY}" text-anchor="${anchor}">${compactNumber(values[index])}</text></g>`;
  }).join('');
  const periodTotal = values.reduce((sum, value) => sum + value, 0);
  return `<section class="funnel-stage funnel-stage--${colorClass}">
    <div class="funnel-stage__head"><div><span>${kicker}</span><h3>${label}</h3></div><strong>${numberFormat.format(periodTotal)}<small>за период</small></strong></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}: динамика по месяцам"><line class="funnel-stage__grid" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}"/><path class="funnel-stage__area" d="${area}"/><path class="funnel-stage__line" d="${line}"/>${monthLabels}${dots}</svg>
  </section>`;
}

function businessFunnel(group, width = 960, compact = false) {
  const eventValues = sumGroup(group);
  const sendValues = sumStatusZero(group);
  const responseValues = sumResponses(group);
  const eventTotal = eventValues.reduce((sum, value) => sum + value, 0);
  const sendTotal = sendValues.reduce((sum, value) => sum + value, 0);
  const responseTotal = responseValues.reduce((sum, value) => sum + value, 0);
  const sendRate = eventTotal ? (sendTotal / eventTotal) * 100 : 0;
  const responseRate = sendTotal ? (responseTotal / sendTotal) * 100 : 0;
  const stageHeight = compact ? 118 : 148;
  return `<div class="business-funnel${compact ? ' business-funnel--compact' : ''}" aria-label="Бизнес-воронка: события, коммуникации и ответы">
    ${funnelStageChart({ label: 'Полученные события', kicker: '01 · Входящий поток', values: eventValues, labels: months, colorClass: 'events', width, height: stageHeight })}
    <div class="funnel-connector"><span>↓</span><b>${sendRate.toFixed(1).replace('.', ',')}%</b><small>событий перешли в коммуникацию</small></div>
    ${funnelStageChart({ label: 'Отправленные коммуникации', kicker: '02 · Доставка ценности', values: sendValues, labels: months, colorClass: 'sends', width, height: stageHeight })}
    <div class="funnel-connector"><span>↓</span><b>${responseRate.toFixed(1).replace('.', ',')}%</b><small>отправок получили ответ</small></div>
    ${funnelStageChart({ label: 'Полученные ответы', kicker: '03 · Результат контакта', values: responseValues, labels: months, colorClass: 'responses', width, height: stageHeight })}
  </div>`;
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
  <link rel="stylesheet" href="${relative}assets/styles.css?v=20261019-6">
</head>`;
}

function renderEventCard(event) {
  const planMeta = surveyPlans.get(event.id);
  const communicationStatus = event.statuses.find((status) => status.code === 0);
  const responseValues = communicationStatus?.qaValues?.map((value) => value ?? 0) || months.map(() => 0);
  const monitorsResponses = event.isTop && Boolean(planMeta);
  const primaryValues = monitorsResponses ? responseValues : event.totals;
  const primaryLatest = primaryValues.at(-1) || 0;
  const planProgress = monitorsResponses && planMeta.plan ? (primaryLatest / planMeta.plan) * 100 : null;
  const responsesRemaining = monitorsResponses ? Math.max(0, planMeta.plan - primaryLatest) : 0;
  const dailyResponsesNeeded = remainingBusinessDays > 0 ? Math.ceil(responsesRemaining / remainingBusinessDays) : responsesRemaining;
  const latestSends = communicationStatus?.values?.at(-1) || 0;
  const currentResponseRate = latestSends > 0 ? primaryLatest / latestSends : 0;
  const currentDailySends = elapsedBusinessDays > 0 ? Math.ceil(latestSends / elapsedBusinessDays) : 0;
  const requiredSendsRemaining = currentResponseRate > 0 ? Math.ceil(responsesRemaining / currentResponseRate) : 0;
  const requiredDailySends = remainingBusinessDays > 0 ? Math.ceil(requiredSendsRemaining / remainingBusinessDays) : requiredSendsRemaining;
  const sendsIncrease = Math.max(0, requiredDailySends - currentDailySends);
  const sendsIncreasePercent = currentDailySends > 0 ? (sendsIncrease / currentDailySends) * 100 : 0;
  const planRisk = sendsIncrease > 0;
  const planStatus = monitorsResponses ? `<div class="plan-status"><div class="plan-ring" style="--progress:${Math.min(planProgress, 100).toFixed(1)}%"><div><b>${planProgress.toFixed(1).replace('.', ',')}%</b><span>выполнено<br>плана</span></div></div><div class="plan-status__message ${planRisk ? 'is-risk' : 'is-ok'}"><b>${planRisk ? '⚠ План в риске' : '✓ План выполняется'}</b><span>${planRisk ? `Нужно увеличить темп отправок на ${sendsIncreasePercent.toFixed(1).replace('.', ',')}%, чтобы выполнить план.` : 'Текущего темпа отправок достаточно для выполнения плана.'}</span></div></div>` : '';
  const sendPace = responsesRemaining > 0 && remainingBusinessDays > 0
    ? `<div class="send-pace"><div class="send-pace__card"><span class="send-pace__label">Текущий темп</span><b class="send-pace__value">${numberFormat.format(currentDailySends)}</b><span class="send-pace__unit">отправок в день</span><small class="send-pace__note">Отклик — ${(currentResponseRate * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%</small></div><div class="send-pace__card ${sendsIncrease > 0 ? 'is-risk' : 'is-ok'}"><span class="send-pace__label">Нужный темп</span><b class="send-pace__value">${numberFormat.format(requiredDailySends)}</b><span class="send-pace__unit">отправок в день</span><small class="send-pace__note">${sendsIncrease > 0 ? `↑ на ${numberFormat.format(sendsIncrease)} в день · +${sendsIncreasePercent.toFixed(1).replace('.', ',')}%` : 'Текущего темпа достаточно'}</small></div></div>`
    : '';
  const planPace = monitorsResponses
    ? `<div class="plan-metrics"><div class="plan-metric"><span>Осталось</span><b>${numberFormat.format(responsesRemaining)}</b><small>ответов</small></div><div class="plan-metric ${remainingBusinessDays <= 0 && responsesRemaining > 0 ? 'is-risk' : ''}"><span>Нужно</span><b>${numberFormat.format(responsesRemaining === 0 ? 0 : dailyResponsesNeeded)}</b><small>${remainingBusinessDays > 0 || responsesRemaining === 0 ? 'ответов в день' : 'рабочих дней не осталось'}</small></div></div>${responsesRemaining > 0 ? sendPace : '<div class="plan-complete">✓ План выполнен</div>'}`
    : '';
  const changeClass = event.change === null ? 'neutral' : event.change >= 0 ? 'up' : 'down';
  const eventAlerts = buildEventAlerts(event);
  const alertUps = eventAlerts.filter((alert) => alert.direction === 'up').length;
  const alertDowns = eventAlerts.length - alertUps;
  const searchText = `event ${event.id} ${planMeta?.name || ''} ${planMeta?.type || ''} ${event.statuses.map((status) => `${status.code} ${status.description}`).join(' ')}`;
  const cardTrend = !event.hasData
    ? '<small>нет данных</small><b class="trend neutral">—</b>'
    : isLatestComparisonExcluded
      ? '<small>октябрь неполный</small><b class="trend neutral">—</b>'
      : `<small>к ${months.at(-2)}</small><b class="trend ${changeClass}">${percent(event.change)}</b>`;
  const lastFullIndex = months.findIndex((month) => month === excludedComparisonToMonth) - 1;
  const priorFullIndex = lastFullIndex - 1;
  const funnelMetrics = event.hasData && lastFullIndex > 0 ? [
    { label: 'События', current: event.totals[lastFullIndex] || 0, previous: event.totals[priorFullIndex] || 0, share: 100 },
    { label: 'Отправки', current: communicationStatus?.values[lastFullIndex] || 0, previous: communicationStatus?.values[priorFullIndex] || 0, share: event.totals[lastFullIndex] ? ((communicationStatus?.values[lastFullIndex] || 0) / event.totals[lastFullIndex]) * 100 : 0 },
    { label: 'Ответы', current: communicationStatus?.qaValues?.[lastFullIndex] || 0, previous: communicationStatus?.qaValues?.[priorFullIndex] || 0, share: communicationStatus?.values[lastFullIndex] ? ((communicationStatus?.qaValues?.[lastFullIndex] || 0) / communicationStatus.values[lastFullIndex]) * 100 : 0 }
  ] : [];
  const funnel = funnelMetrics.length ? `<div class="event-funnel" aria-label="Воронка за ${monthName(months[lastFullIndex], 'long')}; изменения относительно ${monthName(months[priorFullIndex], 'genitive')}">
    <div class="event-funnel__caption"><span>Воронка · ${monthNamesShort[Number(months[lastFullIndex].slice(5)) - 1]}</span><small>к ${monthNamesShort[Number(months[priorFullIndex].slice(5)) - 1]}</small></div>
    ${funnelMetrics.map((metric, index) => {
      const change = metric.previous ? ((metric.current - metric.previous) / metric.previous) * 100 : metric.current ? Infinity : 0;
      const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
      const changeLabel = Number.isFinite(change) ? `${change > 0 ? '↑' : change < 0 ? '↓' : '→'} ${Math.abs(change).toFixed(1).replace('.', ',')}%` : '↑ новое';
      const shareLabel = index === 0 ? '100% объёма' : index === 1 ? `${metric.share.toFixed(1).replace('.', ',')}% событий` : `${metric.share.toFixed(1).replace('.', ',')}% отправок`;
      return `<div class="event-funnel__step event-funnel__step--${index + 1}"><span>${metric.label}<small>${shareLabel}</small></span><b>${compactNumber(metric.current)}</b><em class="${direction}">${changeLabel}</em></div>`;
    }).join('')}
  </div>` : '';
  return `<a class="event-card${event.isTop ? ' is-top' : ''}${event.hasData ? '' : ' is-missing'}" href="events/${event.id}.html" data-id="${event.id}" data-top="${event.isTop}" data-rank="${event.topRank}" data-has-data="${event.hasData}" data-latest="${primaryLatest}" data-change="${event.change ?? -999999}" data-search="${esc(searchText.toLowerCase())}">
    <div class="event-card__top"><span class="event-id">${event.isTop ? '<small class="top-badge">ТОП</small>' : ''}#${event.id}${planMeta ? `<span class="survey-inline"><b>${esc(planMeta.name)}</b><i>${esc(planMeta.type)}</i></span>` : ''}</span><span class="card-actions">${monitorsResponses ? '<button class="card-expand" type="button" aria-label="Открыть карточку крупнее" title="Открыть крупнее">⛶</button>' : `<span class="trend-block">${cardTrend}</span>`}</span></div>
    ${planMeta ? `<div class="survey-identity"><span>Текущий период</span><strong>1.${latestMonthNumber} — ${currentDataDay}.${latestMonthNumber}</strong></div>` : ''}
    ${miniSpark(primaryValues, months, 180, 66, monitorsResponses ? 'ответов' : 'событий')}
    ${monitorsResponses ? `${planStatus}<div class="response-plan-head"><div><span>План ответов на месяц</span><b>${numberFormat.format(planMeta.plan)}</b><small>целевой объём</small></div><div><span>Получено ответов</span><b>${numberFormat.format(primaryLatest)}</b><small>за ${monthName(latestMonth, 'long')}</small></div><div class="is-deficit"><span>Осталось собрать</span><b>${numberFormat.format(responsesRemaining)}</b><small>ответов</small></div></div><div class="plan-progress"><div class="action-title">Что необходимо сделать</div>${planPace}</div>` : `<div class="event-card__value${!event.hasData ? ' event-card__value--missing' : ''}">${!event.hasData ? 'Нет данных' : numberFormat.format(primaryLatest)}</div>${event.hasData ? `<div class="event-card__value-label">Сумма событий за ${latestMonth}</div>` : ''}`}
    ${funnel}
    <div class="event-card__meta"><span>${event.hasData ? `${eventAlerts.length} алертов · ↓${alertDowns} ↑${alertUps}` : 'алертов нет'}</span><span>${event.hasData ? latestMonth : '—'}</span></div>
  </a>`;
}

const cards = catalogueEvents.map(renderEventCard).join('\n');

const topEvents = catalogueEvents.filter((event) => event.isTop);
const otherEvents = catalogueEvents.filter((event) => event.hasData && !event.isTop);
const sumGroup = (group) => months.map((_, index) => group.reduce((sum, event) => sum + (event.totals[index] || 0), 0));
const sumStatusZero = (group) => months.map((_, index) => group.reduce((sum, event) => sum + (event.statuses.find((status) => status.code === 0)?.values[index] || 0), 0));
const sumResponses = (group) => months.map((_, index) => group.reduce((sum, event) => sum + (event.statuses.find((status) => status.code === 0)?.qaValues?.[index] || 0), 0));
const topTotals = sumGroup(topEvents);
const otherTotals = sumGroup(otherEvents);
const overviewSeries = (group) => [
  { label: 'Отправки', values: sumStatusZero(group) }
];
const topPeriodTotal = topTotals.reduce((sum, value) => sum + value, 0);
const otherPeriodTotal = otherTotals.reduce((sum, value) => sum + value, 0);
const topAlertCount = topEvents.reduce((sum, event) => sum + buildEventAlerts(event).length, 0);
const otherAlertCount = otherEvents.reduce((sum, event) => sum + buildEventAlerts(event).length, 0);

function segmentDashboard({ file, eyebrow, title, description, group, totals }) {
  const segmentCards = group.map(renderEventCard).join('\n');
  return `${baseHead(`${title} — дашборд`, description)}
<body class="overview-page segment-page">
  <header class="site-header">
    <a class="brand" href="index.html" aria-label="Главная"><span class="brand__mark"><i></i><i></i><i></i></span><span><b>Events</b><small>status monitor</small></span></a>
    <a class="period-pill" href="index.html">← Общий обзор</a>
  </header>
  <main>
    <section class="overview-hero">
      <div class="overview-hero__copy"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">${description}</p></div>
      <div class="overview-hero__pulse">
        <div class="pulse-header"><span>Сумма событий группы по месяцам</span><span class="trend neutral">сентябрь → октябрь не сравнивается: октябрь неполный</span></div>
        <strong>${numberFormat.format(totals.at(-1))}</strong><span class="pulse-current-label">событий за ${monthName(latestMonth, 'long')}</span>
        ${businessFunnel(group, 560, true)}
      </div>
    </section>
    <section class="metric-strip" aria-label="Сводные показатели"><div><span>Опросов в группе</span><b>${group.length}</b></div><div><span>Месяцев</span><b>${months.length}</b></div></section>
    <section class="catalogue"><div class="section-heading"><div><p class="eyebrow">СОСТАВ ГРУППЫ</p><h2>${title}</h2></div><span>${group.length} опросов</span></div><div class="event-grid">${segmentCards}</div></section>
  </main>
  <footer><span>Источник: предоставленная агрегированная выборка</span><a href="index.html">Вернуться к общему обзору →</a></footer>
</body></html>`;
}

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
    <section class="overview-hero overview-hero--main">
      <div class="overview-hero__copy">
        <h1>Динамика событий</h1>
        <p class="lede">Помесячная картина обработки событий: от успешной коммуникации до каждой причины отсева.</p>
      </div>
      <div class="overview-hero__pulse">
        <div class="pulse-header"><span>Воронка платформы · ${months[0]} — ${months.at(-1)}</span><span class="trend neutral">сравнение с ${monthName(months.at(-2))} отключено: октябрь неполный</span></div>
        ${businessFunnel(events, 1040)}
      </div>
    </section>

    <nav class="dashboard-links" aria-label="Отдельные дашборды групп">
      <article class="group-dashboard">
        <header><span class="eyebrow">ТОП‑ТРИГГЕРЫ</span><a href="top.html">Открыть полный обзор →</a></header>
        <div class="group-dashboard__kpi"><b>${numberFormat.format(topPeriodTotal)}</b><small>получено событий за период: ${months[0]} — ${months.at(-1)}</small></div>
        <div class="group-dashboard__charts">${businessFunnel(topEvents, 560, true)}</div>
        <button class="chart-expand" type="button" aria-label="Открыть графики топ-триггеров крупнее">⛶ Развернуть графики</button>
        <footer><span>${topEvents.length} опросов</span><span>${topAlertCount} алертов за завершённые месяцы</span></footer>
      </article>
      <article class="group-dashboard">
        <header><span class="eyebrow">ВСЕ ОСТАЛЬНЫЕ</span><a href="others.html">Открыть полный обзор →</a></header>
        <div class="group-dashboard__kpi"><b>${numberFormat.format(otherPeriodTotal)}</b><small>получено событий за период: ${months[0]} — ${months.at(-1)}</small></div>
        <div class="group-dashboard__charts">${businessFunnel(otherEvents, 560, true)}</div>
        <button class="chart-expand" type="button" aria-label="Открыть графики остальных опросов крупнее">⛶ Развернуть графики</button>
        <footer><span>${otherEvents.length} опросов</span><span>${otherAlertCount} алертов за завершённые месяцы</span></footer>
      </article>
    </nav>

    <section class="catalogue" id="catalogue">
      <div class="section-heading">
        <div><p class="eyebrow">КАТАЛОГ</p><h2>Выберите опрос</h2></div>
        <span id="resultCount">${topSurveyIds.length} топ-опросов</span>
      </div>
      <div class="scope-toggle" role="group" aria-label="Состав списка">
        <button class="active" type="button" data-scope="top">Топ опросы <span>${topSurveyIds.length}</span></button>
        <button type="button" data-scope="all">Все опросы <span>${events.length}</span></button>
      </div>
      <div class="catalogue-tools">
        <label class="search-box"><span>⌕</span><input id="eventSearch" type="search" placeholder="Найти ID или статус…" autocomplete="off"></label>
        <label class="sort-box"><span>Сортировка</span><select id="eventSort"><option value="latest" selected>По объёму</option><option value="top">По списку</option><option value="id">По ID</option><option value="change">По динамике</option></select></label>
      </div>
      <div class="event-grid" id="eventGrid">${cards}</div>
      <div class="empty-state" id="emptyState" hidden><b>Ничего не найдено</b><span>Попробуйте другой ID или код статуса.</span></div>
    </section>
  </main>
  <dialog class="chart-dialog" id="chartDialog"><div class="chart-dialog__head"><div><span class="eyebrow"></span><strong></strong></div><button type="button" aria-label="Закрыть увеличенные графики">×</button></div><div class="chart-dialog__body"></div></dialog>
  <footer><span>Источник: предоставленная агрегированная выборка</span><span>Пропуски по месяцам отображаются как 0</span></footer>
  <script src="assets/index.js?v=20261019-1"></script>
</body>
</html>`;

fs.writeFileSync(path.join(dist, 'index.html'), indexHtml);
fs.writeFileSync(path.join(dist, 'top.html'), segmentDashboard({
  file: 'top.html', eyebrow: 'ТОП‑ТРИГГЕРЫ', title: 'Топ‑триггеры',
  description: 'Агрегированная динамика и карточки опросов из зафиксированного списка топ‑триггеров.', group: topEvents, totals: topTotals
}));
fs.writeFileSync(path.join(dist, 'others.html'), segmentDashboard({
  file: 'others.html', eyebrow: 'ОСТАЛЬНЫЕ ТРИГГЕРЫ', title: 'Все остальные',
  description: 'Агрегированная динамика всех опросов, которые не входят в список топ‑триггеров.', group: otherEvents, totals: otherTotals
}));

const eventList = catalogueEvents
  .map((event) => ({ id: event.id, latest: event.latest, hasData: event.hasData, isTop: event.isTop }))
  .sort((a, b) => a.id - b.id);
fs.writeFileSync(path.join(assetsDir, 'events-list.js'), `window.EVENT_LIST=${JSON.stringify(eventList)};`);

for (const event of catalogueEvents) {
  const changeClass = event.change === null ? 'neutral' : event.change >= 0 ? 'up' : 'down';
  const eventPayload = {
    id: event.id,
    hasData: event.hasData,
    isTop: event.isTop,
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
      <a href="#alerts"><span>⚑</span> Алерты</a>
      <a href="#charts"><span>⌗</span> Статусы</a>
    </nav>
    <div class="sidebar-note"><span>${event.hasData ? 'Период данных' : 'Статус данных'}</span><b>${event.hasData ? `${months[0]} — ${months.at(-1)}` : 'Нет наблюдений'}</b><small>${event.hasData ? `${months.length} месяцев · ${event.statuses.length} статусов` : 'опрос есть в топ-списке'}</small></div>
  </aside>
  <main class="detail-main" id="top">
    <div class="detail-topbar">
      <a class="back-link" href="../index.html">← Все события</a>
      <label class="event-jump"><span>Перейти к ID</span><select id="eventJump" aria-label="Перейти к другому event_type_id"></select></label>
    </div>
    <section class="event-hero">
      <div>
        <p class="eyebrow">EVENT_TYPE_ID ${event.isTop ? '<span class="top-survey-label">ТОП ОПРОС</span>' : ''}</p>
        <h1>${event.id}</h1>
        <p>${event.hasData ? 'Детальная динамика обработки по каждому статусу.' : 'Отдельная страница приоритетного опроса.'}</p>
      </div>
      <div class="hero-stamp"><span>${event.hasData ? 'АКТУАЛЬНЫЙ ПЕРИОД' : 'СТАТУС ДАННЫХ'}</span><b>${event.hasData ? latestMonth : 'Нет строк'}</b><small>${event.hasData ? `${numberFormat.format(event.latest)} событий` : 'в исходной выборке'}</small></div>
    </section>
    ${event.hasData ? `<section class="kpi-grid" aria-label="Показатели события">
      <article><span>Сумма событий за ${latestMonth}</span><b>${numberFormat.format(event.latest)}</b><small>сумма всех событий</small></article>
      <article><span>Изменение суммы событий к ${months.at(-2)}</span><b class="neutral">Не считается</b><small>${latestMonth} — неполный месяц</small></article>
      <article><span>Коммуникации</span><b>${numberFormat.format(event.communicated)}</b><small>${event.communicationShare.toFixed(1).replace('.', ',')}% от объёма</small></article>
    </section>` : ''}
    ${renderAlertPanel(event)}
    ${event.hasData ? `<section class="chart-section" id="charts">
      <div class="section-heading section-heading--charts"><div><p class="eyebrow">STATUS_DET</p><h2>Кривые изменения</h2></div><span>${event.statuses.length + (event.statuses.some((status) => status.code === 0 && status.qaValues?.some((value) => value !== null)) ? 1 : 0)} отдельных графиков</span></div>
      <div class="chart-grid" id="chartGrid" aria-live="polite"></div>
    </section>` : `<section class="missing-survey" id="charts">
      <span class="missing-survey__mark">#${event.id}</span>
      <p class="eyebrow">НЕТ ДАННЫХ ДЛЯ ГРАФИКОВ</p>
      <h2>В источнике нет наблюдений по этому опросу</h2>
      <p>Номер включён в список топ-опросов, поэтому для него создана отдельная страница. Графики появятся после добавления строк с этим <code>event_type_id</code> в исходные данные.</p>
      <a href="../index.html#catalogue">← Вернуться к списку опросов</a>
      <div id="chartGrid" hidden></div>
    </section>`}
    <footer><span>event_type_id ${event.id}</span><span>Пропуски по месяцам отображаются как 0</span></footer>
  </main>
  <div class="chart-tooltip" id="chartTooltip" hidden></div>
  <script>window.EVENT_DATA=${JSON.stringify(eventPayload)};</script>
  <script src="../assets/events-list.js"></script>
  <script src="../assets/dashboard.js?v=20261019-6"></script>
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
.overview-hero__pulse{background:var(--ink);color:#fff;border-radius:30px;padding:clamp(28px,4vw,48px);box-shadow:0 30px 80px rgba(16,34,29,.22);overflow:hidden;position:relative}.overview-hero__pulse:before{content:"";position:absolute;inset:-70% -20% auto 45%;aspect-ratio:1;border-radius:50%;background:rgba(201,255,87,.08);pointer-events:none}.pulse-header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;font-size:11px;color:#a6b4ae;text-transform:uppercase;letter-spacing:.1em;position:relative;z-index:1}.pulse-header .trend{max-width:48%;text-align:right;line-height:1.35}.overview-hero__pulse>strong{display:block;font-size:clamp(40px,5vw,68px);letter-spacing:-.05em;margin:22px 0 0;position:relative;z-index:1}.pulse-current-label{display:block;margin-top:2px;color:#a6b4ae;font-size:12px;position:relative;z-index:1}.overview-chart{display:block;width:100%;height:auto;margin-top:18px;overflow:visible;position:relative;z-index:1}.overview-grid-line{stroke:#304840;stroke-width:1}.overview-axis-label{fill:#8fa29b;font-size:9px}.overview-point-label{fill:#fff;font-size:8px;font-weight:700;paint-order:stroke;stroke:var(--ink);stroke-width:4px;stroke-linejoin:round}.overview-chart-area{fill:rgba(201,255,87,.07)}.overview-chart-line{fill:none;stroke:var(--lime);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.overview-chart-point{fill:var(--lime);stroke:var(--ink);stroke-width:2}.spark{display:block;width:100%;height:auto;overflow:visible}.spark polyline{fill:none;stroke:var(--lime);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.spark__point{fill:var(--card);stroke:#3e806d;stroke-width:2}.spark__label{fill:#315f52;font-size:7px;font-weight:700;paint-order:stroke;stroke:var(--card);stroke-width:3px;stroke-linejoin:round}.month-row{display:flex;justify-content:space-between;font-size:9px;color:#81918a;margin-top:7px}
.trend{font-size:11px;font-weight:800;letter-spacing:.02em}.trend.up,.up{color:#207f5e}.trend.down,.down{color:#c84b44}.overview-hero__pulse .trend.up{color:var(--lime)}.overview-hero__pulse .trend.down{color:#ff9e8e}.neutral{color:var(--muted)}
.metric-strip{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:110px}.metric-strip>div{padding:30px 25px;border-right:1px solid var(--line)}.metric-strip>div:first-child{padding-left:0}.metric-strip>div:last-child{border:0}.metric-strip span{display:block;color:var(--muted);font-size:12px;margin-bottom:9px}.metric-strip b{font-size:30px;letter-spacing:-.04em}
.dashboard-links{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:-20px 0 90px}.group-dashboard{background:var(--ink);color:#fff;border-radius:24px;padding:25px 28px 20px;overflow:hidden;transition:transform .2s,box-shadow .2s}.group-dashboard:hover{transform:translateY(-4px);box-shadow:var(--shadow)}.group-dashboard header,.group-dashboard footer{display:flex;align-items:center;justify-content:space-between;gap:16px}.group-dashboard .eyebrow{color:var(--lime)}.group-dashboard i{color:var(--lime);font-style:normal;font-size:11px}.group-dashboard__kpi{margin-top:20px}.group-dashboard__kpi b{display:block;font-size:38px;letter-spacing:-.04em}.group-dashboard__kpi small{display:block;color:#a6b4ae;font-size:10px;margin-top:3px}.group-dashboard .overview-chart{margin-top:8px}.group-dashboard footer{border-top:1px solid #304840;padding-top:13px;color:#a6b4ae;font-size:10px}.segment-page .overview-hero{grid-template-columns:minmax(300px,.9fr) minmax(440px,1.1fr)}.segment-page .overview-hero__copy h1{font-size:clamp(48px,5.7vw,80px);line-height:.94}.segment-page .catalogue{padding-top:20px}
.catalogue{padding-bottom:80px}.section-heading{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:28px}.section-heading h2{font-size:clamp(32px,4vw,54px);letter-spacing:-.05em;margin:0}.section-heading>span{font-size:12px;color:var(--muted);padding-bottom:8px}.scope-toggle{display:inline-flex;gap:4px;padding:4px;background:#e7e8e1;border-radius:14px;margin-bottom:16px}.scope-toggle button{border:0;background:transparent;color:var(--muted);font-size:12px;font-weight:700;padding:10px 14px;border-radius:10px;cursor:pointer}.scope-toggle button span{display:inline-grid;place-items:center;min-width:22px;height:19px;margin-left:7px;padding:0 5px;border-radius:99px;background:rgba(16,34,29,.08);font-size:9px}.scope-toggle button.active{background:var(--ink);color:#fff;box-shadow:0 5px 14px rgba(16,34,29,.16)}.scope-toggle button.active span{background:var(--lime);color:var(--ink)}.catalogue-tools{display:flex;gap:12px;margin-bottom:24px}.search-box,.sort-box{height:52px;background:var(--card);border:1px solid var(--line);border-radius:14px;display:flex;align-items:center}.search-box{flex:1;gap:10px;padding:0 18px}.search-box span{font-size:24px;transform:rotate(-15deg);color:var(--muted)}.search-box input{border:0;outline:0;background:transparent;width:100%;color:var(--ink)}.sort-box{padding:0 14px;gap:12px}.sort-box>span{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.sort-box select,.event-jump select{border:0;background:transparent;color:var(--ink);font-weight:700;outline:0}
.event-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.event-card{position:relative;background:var(--card);border:1px solid transparent;border-radius:19px;padding:21px;min-height:238px;display:flex;flex-direction:column;transition:transform .2s,border-color .2s,box-shadow .2s}.event-card.is-top{border-color:#c7d5ce;background:linear-gradient(145deg,#fffef9 55%,#f0f7e1)}.event-card.is-top:before{content:"";position:absolute;inset:0 auto 0 0;width:4px;border-radius:19px 0 0 19px;background:var(--lime)}.event-card.is-missing{background:#eeeee8;border-style:dashed}.event-card.is-missing .spark{opacity:.28}.event-card:hover{transform:translateY(-4px);border-color:#9ab7ab;box-shadow:var(--shadow)}.event-card__top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.event-id{font-weight:800;font-size:14px;letter-spacing:.02em;display:flex;align-items:center;gap:7px}.top-badge{font-size:7px;letter-spacing:.12em;padding:4px 5px;border-radius:5px;background:var(--lime);color:var(--ink)}.trend-block{display:flex;flex-direction:column;align-items:flex-end;line-height:1.15;white-space:nowrap}.trend-block small{font-size:8px;font-weight:500;color:var(--muted);margin-bottom:4px}.trend-block b{font-size:11px}.event-card .spark{height:66px;margin:12px 0 9px}.event-card .spark polyline{stroke:#3e806d;stroke-width:2}.event-card__value{font-size:27px;font-weight:750;letter-spacing:-.04em}.event-card__value--missing{font-size:20px;color:var(--muted)}.event-card__value-label{color:var(--muted);font-size:9px;margin-top:2px}.event-card__meta{display:flex;justify-content:space-between;color:var(--muted);font-size:10px;margin-top:auto}.empty-state{text-align:center;padding:90px 20px;border:1px dashed #bac5bf;border-radius:20px}.empty-state b,.empty-state span{display:block}.empty-state span{color:var(--muted);margin-top:8px}
.event-card[hidden]{display:none!important}
footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:11px}.overview-page>footer{margin:0 clamp(24px,5vw,78px)}
.sidebar{position:fixed;inset:0 auto 0 0;width:248px;background:var(--ink);color:white;padding:30px 24px;display:flex;flex-direction:column;z-index:5}.brand--light .brand__mark{background:var(--lime)}.brand--light .brand__mark i{background:var(--ink)}.brand--light small{color:#8fa29b}.sidebar nav{display:flex;flex-direction:column;gap:6px;margin-top:74px}.sidebar nav a{padding:13px 15px;border-radius:11px;color:#9eb0aa;font-size:13px;display:flex;gap:12px;align-items:center}.sidebar nav a span{font-size:18px}.sidebar nav a:hover,.sidebar nav a.active{background:rgba(255,255,255,.08);color:white}.sidebar nav a.active:after{content:"";margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--lime)}.sidebar-note{margin-top:auto;padding:18px;border:1px solid rgba(255,255,255,.1);border-radius:14px;display:flex;flex-direction:column}.sidebar-note span{font-size:9px;letter-spacing:.14em;color:#8fa29b}.sidebar-note b{font-size:13px;margin:9px 0}.sidebar-note small{font-size:10px;color:#8fa29b}
.detail-main{margin-left:248px;min-height:100vh;padding:0 clamp(24px,5vw,70px)}.detail-topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.back-link{font-size:12px;color:var(--muted)}.back-link:hover{color:var(--ink)}.event-jump{display:flex;align-items:center;gap:12px}.event-jump>span{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.event-jump select{min-width:110px;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:9px 12px}
.event-hero{display:flex;justify-content:space-between;align-items:flex-end;padding:64px 0 48px}.event-hero h1{font-size:clamp(72px,10vw,142px);line-height:.75;letter-spacing:-.07em;margin:0}.event-hero>div:first-child>p:last-child{color:var(--muted);margin:28px 0 0}.top-survey-label{display:inline-block;margin-left:8px;padding:5px 7px;border-radius:6px;background:var(--lime);color:var(--ink);letter-spacing:.1em;vertical-align:middle}.hero-stamp{min-width:210px;border-left:3px solid var(--lime);padding:7px 0 7px 18px;display:flex;flex-direction:column}.hero-stamp span{font-size:9px;letter-spacing:.14em;color:var(--muted)}.hero-stamp b{font-size:24px;margin:6px 0}.hero-stamp small{font-size:11px;color:var(--muted)}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);background:var(--card);border:1px solid var(--line);border-radius:20px;margin-bottom:84px}.kpi-grid article{padding:25px;border-right:1px solid var(--line)}.kpi-grid article:last-child{border-right:0}.kpi-grid span,.kpi-grid small{display:block;color:var(--muted);font-size:10px;line-height:1.45}.kpi-grid b{display:block;font-size:29px;letter-spacing:-.04em;margin:12px 0 8px}
.alert-panel{margin:0 0 84px;padding:clamp(24px,4vw,42px);background:var(--ink);color:#fff;border-radius:24px;box-shadow:0 18px 50px rgba(29,47,41,.12);position:relative;overflow:hidden}.alert-panel:before{content:"";position:absolute;width:280px;height:280px;border-radius:50%;right:-110px;top:-150px;background:rgba(201,255,87,.08);pointer-events:none}.alert-panel__header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:24px;border-bottom:1px solid rgba(255,255,255,.12);position:relative}.alert-panel__header .eyebrow{color:var(--lime);margin-bottom:12px}.alert-panel__header h2{font-size:clamp(28px,4vw,48px);line-height:1;letter-spacing:-.045em;margin:0}.alert-count{flex:none;padding:9px 13px;border:1px solid rgba(255,255,255,.16);border-radius:99px;color:#c1cdc8;font-size:11px}.alert-summary{display:flex;align-items:center;gap:10px;margin:20px 0}.alert-summary>span{padding:7px 10px;border-radius:8px;font-size:11px;font-weight:800}.alert-summary__down{color:#ff9e8e;background:rgba(255,130,111,.1)}.alert-summary__up{color:var(--lime);background:rgba(201,255,87,.09)}.alert-summary small{margin-left:auto;color:#8fa29b;font-size:10px}.alert-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-height:520px;overflow:auto;padding-right:6px;scrollbar-color:#476158 transparent}.alert-item{display:flex;gap:12px;padding:17px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.08);border-radius:14px}.alert-item--down{border-left:3px solid var(--coral)}.alert-item--up{border-left:3px solid var(--lime)}.alert-item__icon{flex:none;display:grid;place-items:center;width:29px;height:29px;border-radius:50%;background:rgba(255,255,255,.08);font-size:15px;font-weight:800}.alert-item--down .alert-item__icon,.alert-item--down .alert-item__top strong{color:#ff9e8e}.alert-item--up .alert-item__icon,.alert-item--up .alert-item__top strong{color:var(--lime)}.alert-item__content{min-width:0;flex:1}.alert-item__top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.alert-item__top b{font-size:13px;line-height:1.35}.alert-item__top strong{flex:none;font-size:12px}.alert-item p{margin:8px 0 7px;color:#d6dfdc;font-size:11px;line-height:1.45}.alert-item small{color:#8fa29b;font-size:9px;line-height:1.4}.alert-panel__message{padding:34px 0 4px;color:#b7c4bf;font-size:14px}.alert-panel--empty{min-height:230px}
.section-heading--charts{padding-bottom:22px;border-bottom:1px solid var(--line)}.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:28px 0 90px}.chart-card{background:var(--card);border:1px solid rgba(16,34,29,.08);border-radius:20px;padding:24px;box-shadow:0 4px 16px rgba(16,34,29,.025)}.chart-card__header{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px}.status-chip{flex:none;padding:7px 9px;border-radius:9px;background:var(--ink);color:white;font-size:11px;font-weight:800}.chart-card__title{min-width:0}.chart-card__title h3{font-size:16px;line-height:1.35;margin:0;font-weight:750}.chart-card__title p{color:var(--muted);font-size:9px;line-height:1.45;margin:8px 0 0;text-transform:uppercase;letter-spacing:.1em}.chart-card__latest{margin-left:auto;text-align:right;white-space:nowrap}.chart-card__latest b{display:block;font-size:18px}.chart-card__latest small{font-size:9px;color:var(--muted)}.chart-wrap{position:relative}.status-chart{display:block;width:100%;height:auto;overflow:visible}.status-chart text{font-family:Inter,"Segoe UI",Arial,sans-serif}.grid-line{stroke:#e4e6df;stroke-width:1}.axis-label{fill:#84918c;font-size:9px}.point-label{fill:var(--ink);font-size:8px;font-weight:700;paint-order:stroke;stroke:var(--card);stroke-width:4px;stroke-linejoin:round}.chart-line{fill:none;stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round}.chart-area{opacity:.09}.chart-point{stroke:var(--card);stroke-width:3;cursor:pointer;transition:r .15s}.chart-point:hover{r:6}.data-table{margin-top:12px;border-top:1px solid var(--line);padding-top:12px}.data-table summary{cursor:pointer;color:var(--muted);font-size:10px}.data-table table{width:100%;border-collapse:collapse;margin-top:12px;font-size:10px}.data-table td,.data-table th{padding:6px;border-bottom:1px solid #ecece7;text-align:right}.data-table th:first-child,.data-table td:first-child{text-align:left}.chart-tooltip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:white;border-radius:9px;padding:9px 11px;font-size:11px;box-shadow:0 10px 30px rgba(16,34,29,.25)}.chart-tooltip b{display:block;margin-top:3px;color:var(--lime)}.missing-survey{min-height:410px;margin:0 0 90px;padding:54px;background:var(--card);border:1px dashed #aebbb5;border-radius:24px;position:relative;overflow:hidden}.missing-survey:after{content:"";position:absolute;width:260px;height:260px;border-radius:50%;right:-80px;top:-80px;background:var(--lime);opacity:.18}.missing-survey__mark{display:block;font-size:64px;font-weight:800;letter-spacing:-.06em;color:#ccd3cf;margin-bottom:42px}.missing-survey h2{max-width:680px;font-size:clamp(32px,5vw,58px);line-height:1;letter-spacing:-.05em;margin:0 0 24px}.missing-survey>p:not(.eyebrow){max-width:700px;color:var(--muted);font-size:15px;line-height:1.65}.missing-survey a{display:inline-block;margin-top:24px;font-size:12px;font-weight:800;border-bottom:1px solid var(--ink)}
.chart-card__actions{display:flex;align-items:flex-end;gap:14px;margin-left:auto}.chart-card__actions .chart-card__latest{margin-left:0}.chart-card__expand{display:flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid rgba(7,91,54,.14);border-radius:9px;background:rgba(7,91,54,.055);color:#155d43;font:inherit;font-size:9px;font-weight:750;cursor:pointer}.chart-card__expand:hover{background:rgba(7,91,54,.11)}.chart-card--expanded{grid-column:1/-1}.chart-card:fullscreen{box-sizing:border-box;width:100vw;height:100vh;padding:clamp(28px,4vw,64px);border:0;border-radius:0;background:#f5fbf7;overflow:auto}.chart-card:fullscreen .chart-card__header{margin-bottom:28px}.chart-card:fullscreen .chart-card__title h3{font-size:clamp(24px,2.4vw,38px)}.chart-card:fullscreen .chart-card__title p{font-size:12px}.chart-card:fullscreen .chart-card__latest b{font-size:28px}.chart-card:fullscreen .chart-wrap{display:flex;align-items:center;min-height:calc(100vh - 230px)}.chart-card:fullscreen .status-chart{width:100%;max-height:calc(100vh - 230px)}.chart-card:fullscreen .axis-label{font-size:11px}.chart-card:fullscreen .point-label{font-size:9px;stroke-width:4px}.chart-card:fullscreen .chart-line{stroke-width:3.5}.chart-card:fullscreen .chart-point{r:5}.chart-card:fullscreen .qa-label{font-size:8.5px}.chart-card:fullscreen .comparison-overlay text{font-size:9px}.chart-card:fullscreen .chart-card__expand{font-size:11px;padding:10px 14px}.chart-card:fullscreen .data-table{margin-top:18px}.chart-card--expanded{padding:34px}.chart-card--expanded .chart-card__title h3{font-size:24px}.chart-card--expanded .axis-label{font-size:10px}.chart-card--expanded .point-label{font-size:9px}.chart-card--expanded .chart-line{stroke-width:3.3}
.qa-bar{fill:#16a34a;opacity:.32;stroke:#0b7a3b;stroke-width:1}.qa-label{fill:#087044;font-size:7px;font-weight:800;paint-order:stroke;stroke:rgba(255,255,255,.9);stroke-width:3px;stroke-linejoin:round}.qa-label__rate,.point-label__rate{font-weight:600;opacity:.72}
.overview-secondary-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.overview-secondary-line--0{stroke:#31d8b0}.overview-secondary-line--1{stroke:#68b8ff;stroke-dasharray:5 4}.overview-secondary-point{stroke:var(--ink);stroke-width:1.5}.overview-secondary-point--0{fill:#31d8b0}.overview-secondary-point--1{fill:#68b8ff}.overview-secondary-label{fill:#9af0d9;font-size:7px;font-weight:800;paint-order:stroke;stroke:#10382c;stroke-width:3px;stroke-linejoin:round}.overview-legend text{fill:#d9e7e2;font-size:9px;font-weight:700}.overview-legend line{stroke-width:3}.overview-response-axis{fill:#68b8ff;font-size:8px;font-weight:700}
.response-chart-block{margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.14)}.response-chart-title{display:flex;align-items:baseline;justify-content:space-between;gap:16px;color:#fff}.response-chart-title b{font-size:13px}.response-chart-title span{font-size:9px;color:#9db4ab}.response-chart{display:block;width:100%;height:auto;margin-top:6px;overflow:visible}.response-grid-line{stroke:rgba(143,162,155,.18);stroke-width:1}.response-axis-label{fill:#8fb9ad;font-size:8px}.response-chart-line{fill:none;stroke:#68b8ff;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.response-chart-point{fill:#68b8ff;stroke:var(--ink);stroke-width:1.5}.response-point-label{fill:#b9dcff;font-size:7px;font-weight:800;paint-order:stroke;stroke:#10382c;stroke-width:3px;stroke-linejoin:round}
.business-funnel{display:grid;gap:0;margin-top:30px;position:relative;z-index:1}.funnel-stage{--stage:#c9ff57;--stage-soft:rgba(201,255,87,.11);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:18px 22px 12px;background:linear-gradient(120deg,rgba(255,255,255,.075),rgba(255,255,255,.025));box-shadow:inset 0 1px rgba(255,255,255,.08)}.funnel-stage--sends{--stage:#39d7c0;--stage-soft:rgba(57,215,192,.11)}.funnel-stage--responses{--stage:#67b8ff;--stage-soft:rgba(103,184,255,.12)}.funnel-stage__head{display:flex;align-items:flex-start;justify-content:space-between;gap:22px}.funnel-stage__head span{display:block;color:var(--stage);font-size:9px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.funnel-stage__head h3{margin:5px 0 0;color:#fff;font-size:19px;line-height:1.1}.funnel-stage__head>strong{color:#fff;font-size:27px;line-height:1;text-align:right;letter-spacing:-.035em}.funnel-stage__head>strong small{display:block;margin-top:6px;color:#91a79f;font-size:8px;font-weight:500;letter-spacing:.08em;text-transform:uppercase}.funnel-stage svg{display:block;width:100%;height:auto;margin-top:3px;overflow:visible}.funnel-stage__grid{stroke:rgba(255,255,255,.12)}.funnel-stage__area{fill:var(--stage-soft)}.funnel-stage__line{fill:none;stroke:var(--stage);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.funnel-stage__point{fill:var(--stage);stroke:#0d2b22;stroke-width:2}.funnel-stage__month{fill:#89a097;font-size:8px}.funnel-stage__value{fill:#fff;font-size:8px;font-weight:800;paint-order:stroke;stroke:#12352a;stroke-width:3px;stroke-linejoin:round}.funnel-connector{height:56px;display:grid;grid-template-columns:34px auto 1fr;align-items:center;gap:10px;padding:0 22px;color:#fff}.funnel-connector span{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.1);color:var(--lime);font-size:18px}.funnel-connector b{font-size:20px}.funnel-connector small{color:#9db0a9;font-size:10px}.business-funnel--compact{margin-top:14px}.business-funnel--compact .funnel-stage{padding:12px 14px 8px;border-radius:16px}.business-funnel--compact .funnel-stage__head h3{font-size:13px}.business-funnel--compact .funnel-stage__head>strong{font-size:18px}.business-funnel--compact .funnel-stage__head span{font-size:7px}.business-funnel--compact .funnel-stage__value{font-size:7px}.business-funnel--compact .funnel-stage__month{font-size:7px}.business-funnel--compact .funnel-connector{height:42px;padding:0 14px;grid-template-columns:24px auto 1fr;gap:7px}.business-funnel--compact .funnel-connector span{width:22px;height:22px;font-size:13px}.business-funnel--compact .funnel-connector b{font-size:14px}.business-funnel--compact .funnel-connector small{font-size:8px}.group-dashboard{position:relative}.group-dashboard__charts{position:relative;z-index:1}
.alert-filter-group{display:flex;gap:6px}.alert-filter-group--period{margin-left:8px;padding-left:14px;border-left:1px solid rgba(255,255,255,.15)}.alert-filter-group--period button{color:#c7d5d0;background:rgba(255,255,255,.06)}.alert-filter-group--period button.active{color:#fff;background:rgba(104,184,255,.2);border-color:rgba(104,184,255,.45)}.comparison-overlay path{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;opacity:.88}.comparison-send{stroke:#16a37a}.comparison-response{stroke:#419ee8;stroke-dasharray:6 4}.comparison-legend text{fill:#55766b;font-size:8px;font-weight:800}.comparison-legend line{stroke-width:3}.comparison-legend .comparison-note{fill:#7e918a;font-weight:600}
.event-card:not(.is-missing){min-height:386px}.event-funnel{margin:14px 0 13px;padding-top:10px;border-top:1px solid rgba(8,82,50,.1)}.event-funnel__caption{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;color:#315f52;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.09em}.event-funnel__caption small{color:var(--muted);font-size:7px}.event-funnel__step{min-height:36px;margin:0 auto 4px;padding:6px 9px;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:7px;color:#063722;background:linear-gradient(90deg,rgba(33,160,56,.14),rgba(0,168,143,.07));border:1px solid rgba(33,160,56,.14);clip-path:polygon(3% 0,97% 0,93% 100%,7% 100%)}.event-funnel__step--1{width:100%}.event-funnel__step--2{width:88%}.event-funnel__step--3{width:76%;margin-bottom:0}.event-funnel__step>span{font-size:9px;font-weight:800;line-height:1.1}.event-funnel__step>span small{display:block;margin-top:2px;font-size:6px;font-weight:600;color:#638276}.event-funnel__step>b{font-size:11px;white-space:nowrap}.event-funnel__step>em{min-width:48px;text-align:right;font-size:8px;font-style:normal;font-weight:900;white-space:nowrap}.event-funnel__step>em.up{color:#087c46}.event-funnel__step>em.down{color:#c94b43}.event-funnel__step>em.neutral{color:#71847b}
.event-card:not(.is-missing){min-height:430px}.event-funnel{margin:15px 0 14px;padding-top:12px}.event-funnel__caption{margin-bottom:10px;font-size:9px;letter-spacing:.08em}.event-funnel__caption small{padding:3px 7px;border-radius:999px;background:rgba(8,82,50,.06);font-size:8px}.event-funnel__step{position:relative;min-height:43px;margin-bottom:9px;padding:7px 10px;grid-template-columns:minmax(72px,1fr) minmax(54px,auto) minmax(53px,auto);gap:9px;clip-path:none;border-radius:12px;background:rgba(255,255,255,.62);border:1px solid rgba(8,118,72,.14);box-shadow:0 5px 14px rgba(8,79,47,.055)}.event-funnel__step:before{content:"";position:absolute;inset:7px auto 7px 5px;width:3px;border-radius:5px;background:#3aad7a}.event-funnel__step:not(:last-child):after{content:"↓";position:absolute;left:50%;bottom:-11px;transform:translateX(-50%);z-index:2;width:15px;height:15px;display:grid;place-items:center;border-radius:50%;background:#e8f7ee;color:#188754;font-size:8px;font-weight:900}.event-funnel__step--1{width:100%}.event-funnel__step--2{width:94%}.event-funnel__step--3{width:88%;margin-bottom:0}.event-funnel__step>span{padding-left:5px;font-size:10px;line-height:1.15}.event-funnel__step>span small{margin-top:3px;font-size:7px}.event-funnel__step>b{font-size:12px;text-align:right}.event-funnel__step>em{min-width:53px;padding:4px 6px;border-radius:999px;text-align:center;font-size:8px;background:rgba(8,82,50,.045)}.event-funnel__step>em.up{background:rgba(22,163,74,.09)}.event-funnel__step>em.down{background:rgba(201,75,67,.08)}
.spark-block{margin:9px 0 6px}.event-card .spark-block .spark{height:55px;margin:2px 0 0}.spark-caption{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#315f52}.spark-caption>span{font-size:8px;font-weight:800}.spark-caption small{display:flex;align-items:center;gap:4px;color:#6c8379;font-size:6px;white-space:nowrap}.spark-caption i{display:inline-block;width:5px;height:5px;border:1.5px solid #3e806d;border-radius:50%;background:rgba(255,255,255,.7)}
.survey-identity{min-height:39px;margin-top:9px;padding-bottom:7px;border-bottom:1px solid rgba(8,82,50,.09)}.survey-identity strong,.survey-identity span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.survey-identity strong{font-size:12px;color:#073b25}.survey-identity span{margin-top:3px;color:#648075;font-size:7px;text-transform:uppercase;letter-spacing:.08em}.plan-progress{display:grid;grid-template-columns:1fr auto;align-items:center;gap:3px 8px;margin-top:9px;padding:8px 10px;border-radius:11px;background:rgba(255,255,255,.56);border:1px solid rgba(8,118,72,.12)}.plan-progress>div:first-child{display:flex;align-items:baseline;gap:6px}.plan-progress>div:first-child span{color:#6b8178;font-size:7px;text-transform:uppercase;letter-spacing:.08em}.plan-progress>div:first-child b{font-size:10px}.plan-progress>strong{font-size:13px;color:#ad6a18}.plan-progress>strong.is-complete{color:#12804b}.plan-progress>i{grid-column:1/-1;height:4px;border-radius:99px;background:rgba(8,82,50,.09);overflow:hidden}.plan-progress>i span{display:block;width:var(--progress);height:100%;border-radius:inherit;background:linear-gradient(90deg,#21a038,#00a88f)}.plan-pace{grid-column:1/-1;display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:5px;padding-top:7px;border-top:1px solid rgba(8,82,50,.09)}.plan-pace span{color:#5d776c;font-size:7px;line-height:1.3}.plan-pace span b{color:#173f31;font-size:8px}.plan-pace strong{max-width:112px;text-align:right;color:#0b7145;font-size:9px;line-height:1.2}.plan-pace--risk strong{color:#bb493f}.plan-pace--done{align-items:center}.plan-pace--done b{color:#12804b;font-size:9px}.send-pace{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}.send-pace>div{display:grid;gap:2px;padding:7px;border-radius:8px;background:rgba(7,91,54,.055)}.send-pace span{font-size:7px;color:#60796f;text-transform:uppercase;letter-spacing:.07em}.send-pace b{font-size:9px;color:#143f30}.send-pace small{font-size:7px;line-height:1.25;color:#5d776c}.send-pace .is-risk{background:rgba(196,79,61,.07)}.send-pace .is-risk small{color:#ad493e;font-weight:700}.send-pace .is-ok small{color:#12804b;font-weight:700}.event-card.is-top{min-height:600px}.event-card.is-missing.is-top .spark{opacity:1}.event-card.is-missing.is-top{background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(224,250,232,.72));border-style:solid}
.plan-progress .send-pace{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px;margin-top:7px}.plan-progress .send-pace__card{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:1px;padding:8px;border-radius:9px;background:rgba(7,91,54,.055)}.plan-progress .send-pace__label{display:block;font-size:7px;line-height:1.2;color:#60796f;text-transform:uppercase;letter-spacing:.08em;white-space:normal}.plan-progress .send-pace__value{display:block;margin-top:3px;font-size:14px;line-height:1;color:#123e2f;letter-spacing:-.02em;white-space:nowrap}.plan-progress .send-pace__unit{display:block;font-size:7px;line-height:1.2;color:#405f53;text-transform:none;letter-spacing:0;white-space:normal}.plan-progress .send-pace__note{display:block;margin-top:5px;font-size:7px;line-height:1.3;color:#5d776c}.plan-progress .send-pace__card.is-risk{background:rgba(196,79,61,.07)}.plan-progress .send-pace__card.is-risk .send-pace__note{color:#ad493e;font-weight:700}.plan-progress .send-pace__card.is-ok .send-pace__note{color:#12804b;font-weight:700}
.card-actions{display:flex;align-items:flex-start;gap:8px}.card-expand{position:relative;z-index:2;display:grid;place-items:center;width:27px;height:27px;padding:0;border:1px solid rgba(8,82,50,.14);border-radius:8px;background:rgba(255,255,255,.65);color:#195c45;font-size:15px;line-height:1;cursor:pointer;transition:background .2s,transform .2s}.card-expand:hover{background:#fff;transform:scale(1.08)}.response-plan-head{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.response-plan-head>div{display:flex;min-width:0;flex-direction:column;padding:9px;border-radius:10px;background:rgba(255,255,255,.62);border:1px solid rgba(8,118,72,.12)}.response-plan-head span{min-height:18px;color:#60796f;font-size:7px;line-height:1.25;text-transform:uppercase;letter-spacing:.07em}.response-plan-head b{margin-top:4px;color:#0b3827;font-size:19px;line-height:1;letter-spacing:-.035em;white-space:nowrap}.response-plan-head small{margin-top:4px;color:#6a8177;font-size:7px}.plan-progress{display:block;margin-top:7px}.plan-progress>i{display:block;width:100%;height:5px}.plan-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}.plan-metric{display:flex;min-width:0;flex-direction:column;align-items:flex-start;padding:8px;border-radius:9px;background:rgba(7,91,54,.055)}.plan-metric span{color:#60796f;font-size:7px;text-transform:uppercase;letter-spacing:.08em}.plan-metric b{margin-top:3px;color:#123e2f;font-size:14px;line-height:1;white-space:nowrap}.plan-metric small{margin-top:3px;color:#405f53;font-size:7px}.plan-metric.is-risk{background:rgba(196,79,61,.07)}.plan-complete{margin-top:8px;padding:9px;border-radius:9px;background:rgba(33,160,56,.09);color:#12804b;font-size:9px;font-weight:800;text-align:center}.chart-dialog.is-card-view{width:min(760px,94vw);background:linear-gradient(145deg,#eaf8ef,#d8f3e5);color:#073b25}.chart-dialog.is-card-view .chart-dialog__head{background:rgba(236,250,242,.9);color:#073b25;border-color:rgba(8,82,50,.1)}.chart-dialog.is-card-view .chart-dialog__head .eyebrow{color:#12804b}.chart-dialog.is-card-view .chart-dialog__head button{border-color:rgba(8,82,50,.14);background:rgba(8,82,50,.06);color:#073b25}.chart-dialog.is-card-view .chart-dialog__body{display:flex;justify-content:center;padding:24px}.chart-dialog.is-card-view .event-card{width:min(560px,100%);min-height:0;padding:30px;transform:none;cursor:default}.chart-dialog.is-card-view .event-card:before{width:6px}.chart-dialog.is-card-view .survey-identity strong{font-size:18px}.chart-dialog.is-card-view .survey-identity span,.chart-dialog.is-card-view .response-plan-head span,.chart-dialog.is-card-view .plan-metric span,.chart-dialog.is-card-view .send-pace__label{font-size:10px}.chart-dialog.is-card-view .spark-caption>span{font-size:11px}.chart-dialog.is-card-view .spark-caption small{font-size:9px}.chart-dialog.is-card-view .event-card .spark-block .spark{height:92px}.chart-dialog.is-card-view .response-plan-head b{font-size:30px}.chart-dialog.is-card-view .response-plan-head small,.chart-dialog.is-card-view .plan-metric small,.chart-dialog.is-card-view .send-pace__unit,.chart-dialog.is-card-view .send-pace__note{font-size:10px}.chart-dialog.is-card-view .plan-metric b,.chart-dialog.is-card-view .send-pace__value{font-size:22px}.chart-dialog.is-card-view .event-funnel__caption{font-size:11px}.chart-dialog.is-card-view .event-funnel__step>span{font-size:13px}.chart-dialog.is-card-view .event-funnel__step>span small{font-size:9px}.chart-dialog.is-card-view .event-funnel__step>b{font-size:16px}.chart-dialog.is-card-view .event-funnel__step>em{font-size:10px}.chart-dialog.is-card-view .card-expand{display:none}
.plan-status{display:grid;grid-template-columns:84px 1fr;align-items:center;gap:10px;margin-top:10px}.plan-ring{width:78px;aspect-ratio:1;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#20b96b var(--progress),#e4ece8 0);position:relative}.plan-ring:after{content:"";position:absolute;inset:8px;border-radius:50%;background:#f7fcf9}.plan-ring>div{position:relative;z-index:1;text-align:center}.plan-ring b,.plan-ring span{display:block}.plan-ring b{font-size:17px;line-height:1}.plan-ring span{margin-top:4px;color:#60796f;font-size:7px;line-height:1.2}.plan-status__message{min-height:72px;display:flex;flex-direction:column;justify-content:center;padding:10px 12px;border-radius:12px}.plan-status__message.is-risk{background:linear-gradient(135deg,#fff0f1,#ffe5e8);color:#bb2538}.plan-status__message.is-ok{background:linear-gradient(135deg,#eaf9ef,#e0f6e9);color:#14804b}.plan-status__message b{font-size:12px}.plan-status__message span{margin-top:5px;color:#4e645b;font-size:8px;line-height:1.35}.response-plan-head{grid-template-columns:1fr 1fr 1fr}.response-plan-head>div.is-deficit{background:linear-gradient(135deg,#fff1f2,#ffe5e8);border-color:rgba(190,37,56,.08)}.response-plan-head>div.is-deficit b{color:#c32239}.event-card.is-top .spark-block{order:7;margin-top:14px;padding-top:12px;border-top:1px solid rgba(8,82,50,.1)}.event-card.is-top .event-card__top{order:1}.event-card.is-top .survey-identity{order:2}.event-card.is-top .plan-status{order:3}.event-card.is-top .response-plan-head{order:4}.event-card.is-top .plan-progress{order:5}.event-card.is-top .event-funnel{order:6;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}.event-card.is-top .event-funnel__caption{grid-column:1/-1}.event-card.is-top .event-funnel__step{width:100%;margin:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-height:76px;padding:9px;box-shadow:none}.event-card.is-top .event-funnel__step:after{content:"→";left:auto;right:-11px;bottom:50%;transform:translateY(50%)}.event-card.is-top .event-funnel__step:last-child:after{display:none}.event-card.is-top .event-funnel__step>b{font-size:14px;text-align:left}.event-card.is-top .event-funnel__step>em{min-width:0;text-align:left}.event-card.is-top .event-card__meta{order:8;width:100%}.event-card.is-top{min-height:760px}.chart-dialog.is-card-view .plan-status{grid-template-columns:125px 1fr}.chart-dialog.is-card-view .plan-ring{width:116px}.chart-dialog.is-card-view .plan-ring:after{inset:11px}.chart-dialog.is-card-view .plan-ring b{font-size:27px}.chart-dialog.is-card-view .plan-ring span{font-size:10px}.chart-dialog.is-card-view .plan-status__message{min-height:105px;padding:18px}.chart-dialog.is-card-view .plan-status__message b{font-size:20px}.chart-dialog.is-card-view .plan-status__message span{font-size:13px}.chart-dialog.is-card-view .response-plan-head{gap:12px}.chart-dialog.is-card-view .event-funnel{gap:10px}.chart-dialog.is-card-view .event-funnel__step{min-height:100px;padding:14px}
.event-card.is-top .event-card__top{align-items:center}.event-card.is-top .event-id{flex-wrap:wrap}.event-card.is-top .top-badge{order:-1}.survey-inline{display:flex;align-items:baseline;gap:5px;padding-left:8px;border-left:1px solid rgba(8,82,50,.16)}.survey-inline b{font-size:11px}.survey-inline i{color:#648075;font-size:7px;font-style:normal;text-transform:uppercase;letter-spacing:.05em}.event-card.is-top .survey-identity{min-height:0;margin-top:8px;padding:7px 9px;border:0;border-radius:8px;background:rgba(8,82,50,.045);display:flex;align-items:center;justify-content:space-between}.event-card.is-top .survey-identity span{margin:0;font-size:7px}.event-card.is-top .survey-identity strong{font-size:9px}.event-card.is-top .event-funnel{order:5;margin-top:10px}.event-card.is-top .plan-progress{order:6;margin-top:12px;padding-top:10px;border-top:1px solid rgba(8,82,50,.1)}.event-card.is-top .spark-block{order:7}.action-title{margin-bottom:8px;color:#123e2f;font-size:11px;font-weight:850}.chart-dialog.is-card-view .survey-inline b{font-size:16px}.chart-dialog.is-card-view .survey-inline i{font-size:10px}.chart-dialog.is-card-view .action-title{font-size:16px}
.group-dashboard header a{color:var(--lime);font-size:11px}.group-dashboard__charts{position:relative}.chart-expand{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin:10px 0 12px;padding:9px 12px;border:1px solid rgba(255,255,255,.18);border-radius:11px;background:rgba(255,255,255,.07);color:#e7f4ef;font:inherit;font-size:10px;font-weight:700;cursor:pointer;transition:background .18s,transform .18s}.chart-expand:hover{background:rgba(255,255,255,.13);transform:translateY(-1px)}
.chart-dialog{width:min(1240px,94vw);max-width:none;max-height:92vh;margin:auto;padding:0;border:1px solid rgba(255,255,255,.2);border-radius:28px;background:linear-gradient(145deg,#07472f,#06291f 62%,#00785d);color:#fff;box-shadow:0 32px 120px rgba(0,30,20,.48);overflow:auto}.chart-dialog::backdrop{background:rgba(3,23,16,.68);backdrop-filter:blur(9px)}.chart-dialog__head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:22px 28px;background:rgba(5,47,34,.84);border-bottom:1px solid rgba(255,255,255,.13);backdrop-filter:blur(18px)}.chart-dialog__head .eyebrow{display:block;margin:0 0 4px;color:var(--lime)}.chart-dialog__head strong{font-size:22px}.chart-dialog__head button{display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(255,255,255,.18);border-radius:50%;background:rgba(255,255,255,.08);color:#fff;font-size:26px;cursor:pointer}.chart-dialog__body{padding:24px 34px 36px}.chart-dialog__body .overview-chart{width:100%;margin-top:0}.chart-dialog__body .response-chart-block{margin-top:26px;padding-top:24px}.chart-dialog__body .response-chart-title b{font-size:18px}.chart-dialog__body .overview-point-label,.chart-dialog__body .overview-secondary-label,.chart-dialog__body .response-point-label{font-size:9px}
@media(max-width:1100px){.event-grid{grid-template-columns:repeat(3,1fr)}.chart-grid{grid-template-columns:1fr}}
@media(max-width:800px){.overview-hero{grid-template-columns:1fr;padding-top:65px}.overview-hero__pulse{order:-1}.event-grid{grid-template-columns:repeat(2,1fr)}.sidebar{position:static;width:auto;height:72px;padding:0 20px;flex-direction:row;align-items:center}.sidebar nav{margin:0 0 0 auto;flex-direction:row}.sidebar nav a{padding:9px}.sidebar nav a span,.sidebar nav a:after,.sidebar nav a:not(.active){display:none}.sidebar-note{display:none}.detail-main{margin-left:0}.event-hero{padding-top:48px}}
@media(max-width:560px){.site-header{height:70px}.period-pill{display:none}.overview-page main{padding:0 18px}.overview-hero h1{font-size:62px}.overview-hero__pulse{padding:22px 16px;border-radius:22px}.pulse-header{gap:12px;font-size:9px}.pulse-header .trend{max-width:50%}.overview-axis-label{font-size:8px}.overview-point-label{font-size:7px}.metric-strip{margin-bottom:72px}.catalogue-tools{flex-direction:column}.sort-box{justify-content:space-between}.event-grid{grid-template-columns:1fr 1fr;gap:8px}.event-card{padding:16px;min-height:185px}.event-card__value{font-size:21px}.event-card .spark{margin:14px 0}.event-card__meta span:first-child{display:none}.detail-main{padding:0 16px}.detail-topbar{height:66px}.event-jump>span{display:none}.event-hero{display:block}.event-hero h1{font-size:90px}.hero-stamp{margin-top:38px}.kpi-grid{grid-template-columns:1fr}.kpi-grid article{padding:18px;border-right:0;border-bottom:1px solid var(--line)}.kpi-grid article:last-child{border-bottom:0}.kpi-grid b{font-size:23px}.chart-card{padding:16px}.chart-card__header{flex-wrap:wrap}.chart-card__latest{width:100%;text-align:left;margin-left:47px}.section-heading--charts{align-items:flex-start;gap:10px}.section-heading--charts>span{max-width:90px;text-align:right}.overview-page>footer,footer{flex-direction:column}.sidebar nav a.active{font-size:0}.sidebar nav a.active span{display:block;font-size:20px}}
@media(max-width:700px){.alert-panel{padding:24px 18px}.alert-panel__header{align-items:flex-start;flex-direction:column}.alert-summary{flex-wrap:wrap}.alert-summary small{width:100%;margin:2px 0 0}.alert-list{grid-template-columns:1fr;max-height:620px}.alert-item__top{gap:8px}}
@media(max-width:720px){.dashboard-links{grid-template-columns:1fr}.event-card__meta span:first-child{display:inline}.group-dashboard{padding:20px 16px}.group-dashboard__kpi b{font-size:30px}}
.alert-summary button{appearance:none;border:1px solid transparent;padding:7px 10px;border-radius:8px;font:inherit;font-size:11px;font-weight:800;cursor:pointer;opacity:.42;transition:opacity .18s,transform .18s,border-color .18s}.alert-summary button.active{opacity:1;border-color:rgba(255,255,255,.18);transform:translateY(-1px)}.alert-summary__down{color:#ff9e8e;background:rgba(255,130,111,.1)}.alert-summary__up{color:var(--lime);background:rgba(201,255,87,.09)}.alert-item[hidden]{display:none}
/* Sber-inspired interface: no logos or proprietary graphic marks */
:root{--ink:#082b1c;--muted:#557064;--paper:#eef8f2;--card:rgba(255,255,255,.68);--line:rgba(8,82,50,.13);--lime:#b6ff5c;--mint:#21a038;--coral:#ff7868;--blue:#16b8f3;--shadow:0 24px 70px rgba(8,79,47,.13);font-family:"SB Sans Text","Segoe UI",Arial,sans-serif}
body{background:radial-gradient(circle at 8% 7%,rgba(33,160,56,.16),transparent 28%),radial-gradient(circle at 92% 18%,rgba(0,190,151,.14),transparent 26%),linear-gradient(145deg,#f6fbf8 0%,#eaf7f0 55%,#f8fcfa 100%);background-attachment:fixed}
.site-header{position:sticky;top:0;z-index:12;height:76px;background:rgba(244,251,247,.64);border-bottom:1px solid rgba(255,255,255,.7);box-shadow:0 8px 32px rgba(9,67,43,.06);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%)}
.brand__mark{display:none}.brand b{font-size:16px;color:#0b6f3c}.brand small{color:#638276}.period-pill{background:rgba(255,255,255,.58);border-color:rgba(33,160,56,.18);backdrop-filter:blur(12px)}
.overview-page main{max-width:1540px}.overview-hero--main{display:block;padding:52px 0 80px}.overview-hero--main .overview-hero__copy{max-width:1040px;margin:0 auto 32px;text-align:center}.overview-hero--main h1{font-size:clamp(44px,6vw,84px);line-height:.96;white-space:nowrap;background:linear-gradient(100deg,#073b23 8%,#16a34a 56%,#00a88f 100%);-webkit-background-clip:text;background-clip:text;color:transparent}.overview-hero--main .lede{max-width:720px;margin:20px auto 0;font-size:17px}.overview-hero--main .overview-hero__pulse{width:100%;padding:30px 56px 28px;border-radius:38px;background:linear-gradient(145deg,rgba(7,71,43,.96),rgba(8,38,29,.95) 55%,rgba(0,118,86,.93));border:1px solid rgba(255,255,255,.18);box-shadow:0 35px 100px rgba(1,69,41,.28),inset 0 1px 0 rgba(255,255,255,.18);backdrop-filter:blur(28px) saturate(150%)}
.overview-hero--main .overview-hero__pulse:after,.group-dashboard:after,.event-card:after{content:"";position:absolute;inset:1px 12% auto;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent);pointer-events:none}.overview-hero--main .pulse-header{font-size:12px}.overview-hero--main .overview-hero__pulse>strong{font-size:clamp(54px,8vw,100px);margin-top:28px}.overview-hero--main .pulse-current-label{font-size:14px}.overview-hero--main .overview-chart{margin-top:24px}.overview-hero--main .business-funnel{margin-top:18px}
.dashboard-links{margin:0 0 110px;gap:22px}.group-dashboard{position:relative;background:linear-gradient(145deg,rgba(6,72,43,.92),rgba(3,46,34,.95));border:1px solid rgba(255,255,255,.18);border-radius:28px;box-shadow:0 20px 60px rgba(8,79,47,.18),inset 0 1px rgba(255,255,255,.15);backdrop-filter:blur(24px) saturate(150%)}
.catalogue-tools,.scope-toggle,.event-card,.kpi-grid,.chart-card,.missing-survey{backdrop-filter:blur(20px) saturate(155%);-webkit-backdrop-filter:blur(20px) saturate(155%)}
.event-card{overflow:hidden;background:linear-gradient(145deg,rgba(255,255,255,.82),rgba(236,250,242,.64));border-color:rgba(255,255,255,.92);box-shadow:0 14px 42px rgba(8,79,47,.08),inset 0 1px rgba(255,255,255,.95)}.event-card.is-top{background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(224,250,232,.72));border-color:rgba(33,160,56,.2)}.event-card:hover{transform:translateY(-7px) scale(1.012);box-shadow:0 24px 60px rgba(8,79,47,.17)}
.search-box,.sort-box{background:rgba(255,255,255,.64);border-color:rgba(255,255,255,.9);box-shadow:0 10px 30px rgba(8,79,47,.06);backdrop-filter:blur(18px)}
.scope-toggle{background:rgba(255,255,255,.5);border:1px solid rgba(255,255,255,.75)}.scope-toggle button.active{background:linear-gradient(135deg,#168b43,#007c60)}
.alert-panel,.sidebar{background:linear-gradient(155deg,#063c25,#06291f 60%,#006c52)}.kpi-grid,.chart-card,.missing-survey{background:rgba(255,255,255,.67);border-color:rgba(255,255,255,.85);box-shadow:0 16px 48px rgba(8,79,47,.09)}
@supports (animation-timeline:view()){.group-dashboard,.event-card{animation:glass-reveal linear both;animation-timeline:view();animation-range:entry 5% cover 24%}@keyframes glass-reveal{from{opacity:.25;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}}
@container (max-width:360px){.event-card__value{font-size:22px}.spark__label{font-size:6px}}
@media(max-width:800px){.overview-hero--main{padding-top:40px}.overview-hero--main .overview-hero__pulse{padding:28px 20px;border-radius:28px}.overview-hero--main .overview-hero__copy{text-align:left}.overview-hero--main .lede{margin-left:0}.overview-hero--main h1{font-size:clamp(40px,11vw,56px);white-space:normal}.dashboard-links{grid-template-columns:1fr}}
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
const scopeButtons=[...document.querySelectorAll('[data-scope]')];
let scope='top';
const plural=n=>{const d=n%10,h=n%100;return h>=11&&h<=14?'опросов':d===1?'опрос':d>=2&&d<=4?'опроса':'опросов'};
function update(){
  const query=search.value.trim().toLowerCase();
  let visible=cards.filter(card=>(scope==='top'?card.dataset.top==='true':card.dataset.hasData==='true')&&(!query||card.dataset.search.includes(query)));
  const key=sort.value;
  visible.sort((a,b)=>key==='top'?Number(a.dataset.rank)-Number(b.dataset.rank):key==='id'?Number(a.dataset.id)-Number(b.dataset.id):key==='change'?Number(b.dataset.change)-Number(a.dataset.change):Number(b.dataset.latest)-Number(a.dataset.latest));
  cards.forEach(card=>card.hidden=true);
  visible.forEach(card=>{card.hidden=false;grid.append(card)});
  count.textContent=visible.length+' '+plural(visible.length);
  empty.hidden=visible.length!==0;
}
scopeButtons.forEach(button=>button.addEventListener('click',()=>{scope=button.dataset.scope;scopeButtons.forEach(item=>item.classList.toggle('active',item===button));sort.value='latest';update()}));
search.addEventListener('input',update);sort.addEventListener('change',update);update();
const chartDialog=document.getElementById('chartDialog');
if(chartDialog){
  const dialogBody=chartDialog.querySelector('.chart-dialog__body');
  const dialogEyebrow=chartDialog.querySelector('.chart-dialog__head .eyebrow');
  const dialogTitle=chartDialog.querySelector('.chart-dialog__head strong');
  document.querySelectorAll('.chart-expand').forEach(button=>button.addEventListener('click',()=>{
    const dashboard=button.closest('.group-dashboard');
    chartDialog.classList.remove('is-card-view');
    dialogEyebrow.textContent=dashboard.querySelector('.eyebrow').textContent;
    dialogTitle.textContent='Динамика событий, отправок и ответов';
    dialogBody.replaceChildren(dashboard.querySelector('.group-dashboard__charts').cloneNode(true));
    chartDialog.showModal();
  }));
  document.querySelectorAll('.card-expand').forEach(button=>button.addEventListener('click',event=>{
    event.preventDefault();event.stopPropagation();
    const card=button.closest('.event-card');
    const clone=card.cloneNode(true);
    clone.removeAttribute('href');clone.removeAttribute('hidden');
    chartDialog.classList.add('is-card-view');
    dialogEyebrow.textContent='ОПРОС '+card.dataset.id;
    dialogTitle.textContent='План и динамика ответов';
    dialogBody.replaceChildren(clone);
    chartDialog.showModal();
  }));
  chartDialog.querySelector('.chart-dialog__head button').addEventListener('click',()=>chartDialog.close());
  chartDialog.addEventListener('click',event=>{if(event.target===chartDialog)chartDialog.close()});
}
`;
fs.writeFileSync(path.join(assetsDir, 'index.js'), indexJs.trim() + '\n');

const dashboardJs = `
const data=window.EVENT_DATA;
const nf=new Intl.NumberFormat('ru-RU');
const compact=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
const monthNames=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
const monthLabel=value=>{const [year,month]=value.split('-');return monthNames[Number(month)-1]+' '+year.slice(2)};
const jump=document.getElementById('eventJump');
window.EVENT_LIST.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent='#'+item.id+(item.id===data.id?' · текущий':item.isTop?' · топ':'')+(item.hasData?'':' · нет данных');option.selected=item.id===data.id;jump.append(option)});
jump.addEventListener('change',()=>location.href=jump.value+'.html');
const tooltip=document.getElementById('chartTooltip');
const colorFor=code=>{if(code===0)return '#2ca77c';let n=Math.abs(Number(code));return ['#5f8dff','#f17665','#8a6fe8','#df9b39','#32a4b8','#cc5c8d'][n%6]};
const communicationStatus=data.statuses.find(status=>status.code===0);
function smoothPath(points){if(points.length<2)return points.length?'M'+points[0][0]+','+points[0][1]:'';let d='M'+points[0][0]+','+points[0][1];for(let i=0;i<points.length-1;i++){const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;const c1=[p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6];const c2=[p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6];d+=' C'+c1[0].toFixed(1)+','+c1[1].toFixed(1)+' '+c2[0].toFixed(1)+','+c2[1].toFixed(1)+' '+p2[0].toFixed(1)+','+p2[1].toFixed(1)}return d}
function niceMax(value){if(value<=0)return 1;const power=10**Math.floor(Math.log10(value));const ratio=value/power;const nice=ratio<=1?1:ratio<=2?2:ratio<=5?5:10;return nice*power}
function renderChart(status){
  const width=720,height=270,pad={top:45,right:20,bottom:38,left:62};
  const plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const max=niceMax(Math.max(...status.values));
  const points=status.values.map((value,index)=>[pad.left+(index/(status.values.length-1))*plotW,pad.top+plotH-(value/max)*plotH]);
  const line=smoothPath(points),area=line+' L'+points.at(-1)[0]+','+(pad.top+plotH)+' L'+points[0][0]+','+(pad.top+plotH)+' Z';
  const isQaResponse=status.isQaResponse===true;
  const displayCode=status.displayCode??status.code;
  const displayDescription=status.displayDescription??status.description;
  const color=isQaResponse?'#16a34a':colorFor(status.code);
  const hasQa=status.code===0&&Array.isArray(status.qaValues);
  const ticks=[0,.25,.5,.75,1].map(f=>{const y=pad.top+plotH-f*plotH;return '<line class="grid-line" x1="'+pad.left+'" y1="'+y+'" x2="'+(width-pad.right)+'" y2="'+y+'"/><text class="axis-label" x="'+(pad.left-10)+'" y="'+(y+3)+'" text-anchor="end">'+compact.format(max*f)+'</text>'}).join('');
  const months=data.months.map((month,index)=>'<text class="axis-label" x="'+points[index][0]+'" y="'+(height-10)+'" text-anchor="middle">'+monthLabel(month)+'</text>').join('');
  const qaBars=hasQa?status.qaValues.map((value,index)=>{if(value===null)return '';const response=Math.min(value,status.values[index]);const barHeight=status.values[index]?Math.max(2,(response/max)*plotH):0;const rate=status.values[index]?(response/status.values[index])*100:0;const labelY=Math.max(pad.top+plotH-barHeight-16,16);return '<g class="qa-bar-group"><rect class="qa-bar" x="'+(points[index][0]-8)+'" y="'+(pad.top+plotH-barHeight)+'" width="16" height="'+barHeight+'"><title>'+data.months[index]+': '+nf.format(response)+' ответов · отклик '+rate.toFixed(1).replace('.',',')+'%</title></rect><text class="qa-label" x="'+points[index][0]+'" y="'+labelY+'" text-anchor="middle"><tspan x="'+points[index][0]+'">'+compact.format(response)+'</tspan><tspan class="qa-label__rate" x="'+points[index][0]+'" dy="10">'+rate.toFixed(1).replace('.',',')+'%</tspan></text></g>'}).join(''):'';
  const comparisonOverlay=!hasQa&&!isQaResponse&&communicationStatus?(()=>{
    const overlayPath=values=>{const safe=values.map(value=>value??0),low=Math.min(...safe),high=Math.max(...safe),range=Math.max(high-low,1);const overlayPoints=safe.map((value,index)=>[pad.left+(index/(safe.length-1))*plotW,pad.top+plotH-((value-low)/range)*plotH]);return smoothPath(overlayPoints)};
    const responses=communicationStatus.qaValues?.map(value=>value??0)||Array(data.months.length).fill(0);
    return '<g class="comparison-overlay"><g class="comparison-legend"><line class="comparison-send" x1="'+pad.left+'" y1="24" x2="'+(pad.left+22)+'" y2="24"/><text x="'+(pad.left+28)+'" y="27">Отправки</text><line class="comparison-response" x1="'+(pad.left+105)+'" y1="24" x2="'+(pad.left+127)+'" y2="24"/><text x="'+(pad.left+133)+'" y="27">Ответы</text><text class="comparison-note" x="'+(width-pad.right)+'" y="27" text-anchor="end">сравнительный фон · нормировано</text></g><path class="comparison-send" d="'+overlayPath(communicationStatus.values)+'"/><path class="comparison-response" d="'+overlayPath(responses)+'"/></g>';
  })():'';
  const pointEls=points.map((point,index)=>{const labelY=Math.max(point[1]-(isQaResponse?20:12),16);const rate=isQaResponse&&status.rates[index]!==null?status.rates[index].toFixed(1).replace('.',',')+'%':null;return '<g><circle class="chart-point" data-index="'+index+'" cx="'+point[0]+'" cy="'+point[1]+'" r="4" fill="'+color+'"/><text class="point-label" x="'+point[0]+'" y="'+labelY+'" text-anchor="middle"><tspan x="'+point[0]+'">'+compact.format(status.values[index])+'</tspan>'+(rate?'<tspan class="point-label__rate" x="'+point[0]+'" dy="11">'+rate+'</tspan>':'')+'</text></g>'}).join('');
  const rows=data.months.map((month,index)=>'<tr><td>'+month+'</td><td>'+nf.format(status.values[index])+'</td>'+(hasQa?'<td>'+(status.qaValues[index]===null?'—':nf.format(status.qaValues[index]))+'</td><td>'+(status.qaValues[index]===null||!status.values[index]?'—':(status.qaValues[index]/status.values[index]*100).toFixed(1).replace('.',',')+'%')+'</td>':'')+'</tr>').join('');
  const card=document.createElement('article');card.className='chart-card';
  card.innerHTML='<header class="chart-card__header"><span class="status-chip">'+displayCode+'</span><div class="chart-card__title"><h3>'+displayDescription+'</h3><p>'+(isQaResponse?'Количество полученных ответов · подпись точки содержит отклик':hasQa?'Линия — отправки · столбцы — ответы и отклик':'Статус '+status.code+' · сравнение с основными бизнес-метриками')+'</p></div><div class="chart-card__actions"><div class="chart-card__latest"><b>'+nf.format(status.latest)+'</b><small>'+data.months.at(-1)+'</small></div><button class="chart-card__expand" type="button" aria-label="Развернуть график на весь экран" title="Развернуть на весь экран">⛶ <span>Развернуть</span></button></div></header><div class="chart-wrap"><svg class="status-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Динамика: '+displayDescription+'">'+ticks+months+qaBars+'<path class="chart-area" d="'+area+'" fill="'+color+'"/><path class="chart-line" d="'+line+'" stroke="'+color+'"/>'+comparisonOverlay+pointEls+'</svg></div><details class="data-table"><summary>Показать таблицу значений</summary><table><thead><tr><th>Месяц</th><th>'+(isQaResponse?'Ответы':'Отправки')+'</th>'+(hasQa?'<th>Ответы</th><th>Отклик</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></details>';
  const expandButton=card.querySelector('.chart-card__expand');
  expandButton.addEventListener('click',async()=>{
    if(document.fullscreenElement===card){await document.exitFullscreen();return}
    if(card.requestFullscreen){await card.requestFullscreen();return}
    card.classList.toggle('chart-card--expanded');
    expandButton.querySelector('span').textContent=card.classList.contains('chart-card--expanded')?'Свернуть':'Развернуть';
    card.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.addEventListener('fullscreenchange',()=>{const active=document.fullscreenElement===card;expandButton.querySelector('span').textContent=active?'Свернуть':'Развернуть';expandButton.setAttribute('aria-label',active?'Свернуть график':'Развернуть график на весь экран')});
  card.querySelectorAll('.chart-point').forEach(point=>{point.addEventListener('pointerenter',event=>{const index=Number(point.dataset.index);const rate=isQaResponse&&status.rates[index]!==null?' · отклик '+status.rates[index].toFixed(1).replace('.',',')+'%':'';tooltip.innerHTML=data.months[index]+'<b>'+nf.format(status.values[index])+rate+'</b>';tooltip.hidden=false;const rect=event.target.getBoundingClientRect();tooltip.style.left=Math.min(rect.left,innerWidth-170)+'px';tooltip.style.top=Math.max(8,rect.top-58)+'px'});point.addEventListener('pointerleave',()=>tooltip.hidden=true)});
  return card;
}
const chartGrid=document.getElementById('chartGrid');
const primaryStatus=data.statuses.find(status=>status.code===0);
if(primaryStatus){
  chartGrid.append(renderChart(primaryStatus));
  if(Array.isArray(primaryStatus.qaValues)){
    const values=primaryStatus.qaValues.map(value=>value??0);
    const rates=values.map((value,index)=>primaryStatus.values[index]?value/primaryStatus.values[index]*100:null);
    chartGrid.append(renderChart({code:0,displayCode:'QA',displayDescription:'Динамика ответов на коммуникации',values,rates,latest:values.at(-1),isQaResponse:true,qaValues:null}));
  }
}
data.statuses
  .filter(status=>status.code!==0)
  .sort((a,b)=>b.values.reduce((sum,value)=>sum+(value||0),0)-a.values.reduce((sum,value)=>sum+(value||0),0))
  .forEach(status=>chartGrid.append(renderChart(status)));
const alertFilterButtons=[...document.querySelectorAll('[data-alert-filter]')];
const alertPeriodButtons=[...document.querySelectorAll('[data-alert-period-filter]')];
const alertItems=[...document.querySelectorAll('.alert-item')];
const alertCount=document.querySelector('.alert-count');
function updateAlertFilters(){
  const enabled=new Set(alertFilterButtons.filter(button=>button.classList.contains('active')).map(button=>button.dataset.alertFilter));
  const period=alertPeriodButtons.find(button=>button.classList.contains('active'))?.dataset.alertPeriodFilter||'latest';
  let visible=0;
  alertItems.forEach(item=>{const show=enabled.has(item.classList.contains('alert-item--down')?'down':'up')&&item.dataset.alertPeriod===period;item.hidden=!show;if(show)visible+=1});
  if(alertCount)alertCount.textContent=visible===alertItems.length?alertItems.length+' алертов':visible+' из '+alertItems.length+' алертов';
}
alertFilterButtons.forEach(button=>button.addEventListener('click',()=>{button.classList.toggle('active');button.setAttribute('aria-pressed',button.classList.contains('active'));updateAlertFilters()}));
alertPeriodButtons.forEach(button=>button.addEventListener('click',()=>{alertPeriodButtons.forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',active)});updateAlertFilters()}));
updateAlertFilters();
`;
fs.writeFileSync(path.join(assetsDir, 'dashboard.js'), dashboardJs.trim() + '\n');

console.log(JSON.stringify({
  rows: rows.length,
  eventsWithData: events.length,
  eventPages: catalogueEvents.length,
  topSurveys: topSurveyIds.length,
  missingTopSurveys: missingTopEvents.length,
  statuses: new Set(rows.map((row) => row.status)).size,
  months,
  output: dist
}, null, 2));
