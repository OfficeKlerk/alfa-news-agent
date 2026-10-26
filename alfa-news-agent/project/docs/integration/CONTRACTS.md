# API и JSON v1

Машиночитаемый источник: `scripts/build_contracts.py`; результаты — `contracts/v1/schema.json` (JSON Schema 2020-12) и `contracts/v1/openapi.json` (OpenAPI 3.1). Изменения вносятся в генератор и проверяются `python scripts/build_contracts.py --check`. Схема профиля берётся непосредственно из существующего `company_context/profile.schema.json`, без ручного дублирования. Общие примеры лежат в `contracts/v1/examples`, учебные события/источники — в `integration/fixtures`.

## HTTP

| Метод и путь | Вход → выход (имена схем) | Владелец |
|---|---|---:|
| GET `/v1/health` | — → `HealthDataResponse` | 5 |
| GET `/v1/companies?offset=0&limit=20` | query → `CompaniesDataResponse` | 1 |
| GET `/v1/companies/{company_id}` | ID → `ProfileResponse` | 1 |
| POST `/v1/rank` | `RankRequest` → `RankDataResponse` | 1 |
| POST `/v1/tools/search_news` | `SearchRequest` → `SearchDataResponse` | 3 |
| POST `/v1/tools/rag_bank_analytics` | `RagRequest` → `RagDataResponse` | 3 |
| POST `/v1/tools/resolve_sources` | `ResolveRequest` → `ResolveDataResponse` | 3 |
| POST `/v1/analyze` | `AnalyzeRequest` → `AnalysisResponse` | 2/5 |
| GET `/v1/analyses/{id}?company_id=…` | ID + company → `AnalysisResponse` | 2/5 |
| POST `/v1/analyses/{id}/questions` | `QuestionRequest` → `AnswerResponse` | 2/5 |
| POST `/v1/agent/analyze` | `AgentRequest` → `AnalysisResponse` | 2, только внутренний сервис |
| POST `/v1/agent/questions` | `AgentQuestionRequest` → `AnswerResponse` | 2, только внутренний сервис |

Два внутренних маршрута публикуются ролью 2 или mocks; публичный gateway отвечает на них 404. Он собирает контекст и передаёт запрос внутреннему агенту. Все сервисы должны поддерживать GET `/v1/health` и возвращать общий envelope с тем же request ID.

Запрос POST — JSON-объект с `Content-Type: application/json`. Лимит тела — 1 МБ. Неизвестные поля в новых DTO запрещены; поля исходного профиля подчиняются его существующей схеме. Идентификатор — 1–160 символов `A-Z a-z 0-9 _ : . -`. Дата включает время, секунды и пояс: `2026-10-23T13:00:00+03:00` или `2026-10-23T10:00:00Z`. Дата без пояса и bool вместо числа отклоняются. Количество новостей в rank ≤100, выдача RAG ≤20, разрешение источников ≤50.

## Envelope и ошибки

```json
{
  "meta": {
    "schema_version": "1.0.0",
    "request_id": "example-001",
    "mode": "mock",
    "warnings": ["synthetic_news"]
  },
  "data": {}
}
```

`data` имеет конкретную схему маршрута. `mock` означает использование синтетических данных/мока, `demo` — демонстрационную генерацию без LLM, `live` — реальный поставщик без этих флагов. `live` не является оценкой качества модели или готовности к production. Итоговый mode учитывает все использованные компоненты. Профиль внутри `data` сохраняет собственную прежнюю версию `schema_version="1.0"`; версия envelope — `1.0.0`.

Клиент может передать `X-Request-ID`; сервис возвращает его в заголовке и JSON. Некорректный ID заменяется новым. Тела ошибок провайдера и ключи не пересылаются.

```json
{
  "schema_version": "1.0.0",
  "request_id": "example-001",
  "error": {"code": "DEPENDENCY_TIMEOUT", "message": "Provider timeout", "retryable": true}
}
```

| HTTP | Значение |
|---:|---|
| 400 | Некорректный JSON |
| 403 | Недопустимый browser Origin |
| 404 | Объект/маршрут не найден, в том числе анализ другой компании |
| 409 | В этой сессии уже выполняется вопрос |
| 413 / 415 | Превышен размер / неверный Content-Type |
| 422 | Нарушен входной контракт |
| 429 | Достигнут лимит исполнения или dev-сессий |
| 502 | Неверный JSON/контракт/источник ответа поставщика |
| 503 / 504 | Поставщик недоступен / timeout |
| 500 | Внутренняя ошибка |

## Профиль и ранжирование

`RankRequest`: `company_id`, `events`, `as_of`, `limit`. Профиль не передаётся из браузера: его получает сервис роли 1 из собственного ContextStore. Ответ: `company_id`, `as_of`, `items`, `excluded_future_news_ids`, `truncated`.

