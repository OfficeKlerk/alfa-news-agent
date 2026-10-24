# LLM: полный контекст и явный запуск

Основной сценарий: компания + новость + дата + аудитория → подготовленный контекст → структурированный ответ с основаниями. Существующие Python-модули и автономный Node-агент сохранены. В live-адаптере `/v1` используется один подготовленный запрос и максимум одна попытка исправить неверный JSON. Планирование новых инструментов в этом сценарии не выполняется.

## Запуск без Docker

Нужны установленные зависимости из корневого README. Выполните `npm run build`. Создайте личный `.env`, только если его ещё нет:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Локально заполните `LLM_API_KEY`, проверьте `LLM_BASE_URL` и `LLM_MODEL`. Это API, совместимый с существующим форматом `/chat/completions`. Адрес и перечень моделей из прототипа не являются проверкой их доступности. Для другого провайдера явно задайте `LLM_ALLOWED_MODELS_JSON=["your-model-id"]`. Ключ не вставлять в исходники, архивы, команды или чат.

По умолчанию `LLM_RESPONSE_FORMAT=json_object`: совместимый JSON mode, без гарантии формы ответа со стороны провайдера. Если выбранные провайдер **и модель** поддерживают strict Structured Outputs через `/chat/completions`, установите `LLM_RESPONSE_FORMAT=json_schema`. Роль 2 передаст `response_format={type:"json_schema",json_schema:{name,schema,strict:true}}` с отдельной схемой `GeneratedAnalysis` или `GeneratedAnswer`. Поддержка текущего шлюза не подтверждена; она не определяется автоматически по имени модели. При HTTP-ошибке неподдерживаемой схемы автоматического повторного платного запроса с другим форматом нет: измените настройку вручную. Старый `/api` без переданной схемы продолжает использовать JSON mode.

Настройки `LLM_REASONING_EFFORT` и `LLM_EXTRA_BODY_JSON` из текущего master сохраняются вместе с новым форматом. В `LLM_EXTRA_BODY_JSON` нельзя переопределить `response_format`: используйте только `LLM_RESPONSE_FORMAT`. Это не позволяет провайдерским настройкам случайно отключить контракт. Compose передаёт все три настройки. Промпт анализа и промпт уточняющего вопроса используют общие правила доказательности, но разные инструкции формата; пример анализа не добавляется в промпт вопроса.

Если базы профилей ещё нет, создайте новый снимок из CSV; команда заменяет указанный выходной файл:

```powershell
python -m company_context build --companies data/appendix_1/df_Uid_data_hack.csv --links data/appendix_1/df_Fid_Uid_link_hack.csv --payments data/appendix_1/df_Uid_payment_hack.csv --database var/llm/context.sqlite3 --report var/llm/context-audit.json
python scripts/dev.py --live --context-db var/llm/context.sqlite3
```

Можно использовать уже созданную базу `var/learning/context.sqlite3`, указав её путь вместо нового. Открыть <http://localhost:8000/analysis/>. До нажатия «Сформировать ответ» внешних запросов модели нет. Проверка `node scripts/check_llm.mjs` проверяет только конфигурацию, а не ключ у провайдера.

`--live` включает модель только в отдельном сервисе агента. Gateway и legacy `/api` работают в demo, RAG читает Node-данные из `data/`. Отдельные базы процессов находятся в `var/integration/live`; обычный demo — в `var/integration/dev`. `--data-dir` позволяет указать свой каталог Node-данных. Профиль и ранжирование приходят из Python. `--live --smoke` запрещён, чтобы smoke не расходовал вызовы. `--learning --live` совместимы при реальной базе и отсутствии `RANK_MODEL_PATH`.

Начальная лента Node содержит учебные новости: live-ключ не превращает их в настоящие. Введите проверенную новость через форму или импортируйте Event / RankRequest JSON. Ручной ввод создаёт `event_type=other`, `fact_status=reported`, без неподтверждённых стран, компаний или отраслевой разметки. Более подробную разметку можно передать через JSON. Сервис не загружает URL и не подтверждает достоверность введённого текста.

## Передаваемый контекст

`POST /v1/analysis-context` принимает `{company_id,event,as_of,audience_role}`. Возвращает `input`, `sources`, `sha256`, `serialized_bytes`. Полный Python-профиль сохраняет `null`, `false`, raw-выручку и неизвестные единицы, provenance, платёжные связи и ограничения. ML-оценка передаётся вместе со `score_kind`, без превращения в вероятность убытка. Источники новости и датированные bank-фрагменты включаются целиком в рамках явного лимита.

`POST /v1/analyze-event` принимает тот же запрос и необязательный `expected_context_sha256`. UI и CLI передают хэш просмотренного контекста; изменение профиля, ранжирования или RAG даёт 409 до вызова модели. Лимит `LLM_MAX_CONTEXT_BYTES=200000` запрещает молчаливое усечение. Это лимит байтов, а не оценка токенов модели: предел контекстного окна конкретного провайдера нужно учитывать отдельно.

CLI для существующего RankRequest:

```powershell
python scripts/learning.py example --company-id U_35074 --output var/llm/request.json
python scripts/llm_request.py context --request var/llm/request.json --news-id cbr_rate_20260911
python scripts/llm_request.py analyze --request var/llm/request.json --news-id cbr_rate_20260911 --context-file var/llm/context.json
```

Пример из research содержит курируемые события и AI-разметку: перед использованием проверьте первоисточники. Сохранённые контексты и ответы находятся в `var/`, не добавляются в Git. Настройки `LLM_TIMEOUT_SECONDS`, `MAX_DAILY_LLM_CALLS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_MAX_RESPONSE_BYTES` ограничивают время, число вызовов, размер генерации и HTTP-ответа. Счётчик вызовов локален для SQLite конкретного процесса, не общий денежный бюджет. Неуспешные вызовы и исправление JSON тоже учитываются.

Формат ответа и проверки: [LLM_GROUNDING.md](LLM_GROUNDING.md). Интерфейс и содержательная оценка: [LLM_EVALUATION_UI.md](LLM_EVALUATION_UI.md).
