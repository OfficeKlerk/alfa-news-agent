"""Контрактный тест: demo_news.json валиден по contracts/v1 (Event + Evidence).

Защищает fixture от случайной порчи: если кто-то добавит новость без
обязательного поля или с недопустимым event_type, тест упадёт. Зависимостей нет
(не требует jsonschema) — проверка строится по самому файлу схемы, поэтому
изменения контракта автоматически учитываются.

Запуск:
    python -m pytest tests/test_demo_news_contract.py -q
    # или без pytest:
    python tests/test_demo_news_contract.py
"""

import json
from pathlib import Path


def _find_repo_root(start: Path) -> Path:
    for parent in [start, *start.parents]:
        if (parent / "contracts" / "v1" / "schema.json").exists():
            return parent
    raise FileNotFoundError("Не найден contracts/v1/schema.json выше " + str(start))


def _load():
    root = _find_repo_root(Path(__file__).resolve().parent)
    schema = json.loads((root / "contracts" / "v1" / "schema.json").read_text(encoding="utf-8"))["$defs"]
    candidates = [root / "data" / "demo" / "demo_news.json", root / "demo" / "demo_news.json"]
    fixture_path = next((p for p in candidates if p.exists()), None)
    if fixture_path is None:
        raise FileNotFoundError("Не найден demo_news.json в data/demo/ или demo/")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    return schema, fixture


def _validate_event(event, schema):
    errors = []
    ev_def = schema["Event"]
    for field in ev_def["required"]:
        if field not in event:
            errors.append(f"missing required field '{field}'")
    et = ev_def["properties"]["event_type"].get("enum", [])
    if event.get("event_type") not in et:
        errors.append(f"event_type '{event.get('event_type')}' not in {et}")
    fs = ev_def["properties"]["fact_status"].get("enum", [])
    if event.get("fact_status") not in fs:
        errors.append(f"fact_status '{event.get('fact_status')}' not in {fs}")
    for field in ("okved_divisions", "countries", "regions", "company_ids"):
        if not isinstance(event.get(field), list):
            errors.append(f"'{field}' must be a list")
    sources = event.get("sources")
    if not isinstance(sources, list) or len(sources) < 1:
        errors.append("'sources' must have at least one item")
    else:
        for i, src in enumerate(sources):
            for field in schema["Evidence"]["required"]:
                if field not in src:
                    errors.append(f"source[{i}] missing '{field}'")
            if src.get("kind") != "news":
                errors.append(f"source[{i}] kind must be 'news'")
    return errors


def test_demo_news_valid_against_contract():
    schema, fixture = _load()
    assert isinstance(fixture.get("events"), list) and fixture["events"], "no events in fixture"
    all_errors = {}
    for event in fixture["events"]:
        errs = _validate_event(event, schema)
        if errs:
            all_errors[event.get("news_id", "<no id>")] = errs
    assert not all_errors, "Нарушения контракта: " + json.dumps(all_errors, ensure_ascii=False, indent=2)


def test_news_ids_unique():
    _, fixture = _load()
    ids = [e.get("news_id") for e in fixture["events"]]
    assert len(ids) == len(set(ids)), f"Дубли news_id: {ids}"


if __name__ == "__main__":
    test_demo_news_valid_against_contract()
    test_news_ids_unique()
    print("OK: demo_news.json валиден по контракту, news_id уникальны")
