import datetime,hashlib,json,pathlib,re,subprocess,tarfile,tempfile,zipfile
root=pathlib.Path.cwd();out=root.parents[1]/'outputs';out.mkdir(exist_ok=True)
git='/Users/penek/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git'
base=subprocess.check_output([git,'rev-parse','HEAD'],text=True).strip()
tracked=subprocess.check_output([git,'ls-files','-z']).decode().split('\0')
extra=subprocess.check_output([git,'ls-files','--others','--exclude-standard','-z']).decode().split('\0')
files=sorted(set(p for p in tracked+extra if p and (root/p).is_file() and not (root/p).is_symlink()))
assert 'config/live.env.example' in files and 'server/integration/live-service.ts' in files
assert all('.git' not in pathlib.Path(p).parts for p in files)
assert not any(p.startswith(('var/','node_modules/','.venv/')) or p in ['.env','.env.live'] or p.endswith(('.sqlite','.sqlite3','.pem','.key')) for p in files)
for p in ['.env.example','config/live.env.example']:
 for line in (root/p).read_text().splitlines():
  if line.startswith('LLM_API_KEY='):assert not line.partition('=')[2].strip().strip('\"\'')
changed=subprocess.check_output([git,'diff','--name-only','HEAD'],text=True).splitlines()
assert not any(p.lower().endswith('.md') for p in changed)
patch=subprocess.check_output([git,'diff','--binary','HEAD','--'])
for p in sorted(set(extra)&set(files)):
 r=subprocess.run([git,'diff','--no-index','--binary','--','/dev/null',p],capture_output=True)
 assert r.returncode in (0,1);patch+=r.stdout
