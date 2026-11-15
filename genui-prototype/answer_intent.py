"""Recognize the scope of the supported weekly answer-change questions."""
import re


def normalize(text):
    return ' '.join(text.casefold().replace('ё','е').split())


def resolve_scope(phrase,surveys,default):
    if not isinstance(phrase,str) or len(phrase)>300:
        raise ValueError('Уточните опрос, продукт или канал.')
    text=normalize(phrase).strip(' «»"')
    if not text:
        return default,[]
    channel=''
    for code,pattern in (
        ('communication',r'пуш(?:и)?\s*(?:\+|и|/|-)?\s*смс'),
        ('success_screen',r'экран(?:ы|ам|ах|ов|а)?\s+успеха'),
    ):
        prefix,separator,tail=re.split(r'(?<!\w)('+pattern+r')(?!\w)',text,maxsplit=1) if re.search(r'(?<!\w)'+pattern+r'(?!\w)',text) else (text,'','')
        if separator and not tail.strip():
            channel=code
            text=re.sub(r'(?:^|\s)(?:по\s+)?канал(?:у|е)?\s*[:«"]?\s*$','',prefix.strip()).strip(' ,·')
            break
    text=re.sub(r'^(?:по|для|во|в|на)(?:\s+|$)','',text).strip(' «»"')
    if not text and channel:
        return {'channel':channel},[]
    ident=re.fullmatch(r'(?:опрос(?:у|е|а)?\s+)?[№#]?\s*(\d{1,7})',text)
    if ident:
        return {'id':int(ident[1]),'channel':channel},[]
    if text in ('банк','банку','банке','всему банку','всём банке','всем банке','всем опросам','все опросы'):
        return {'channel':channel},[]
    if text in ('общебанк','общебанку','общебанковскому опросу','общебанковский опрос'):
        return {'id':1007,'channel':channel},[]
    text=re.sub(r'^продукт(?:у|а|е)?\s+','',text).strip(' «»"')
    products=sorted({p for survey in surveys for p in survey['meta'].get('products',[])},key=str.casefold)
    exact=[p for p in products if normalize(p)==text]
    # Accept common Russian case endings on the last word only, retaining ambiguity.
    stem=lambda value:re.sub(r'(?<=\w{3})(?:ами|ями|ам|ям|ах|ях|ов|ев|ы|и|у|ю|а|я|е)$','',value)
    matches=exact or [p for p in products if stem(normalize(p))==stem(text)]
    if len(matches)==1:
        return {'product':matches[0],'channel':channel},[]
    choices=matches or [p for p in products if text in normalize(p) or normalize(p) in text]
    return None,[{'label':p,'selection':{'product':p,'channel':channel}} for p in choices[:8]]
