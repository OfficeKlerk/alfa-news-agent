# Пять разработчиков: единые правила

> Обновление: для объединённой ветки и переноса всех работ в master используйте [MERGE_TO_MASTER.md](MERGE_TO_MASTER.md) и корневой README. Ниже сохранена инструкция первоначального интеграционного этапа.

Стартовая локальная база для новых задач — `role5/integration-foundation`. Она основана на проверенной `feature/node-prototype`; другая feature-ветка подключается через проверенный overlay. До согласования интеграционного PR не объединять feature-ветки в master и не переносить целиком их README/датасеты поверх текущей работы.

## Владение и критерии приёмки

| Роль | Своя область | Вход/выход | Независимая работа и проверка |
|---|---|---|---|
| **1 Data/ML** | `company_context/*`, `news_analysis/*` в исходной ML-ветке; новые модели/датасеты | `Profile`, `RankRequest` → `RankDataResponse` | Запустить Python API с mock rank или проверенным модулем. Не трогать Node `db.ts` ради нового профиля. Сохранить null/provenance, отдельную шкалу score и оценку качества |
| **2 AI/Agent** | `server/agent.ts`, `prompts.ts`, `llm.ts` или собственный отдельный HTTP-сервис | `AgentRequest` → `AnalysisResponse`; `AgentQuestionRequest` → `AnswerResponse` | Использовать готовые профиль/событие/rank/RAG; инструменты роли 3 доступны через HTTP. Проверять источники, лимиты, историю и разные аудитории. Моки остальных ролей доступны постоянно |
| **3 Backend/RAG** | `server/news.ts`, часть `server/retrieval.ts` с поиском, новый отдельный RAG-сервис/индексы | search_news, rag_bank_analytics, resolve_sources | Работать с общими примерами. Датировать документы по проверенному реестру; сохранять URL/страницы/excerpt и нормализованные события. Реализовать реальный ingest/hybrid/reranking, не переносить туда персональный rank |
| **4 Frontend** | `frontend/*`, продуктовый UI, использование `integration/frontend/client.js` | Публичный `/v1`, SDK | Запускать весь mock-стек без ключей. Перевести существующий `/api` UI на `/v1` отдельным PR. Проверить loading/error/empty, source viewer, переключение компании, отмену старых запросов и повторные вопросы |
| **5 Архитектура/интеграция** | `server/integration/*`, `integration/*`, контракты, Docker/CI, общие инструкции | Все границы и режимы | Поддерживать совместимость, реальные адаптеры и сквозные тесты. Review общих схем, обновлений SHA, миграций и будущих публикаций |

`server/app.ts`, `db.ts`, `config.ts`, `types.ts` — общие legacy-файлы. Их изменения заранее обозначаются в задаче и обсуждаются с 5 и затронутым владельцем. Новые role-модули и новые тестовые файлы предпочтительнее одновременного редактирования одной большой функции. Таблица устанавливает рабочие границы, но не блокирует согласованное улучшение.

## Роль 1: Python отдельно

После установки Python-зависимостей:

```bash
python -m uvicorn integration.app:app --host 127.0.0.1 --port 8101
```

По умолчанию используется отдельная fixture-база и mock rank. Для проверенной ветки выполнить подготовку и установить `RANK_MODE=news-analysis`. Для работы в собственной исходной ветке с доработками можно задать `NEWS_MODULE_PATH` на её локальный корень, запустить её тесты и интеграционные тесты; в общий lock вносится только проверенный коммит.

Для реальных CSV базу собирать явно:

```bash
python -m company_context build --companies data/appendix_1/df_Uid_data_hack.csv --links data/appendix_1/df_Fid_Uid_link_hack.csv --payments data/appendix_1/df_Uid_payment_hack.csv --database var/context-real.sqlite3 --revenue-unit unknown
```

Потом установить `CONTEXT_MODE=existing` и `CONTEXT_DB` в окружении Python-процесса. Единицу `rub/thousand_rub` выбирать только после подтверждения, а не для получения ожидаемого фильтра крупного бизнеса. При подключении реальной базы нужно искать существующие company ID через API, а не использовать учебные `U_A/U_C`.

## Роли 2 и 3: отдельные процессы

После `npm ci` и `npm run build` доступен общий entrypoint адаптеров. Ниже POSIX-команды; PowerShell задаёт те же значения через `$env:ИМЯ = 'значение'` перед `node`.

Роль 2:

```bash
SERVICE_KIND=agent PORT=8202 DB_PATH=var/role2.sqlite3 LLM_MODE=demo node dist/integration/provider-server.js
```

Роль 3:

