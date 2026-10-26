"""Small L2 logistic ranker with JSON artifacts; standard library only."""

import hashlib
import json
import math
from collections import defaultdict
from .contracts import finite, text, timestamp
from .features import FEATURE_VERSION, baseline_score, feature_names, infer_feature_version
from .evidence import assert_training_eligible


def sigmoid(z):
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    ez = math.exp(z)
    return ez / (1 + ez)


def vector(values, feature_version=None):
    names = feature_names(feature_version or infer_feature_version(values))
    if not isinstance(values, dict) or set(values) != set(names):
        raise ValueError("Feature names do not match the model contract")
    return [finite(values[name], name, 0, 1) for name in names]


class LogisticRanker:
    def __init__(self, coefficients, intercept, metadata=None, feature_version=FEATURE_VERSION):
        self.feature_version = feature_version
        self.feature_names = feature_names(feature_version)
        if len(coefficients) != len(self.feature_names):
            raise ValueError("Wrong number of coefficients")
        self.coefficients = [finite(w, "coefficient") for w in coefficients]
        self.intercept = finite(intercept, "intercept")
        self.metadata = metadata or {}

    def predict(self, values):
        return sigmoid(self.intercept + sum(w * x for w, x in zip(self.coefficients, vector(values, self.feature_version))))

    def explain(self, features):
        if features.get("version") != self.feature_version:
            raise ValueError("Explanation feature version differs from the model")
        xs = vector(features["values"], self.feature_version)
        return sorted([
            {"feature": name, "value": x, "coefficient": w, "logit_contribution": w * x,
             "contribution": w * x, "scale": "logit",
             "evidence": features["evidence"][name]}
            for name, x, w in zip(self.feature_names, xs, self.coefficients) if x != 0
        ], key=lambda row: (-abs(row["logit_contribution"]), row["feature"]))

    def to_dict(self):
        return {"model_type": "l2_logistic_relevance", "schema_version": "1.0",
                "feature_version": self.feature_version, "feature_names": list(self.feature_names),
                "coefficients": self.coefficients, "intercept": self.intercept,
                "metadata": self.metadata, "score_meaning": "uncalibrated_relevance_score_not_business_loss_probability"}

    @classmethod
    def from_dict(cls, data):
        if (data.get("model_type") != "l2_logistic_relevance" or data.get("schema_version") != "1.0"
                or data.get("feature_names") != list(feature_names(data.get("feature_version")))):
            raise ValueError("Unsupported ranker artifact")
        return cls(data["coefficients"], data["intercept"], data.get("metadata"), data["feature_version"])


def fit(rows, l2=0.01, iterations=600, tolerance=1e-7):
    """Minimize mean binary log-loss + l2/2 * ||w||²; intercept is unpenalized.

    All input features are bounded to [0, 1]. Backtracking ensures decreasing loss.
    Labels >=2 are positive; labels 0/1 are negative. No pseudo-label generation.
    """
    finite(l2, "l2", 0)
    finite(tolerance, "tolerance", 1e-12, 1)
    if not isinstance(iterations, int) or isinstance(iterations, bool) or not 1 <= iterations <= 10000:
        raise ValueError("iterations must be 1..10000")
    feature_version = validate_rows(rows)
    assert_training_eligible(rows)
    x = [vector(row["features"], feature_version) for row in rows]
    y = [int(row["label"] >= 2) for row in rows]
    if set(y) != {0, 1}:
        raise ValueError("Training requires both important and non-important examples")
    n, d = len(x), len(feature_names(feature_version))
    p = sum(y) / n
    w, b = [0.0] * d, math.log(p / (1 - p))

    def loss(weights, bias):
        total = 0.0
        for values, label in zip(x, y):
            z = bias + sum(a * v for a, v in zip(weights, values))
            total += max(z, 0) + math.log1p(math.exp(-abs(z))) - label * z
        return total / n + l2 * sum(a * a for a in weights) / 2

    previous = loss(w, b)
    converged = False
    for epoch in range(iterations):
        grad, bias_grad = [0.0] * d, 0.0
        for values, label in zip(x, y):
            error = sigmoid(b + sum(a * v for a, v in zip(w, values))) - label
            bias_grad += error / n
            for i, value in enumerate(values):
                grad[i] += error * value / n
        grad = [g + l2 * a for g, a in zip(grad, w)]
        norm = bias_grad ** 2 + sum(g * g for g in grad)
        if norm ** 0.5 < tolerance:
            converged = True
            break
        step = 4.0
        while step > 1e-10:
            candidate = [a - step * g for a, g in zip(w, grad)]
            bias = b - step * bias_grad
            value = loss(candidate, bias)
            if value <= previous - 1e-4 * step * norm:
                break
            step /= 2
        else:
            break
        w, b, previous = candidate, bias, value
    return LogisticRanker(w, b, {"l2": l2, "iterations": epoch + 1, "converged": converged,
                                  "objective": previous, "positive_label_minimum": 2}, feature_version)


