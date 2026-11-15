"""Actionable failure contracts; never infer auth or bad CSVs from a timeout."""
def diagnose(error,job=None):
    job=job or {};text=str(error);stage=job.get('creativePhase') or job.get('activeModelStage') or job.get('stage','unknown')
    code=getattr(error,'code',None);rewrite=False
    cause='Причина ещё не установлена. Нужен диагностический отчёт с этого ноутбука.'
    action='Запустите python diagnose_project.py --probe-model и передайте diagnostics-report.json.'
    owner='не установлено'
    if 'не настроена' in text or 'CLI не найден' in text or 'Исполняемый файл' in text or 'ai-config.json' in text:
        owner='настройка интеграции';cause='Команда CLI или конфигурация не прошла проверку до вызова модели.'
        action='Запустите python configure_gigacode.py или исправьте .local-data/ai-config.json. Проверьте настройку через python diagnose_project.py. Добавление CSV и изменение аналитического запроса не нужны.'
    elif code=='cli_exit':
        owner='CLI';cause='Процесс CLI завершился с ненулевым кодом. Это не доказывает ошибку авторизации.'
        action='Проверьте диагностический отчёт; stderr сохранён только в локальном логе. Изменение запроса не исправляет запуск CLI.'
    elif code=='model_json':
        owner='ответ модели / адаптер';cause='CLI ответила, но не удалось получить один полный JSON. Ошибка возникла до проверки визуализации.'
        action='Проверьте тест JSON в диагностике и формат вывода CLI. Для уже рассчитанных данных доступен стандартный просмотр.'
    elif error.__class__.__name__=='ModelTimeout':
        owner='выполнение модели';cause='Процесс не закончил ответ в отведённое время. Причина задержки не установлена; CSV и авторизация этим не проверены.'
        action='Сначала проверьте короткие тесты модели. Если они проходят, повторите только генерацию или запросите компактную панель для одной задачи.'
    elif stage in ('creative-code-validation','chart-conversation-validation'):
        owner='согласование ответа модели с платформой';cause='Ответ получен, но его структура, пояснения или ссылки не соответствуют контракту платформы.'
        action='Переформулировать аналитический вопрос не требуется. Откройте рассчитанные данные; передайте отчёт для исправления контракта.'
    elif stage=='creative-plan-validation':
        owner='согласование плана модели с платформой';cause='Модель не выдала допустимый план отбора данных.'
        action='Явно укажите показатель, период и опрос/продукт. Если запрос уже точный, нужен разбор ответа модели, а не подбор слов.'
    elif 'двухстот тысяч' in text or 'двухсот тысяч' in text or '18000' in text or 'четыре миллиона' in text:
        owner='лимит платформы';cause='Запрос превысил вычислительный или интерфейсный предел. Это ограничение реализации.'
        action='Для рейтинга используйте «Топ 10 опросов по отправкам за 2026 год»; для исследования выберите продукт или период. Данные не усекались.';rewrite=True
    elif 'обоих каналах' in text or 'канал' in text and 'уточнит' in text.lower():
        owner='неоднозначный отбор';cause='Для номера найдены наблюдения в двух каналах; объединение без уточнения запрещено.'
        action='Добавьте «пуш+смс» или «экран успеха». Удалять данные из второго CSV не нужно.';rewrite=True
    elif 'Нет данных' in text or 'Нет загруженных' in text:
        owner='отбор данных';cause='В выбранном сочетании периода, каналов и справочников наблюдения не найдены.'
        action='Сверьте диапазон дат, ID, канал и связь продукта со справочником. Наличие записи в справочнике ещё не означает наличие наблюдений в CSV.';rewrite=True
    return {'code':code or ('timeout' if error.__class__.__name__=='ModelTimeout' else 'pipeline_failure'),'stage':stage,'owner':owner,'cause':cause,'nextAction':action,'changeQuery':rewrite,'hasCalculatedData':bool(job.get('creativeData')),'requestId':job.get('id'),'modelCalls':job.get('calls',1 if getattr(error,'modelInvoked',False) else 0)}