Каждый `RankedItem` содержит `news_id`, `event_id`, `score`, `score_kind`, `reasons[{code,text,profile_paths}]`, `warnings`. `profile_paths` — JSON pointers к полям исходного профиля. `manual_feature_baseline` сохраняет исходную числовую шкалу; `mock` и `logistic_relevance_uncalibrated` имеют диапазон 0–1. Между разными `score_kind` оценки не сравниваются. Нельзя показывать их как вероятность ущерба. При нормализации/калибровке нужен новый явно названный тип оценки.

Одно `news_id` не может повторяться в rank-запросе. Для общего `event_id` выбирается самая поздняя публикация не позже `as_of`, при равенстве — по `news_id`. `null` в профиле не заменяется false/0; выручка RUB доступна только при подтверждённой единице.

## События, RAG и реестр

`Event` — нормализованный результат роли 3: `news_id`, `event_id`, `title`, `text`, `event_type`, `published_at`, nullable `event_at`, `fact_status`, `okved_divisions`, `countries`, `regions`, `company_ids`, nullable `entity_mapping_source`, `sources`, `is_mock`. Событие обязано иметь news-source с URL и excerpt. Непустой `company_ids` требует явного происхождения entity mapping; совпадение названия не считается готовой привязкой.

`Evidence`: `id`, `kind` (`company/news/bank`), `title`, nullable HTTP(S) `url`, `excerpt`, nullable `document_id/page/published_at`, `is_mock`. Для bank обязательны `document_id`, страница ≥1 и URL. В контексте анализа bank-источник должен иметь проверенную дату не позже `as_of`; недатированную аналитику нужно вернуть как ограничение, а не использовать для подтверждения позиции банка.

`search_news` принимает query, as_of, limit и nullable точный news_id. `rag_bank_analytics` возвращает bank-фрагменты и limitations, не готовую бизнес-рекомендацию. `resolve_sources` принимает ID и as_of, возвращает авторитетные тексты и `unknown_ids`. ID фрагмента должен стабильно обозначать конкретный документ/страницу/фрагмент; при смене содержимого нужна новая версия ID либо отказ по несовпадению. Синтетические источники остаются помечены `is_mock`.

## Агент и интерфейс

`AnalyzeRequest`: `company_id`, `news_id`, `as_of`, `audience_role` (`cfo/ceo/treasury`). Командные роли 1–5 не связаны с этими тремя аудиториями пользователя.

`AgentRequest` дополнительно содержит полный `profile`, нормализованный `event`, `ranked_item`, `research` и `is_mock`. Подготовленная live-генерация использует только переданные источники. Автономный legacy-агент сохранён отдельно; для совместимых demo/mock-поставщиков дополнительные источники проверяются шлюзом через `resolve_sources`. Идентификаторы и тексты источников нельзя генерировать самостоятельно.

`AnalysisEventRequest` = `{company_id,event,as_of,audience_role,expected_context_sha256?}`. `/v1/analysis-context` собирает профиль, ранг и RAG без генерации, возвращает `{input,sources,sha256,serialized_bytes}`. `/v1/analyze-event` анализирует переданное событие; несовпадение просмотренного хэша даёт 409 до модели. `/v1/analyze` по news_id сохранён. Профиль и ранжирование из браузера не принимаются.

`Analysis` содержит ID/компанию/новость/дату, `summary`, `why_relevant`, `claims`, `risks`, `opportunities`, `recommendations`, `limitations`, `sources`, `trace`, `mode`. Claim = `{kind,text,quote,source_ids}`. `fact` требует news-source; `ai` — company и news; `bank` — дословную quote, найденную в bank-excerpt, и `text=quote`. Проверка структуры и ссылок не доказывает семантическую истинность claim.

Для вопросов gateway передаёт агенту `analysis`, `company_id`, `question`, последние ≤10 пар `history`. `Answer` содержит `analysis_id`, `company_id`, `answer`, `source_ids` только из этого анализа. Для новых событий/источников нужно создать новый анализ. История между компаниями не переносится.

Для `Analysis.mode=live` обязательны `missing_data` и `grounding`; ai-claims требуют конкретных `profile_paths` и `conditions`, факт — точной news-цитаты. Live-вопросы дополнены `claims`, `claim_indexes`, `limitations`, `missing_data` и проходят повторную проверку gateway. Полная схема, ограничения и `MODEL_*` коды ошибок: [LLM_GROUNDING.md](LLM_GROUNDING.md). Mock/demo сохраняют прежние обязательные поля. Усиление live-контракта требует одновременного обновления внешней реализации роли 2.

SDK роли 4: `integration/frontend/client.js`. При смене компании нужно отменить активные запросы через AbortController, очистить выбранный анализ и не показывать запоздалый результат предыдущей компании. Учебная страница показывает этот способ работы. Для старого UI действует старый контракт `/api`; смешивать форматы `actions` и `recommendations`, `published` и `published_at`, Node relevance и Python score нельзя.

Изменения контракта проходят отдельный review роли 5 и затронутых владельцев, обновляют генератор, схемы, примеры, моки, SDK и тесты одной поставкой. Нельзя незаметно переименовать поле или сделать необязательный признак обязательным. Для несовместимого изменения нужен `/v2` или явно согласованный переход.