def validate_rows(rows):
    if not isinstance(rows, (list, tuple)) or not rows:
        raise ValueError("Empty training dataset")
    pairs = set()
    feature_version = None
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each training row must be an object")
        for key in ("company_id", "event_id", "query_id"):
            text(row.get(key), key)
        timestamp(row.get("published_at"))
        version = row.get("feature_version")
        feature_names(version)
        if feature_version is not None and version != feature_version:
            raise ValueError("Mixed feature versions require separate training datasets")
        feature_version = version
        if row.get("label_origin") not in {"human", "ai", "synthetic"}:
            raise ValueError("label_origin must be human, ai or synthetic")
        if row["label_origin"] == "ai":
            for key in ("annotator", "rubric_version", "annotation_reason"):
                text(row.get(key), key)
        if isinstance(row.get("label"), bool) or row.get("label") not in (0, 1, 2, 3):
            raise ValueError("Each row needs a relevance label 0, 1, 2 or 3")
        key = (row["company_id"], row["event_id"], row["query_id"])
        if key in pairs:
            raise ValueError("Duplicate company/event/query training example")
        pairs.add(key)
        if not isinstance(row.get("features"), dict):
            raise ValueError("features must be an object")
        vector(row["features"], feature_version)
    return feature_version


def temporal_split(rows):
    """Keep events and supplied policy clusters together across all companies.

    A cluster's latest publication defines its temporal position. Different
    clauses of one policy cannot be split merely because they have different IDs.
    """
    latest = {}
    event_groups = {}
    for row in rows:
        event = row["event_id"]
        group = text(row.get("split_group_id", event), "split_group_id")
        if event in event_groups and event_groups[event] != group:
            raise ValueError("Inconsistent split group for an event")
        event_groups[event] = group
        latest[group] = max(latest.get(group, timestamp(row["published_at"])), timestamp(row["published_at"]))
    if len(latest) < 10:
        raise ValueError("Need at least 10 distinct event clusters for train/validation/test")
    events = sorted(latest, key=lambda event: (latest[event], event))
    cut1, cut2 = max(1, int(len(events) * .6)), int(len(events) * .8)
    groups = [set(events[:cut1]), set(events[cut1:cut2]), set(events[cut2:])]
    return [[row for row in rows if event_groups[row["event_id"]] in group] for group in groups]


def evaluate(rows, score, k=5):
    if not isinstance(k, int) or isinstance(k, bool) or k < 1:
        raise ValueError("k must be positive")
    if not rows:
        return {"queries": 0, "rows": 0, "precision_at_k": None, "ndcg_at_k": None}
    # Evaluation helpers also accept compact rows without annotation metadata,
    # but they may never combine feature spaces within one reported metric.
    versions = {infer_feature_version(row["features"]) for row in rows}
    if len(versions) != 1 or any(row.get("feature_version", next(iter(versions))) not in versions for row in rows):
        raise ValueError("Mixed or mismatched feature versions in evaluation")
    groups = defaultdict(list)
    for row in rows:
        groups[row["query_id"]].append((score(row["features"]), row["label"], row["event_id"]))
    precision, ndcg = [], []
    for group in groups.values():
        ranked = sorted(group, key=lambda item: (-item[0], item[2]))[:k]
        ideal = sorted((item[1] for item in group), reverse=True)[:k]
        dcg = sum((2 ** item[1] - 1) / math.log2(i + 2) for i, item in enumerate(ranked))
        idcg = sum((2 ** label - 1) / math.log2(i + 2) for i, label in enumerate(ideal))
        precision.append(sum(item[1] >= 2 for item in ranked) / len(ranked))
        ndcg.append(dcg / idcg if idcg else 0.0)
    return {"queries": len(groups), "rows": len(rows), "k": k,
            "precision_at_k": sum(precision) / len(precision), "ndcg_at_k": sum(ndcg) / len(ndcg),
            "precision_denominator": "min(k, query_size)", "no_relevant_query_ndcg": 0}


