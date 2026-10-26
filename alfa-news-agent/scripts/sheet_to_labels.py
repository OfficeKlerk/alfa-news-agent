#!/usr/bin/env python3
"""Конвертер: заполненный лист разметки (CSV) → labels.json для evaluate_ranking.py.

Вход: CSV со столбцами company_id, news_id, relevance (0..3) [, notes].
Выход: labels.json вида {"companies": {company_id: {news_id: gain}}}.

Проверяет, что оценки — целые 0..3 и что нет пропусков/дублей пар. Так ручная
разметка (независимая от ранжировщика) превращается в эталон для метрик.

Запуск:
    python scripts/sheet_to_labels.py --sheet data/demo/eval/annotation_sheet.csv --out data/demo/eval/labels.json
"""

import argparse
import csv
import json
from pathlib import Path

VALID = {"0", "1", "2", "3"}


def convert(sheet_path: Path):
    companies = {}
    errors = []
    seen = set()
    with sheet_path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        required = {"company_id", "news_id", "relevance"}
        missing_cols = required - set(reader.fieldnames or [])
        if missing_cols:
            raise SystemExit(f"В CSV нет столбцов: {', '.join(sorted(missing_cols))}")
        for i, row in enumerate(reader, 2):
            cid = (row.get("company_id") or "").strip()
            nid = (row.get("news_id") or "").strip()
            rel = (row.get("relevance") or "").strip()
            if not cid or not nid:
                errors.append(f"строка {i}: пустой company_id или news_id")
                continue
            if (cid, nid) in seen:
                errors.append(f"строка {i}: дубль пары {cid}/{nid}")
                continue
            seen.add((cid, nid))
            if rel not in VALID:
                errors.append(f"строка {i}: relevance '{rel}' не из 0..3 (пара {cid}/{nid})")
                continue
            companies.setdefault(cid, {})[nid] = int(rel)
    if errors:
        raise SystemExit("Ошибки разметки:\n  " + "\n  ".join(errors))
    return {"scale": "0=нерелевантно,1=слабо,2=заметно,3=высоко", "companies": companies}


def main():
    ap = argparse.ArgumentParser(description="CSV разметки → labels.json")
    ap.add_argument("--sheet", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    labels = convert(args.sheet)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(labels, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pairs = sum(len(v) for v in labels["companies"].values())
    print(f"OK: {len(labels['companies'])} компаний, {pairs} размеченных пар → {args.out}")


if __name__ == "__main__":
    main()
