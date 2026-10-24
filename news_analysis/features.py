"""Versioned company-event features; missing values have their own indicators."""

import math
import re
from .contracts import finite, normalized, timestamp, validate_event, validated_event_details, validate_source_availability

FEATURE_VERSION = "company_event_v1"
FEATURE_NAMES = (
    "rate_financing", "rate_deposit", "fx_trade", "industry_match", "country_match", "region_match",
    "direct_company_match", "related_company_match", "graph_in_share", "graph_out_share",
    "graph_in_coverage", "graph_out_coverage", "freshness",
    "disputed", "industry_unknown", "financing_unknown", "deposit_unknown",
    "trade_unknown", "graph_in_unknown", "graph_out_unknown",
)
BASELINE_WEIGHTS = (0.9, 0.7, 0.8, 0.75, 0.8, 0.6, 1.0, 0.7, 0.85, 0.85, 0, 0, 0.1, -0.5, 0, 0, 0, 0, 0, 0)

# The public v1 constants and its extraction are frozen: existing datasets and
# saved coefficients must retain exactly the same meaning and vector order.
DEFAULT_FEATURE_VERSION = "company_event_v2"
V2_FEATURE_NAMES = FEATURE_NAMES + (
    "rate_hold_financing", "rate_hold_deposit", "rate_magnitude_financing", "rate_magnitude_deposit",
    "rate_direction_unknown", "rate_magnitude_unknown", "industry_exact_match", "industry_target_mismatch",
    "industry_target_unknown", "target_role_match", "target_role_mismatch", "target_role_unknown",
    "applicable_deadline_30d", "applicable_effective", "applicable_forecast", "effective_date_unknown",
    "industry_subject_match", "industry_subject_mismatch", "industry_subject_unknown",
)
# Untrained, documented hypotheses, not coefficients fitted to audit labels.
# Holding a rate is contextual information, not a new rate shock; magnitude is
# a relevance interaction, not an estimate of a company's financial exposure.
V2_BASELINE_WEIGHTS = BASELINE_WEIGHTS + (
    -.75, -.55, .2, .15, 0, 0, .25, 0, 0, .2, 0, 0, .15, .1, -.2, 0, 0, 0, 0,
)
FEATURE_SCHEMAS = {
    FEATURE_VERSION: (FEATURE_NAMES, BASELINE_WEIGHTS),
    DEFAULT_FEATURE_VERSION: (V2_FEATURE_NAMES, V2_BASELINE_WEIGHTS),
}


def feature_names(version):
    if not isinstance(version, str) or version not in FEATURE_SCHEMAS:
        raise ValueError("Unsupported feature version: " + str(version))
    return FEATURE_SCHEMAS[version][0]


def feature_weights(version):
    feature_names(version)
    return FEATURE_SCHEMAS[version][1]


def infer_feature_version(values):
    for version, (names, _) in FEATURE_SCHEMAS.items():
        if isinstance(values, dict) and set(values) == set(names):
            return version
    raise ValueError("Feature names do not match a supported feature contract")


