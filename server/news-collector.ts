import { randomUUID } from "node:crypto";
import type { Settings } from "./config.js";
import type { Store } from "./db.js";
import { AppError } from "./types.js";
import { emptyFeedResult, ingestFeed, mergeFeedResult, type FeedRefreshResult } from "./news.js";
import { configuredNewsSources, NewsSourceIngestor, type SourceSettings } from "./news-sources.js";

export interface NewsCollectorOptions {
  request?: typeof fetch;
  /** Milliseconds since epoch; injected only for deterministic tests. */
  now?: () => number;
  leaseMs?: number;
}
export interface NewsFeedStatus {
  url: string;
  name: string;
  kind: "rss" | "json" | "html";
  article_count: number;
  full_text_count: number;
  inline_full_text_count: number;
  excerpt_count: number;
  discovered_count: number;
  pending_full_text_count: number;
  full_text_errors: number;
  last_attempt: string | null;
  last_success: string | null;
  last_error: string | null;
  next_attempt: string | null;
  consecutive_failures: number;
}
export interface NewsCollectorStatus {
  enabled: boolean;
  running: boolean;
  poll_seconds: number;
  last_success: string | null;
  feeds: NewsFeedStatus[];
}

const iso = (value: unknown): string | null => typeof value === "number" ? new Date(value).toISOString() : null;
function publicFeedError(error: unknown): string {
  if (error instanceof AppError) return error.message.slice(0, 256);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "Истекло время ожидания RSS";
  return "Не удалось загрузить или обработать RSS";
}

/** One durable scheduler for manual refresh and background collection alike. */
export class NewsCollector {
  private readonly owner = randomUUID();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<FeedRefreshResult>;
  private cancel?: AbortController;
  private stopping = false;
  private readonly ingestor: NewsSourceIngestor;

  constructor(private readonly settings: Settings & SourceSettings, private readonly db: Store, options: NewsCollectorOptions = {}) {
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.leaseMs = Math.max(1000, options.leaseMs ?? 60000);
    this.ingestor = new NewsSourceIngestor(settings,db,options.request);
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS news_feed_state (
        url TEXT PRIMARY KEY, last_attempt INTEGER, last_success INTEGER,
        last_error TEXT, next_attempt INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS news_collector_lease (
        slot TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    this.syncFeeds();
  }

  private get urls(): string[] { return [...new Set(this.settings.feeds)].slice(0, 64); }
  private get pollMs(): number { return Math.max(1, this.settings.newsPollSeconds ?? 300) * 1000; }
  private syncFeeds(): void {
    for (const url of this.urls) this.db.run("INSERT OR IGNORE INTO news_feed_state(url) VALUES(?)", url);
  }

  /** Starts once, polls immediately, and does not keep an otherwise idle process alive. */
  start(): void {
    if (this.timer || !this.settings.newsEnabled) return;
    this.stopping = false;
    const poll = () => { void this.refresh({ force: false }).catch(() => { /* The lease owner or a later tick will retry. */ }); };
    poll();
    this.timer = setInterval(poll, Math.min(this.pollMs, 30000));
    this.timer.unref();
  }

  /** Manual refresh bypasses the due time, but shares the same lease and in-flight work. */
  refresh(options: { force?: boolean } = {}): Promise<FeedRefreshResult> {
    if (this.pending) return this.pending;
    if (this.stopping) return Promise.reject(new AppError("Сборщик новостей остановлен", 503));
    if (!this.urls.length) return Promise.reject(new AppError("RSS не настроен. Добавьте NEWS_FEEDS_JSON в .env."));
    this.syncFeeds();
    this.cancel = new AbortController();
    const task = this.collect(options.force ?? true, this.cancel.signal);
    this.pending = task;
    void task.finally(() => {
      if (this.pending === task) { this.pending = undefined; this.cancel = undefined; }
    }).catch(() => { /* The caller receives the original rejection. */ });
    return task;
  }

  status(): NewsCollectorStatus {
    const sources=configuredNewsSources(this.settings);
    const coverage=new Map(this.db.all(`SELECT json_extract(payload,'$.feed_url') url,COUNT(*) article_count,
      SUM(json_extract(payload,'$.content_scope')='article_full') full_text_count,
      SUM(json_extract(payload,'$.content_scope')='feed_content') inline_full_text_count,
      SUM(json_extract(payload,'$.content_scope')='feed_excerpt') excerpt_count FROM news_metadata
      GROUP BY json_extract(payload,'$.feed_url')`).map(row=>[row.url,row]));
    const backlogs=new Map(this.db.all(`SELECT feed_url,COUNT(*) discovered_count,
      SUM(next_attempt=0 OR last_error IS NOT NULL) pending_full_text_count,
      SUM(last_error IS NOT NULL) full_text_errors FROM news_article_backlog GROUP BY feed_url`).map(row=>[row.feed_url,row]));
    const feeds = this.urls.map(url => {
      const row = this.db.get("SELECT * FROM news_feed_state WHERE url=?", url);
      const source=sources.find(s=>s.url===url)!, counts=coverage.get(url), backlog=backlogs.get(url);
      return { url,name:source.name,kind:source.kind,
        article_count:Number(counts?.article_count ?? 0),full_text_count:Number(counts?.full_text_count ?? 0),
        inline_full_text_count:Number(counts?.inline_full_text_count ?? 0),excerpt_count:Number(counts?.excerpt_count ?? 0),
        discovered_count:Number(backlog?.discovered_count ?? 0),pending_full_text_count:Number(backlog?.pending_full_text_count ?? 0),
        full_text_errors:Number(backlog?.full_text_errors ?? 0),
        last_attempt: iso(row?.last_attempt), last_success: iso(row?.last_success),
        last_error: row?.last_error ?? null, next_attempt: iso(row?.next_attempt),
        consecutive_failures: Number(row?.consecutive_failures ?? 0) };
    });
    const successes = feeds.map(feed => feed.last_success).filter((value): value is string => value !== null).sort();
    const lease = this.db.get("SELECT expires_at FROM news_collector_lease WHERE slot='feeds'");
    return { enabled: Boolean(this.settings.newsEnabled), running: Boolean(this.pending || lease && lease.expires_at > this.now()),
      poll_seconds: this.pollMs / 1000, last_success: successes.at(-1) ?? null, feeds };
  }

  /** Stops timers, aborts the request, and releases the lease before Store.close(). */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer); this.timer = undefined;
    this.cancel?.abort();
    await this.pending?.catch(() => undefined);
  }

