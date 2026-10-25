# Проверка UI + gateway без платных вызовов (TASKS9 #6)

> `scripts/check_analysis_ui.ts` поднимает **реальный** стек (Python API + Node gateway + агент + валидаторы + продуктовый UI) и гоняет его через Chromium (Playwright). Заменяется **только** LLM-провайдер — локальной HTTPS-заглушкой, которая возвращает ответы формы валидатора и умеет имитировать сбои REPORT8 (обрезка, цикл, пустой ответ провайдера). **0 платных вызовов**, ключ не читается.

## Результат (master `b3c51eb`, 25.10.2026)

**15 из 15 шагов пройдено, paid_calls: 0.** Среди проверенного:
- контекст строится без вызова LLM; переключение компании сбрасывает старый анализ; показывается профиль новой компании;
- обрезанный ответ (лимит 2500) → понятный отказ, не частичный анализ;
- зацикленный ответ → отказ с указанием повторов, без частичного анализа;
- пустой ответ провайдера (AkashML, native error) → явный отказ маршрута после одного вызова, без repair;
- grounded-генерация использует cap TASKS8 (2500); `null`-флаги продуктов доходят до gateway без искажений; провайдер видит только бизнес-представление и не получает repair после обрезки.

Полный отчёт по шагам — `var/ui-check/report.json` (gitignored, генерируется прогоном).

## Как воспроизвести

```bash
# 1) dev-инструмент Playwright ставится локально (в CI не качается — см. ниже)
npm i -D playwright && npx playwright install chromium   # нужен также openssl

# 2) company-context SQLite (профили). company_context ждёт РАСПАКОВАННЫЙ CSV:
mkdir -p var/ui-check/csv
for f in df_Uid_data_hack df_Uid_payment_hack df_Fid_Uid_link_hack; do gunzip -c data/$f.csv.gz > var/ui-check/csv/$f.csv; done
python -m company_context build \
  --companies var/ui-check/csv/df_Uid_data_hack.csv \
  --links var/ui-check/csv/df_Fid_Uid_link_hack.csv \
  --payments var/ui-check/csv/df_Uid_payment_hack.csv \
  --database var/ui-check/context.sqlite3 --revenue-unit rub
# (на реальных данных — те же CSV организаторов; синтетические 3 компании годятся для проверки UI)

# 3) сама проверка
npm run build
PYTHON=python node --import tsx scripts/check_analysis_ui.ts \
  --context-db var/ui-check/context.sqlite3 --out var/ui-check/report.json
```

## CI и Playwright

`playwright` добавлен в `devDependencies` (точная версия), чтобы `require("playwright")` разрешался воспроизводимо. CI **браузер не качает** и не запускает: в шаге `npm ci` выставлен `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. UI-проверка — локальная, в пайплайн не входит (ей нужен Chromium и openssl).

## Оговорки
- Провайдер — локальная заглушка формы валидатора, **не настоящая модель**: проверяется поведение UI/gateway/валидаторов и диагностика, а не смысловое качество ответов LLM.
- `--context-db` обязателен и должен существовать; на синтетических 3 компаниях проверяется только UI-путь.
- Браузерная визуальная эстетика не оценивается — это функциональная проверка шагов.