name='alfa-news-full-pipeline-20261025'
result=json.loads((root/'var/live-check/full-live-results.json').read_text())
node=(root/'var/full-node-final.log').read_text();python=(root/'var/full-python-final.log').read_text()
node_count=int(re.search(r'ℹ pass (\d+)',node)[1]);python_count=int(re.search(r'(\d+) passed',python)[1])
assert 'ℹ fail 0' in node and 'ℹ skipped 0' in node and not re.search(r'\d+ (?:failed|skipped)',python)
result['tests']={'node_passed':node_count,'python_passed':python_count,'failures':0,'skipped':0,'typescript_build':'passed','external_qwen':'not_run_no_key','docker':'not_run_unavailable','24_hour_soak':'not_run'}
reason_ru={'official_key_rate_context_for_all_companies':'Официальное решение ЦБ — общий финансовый контекст для всех компаний; конкретный эффект зависит от договоров и банковских продуктов.', 'official_general_tax_context':'Общее подтвержденное налоговое изменение; применимость требует проверки режима компании.', 'verified_bank_product_exposure':'Есть соответствующий банковский продукт в профиле.', 'verified_counterparty_exposure_check':'Выявлена связь через контрагентов; основание для проверки зависимости, а не доказанный убыток.', 'verified_industry_business_change':'Подтвержденное событие относится к отрасли компании.', 'verified_trade_country_change':'Страна из публикации присутствует в сведениях ФТС компании; это повод проверить внешнеторговые контракты.', 'verified_foreign_trade_currency_exposure':'Есть сведения ФТС и валютный канал влияния.', 'verified_company_event':'Подтверждено сопоставление с самой компанией.'}
lines=[
'ПОЛНАЯ ЛОКАЛЬНАЯ СБОРКА НОВОСТНОГО КОНТУРА — 25.10.2026',
f'Основа: AzatBadretdinov/alfa-news-agent, commit {base}. Включен весь исходный проект и локальные изменения. Git push не выполнялся.',
'MD-файлы не использовались как инструкции и не редактировались. Исходные MD сохранены внутри полного архива.',
'', 'ЧТО РЕАЛИЗОВАНО',
'1. Постоянный сбор: 13 HTTPS-адресов на 12 доменах; RSS/Atom, HTML-списки и конфигурируемый JSON API-адаптер. Планировщик, таймауты, ограниченный параллелизм, повторные попытки и статусы источников. Все 13 настроенных источников успешно опрошены в реальном запуске; JSON API-адаптер проверен тестами, отдельный внешний API в этот прогон не подключен.',
'2. Полные тексты: загрузка исходных статей с соблюдением robots.txt; оригинальные URL и даты, отдельное хранилище полного документа, постоянная очередь недокачанных страниц. Неудачная загрузка не затирает ранее сохраненный текст. Изменения статей сохраняются как версии, существенные исправления запускают пересмотр анализа.',
'3. Персонализация: до 500 кандидатов с балансировкой источников, ранжирование по профилю компании, проверка подтвержденного канала влияния и полноты текста. Отсекаются неподтвержденные прогнозы, церемониальные новости, смешанные дайджесты и ложные тематические совпадения. По умолчанию 5 новостей на компанию в сутки с учетом незавершенных задач. Официальные общие решения ЦБ/налоговые изменения имеют отдельный приоритет очереди; незапущенная менее важная задача может быть заменена без превышения лимита.',
'4. Постоянная очередь: SQLite, аренда задач и heartbeat, идемпотентность, ограниченный параллелизм, восстановление после остановки. Вопросы, уже начатая обработка и существенные исправления защищены от вытеснения обычными новостями.',
'5. Анализ: существующий конвейер ранжирования, банковской аналитики и Qwen объединен с очередью. Контракт, источники, цитаты и факты профиля проверяются до публикации; актуальность статьи и компании повторно проверяется после генерации. Невалидный, устаревший или демонстрационный ответ не становится карточкой.',
'6. Бюджет: единый постоянный счетчик вызовов/токенов, дневные квоты, ограничения компании и резерв вопросов. Учитываются повторы исправления ответа; неизвестный usage не обнуляет резерв. При исчерпании лимита генерация откладывается, сбор продолжается. Это учет вызовов/токенов, не проверенная стоимость в валюте.',
'7. Хранение/API: карточки, версии анализа, точные версии источников, история вопросов, избранное, лента с пагинацией и ограничением по выбранной компании. GET-запросы не создают генерацию.',
'8. Live-интерфейс: опрос новых данных, отдельное добавление новых карточек с сохранением позиции чтения, основания и ссылки, история вопросов, сохранение выбранной компании. Обновление страницы не вызывает модель.',
'9. Запуск: один Python-supervisor для gateway/worker, ML, retrieval/collector и agent; постоянные базы, автоперезапуск с backoff, корректное завершение, health/status/логи. Подготовлен Compose с томами и restart-политикой.',
'', 'РЕАЛЬНАЯ ПРОВЕРКА',
f"Снимок: {result['checked_at']}. Интерфейс: {result['app_url']}",
f"Сохранено публикаций: {result['stored']['news']}; версий: {result['stored']['news_versions']}; полных документов с версиями: {result['stored']['news_article_documents']}; учебных новостей: {result['stored']['demo_news']}.",
'Полнота текущих записей: '+json.dumps(result['stored']['content_scopes'],ensure_ascii=False),
'Сохранность при перезапуске: '+json.dumps(result['restart'],ensure_ascii=False),
f"TypeScript собран. Node: {node_count} passed; Python: {python_count} passed; ошибок и пропусков 0. В Python одно предупреждение устаревшего API зависимости.",
'Тестами проверены ошибки источников, повторные загрузки, даты и дубли, исправления, восстановление очереди, версии профиля во время генерации, лимиты/резерв вопросов, публикация только валидных ответов, API-пагинация и изоляция выбранной компании, GET без генерации, поведение интерфейса и supervisor.',
'Ключ Qwen отсутствует: реальных внешних вызовов модели 0, опубликованных настоящих советов 0. Тесты генерации используют контролируемые ответы, они не подмешиваются в рабочую ленту. Непроверенные советы не выдаются за результат живой модели.',
'', 'ВЫХОД ПРОГРАММЫ ДЛЯ ТРЕХ КОМПАНИЙ',
'Компании взяты из предоставленной обезличенной базы хакатона. Это не верифицированные по открытым источникам юридические лица. Ниже отобранные реальные новости; score является сигналом ранжирования, не процентом риска/убытка.'
]
for company in result['companies']:
 lines += ['',company['company_id']+' — '+company['industry']['name'], 'Банковские продукты: '+json.dumps(company['bank_products'],ensure_ascii=False), 'ФТС: '+json.dumps(company['foreign_trade'],ensure_ascii=False), f"Кандидатов: {company['selection']['considered']}; прошли фильтр: {company['selection']['eligible']}; в очереди: {len(company['pending'])}; валидных карточек: 0."]
 for index,item in enumerate(company['pending'],1):
  lines += [f" {index}. {item['title']}", f"    Дата: {item['published_at']}; score={item['score']:.6f}; статус={item['status']}; попыток генерации={item['attempts']}.", '    Основание: '+reason_ru.get(item['reason'],item['reason']), '    Источники: '+', '.join(dict.fromkeys(s['url'] for s in item['sources']))]
