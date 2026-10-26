"""Build a tiny Node-compatible dataset from existing synthetic fixtures."""
import gzip
import json
from pathlib import Path
from .contracts import ROOT


def node_fixture(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for source, name in [("companies.csv", "df_Uid_data_hack.csv"), ("links.csv", "df_Fid_Uid_link_hack.csv"), ("payments.csv", "df_Uid_payment_hack.csv")]:
        raw = (ROOT / "tests/fixtures/company_context" / source).read_bytes()
        (destination / (name + ".gz")).write_bytes(gzip.compress(raw, mtime=0))
    events = json.loads((ROOT / "integration/fixtures/events.json").read_text())
    news = [{"id": e["news_id"], "title": e["title"], "text": e["text"], "published": e["published_at"],
             "url": e["sources"][0]["url"], "tags": []} for e in events]
    research = json.loads((ROOT / "integration/fixtures/research.json").read_text())
    research = [{**s, "id": s["id"].removeprefix("research:"), "text": s["excerpt"]} for s in research]
    (destination / "demo_news.json").write_text(json.dumps(news, ensure_ascii=False))
    (destination / "research.json").write_text(json.dumps(research, ensure_ascii=False))
    return destination
