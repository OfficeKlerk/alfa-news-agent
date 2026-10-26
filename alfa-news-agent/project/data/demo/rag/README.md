# RAG retrieval eval — оценка поиска по аналитике банка

Аддитивный харнесс для измерения качества RAG-ретрива (пробел R3-05 / `MONITORING.md`). Работает на реальном OCR-корпусе банка (`data/research.json`), офлайн, без LLM-бюджета. Ядро роли 3 (`server/retrieval.ts`) не затрагивается — это независимая метрика и reference baseline.

## Файлы и пути в репозитории (для PR)

| Здесь | Путь в репозитории | Назначение |
|---|---|---|
| `demo/rag/rag_reference_retriever.py` | `scripts/rag_reference_retriever.py` | BM25-ретривер (reference baseline) |
| `demo/rag/evaluate_retrieval.py` | `scripts/evaluate_retrieval.py` | hit@k / recall@k / MRR |
| `demo/rag/queries.json` | `data/demo/rag/queries.json` | 12 проверяемых запросов + ожидаемые документы |
| `demo/rag/corpus_manifest.json` | `data/demo/rag/corpus_manifest.json` | 9 документов корпуса: даты, страницы, ID |
| `demo/rag/reference_retrieval.json` | `data/demo/rag/reference_retrieval.json` | выход BM25 (топ-5 на запрос) |
| `demo/rag/retrieval_report.md` | `docs/RETRIEVAL_REPORT.md` | реальные числа + инсайты |

## Запуск (офлайн)

```bash
python scripts/rag_reference_retriever.py --corpus data/research.json \
  --queries data/demo/rag/queries.json --out data/demo/rag/reference_retrieval.json --k 5
python scripts/evaluate_retrieval.py --queries data/demo/rag/queries.json \
  --retrieval data/demo/rag/reference_retrieval.json --k 3
```

## Результат baseline (BM25)

hit@3 = 0.92 · recall@3 = 0.88 · hit@5 = 1.00 · hit@1 = 0.58. Подробности и провалы — `retrieval_report.md`.

## Для роли 3

Это **цель-метрика**: векторный/гибридный поиск (R3-05) прогоняется этим же `evaluate_retrieval.py` — достаточно привести его выход к формату `reference_retrieval.json` (`{queries:{qid:[{filename,...}]}}`). Baseline-числа — то, что надо побить (особенно hit@1).
