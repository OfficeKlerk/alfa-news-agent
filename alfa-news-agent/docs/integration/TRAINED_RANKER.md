# Обучение и подключение ML-ранжировщика

Эта инструкция рассчитана на PowerShell, корень объединённого репозитория и Python 3.12 / Node.js 24. Docker не нужен. Для загрузки весов через API требуется изменение `integration/ml.py` из этой ветки: прежняя версия master игнорирует `RANK_MODEL_PATH`.

## 1. Окружение

Если окружение уже установлено, используйте его. Иначе:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -c requirements.lock
npm ci --ignore-scripts
npm run build
```

## 2. Обучение и сравнение

```powershell
.\.venv\Scripts\python.exe -m news_analysis train --dataset data/training_v2/bundle/eligible.jsonl --model-out data/processed/ranker-v2.json --report-out data/processed/ranker-v2-report.json
Get-Content data/processed/ranker-v2-report.json -Raw
```

Используйте `eligible.jsonl`, а не карантинные записи или произвольную смесь файлов. Команда сохраняет заданное разделение по событиям, выбирает L2 на validation и оценивает модель и ручной baseline на одинаковом test. Test не участвует в обучении. В отчёте сохраняется SHA-256 датасета.

Проверенный запуск для SHA-256 `3bf096ab5355afd53d84c82acabe037c55391d96276ba4f808e0229adc617866`:

| Test, 16 запросов / 52 записи | Обученная модель | Ручной baseline |
|---|---:|---:|
| NDCG@5 | 0,990895 | 0,996965 |
| Precision@5 | 0,317708 | 0,317708 |

Модель не улучшила baseline: разница NDCG@5 равна −0,006070. Поэтому веса подключаются только явно для эксперимента; основной режим автоматически не заменяется. Эти числа не являются accuracy. Precision использует знаменатель `min(k, query_size)`; размеры групп малы.

Все 323 строки eligible имеют AI-разметку. Статус отчёта — `provisional_ai_agreement`: это согласие с разметкой ИИ, а не независимая оценка экспертами. Высокий NDCG не доказывает качество на реальных клиентах. Оценка модели не является вероятностью финансового ущерба.

## 3. Запуск API с весами

В том же PowerShell, из корня репозитория:

```powershell
$env:RANK_MODE = 'news-analysis'
$env:NEWS_MODULE_PATH = (Get-Location).Path
$env:RANK_MODEL_PATH = (Resolve-Path .\data\processed\ranker-v2.json).Path
.\.venv\Scripts\python.exe scripts/dev.py --native-providers
```

Откройте http://localhost:8000/integration. Это интеграционный деморежим с учебными профилями и demo-агентом, но с настоящими загруженными весами ранжировщика. Основной интерфейс `/` использует прежний `/api` и через это изменение на ML не переключается. Настройки Compose эта инструкция не меняет.

В другом окне PowerShell проверьте ответ API:

```powershell
$body = Get-Content .\contracts\v1\examples\rank-request.json -Raw
$result = Invoke-RestMethod -Uri http://localhost:8000/v1/rank -Method Post -ContentType 'application/json' -Body $body
$result.data.items | Select-Object news_id, score, score_kind, warnings
```

Ожидается `score_kind = logistic_relevance_uncalibrated` и предупреждение `ranker_not_validated_on_human_labels`. Веса загружаются один раз при старте Python-сервиса. После переобучения перезапустите процессы. Неверный файл или несовместимая версия признаков останавливают запуск с ошибкой; тихой подмены baseline нет.

Для возврата к ручному baseline остановите процессы через Ctrl+C, выполните `Remove-Item Env:RANK_MODEL_PATH` и запустите снова. `RANK_MODE=news-analysis` без пути к весам сохраняет прежний ручной baseline.

## 4. Проверки

```powershell
New-Item -ItemType Directory -Force var | Out-Null
.\.venv\Scripts\python.exe -m pytest tests/integration/test_trained_ranker.py -q
.\.venv\Scripts\python.exe scripts/dev.py --smoke --native-providers
```

Новые тесты проверяют фактическое использование весов через `/v1/rank`, сохранение предупреждения об AI-разметке, прежний baseline без файла и отказ при ошибочном артефакте. Smoke проверяет HTTP-интеграцию процессов.

## 5. Как улучшать качество дальше

Сначала соберите независимую экспертную разметку пар «компания — событие» с несколькими кандидатами для каждой компании. Зафиксируйте отдельный контрольный набор новых событий и компаний. Сравнивайте baseline и модель на одних запросах; включайте нерелевантные новости и неоднозначные случаи. При текущем маленьком test не делайте вывод о превосходстве без оценки разброса результата.

Меняйте признаки и параметры по train/validation, а не по текущему test. После выбора новой модели проверьте её один раз на независимом контрольном наборе. Для включения по умолчанию сначала покажите устойчивое улучшение ранжирования и проверьте ошибки на примерах с экспертом. Калибровка вероятностей, прогноз потерь и обучение финансовых сценариев — отдельные задачи.
