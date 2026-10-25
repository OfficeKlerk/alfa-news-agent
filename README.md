# Alfa News Agent

**Объединённая версия 25.10.2026:** [оценка и проверки](docs/reports/MERGED_PIPELINE_REVIEW_20261025.md), [запуск live с OIDC](deploy/MERGED_RELEASE.md), [задачи трём исполнителям](deploy/NEXT_TASKS_3_PEOPLE.md). Live-контур коллеги уже включён; старые замечания об отсутствии конвейера относятся к предыдущей сборке.

Персональная новостная аналитика для компаний: профиль бизнеса → релевантные новости → анализ с источниками → уточняющие вопросы.

> 🧭 Новым читателям и жюри: начните с [карты проекта](docs/INDEX.md) — что где лежит, как запустить проверки и где какой критерий ТЗ закрыт.

Обновление безопасности и поиска: [защищённый запуск и OIDC](docs/integration/PRODUCTION_ACCESS.md), [состав изменений и проверки](docs/reports/DELIVERY_REVIEW_20261025.md), [независимая приёмка live-конвейера](docs/integration/LIVE_PIPELINE_ACCEPTANCE.md). Production-конфигурация — `compose.production.yaml`; она использует реальные сервисы и требует настройки доступа. Обычный `compose.yaml` — локальный demo.

В этой ветке объединены `master`, `feature/news-analysis`, `feature/node-prototype` и `role5/integration-foundation`. История и предметные модули сохранены. Состав, проверки и порядок передачи в master: [MERGE_TO_MASTER.md](docs/integration/MERGE_TO_MASTER.md).

Уже реализованы профили компаний из CSV/SQLite, признаки и ранжирование новостей, загрузка сохранённых весов, обратная связь с автоматическим подбором и проверкой новых версий ML. Для Python и Node.js есть общие `/v1` контракты, адаптеры, моки, запуск без Docker, Compose и CI.

Сбор новостей теперь сохраняет даты публикации и версии текста, исключает недатированные записи из ранжирования и объединяет подтверждённые дубли. Из текста извлекаются события с указанием источника; признаки `company_event_v2` учитывают направление изменения, предмет события и условия применимости. Первый аудит персонализации: [39 оценок для трёх компаний](data/personalization/annotation_table.md), [сравнение до/после](docs/reports/PERSONALIZATION_COMPARISON.md). Это небольшой разработочный набор с AI-разметкой. Состав изменения и команды проверки: [передача кода](docs/integration/NEWS_PERSONALIZATION_HANDOFF.md).

Блок LLM получает полный профиль, новость, дату анализа, ML-оценку и доступные банковские фрагменты. Добавлены структурированный ответ, проверка цитат и оснований, условия рекомендаций, недостающие данные, интерфейс выбора компании/новости и уточняющие вопросы. Пять сценариев оценки охватывают разные компании, нерелевантную новость, неполный профиль и отсутствие RAG. Качество настоящей модели требует отдельного запуска с локальным ключом и экспертного ревью.

## Запуск без Docker

Нужны Python 3.12 и Node.js 24.13–24.x. Команды выполнять из корня проекта. Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt -c requirements.lock
npm ci
npm run integration:dev
```

Linux/macOS: вместо PowerShell-активации выполнить `source .venv/bin/activate`, остальные команды те же.

Открыть <http://localhost:8000/analysis/>: выбор компании и новости → просмотр контекста → ответ с источниками → уточнения. Одна команда запускает Python API, Node gateway и моки; Ctrl+C завершает процессы. Стандартный стенд использует маленькие синтетические данные и отдельные базы в `var/integration/dev`, без внешних LLM. Технический стенд — <http://localhost:8000/integration>, исходный интерфейс со старым `/api` — <http://localhost:8000/>.

## Подключить Python-ранжирование из объединённого проекта

Пакет `news_analysis` уже находится в репозитории. После установки зависимостей и сборки:

```powershell
$env:RANK_MODE = 'news-analysis'
$env:NEWS_MODULE_PATH = (Get-Location).Path
python scripts/dev.py --native-providers
```

Запускаются четыре процесса: Python, отдельные Node-сервисы агента и поиска, gateway. Профиль и ранжирование поступают из Python. Для возврата к мокам удалить эти переменные из окружения. На Linux/macOS аналогичный запуск: `RANK_MODE=news-analysis NEWS_MODULE_PATH=. python scripts/dev.py --native-providers`.

Настоящие данные, модели и сервисы подключаются явно. Наличие пакетов в master само по себе не переводит demo-интерфейс на обученный ML или production RAG. Локальные `/v1` анализы и история живут в памяти gateway до перезапуска/истечения срока; старый `/api` имеет отдельное SQLite-состояние.

## ML и обучение по обратной связи

`RANK_MODEL_PATH` подключает сохранённые веса при запуске. В режиме `--learning` человек оценивает новости на `/learning`, а фоновое обучение подбирает веса, метод и регуляризацию. Новая версия включается только после проверки на свежих отложенных данных; доступны история и откат. Это обучение релевантности новостей, не обучение LLM или прогноз убытков. Инструкции: [сохранённый ranker](docs/integration/TRAINED_RANKER.md), [обратная связь и автообучение](docs/integration/ADAPTIVE_LEARNING.md).

## Настоящая LLM

После сборки укажите ключ и параметры провайдера в личном `.env`. Используйте существующую базу реальных профилей:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Заполните LLM_API_KEY и OIDC/TLS по PRODUCTION_ACCESS.md, затем:
python scripts/dev.py --live --context-db var/learning/context.sqlite3
```

