"""Validated input contracts. Text extraction belongs to the news/RAG component."""

import math
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

EVENT_TYPES = {"rate_change", "fx_change", "commodity_price_change", "trade_restriction",
               "regional_event", "company_event", "tax_change", "other"}


def finite(value, name, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}: expected a finite number")
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ValueError(f"{name}: outside allowed range [{minimum}, {maximum}]")
    return float(value)


def text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name}: expected a nonempty string")
    return value


def timestamp(value):
    text(value, "timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timestamps must include a timezone")
    return result.astimezone(timezone.utc)


def validate_event(event):
    if not isinstance(event, dict):
        raise ValueError("event must be an object")
    for key in ("news_id", "event_id", "title"):
        text(event.get(key), key)
    if event.get("event_type") not in EVENT_TYPES:
        raise ValueError("Unknown event_type")
    timestamp(event.get("published_at"))
    if event.get("event_at") is not None:
        timestamp(event["event_at"])
    for key in ("okved_divisions", "countries", "regions", "company_ids"):
        if not isinstance(event.get(key, []), list):
            raise ValueError(f"{key} must be a list")
        for item in event.get(key, []):
            text(item, key)
        if key == "okved_divisions" and any(not re.fullmatch(r"\d{2}", x) for x in event.get(key, [])):
            raise ValueError("okved_divisions must contain two-digit codes")
    if event.get("company_ids"):
        text(event.get("entity_mapping_source"), "entity_mapping_source")
    if not isinstance(event.get("sources"), list) or not event["sources"]:
        raise ValueError("Every event needs at least one source with an excerpt")
    source_ids = set()
    for source in event["sources"]:
        if not isinstance(source, dict):
            raise ValueError("Each source must be an object")
        if source.get("id") is not None:
            sid = text(source["id"], "source.id")
            if sid in source_ids:
                raise ValueError("Duplicate news source id")
            source_ids.add(sid)
        parsed = urlparse(text(source.get("url"), "source.url"))
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ValueError("Source URL must be HTTP(S)")
        text(source.get("excerpt"), "source.excerpt")
    if event.get("fact_status") not in {"reported", "confirmed", "disputed"}:
        raise ValueError("fact_status must be reported, confirmed or disputed")
    validated_event_details(event)
    return event


