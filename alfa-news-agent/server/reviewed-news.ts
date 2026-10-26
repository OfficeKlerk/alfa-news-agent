import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Store } from "./db.js";
import type { Json } from "./types.js";
import { canonicalUrl, normalizePublicationDate } from "./news-events.js";
import { saveNews } from "./news.js";

export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const reviewedRecordHash = (article: Json) => textHash(JSON.stringify([
  article.title, article.url, article.published, article.text,
]));

/** A checked-in, explicitly excerpted source snapshot; no network or LLM at startup. */
export function readReviewedNews(file: string): Json[] {
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  if (bundle.schema_version !== "reviewed_primary_news_v1" || !Array.isArray(bundle.articles) ||
      !bundle.articles.length || bundle.articles.length > 100) throw new Error("Invalid reviewed news bundle");
  const ids = new Set<string>(), urls = new Set<string>();
  for (const item of bundle.articles as Json[]) {
    if (!item || typeof item !== "object" || typeof item.article_id !== "string" || ids.has(item.article_id) ||
        typeof item.title !== "string" || item.title.trim().length < 5 || item.title.length > 300 ||
        typeof item.text !== "string" || item.text.trim().length < 30 || item.text.length > 18000 ||
        typeof item.url !== "string" || !item.url.startsWith("https://") || canonicalUrl(item.url) !== item.url || urls.has(item.url) ||
        item.is_mock !== false || item.text_kind !== "primary_excerpt" || item.publication_precision !== "day" ||
        typeof item.published !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.published) ||
        normalizePublicationDate(item.published).status !== "valid" ||
        typeof item.publisher !== "string" || !item.publisher.trim() ||
        typeof item.published_display !== "string" || !item.published_display.trim() ||
        typeof item.reviewed_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.reviewed_on) ||
        item.content_sha256 !== textHash(item.text) || item.record_sha256 !== reviewedRecordHash(item) ||
        typeof item.raw_html_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.raw_html_sha256)) {
      throw new Error("Invalid reviewed primary article or snapshot checksum");
    }
    ids.add(item.article_id); urls.add(item.url);
  }
  return bundle.articles;
}

/** Install missing reviewed snapshots in existing and new DBs, preserving later editorial revisions. */
export function importReviewedNews(db: Store, file: string) {
  if (!existsSync(file)) return { inserted: 0, preserved: 0 };
  const articles = readReviewedNews(file); // Validate the whole bundle before writing any article.
  let inserted = 0, preserved = 0;
  for (const article of articles) {
    const identity = "url:" + canonicalUrl(article.url);
    if (db.get("SELECT news_id FROM news_metadata WHERE identity=?", identity) ||
        db.get("SELECT id FROM news WHERE url=?", article.url)) {
      preserved++;
      continue;
    }
    saveNews(db, article);
    inserted++;
  }
  return { inserted, preserved };
}
