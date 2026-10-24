# Как обновить локальный master и отправить файлы

Команды ниже выполняет пользователь в PowerShell. Подготовка и проверка архива не создают коммитов на GitHub, PR или merge. Архив содержит исходники и README, без личного `.env`, баз, весов и зависимостей.

Комплект сверён с `master` на коммите `7c9493bf98c553efc2d9bb2f7f39413bf9774c63`: изменения общего ML-кода совпадают с локальной базой, 27 новых файлов команды проверены отдельно и сохраняются при обновлении. Ссылки из командного README включены в новый README. Это снимок проверки: перед копированием всё равно подтяните актуальный master.

## 1. Сохранить локальное состояние и получить master

```powershell
cd C:\Users\Roman\alfa-news-agent
git status
$backupBranch = 'backup/before-llm-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
git branch $backupBranch
git stash push -u -m 'Before LLM update'
git status --short
git fetch --all --prune
git switch master
git pull --ff-only origin master
```

Выполняйте команды по очереди. `git status --short` после stash должен быть пустым. `No local changes to save` означает, что сохранять нечего. Ветка backup сохраняет коммиты, stash — незакоммиченные отслеживаемые и обычные неотслеживаемые файлы. Игнорируемые `.env`, `.venv`, `node_modules`, `var` остаются на диске. Нельзя использовать `git clean` или `reset --hard` для очистки этой папки.

Если после stash остались файлы, сохраните их отдельно до продолжения. Если switch/pull завершился ошибкой, сначала разберите её; не копируйте архив поверх неудачного обновления. `--ff-only` специально не объединяет разошедшиеся истории автоматически. `fetch --all` получает ссылки всех remote, но не сливает остальные ветки в master.

Сохранённые изменения не применяются автоматически. Если это прежний комплект LLM, его заменяет новый архив. Если в stash есть другие нужные правки, верните их отдельно через `git stash apply` с проверкой конфликтов и повторным запуском тестов; запись stash остаётся до явного удаления. Посмотреть сохранения можно командами `git stash list` и `git stash show -p 'stash@{0}'`.

## 2. Распаковать финальный архив

Скачайте `alfa-llm-final.zip` в Downloads. Проверьте имя файла и измените путь, если браузер добавил `(1)`:

```powershell
$llmArchive = Join-Path $env:USERPROFILE 'Downloads\alfa-llm-final.zip'
Expand-Archive -LiteralPath $llmArchive -DestinationPath . -Force
git status --short
git diff --stat
```

Архив распаковывается прямо в корень проекта, рядом с `package.json`. README заменяется намеренно. Не копируйте содержимое в дополнительную вложенную папку. Если после проверки архива товарищи уже изменили те же файлы, сопоставьте `git diff` с их изменениями до коммита; полный файл в ZIP сам по себе не умеет разрешать такие конфликты.

## 3. Проверить установку и работу

Нужны Node.js 24.13–24.x и Python 3.12. Если `.venv` ещё нет, сначала `python -m venv .venv`.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -c requirements.lock
npm ci
.\.venv\Scripts\python.exe scripts/build_contracts.py --check
npm run typecheck
npm test
npm run build
npm run llm:evaluate
.\.venv\Scripts\python.exe scripts/prepare_news_source.py
.\.venv\Scripts\python.exe -m pytest tests/integration tests/test_demo_news_contract.py -q
.\.venv\Scripts\python.exe -m unittest discover -s tests -q
.\.venv\Scripts\python.exe scripts/dev.py --smoke
```

При ошибке остановитесь на ней, исправьте и повторите соответствующую проверку. `prepare_news_source.py` проверяет текущий встроенный модуль аналитики и JSON-контракты на синтетических профилях; история Git не требуется.

Обычный запуск интерфейса:

```powershell
.\.venv\Scripts\python.exe scripts/dev.py
```

Откройте <http://localhost:8000/analysis/>. Проверьте выбор компании/новости, контекст, генерацию demo, переходы к источникам и вопрос. Ctrl+C остановит сервисы. Внешняя LLM и оценка её качества запускаются отдельно по [LIVE_LLM.md](LIVE_LLM.md) и [LLM_EVALUATION_UI.md](LLM_EVALUATION_UI.md).

## 4. Добавить только файлы комплекта и отправить master

```powershell
$llmFiles = Get-Content .\docs\integration\LLM_FILES.txt
git add -- $llmFiles
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m 'Add grounded LLM analysis'
git pull --rebase origin master
git push origin master
git status
```

Список `LLM_FILES.txt` включает все файлы архива. Посторонние ZIP, bundle, research-папки и личные настройки в этот add не попадают. Коммит отправляет также более ранние локальные коммиты master, если они есть: их следует просмотреть через `git log origin/master..HEAD --oneline`.

Если pull подтянул новые коммиты, повторите проверки из шага 3 до push. При конфликтах rebase выполните `git status`, исправьте конфликтующие файлы, добавьте именно их через `git add -- путь` и выполните `git rebase --continue`; затем повторите тесты. Для отмены незавершённого rebase — `git rebase --abort`. Не используйте `push --force`.

Если push отклонён из-за новых коммитов, снова выполните `git pull --rebase origin master`, проверки и обычный push. Если GitHub запрещает прямой push в master, используйте рабочую ветку и PR по правилам репозитория; обходить защиту не нужно. После успешного push раздел `git status` должен сообщать, что master совпадает с origin/master; сохранённый stash при этом остаётся локально.
