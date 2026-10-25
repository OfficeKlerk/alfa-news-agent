# Проверка локальной интеграции

Дата: 23.10.2026. Python 3.12.14, Node.js 24.19.0 в среде подготовки; проект сохраняет исходное требование Node 24.13–24.x. Проверки не использовали реальные LLM и не изменяли GitHub.

| Проверка | Результат |
|---|---|
| `master`: unittest профиля | 19 тестов пройдены |
| Точный `feature/news-analysis@53c2256…` | 78 тестов пройдены, включая тесты профиля, графа, ranker, сценариев, датасетов и происхождения |
| Исходный Node-прототип | typecheck, 18 тестов и build пройдены |
| Общая схема и OpenAPI | Python Draft 2020-12 + Node AJV; OpenAPI 3.1 успешно разобран и разрешён Swagger Parser |
| Текущая Node-ветка | 28 тестов: 18 исходных + 10 интеграционных; typecheck/build пройдены |
| Новые Python/инфраструктурные тесты | 15 пройдены, включая native Python rank-адаптер после подготовки overlay |
| Сквозной HTTP, отдельные Python/Node/mocks | Профиль → поиск → rank → анализ → история; legacy API сохранён |
| Сквозной HTTP, Python news_analysis + native Node agent | Пройдено, demo без LLM |
| Сквозной HTTP, отдельные native role-2/role-3 сервисы + Python news_analysis | Пройдено, четыре независимых процесса |
| Compose YAML | Все три файла соответствуют официальной JSON Schema Compose Specification |
| Сборка/запуск Docker images | **Не выполнялись: Docker отсутствует в среде** |
| GitHub Actions | Workflow подготовлен, удалённо не запускался |
| Исходные модули | `company_context`, `server/{app,agent,db,news,retrieval,config,types,llm,prompts,index}.ts`, `frontend` не изменены |

Негативные тесты проверяют неизвестную компанию, чужую сессию, неподходящую версию профиля, неверные JSON/Content-Type/размер/Origin, timestamp без пояса, bool вместо числа, повтор news ID, будущие события, контекст другого rank-ответа, неизвестные ID/изменённый текст источника агента, сетевую ошибку/timeout/невалидный ответ поставщика, лимит параллелизма, ёмкость и истечение dev-сессий. Есть проверка дополнительного источника, самостоятельно найденного агентом и подтверждённого реестром роли 3.

При подготовке обнаружены и исправлены: отсутствие проверки date-time в минимальном Python jsonschema, несовместимость CommonJS-экспорта ajv-formats с NodeNext, разделение native baseline и вероятностной шкалы, мутация общего объекта source in-process адаптером, отсутствие limitations в legacy-RAG envelope. Эти случаи входят в контрактные и сквозные проверки. Исходные предметные модули при этом не переписывались.

В pip-тестах есть предупреждение сторонней Starlette/AnyIO о deprecated BlockingPortal alias; оно не приводит к провалу тестов. Production-готовность реальных сервисов этим документом не заявляется. Не проверены реальные LLM, качество OCR/ML, нагрузка, production auth и контейнерные права/сборка на целевой ОС.

## Что выполнить на компьютере с Docker

```bash
docker compose config --quiet
docker compose up --build --wait --wait-timeout 180
python scripts/smoke.py http://127.0.0.1:8000
docker compose logs --tail=100
docker compose down
```

После подготовки overlay:

```bash
docker compose -f compose.yaml -f compose.news.yaml config --quiet
docker compose -f compose.yaml -f compose.news.yaml up --build --wait
python scripts/smoke.py http://127.0.0.1:8000
```

Готовый workflow повторяет unit/contract/HTTP проверки и имеет отдельный job Compose smoke. До будущей публикации его результат неизвестен. Успех статической JSON Schema не заменяет сборку и запуск контейнеров.
