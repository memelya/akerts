"""Explicit user daily answer targets. Values are scenario inputs, never reference edits."""
import calendar,datetime as dt,re
from agent_schema import plan as validate_plan
from creative_plan import temporal

def target_from_query(query):
 q=query.lower().replace('ё','е')
 if not re.search(r'план|целев|норм|отклон',q) or not re.search(r'ответ',q):return None
 number=r'(?<![\d.,+\-])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{1,10})(?![\d.,])'
 match=re.search(r'ответ[а-я]*\s*[:=]?\s*'+number+r'\s*(?:в|за|на)\s*(?:день|сутки)',q) or re.search(number+r'\s*(?:ответ[а-я]*\s*)?(?:в|за|на)\s*(?:день|сутки)',q)
 if not match:return None
 value=int(re.sub(r'\s','',match[1]))
 if not 1<=value<=1000000000:raise ValueError('Дневной план ответов должен быть целым числом от одного до миллиарда.')
 if re.search(r'рабоч\w*\s+д',q):raise ValueError('План по рабочим дням требует рабочего календаря. Укажите план на календарный день.')
 return {'metric':'answers','value':value,'grain':'day','source':'user'}

def prepare_target(engine,request,state,revision,target):
 query=request['query'];q=query.lower();previous=request.get('previous') or {};base=request.get('previousAgent') or {}
 ids=list(dict.fromkeys(int(i) for i in re.findall(r'опрос[а-я]*\s*[#№]?\s*(\d+)',q)))
 if not ids:ids=previous.get('ids') or base.get('scope',{}).get('ids',[])
 if len(ids)!=1:raise ValueError('Для дневного плана укажите один опрос, например «план 2000 ответов в день по опросу 1007».')
 scope={'ids':ids}
 if re.search(r'экран',q):scope['channel']='success_screen'
 elif re.search(r'пуш|смс',q):scope['channel']='communication'
 from genui_extended import select_surveys
 selected=select_surveys(state,{'ids':ids,'filters':{k:v for k,v in scope.items() if k!='ids'}})
 if not selected:raise ValueError('В загруженных данных нет указанного опроса.')
 keys=[(s['meta']['channel'],s['event']['id']) for s in selected];anchor=engine.store.last_daily(revision,keys)
 if not anchor:raise ValueError('Для сравнения с дневным планом нужны дневные строки этого опроса. Месячная выгрузка не подтверждает значения по дням.')
 end=dt.date.fromisoformat(anchor);period=temporal(query,str(end.year));notes=[]
 if not period and previous:
  if previous.get('daysCount'):period={'grain':'day','days':previous['daysCount'],'comparison':'previous'}
  else:period={'grain':'month','months':previous.get('monthsCount',1),'comparison':'previous',**{k:previous[k] for k in ('startMonth','endMonth') if previous.get(k)}}
  notes.append('Период взят из текущего графика; явно указанный номер опроса заменяет прежний.')
 if not period and base.get('period'):period=dict(base['period']);notes.append('Период сохранён из текущего анализа.')
 if not period:period={'grain':'day','days':7,'comparison':'previous'};notes.append('Период не указан: последние семь дней от последней дневной строки выбранного опроса.')
 if period['grain']=='month' and not re.search(r'по\s+месяц',q):
  last=min(period.get('endMonth') or end.strftime('%Y-%m'),end.strftime('%Y-%m'));y,m=map(int,last.split('-'));n=y*12+m-period.get('months',1)
  first=period.get('startMonth') or f'{n//12:04d}-{n%12+1:02d}'
  period={'grain':'day','days':min(366,(min(end,dt.date(y,m,calendar.monthrange(y,m)[1]))-dt.date.fromisoformat(first+'-01')).days+1),'startDate':first+'-01','endDate':last+'-'+str(calendar.monthrange(y,m)[1]),'comparison':'previous'}
 plan=validate_plan({'kind':'workspace','title':'Опрос '+str(ids[0])+' · ответы и дневной план','scope':scope,'period':period,'answersTarget':target,'goal':'investigate'})
 return {'plan':plan,'metrics':['answers','planExpected','planGap'],'trend':True,'notes':notes+['План из запроса: '+str(target['value'])+' ответов на календарный день. Справочник не изменён.','Отклонение = факт − план. Для пропущенных дней отклонение не вычисляется; отсутствие строк не означает ноль.']}
