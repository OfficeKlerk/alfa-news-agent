# PR: TEAM_TASKS5, задачи 3 и 4

Ветка `feature/event-interpretation`, base **master** (`cee9cf8`, включая принятый PR #27 с задачами 1/2/5). Коммиты и push выполняет Матвей.

## Название

Clarify rate holds, sector applicability and standards development

## Описание

Сохранение ключевой ставки больше не предлагается трактовать как неизменность всех договорных и рыночных условий. Анализ и уточняющие вопросы получают одинаковые ограничения: условия финансирования неизвестны без договоров и актуальных предложений; новый процентный шок не придумывается.

До ML-ранжирования применяется существующее извлечение и к вручную введённым новостям. Транспортный бюджет и электроэнергетика получают проверяемую тематическую связь; она не подтверждает контракты или применимость требований. Стадия разработки ГОСТов сохраняется в контексте и промпте, без подмены её принятием или обязательным применением.

Изменены основной промпт, подготовка события, отраслевое извлечение, условные ML-пояснения и соответствующие тесты. Файлы валидаторов/repair первого участника и API-контракты не изменены. В gateway правка ограничена подготовкой события перед ML.

Проверка: 207 Node-тестов на master с принятым PR #27, typecheck/build, контракты, 5 офлайн-сценариев LLM и HTTP smoke с news-analysis/native providers прошли. Python: 197 passed / 3 failures окружения Windows (CRLF checksum двух неизменённых файлов, права на симлинки); полный набор должен пройти в CI. Новые четыре Python-регрессии и Python-интеграция: 47 passed.

Есть сравнение на трёх сохранённых реальных публикациях с синтетическими профилями. Оригинальные неудачные JSON из TEAM_TASKS5 не переданы. Внешняя LLM не вызывалась, семантическая приёмка ещё нужна. Подробности: docs/reports/TEAM_TASKS5_3_4.md.

## Отправка

```powershell
cd D:\Develop\study\hackathon\alfa-news-agent-current
git branch --show-current
git status
git add news_analysis/pipeline.py server/news-subjects.ts server/integration/analysis-prompts.ts server/integration/advice-policy.ts server/integration/event-interpretation.ts server/integration/gateway.ts server/integration/tests/event-interpretation.test.ts tests/test_event_interpretation.py tests/fixtures/event_interpretation_cases.json data/demo/event_interpretation_comparison.json docs/reports/TEAM_TASKS5_3_4.md docs/integration/PR_EVENT_INTERPRETATION.md
git commit -m "Clarify event interpretation for tasks 3 and 4"
git push -u origin feature/event-interpretation
```

После push открыть PR: base master, compare feature/event-interpretation. Перед отправкой сверить свежий master и ветку `codex/role2-tasks-1-2-5`; список файлов при текущей проверке не пересекался. Не добавлять .env, .venv, var или артефакты локального окружения.
