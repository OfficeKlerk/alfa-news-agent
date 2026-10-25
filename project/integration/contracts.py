import json
from pathlib import Path
from datetime import datetime
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "contracts/v1/schema.json").read_text(encoding="utf-8"))
FORMATS = FormatChecker()


@FORMATS.checks("date-time")
def datetime_with_zone(value):
    if not isinstance(value, str):
        return True
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def validate(name, value):
    schema = {"$ref": f"#/$defs/{name}", "$defs": SCHEMA["$defs"]}
    Draft202012Validator(schema, format_checker=FORMATS).validate(value)
    from news_analysis.contracts import validated_event_details
    from integration.payment_context import validate_payment_context
    def visit(node):
        if isinstance(node, list):
            for item in node:
                visit(item)
        elif isinstance(node, dict):
            if all(key in node for key in ("company_id", "schema_version", "payment_summary", "industry")):
                try:
                    validate_payment_context(node)
                except ValueError as error:
                    # The HTTP boundary must report invalid provider output as 502,
                    # not misclassify a corrupt aggregate as a caller's 422 error.
                    raise ValidationError(str(error)) from error
            if all(key in node for key in ("news_id", "event_id", "event_type", "sources")):
                validated_event_details(node)
            for item in node.values():
                visit(item)
    visit(value)
    return value


def envelope(data, request_id, mode="mock", warnings=()):
    return {"meta": {"schema_version": "1.0.0", "request_id": request_id,
                     "mode": mode, "warnings": list(warnings)}, "data": data}
