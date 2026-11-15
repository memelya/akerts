"""Only predictable chart grammar stays local in automatic mode."""
import re
from genui_query import normalize_rate_phrase

def needs_agent(query,previous_agent=None,product_names=()):
    text=(query or '').lower().replace('ё','е')
    text=normalize_rate_phrase(text)
    if re.search(r'почему|причин|разбер|найд|ищи|подбер|утрен|руковод|мониторинг|проблем|аномал|отклон|ухудш|качеств|много|мало|вырос|растут|просел|просел|меньше|больше|вмеш|здоров|сроч|приоритиз|важност|исслед|обычн|рабочий\s+экран',text):return True
    if previous_agent and not re.search(r'опрос[а-я]*\s+\d+|отклик',text):return True
    for name in sorted(product_names,key=len,reverse=True):text=text.replace(name.casefold(),'')
    stems=r'разбив|разрез|помесяч|покаж|сдела|постро|сравн|добав|убер|убра|остав|теперь|отправ|ответ|отклик|событ|опрос|продукт|групп|свободн|приоритет|топ|триггерн|общ|пуш|смс|экран|успех|количеств|число|уникальн|график|последн|месяц|дн|день|недел|год|январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр|отсеч|стоп|лист|политик|контакт|план|совмест|совмещ|объедин|раздельн|отдельн|оценк|начал'
    stop={'мне','по','за','в','на','и','с','со','для','из','все','всех','всем','весь','без','одном','один','к','этом','это','их','так','же','также','а','пожалуйста','плюс','вместе','каждому','каждого','csi','csat','event_type_id'}
    words=re.findall(r'[а-яa-z_]+',text)
    return any(w not in stop and not re.match(stems+'|тип',w) for w in words)
