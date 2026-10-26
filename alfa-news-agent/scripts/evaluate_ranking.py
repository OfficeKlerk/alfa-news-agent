#!/usr/bin/env python3
"""Оценка качества персонализированного ранжирования новостей.

Считает precision@k и nDCG@k по размеченному набору (labels.json) и выходу
ранжировщика (predictions.json), отдельно по каждой компании и в среднем.
Чистый stdlib, без сети и расхода LLM-бюджета.

Запуск:
    python demo/eval/evaluate.py \
        --labels demo/eval/labels.json \
        --predictions demo/eval/sample_predictions.json \
        --k 3

Форматы:
    labels.json       {"companies": {"<company_id>": {"<news_id>": gain0..3, ...}}}
    predictions.json  {"companies": {"<company_id>": ["<news_id>", ...]}}  # лучший первым
"""

import argparse
import json
import math
from pathlib import Path


def dcg(gains):
    """Discounted cumulative gain для списка выгод в порядке ранжирования."""
    return sum(g / math.log2(i + 2) for i, g in enumerate(gains))


def ndcg_at_k(ranked_news, relevance, k):
    """nDCG@k: 0..1, где 1 — идеальный порядок по убыванию релевантности."""
    gains = [relevance.get(n, 0) for n in ranked_news[:k]]
    ideal = sorted(relevance.values(), reverse=True)[:k]
    denom = dcg(ideal)
    return (dcg(gains) / denom) if denom else 0.0


def precision_at_k(ranked_news, relevance, k, threshold=1):
    """Доля действительно релевантных (gain>=threshold) среди top-k."""
    top = ranked_news[:k]
    if not top:
        return 0.0
    hits = sum(1 for n in top if relevance.get(n, 0) >= threshold)
    return hits / len(top)


def evaluate(labels, predictions, k, threshold=1):
    per_company = {}
    companies = labels["companies"]
    preds = predictions["companies"]
    for cid, relevance in companies.items():
        ranked = preds.get(cid)
        if not ranked:
            raise SystemExit(f"Нет предсказаний для компании {cid}")
        per_company[cid] = {
            "precision@k": round(precision_at_k(ranked, relevance, k, threshold), 4),
            "ndcg@k": round(ndcg_at_k(ranked, relevance, k), 4),
        }
    n = len(per_company) or 1
    macro = {
        "precision@k": round(sum(v["precision@k"] for v in per_company.values()) / n, 4),
        "ndcg@k": round(sum(v["ndcg@k"] for v in per_company.values()) / n, 4),
    }
    return {"k": k, "relevance_threshold": threshold, "per_company": per_company, "macro_average": macro}


def main():
    ap = argparse.ArgumentParser(description="Оценка персонализированного ранжирования новостей")
    ap.add_argument("--labels", required=True, type=Path)
    ap.add_argument("--predictions", required=True, type=Path)
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--threshold", type=int, default=1, help="Минимальный gain, считающийся релевантным для precision")
    args = ap.parse_args()

    labels = json.loads(args.labels.read_text(encoding="utf-8"))
    predictions = json.loads(args.predictions.read_text(encoding="utf-8"))
    report = evaluate(labels, predictions, args.k, args.threshold)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
