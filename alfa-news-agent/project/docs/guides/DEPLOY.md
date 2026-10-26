# Деплой (роль 5)

Как поднять живой прототип на бесплатном сервере. Docker-конфиг уже есть в репозитории; этот документ описывает проверенные по содержимому пути. Сборку образа проверить на машине с Docker (у автора этого гайда daemon недоступен — отмечено честно).

## Вариант A — один контейнер (рекомендуется для free-хоста)

Корневой `Dockerfile` собирает self-contained Node-сервис: продуктовый UI + legacy `/api`, порт 8000, режим demo (без ключа) или live.

### Render.com (есть готовый блупринт)
1. New + → Blueprint → указать репозиторий. Render прочитает [`deploy/render.yaml`](../../deploy/render.yaml).
2. Для live-режима задать секрет `LLM_API_KEY` в UI (не в репозитории) и `LLM_MODE=live`. По умолчанию — `demo` (без ключа и без расхода бюджета).
3. Health-check: `/api/health`.

### Railway / любой Docker-хост
```bash
docker build -t alfa-insight .
docker run -p 8000:8000 \
  -e LLM_MODE=demo -e HOST=0.0.0.0 -e PORT=8000 alfa-insight
# live: -e LLM_MODE=live -e LLM_API_KEY=sk-... -e LLM_MODEL=qwen/qwen3.6-35b-a3b
```
Открыть `http://<host>:8000/` (UI на `/api`) · `/?api=v1` — UI на `/v1` (см. `docs/V1_MIGRATION.md`).

> Первый старт импортирует CSV в SQLite (`/app/var`) — может занять время; данные уже в образе. На free-плане состояние эфемерно (пересоздаётся при рестарте) — для демо достаточно; для персистентности добавить disk.

## Вариант B — полная /v1-интеграция (3 сервиса)

`compose.yaml` поднимает gateway + ml (Python) + mocks с healthcheck'ами:
```bash
docker compose up --build --wait
# gateway на 127.0.0.1:8000, demo-режим и моки по умолчанию
```
Это нужно, когда демонстрируется связка Python↔Node и `/v1`. На free single-service хостах не разворачивается — нужен хост с Docker Compose (VPS/локально).

## Переменные окружения (из compose.yaml / .env.example)

| Переменная | Назначение | Дефолт |
|---|---|---|
| `LLM_MODE` | `demo` (без LLM) / `live` | demo |
| `LLM_API_KEY` | ключ шлюза — **только секретом**, не в git | — |
| `LLM_BASE_URL` | шлюз моделей | changellenge.up.railway.app/v1 |
| `LLM_MODEL` | модель по умолчанию | qwen/qwen3.6-35b-a3b |
| `MAX_DAILY_LLM_CALLS` | локальный лимит вызовов | 100 |
| `LLM_TIMEOUT_SECONDS` | таймаут вызова | 120 |
| `LLM_MAX_OUTPUT_TOKENS` / `_PLANNING_TOKENS` | лимиты токенов | 6000 / 6000 |

## Чек-лист перед демо
- [ ] Образ собирается на машине с Docker (здесь не проверено — нет daemon).
- [ ] `demo`-режим открывается без ключа; `/api/health` отвечает `ok`.
- [ ] Ключ только в секретах хоста, не в репозитории (`.env` в `.gitignore`).
- [ ] Для live — следить за бюджетом (`scripts/estimate_budget.py`, дашборд `demo/dashboard/`).
- [ ] Репозиторий приватный + доступ жюри (см. `docs/DECISIONS.md`).

## Честные ограничения
- Сборку образа и реальный деплой нужно подтвердить на машине с Docker — в этой подготовке daemon недоступен, конфиг проверен чтением.
- Node 24.13 / Python 3.12 зафиксированы в образах; локально у разработчиков могут быть новее — для прод-образа используйте Docker, а не локальные версии.
