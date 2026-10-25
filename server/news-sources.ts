import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Settings } from "./config.js";
import type { Store } from "./db.js";
import { AppError, type Json } from "./types.js";
import { canonicalUrl, normalizePublicationDate } from "./news-events.js";
import { NewsHttp, safeNewsUrl } from "./news-http.js";
import { extractArticleHtml, extractHtmlListing, type HtmlListingOptions } from "./news-html.js";
import { emptyFeedResult, feedPlainText, saveNews, type FeedRefreshResult } from "./news.js";

export interface NewsSource {
  url: string;
  name: string;
  kind: "rss" | "json" | "html";
  hosts: string[];
  articleSelectors?: string[];
  listing?: HtmlListingOptions;
  json?: { itemsPath?: string; columnsPath?: string; fields: { title:string; text?:string; url:string; published:string; modified?:string }; urlPrefix?:string; timezone?:string };
}
export interface SourceSettings {
  newsFullTextEnabled?: boolean;
  newsFullTextConcurrency?: number;
  newsFullTextRefreshSeconds?: number;
  newsFullTextMaxPerSource?: number;
  newsSourceConcurrency?: number;
  newsSources?: NewsSource[];
}
export function configuredNewsSources(settings: Settings & SourceSettings): NewsSource[] {
  const registryPath = settings.root ? resolve(settings.root,"config/news-source-registry.json") : "";
  const registry: NewsSource[] = settings.newsSources ?? (registryPath && existsSync(registryPath) ? JSON.parse(readFileSync(registryPath,"utf8")) : []);
  return [...new Set(settings.feeds)].slice(0,64).map(url => {
    const configured = registry.find(source => source.url === url);
    if (configured) return configured;
    const parsed = safeNewsUrl(url), withoutWww = parsed.hostname.replace(/^www\./,"");
    return { url, name: parsed.hostname, kind:"rss", hosts: [...new Set([parsed.hostname,withoutWww,"www." + withoutWww])] };
  });
}
const array = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
const valueAt = (value: any, path = "") => path ? path.split(".").reduce((item,key) => item?.[key],value) : value;
const rawText = (value: any): string => value == null ? "" : typeof value === "object" ? String(value["#text"] ?? "") : String(value);

