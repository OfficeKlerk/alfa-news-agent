#!/usr/bin/env python3
"""Reproduce the frozen personalization development audit without fitting weights.

First export both input views with extract_personalization_events.ts. Initial
graph reconstruction requires --database; later runs use --graph-snapshots and
the committed bounded exports, offline. Each event is scored at its own
publication time (age zero): a relevance-only scenario comparison, not backtest.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from evaluate_ranking import evaluate, dcg
from news_analysis.contracts import timestamp, validate_event
from news_analysis.features import extract_features, baseline_score, baseline_explain
from news_analysis.graph import PaymentGraph
from company_context import ContextStore


VARIANTS = {
    "curated_v1": ("curated", "before", "company_event_v1"),
    "curated_v2": ("curated", "after", "company_event_v2"),
    "articles_v1": ("articles", "before", "company_event_v1"),
    "articles_v2": ("articles", "after", "company_event_v2"),
}
EVENT_FIELDS = {"news_id", "event_id", "title", "text", "event_type", "published_at", "event_at", "fact_status",
                "okved_divisions", "countries", "regions", "company_ids", "entity_mapping_source", "sources", "is_mock",
                "split_group_id", "event_details"}
EVIDENCE_FIELDS = {"id", "kind", "title", "url", "excerpt", "document_id", "page", "published_at", "is_mock"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def value_sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line]


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_predictions(labels, predictions):
    require(set(predictions["companies"]) == set(labels["companies"]), "prediction company coverage mismatch")
    for cid, relevance in labels["companies"].items():
        ranked = predictions["companies"][cid]
        require(len(ranked) == len(set(ranked)) == len(relevance) and set(ranked) == set(relevance),
                f"missing/duplicate/unknown predictions for {cid}")


def validate_bundle(directory):
    spec = importlib.util.spec_from_file_location("personalization_frozen_validator", directory / "validate.py")
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    validator.validate(directory)


def load_exports(directory, curated_path, articles_path, labels):
    manifest = read(directory / "manifest.json")
    exports = {"curated": read(curated_path), "articles": read(articles_path)}
    expected = set(next(iter(labels["companies"].values())))
    for mode, export in exports.items():
        require(export["mode"] == mode and export["schema_version"] == "personalization_extraction_v1", "wrong extraction mode/version")
        require(export["input_sha256"] == manifest["files"]["events.json" if mode == "curated" else "articles.json"]["sha256"],
                f"extraction input hash mismatch: {mode}")
        require(export["extractor_sha256"] == sha(ROOT / "server/news-events.ts"), f"stale extractor output: rerun Node export for {mode}")
        require(export.get("taxonomy_sha256") == sha(ROOT / "server/news-subjects.ts"), f"stale taxonomy output: rerun Node export for {mode}")
        require(export["exporter_sha256"] == sha(ROOT / "scripts/extract_personalization_events.ts"), f"stale exporter output: {mode}")
        ids = [record["news_id"] for record in export["records"]]
        require(len(ids) == len(set(ids)) == len(expected) and set(ids) == expected, f"extraction matrix incomplete: {mode}")
        for record in export["records"]:
            for side in ("before", "after"):
                event = record[side]
                require(set(event) <= EVENT_FIELDS and all(set(source) == EVIDENCE_FIELDS for source in event["sources"]), "non-whitelisted event/source field")
                require(event["news_id"] == record["news_id"] and event["is_mock"] is False, "event identity/mock mismatch")
                require(all(source["kind"] == "news" and source["is_mock"] is False for source in event["sources"]), "invalid real-news evidence")
                validate_event(event)
                require(all(source["published_at"] is not None and timestamp(source["published_at"]) <= timestamp(event["published_at"])
                            for source in event["sources"]), "source unavailable at event assessment time")
            if mode == "articles":
                before = record["before"]
                require(before["event_type"] == "other" and "event_details" not in before and all(not before[field] for field in
                        ("okved_divisions", "countries", "regions", "company_ids")), "raw baseline leaked extracted metadata")
    return exports


def graph_snapshot_binding(directory, curated_path, articles_path):
    return {"profiles_sha256": sha(directory / "profiles.jsonl"), "frozen_graph_sha256": sha(directory / "graph_evidence.jsonl"),
            "event_inputs_sha256": {"curated": sha(curated_path), "articles": sha(articles_path)},
            "graph_engine_sha256": sha(ROOT / "news_analysis/graph.py"),
            "graph_dependencies_sha256": {"company_context/io.py": sha(ROOT / "company_context/io.py")}}


def load_or_build_graphs(directory, exports, profiles, binding, database=None, snapshots=None):
    if database:
        frozen = {(g["company_id"], g["event_id"]): g for g in rows(directory / "graph_evidence.jsonl")}
        result = {"schema_version": "personalization_graphs_v1", **binding, "variants": {key: [] for key in VARIANTS}}
        with ContextStore(database) as store:
            require(store.metadata["sources"] == read(directory / "manifest.json")["sources"], "database differs from frozen organizer source hashes")
            for cid in profiles:
                graph = PaymentGraph(store, cid)
                for name, (mode, side, version) in VARIANTS.items():
                    for record in exports[mode]["records"]:
                        event = record[side]
                        # Original curated v1 is explicitly the frozen baseline.
                        # Every other view is recomputed with its own dimensions;
                        # raw other/empty events cannot inherit curated matches.
                        exposure = frozen[(cid, event["event_id"])] if name == "curated_v1" else graph.exposure(event, evidence_limit=1000, feature_version=version)
                        result["variants"][name].append({"news_id": event["news_id"], "exposure": exposure})
    else:
        require(snapshots is not None and snapshots.is_file(), "Provide --database for initial graph export, or --graph-snapshots for an offline rerun")
        result = read(snapshots)
        require(result.get("schema_version") == "personalization_graphs_v1", "unsupported graph snapshot schema")
        require(all(result.get(key) == value for key, value in binding.items()), "graph snapshot hash/input binding mismatch; reconstruct with --database")
    if database:
        result["content_sha256"] = value_sha(result["variants"])
    require(result.get("content_sha256") == value_sha(result["variants"]), "graph snapshot content hash mismatch")
    require(set(result["variants"]) == set(VARIANTS), "graph variant coverage mismatch")
    lookup = {}
    for name, (mode, side, version) in VARIANTS.items():
        events = {record["news_id"]: record[side] for record in exports[mode]["records"]}
        expected = {(cid, nid) for cid in profiles for nid in events}
        stage = {}
        for row in result["variants"][name]:
            exposure = row["exposure"]
            key = (exposure["company_id"], row["news_id"])
            require(key not in stage and key in expected, "duplicate/unknown graph pair")
            require(exposure["event_id"] == events[row["news_id"]]["event_id"], "graph/event identity mismatch")
            if name == "articles_v1":
                require(all(exposure[d]["matched_share"] in (0, None) and exposure[d]["attribute_coverage_share"] in (0, None)
                            for d in ("in", "out")) and not exposure["related_company_matches"], "raw baseline graph leaked curated matches")
            stage[key] = exposure
        require(set(stage) == expected, "graph matrix incomplete")
        lookup[name] = stage
    return result, lookup


def tie_expected_metrics(scored, relevance, k, threshold=2):
    """Exact expectation under uniform permutations within equal-score blocks."""
    groups = []
    for row in scored:
        if not groups or groups[-1][0] != row["score"]:
            groups.append((row["score"], []))
        groups[-1][1].append(row)
    expected_dcg, expected_hits, position = 0.0, 0.0, 0
    for _, group in groups:
        gains = [relevance[row["news_id"]] for row in group]
        size = len(group)
        for i in range(position, min(position + size, k)):
            expected_dcg += (sum(gains) / size) / math.log2(i + 2)
            expected_hits += sum(value >= threshold for value in gains) / size
        position += size
    ideal = dcg(sorted(relevance.values(), reverse=True)[:k])
    positives = sum(value >= threshold for value in relevance.values())
    return {"ndcg@k": round(expected_dcg / ideal, 4) if ideal else 0.0,
            "precision@k": round(expected_hits / min(k, len(scored)), 4),
            "recall@k": round(expected_hits / positives, 4) if positives else None}


def score_variants(exports, profiles, graph_lookup, labels):
    results, metrics, predictions = {}, {}, {}
    for name, (mode, side, version) in VARIANTS.items():
        results[name], predictions[name] = {}, {"companies": {}}
        for cid, profile in profiles.items():
            scored = []
            for record in exports[mode]["records"]:
                event = record[side]
                features = extract_features(profile, event, event["published_at"], graph_lookup[name][(cid, event["news_id"])], feature_version=version)
                score = baseline_score(features["values"])
                require(math.isfinite(score), "nonfinite ranking score")
                scored.append({"news_id": event["news_id"], "event_id": event["event_id"], "title": event["title"],
                               "as_of": event["published_at"], "age_days": 0, "score": score, "score_kind": "untrained_baseline",
                               "feature_version": version, "features": features["values"],
                               "contributions": [{key: row[key] for key in ("feature", "value", "coefficient", "contribution")}
                                                 for row in baseline_explain(features)],
                               "label": labels["companies"][cid][event["news_id"]]})
            scored.sort(key=lambda row: (-row["score"], row["news_id"]))
            for i, row in enumerate(scored, 1):
                row["rank"] = i
            results[name][cid] = scored
            predictions[name]["companies"][cid] = [row["news_id"] for row in scored]
        validate_predictions(labels, predictions[name])
        metrics[name] = {}
        for k in (3, 5):
            result = evaluate(labels, predictions[name], k=k, threshold=2)
            for cid, relevance in labels["companies"].items():
                ranking = predictions[name]["companies"][cid]
                positives = {nid for nid, value in relevance.items() if value >= 2}
                row = result["per_company"][cid]
                row["recall@k"] = round(len(set(ranking[:k]) & positives) / len(positives), 4) if positives else None
                row["significant_total"] = len(positives)
                row["top_news_ids"] = ranking[:k]
                row["missed_significant"] = [nid for nid in ranking[k:] if nid in positives]
                row["irrelevant_high"] = [nid for nid in ranking[:k] if relevance[nid] == 0]
                row["tie_averaged"] = tie_expected_metrics(results[name][cid], relevance, k)
            recalls = [row["recall@k"] for row in result["per_company"].values() if row["recall@k"] is not None]
            result["macro_average"]["recall@k"] = round(sum(recalls) / len(recalls), 4) if recalls else None
            result["macro_tie_averaged"] = {}
            for metric in ("ndcg@k", "precision@k", "recall@k"):
                values = [row["tie_averaged"][metric] for row in result["per_company"].values() if row["tie_averaged"][metric] is not None]
                result["macro_tie_averaged"][metric] = round(sum(values) / len(values), 4) if values else None
            metrics[name][str(k)] = result
    return results, metrics, predictions


def comparisons(scored, labels):
    output = {}
    for mode in ("curated", "articles"):
        output[mode] = []
        for cid in labels["companies"]:
            before = {row["news_id"]: row for row in scored[mode + "_v1"][cid]}
            after = {row["news_id"]: row for row in scored[mode + "_v2"][cid]}
            for nid in sorted(before):
                left, right = before[nid], after[nid]
                output[mode].append({"company_id": cid, "news_id": nid, "title": left["title"], "label": left["label"],
                                     "rank_before": left["rank"], "rank_after": right["rank"], "rank_gain": left["rank"] - right["rank"],
                                     "score_before": left["score"], "score_after": right["score"],
                                     "changed_features": {key: {"before": left["features"].get(key), "after": value}
                                                          for key, value in right["features"].items() if left["features"].get(key) != value}})
    return output


def extraction_coverage(exports):
    result = {}
    for mode, export in exports.items():
        events = [record["after"] for record in export["records"]]
        details = [event.get("event_details", {}) for event in events]
        result[mode] = {"events_total": len(events), "events_with_details": sum(bool(row) for row in details),
                        "non_other_event_types": sum(event["event_type"] != "other" for event in events),
                        "known_direction": sum(row.get("direction", "unknown") != "unknown" for row in details),
                        "known_magnitude": sum(row.get("magnitude") is not None for row in details),
                        "literal_target_codes": sum(bool(row.get("target_okved_codes")) for row in details),
                        "inferred_subject_codes": sum(bool(row.get("subject_okved_codes")) for row in details),
                        "effective_date": sum(bool(row.get("effective_at")) for row in details)}
    return result


def render_report(path, report, comparison, scored):
    names = {"curated_v1": "Курированные события / v1", "curated_v2": "Те же события + извлечение / v2",
             "articles_v1": "Пересказы / прежний other", "articles_v2": "Пересказы / извлечение + v2"}
    lines = ["# Персонализация: сравнение до и после", "",
             "Сравнение 3 компаний × 13 исторических событий по 39 заранее замороженным AI-оценкам. "
             "Метки и коэффициенты при выполнении скрипта не изменяются; обучение не запускается.", "",
             "**Возраст каждой новости равен нулю**: она оценивается на собственную дату публикации с доступным снимком компании. "
             "Это изоляция предметной релевантности при ретроспективном сценарии, не хронологическая лента и не backtest. "
             "Дата наблюдения полей компаний неизвестна.", "",
             "Два отдельных сравнения: (1) исходные курированные типы/отрасли и добавленные только из текста event_details; "
             "(2) прежний RSS-вход other с пустыми измерениями против текущего извлечения. "
             "Во втором случае входы — фактические AI-пересказы реальных первоисточников, не полный оригинальный корпус статей.", "",
             "## Результат и оставшиеся ошибки", ""]
    significant = sum(row["label"] >= 2 for row in comparison["curated"])
    for mode in ("curated", "articles"):
        before = report["metrics"][mode + "_v1"]["3"]
        after = report["metrics"][mode + "_v2"]["3"]
        missing = sum(len(row["missed_significant"]) for row in after["per_company"].values())
        lines.append(f"- {mode}: NDCG@3 {before['macro_average']['ndcg@k']:.4f} → {after['macro_average']['ndcg@k']:.4f}; "
                     f"в top-3 после изменения попало {significant - missing} из {significant} значимых пар.")
    lines += ["", "| Проверяемый случай | Курированный вход: позиция до → после | Вход без тегов: позиция до → после | Что исправляется |",
              "|---|---:|---:|---|"]
    examples = [("U_34911", "fao_202609", "Зерновая тема сопоставляется с 46.21; сохранение ставки отделено от нового изменения."),
                ("U_99262", "fuel_exports_20260730", "Связь с топливными контрагентами сохраняется по узкому предмету вместо всего раздела оптовой торговли."),
                ("U_4909", "so_ups_equipment_rules_20260812", "Распознаётся тема генерирующего оборудования; юридическое участие в оптовом рынке остаётся неизвестным."),
                ("U_4909", "museum_moscow_20260625", "Совпадение города не повышает явно непрофильную выставку при известной отрасли компании.")]
    pair_lookup = {mode: {(row["company_id"], row["news_id"]): row for row in values} for mode, values in comparison.items()}
    for cid, nid, explanation in examples:
        if all((cid, nid) in pair_lookup[mode] for mode in ("curated", "articles")):
            first, second = (pair_lookup[mode][(cid, nid)] for mode in ("curated", "articles"))
            lines.append(f"| {cid}: {nid} | {first['rank_before']} → {first['rank_after']} | {second['rank_before']} → {second['rank_after']} | {explanation} |")
    bad_counts = {mode: sum(len(row["irrelevant_high"]) for row in report["metrics"][mode + "_v2"]["3"]["per_company"].values())
                  for mode in ("curated", "articles")}
    lines += ["", "Покрытие значимых событий не означает, что весь порядок корректен. "
              f"После изменения среди девяти суммарных позиций top-3 осталось {bad_counts['curated']} элементов с оценкой 0 "
              f"для курированного входа и {bad_counts['articles']} для входа без тегов. Ниже перечислены все такие попадания. "
              "Сведения ФТС и страны контрагентов не подтверждают резидентство или наличные валютные операции. "
              "Эти условия ещё требуют самостоятельных признаков и подтверждённых данных; веса ради этой таблицы не подгонялись.", "",
              "В исходном raw-входе все 13 баллов равны; его позиции — служебная сортировка по ID. "
              "Поэтому результат дополнительно оценивается с усреднением внутри ничьих, а движение из такой позиции "
              "не трактуется как измеренная уверенность прежней модели.", "",
             "## Метрики", "",
             "NDCG использует линейную выгоду 0–3 из существующего `scripts/evaluate_ranking.py`. "
             "Значимая новость для precision/recall — оценка ≥2. Усреднение по компаниям равновесное. "
             "У компаний всего 2, 2 и 1 значимых события: даже идеальный precision@5 здесь ограничен числом таких событий.", "",
             "| Вариант | k | NDCG | Precision | Recall | NDCG с усреднением ничьих |", "|---|---:|---:|---:|---:|---:|"]
    for name in VARIANTS:
        for k in ("3", "5"):
            row = report["metrics"][name][k]
            m = row["macro_average"]
            lines.append(f"| {names[name]} | {k} | {m['ndcg@k']:.4f} | {m['precision@k']:.4f} | {m['recall@k']:.4f} | {row['macro_tie_averaged']['ndcg@k']:.4f} |")
    lines += ["", "При одинаковом балле порядок определяется `news_id`, а не смыслом новости. "
              "Последняя колонка — точное ожидаемое значение при случайной перестановке внутри каждого блока равных баллов; "
              "это устраняет эффект удачного алфавитного порядка. Доверительные интервалы и статистическая значимость не заявляются.", "",
              "## Покрытие извлечения", "",
              "Это число заполненных полей, а не точность классификатора. Выведенные по теме коды отраслей "
              "отличаются от буквально указанных в источнике кодов и не подтверждают юридическую применимость нормы.", "",
              "| Вход | Событий | С деталями | Тип известен | Изменение/сохранение | Величина | Буквальные коды | Выведенная тема | Дата действия |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for mode, coverage in report["extraction_coverage"].items():
        values = [coverage[key] for key in ("events_total", "events_with_details", "non_other_event_types", "known_direction",
                                          "known_magnitude", "literal_target_codes", "inferred_subject_codes", "effective_date")]
        lines.append("| " + mode + " | " + " | ".join(str(value) for value in values) + " |")
    lines += ["",
              "## Ошибки в первых трёх позициях", "", "| Вариант | Компания | Top-3 (оценки) | Значимые вне top-3 | Нерелевантные в top-3 |",
              "|---|---|---|---|---|"]
    for name in VARIANTS:
        for cid, metrics in report["metrics"][name]["3"]["per_company"].items():
            top = "; ".join(f"{row['news_id']} ({row['label']})" for row in scored[name][cid][:3])
            lines.append(f"| {names[name]} | {cid} | {top} | {', '.join(metrics['missed_significant']) or '—'} | {', '.join(metrics['irrelevant_high']) or '—'} |")
    lines += ["", "## Изменение позиций каждой пары", "",
              "Оценки не подбирались по этим результатам. Повышение позиции при одинаковом балле само по себе не означает улучшения персонализации.", ""]
    for mode in ("curated", "articles"):
        lines += ["### " + ("Курированный вход" if mode == "curated" else "Вход из пересказов без тегов"), "",
                  "| Компания | Новость | Оценка | Позиция до → после | Балл до → после |", "|---|---|---:|---:|---:|"]
        for row in comparison[mode]:
            lines.append(f"| {row['company_id']} | {row['news_id']} | {row['label']} | {row['rank_before']} → {row['rank_after']} | {row['score_before']:.4f} → {row['score_after']:.4f} |")
    lines += ["", "## Ограничения и воспроизведение", "",
              "Исходная таблица и обоснования: [PERSONALIZATION_LABELS.md](PERSONALIZATION_LABELS.md). "
              "Человеческая проверка исходных меток отсутствует. Второй AI-проход не превращает их в экспертный gold. "
              "Набор использован для поиска ошибок и разработки; улучшение на нём не измеряет перенос на новые компании/события. "
              "Некоторые нормы и компании зависимы; адресные события о членах обезличенной группы не покрыты.", "",
              "Графы для raw-входа и v2 пересчитаны по соответствующим полям событий. "
              "Raw other не наследует отраслевые совпадения курированного входа. "
              "Снимки графа привязаны хешами к профилям, извлечению и реализации графа; повторный прогон возможен без исходной SQLite.", "",
              "```bash",
              "node --import tsx scripts/extract_personalization_events.ts --mode curated --input data/personalization/events.json --out data/personalization/evaluation/curated_extracted.json",
              "node --import tsx scripts/extract_personalization_events.ts --mode articles --input data/personalization/articles.json --out data/personalization/evaluation/articles_extracted.json",
              "python scripts/evaluate_personalization.py --input data/personalization --out data/personalization/evaluation --graph-snapshots data/personalization/evaluation/graph_snapshots.json --report docs/reports/PERSONALIZATION_COMPARISON.md",
              "```", "",
              "При изменении извлечения/правил графа пересоберите снимки: вместо `--graph-snapshots` укажите "
              "`--database data/processed/company_context.sqlite` с полной исходной базой, соответствующей сохранённым хешам. "
              "Маленькая база синтетических компаний для CI будет отклонена.", "",
              "Машиночитаемые результаты: `data/personalization/evaluation/metrics.json`, `scores.json`, "
              "`predictions.json`, `comparison.json`, `graph_snapshots.json`. В метриках записаны хеши исходных меток и кода; "
              "несовпадающий или неполный набор отклоняется.", ""]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def run(args):
    directory, output = args.input.resolve(), args.out.resolve()
    validate_bundle(directory)
    labels = {"companies": {}}
    for row in rows(directory / "labels.jsonl"):
        labels["companies"].setdefault(row["company_id"], {})[row["news_id"]] = row["label"]
    profiles = {row["company_id"]: row for row in rows(directory / "profiles.jsonl")}
    curated = args.curated or directory / "evaluation/curated_extracted.json"
    articles = args.articles or directory / "evaluation/articles_extracted.json"
    exports = load_exports(directory, curated, articles, labels)
    binding = graph_snapshot_binding(directory, curated, articles)
    graph_dump, graph_lookup = load_or_build_graphs(directory, exports, profiles, binding, args.database, args.graph_snapshots)
    scored, metrics, predictions = score_variants(exports, profiles, graph_lookup, labels)
    comparison = comparisons(scored, labels)
    report = {"schema_version": "personalization_comparison_v1", "labels_sha256": sha(directory / "labels.jsonl"),
              "feature_code_sha256": sha(ROOT / "news_analysis/features.py"), "evaluator_sha256": sha(Path(__file__)),
              "extraction_code_sha256": sha(ROOT / "server/news-events.ts"), "graph_binding": binding,
              "taxonomy_code_sha256": sha(ROOT / "server/news-subjects.ts"),
              "graph_content_sha256": graph_dump["content_sha256"],
              "assessment": "each event at its own publication time, age=0, retrospective current-profile scenario; not historical backtest",
              "dataset_usage": "development_audit_not_holdout", "label_origin": "ai", "human_reviewed_pairs": 0,
              "metrics": metrics, "extraction_coverage": extraction_coverage(exports), "tie_break": "score descending, then news_id ascending",
              "score_ties": {name: {cid: {"unique_scores": len({row['score'] for row in data}), "candidate_count": len(data)}
                                    for cid, data in companies.items()} for name, companies in scored.items()}}
    write(output / "graph_snapshots.json", graph_dump)
    write(output / "scores.json", scored)
    write(output / "metrics.json", report)
    write(output / "predictions.json", predictions)
    write(output / "comparison.json", comparison)
    if args.report:
        render_report(args.report, report, comparison, scored)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data/personalization")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--curated", type=Path)
    parser.add_argument("--articles", type=Path)
    graph = parser.add_mutually_exclusive_group(required=True)
    graph.add_argument("--database", help="Full organizer snapshot matching frozen source hashes")
    graph.add_argument("--graph-snapshots", type=Path, help="Bound graph exports for offline reproduction")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        report = run(args)
    except (ValueError, KeyError, IndexError, TypeError, OSError) as error:
        parser.exit(1, f"Personalization audit failed: {error}\n")
    print(json.dumps({name: {k: value["macro_average"] for k, value in stage.items()} for name, stage in report["metrics"].items()}, indent=2))


if __name__ == "__main__":
    main()
