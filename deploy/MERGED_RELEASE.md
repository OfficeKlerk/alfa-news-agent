# Запуск объединённого live-контура

Обновление задачи 2: перед обновлением/восстановлением прочитать `docs/integration/DURABLE_EXECUTION.md`. Gateway и agent обновлять вместе; unknown не переотправляется автоматически, старые общие вопросы не присваиваются пользователю.

Актуальная оценка: `docs/reports/MERGED_PIPELINE_REVIEW_20261025.md`; задачи: `deploy/NEXT_TASKS_3_PEOPLE.md`. Материалы `verification/` и прежний отчёт DELIVERY_REVIEW относятся к отдельным сборкам. В новой поставке проект лежит в корне ZIP, актуальный манифест — `delivery-task2/MANIFEST.json`.

Node 24.13–24.x, Python 3.12, Linux/macOS (supervisor использует fcntl); для теста HTTPS IdP нужен openssl. Входные реальные CSV/база компаний и секреты не включены. Установить `npm ci`, создать venv, `pip install -r requirements-dev.txt -c requirements.lock`, `npm run build`.

Скопировать `config/live.env.example` в приватный `.env.live`. Заполнить реальный OIDC issuer/client/audience, `PUBLIC_BASE_URL=https://ваш-домен`, trusted company_ids/roles и callback `/auth/callback`. Сгенерировать ДВА разных секрета: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`; записать в AUTH_COOKIE_KEY и INTERNAL_API_TOKEN. Не публиковать секреты. Требования и claim mapping — `docs/integration/PRODUCTION_ACCESS.md`.

Командный стенд без платных вызовов:

```sh
.venv/bin/python scripts/live.py --context-db /absolute/path/companies.sqlite --env-file .env.live
```

Python-supervisor запускает реальные сервисы, collector и gateway с worker. Нужны доступный IdP и секреты даже при выключенной генерации. Backend привязан к loopback. Настроить HTTPS proxy на выбранный PORT с сохранением внешнего Host; открывать `PUBLIC_BASE_URL/live/`. Нельзя выдавать этот адрес за production-приёмку. Флаг `--check` проверяет часть конфигурации, но не доступность IdP или работоспособность ключей.

Docker-альтернатива: заполнить CONTEXT_DB_HOST_PATH (readable existing SQLite), NEWS_FEEDS_JSON, OIDC и секреты, затем:

```sh
docker compose --env-file .env.live -f compose.production.yaml config --quiet
docker compose --env-file .env.live -f compose.production.yaml up --build --wait
```

`compose.production.yaml` и `compose.live.yaml` содержат полный защищённый pipeline. Первый порт остаётся loopback; TLS организует proxy. В этой среде Docker-старт не проверен. LIVE_WORKER_CONCURRENCY=1 — начальный профиль для VPS 2 ГБ; память и диск ещё измерить. Не запускать supervisor и Docker одновременно с одними базами/портами.

Платная генерация: после настройки стенда, ознакомления с unknown/recovery и согласования бюджета указать ключ ТОЛЬКО агенту; supervisor требует `--with-llm`, Compose — ANALYSIS_ENABLED=1. Само наличие ключа не включает генерацию. Сейчас по умолчанию ANALYSIS_ENABLED=0. Ошибка не должна подменяться demo-ответом.

Офлайн-разработка с fixtures: `python scripts/dev.py --native-providers` — отдельный явно development-контур, не публиковать. Старый `scripts/accept_deployment.py` проверяет manual v1; в live-режиме ручная генерация закономерно заблокирована 409. Его нельзя использовать как единственный PASS нового pipeline: нужны live black-box сценарии из NEXT_TASKS и LIVE_PIPELINE_ACCEPTANCE.

Live-карточки, версии, subscriptions, личные favorites и личные Q&A хранятся в SQLite и переживают restart. Ручные transient sessions вне live по-прежнему в памяти. Не делать round-robin по нескольким независимым SQLite-репликам; shared storage/distributed budget — следующий этап после измерений.
