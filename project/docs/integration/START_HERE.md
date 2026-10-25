# Старт команды: интеграция v1

> Обновление: для объединённой ветки и переноса всех работ в master используйте [MERGE_TO_MASTER.md](MERGE_TO_MASTER.md) и корневой README. Ниже сохранена инструкция первоначального интеграционного этапа.

Подготовлено 23 октября 2026 года. Рабочая ветка: `role5/integration-foundation`, база — `feature/node-prototype` (`d1c08bb`). Ветки не объединены. GitHub не изменён: push, PR и запуск Actions не выполнялись.

Это интеграционный фундамент для параллельной разработки. В нём работают общий запуск, контракты, моки и адаптеры существующих модулей. Реальные ML, автономный агент и промышленный RAG остаются задачами соответствующих ролей. Старый интерфейс сохранён и пока использует `/api`; новый стенд и SDK используют `/v1`.

## Что читать

1. [AUDIT.md](AUDIT.md) — три ветки, различия и ограничения.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — границы Python/Node.js и способ подключения модулей.
3. [CONTRACTS.md](CONTRACTS.md) — API, форматы, ошибки и правила источников.
4. [TEAM.md](TEAM.md) — владение кодом, отдельные команды запуска для пяти ролей и порядок PR.
5. [VALIDATION.md](VALIDATION.md) — выполненные проверки и то, что ещё нужно проверить.
6. [PR_DRAFT.md](PR_DRAFT.md) — готовое описание будущего PR, который пока не создан.

## Запуск через Docker

Нужны Docker Engine/Desktop и Docker Compose v2. Из корня репозитория:

```bash
docker compose up --build --wait
```

Открыть <http://localhost:8000/integration>. Кнопка проводит через профиль Python → поиск → ранжирование Python → агент → уточняющие вопросы. Выбор `U_A` и `U_C` даёт разные результаты мок-ранжирования. Все учебные данные помечены `mode=mock`.

Существующий интерфейс: <http://localhost:8000/>. Он продолжает обращаться к старому `/api` и использует исходные данные Node-прототипа; это отдельный переходный путь, не доказательство подключения нового `/v1` к продуктовому UI.

```bash
python scripts/smoke.py http://127.0.0.1:8000
docker compose logs --tail=100
docker compose down
```

`down` сохраняет базы. Удалять volumes следует только при осознанном сбросе локальных данных. Python и Node имеют разные volumes и разные схемы SQLite.

## Запуск без Docker

Нужны Python 3.12, Git и Node.js 24.13–24.x (точная исходная версия записана в `.nvmrc`).

```bash
python -m venv .venv
```

Активировать окружение:

```bash
# Linux / macOS
source .venv/bin/activate
```

```powershell
# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Затем на любой платформе:

```bash
python -m pip install -r requirements-dev.txt -c requirements.lock
npm ci
npm run integration:dev
```

Одна команда запускает три процесса, ждёт их готовности и завершает их по Ctrl+C. Она использует маленькие синтетические данные, отдельные базы в `var/integration/dev`, режим агента demo и не вызывает LLM. Логи лежат рядом с базами. Открыть <http://localhost:8000/integration>.

Проверка с временными базами и свободными портами:

```bash
npm run integration:smoke
```

Для прямых команд Python нужно активированное окружение. `Makefile` — дополнительное удобство для систем с `make`, а не обязательное условие запуска.

## Проверить встроенный модуль аналитики

```bash
python scripts/prepare_news_source.py
```

Скрипт проверяет встроенный `news_analysis` на синтетических профилях: JSON-контракты профиля и ранжирования, признаки `company_event_v2` и объяснения оценок. История Git и старый overlay не требуются. `integration/sources.lock.json` сохраняет историческое происхождение исходников. Docker использует модуль, включённый в образ.

Docker:

```bash
docker compose -f compose.yaml -f compose.news.yaml up --build --wait
```

Без Docker, Linux/macOS:

```bash
RANK_MODE=news-analysis AGENT_MODE=legacy python scripts/dev.py --smoke
RANK_MODE=news-analysis AGENT_MODE=legacy python scripts/dev.py
```

PowerShell:

```powershell
$env:RANK_MODE = 'news-analysis'
$env:AGENT_MODE = 'legacy'
python scripts/dev.py --smoke
python scripts/dev.py
```

`legacy` здесь означает адаптер существующего Node-агента. Профиль и ранжирование он получает из Python, фрагменты — через контракт роли 3. Локальный runner всё равно использует demo без LLM. Для возврата к мокам удалить эти переменные окружения.

## Проверки перед передачей коллегам

```bash
python scripts/build_contracts.py --check
npm run typecheck
npm test
npm run build
python -m unittest discover -s tests -p test_company_context.py -q
python scripts/prepare_news_source.py
python -m pytest tests/integration -q
python scripts/dev.py --smoke
```

Ветка содержит локально подготовленный workflow GitHub Actions. Он начнёт работать только после будущего push. До публикации нужно выполнить Docker-проверку на компьютере с Docker: в среде подготовки Docker отсутствовал.

Следующий шаг команды: проверить этот фундамент локально, согласовать владельцев и `/v1`, затем отдельно разрешить публикацию ветки и Draft PR. До этого не выполнять команды push и создания PR.