Откройте настроенный HTTPS-адрес `/analysis/`, войдите через IdP и выберите разрешённую компанию, введите проверенную новость или импортируйте JSON. «Подготовить контекст» не вызывает модель; «Сформировать ответ» запускает генерацию. Ответ содержит факты, связь с компанией, условные действия, ограничения и источники. Вопросы используют контекст сохранённого анализа. Текст новости не загружается автоматически по URL.

Создание базы и настройки: [LIVE_LLM.md](docs/integration/LIVE_LLM.md). JSON и проверки: [LLM_GROUNDING.md](docs/integration/LLM_GROUNDING.md). Интерфейс и оценка качества: [LLM_EVALUATION_UI.md](docs/integration/LLM_EVALUATION_UI.md).

## Модули и документы

| Путь | Назначение | Инструкция |
|---|---|---|
| `company_context/` | CSV → SQLite, профиль компании, платёжные связи, provenance и неизвестные значения | [Профиль](company_context/README.md) |
| `news_analysis/` | Признаки, граф, baseline/ML ranker, условные сценарии, подготовка датасетов | [Python API и CLI](news_analysis/README.md) |
| `server/`, `frontend/` | Node-прототип: агент, RSS, лексический поиск, legacy `/api`; live-генерация в адаптере | [Архитектура прототипа](docs/architecture/ARCHITECTURE.md), [LLM](docs/integration/LIVE_LLM.md) |
| `integration/`, `server/integration/` | Python/Node `/v1`, адаптеры, HTTP-клиенты, моки, SDK и общий запуск | [Архитектура интеграции](docs/integration/ARCHITECTURE.md) |
| `contracts/v1/` | JSON Schema 2020-12, OpenAPI 3.1, примеры | [Контракты](docs/integration/CONTRACTS.md) |
| `integration/analysis_ui/` | Новый UI через `/v1`: выбор компании/новости, источники, условия и вопросы | [Интерфейс и оценка](docs/integration/LLM_EVALUATION_UI.md) |
| `data/training_v1/`, `data/training_v2/` | Датасеты, источники, ревью и ограничения AI-разметки | [v1](data/training_v1/README.md), [v2](data/training_v2/README.md) |
| `data/personalization/` | 3 проверенных профиля, 13 событий, 39 оценок, независимый AI-проход и воспроизводимое сравнение | [Таблица](data/personalization/annotation_table.md), [методика](docs/reports/PERSONALIZATION_LABELS.md) |
| `data/weekly_audit_20261024/` | 30 фактических результатов на 10 оригинальных новостях недели; источники, хеши и сравнение до/после | [Результаты](docs/reports/WEEKLY_NEWS_RESULTS_20261024.md), [исправления и проверки](docs/reports/NEWS_FULL_AUDIT_20261024.md) |
| `data/integration_payment_20261024/` | Проверка новых платёжных агрегатов коллег вместе с Data/ML; 30 пар без регрессии | [Интеграция и запуск](docs/reports/PAYMENT_INTEGRATION_REVIEW_20261024.md) |
| `tests/`, `server/**/tests/` | Unit-, контрактные и интеграционные проверки | [Проверка объединения](docs/integration/MERGE_TO_MASTER.md) |
| `data/demo/` | Демо-набор: компании, новости, разметка, привязка к аналитике банка | [Демо-компании](docs/guides/DEMO_COMPANIES.md) |
| `docs/INDEX.md` | Карта проекта: навигация, проверки, критерии ТЗ | [Карта](docs/INDEX.md) |
| `docs/ARCHITECTURE_OVERVIEW.md`, `docs/DECISIONS.md` | Единая схема гибрида Python+Node; решения команды | — |
| `docs/SECURITY.md`, `docs/MONITORING.md`, `docs/SCALABILITY.md` | Безопасность AI, мониторинг качества (№12), масштабирование (№7) | — |
| `docs/DEMO_SCRIPT.md`, `docs/BASELINE_REPORT.md`, `docs/LABELING_GUIDE.md` | Сценарий защиты, baseline-метрика, инструкция по разметке | — |
| `docs/ui/` | Отдельный эталонный макет карточки: факт, банк, AI | [Макет](docs/ui/README.md) |

