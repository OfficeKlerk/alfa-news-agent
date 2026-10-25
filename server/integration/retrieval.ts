import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";
import type { Store } from "../db.js";
import type { Retrieval } from "../retrieval.js";
import type { Settings } from "../config.js";
import type { NewsCollector } from "../news-collector.js";
import { saveNews, ingestFeeds } from "../news.js";
import { articleToEvent, clusterEvents, newsArticlesAsOf, normalizePublicationDate } from "../news-events.js";
import { ApiFault, envelope, validate, type Envelope } from "./contracts.js";
import { ContractClient } from "./client.js";
import { sourceBalancedCandidates } from "./news-candidates.js";

export interface RetrievalPort {
  search(body: Json, requestId: string): Promise<Envelope>;
  rag(body: Json, requestId: string): Promise<Envelope>;
  resolve(body: Json, requestId: string): Promise<Envelope>;
  ingest?(body: Json, requestId: string): Promise<Envelope>;
  refresh?(body: Json, requestId: string): Promise<Envelope>;
  status?(requestId: string): Promise<Envelope>;
}
export class HttpRetrieval implements RetrievalPort {
  constructor(private client: ContractClient) {}
  search(body: Json, id: string) { return this.client.call("/v1/tools/search_news", "SearchDataResponse", id, body); }
  rag(body: Json, id: string) { return this.client.call("/v1/tools/rag_bank_analytics", "RagDataResponse", id, body); }
  resolve(body: Json, id: string) { return this.client.call("/v1/tools/resolve_sources", "ResolveDataResponse", id, body); }
  ingest(body: Json, id: string) { return this.client.call("/v1/news", "IngestDataResponse", id, body); }
  // Five configured feeds may each consume their 20-second deadline.
  refresh(body: Json, id: string) { return this.client.call("/v1/feeds/refresh", "FeedRefreshDataResponse", id, body, {}, 120_000); }
  status(id: string) { return this.client.call("/v1/feeds/status", "FeedStatusDataResponse", id); }
}
export class MockRetrieval implements RetrievalPort {
  private events: Json[] = JSON.parse(readFileSync(resolve(ROOT, "integration/fixtures/events.json"), "utf8"));
  private research: Json[] = JSON.parse(readFileSync(resolve(ROOT, "integration/fixtures/research.json"), "utf8"));
  async search(body: Json, id: string) {
    const items = this.events.filter(e => Date.parse(e.published_at) <= Date.parse(body.as_of) && (!body.news_id || e.news_id === body.news_id) && (!body.query || (e.title + " " + e.text).toLowerCase().includes(body.query.toLowerCase()))).slice(0, body.limit);
    return envelope({ items }, id, "mock", ["synthetic_news"]);
  }
  async rag(body: Json, id: string) {
    return envelope({ items: this.research.filter(s => Date.parse(s.published_at) <= Date.parse(body.as_of)).slice(0, body.limit), limitations: ["Синтетический корпус; не является аналитикой банка"] }, id, "mock", ["synthetic_bank_corpus"]);
  }
  async resolve(body: Json, id: string) {
    const registry = new Map<string, Json>([...this.events.flatMap(e => e.sources), ...this.research].map(s => [s.id, s]));
    const items = body.source_ids.map((key: string) => registry.get(key)).filter((s: Json | undefined) => s && s.published_at && Date.parse(s.published_at) <= Date.parse(body.as_of));
    const found = new Set(items.map((s: Json) => s.id));
    return envelope({ items, unknown_ids: body.source_ids.filter((key: string) => !found.has(key)) }, id, "mock", ["synthetic_source_registry"]);
  }
}
const date = (value: unknown) => normalizePublicationDate(value).value;

