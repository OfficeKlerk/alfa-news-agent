import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";
import type { Store } from "../db.js";
import type { Retrieval } from "../retrieval.js";
import type { Settings } from "../config.js";
import { saveNews, ingestFeeds } from "../news.js";
import { articleToEvent, clusterEvents, newsArticlesAsOf, normalizePublicationDate } from "../news-events.js";
import { ApiFault, envelope, validate, type Envelope } from "./contracts.js";
import { ContractClient } from "./client.js";

export interface RetrievalPort {
  search(body: Json, requestId: string): Promise<Envelope>;
  rag(body: Json, requestId: string): Promise<Envelope>;
  resolve(body: Json, requestId: string): Promise<Envelope>;
  ingest?(body: Json, requestId: string): Promise<Envelope>;
  refresh?(body: Json, requestId: string): Promise<Envelope>;
}
export class HttpRetrieval implements RetrievalPort {
  constructor(private client: ContractClient) {}
  search(body: Json, id: string) { return this.client.call("/v1/tools/search_news", "SearchDataResponse", id, body); }
  rag(body: Json, id: string) { return this.client.call("/v1/tools/rag_bank_analytics", "RagDataResponse", id, body); }
  resolve(body: Json, id: string) { return this.client.call("/v1/tools/resolve_sources", "ResolveDataResponse", id, body); }
  ingest(body: Json, id: string) { return this.client.call("/v1/news", "IngestDataResponse", id, body); }
  refresh(body: Json, id: string) { return this.client.call("/v1/feeds/refresh", "FeedRefreshDataResponse", id, body); }
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
  constructor(private db: Store, private retrieval: Retrieval, private settings: Settings = db.settings) {}
  private articles(asOf: string, newsId?: string): Json[] {
    return newsArticlesAsOf(this.db, asOf, newsId);
  }
  async search(body: Json, id: string) {
    const events = this.articles(body.as_of, body.news_id).map(articleToEvent).filter((event): event is Json => event !== null);
    const items = clusterEvents(events).filter(event => !body.query || [event.title, event.text, ...event.sources.map((s: Json) => s.excerpt)].join(" ").toLowerCase().includes(body.query.toLowerCase())).slice(0, body.limit);
    for (const event of items) validate("Event", event, true);
    return envelope({ items }, id, items.some(e => e.is_mock) ? "mock" : "live", ["conservative_rule_extraction", "undated_invalid_future_news_excluded", "date_only_news_assume_utc_end_of_day"]);
  }
  async ingest(body: Json, id: string) {
    const saved = saveNews(this.db, body);
    const item = saved.date_status === "valid" && (!saved.available_at || Date.parse(saved.available_at) <= Date.now()) ? articleToEvent(saved) : null;
    if (item) validate("Event", item, true);
    return envelope({ item, news_id: saved.id, date_status: saved.date_status, ingestion_status: saved.ingestion_status, warnings: saved.warnings }, id, "live", saved.warnings);
  }
  async refresh(_body: Json, id: string) {
    return envelope(await ingestFeeds(this.settings, this.db), id, "live");
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
      if (source) items.push(source); else unknown_ids.push(key);
    }
    return envelope({ items, unknown_ids }, id, items.some(s => s.is_mock) ? "mock" : "live", ["undated_bank_pages_excluded"]);
  }
}