export function parseNewsRss(xml: string, source: NewsSource): Json[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new AppError("Недопустимый XML RSS",502);
  const doc = new XMLParser({ ignoreAttributes:false, removeNSPrefix:true, parseTagValue:false, processEntities:false,
    isArray:name => name === "item" || name === "entry" }).parse(xml);
  if (!doc.rss?.channel && !doc.feed) throw new AppError("Ответ не является RSS или Atom",502);
  return array(doc.rss?.channel?.item ?? doc.feed?.entry).slice(0,200).map(entry => {
    const links = array(entry.link), link = links.find(l => l?.["@_rel"] === "alternate") ?? links.find(l => !l?.["@_rel"]);
    const fullText = feedPlainText(entry.encoded ?? entry.content), summary = feedPlainText(entry.description ?? entry.summary);
    return { title:feedPlainText(entry.title), text:fullText || summary,
      url: feedPlainText(typeof link === "object" ? link?.["@_href"] ?? rawText(link) : rawText(link)),
      published:rawText(entry.pubDate || entry.published), modified:rawText(entry.updated), guid:rawText(entry.guid ?? entry.id),
      feed_url:source.url, content_scope:fullText ? "feed_content" : "feed_excerpt" };
  });
}
export function parseNewsJson(text: string, source: NewsSource): Json[] {
  if (!source.json) throw new AppError("Не настроено сопоставление JSON API",502);
  let data: any; try { data = JSON.parse(text); } catch { throw new AppError("Недопустимый JSON API",502); }
  const spec = source.json, records = valueAt(data,spec.itemsPath), columns = spec.columnsPath ? valueAt(data,spec.columnsPath) : undefined;
  if (!Array.isArray(records) || columns && !Array.isArray(columns)) throw new AppError("JSON API изменил структуру списка",502);
  return records.slice(0,200).map(raw => {
    const row = columns ? Object.fromEntries(columns.map((key: string,i:number) => [key,raw[i]])) : raw;
    const field = (key:string | undefined) => key ? valueAt(row,key) : "";
    let published = String(field(spec.fields.published) ?? "");
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(published) && spec.timezone) published = published.replace(" ","T") + spec.timezone;
    return { title:feedPlainText(field(spec.fields.title)), text:feedPlainText(field(spec.fields.text)),
      url:(spec.urlPrefix ?? "") + String(field(spec.fields.url) ?? ""), published, modified:field(spec.fields.modified),
      content_scope:spec.fields.text ? "feed_content" : "feed_excerpt", feed_url:source.url };
  });
}
async function pooled<T>(values: T[], parallel: number, task:(value:T) => Promise<void>):Promise<void> {
  let index = 0;
  const outcomes = await Promise.allSettled(Array.from({length:Math.max(1,Math.min(parallel,values.length || 1))},async () => { while (index < values.length) { const value = values[index++]; await task(value); } }));
  const failed = outcomes.find((item):item is PromiseRejectedResult => item.status === "rejected");
  if (failed) throw failed.reason;
}
/** Real adapters share one transport, extraction policy, bounded pool and version store. */
export class NewsSourceIngestor {
  private readonly http: NewsHttp;
  constructor(private readonly settings: Settings & SourceSettings, private readonly db: Store, request?:typeof fetch) {
    this.http = new NewsHttp(request);
    db.connection.exec(`CREATE TABLE IF NOT EXISTS news_article_backlog (
      url TEXT PRIMARY KEY,feed_url TEXT NOT NULL,payload TEXT NOT NULL,
      first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT
    ); CREATE INDEX IF NOT EXISTS news_article_due ON news_article_backlog(feed_url,next_attempt);`);
  }
  async ingest(source: NewsSource, signal?:AbortSignal):Promise<FeedRefreshResult> {
    const response = await this.http.read(source.url,{hosts:source.hosts,signal,maxBytes:3000000,robots:source.kind === "html",
      accept:source.kind === "rss" ? "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.1" : source.kind === "json" ? "application/json" : "text/html,*/*;q=0.1"});
    const entries = source.kind === "rss" ? parseNewsRss(response.text,source)
      : source.kind === "json" ? parseNewsJson(response.text,source)
      : source.listing ? extractHtmlListing(response.text,response.url,source.hosts,source.listing) : [];
    if (!entries.length) throw new AppError("Источник не содержит распознанных публикаций",502);
    const result = emptyFeedResult();
    const current = new Map<string,Json>(), now=Date.now();
    for (const entry of entries) {
      try {
        const link = new URL(String(entry.url),source.url); if (link.protocol === "http:") link.protocol = "https:";
        const url = canonicalUrl(safeNewsUrl(link.toString(),source.hosts).toString());
        if (String(entry.title).length < 5) throw new AppError("Недостаточный заголовок");
        const payload = {...entry,url}; current.set(url,payload);
        // Keep every discovered URL, including short/empty RSS teasers. A small
        // full-text pool must not lose stories which disappear from a busy feed.
        this.db.run(`INSERT INTO news_article_backlog VALUES(?,?,?,?,?,0,NULL)
          ON CONFLICT(url) DO UPDATE SET payload=excluded.payload,last_seen=excluded.last_seen`,url,source.url,JSON.stringify(payload),now,now);
      } catch { result.quarantined++; }
    }
    const limit=Math.max(1,Math.min(100,this.settings.newsFullTextMaxPerSource ?? 20));
    const backlog=this.db.all(`SELECT * FROM news_article_backlog WHERE feed_url=? AND next_attempt<=?
      AND (next_attempt=0 OR last_seen>=?) ORDER BY next_attempt,first_seen,url LIMIT ?`,source.url,now,now-7*86400000,limit);
    const dueUrls=new Set(backlog.map(row=>row.url));
    for (const row of backlog) if (!current.has(row.url)) current.set(row.url,JSON.parse(row.payload));
    await pooled([...current.values()],this.settings.newsFullTextConcurrency ?? 3,async input => {
      signal?.throwIfAborted();
      let data: Json = {...input,source_name:source.name};
      try {
        // Publishers still expose HTTP links in RSS. Upgrade to HTTPS on the same allowed host.
        const link = new URL(String(data.url),source.url); if (link.protocol === "http:") link.protocol = "https:";
        data.url = canonicalUrl(safeNewsUrl(link.toString(),source.hosts).toString()); data.original_url = data.url;
        const known = this.db.get("SELECT id FROM news WHERE url=?",data.url)
          ?? this.db.get("SELECT news_id AS id FROM news_metadata WHERE json_extract(payload,'$.original_url')=?",data.url);
        const old = known ? this.db.news(known.id) : undefined;
        const due = dueUrls.has(data.url);
        const enabled = this.settings.newsFullTextEnabled ?? false;
        if (enabled && due) {
          try {
            const article = await this.http.read(data.url,{hosts:source.hosts,signal,robots:true});
            if (article.contentType && !/html|xhtml/i.test(article.contentType)) throw new AppError("Статья имеет неподдерживаемый формат",502);
            const extracted = extractArticleHtml(article.text,article.url,source.hosts,source.articleSelectors);
            const date = normalizePublicationDate(extracted.published);
            // RSS timestamps remain the publication evidence if the page exposes no valid date.
            data = {...data,...extracted,published:date.status === "valid" ? extracted.published : data.published,
              modified:extracted.modified || data.modified,content_scope:"article_full",full_text_fetched_at:new Date().toISOString(),
              full_text_next_attempt:new Date(Date.now() + (this.settings.newsFullTextRefreshSeconds ?? 3600)*1000).toISOString(),full_text_error:null,extraction_warnings:[]};
            this.db.run("UPDATE news_article_backlog SET next_attempt=?,last_error=NULL WHERE url=?",Date.parse(data.full_text_next_attempt),input.url);
          } catch (error) {
            if (signal?.aborted) throw error;
            const reason = error instanceof AppError ? error.message : "Не удалось загрузить полный текст";
            data = {...data,full_text_next_attempt:new Date(Date.now()+900000).toISOString(),full_text_error:reason,
              extraction_warnings:["full_article_fetch_failed",reason]};
            this.db.run("UPDATE news_article_backlog SET next_attempt=?,last_error=? WHERE url=?",Date.parse(data.full_text_next_attempt),reason,input.url);
            // A transient article failure must not erase a previously fetched full version.
            if (old?.content_scope === "article_full") {
              const document = this.db.get("SELECT text FROM news_article_documents WHERE news_id=? AND version_id=?",old.id,old.source_id.split(":").at(-1));
              data = {...data,title:old.title,text:document?.text ?? old.text,url:old.url,published:old.published,modified:old.modified_at,
                content_scope:"article_full",extraction_method:old.extraction_method,full_text_fetched_at:old.full_text_fetched_at,
                extraction_warnings:["full_article_refresh_failed_prior_version_retained",reason]};
            }
          }
        } else if (old?.content_scope === "article_full") {
          // Keep the immutable complete version until its scheduled correction check.
          const document = this.db.get("SELECT text FROM news_article_documents WHERE news_id=? AND version_id=?",old.id,old.source_id.split(":").at(-1));
          data = {...data,...old,text:document?.text ?? old.text,modified:old.modified_at,extraction_warnings:old.warnings};
        } else if (old && !due) {
          data = {...data,full_text_next_attempt:old.full_text_next_attempt,full_text_error:old.full_text_error,
            full_text_fetched_at:old.full_text_fetched_at,extraction_warnings:old.full_text_error ? ["full_article_fetch_failed",old.full_text_error] : []};
        } else if (enabled) data.extraction_warnings = ["full_article_waiting_for_fetch_slot"];
        const saved = saveNews(this.db,data); result.processed++;
        if (saved.ingestion_status === "duplicate") result.duplicates++; else if (saved.ingestion_status === "updated") result.updated++; else result.inserted++;
        if (saved.date_status !== "valid" || !saved.url || saved.available_at && Date.parse(saved.available_at)>Date.now()) result.quarantined++;
      } catch (error) { if (signal?.aborted || !(error instanceof AppError) && !(error instanceof TypeError)) throw error; result.quarantined++; }
    });
    return result;
  }
}
