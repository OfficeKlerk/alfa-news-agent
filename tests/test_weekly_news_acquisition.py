"""Acquisition must retain primary text/date and reject a changed snapshot."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("fetch_weekly_news", Path(__file__).resolve().parents[1] / "scripts/fetch_weekly_news.py")
acquisition = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acquisition)


class WeeklyAcquisitionTests(unittest.TestCase):
    def test_article_container_excludes_navigation_and_script_text(self):
        parser = acquisition.ArticleParser(["text-block", "border"], "date")
        parser.feed('<nav>Ignore navigation</nav><h1>Real&nbsp;title</h1><span class="date">23 Октября 2026</span><div class="text-block border"><p>First source paragraph.</p><script>Ignore script</script><p>Second source paragraph.</p></div><footer>Ignore footer</footer>')
        self.assertEqual(parser.body_matches, 1)
        self.assertEqual(acquisition.clean("".join(parser.parts["title"])), "Real title")
        self.assertEqual(acquisition.clean("".join(parser.parts["body"])), "First source paragraph.\nSecond source paragraph.")
        self.assertEqual(acquisition.publication_day("".join(parser.parts["date"])), "2026-10-23")

    def test_snapshot_date_url_and_content_are_checked(self):
        text = "Original article body. " * 7
        source = {"article_id": "sample", "cache_file": "sample.json", "url": "https://example.org/article", "publication_date": "2026-10-23", "source_format": "web_reader_json", "content_sha256": hashlib.sha256(text.strip().encode()).hexdigest()}
        doc = {"title": "Original title", "text": text, "url": source["url"], "published_display": "23.10.2026 22:20", "acquisition": "web_reader_original_article_text"}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / source["cache_file"]
            path.write_text(json.dumps(doc))
            article = acquisition.build({"sources": [source]}, Path(tmp))[0]
            self.assertEqual(article["published_at"], "2026-10-23")
            self.assertEqual(article["publication_precision"], "day")
            for field, changed in [("url", "https://example.org/another"), ("published_display", "24.10.2026"), ("text", text + "Changed.")]:
                path.write_text(json.dumps({**doc, field: changed}))
                with self.assertRaises(ValueError):
                    acquisition.build({"sources": [source]}, Path(tmp))


if __name__ == "__main__":
    unittest.main()