Распределение работы пяти ролей: [TEAM.md](docs/integration/TEAM.md). После принятия объединения новые рабочие ветки создавать от обновлённого master. Старые указания на базу `feature/node-prototype` относятся к первоначальному отдельному PR интеграции.

## Проверенные даты банка и реальные новости

В OCR-корпусе восстановлены подтверждённые даты восьми документов (56 страниц); у обзора золота точный день остаётся неизвестным. Подключены три проверенные реальные новости отдельно от demo. Изменения применяются при перезапуске без удаления базы. Доказательства, проверки и запуск `/v1` с реальными источниками: [BANK_DATES_AND_REAL_NEWS.md](docs/integration/BANK_DATES_AND_REAL_NEWS.md).

## Отдельный legacy Node-прототип

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
$env:AUTH_MODE = 'development'
npm start
```

На Linux/macOS: `AUTH_MODE=development npm start`. Этот офлайн-запуск обслуживает старый `/api` без Python. Первый старт импортирует полные gzip CSV в `var/app-node.sqlite3`; интерфейс — <http://localhost:8000/>. `start_windows.bat` также относится к этому режиму. Не смешивать его DTO `published/actions/relevance` с `/v1` `published_at/recommendations/score_kind`.

## Проверки

Протокольный OIDC-тест дополнительно требует установленный `openssl` в PATH (только для тестового HTTPS IdP, не для запуска приложения).

```powershell
python scripts/build_contracts.py --check
npm run typecheck
npm test
npm run build
npm run llm:evaluate
python -m unittest discover -s tests -q
python scripts/prepare_news_source.py
python -m pytest tests/integration -q
python scripts/dev.py --smoke
```

`prepare_news_source.py` проверяет встроенный модуль, профили и ранжирование по JSON-контрактам без Git-истории и сети.

`llm:evaluate` без флагов проверяет пять сценариев на подготовленных эталонах без сети и сохраняет отчёт в `var/llm-evaluation/offline.json`. Реальная генерация: `npm run llm:evaluate -- --live`, затем содержательное ревью. Исходный `test_llm.py` — отдельная ручная сетевая проверка. Подробный отчёт объединения: [MERGE_TO_MASTER.md](docs/integration/MERGE_TO_MASTER.md).

## Docker — дополнительный способ запуска

```powershell
docker compose up --build --wait
```

Он запускает общий стенд с моками. Встроенное ранжирование включается через `docker compose -f compose.yaml -f compose.news.yaml up --build --wait`. Модуль `news_analysis` включён в Python-образ; старый overlay не требуется. Docker необязателен для локальной разработки.

## Ограничения

- Стандартный стенд помечает синтетические данные и моки; live LLM требует явной конфигурации и ключа в локальном `.env`. Ключи в Git не добавлять.
- Сборка, офлайн-тесты, пять проверочных сценариев и HTTP-запуск проверены. Настоящий внешний провайдер без ключа не проверялся; механическая проверка цитат и полей не доказывает смысловую корректность ответа. Браузерная визуальная проверка новой страницы в этой среде не выполнялась.
- Исходный Node RAG — лексический поиск по 64 OCR-страницам 9 документов; полноценный гибридный поиск и оценка качества остаются задачей роли 3. Недатированные bank-фрагменты не используются для подтверждения позиции банка на `as_of`.
- Python baseline имеет собственную шкалу; `score_kind` обязателен. Релевантность не является вероятностью ущерба. AI-разметка датасетов не заменяет независимую экспертную оценку; готовые проверенные веса не поставляются.
- Неизвестные единицы выручки, валюты/периоды платежей и условия договоров нельзя достраивать. Платёж не доказывает поставку, связь через физлицо — владение. Сценарные расчёты требуют явных параметров.
- Проект рассчитан на локальную разработку; выбор company ID не является аутентификацией.

GitHub-публикацию и merge выполняет пользователь. Подготовка этой объединённой ветки выполнена только локально.

Повторная проверка и исправления: [LLM_VERIFICATION.md](docs/integration/LLM_VERIFICATION.md). Копирование финального комплекта, обновление master и ручной push: [PUBLISH_MASTER.md](docs/integration/PUBLISH_MASTER.md).

Оценка текущего банковского поиска: `npm run rag:evaluate` (офлайн; нужен Python для BM25 reference). [Методика](docs/guides/SERVER_RETRIEVAL_EVAL.md) и [результаты/промахи](docs/reports/SERVER_RETRIEVAL_EVAL.md).