  private async collect(force: boolean, signal: AbortSignal): Promise<FeedRefreshResult> {
    const now = this.now(), result = emptyFeedResult();
    const due = this.urls.filter(url => force || (this.db.get("SELECT next_attempt FROM news_feed_state WHERE url=?", url)?.next_attempt ?? 0) <= now);
    if (!due.length) return result;
    const acquired = this.db.run(`INSERT INTO news_collector_lease(slot,owner,expires_at) VALUES('feeds',?,?)
      ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE news_collector_lease.expires_at<=?`, this.owner, now + this.leaseMs, now);
    if (!acquired.changes) throw new AppError("Сбор новостей уже выполняется другим процессом", 409);
    const renewal = setInterval(() => {
      try {
        const renewed = this.db.run("UPDATE news_collector_lease SET expires_at=? WHERE slot='feeds' AND owner=?", this.now() + this.leaseMs, this.owner);
        if (!renewed.changes) this.cancel?.abort();
      } catch { this.cancel?.abort(); }
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    try {
      let index = 0;
      const sources = configuredNewsSources(this.settings);
      const outcomes = await Promise.allSettled(Array.from({length:Math.min(due.length,this.settings.newsSourceConcurrency ?? 3)},async () => {
      while (index < due.length) {
        const url = due[index++];
        signal.throwIfAborted();
        // Another process may have completed this URL between the initial due
        // check and acquisition of the shared lease.
        if (!force && (this.db.get("SELECT next_attempt FROM news_feed_state WHERE url=?", url)?.next_attempt ?? 0) > this.now()) continue;
        // Do not advance next_attempt before success/failure: a crashed process must
        // be retried when its lease expires, even if the normal poll period is long.
        this.db.run("UPDATE news_feed_state SET last_attempt=? WHERE url=?", this.now(), url);
        try {
          const source = sources.find(item => item.url === url)!;
          const batch = this.settings.newsFullTextEnabled || source.kind !== "rss"
            ? await this.ingestor.ingest(source,signal) : await ingestFeed(url, this.db, this.request, signal);
          signal.throwIfAborted();
          mergeFeedResult(result, batch);
          if (!batch.processed && batch.quarantined) throw new AppError("В RSS нет пригодных записей: отсутствует заголовок или достаточный текст", 502);
          this.db.run("UPDATE news_feed_state SET last_success=?,last_error=NULL,next_attempt=?,consecutive_failures=0 WHERE url=?", this.now(), this.now() + this.pollMs, url);
        } catch (error) {
          if (signal.aborted) throw error;
          result.failed_hosts.push(new URL(url).hostname);
          const attempts = Number(this.db.get("SELECT consecutive_failures FROM news_feed_state WHERE url=?", url)?.consecutive_failures ?? 0) + 1;
          const delay = Math.min(Math.max(this.pollMs, 3600000), this.pollMs * 2 ** Math.min(attempts - 1, 12));
          this.db.run("UPDATE news_feed_state SET last_error=?,next_attempt=?,consecutive_failures=? WHERE url=?", publicFeedError(error), this.now() + delay, attempts, url);
        }
      }
      }));
      const failed = outcomes.find((item):item is PromiseRejectedResult => item.status === "rejected");
      if (failed) throw failed.reason;
      return result;
    } finally {
      clearInterval(renewal);
      this.db.run("DELETE FROM news_collector_lease WHERE slot='feeds' AND owner=?", this.owner);
    }
  }
}
