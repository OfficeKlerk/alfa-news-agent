# Карта проекта — с чего начать

> Одностраничная навигация: что это, где что лежит, как запустить. Подробности — по ссылкам.

## Что это
Персональная новостная аналитика для крупного бизнеса: **профиль компании → релевантные новости → интерпретация с источниками и позицией банка → уточняющие вопросы**. Не лента-пересказ, а объяснение влияния события на конкретную компанию. Агентная логика + RAG по аналитике Альфа-Банка.

## Код — модули верхнего уровня

| Путь | Назначение | Стек / роль |
|---|---|---|
| `company_context/` | CSV → SQLite, профиль компании, граф платежей, provenance | Python / 1 |
| `news_analysis/` | признаки, граф, baseline/ML-ранкер, сценарии, датасеты | Python / 1 |
| `server/` | Node-приложение: агент, LLM, RSS, RAG-поиск, legacy `/api` | Node·TS / 2,3 |
| `server/integration/`, `integration/` | gateway `/v1`, адаптеры, Python ML-сервис, моки | Python+Node / 5 |
| `frontend/` | продуктовый UI (lenta, карточка факт/банк/AI, вопросы) | JS / 4 |
| `contracts/v1/` | JSON Schema + OpenAPI + примеры — интерфейс между компонентами | — / 5 |
| `scripts/` | CLI: оценка ранжирования/ретрива, бюджет, dev-запуск | — |
| `data/` | данные: `appendix_1/2` (CSV/PDF), `training_v1/2`, `demo/` (fixtures) | — |
| `tests/` | Python-тесты (контракт, оценка, интеграция) | — |
| `docker/`, `deploy/`, `compose*.yaml`, `Dockerfile` | сборка и деплой | — / 5 |

> ⚠️ **Про интерфейсы:** продуктовый UI — `frontend/`. В `integration/` есть ещё три *технических* стенда (`frontend/` SDK-проверка, `analysis_ui/`, `learning_ui/`) — они для разработки, не продукт.

## Документация — по папкам

| Папка | Что внутри |
|---|---|
| [`docs/architecture/`](architecture/) | `ARCHITECTURE_OVERVIEW` (гибрид Python+Node), `ARCHITECTURE` (Node-прототип), `SECURITY`, `SCALABILITY` |
| [`docs/reports/`](reports/) | метрики: `BASELINE_REPORT` (ранжирование), `RETRIEVAL_REPORT` (RAG), `SERVER_RETRIEVAL_EVAL` (ретрив), `RETRIEVAL_FRESHNESS` (свежесть/разнообразие), `MONITORING` (критерий №12), `MODEL_SETTINGS` (подбор настроек LLM) |
| [`docs/guides/`](guides/) | `DEMO_SCRIPT` (сценарий защиты), `DEMO_COMPANIES` (матрица), `LABELING_GUIDE`, `DEPLOY`, `V1_MIGRATION` |
| [`docs/process/`](process/) | `DECISIONS` (решения), `TASKS` (план по ролям), `TEAM_GUIDE`, `ROLE_3_BACKEND_RAG` |
| [`docs/integration/`](integration/) | контракты, интеграция, адаптивное обучение LLM |
| [`docs/dashboard/`](dashboard/) | мониторинг-дашборд (HTML) |
| [`docs/ui/`](ui/) | референс-карточка роли 4 + маппинг на контракт |
| [`docs/archive/`](archive/) | исторические снимки (`NODE_MIGRATION`, `CODE_TOUR`, `LINE_BY_LINE`, `HANDOFF`) — не актуализируются |

## Как запустить проверки (офлайн, без расхода бюджета)