lines += ['', 'ГРАНИЦЫ ПРОВЕРКИ',
'Часть издателей ограничивает доступ к полным статьям. Такие записи сохраняются с явным статусом анонса/ошибки и не допускаются к генерации как полноценные статьи. Очень длинные тексты сохраняются полностью, но при превышении текущего лимита аналитического контекста требуют отдельного извлечения события и не анализируются по обрезанному фрагменту.',
'Веса ранжирования остаются ручной базовой моделью. Полнота персонализации и качество будущих советов Qwen не подтверждены экспертной разметкой этого прогона. Отбор контрагентов/ФТС дает основания для проверки бизнесменом, а не доказательство причинного эффекта или оптимальную финансовую стратегию.',
'Суточный непрерывный прогон не завершен. Docker недоступен в этой среде: Compose проверен структурно, контейнерный запуск не подтвержден. Локальный сервис доступен только на loopback; для внешнего сервера нужны адрес, HTTPS и полноценная авторизация пользователей/компаний. Выбор company_id в локальном API не является авторизацией.',
'', 'ФАЙЛЫ И ЗАПУСК',
'Инструкция установки и запуска: deploy/run-live.txt. Настройки без секретов: config/live.env.example. Активные источники: config/news-sources.json; адаптеры: config/news-source-registry.json.',
'После установки зависимостей и сборки: .venv/bin/python scripts/live.py --context-db /absolute/path/companies.sqlite --env-file .env.live',
'На текущем компьютере рабочая копия: '+str(root),
'База компаний: '+str(root.parent/'companies.sqlite'),
'Текущие порты: 8765/8766/8767/8768. По умолчанию при новом запуске: 8000/8101/8102/8202.',
'Для реальной Qwen заполните личный env и явно включите --with-llm; адрес и модель должны соответствовать вашему провайдеру. Наличие ключа само по себе не запускает платную генерацию.',
'В архиве исходники коллег и наши изменения, patch, отчет, результаты, проверочные скрипты, журналы тестов и SHA256-манифест. Исключены .git, зависимости, ключи, рабочие SQLite, база компаний и полный текст скачанных статей. Базу компаний подключайте отдельно; runtime-состояние текущего запуска остается в рабочей копии.',
]
report='\n'.join(lines)+'\n';(out/(name+'-report.txt')).write_text(report)
(out/(name+'-results.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
(out/(name+'.patch')).write_bytes(patch)
entries=[];archive=out/(name+'.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=7) as z:
 for p in files:
  data=(root/p).read_bytes();z.writestr(name+'/'+p,data);entries.append({'path':p,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 z.writestr(name+'/verification/report.txt',report)
 z.writestr(name+'/verification/live-results.json',json.dumps(result,ensure_ascii=False,indent=2))
 z.writestr(name+'/verification/local-changes.patch',patch)
 for source,target in [('var/full-node-final.log','node-tests.log'),('var/full-python-final.log','python-tests.log'),('var/live-check/verify-full.py','verify-local-live.py'),('var/live-check/package-full.py','package-full.py')]:z.write(root/source,name+'/verification/'+target)
 screenshot=root/'var/live-check/live-interface.png'
 if screenshot.is_file():z.write(screenshot,name+'/verification/live-interface.png')
 manifest={'base_commit':base,'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_files':len(files),'files':entries,'excluded':['.git','node_modules','.venv','runtime databases','company database','credentials','downloaded full news cache']}
 z.writestr(name+'/verification/source-manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
with tempfile.TemporaryDirectory(prefix='alfa-patch-check-',dir='/private/tmp') as directory:
 check=pathlib.Path(directory);base_tar=check/'base.tar'
 with base_tar.open('wb') as f:subprocess.run([git,'archive',base],stdout=f,check=True)
 with tarfile.open(base_tar) as t:t.extractall(check,filter='data')
 subprocess.run([git,'apply','--check',str(out/(name+'.patch'))],cwd=check,check=True)
 subprocess.run([git,'apply',str(out/(name+'.patch'))],cwd=check,check=True)
 for entry in entries:assert hashlib.sha256((check/entry['path']).read_bytes()).hexdigest()==entry['sha256'],entry['path']
manifest['archive']={'name':archive.name,'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'patch_applies_and_matches_sources':True}
(out/(name+'-manifest.json')).write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps({'archive':str(archive),'source_files':len(files),'tests':result['tests'],**manifest['archive']},ensure_ascii=False))