def extract_features(profile, event, as_of, graph=None, feature_version=FEATURE_VERSION):
    feature_names(feature_version)
    validate_event(event)
    validate_source_availability(event, as_of)
    if profile.get("schema_version") != "1.0":
        raise ValueError("Expected company profile schema 1.0")
    age = (timestamp(as_of) - timestamp(event["published_at"])).total_seconds() / 86400
    if age < 0:
        raise ValueError("Cannot score a news item published after as_of")
    if graph and (graph.get("company_id") != profile["company_id"] or graph.get("event_id") != event["event_id"]):
        raise ValueError("Graph evidence belongs to another company/event")
    graph_versions = {"one_hop_payment_share_v1": FEATURE_VERSION, "one_hop_payment_share_v2": DEFAULT_FEATURE_VERSION}
    if graph and graph.get("method") in graph_versions and graph_versions[graph["method"]] != feature_version:
        raise ValueError("Graph evidence uses another feature version; recompute it for this model")
    products = profile.get("bank_products", {})
    financing = [products.get(key) for key in ("loan", "leasing", "factoring")]
    trade = profile.get("foreign_trade", {})
    industry = profile.get("industry", {})
    incoming = (graph or {}).get("in", {}).get("matched_share")
    outgoing = (graph or {}).get("out", {}).get("matched_share")
    in_coverage = (graph or {}).get("in", {}).get("attribute_coverage_share")
    out_coverage = (graph or {}).get("out", {}).get("attribute_coverage_share")
    for name, value in (("graph.in.matched_share", incoming), ("graph.out.matched_share", outgoing),
                        ("graph.in.attribute_coverage_share", in_coverage), ("graph.out.attribute_coverage_share", out_coverage)):
        if value is not None:
            finite(value, name, 0, 1)
    rate = event["event_type"] == "rate_change"
    values = {
        "rate_financing": float(rate and any(x is True for x in financing)),
        "rate_deposit": float(rate and products.get("deposit") is True),
        "fx_trade": float(event["event_type"] == "fx_change" and
                          (trade.get("has_fts") is True or
                           (trade.get("has_fts") is None and bool(trade.get("countries"))))),
        "industry_match": float(industry.get("okved_division") in event.get("okved_divisions", [])),
        "country_match": float(trade.get("has_fts") is not False and bool(normalized(trade.get("countries", [])) & normalized(event.get("countries", [])))),
        "region_match": float(bool(normalized([profile.get("geography", {}).get("region")]) & normalized(event.get("regions", [])))),
        "direct_company_match": float(profile["company_id"] in event.get("company_ids", [])),
        "related_company_match": float(bool((graph or {}).get("related_company_matches"))),
        "graph_in_share": incoming if incoming is not None else 0.0,
        "graph_out_share": outgoing if outgoing is not None else 0.0,
        "graph_in_coverage": in_coverage if in_coverage is not None else 0.0,
        "graph_out_coverage": out_coverage if out_coverage is not None else 0.0,
        "freshness": math.exp(-math.log(2) * age / 7),
        "disputed": float(event["fact_status"] == "disputed"),
        "industry_unknown": float(not industry.get("okved_division")),
        "financing_unknown": float(rate and not any(x is True for x in financing) and any(x is None for x in financing)),
        "deposit_unknown": float(rate and products.get("deposit") is None),
        "trade_unknown": float(bool(event.get("countries")) and trade.get("has_fts") is not False and not trade.get("countries")),
        "graph_in_unknown": float(incoming is None or in_coverage is None or in_coverage < 1),
        "graph_out_unknown": float(outgoing is None or out_coverage is None or out_coverage < 1),
    }
    pointers = {
        "rate_financing": ["/bank_products/loan", "/bank_products/leasing", "/bank_products/factoring"],
        "rate_deposit": ["/bank_products/deposit"], "industry_match": ["/industry/okved_division"],
        "fx_trade": ["/foreign_trade"],
        "country_match": ["/foreign_trade"], "region_match": ["/geography/region"],
        "direct_company_match": ["/company_id"], "industry_unknown": ["/industry"],
        "financing_unknown": ["/bank_products"], "deposit_unknown": ["/bank_products/deposit"],
        "trade_unknown": ["/foreign_trade"],
    }
    evidence = {name: {"profile_pointers": pointers.get(name, []), "news_sources": event["sources"],
                       "graph_pointer": ("/related_company_matches" if name == "related_company_match" else
                                         "/" + ("in" if "_in_" in name else "out") if name.startswith("graph_") else None)}
                for name in FEATURE_NAMES}
    if feature_version == DEFAULT_FEATURE_VERSION:
        _extend_v2(profile, event, as_of, values, evidence)
    return {"version": feature_version, "values": values, "evidence": evidence}


def _code(value):
    """Use code prefixes, never a textual industry name as proof of eligibility."""
    if not isinstance(value, str) or not re.fullmatch(r"\d{2}(?:\.\d{1,2}){0,2}", value.strip()):
        return None
    return value.strip().replace(".", "")