def train_ranker(rows, penalties=(.001, .01, .1), iterations=600, holdout_companies=()):
    """Tune on validation, report test separately. Never select a model on test."""
    validate_rows(rows)
    assert_training_eligible(rows)
    if not penalties:
        raise ValueError("At least one L2 candidate is required")
    origins = sorted({row["label_origin"] for row in rows})
    if len(origins) != 1:
        raise ValueError("Do not mix human, AI and synthetic labels in the same training run")
    holdout = set(holdout_companies)
    unknown = holdout - {row["company_id"] for row in rows}
    if unknown:
        raise ValueError("Unknown holdout companies: " + ", ".join(sorted(unknown)))
    frozen = any("dataset_split" in row for row in rows)
    if frozen:
        names = {"train", "validation", "test", "unseen_company_test", "reserved_company_history"}
        if any(row.get("dataset_split") not in names for row in rows):
            raise ValueError("Every row must have a valid frozen dataset_split")
        fixed_holdout = {r["company_id"] for r in rows if r["dataset_split"] in {"unseen_company_test", "reserved_company_history"}}
        seen = {r["company_id"] for r in rows if r["dataset_split"] in {"train", "validation", "test"}}
        if seen & fixed_holdout or (holdout and holdout != fixed_holdout):
            raise ValueError("Company holdout conflicts with frozen dataset_split")
        holdout = fixed_holdout
        train, validation, test = [[r for r in rows if r["dataset_split"] == name]
                                    for name in ("train", "validation", "test")]
        groups = [{r.get("split_group_id", r["event_id"]) for r in part} for part in (train, validation, test)]
        events = [{r["event_id"] for r in part} for part in (train, validation, test)]
        if any(groups[i] & groups[j] or events[i] & events[j] for i,j in ((0,1),(0,2),(1,2))):
            raise ValueError("Event/policy leakage in frozen dataset_split")
    else:
        pool = [row for row in rows if row["company_id"] not in holdout]
        train, validation, test = temporal_split(pool)
    if not train or not validation or not test:
        raise ValueError("Nonempty train, validation and test are required; never repartition reviewed subsets")
    candidates = []
    for l2 in penalties:
        model = fit(train, l2, iterations)
        metrics = evaluate(validation, model.predict)
        candidates.append((metrics["ndcg_at_k"], l2, metrics))
    best = max(candidates, key=lambda item: (item[0], item[1]))
    model = fit(train + validation, best[1], iterations)
    checksum = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    baseline = evaluate(test, baseline_score)
    trained = evaluate(test, model.predict)
    model.metadata.update({"label_origin": origins[0], "dataset_sha256": checksum,
                           "fit_rows": len(train) + len(validation), "event_count": len({r["event_id"] for r in train + validation})})
    report = {
        "label_origin": origins[0], "dataset_sha256": checksum, "selected_l2": best[1],
        "evaluation_status": "provisional_ai_agreement" if origins[0] == "ai" else "independence_not_verified",
        "split": {"method": "frozen_dataset_split" if frozen else "chronological_whole_event_clusters_60_20_20",
                  "train_events": sorted({r["event_id"] for r in train}),
                  "validation_events": sorted({r["event_id"] for r in validation}),
                  "test_events": sorted({r["event_id"] for r in test})},
        "validation_candidates": [{"l2": p, "metrics": m} for _, p, m in candidates],
        "test": {"learned": trained, "manual_feature_baseline": baseline,
                 "ndcg_delta": trained["ndcg_at_k"] - baseline["ndcg_at_k"]},
        "limitations": ["Human relevance judgments are not observed financial losses.",
                        "Scores have not been probability-calibrated.",
                        "Synthetic labels only test mechanics, not real ranking quality.",
                        "AI-labelled evaluation measures agreement with AI, not independent human quality.",
                        "Event clustering and source extraction are supplied upstream."],
    }
    if holdout:
        test_events = {row["event_id"] for row in test}
        unseen = [row for row in rows if row["company_id"] in holdout and row["event_id"] in test_events
                  and (not frozen or row["dataset_split"] == "unseen_company_test")]
        report["unseen_company_test"] = {"companies": sorted(holdout), "metrics": evaluate(unseen, model.predict)}
    return model, report
