"""Local survey-to-product reference, including harmless duplicate rows."""
import csv,io,re
from csv_data import decode_csv,DataError

def parse_products(raw):
    if not raw.strip(): return {},0
    text=decode_csv(raw).lstrip('\ufeff')
    reader=csv.reader(io.StringIO(text),delimiter=max((';',',','\t'),key=text.splitlines()[0].count))
    headers=[s.strip().lower() for s in next(reader)]
    if 'опрос' not in headers or 'продукт' not in headers: raise DataError('products.csv: нужны колонки Опрос;Продукт')
    result={};count=0
    for line,cells in enumerate(reader,2):
        if not any(c.strip() for c in cells):continue
        while len(cells)>len(headers) and not cells[-1].strip():cells.pop()
        if len(cells)!=len(headers):raise DataError('products.csv, строка %s: неверное число колонок'%line)
        ident=cells[headers.index('опрос')].strip();product=re.sub(r'\s+',' ',cells[headers.index('продукт')].strip()) or 'без продукта'
        if not ident.isdigit() or int(ident)<=0:raise DataError('products.csv, строка %s: неверный номер опроса'%line)
        products=result.setdefault(str(int(ident)),[])
        if product.casefold() not in [p.casefold() for p in products]:products.append(product)
        count+=1
    return result,count

def product_from_query(query,names):
    if not re.search(r'продукт',query,re.I):return None
    text=query.casefold()
    for name in sorted(set(names)|{'без продукта'},key=len,reverse=True):
        if re.search(r'(?<!\w)'+re.escape(name.casefold())+r'(?!\w)',text):return name
    raise ValueError('Продукт не найден. Проверьте название и справочник date/products.csv.')
