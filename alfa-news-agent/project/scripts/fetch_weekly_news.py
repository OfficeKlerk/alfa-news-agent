#!/usr/bin/env python3
"""Build the private weekly audit corpus from cached primary-source articles.

Default: use the already acquired HTML / web-reader JSON. --fetch refreshes only
HTML through curl with normal TLS verification. Full text may only be written
under ignored var/; the checked-in registry contains source metadata only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
BLOCK = {"p", "div", "section", "article", "br", "li", "h1", "h2", "h3", "h4", "table", "tr"}
SKIP = {"script", "style", "nav", "footer", "form", "button"}
MONTHS = {name: i for i, name in enumerate("января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split(), 1)}


def clean(value: str) -> str:
    return "\n".join(line for row in value.replace("\xa0", " ").splitlines() if (line := re.sub(r"\s+", " ", row).strip()))


def publication_day(value: str) -> str:
    match = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", value)
    if match:
        day, month, year = map(int, match.groups())
    else:
        match = re.search(r"(\d{1,2})\s+(" + "|".join(MONTHS) + r")\s+(\d{4})", value.lower())
        if not match:
            raise ValueError(f"Unrecognized publication date: {value!r}")
        day, month_name, year = match.groups()
        day, month, year = int(day), MONTHS[month_name], int(year)
    return date(year, month, day).isoformat()


class ArticleParser(HTMLParser):
    def __init__(self, body_classes: list[str], date_class: str):
        super().__init__(convert_charrefs=True)
        self.body_classes = set(body_classes)
        self.date_class = date_class
        self.stack: list[tuple[str, set[str]]] = []
        self.parts: dict[str, list[str]] = {"title": [], "body": [], "date": []}
        self.body_matches = 0

    def active(self) -> set[str]:
        return set().union(*(flags for _, flags in self.stack)) if self.stack else set()

    def handle_starttag(self, tag, attrs):
        classes = set(dict(attrs).get("class", "").split())
        flags = set()
        if tag == "h1":
            flags.add("title")
        if self.body_classes <= classes:
            flags.add("body")
            self.body_matches += 1
        if self.date_class in classes:
            flags.add("date")
        if tag in SKIP:
            flags.add("skip")
        active = self.active() | flags
        if tag in BLOCK and "skip" not in active:
            for key in active & self.parts.keys():
                self.parts[key].append("\n")
        if tag not in VOID:
            self.stack.append((tag, flags))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        active = self.active()
        if tag in BLOCK and "skip" not in active:
            for key in active & self.parts.keys():
                self.parts[key].append("\n")
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, value):
        active = self.active()
        if "skip" not in active:
            for key in active & self.parts.keys():
                self.parts[key].append(value)


def build(registry: dict, cache_dir: Path, fetch: bool = False) -> list[dict]:
    articles = []
    for source in registry["sources"]:
        cache = cache_dir / source["cache_file"]
        if fetch and source["source_format"] == "html":
            subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "60", source["url"], "--output", str(cache)], check=True)
        raw = cache.read_bytes()
        if source["source_format"] == "html":
            parser = ArticleParser(source["body_classes"], source["date_class"])
            parser.feed(raw.decode("utf-8-sig"))
            if parser.body_matches != 1:
                raise ValueError(f"{source['article_id']}: expected one article body, found {parser.body_matches}")
            title = clean("".join(parser.parts["title"]))
            text = clean("".join(parser.parts["body"]))
            displayed_date = clean("".join(parser.parts["date"]))
            acquisition = "primary_html_cache"
        else:
            document = json.loads(raw)
            if document["url"] != source["url"]:
                raise ValueError(f"{source['article_id']}: cached URL mismatch")
            title, text = clean(document["title"]), clean(document["text"])
            displayed_date = document["published_display"]
            acquisition = document["acquisition"]
        published_at = publication_day(displayed_date)
        if published_at != source["publication_date"]:
            raise ValueError(f"{source['article_id']}: publication date changed ({published_at}); do not silently reuse a mutable source URL")
        if not title or len(text) < 100:
            raise ValueError(f"{source['article_id']}: missing title or suspiciously short article")
        content_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if source.get("content_sha256") and source["content_sha256"] != content_sha256:
            raise ValueError(f"{source['article_id']}: extracted content differs from the reviewed source snapshot")
        articles.append({
            "article_id": source["article_id"], "title": title, "text": text,
            "url": source["url"], "published_at": published_at,
            "publication_precision": "day", "text_kind": "primary_article_text",
            "acquisition": acquisition, "published_display": displayed_date,
            "content_sha256": content_sha256,
            "raw_sha256": hashlib.sha256(raw).hexdigest(),
        })
    return articles


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--registry", type=Path, default=ROOT / "data/weekly_audit_20261024/sources.json")
    args.add_argument("--cache-dir", type=Path, default=ROOT / "var/weekly-audit-20261024")
    args.add_argument("--output", type=Path, default=ROOT / "var/weekly-audit-20261024/articles.json")
    args.add_argument("--fetch", action="store_true")
    opt = args.parse_args()
    if not opt.output.resolve().is_relative_to((ROOT / "var").resolve()):
        raise SystemExit("Full source text output must stay under ignored repository var/.")
    registry = json.loads(opt.registry.read_text())
    articles = build(registry, opt.cache_dir, opt.fetch)
    opt.output.parent.mkdir(parents=True, exist_ok=True)
    opt.output.write_text(json.dumps(articles, ensure_ascii=False, indent=2) + "\n")
    for item in articles:
        print(f"{item['article_id']} {item['published_at']} {len(item['text'])} chars {item['content_sha256']}")
    print(f"Wrote {len(articles)} primary articles to {opt.output}")


if __name__ == "__main__":
    main()
