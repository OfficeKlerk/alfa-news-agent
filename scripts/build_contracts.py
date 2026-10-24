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
                      "error": obj({"code": {"enum": ["VALIDATION_ERROR", "NOT_FOUND", "CONFLICT", "BUSY", "DEPENDENCY_UNAVAILABLE", "DEPENDENCY_TIMEOUT", "CONTRACT_VIOLATION", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "FORBIDDEN"]},
                                    "message": STR, "retryable": {"type": "boolean"}})})
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
    d["SearchData"] = obj({"items": array(REF("Event"))})
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
    for name in ["Profile", "CompaniesData", "RankData", "SearchData", "RagData", "ResolveData", "Analysis", "Answer", "HealthData", "FeedbackData", "LearningStatusData", "PreparedContextData", "IngestData", "FeedRefreshData"]:
        d[name + "Response"] = obj({"meta": REF("Meta"), "data": REF(name)})
    routes = [
        ("post", "/v1/learning/feedback", "FeedbackRequest", "FeedbackDataResponse", 5),
        ("get", "/v1/learning/status", None, "LearningStatusDataResponse", 5),
        ("get", "/v1/health", None, "HealthDataResponse", 5),
        ("get", "/v1/companies", None, "CompaniesDataResponse", 1),
        ("get", "/v1/companies/{company_id}", None, "ProfileResponse", 1),
        ("post", "/v1/rank", "RankRequest", "RankDataResponse", 1),
        ("post", "/v1/tools/search_news", "SearchRequest", "SearchDataResponse", 3),
        ("post", "/v1/news", "IngestRequest", "IngestDataResponse", 3),
        ("post", "/v1/feeds/refresh", "FeedRefreshRequest", "FeedRefreshDataResponse", 3),
        ("post", "/v1/tools/rag_bank_analytics", "RagRequest", "RagDataResponse", 3),
        ("post", "/v1/tools/resolve_sources", "ResolveRequest", "ResolveDataResponse", 3),
        ("post", "/v1/analyze", "AnalyzeRequest", "AnalysisResponse", 2),
        ("post", "/v1/analysis-context", "AnalysisEventRequest", "PreparedContextDataResponse", 5),
        ("post", "/v1/analyze-event", "AnalysisEventRequest", "AnalysisResponse", 2),
        ("post", "/v1/agent/analyze", "AgentRequest", "AnalysisResponse", 2),
        ("post", "/v1/agent/questions", "AgentQuestionRequest", "AnswerResponse", 2),
        ("get", "/v1/analyses/{analysis_id}", None, "AnalysisResponse", 2),
        ("post", "/v1/analyses/{analysis_id}/questions", "QuestionRequest", "AnswerResponse", 2),
    ]
    paths = {}
    for method, path, request, response, owner in routes:
        params = []
        for key in ["company_id", "analysis_id"]:
            if "{" + key + "}" in path:
                params.append({"name": key, "in": "path", "required": True, "schema": ID})
        if path == "/v1/companies":
            params += [{"name": "offset", "in": "query", "schema": {"type": "integer", "minimum": 0, "default": 0}},
                       {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}]
        if "{analysis_id}" in path and method == "get":
            params.append({"name": "company_id", "in": "query", "required": True, "schema": ID})
        op = {"operationId": response.removesuffix("Response") + "_" + method + "_" + path.replace("/", "_").replace("{", "").replace("}", ""),
              "tags": [f"role-{owner}"], "parameters": params,
              "responses": {"200": {"description": "Validated result", "content": {"application/json": {"schema": REF(response)}}},
                            **{str(code): {"description": "Error", "content": {"application/json": {"schema": REF("Error")}}}
                               for code in [400, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504]}}}
        if path.startswith("/v1/learning/"):
            op["security"] = [{"LearningToken": []}]
        if request:
            op["requestBody"] = {"required": True, "content": {"application/json": {"schema": REF(request)}}}
        paths.setdefault(path, {})[method] = op
    api = {"openapi": "3.1.0", "info": {"title": "Alfa News integration API", "version": "1.0.0",
            "description": "Local development API. Company selection scopes data, it is not authentication. /v1/agent/analyze is internal."},
           "servers": [{"url": "http://localhost:8000"}], "paths": paths, "components": {"schemas": copy.deepcopy(d), "securitySchemes": {"LearningToken": {"type": "apiKey", "in": "header", "name": "X-Learning-Token"}}}}
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
