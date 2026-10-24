# Отправка TEAM_TASKS6

Ветка `feature/tasks6-grounding`, base **master**. Перед отправкой сверить master; commit/push выполняет Матвей.

## Название

Fix claim shapes, targeted repair and per-claim profile grounding

## Описание PR

После REPORT6 модель повторяла пустые profile_paths у fact, раздувала claims и пропускала выводы «лизинг → обязательства»/«has_fts=false → торговля не ведётся». Профильные утверждения могли остаться внутри claims без собственных подходящих путей.

Разделены формы fact/bank и ai в промпте v9, добавлены рекомендации компактности и адресные правила repair для пустых массивов и неправильного вида источника. Каждый AI-claim теперь проверяется на соответствующие продуктовые, внешнеторговые и платёжные пути. Уточнены проверки флагов и точная формулировка отраслевого несовпадения. Лимиты токенов/попыток сохранены; ключевые схемы ответа не ослаблены, добавлена только диагностика.

Проверки: 224 Node-теста, typecheck/build, 47 Python-проверок, контракты, 5 офлайн-сценариев и HTTP smoke с news-analysis/native providers. Новые регрессии охватывают оба JSON-режима, факты в скрытых claims, неизвестные флаги, исторические bank-цитаты и дословные примеры исходного прогона. Прежняя фикстура покрытия исправлена: кредитный факт больше не подтверждается только платёжным путём.

Выполнен офлайн-replay всех 25 оригинальных ответов: 183 контрольные суммы совпали; три ранее принятых ошибочных ответа теперь отклоняются. Затем по подтверждённому разрешению проведён live-прогон v9: 24 вызова, 8/14 исходных анализов приняты, оба строгих контроля отклонены, один запущенный вопрос отклонён и два заблокированы неудачными анализами. Null-контроль технически принят, но в условиях ответа потеряна неизвестность; также обнаружены перефразировка договорной экспозиции и mismatch при unknown. Полная продуктовая приёмка не заявляется. Полные профили и запросы находятся только в var; ключ исключён. Результаты и дальнейшие задачи: docs/reports/REPORT7.md и TEAM_TASKS7.md. Подготовительный отчёт: docs/reports/TEAM_TASKS6.md.

## Команды

```powershell
cd D:\Develop\study\hackathon\alfa-news-agent-current
git branch --show-current
git status
git add contracts/diagnostic-rules.json contracts/v1/schema.json contracts/v1/openapi.json server/integration/analysis-prompts.ts server/integration/repair-guidance.ts server/integration/prepared-agent.ts server/integration/profile-facts.ts server/integration/grounding.ts server/integration/claim-profile-grounding.ts server/integration/tests/profile-quote-caution.test.ts server/integration/tests/tasks6.test.ts scripts/replay_saved_responses.ts scripts/run_tasks7_llm.ts tests/fixtures/tasks6_report_regressions.json tests/fixtures/tasks6_saved_excerpts.json docs/reports/TEAM_TASKS6.md docs/reports/REPORT7.md docs/reports/TEAM_TASKS7.md docs/integration/PR_TASKS6.md
git commit -m "Fix claim repair and profile grounding for TEAM_TASKS6"
git push -u origin feature/tasks6-grounding
```

Затем создать PR с base master и compare feature/tasks6-grounding. Не добавлять .env, var, .venv и данные личного прогона без отдельной проверки.
