# Передача изменения команде

Рабочая ветка: `feature/rag-document-diversity`, обновлена до `master` `541c778`. PR #20, #21, #22 и #23 уже приняты. Новая оценка свежести/разнообразия из #23 дополняет наше изменение и не меняет сам поиск.

Для нового PR выбрать **base: master**, **compare: feature/rag-document-diversity**. В нём будут только шесть файлов этого изменения. При проверке новой ветки роли 2 прямых пересечений с этими файлами не обнаружено; после обновления выполнены тесты и сборка общей версии.

Команды выполняет Матвей из `D:\Develop\study\hackathon\alfa-news-agent-current`:

```powershell
git status
git add server/retrieval.ts server/agent.ts server/integration/tests/retrieval-diversity.test.ts data/demo/rag/document_diversity_comparison.json docs/reports/RAG_DOCUMENT_DIVERSITY.md docs/integration/PR_RAG_DOCUMENT_DIVERSITY.md
git commit -m "Diversify bank retrieval results by document"
git push -u origin feature/rag-document-diversity
```

Затем открыть PR на GitHub с правильной base, как описано выше. Перед отправкой ещё раз проверить изменения команды. Код, коммиты и push чужой ветки не нужны.

## Заголовок PR

Diversify bank retrieval results by document

## Описание PR

При поиске банковской аналитики первые пять фрагментов могли относиться к одному PDF и вытеснять нужные документы. Сначала выдаётся лучший фрагмент каждого найденного документа, затем дополнительные фрагменты, не больше двух на страницу. Порядок сохраняется при увеличении limit; ID, даты, текст цитат и API-контракты сохранены. Обновлена версия кэша старого агента.

На прежних 28 development-запросах: hit@5 среди 26 запросов с доступной датированной целью вырос с 22/26 до 26/26, recall@5 — с 75,0% до 94,2%. Первый результат сохранился для всех запросов; два запроса к недатированному gold-документу остаются без доступной цели. Это проверка документов на небольшом известном наборе, не доказательство релевантности каждой цитаты или качества анализа.

Проверено на master 541c778: 155 тестов, typecheck, build; offline evaluation с проверкой дат, OCR-цитат и resolve. Сетевых и платных LLM-запросов в проверке нет. Отчёт: docs/reports/RAG_DOCUMENT_DIVERSITY.md; сравнение: data/demo/rag/document_diversity_comparison.json. Использует уже принятый #20 с оценкой поиска.