```bash
python scripts/evaluate_ranking.py --labels data/demo/eval/labels.json \
  --predictions data/demo/eval/sample_predictions.json --k 3        # качество ранжирования
python scripts/evaluate_retrieval.py --queries data/demo/rag/queries.json \
  --retrieval data/demo/rag/reference_retrieval.json --k 3          # качество RAG-ретрива
python scripts/estimate_budget.py --usage data/demo/sample_usage.json \
  --prices data/demo/model_prices.json                             # бюджет в рублях
python -m pytest tests/test_demo_news_contract.py -q               # контрактный тест
```
Полный список (typecheck/test/build Python+Node) — корневой `README.md`, раздел «Проверки».

Аудит персонализации: [таблица компания × новость × оценка × причина](../data/personalization/annotation_table.md), [сравнение v1/v2](reports/PERSONALIZATION_COMPARISON.md). Он использует 3 проверенных обезличенных профиля и 13 событий; оценки AI, независимой человеческой проверки пока нет. [Сбор и извлечение событий](integration/NEWS_INGESTION.md) описывает даты, версии и дубли; [передача кода](integration/NEWS_PERSONALIZATION_HANDOFF.md) содержит команды воспроизведения.

Последующая [проверка всей цепочки и исправления от 24 октября](reports/NEWS_FULL_AUDIT_20261024.md): [30 результатов на оригинальных новостях недели](reports/WEEKLY_NEWS_RESULTS_20261024.md), без внешней LLM. Это отдельная отладочная подборка, без независимых человеческих оценок.

Живые LLM-прогоны и списки работ: [REPORT8](reports/REPORT8.md) → [TEAM_TASKS8](reports/TEAM_TASKS8.md) → [ход исправлений](reports/TASKS8_PROGRESS.md) → [REPORT9](reports/REPORT9.md) → [TEAM_TASKS9](reports/TEAM_TASKS9.md).

Свежая [проверка интеграции ветки коллег `codex/payment-context`](reports/PAYMENT_INTEGRATION_REVIEW_20261024.md): новые платёжные агрегаты, исправления расчётов/контрактов и правильный режим `/v1` + `RANK_MODE=news-analysis`.

## Запуск приложения
```bash
npm ci && npm run build && python scripts/dev.py   # стенд на :8000 (Python API + Node gateway + моки)
# http://127.0.0.1:8000/          — продуктовый UI (/api)
# http://127.0.0.1:8000/?api=v1   — UI на /v1 (см. docs/guides/V1_MIGRATION.md)
```

## Демо за 2 минуты
Открыть UI → переключать 3 компании из `data/demo/demo_companies.json` (`U_34911`, `U_99262`, `U_4909`) → показать, что новость про ключевую ставку значима для компаний с кредитами и не значима для энергокомпании без кредитов. Сценарий целиком — [`docs/guides/DEMO_SCRIPT.md`](guides/DEMO_SCRIPT.md).

## Соответствие критериям ТЗ

| Критерий успеха | Где закрыт |
|---|---|
| Бизнес-контекст, отбор значимых событий | `company_context/`, `news_analysis/` |
| Персонализация (не отраслевой тренд) | [`docs/guides/DEMO_COMPANIES.md`](guides/DEMO_COMPANIES.md) |
| Качество отбора (измеримо) | [`docs/reports/BASELINE_REPORT.md`](reports/BASELINE_REPORT.md), `scripts/evaluate_ranking.py` |
| Позиция банка отделена от вывода AI | `data/demo/news_bank_mapping.json`, карточка UI |
| Трассируемость (№11) | provenance + [`docs/architecture/ARCHITECTURE_OVERVIEW.md`](architecture/ARCHITECTURE_OVERVIEW.md) |
| Масштабируемость (№7) | [`docs/architecture/SCALABILITY.md`](architecture/SCALABILITY.md) |
| Мониторинг качества (№12) | [`docs/reports/MONITORING.md`](reports/MONITORING.md), [`docs/dashboard/`](dashboard/) |
| Безопасность AI | [`docs/architecture/SECURITY.md`](architecture/SECURITY.md) |
| Бюджет 500 ₽/день | `scripts/estimate_budget.py` |