def validated_event_details(event):
    """Validate optional extracted fields and their traceable quotes, not causal truth.

    Percent is a relative change; percentage_points and bps are absolute rate deltas.
    A quoted field remains an extraction that may need human semantic review.
    """
    defaults = {"direction": "unknown", "magnitude": None, "magnitude_unit": "unknown",
                "effective_at": None, "decision_status": "unknown", "target_roles": [],
                "target_okved_codes": [], "evidence": []}
    if "event_details" not in event:
        return defaults
    details = event["event_details"]
    taxonomy_fields = {"subject_okved_codes", "taxonomy_origin", "taxonomy_version"}
    if (not isinstance(details, dict) or not set(defaults) <= set(details)
            or set(details) - set(defaults) - taxonomy_fields):
        raise ValueError("event_details must contain exactly the versioned detail fields")
    if set(details) & taxonomy_fields:
        if (not taxonomy_fields <= set(details) or details["taxonomy_origin"] != "rule_inference"
                or details["taxonomy_version"] != "business-subjects-v1"):
            raise ValueError("Subject taxonomy requires its declared inference origin and version")
    for field, choices in {
        "direction": {"increase", "decrease", "unchanged", "unknown"},
        "magnitude_unit": {"bps", "percentage_points", "percent", "unknown"},
        "decision_status": {"announced", "effective", "forecast", "unknown"},
    }.items():
        if not isinstance(details[field], str) or details[field] not in choices:
            raise ValueError("Unsupported event_details." + field)
    if details["magnitude"] is not None:
        finite(details["magnitude"], "event_details.magnitude", 0)
        if details["magnitude_unit"] == "unknown":
            raise ValueError("Magnitude requires a known unit")
    elif details["magnitude_unit"] != "unknown":
        raise ValueError("Magnitude unit without magnitude")
    if details["direction"] == "unchanged" and details["magnitude"] not in (None, 0):
        raise ValueError("Unchanged event direction contradicts a nonzero magnitude")
    if details["direction"] in {"increase", "decrease"} and details["magnitude"] == 0:
        raise ValueError("Changed event direction contradicts a zero magnitude")
    if details["effective_at"] is not None:
        timestamp(details["effective_at"])
    for field in ("target_roles", "target_okved_codes", "subject_okved_codes"):
        values = details.get(field, [])
        if not isinstance(values, list) or any(not isinstance(v, str) for v in values) or len(values) != len(set(values)):
            raise ValueError("Expected unique strings in " + field)
    if set(details["target_roles"]) - {"importer", "exporter", "buyer", "seller", "borrower", "depositor"}:
        raise ValueError("Unknown target role")
    if any(not re.fullmatch(r"\d{2}(?:\.\d{1,2}){0,2}", code)
           for field in ("target_okved_codes", "subject_okved_codes") for code in details.get(field, [])):
        raise ValueError("Invalid target OKVED code")
    sources = {source.get("id"): source for source in event.get("sources", []) if source.get("id")}
    allowed = (set(defaults) - {"evidence"}) | {"event_type", "event_at", "okved_divisions", "subject_okved_codes"}
    supported = set()
    if not isinstance(details["evidence"], list) or len(details["evidence"]) > 100:
        raise ValueError("Invalid event_details evidence array")
    for row in details["evidence"]:
        if not isinstance(row, dict) or set(row) != {"field", "quote", "source_ids"} or row["field"] not in allowed:
            raise ValueError("Invalid event_details evidence field")
        quote = text(row["quote"], "event_details.evidence.quote")
        ids = row["source_ids"]
        if len(quote) > 4000 or not isinstance(ids, list) or not ids or any(not isinstance(s, str) for s in ids) or len(ids) != len(set(ids)):
            raise ValueError("Invalid event_details evidence source_ids")
        if any(s not in sources or quote not in sources[s]["excerpt"] for s in ids):
            raise ValueError("Event evidence must quote each referenced source exactly")
        supported.add(row["field"])
    for field, value in details.items():
        if field not in {"evidence", "taxonomy_origin", "taxonomy_version"} and value is not None and value != "unknown" and value != [] and field not in supported:
            raise ValueError("Missing event evidence for " + field)
    return details


def normalized(values):
    return {x.strip().casefold().replace("ё", "е") for x in values if x}


def validate_source_availability(event, as_of):
    """A publication cannot expose evidence from a later revision.

    Legacy standalone events may lack source timestamps; retain that explicit
    compatibility case. New API sources carry revision availability in their
    published_at field, independently of the first article publication.
    """
    cutoff = timestamp(as_of)
    for source in event.get("sources", []):
        available_at = source.get("published_at")
        if available_at is not None and timestamp(available_at) > cutoff:
            raise ValueError("News source is available after as_of")


def deduplicate(events, as_of):
    """One item per upstream event cluster. Later reporting cannot leak backwards."""
    cutoff = timestamp(as_of)
    if not isinstance(events, (list, tuple)):
        raise ValueError("events must be an array")
    clusters, future = {}, []
    ids = set()
    for event in events:
        validate_event(event)
        if event["news_id"] in ids:
            raise ValueError("Duplicate news_id")
        ids.add(event["news_id"])
        if timestamp(event["published_at"]) > cutoff:
            future.append(event["news_id"])
            continue
        validate_source_availability(event, as_of)
        clusters.setdefault(event["event_id"], []).append(event)
    result = []
    for group in clusters.values():
        chosen = max(group, key=lambda e: (timestamp(e["published_at"]), e["news_id"]))
        # Keep the chosen extraction and its evidence together; do not silently merge claims.
        result.append(dict(chosen, duplicate_news_ids=sorted(e["news_id"] for e in group
                                                           if e["news_id"] != chosen["news_id"])))
    return result, future
