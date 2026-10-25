#!/usr/bin/env python3
"""Референс-ретривер по корпусу аналитики банка (BM25, чистый stdlib).

Назначение — baseline для оценки RAG: лексический поиск по OCR-тексту корпуса
(`data/research.json`, 64 страницы / 9 документов). Это НЕ продакшен-поиск, а
воспроизводимая нижняя планка, которую должен побить векторный/гибридный поиск
роли 3 (R3-05). Сеть и LLM не используются.

Выдаёт на каждый запрос ранжированный список документов (по лучшему чанку).

Запуск:
    python scripts/rag_reference_retriever.py \
        --corpus data/research.json \
        --queries data/demo/rag/queries.json \
        --out data/demo/rag/reference_retrieval.json --k 5
"""

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path

STOP = {
    "и","в","во","не","что","он","на","я","с","со","как","а","то","все","она","так",
    "его","но","да","ты","к","у","же","вы","за","бы","по","только","ее","мне","было",
    "вот","от","меня","о","из","ему","теперь","для","мы","тебя","их","чем","была","сам",
    "чтобы","без","до","вам","ну","ли","если","или","об","при","над","этот","эта","это",
    "эти","тот","та","те","года","год","стр","млрд","млн",
}


def tokenize(text):
    text = text.lower().replace("ё", "е")
    tokens = re.findall(r"[а-яa-z0-9]+", text)
    return [t for t in tokens if len(t) > 2 and t not in STOP]


class BM25:
    """Минимальный BM25 (k1=1.5, b=0.75) над списком документов-токенов."""

    def __init__(self, docs_tokens, k1=1.5, b=0.75):
        self.k1, self.b = k1, b
        self.docs = docs_tokens
        self.N = len(docs_tokens)
        self.avgdl = sum(len(d) for d in docs_tokens) / self.N if self.N else 0
        self.df = Counter()
        for d in docs_tokens:
            for t in set(d):
                self.df[t] += 1
        self.tf = [Counter(d) for d in docs_tokens]

    def idf(self, term):
        n = self.df.get(term, 0)
        return max(0.0, math.log((self.N - n + 0.5) / (n + 0.5) + 1))

    def score(self, query_tokens, i):
        dl = len(self.docs[i]) or 1
        s = 0.0
        for t in query_tokens:
            f = self.tf[i].get(t, 0)
            if not f:
                continue
            s += self.idf(t) * (f * (self.k1 + 1)) / (f + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
        return s


def main():
    ap = argparse.ArgumentParser(description="BM25 reference retriever over bank corpus")
    ap.add_argument("--corpus", required=True, type=Path, help="research.json (chunks)")
    ap.add_argument("--queries", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--k", type=int, default=5)
    args = ap.parse_args()

    chunks = json.loads(args.corpus.read_text(encoding="utf-8"))
    docs_tokens = [tokenize(c.get("text", "")) for c in chunks]
    bm25 = BM25(docs_tokens)
    queries = json.loads(args.queries.read_text(encoding="utf-8"))["queries"]

    result = {"_retriever": "bm25_lexical_reference", "k": args.k, "queries": {}}
    for q in queries:
        qt = tokenize(q["query"])
        scored = sorted(((bm25.score(qt, i), i) for i in range(len(chunks))), key=lambda x: -x[0])
        best_by_doc = {}
        for sc, i in scored:
            c = chunks[i]
            fn = c["filename"]
            if fn not in best_by_doc or sc > best_by_doc[fn]["score"]:
                best_by_doc[fn] = {"filename": fn, "document_id": c["document_id"],
                                   "page": c["page"], "score": round(sc, 3)}
        ranked = sorted(best_by_doc.values(), key=lambda d: -d["score"])[:args.k]
        result["queries"][q["id"]] = ranked

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK: {len(queries)} запросов, топ-{args.k} документов → {args.out}")
    for qid, ranked in result["queries"].items():
        print(f"  {qid}: {[r['filename'] for r in ranked]}")


if __name__ == "__main__":
    main()
