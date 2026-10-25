#!/usr/bin/env python3
"""Оценка качества RAG-ретрива по корпусу аналитики банка.

Считает hit-rate@k, recall@k и MRR по размеченным запросам (queries.json) и
выходу ретривера (reference_retrieval.json). Отдельно по запросам и в среднем.
Чистый stdlib, без сети. Закрывает пробел MONITORING.md («retrieval hit-rate»).

Запуск:
    python scripts/evaluate_retrieval.py \
        --queries data/demo/rag/queries.json \
        --retrieval data/demo/rag/reference_retrieval.json --k 3

Метрики:
    hit@k   — хотя бы один ожидаемый документ попал в топ-k (доля запросов)
    recall@k— доля ожидаемых документов, найденных в топ-k (усреднённая)
    MRR     — средний обратный ранг первого ожидаемого документа
"""

import argparse
import json
from pathlib import Path


def rr(ranked_files, expected):
    """Reciprocal rank первого ожидаемого документа (0, если нет)."""
    for i, fn in enumerate(ranked_files, 1):
        if fn in expected:
            return 1.0 / i
    return 0.0


def evaluate(queries, retrieval, k):
    per = {}
    ranked_by_q = retrieval["queries"]
    for q in queries["queries"]:
        qid = q["id"]
        expected = set(q["expected"])
        ranked = [r["filename"] for r in ranked_by_q.get(qid, [])][:k]
        hit = 1.0 if expected & set(ranked) else 0.0
        recall = len(expected & set(ranked)) / len(expected) if expected else 0.0
        per[qid] = {"hit@k": hit, "recall@k": round(recall, 3),
                    "rr": round(rr([r["filename"] for r in ranked_by_q.get(qid, [])], expected), 3),
                    "top": ranked, "expected": sorted(expected)}
    n = len(per) or 1
    macro = {
        "hit@k": round(sum(v["hit@k"] for v in per.values()) / n, 3),
        "recall@k": round(sum(v["recall@k"] for v in per.values()) / n, 3),
        "mrr": round(sum(v["rr"] for v in per.values()) / n, 3),
    }
    return {"k": k, "n_queries": len(per), "macro": macro, "per_query": per}


def main():
    ap = argparse.ArgumentParser(description="Evaluate RAG retrieval quality")
    ap.add_argument("--queries", required=True, type=Path)
    ap.add_argument("--retrieval", required=True, type=Path)
    ap.add_argument("--k", type=int, default=3)
    args = ap.parse_args()
    queries = json.loads(args.queries.read_text(encoding="utf-8"))
    retrieval = json.loads(args.retrieval.read_text(encoding="utf-8"))
    print(json.dumps(evaluate(queries, retrieval, args.k), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
