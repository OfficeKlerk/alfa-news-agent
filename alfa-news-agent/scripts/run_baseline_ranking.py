#!/usr/bin/env python3
"""Прогон baseline-ранжировщика news_analysis на наборе новостей → predictions.json.

Берёт профиль из company_context (SQLite) и ранжирует события через
news_analysis.analyze_news (baseline, без обученной модели). Результат — порядок
news_id на каждую компанию, готовый для scripts/evaluate_ranking.py.

Сеть и LLM не используются, бюджет не тратится.

Запуск (из корня репозитория):
    python scripts/run_baseline_ranking.py \
        --database var/context-real.sqlite3 \
        --news data/demo/demo_news.json \
        --out data/demo/eval/baseline_predictions.json \
        --companies U_34911 U_99262 U_4909

Требует импортируемых пакетов company_context и news_analysis (запуск из корня).
"""

import argparse
import json
import sys
from pathlib import Path

# Корень репозитория (каталог с пакетами) может быть не в sys.path, если скрипт
# запущен из scripts/. Находим каталог, содержащий company_context, и добавляем.
_here = Path(__file__).resolve()
for _root in [_here.parent, *_here.parents]:
    if (_root / "company_context").is_dir() and (_root / "news_analysis").is_dir():
        if str(_root) not in sys.path:
            sys.path.insert(0, str(_root))
        break

from company_context import ContextStore
from news_analysis import analyze_news

DEFAULT_COMPANIES = ["U_34911", "U_99262", "U_4909"]


def main():
    ap = argparse.ArgumentParser(description="Baseline ranking → predictions.json")
    ap.add_argument("--database", required=True)
    ap.add_argument("--news", required=True, help="demo_news.json ({as_of, events:[Event,...]})")
    ap.add_argument("--out", required=True, help="куда писать predictions.json")
    ap.add_argument("--scores-out", help="опционально: сырые score по новостям")
    ap.add_argument("--companies", nargs="+", default=DEFAULT_COMPANIES)
    ap.add_argument("--limit", type=int, default=100)
    args = ap.parse_args()

    news = json.loads(Path(args.news).read_text(encoding="utf-8"))
    events, as_of = news["events"], news["as_of"]
    preds = {"_source": "news_analysis.analyze_news baseline (no trained model)", "companies": {}}
    scores = {}
    with ContextStore(args.database) as store:
        for cid in args.companies:
            result = analyze_news(store, cid, events, as_of, limit=args.limit)
            preds["companies"][cid] = [c["news_id"] for c in result["cards"]]  # отсортировано по score desc
            scores[cid] = [{"news_id": c["news_id"], "score": round(c["score"], 4),
                            "score_kind": c["score_kind"]} for c in result["cards"]]

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(preds, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.scores_out:
        Path(args.scores_out).write_text(json.dumps(scores, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for cid in args.companies:
        print(f"{cid}: {preds['companies'][cid]}")


if __name__ == "__main__":
    main()
