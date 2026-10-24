"""Adapters for ContextStore and the bundled, versioned news_analysis module."""
import importlib
import json
import os
import sys
from datetime import datetime
from uuid import uuid4
from pathlib import Path
from company_context import ContextStore, build_database
from .contracts import ROOT


def prepare_context():
    database = Path(os.environ.get("CONTEXT_DB", ROOT / "var/integration/context.sqlite3"))
    mode = os.environ.get("CONTEXT_MODE", "fixture")
    if mode not in {"fixture", "existing"}:
        raise ValueError("CONTEXT_MODE must be fixture or existing")
    if mode == "fixture":
        # Separate fixture database: never implicitly rebuild a user's existing database.
        database.parent.mkdir(parents=True, exist_ok=True)
        if not database.exists():
            fixtures = ROOT / "tests/fixtures/company_context"
            build_database(fixtures / "companies.csv", database, links=fixtures / "links.csv",
                           payments=fixtures / "payments.csv", revenue_unit="unknown")
    if not database.is_file():
        raise ValueError("CONTEXT_DB does not exist; build it explicitly with company_context CLI")
    with ContextStore(database):
        pass
    return database, mode


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class RankAdapter:
    def __init__(self):
        self.mode = os.environ.get("RANK_MODE", "mock")
        self.analyze = None
        self.model = None
        self.learning = None
        model_path = os.environ.get("RANK_MODEL_PATH")
        if model_path and self.mode != "news-analysis":
            raise ValueError("RANK_MODEL_PATH requires RANK_MODE=news-analysis")
        if self.mode == "news-analysis":
            path = Path(os.environ.get("NEWS_MODULE_PATH", ROOT)).resolve()
            if not (path / "news_analysis/__init__.py").is_file():
                raise ValueError("NEWS_MODULE_PATH must contain a compatible news_analysis package; omit it to use this repository")
            for name, cached in tuple(sys.modules.items()):
                if name == "news_analysis" or name.startswith("news_analysis."):
                    filename = getattr(cached, "__file__", None)
                    if filename and not Path(filename).resolve().is_relative_to(path / "news_analysis"):
                        raise ValueError("NEWS_MODULE_PATH differs from the already loaded news_analysis; select one checkout before process startup")
            sys.path.insert(0, str(path))
            try:
                module = importlib.import_module("news_analysis")
                feature_module = importlib.import_module("news_analysis.features")
                contract_module = importlib.import_module("news_analysis.contracts")
                if (getattr(feature_module, "DEFAULT_FEATURE_VERSION", None) != "company_event_v2"
                        or not callable(getattr(feature_module, "baseline_explain", None))
                        or not callable(getattr(contract_module, "validate_source_availability", None))):
                    raise ValueError("NEWS_MODULE_PATH uses an incompatible legacy module; use the bundled module and load v1 weights via RANK_MODEL_PATH")
            finally:
                sys.path.remove(str(path))
            self.analyze = module.analyze_news
            if model_path:
                try:
                    artifact = json.loads(Path(model_path).read_text(encoding="utf-8-sig"))
                    if not isinstance(artifact, dict) or not isinstance(artifact.get("metadata", {}), dict):
                        raise ValueError("Expected a model object with metadata")
                    self.model = module.LogisticRanker.from_dict(artifact)
                except (OSError, ValueError, KeyError, TypeError) as error:
                    raise ValueError("Cannot load RANK_MODEL_PATH; check the model file and feature version") from error
        elif self.mode != "mock":
            raise ValueError("RANK_MODE must be mock or news-analysis")

    def rank(self, store, request, exposure_id=None):
        ids = [event["news_id"] for event in request["events"]]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate news_id")
        if self.analyze:
            model = self.learning.model() if self.learning else self.model
            # Only validated extraction enters the original pipeline. No fabricated scenario parameters.
            result = self.analyze(store, request["company_id"], request["events"], request["as_of"],
                                  model=model, limit=request["limit"])
            items = []
            for card in result["cards"]:
                features = card["company_evidence"]["features"]
                basis = {"rule_subject_taxonomy": "тематическое сопоставление по правилам; применимость условий не подтверждена",
                         "explicit_target_okved": "совпадение явно указанного целевого ОКВЭД"}
                reasons = [{"code": key, "text": f"{key}: {features['values'][key]}" +
                            (" (" + basis[value["match_basis"]] + ")" if value.get("match_basis") in basis else ""),
                            "profile_paths": value["profile_pointers"]}
                           for key, value in features["evidence"].items() if features["values"][key]]
                contributions = [{"feature": entry["feature"], "value": entry["value"],
                                  "coefficient": entry["coefficient"], "contribution": entry["contribution"],
                                  "scale": entry["scale"],
                                  "profile_paths": entry["evidence"].get("profile_pointers", []),
                                  "source_ids": sorted({source["id"] for source in entry["evidence"].get("news_sources", [])
                                                        if isinstance(source.get("id"), str)})}
                                 for entry in card["model_assessment"]["feature_contributions"]]
                items.append({"news_id": card["news_id"], "event_id": card["event_id"], "score": card["score"],
                              "feature_version": features["version"], "feature_contributions": contributions,
                              "score_kind": card["score_kind"], "reasons": reasons or [
                                  {"code": "baseline", "text": "Базовая оценка; прямое влияние не подтверждено", "profile_paths": []}],
                              "warnings": card["self_check"]["warnings"]})
            data = {"company_id": result["company_id"], "as_of": result["as_of"], "items": items,
                    "excluded_future_news_ids": result["excluded_future_news_ids"], "truncated": result["truncated"]}
            if self.learning and exposure_id:
                events = {event["news_id"]: event for event in request["events"]}
                rows = []
                for card in result["cards"]:
                    event = events[card["news_id"]]
                    rows.append({"company_id": request["company_id"], "event_id": card["event_id"],
                                 "as_of": request["as_of"], "published_at": event["published_at"],
                                 "features": card["company_evidence"]["features"]["values"],
                                 "feature_version": card["company_evidence"]["features"]["version"], "is_mock": event["is_mock"],
                                 "split_group_id": event.get("split_group_id", event["event_id"]),
                                 "annotation_context": {"event": event,
                                     "profile_provenance": card["company_evidence"]["profile_provenance"],
                                     "feature_evidence": card["company_evidence"]["features"]["evidence"]}})
                    card_warning = "human_feedback_not_independently_audited"
                    next(item for item in items if item["event_id"] == card["event_id"])["warnings"].append(card_warning)
                data["feedback_id"] = str(uuid4())
                data["model_version"] = model.metadata["registry_version"] if model else "baseline"
                self.learning.capture(data["feedback_id"], request["company_id"], rows, data, data["model_version"])
            return data
        profile = store.get_company_profile(request["company_id"])
        future, clusters = [], {}
        from news_analysis.contracts import validate_source_availability
        for event in request["events"]:
            if timestamp(event["published_at"]) > timestamp(request["as_of"]):
                future.append(event["news_id"])
                continue
            validate_source_availability(event, request["as_of"])
            old = clusters.get(event["event_id"])
            if not old or (timestamp(event["published_at"]), event["news_id"]) > (timestamp(old["published_at"]), old["news_id"]):
                clusters[event["event_id"]] = event
        items = []
        for event in clusters.values():
            match = profile["industry"]["okved_division"] in event["okved_divisions"]
            items.append({"news_id": event["news_id"], "event_id": event["event_id"], "score": 0.8 if match else 0.2,
                          "score_kind": "mock", "reasons": [{"code": "fixture_industry", "text": "Учебное сопоставление ОКВЭД" if match else "Учебный общий контекст",
                                                              "profile_paths": ["/industry/okved_division"]}],
                          "warnings": ["mock_ranker_not_a_model"]})
        items.sort(key=lambda item: (-item["score"], item["event_id"]))
        return {"company_id": request["company_id"], "as_of": request["as_of"], "items": items[:request["limit"]],
                "excluded_future_news_ids": future, "truncated": len(items) > request["limit"]}