/** SQLite projection with publication-time filtering and source-preserving event clustering. */
export class LegacyRetrieval implements RetrievalPort {
  constructor(private db: Store, private retrieval: Retrieval, private settings: Settings = db.settings, private collector?: NewsCollector, private allowSynthetic = true) {}
  private articles(asOf: string, newsId?: string): Json[] {
    return newsArticlesAsOf(this.db, asOf, newsId);
  }
  async search(body: Json, id: string) {
    const articles = this.articles(body.as_of);
    // Build the complete cluster before selecting a publication window, otherwise
    // candidate and worker lookups would disagree on their evidence/revision hash.
    const events = articles.map(articleToEvent).filter((event): event is Json => event !== null && (this.allowSynthetic || !event.is_mock));
    const requested = body.news_id ? events.find(event=>event.news_id===body.news_id) : undefined;
    const candidates = clusterEvents(body.news_id ? events.filter(event=>event.event_id===requested?.event_id) : events)
      .filter(event=>!body.since || body.news_id || Date.parse(event.published_at)>=Date.parse(body.since))
      .filter(event => !body.query || [event.title, event.text, ...event.sources.map((s: Json) => s.excerpt)].join(" ").toLowerCase().includes(body.query.toLowerCase()));
    // A worker must receive the same complete event cluster as candidate search;
    // the requested logical article ID continues to bind its job/card history.
    if (body.news_id) for (const event of candidates) event.news_id=body.news_id;
    const selection = body.news_id ? { items: candidates.slice(0, body.limit), balanced: false } : sourceBalancedCandidates(candidates, body.candidate_limit ?? body.limit);
    const offset = body.offset ?? 0;
    const items = selection.items.slice(offset, offset + body.limit);
    for (const event of items) validate("Event", event, true);
    const shown = new Set(items.flatMap(e => e.sources.map((s: Json) => s.id)));
    const contentWarnings = articles.filter(a => shown.has(a.source_id)).flatMap(a => (a.warnings ?? [])
      .filter((warning: string) => ["rss_excerpt_only_full_article_not_fetched", "source_text_truncated_18000"].includes(warning)));
    return envelope({ items, total_candidates: selection.items.length, next_offset: offset + items.length < selection.items.length ? offset + items.length : null }, id, items.some(e => e.is_mock) ? "mock" : "live", [...new Set(["conservative_rule_extraction", "undated_invalid_future_news_excluded", "date_only_news_assume_utc_end_of_day", ...(selection.balanced ? ["source_balanced_candidate_window"] : []), ...contentWarnings])]);
  }
  async ingest(body: Json, id: string) {
    const saved = saveNews(this.db, body);
    const item = saved.date_status === "valid" && (!saved.available_at || Date.parse(saved.available_at) <= Date.now()) ? articleToEvent(saved) : null;
    if (item) validate("Event", item, true);
    return envelope({ item, news_id: saved.id, date_status: saved.date_status, ingestion_status: saved.ingestion_status, warnings: saved.warnings }, id, "live", saved.warnings);
  }
  async refresh(_body: Json, id: string) {
    return envelope(await (this.collector ? this.collector.refresh() : ingestFeeds(this.settings, this.db)), id, "live");
  }
  async status(id: string) {
    if (!this.collector) throw new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "Collector status is unavailable");
    return envelope(this.collector.status(), id, "live");
  }
  async rag(body: Json, id: string) {
    const items = this.retrieval.research(body.query, body.limit, body.as_of).map(doc => ({ id: "research:" + doc.id, kind: "bank", title: doc.title,
      url: doc.url, excerpt: doc.text, document_id: doc.document_id, page: doc.page, published_at: date(doc.published_at ?? doc.published ?? doc.date), is_mock: false }))
      .filter(doc => doc.published_at !== null && Date.parse(doc.published_at) <= Date.parse(body.as_of));
    return envelope({ items, limitations: ["Лексический поиск исходного прототипа; недатированные и будущие страницы исключены до выбора первых результатов."] }, id, "live", ["legacy_lexical_search", "undated_bank_pages_excluded", "date_only_bank_sources_assume_utc_end_of_day"]);
  }
  async resolve(body: Json, id: string) {
    const items: Json[] = [], unknown_ids: string[] = [];
    for (const key of body.source_ids as string[]) {
      let source: Json | undefined;
      if (key.startsWith("news:")) {
        try {
          const match = /^news:([^:]+)(?::([^:]+))?$/.exec(key);
          if (match?.[2]) {
            const row = this.db.get("SELECT payload FROM news_versions WHERE news_id=? AND version_id=? AND available_at<=?", match[1], match[2], new Date(body.as_of).toISOString());
            const article = row ? JSON.parse(row.payload) : null;
            if (article && Date.parse(article.published) <= Date.parse(body.as_of)) source = articleToEvent(article)?.sources[0];
          } else if (match) {
            source = articleToEvent(this.articles(body.as_of, match[1])[0] ?? {})?.sources[0];
            if (source) source = { ...source, id: key };
          }
        } catch (error) { if (!(error instanceof Error && "status" in error && error.status === 404)) throw error; }
      } else if (key.startsWith("research:")) {
        const match = /^(.*):c(\d+)$/.exec(key.slice(9));
        if (match) {
          const row = this.db.get("SELECT payload FROM research WHERE id=?", match[1]);
          if (row) {
            const doc = JSON.parse(row.payload), start = Number(match[2]), publishedAt = date(doc.published_at ?? doc.published ?? doc.date);
            if (publishedAt && start % 1400 === 0 && start < doc.text.length && Date.parse(publishedAt) <= Date.parse(body.as_of)) source = {
              id: key, kind: "bank", title: doc.title, url: doc.url, excerpt: doc.text.slice(Math.max(0, start - 150), start + 1600),
              document_id: doc.document_id, page: doc.page, published_at: publishedAt, is_mock: false,
            };
          }
        }
      }
      if (source && (this.allowSynthetic || !source.is_mock)) items.push(source); else unknown_ids.push(key);
    }
    return envelope({ items, unknown_ids }, id, items.some(s => s.is_mock) ? "mock" : "live", ["undated_bank_pages_excluded"]);
  }
}
