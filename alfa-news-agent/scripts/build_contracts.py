"""Generate the shared JSON Schema and OpenAPI from one registry (no network)."""
import argparse
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REF = lambda name: {"$ref": f"#/$defs/{name}"}
STR = {"type": "string", "minLength": 1}
ID = {"type": "string", "pattern": r"^[A-Za-z0-9_:.\-]{1,160}$"}
DATE = {"type": "string", "format": "date-time", "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"}
STRINGS = {"type": "array", "items": STR}


def obj(properties, required=None):
    return {"type": "object", "additionalProperties": False, "properties": properties,
            "required": list(properties) if required is None else required}


def array(items, **kwargs):
    return {"type": "array", "items": items, **kwargs}


def generate():
    profile = json.loads((ROOT / "company_context/profile.schema.json").read_text(encoding="utf-8"))
    profile.pop("$id", None)
    profile.pop("$schema", None)
    d = {"Profile": profile}
    d["Meta"] = obj({"schema_version": {"const": "1.0.0"}, "request_id": ID,
                     "mode": {"enum": ["mock", "demo", "live"]}, "warnings": STRINGS})
    d["Error"] = obj({"schema_version": {"const": "1.0.0"}, "request_id": ID,
                      "error": obj({"code": {"enum": ["VALIDATION_ERROR", "NOT_FOUND", "CONFLICT", "BUSY", "DEPENDENCY_UNAVAILABLE", "DEPENDENCY_TIMEOUT", "CONTRACT_VIOLATION", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "FORBIDDEN", "UNAUTHORIZED", "MODEL_OUTCOME_UNKNOWN", "OPERATION_CONFLICT", "SESSION_CHANGED", "MODEL_CANCELLED", "MODEL_OPERATION_CLOSED"]},
                                    "message": STR, "retryable": {"type": "boolean"}})})
    rules = json.loads((ROOT / "contracts/diagnostic-rules.json").read_text(encoding="utf-8"))
    d["FieldIssue"] = obj({"stage": {"enum": list(rules)},
        "path": {**STR, "maxLength": 500, "pattern": "^/"},
        "rule": {"enum": [rule for group in rules.values() for rule in group]},
        "expected": {"enum": ["string", "object", "array", "integer", "number", "boolean", "null"]},
        "limit": {"type": "number", "minimum": -1e9, "maximum": 1e9}},
        ["stage", "path", "rule"])
    d["ResponseDiagnostics"] = obj({"issues": array(REF("FieldIssue"), minItems=1, maxItems=10),
        "generation_id": {"type": "string", "format": "uuid"},
        "attempts": {"type": "integer", "minimum": 1, "maximum": 2},
        "max_attempts": {"const": 2}, "draft_saved": {"type": "boolean"},
        "history": array(obj({"attempt": {"type": "integer", "minimum": 1, "maximum": 2},
            "issues": array(REF("FieldIssue"), minItems=1, maxItems=10)}), maxItems=2)}, ["issues"])
    d["Error"]["properties"]["error"]["properties"]["diagnostics"] = REF("ResponseDiagnostics")
    d["Evidence"] = obj({"id": ID, "kind": {"enum": ["company", "news", "bank"]}, "title": STR,
                         "url": {"type": ["string", "null"], "format": "uri", "pattern": "^https?://"},
                         "excerpt": STR, "document_id": {"type": ["string", "null"]},
                         "page": {"type": ["integer", "null"], "minimum": 1},
                         "published_at": {**DATE, "type": ["string", "null"]},
                         "is_mock": {"type": "boolean"}})
    d["Evidence"]["allOf"] = [
        {"if": {"properties": {"kind": {"const": "bank"}}}, "then": {"properties": {
            "document_id": STR, "page": {"type": "integer", "minimum": 1}, "url": {"type": "string", "format": "uri", "pattern": "^https?://"}}}},
        {"if": {"properties": {"kind": {"const": "news"}}}, "then": {"properties": {"url": {"type": "string", "format": "uri", "pattern": "^https?://"}}}}]
    d["Event"] = obj({"news_id": ID, "event_id": ID, "title": STR, "text": STR,
                      "event_type": {"enum": ["rate_change", "fx_change", "commodity_price_change", "trade_restriction", "regional_event", "company_event", "tax_change", "other"]},
                      "published_at": DATE, "event_at": {**DATE, "type": ["string", "null"]},
                      "fact_status": {"enum": ["reported", "confirmed", "disputed"]},
                      "okved_divisions": array({"type": "string", "pattern": r"^\d{2}$"}),
                      "countries": STRINGS, "regions": STRINGS, "company_ids": array(ID),
                      "entity_mapping_source": {"type": ["string", "null"]},
                      "sources": array({"allOf": [REF("Evidence"), {"properties": {"kind": {"const": "news"}}}]}, minItems=1), "is_mock": {"type": "boolean"}})
    d["Event"]["properties"]["split_group_id"] = ID
    d["Event"]["properties"]["content"] = obj({"scope": {"enum": ["article_full", "feed_content", "feed_excerpt", "provided"]},
        "material_revision": STR, "version_id": STR, "warnings": STRINGS})
    d["EventDetails"] = obj({
        "direction": {"enum": ["increase", "decrease", "unchanged", "unknown"]},
        "magnitude": {"type": ["number", "null"], "minimum": 0},
        "magnitude_unit": {"enum": ["bps", "percentage_points", "percent", "unknown"]},
        "effective_at": {**DATE, "type": ["string", "null"]},
        "decision_status": {"enum": ["announced", "effective", "forecast", "unknown"]},
        "target_roles": array({"enum": ["importer", "exporter", "buyer", "seller", "borrower", "depositor"]}, uniqueItems=True),
        "target_okved_codes": array({"type": "string", "pattern": r"^\d{2}(?:\.\d{1,2}){0,2}$"}, uniqueItems=True),
        "evidence": array(obj({"field": {"enum": ["direction", "magnitude", "magnitude_unit", "effective_at", "decision_status", "target_roles", "target_okved_codes", "event_type", "event_at", "okved_divisions"]},
                               "quote": {**STR, "maxLength": 4000}, "source_ids": array(ID, minItems=1, uniqueItems=True)}), maxItems=100)
    })
    d["Event"]["properties"]["event_details"] = REF("EventDetails")
    d["EventDetails"]["properties"].update({
        "subject_okved_codes": array({"type": "string", "pattern": r"^\d{2}(?:\.\d{1,2}){0,2}$"}, uniqueItems=True),
        "taxonomy_origin": {"const": "rule_inference"},
        "taxonomy_version": {"const": "business-subjects-v1"}})
    d["EventDetails"]["properties"]["evidence"]["items"]["properties"]["field"]["enum"].append("subject_okved_codes")
    d["EventDetails"]["allOf"] = [{"if": {"required": ["subject_okved_codes"], "properties": {"subject_okved_codes": {"minItems": 1}}},
        "then": {"required": ["taxonomy_origin", "taxonomy_version"]}}]
    d["Event"]["allOf"] = [{"if": {"properties": {"company_ids": {"minItems": 1}}},
                              "then": {"properties": {"entity_mapping_source": STR}}}]
    d["Reason"] = obj({"code": ID, "text": STR, "profile_paths": array({"type": "string", "pattern": "^/"})})
    d["RankedItem"] = obj({"news_id": ID, "event_id": ID, "score": {"type": "number"},
                           "score_kind": {"enum": ["mock", "manual_feature_baseline", "logistic_relevance_uncalibrated"]},
                           "reasons": array(REF("Reason"), minItems=1), "warnings": STRINGS})
    d["RankedItem"]["allOf"] = [{"if": {"properties": {"score_kind": {"enum": ["mock", "logistic_relevance_uncalibrated"]}}},
                                   "then": {"properties": {"score": {"minimum": 0, "maximum": 1}}}}]
    d["RankedItem"]["properties"].update({
        "feature_version": {"enum": ["company_event_v1", "company_event_v2"]},
        "feature_contributions": array(obj({"feature": STR, "value": {"type": "number"},
            "coefficient": {"type": "number"}, "contribution": {"type": "number"},
            "scale": {"enum": ["raw_score", "logit"]},
            "profile_paths": array({"type": "string", "pattern": "^/"}), "source_ids": array(ID)}))})
    d["RankRequest"] = obj({"company_id": ID, "events": array(REF("Event"), maxItems=100),
                            "as_of": DATE, "limit": {"type": "integer", "minimum": 1, "maximum": 100}})
    d["RankData"] = obj({"company_id": ID, "as_of": DATE, "items": array(REF("RankedItem")),
                         "excluded_future_news_ids": array(ID), "truncated": {"type": "boolean"}})
    d["RankData"]["properties"].update({"feedback_id": ID, "model_version": STR})
    d["FeedbackRequest"] = obj({"ranking_id": ID, "company_id": ID,
        "ratings": array(obj({"event_id": ID, "policy_group_id": ID,
            "label": {"type": "integer", "minimum": 0, "maximum": 3}, "source_reviewed": {"const": True},
            "reason": {"type": "string", "minLength": 3, "maxLength": 2000}}), minItems=1, maxItems=100)})
    d["FeedbackData"] = obj({"accepted": {"type": "integer", "minimum": 0}, "duplicates": {"type": "integer", "minimum": 0}})
    d["LearningStatusData"] = obj({"active_version": STR, "paused": {"type": "boolean"},
        "labels": obj({key: {"type": "integer", "minimum": 0} for key in ("train", "validation", "gate")}),
        "consumed_gate_groups": {"type": "integer", "minimum": 0},
        "last_run": {"type": ["object", "null"]}, "thresholds": {"type": "object"}})
    d["LearningStatusData"]["properties"]["feature_versions"] = {
        "type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}
    d["SearchRequest"] = obj({"query": {"type": "string", "maxLength": 500}, "as_of": DATE,
                              "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                              "news_id": {"type": ["string", "null"], "pattern": ID["pattern"]}})
    d["SearchRequest"]["properties"].update({"since": DATE,
        "offset": {"type": "integer", "minimum": 0, "maximum": 1000},
        "candidate_limit": {"type": "integer", "minimum": 1, "maximum": 1000}})
    d["SearchData"] = obj({"items": array(REF("Event"))})
    d["SearchData"]["properties"].update({"total_candidates": {"type": "integer", "minimum": 0},
        "next_offset": {"type": ["integer", "null"], "minimum": 0}})
    d["IngestRequest"] = obj({"title": {**STR, "minLength": 5, "maxLength": 300},
        "text": {**STR, "minLength": 30, "maxLength": 18000},
        "url": {"type": "string", "format": "uri", "pattern": "^https?://", "maxLength": 2000},
        "published": {"type": ["string", "null"], "maxLength": 100},
        "modified": {"type": ["string", "null"], "maxLength": 100}}, ["title", "text", "url"])
    d["IngestData"] = obj({"item": {"anyOf": [REF("Event"), {"type": "null"}]},
        "news_id": ID, "date_status": {"enum": ["valid", "missing", "invalid", "future"]}, "warnings": STRINGS})
    d["IngestData"]["properties"]["ingestion_status"] = {"enum": ["inserted", "updated", "duplicate"]}
    d["FeedRefreshRequest"] = obj({})
    d["FeedRefreshData"] = obj({"processed": {"type": "integer", "minimum": 0}, "failed_hosts": STRINGS})
    d["FeedRefreshData"]["properties"].update({name: {"type": "integer", "minimum": 0}
        for name in ("inserted", "updated", "duplicates", "quarantined")})
    nullable_date = {**DATE, "type": ["string", "null"]}
    d["FeedStatusData"] = obj({"enabled": {"type": "boolean"}, "running": {"type": "boolean"},
        "poll_seconds": {"type": "integer", "minimum": 1}, "last_success": nullable_date,
        "feeds": array(obj({"url": {"type": "string", "format": "uri", "pattern": "^https://"},
            "last_attempt": nullable_date, "last_success": nullable_date,
            "last_error": {"type": ["string", "null"]}, "next_attempt": nullable_date,
            "consecutive_failures": {"type": "integer", "minimum": 0}}), maxItems=64)})
    feed_status_properties = d["FeedStatusData"]["properties"]["feeds"]["items"]["properties"]
    feed_status_properties.update({"name": STR, "kind": {"enum": ["rss", "json", "html"]}})
    feed_status_properties.update({name: {"type": "integer", "minimum": 0} for name in (
        "article_count", "full_text_count", "inline_full_text_count", "excerpt_count",
        "discovered_count", "pending_full_text_count", "full_text_errors")})
    d["RagRequest"] = obj({"query": {"type": "string", "minLength": 1, "maxLength": 500}, "as_of": DATE,
                           "limit": {"type": "integer", "minimum": 1, "maximum": 20}})
    d["RagData"] = obj({"items": array({"allOf": [REF("Evidence"), {"properties": {"kind": {"const": "bank"}}}]}), "limitations": STRINGS})
    d["ResolveRequest"] = obj({"source_ids": array(ID, maxItems=50, uniqueItems=True), "as_of": DATE})
    d["ResolveData"] = obj({"items": array(REF("Evidence")), "unknown_ids": array(ID)})
    d["AnalyzeRequest"] = obj({"company_id": ID, "news_id": ID, "as_of": DATE,
                               "audience_role": {"enum": ["cfo", "ceo", "treasury"]}})
    d["Claim"] = obj({"kind": {"enum": ["fact", "bank", "ai"]}, "text": STR, "quote": {"type": "string"},
                      "source_ids": array(ID, minItems=1)})
    d["Error"]["properties"]["error"]["properties"]["code"]["enum"] += [
        "MODEL_AUTH_ERROR", "MODEL_LIMIT", "MODEL_TIMEOUT", "MODEL_UNAVAILABLE", "MODEL_RESPONSE_INVALID"]
    d["Claim"]["properties"].update({
        "profile_paths": array({"type": "string", "pattern": "^/", "maxLength": 500}, minItems=1, maxItems=20, uniqueItems=True),
        "conditions": array({"type": "string", "minLength": 1, "maxLength": 2000}, minItems=1, maxItems=10)})
    indexes = array({"type": "integer", "minimum": 0, "maximum": 29}, minItems=1, maxItems=30, uniqueItems=True)
    lines = lambda count=10: array({"type": "string", "minLength": 1, "maxLength": 4000, "pattern": r"\S"}, maxItems=count)
    d["Grounding"] = obj({"summary": indexes, "why_relevant": indexes,
        "risks": array(indexes, maxItems=10), "opportunities": array(indexes, maxItems=10),
        "recommendations": array(obj({"claim_indexes": indexes,
            "condition": {"type": "string", "minLength": 1, "maxLength": 2000},
            "required_data": {**lines(), "minItems": 1}}), maxItems=10)})
    d["GeneratedAnalysis"] = obj({"summary": {**STR, "maxLength": 6000, "pattern": r"\S"}, "why_relevant": {**STR, "maxLength": 6000, "pattern": r"\S"},
        "claims": array(REF("Claim"), minItems=2, maxItems=30), "risks": lines(), "opportunities": lines(),
        "recommendations": lines(), "limitations": lines(20), "missing_data": lines(20), "grounding": REF("Grounding")})
    d["Trace"] = obj({"step": ID, "detail": STR})
    d["Analysis"] = obj({"id": ID, "company_id": ID, "news_id": ID, "created_at": DATE,
                         "summary": STR, "why_relevant": STR, "claims": array(REF("Claim"), minItems=1),
                         "risks": STRINGS, "opportunities": STRINGS, "recommendations": STRINGS,
                         "limitations": STRINGS, "sources": array(REF("Evidence"), minItems=1),
                         "trace": array(REF("Trace")), "mode": {"enum": ["mock", "demo", "live"]}})
    d["AgentRequest"] = obj({"company_id": ID, "profile": REF("Profile"), "event": REF("Event"),
                             "ranked_item": REF("RankedItem"), "research": REF("RagData"), "as_of": DATE,
                             "audience_role": {"enum": ["cfo", "ceo", "treasury"]}, "is_mock": {"type": "boolean"}})
    d["Analysis"]["properties"].update({"missing_data": lines(20), "grounding": REF("Grounding")})
    d["Analysis"]["allOf"] = [{"if": {"properties": {"mode": {"const": "live"}}},
                                  "then": {"required": ["grounding", "missing_data"]}}]
    d["AnalysisEventRequest"] = obj({"company_id": ID, "event": REF("Event"), "as_of": DATE,
        "audience_role": {"enum": ["cfo", "ceo", "treasury"]}})
    d["AnalysisEventRequest"]["properties"]["expected_context_sha256"] = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
    d["PreparedContextData"] = obj({"input": REF("AgentRequest"), "sources": array(REF("Evidence"), minItems=2),
        "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"}, "serialized_bytes": {"type": "integer", "minimum": 1}})
    d["QuestionRequest"] = obj({"company_id": ID, "question": {"type": "string", "minLength": 3, "maxLength": 2000}})
    d["AgentQuestionRequest"] = obj({"company_id": ID, "question": {"type": "string", "minLength": 3, "maxLength": 2000},
                                     "analysis": REF("Analysis"), "history": array(obj({"question": STR, "answer": STR}), maxItems=10)})
    d["AgentQuestionRequest"]["properties"].update({"as_of": DATE, "audience_role": {"enum": ["cfo", "ceo", "treasury"]},
        # Optional for mock/demo compatibility; live providers require the original immutable input.
        "prepared_input": REF("AgentRequest")})
    d["Answer"] = obj({"analysis_id": ID, "company_id": ID, "answer": STR, "source_ids": array(ID, minItems=1)})
    d["GeneratedAnswer"] = obj({"answer": {**STR, "maxLength": 8000, "pattern": r"\S"}, "claims": array(REF("Claim"), minItems=2, maxItems=30),
        "claim_indexes": indexes, "limitations": lines(20), "missing_data": lines(20)})
    d["Answer"]["properties"].update({key: value for key, value in d["GeneratedAnswer"]["properties"].items() if key != "answer"})
    d["CompaniesData"] = obj({"items": array(ID), "offset": {"type": "integer", "minimum": 0},
                              "limit": {"type": "integer", "minimum": 1, "maximum": 100}})
    d["HealthData"] = obj({"status": {"const": "ok"}, "service": STR})
    d["RuntimeData"] = obj({"generation_enabled": {"type": "boolean"},"viewer_key": ID},["generation_enabled"])
    role = {"enum": ["cfo", "ceo", "treasury"]}
    milliseconds = {"type": "number", "minimum": 0}
    d["LiveSubscribeRequest"] = obj({"company_id": ID, "audience_role": role,
        "limit": {"type": "integer", "minimum": 1, "maximum": 50}, "min_score": {"type": "number", "minimum": 0, "maximum": 1},
        "enabled": {"type": "boolean"}}, ["company_id", "audience_role"])
    d["LiveScanRequest"] = obj({"company_id": ID, "audience_role": role})
    d["LiveQuestionRequest"] = obj({"company_id": ID, "question": {"type": "string", "minLength": 3, "maxLength": 2000}, "idempotency_key": ID})
    d["LiveFavoriteRequest"] = obj({"company_id": ID, "favorite": {"type": "boolean"}})
    d["LiveCard"] = obj({"id": ID, "seq": {"type": "integer", "minimum": 1}, "company_id": ID, "news_id": ID,
        "revision": STR, "audience_role": role, "title": STR, "created_at": milliseconds,
        "stale": {"type": "boolean"}, "favorite": {"type": "boolean"}, "analysis": REF("Analysis")})
    d["LiveFeedData"] = obj({"items": array(REF("LiveCard"), maxItems=100), "next_cursor": {"type": ["string", "null"]},
        "total":{"type":"integer","minimum":0},"visible_ids":array(ID,uniqueItems=True),"available_count":{"type":"integer","minimum":0},"favorites_count":{"type":"integer","minimum":0},
        "running_tasks":{"type":"integer","minimum":0},"has_running_tasks":{"type":"boolean"}})
    d["LiveSubscriptionData"] = obj({"company_id": ID, "audience_role": role, "limit": {"type": "integer"}, "min_score": {"type": "number"},
        "enabled": {"type": "boolean"}, "next_scan": milliseconds, "last_scan": {"type": ["number", "null"]}, "error": {"type": ["string", "null"]}})
    d["LiveJobData"] = obj({"id": ID, "kind": {"enum": ["analysis", "question"]}, "audience_role":role, "company_id": ID,
        "news_id": ID, "analysis_id": {"type": ["string", "null"]}, "status": {"enum": ["queued", "running", "deferred", "succeeded", "failed", "superseded", "unknown"]},
        "title": {"type": "string"}, "attempts": {"type": "integer"}, "error": {"type": ["string", "null"]},
        "next_attempt": milliseconds, "created_at": milliseconds, "updated_at": milliseconds,
        "result": {"anyOf": [REF("AnalysisResponse"), REF("AnswerResponse"), {"type": "null"}]}})
    d["LiveJobsData"] = obj({"items": array(REF("LiveJobData"), maxItems=100)})
    d["LiveFavoriteData"] = obj({"id": ID, "favorite": {"type": "boolean"}})
    d["LiveDetailData"] = obj({"card": REF("LiveCard"), "history": array(obj({"question": STR,"answer": STR,"response": REF("AnswerResponse"),"created_at": milliseconds})),
        "versions": array(obj({"id": ID,"revision": STR,"created_at": milliseconds,"stale": {"type":"boolean"}}))})
    # Operational telemetry is deliberately extensible; LLM output contracts remain strict.
    d["AgentOperationData"] = obj({"state":{"enum":["not_found","succeeded","failed","running","unknown","recoverable"]},
        "response":{"anyOf":[REF("AnalysisResponse"),REF("AnswerResponse")]},
        "error":obj({"code":STR,"status":{"type":"integer","minimum":400,"maximum":599},"message":STR})},["state"])
    d["AgentOperationData"]["allOf"]=[{"if":{"properties":{"state":{"const":"succeeded"}}},"then":{"required":["response"]}},
        {"if":{"properties":{"state":{"const":"failed"}}},"then":{"required":["error"]}}]
    d["LiveStatusData"] = {"type": "object","properties":{"available_count":{"type":"integer","minimum":0},"favorites_count":{"type":"integer","minimum":0},"running_tasks":{"type":"integer","minimum":0},"has_running_tasks":{"type":"boolean"}}}
    d["BudgetStatusData"] = {"type": "object"}
    for name in ["LiveFeedData", "LiveSubscriptionData", "LiveJobData", "LiveJobsData", "LiveFavoriteData", "LiveDetailData", "LiveStatusData", "AgentOperationData", "BudgetStatusData", "Profile", "CompaniesData", "RankData", "SearchData", "RagData", "ResolveData", "Analysis", "Answer", "HealthData", "FeedbackData", "LearningStatusData", "PreparedContextData", "IngestData", "FeedRefreshData", "FeedStatusData", "RuntimeData"]:
        d[name + "Response"] = obj({"meta": REF("Meta"), "data": REF(name)})
    routes = [
        ("get", "/v1/live/feed", None, "LiveFeedDataResponse", 5),
        ("get", "/v1/live/status", None, "LiveStatusDataResponse", 5),
        ("get", "/v1/budget", None, "BudgetStatusDataResponse", 5),
        ("post", "/v1/live/subscriptions", "LiveSubscribeRequest", "LiveSubscriptionDataResponse", 5),
        ("post", "/v1/live/scan", "LiveScanRequest", "LiveStatusDataResponse", 5),
        ("get", "/v1/live/jobs", None, "LiveJobsDataResponse", 5),
        ("get", "/v1/live/jobs/{job_id}", None, "LiveJobDataResponse", 5),
        ("get", "/v1/live/analyses/{analysis_id}", None, "LiveDetailDataResponse", 5),
        ("post", "/v1/live/analyses/{analysis_id}/favorite", "LiveFavoriteRequest", "LiveFavoriteDataResponse", 5),
        ("post", "/v1/live/analyses/{analysis_id}/questions", "LiveQuestionRequest", "LiveJobDataResponse", 5),
        ("post", "/v1/learning/feedback", "FeedbackRequest", "FeedbackDataResponse", 5),
        ("get", "/v1/learning/status", None, "LearningStatusDataResponse", 5),
        ("get", "/v1/health", None, "HealthDataResponse", 5),
        ("get", "/v1/runtime", None, "RuntimeDataResponse", 5),
        ("get", "/v1/companies", None, "CompaniesDataResponse", 1),
        ("get", "/v1/companies/{company_id}", None, "ProfileResponse", 1),
        ("post", "/v1/rank", "RankRequest", "RankDataResponse", 1),
        ("post", "/v1/tools/search_news", "SearchRequest", "SearchDataResponse", 3),
        ("post", "/v1/news", "IngestRequest", "IngestDataResponse", 3),
        ("post", "/v1/feeds/refresh", "FeedRefreshRequest", "FeedRefreshDataResponse", 3),
        ("get", "/v1/feeds/status", None, "FeedStatusDataResponse", 3),
        ("post", "/v1/tools/rag_bank_analytics", "RagRequest", "RagDataResponse", 3),
        ("post", "/v1/tools/resolve_sources", "ResolveRequest", "ResolveDataResponse", 3),
        ("post", "/v1/analyze", "AnalyzeRequest", "AnalysisResponse", 2),
        ("post", "/v1/analysis-context", "AnalysisEventRequest", "PreparedContextDataResponse", 5),
        ("post", "/v1/analyze-event", "AnalysisEventRequest", "AnalysisResponse", 2),
        ("get", "/v1/agent/operations/{operation_id}", None, "AgentOperationDataResponse", 2),
        ("post", "/v1/agent/analyze", "AgentRequest", "AnalysisResponse", 2),
        ("post", "/v1/agent/questions", "AgentQuestionRequest", "AnswerResponse", 2),
        ("get", "/v1/analyses/{analysis_id}", None, "AnalysisResponse", 2),
        ("post", "/v1/analyses/{analysis_id}/questions", "QuestionRequest", "AnswerResponse", 2),
    ]
    paths = {}
    for method, path, request, response, owner in routes:
        params = []
        for key in ["company_id", "analysis_id", "job_id", "operation_id"]:
            if "{" + key + "}" in path:
                params.append({"name": key, "in": "path", "required": True, "schema": ID})
        if path == "/v1/agent/operations/{operation_id}":
            params += [{"name": "company_id", "in": "query", "required": True, "schema": ID},
                       {"name": "kind", "in": "query", "required": True, "schema": {"enum": ["analysis", "question"]}}]
        if path == "/v1/companies":
            params += [{"name": "offset", "in": "query", "schema": {"type": "integer", "minimum": 0, "default": 0}},
                       {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}]
        if "{analysis_id}" in path and method == "get":
            params.append({"name": "company_id", "in": "query", "required": True, "schema": ID})
        op = {"operationId": response.removesuffix("Response") + "_" + method + "_" + path.replace("/", "_").replace("{", "").replace("}", ""),
              "tags": [f"role-{owner}"], "parameters": params,
              "responses": {"200": {"description": "Validated result", "content": {"application/json": {"schema": REF(response)}}},
                            **{str(code): {"description": "Error", "content": {"application/json": {"schema": REF("Error")}}}
                               for code in [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504]}}}
        if path.startswith("/v1/learning/"):
            op["security"] = [{"BearerAuth": [], "LearningToken": []}, {"BrowserSession": [], "LearningToken": []}]
        elif path == "/v1/health":
            op["security"] = []
        elif path.startswith("/v1/agent/"):
            op["security"] = [{"InternalToken": []}]
        if method == "post" and path.startswith("/v1/live/") and (path.endswith("/questions")):
            op["responses"]["202"] = op["responses"].pop("200")
        if request:
            op["requestBody"] = {"required": True, "content": {"application/json": {"schema": REF(request)}}}
        paths.setdefault(path, {})[method] = op
    api = {"openapi": "3.1.0", "info": {"title": "Alfa News integration API", "version": "1.0.0",
            "description": "Gateway: OIDC company grants and private analysis ownership. Explicit development mode only is unauthenticated. /v1/agent/* belongs to a private service, not the gateway."},
           "servers": [{"url": "http://localhost:8000"}], "security": [{"BearerAuth": []}, {"BrowserSession": []}], "paths": paths, "components": {"schemas": copy.deepcopy(d), "securitySchemes": {"BearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}, "BrowserSession": {"type": "apiKey", "in": "cookie", "name": "__Host-alfa-session"}, "InternalToken": {"type": "apiKey", "in": "header", "name": "X-Internal-Token"}, "LearningToken": {"type": "apiKey", "in": "header", "name": "X-Learning-Token"}}}}
    api = json.loads(json.dumps(api).replace("#/$defs/", "#/components/schemas/"))
    return {"schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "urn:alfa:integration:v1", "$defs": d},
            "openapi.json": api}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name, value in generate().items():
        path = ROOT / "contracts/v1" / name
        content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Stale generated contract: {path}; run python scripts/build_contracts.py")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