def _extend_v2(profile, event, as_of, values, evidence):
    details = validated_event_details(event)
    direction = details.get("direction", "unknown")
    status = details.get("decision_status", "unknown")
    rate = event["event_type"] == "rate_change"
    financing, deposit = values["rate_financing"], values["rate_deposit"]
    magnitude, unit = details.get("magnitude"), details.get("magnitude_unit", "unknown")
    # A percentage-point change is convertible (1 pp = 100 bps); a relative
    # percent change needs the previous rate and must not be treated as pp.
    known_magnitude = magnitude is not None and unit in {"bps", "percentage_points"}
    bps = abs(magnitude) * (100 if unit == "percentage_points" else 1) if known_magnitude else 0
    strength = min(bps / 200, 1) if direction in {"increase", "decrease"} else 0
    targets = details.get("target_okved_codes", [])
    subjects = details.get("subject_okved_codes", []) if not targets else []
    selectors = targets or subjects
    code = _code(profile.get("industry", {}).get("okved_code"))
    division = _code(profile.get("industry", {}).get("okved_division"))
    available_code = code or division
    target_codes = [_code(target) for target in selectors]
    matches = bool(available_code and any(target and available_code.startswith(target) for target in target_codes))
    # A coarser company code cannot disprove applicability to a narrower target.
    uncertain = bool(selectors and (not available_code or any(
        target and target.startswith(available_code) and target != available_code for target in target_codes)))
    mismatch = bool(selectors and not matches and not uncertain)
    if selectors:
        values["industry_match"] = float(matches)
        evidence["industry_match"]["profile_pointers"] = ["/industry/okved_code", "/industry/okved_division"]
        field = "target_okved_codes" if targets else "subject_okved_codes"
        evidence["industry_match"]["event_pointers"] = ["/event_details/" + field]
        evidence["industry_match"]["extraction_evidence"] = [entry for entry in details["evidence"] if entry["field"] == field]
        evidence["industry_match"]["match_basis"] = "explicit_target_okved" if targets else "rule_subject_taxonomy"
        if subjects:
            evidence["industry_match"]["taxonomy_version"] = details["taxonomy_version"]
    if mismatch:
        # A shared region or customs country does not override explicit industry
        # eligibility. Directly named companies remain separate evidence.
        values["country_match"] = values["region_match"] = 0.0

    products, trade = profile.get("bank_products", {}), profile.get("foreign_trade", {})
    trade_direction = trade.get("trade_direction")
    roles = {
        "borrower": products.get("loan"), "depositor": products.get("deposit"),
        # Customs participation, countries, OKVED and payment direction do not
        # establish whether a company imports, exports, buys or sells this item.
        "importer": True if trade_direction in {"import", "importer", "both"} else None,
        "exporter": True if trade_direction in {"export", "exporter", "both"} else None,
        "buyer": None, "seller": None,
    }
    target_roles = details.get("target_roles", [])
    role_states = [roles[role] for role in target_roles]
    role_match = any(value is True for value in role_states)
    role_unknown = bool(role_states and not role_match and any(value is None for value in role_states))
    role_mismatch = bool(role_states and all(value is False for value in role_states))
    # Timing receives weight only if some independently represented company
    # connection exists; an unrelated upcoming deadline must not rise by itself.
    applicability = max(values[name] for name in (
        "rate_financing", "rate_deposit", "fx_trade", "industry_match", "country_match", "region_match",
        "direct_company_match", "related_company_match", "graph_in_share", "graph_out_share"))
    effective = details.get("effective_at")
    days = (timestamp(effective) - timestamp(as_of)).total_seconds() / 86400 if effective else None
    additions = {
        "rate_hold_financing": financing * float(direction == "unchanged"),
        "rate_hold_deposit": deposit * float(direction == "unchanged"),
        "rate_magnitude_financing": financing * strength,
        "rate_magnitude_deposit": deposit * strength,
        "rate_direction_unknown": float(rate and direction == "unknown"),
        "rate_magnitude_unknown": float(rate and direction in {"increase", "decrease"} and not known_magnitude),
        "industry_exact_match": float(bool(targets) and matches and any(target and len(target) > 2 and available_code.startswith(target)
                                                      for target in target_codes)),
        "industry_target_mismatch": float(bool(targets) and mismatch),
        "industry_target_unknown": float(bool(targets) and not matches and uncertain),
        "industry_subject_match": float(bool(subjects) and matches),
        "industry_subject_mismatch": float(bool(subjects) and mismatch),
        "industry_subject_unknown": float(bool(subjects) and not matches and uncertain),
        "target_role_match": float(role_match), "target_role_mismatch": float(role_mismatch),
        "target_role_unknown": float(role_unknown),
        "applicable_deadline_30d": applicability * float(days is not None and 0 < days <= 30 and status != "forecast"),
        "applicable_effective": applicability * float(days is not None and days <= 0 and status != "forecast"),
        "applicable_forecast": applicability * float(status == "forecast"),
        "effective_date_unknown": float(effective is None),
    }
    pointers = {
        "rate_hold_financing": ["/bank_products/loan", "/bank_products/leasing", "/bank_products/factoring"],
        "rate_hold_deposit": ["/bank_products/deposit"],
        "rate_magnitude_financing": ["/bank_products/loan", "/bank_products/leasing", "/bank_products/factoring"],
        "rate_magnitude_deposit": ["/bank_products/deposit"],
        "industry_exact_match": ["/industry/okved_code"], "industry_target_mismatch": ["/industry"],
        "industry_target_unknown": ["/industry"],
        "industry_subject_match": ["/industry"], "industry_subject_mismatch": ["/industry"],
        "industry_subject_unknown": ["/industry"],
        "target_role_match": ["/bank_products/loan", "/bank_products/deposit", "/foreign_trade/trade_direction"],
        "target_role_mismatch": ["/bank_products/loan", "/bank_products/deposit", "/foreign_trade/trade_direction"],
        "target_role_unknown": ["/bank_products/loan", "/bank_products/deposit", "/foreign_trade/trade_direction"],
    }
    fields = {
        "rate_hold_financing": {"direction"}, "rate_hold_deposit": {"direction"},
        "rate_magnitude_financing": {"direction", "magnitude", "magnitude_unit"},
        "rate_magnitude_deposit": {"direction", "magnitude", "magnitude_unit"},
        "rate_direction_unknown": {"direction"}, "rate_magnitude_unknown": {"direction", "magnitude", "magnitude_unit"},
        "industry_exact_match": {"target_okved_codes"}, "industry_target_mismatch": {"target_okved_codes"},
        "industry_target_unknown": {"target_okved_codes"}, "target_role_match": {"target_roles"},
        "industry_subject_match": {"subject_okved_codes"}, "industry_subject_mismatch": {"subject_okved_codes"},
        "industry_subject_unknown": {"subject_okved_codes"},
        "target_role_mismatch": {"target_roles"}, "target_role_unknown": {"target_roles"},
        "applicable_deadline_30d": {"effective_at", "decision_status"},
        "applicable_effective": {"effective_at", "decision_status"}, "applicable_forecast": {"decision_status"},
        "effective_date_unknown": {"effective_at"},
    }
    for name, value in additions.items():
        cited = [entry for entry in details.get("evidence", []) if entry["field"] in fields[name]]
        source_ids = {sid for entry in cited for sid in entry["source_ids"]}
        sources = [source for source in event["sources"] if source.get("id") in source_ids] if cited else event["sources"]
        evidence[name] = {"profile_pointers": pointers.get(name, []), "news_sources": sources,
                          "event_pointers": ["/event_details/" + field for field in sorted(fields[name])], "extraction_evidence": cited,
                          "graph_pointer": None}
        if name.startswith("industry_subject_") and subjects:
            evidence[name].update(match_basis="rule_subject_taxonomy", taxonomy_version=details["taxonomy_version"])
        values[name] = value


def baseline_score(values, feature_version=None):
    """Explicit untrained comparison baseline, inspired by existing theme priorities."""
    version = feature_version or infer_feature_version(values)
    if set(values) != set(feature_names(version)):
        raise ValueError("Feature names do not match the requested feature version")
    return sum(values[name] * weight for name, weight in zip(feature_names(version), feature_weights(version)))


def baseline_explain(features):
    version = features["version"]
    if infer_feature_version(features["values"]) != version:
        raise ValueError("Feature version does not match values")
    return sorted([
        {"feature": name, "value": features["values"][name], "coefficient": weight,
         "contribution": weight * features["values"][name], "scale": "raw_score",
         "evidence": features["evidence"][name]}
        for name, weight in zip(feature_names(version), feature_weights(version)) if features["values"][name] != 0
    ], key=lambda row: (-abs(row["contribution"]), row["feature"]))
