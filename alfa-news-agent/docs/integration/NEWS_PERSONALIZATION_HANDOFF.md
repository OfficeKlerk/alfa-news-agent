# Извлечение событий и аудит персонализации

Изменение подготовлено от `023070d16f4122e25bfe5ad45ad613c96a85ea0a` в локальной ветке `feature/news-personalization`. Коммит и push не выполнены. Новый демонстрационный интерфейс не создавался.

Этот документ фиксирует первую передачу реализации и её проверки. Последующие исправления, новые тесты и прогон 30 пар на оригинальных новостях недели описаны в [NEWS_FULL_AUDIT_20261024.md](../reports/NEWS_FULL_AUDIT_20261024.md).

## Состав

- `server/news.ts`, `server/news-events.ts`, `server/news-subjects.ts`: даты и история версий, канонические адреса, ограниченная кластеризация дублей, извлечение событий и предметных отраслей с цитатами. Подробности: [NEWS_INGESTION.md](NEWS_INGESTION.md).
- `/v1/news`, `/v1/feeds/refresh` и существующий интерфейс импорта подключены к выбранному retrieval-провайдеру. Контракты проверяют структуру и связь свидетельств с текстом; данные из будущих версий исключаются относительно `as_of`.
- `news_analysis/` и `integration/`: версия `company_event_v2` с 39 признаками, объяснение вклада признаков и граф связей с узким сопоставлением отраслей. Старые модели и 20 признаков v1 сохраняют свою версию; смешанные векторы не обучаются как один набор. Правила и веса baseline — инженерные гипотезы, не обученные коэффициенты и не оценки финансового эффекта.
- `data/personalization/`: [39 оценок](../../data/personalization/annotation_table.md), профили, источники, рубрика, шаблон слепого человеческого ревью и 6 независимо оценённых вторым AI пар. [Методика](../reports/PERSONALIZATION_LABELS.md) и [сравнение](../reports/PERSONALIZATION_COMPARISON.md) содержат ограничения и оставшиеся ошибки.

Тематические отрасли, выведенные правилами, отделены от буквальных ОКВЭД в источнике. Они не подтверждают юридическую применимость нормы. Наличие сведений ФТС не назначает компании роль импортёра или экспортёра.

## Воспроизведение

Требуются Python 3.12 и Node.js 24.13–24.x. Из корня проекта, в активированном Python-окружении:

```bash
python -m pip install -r requirements-dev.txt -c requirements.lock
npm ci
python scripts/build_contracts.py --check
npm run typecheck
npm test
npm run build
python -m unittest discover -s tests -q
python -m pytest -q
python data/personalization/validate.py
```

Пересчитать извлечение и сравнение без полной базы организаторов:

```bash
node --import tsx scripts/extract_personalization_events.ts --mode curated --input data/personalization/events.json --out data/personalization/evaluation/curated_extracted.json
node --import tsx scripts/extract_personalization_events.ts --mode articles --input data/personalization/articles.json --out data/personalization/evaluation/articles_extracted.json
python scripts/evaluate_personalization.py --input data/personalization --out data/personalization/evaluation --graph-snapshots data/personalization/evaluation/graph_snapshots.json --report docs/reports/PERSONALIZATION_COMPARISON.md
```

Сохранённые снимки графов привязаны к хешам профилей, извлечения и реализации. После изменения этих входов нужен пересчёт с исходной полной SQLite через `--database`; подмена маленькой базой для тестов отклоняется.

Проверка взаимодействия четырёх сервисов на существующих тестовых данных, без вызова внешней LLM, для Linux/macOS:

```bash
RANK_MODE=news-analysis NEWS_MODULE_PATH=. python scripts/dev.py --smoke --native-providers
```

В PowerShell перед последней командой установите `$env:RANK_MODE='news-analysis'` и `$env:NEWS_MODULE_PATH=(Get-Location).Path`.

## Результат проверки

Проверены сборка TypeScript, соответствие сгенерированных контрактов, 71 Node-тест, 106 Python unittest и 35 pytest. Один старый pytest для отдельно загружаемого исторического модуля пропущен при отсутствии этого модуля; встроенный модуль и новые признаки проверены другими тестами. HTTP smoke для Python context/rank → Node retrieval/agent → gateway прошёл. Сохранённые результаты аудита воспроизводятся без исходной SQLite.

На курированном входе NDCG@3 вырос с 0,7335 до 0,8680; все 5 значимых пар вошли в top-3. На фактических AI-пересказах без отраслевых тегов NDCG@3 вырос с 0,5212 до 0,9212; с усреднением равных баллов — с 0,3371 до 0,9081. В первых трёх позициях по всем компаниям остаются соответственно 2 и 1 нерелевантных попадания. Подробные баллы, позиции и причины сохранены в отчёте.

Это оценка на небольшом наборе, использованном для разработки. Она не измеряет перенос на новые компании, не является историческим backtest и не доказывает качество оригинальных RSS-текстов: проверялось извлечение из фактических AI-пересказов первоисточников. Метки зафиксированы до просмотра ранжирования; независимого человеческого ревью нет. Следующий этап оценки — слепая разметка новых событий и компаний с проверкой человеком.

Архив исходников содержит файлы проекта и небольшой обезличенный набор аудита. В него не входят `.git`, виртуальное окружение, `node_modules`, локальные SQLite, ключи и временные результаты запусков. Патч рассчитан на указанный базовый коммит; перед применением к другой версии выполните `git apply --check` и проверьте конфликты.