```bash
SERVICE_KIND=retrieval PORT=8203 DB_PATH=var/role3.sqlite3 LLM_MODE=demo node dist/integration/provider-server.js
```

Эти процессы оборачивают исходные Node-модули и имеют разные базы. Их можно заменить собственными сервисами на тех же HTTP-контрактах, включая FastAPI для роли 3. Native-RAG сейчас лексический и не использует недатированные bank-страницы; это переходная реализация.

Gateway подключается к ним так:

```bash
ML_URL=http://127.0.0.1:8101 RETRIEVAL_MODE=http RETRIEVAL_URL=http://127.0.0.1:8203 AGENT_MODE=http AGENT_URL=http://127.0.0.1:8202 DB_PATH=var/gateway.sqlite3 LLM_MODE=demo node dist/integration/index.js
```

Другой вариант — оставить `AGENT_URL` или `RETRIEVAL_URL` на общем mock-сервере 8102. Для одной машины каждый процесс получает собственный порт и DB_PATH. `ML_URL/AGENT_URL/RETRIEVAL_URL` — конфигурация сервера, они не передаются браузером.

Полная проверка отдельных native-поставщиков на учебных данных:

```bash
python scripts/prepare_news_source.py
RANK_MODE=news-analysis python scripts/dev.py --smoke --native-providers
```

Она запускает четыре независимых процесса: Python, роль 2, роль 3 и gateway. Внешних LLM-вызовов нет. `python scripts/dev.py --native-providers` запускает тот же стенд постоянно; учебный retrieval-порт 8102, agent-порт 8202.

## Роль 4: перейти на `/v1`

Запустить базовый Compose или `npm run integration:dev`. Использовать SDK из `integration/frontend/client.js`; готовая техническая страница `/integration` показывает последовательность работы. Менять продуктовую вёрстку можно независимо от реальных ML/RAG/LLM.

В задаче перехода нужно согласовать отображение `score_kind`, неизвестных значений, `mode/warnings`, страниц источников и `recommendations`. Старый UI намеренно не переписан в этой ветке. Сохранять прежние `/api` DTO после переключения SDK без явного адаптера нельзя.

## Одна задача — одна локальная ветка

После получения общей базы каждый участник создаёт свою ветку:

```bash
git switch -c feature/r1-profile role5/integration-foundation
# Другие роли: feature/r2-agent, feature/r3-rag, feature/r4-ui, feature/r5-integration
```

Не использовать reset/force push для подгонки чужой ветки. Перед переносом работы смотреть `git status`, diff и SHA базы. Развитие Python-ветки можно продолжать отдельно; её следующий коммит интегрируется после собственного review и обновления source lock.

Для каждого изменения: описать владельца, затронутые схемы, пример запроса/ответа и критерии приёмки. Пример `R3-01`: нормализовать новости в Event, сохранить источники и entity mapping, исключить будущие публикации; тест — контракт + поиск mock/real на одинаковом запросе. `R4-01`: мигрировать ленту на SDK, не показывать результат прежней компании после переключения.

## Локальная передача без GitHub

Пакет `alfa-news-agent-role5.bundle` содержит только новые локальные коммиты и требует наличия исходного Node-коммита. В уже клонированном репозитории:

```bash
git bundle verify ../alfa-news-agent-role5.bundle
git fetch ../alfa-news-agent-role5.bundle role5/integration-foundation:role5/integration-foundation
git switch role5/integration-foundation
```

Если такой локальной ветки уже нет: команда fetch создаст её. Если ветка уже существует с другой работой — сначала выбрать другое локальное имя, не перезаписывать её. Для альтернативного `.patch` создать ветку от `d1c08bbc5700a31ba16971e6c2f7683ebc2f1cd9` и применить файл через `git am`; не применять его прямо к master.

## Последующий PR после отдельного разрешения

1. Сверить актуальность трёх веток и source lock, запустить локальные проверки и Docker smoke на машине с Docker.
2. Согласовать контракты с ролями 1–4 и назначить реальных владельцев; фиктивные CODEOWNERS не добавлены.
3. Только после разрешения пользователя опубликовать `role5/integration-foundation` и открыть Draft PR с базой `feature/node-prototype`, используя `PR_DRAFT.md`.
4. Этот PR показывает только интеграционную инфраструктуру. Переход Node-ветки в master рассматривается отдельно; после её merge интеграционную ветку можно безопасно перебазировать/перенацелить и повторить проверки.
5. В PR приложить результаты contract/unit/HTTP/Compose проверок. Ещё один участник запускает стек. Затем отдельно решается merge; автоматического merge/deploy нет.
