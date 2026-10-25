import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Settings } from "./config.js";
import type { Store } from "./db.js";
import { tags } from "./retrieval.js";
import { AppError, type Json, type News } from "./types.js";
import { canonicalUrl, fingerprint, normalizePublicationDate } from "./news-events.js";
import { NewsHttp, safeNewsUrl } from "./news-http.js";
export function saveNews(db: Store, data: Json): News & { ingestion_status: string } {
  const originalText = String(data.text ?? "").trim();
  const title = String(data.title ?? "")
      .trim()
      .slice(0, 300),
    text = String(data.text ?? "")
      .trim()
      .slice(0, 18000);
  if (title.length < 5 || text.length < 30) throw new AppError("Нужны заголовок от 5 и текст от 30 символов.");
  let url = String(data.url ?? "")
    .trim()
    .slice(0, 2000);
  if (url) {
    try {
      url = canonicalUrl(url);
    } catch {
      throw new AppError("Источник должен быть HTTP(S)-ссылкой.");
    }
  }
  const fetchedAt = new Date().toISOString();
  const identity = url ? "url:" + url : data.guid && data.feed_url ? "guid:" + JSON.stringify([data.feed_url, data.guid]) : "text:" + fingerprint(title + "\n" + text);
  const known = db.get("SELECT news_id FROM news_metadata WHERE identity=?", identity)
    // Adopt a pre-migration row with this URL instead of creating a duplicate.
    ?? (url ? db.get("SELECT id AS news_id FROM news WHERE url=? ORDER BY id LIMIT 1", url) : undefined)
    ?? (data.original_url ? db.get("SELECT id AS news_id FROM news WHERE url=? ORDER BY id LIMIT 1",data.original_url) : undefined)
    ?? (data.original_url ? db.get("SELECT news_id FROM news_metadata WHERE json_extract(payload,'$.original_url')=? ORDER BY news_id LIMIT 1",data.original_url) : undefined);
  const id = known?.news_id ?? fingerprint(identity);
  const old = known ? db.news(id) : undefined;
  const incomingDate = normalizePublicationDate(data.published ?? data.published_at);
  const priorDate = normalizePublicationDate(old?.published);
  const correctedFutureDate = Boolean(priorDate.value && priorDate.value > (old?.fetched_at ?? fetchedAt)
    && incomingDate.value && incomingDate.value <= fetchedAt && incomingDate.value !== priorDate.value);
  const preservePublication = Boolean(priorDate.value && !correctedFutureDate);
  const published = preservePublication ? priorDate : incomingDate;
  const publicationPrecision = preservePublication && old?.published_precision ? old.published_precision : published.precision;
  const modified = normalizePublicationDate(data.modified ?? data.modified_at);
  const materialText = (value: string) => value.normalize("NFKC").replace(/[«»“”]/g, '"').replace(/[‘’]/g,"'").replace(/\s+/g," ").trim();
  const materialVersion = fingerprint(materialText(title) + "\n" + materialText(originalText));
  const contentScope = ["feed_excerpt", "feed_content", "article_full"].includes(data.content_scope) ? data.content_scope : undefined;
  const evidenceChanged = Boolean(old && (old.url !== url || old.content_scope !== contentScope));
  const contentChanged = Boolean(old && (old.title !== title || old.text !== text || old.material_version_id && old.material_version_id !== materialVersion));
  const materialRevision = Boolean(old && (old.material_version_id ?? fingerprint(materialText(old.title) + "\n" + materialText(old.text))) !== materialVersion);
  const validModified = modified.value && (!published.value || modified.value >= published.value) ? modified.value : null;
  const availableAt = correctedFutureDate || evidenceChanged ? (validModified && validModified > fetchedAt ? validModified : fetchedAt)
    : contentChanged ? (validModified && (!old?.available_at || validModified > old.available_at) ? validModified : fetchedAt)
    : (old?.available_at ?? validModified ?? published.value);
  const versionId = fingerprint(JSON.stringify([title, text, published.value, availableAt, materialVersion,url,contentScope ?? null]));
  const dateStatus = published.status === "valid" && (published.value! > fetchedAt || availableAt && availableAt > fetchedAt) ? "future" : published.status;
  const warnings: string[] = [];
  if (published.status !== "valid") warnings.push("publication_date_" + published.status);
  else if (published.value! > fetchedAt) warnings.push("publication_date_future");
  if (availableAt && availableAt > fetchedAt) warnings.push("revision_not_yet_available");
  if (!url) warnings.push("missing_source_url");
  if (publicationPrecision === "day") warnings.push("date_only_assumes_utc_end_of_day");
  if (modified.status === "invalid" || modified.value && !validModified) warnings.push("invalid_modified_date");
  if (incomingDate.value && preservePublication && incomingDate.value !== priorDate.value) warnings.push("original_publication_date_preserved");
  if (correctedFutureDate) warnings.push("future_publication_date_corrected_available_from_fetch");
  if (contentChanged && !validModified) warnings.push("revision_time_unknown_available_from_fetch");
  if (contentScope === "feed_excerpt") warnings.push("rss_excerpt_only_full_article_not_fetched");
  if (Array.isArray(data.extraction_warnings)) warnings.push(...data.extraction_warnings.filter((w:unknown) => typeof w === "string").slice(0,20));
  if (String(data.text ?? "").trim().length > 18000) warnings.push("source_text_truncated_18000");
  const metadata = { date_status: dateStatus, published_precision: publicationPrecision,
    published_raw: preservePublication ? old?.published_raw ?? old?.published : data.published ?? data.published_at ?? null,
    modified_at: validModified ?? (!contentChanged ? old?.modified_at ?? null : null), fetched_at: fetchedAt, available_at: availableAt, source_id: "news:" + id + ":" + versionId, warnings: [...new Set(warnings)],
    material_version_id: materialVersion, material_revision: materialRevision,
    ...(contentScope ? { content_scope: contentScope, feed_url: data.feed_url, extraction_method: data.extraction_method ?? null,
      full_text_chars: originalText.length, full_text_fetched_at: data.full_text_fetched_at ?? null,
      full_text_next_attempt: data.full_text_next_attempt ?? null, full_text_error: data.full_text_error ?? null,
      source_name: data.source_name ?? null, original_url: data.original_url ?? url } : {}) };
  const article = { id, title, text, url, published: published.value ?? "", tags: tags(title + " " + text), is_demo: false, ...metadata };
  db.connection.exec("CREATE TABLE IF NOT EXISTS news_article_documents(news_id TEXT,version_id TEXT,text TEXT NOT NULL,PRIMARY KEY(news_id,version_id))");
  db.connection.exec("BEGIN IMMEDIATE");
  try {
    // Snapshot pre-migration evidence before replacing it.
    if (old && priorDate.value && !db.get("SELECT 1 FROM news_versions WHERE news_id=? LIMIT 1", id)) {
      const oldVersion = fingerprint(JSON.stringify([old.title, old.text, priorDate.value]));
      db.run("INSERT OR IGNORE INTO news_versions VALUES(?,?,?,?)", id, oldVersion, priorDate.value,
        JSON.stringify({ ...old, published: priorDate.value, available_at: priorDate.value, source_id: "news:" + id + ":" + oldVersion }));
    }
    db.run("INSERT OR REPLACE INTO news VALUES(?,?,?,?,?,?,?)", id, title, text, url, published.value ?? "", JSON.stringify(article.tags), 0);
    db.run("INSERT OR REPLACE INTO news_metadata VALUES(?,?,?)", id, identity, JSON.stringify(metadata));
    if (availableAt && published.value) db.run("INSERT OR IGNORE INTO news_versions VALUES(?,?,?,?)", id, versionId, availableAt, JSON.stringify(article));
    if (contentScope === "article_full" || contentScope === "feed_content") db.run("INSERT OR IGNORE INTO news_article_documents VALUES(?,?,?)",id,versionId,originalText);
    db.connection.exec("COMMIT");
  } catch (error) { db.connection.exec("ROLLBACK"); throw error; }
  return { ...db.news(id), ingestion_status: !old ? "inserted" : contentChanged || evidenceChanged || correctedFutureDate || !priorDate.value && published.value ? "updated" : "duplicate" };
}
const array = (value: any): any[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const textValue = (value: any): string =>
  value == null ? "" : Array.isArray(value) ? value.map(textValue).join(" ") : typeof value === "object"
    ? Object.entries(value).filter(([key]) => !key.startsWith("@_")).map(([, child]) => textValue(child)).join(" ") : String(value);

function decodeEntities(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", hellip: "…", copy: "©", reg: "®", euro: "€", rub: "₽" };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (raw, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? raw;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

/** Feed HTML is evidence text, never markup to render or URLs to fetch. */
export function feedPlainText(value: unknown): string {
  return decodeEntities(decodeEntities(textValue(value)))
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ").trim();
}

export interface FeedRefreshResult {
  processed: number;
  failed_hosts: string[];
  inserted: number;
  updated: number;
  duplicates: number;
  quarantined: number;
}
export const emptyFeedResult = (): FeedRefreshResult => ({ processed: 0, failed_hosts: [], inserted: 0, updated: 0, duplicates: 0, quarantined: 0 });
export function mergeFeedResult(target: FeedRefreshResult, result: FeedRefreshResult): void {
  for (const key of ["processed", "inserted", "updated", "duplicates", "quarantined"] as const) target[key] += result[key];
  target.failed_hosts.push(...result.failed_hosts);
}

/** Fetch one configured HTTPS feed. The caller controls retry/lease policy. */
export async function ingestFeed(url: string, db: Store, request: typeof fetch = fetch, cancel?: AbortSignal): Promise<FeedRefreshResult> {
  const parsedUrl = safeNewsUrl(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) throw new AppError("RSS должен иметь HTTPS-адрес без учётных данных.");
  const signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  signal.throwIfAborted();
  const loaded = request === fetch ? await new NewsHttp().read(url,{signal,hosts:[parsedUrl.hostname],maxBytes:2000000,accept:"application/rss+xml,application/atom+xml,application/xml,text/xml"}) : undefined;
  const response = loaded ? new Response(loaded.text) : await request(url, {
    redirect: "error", signal,
    headers: { "User-Agent": "AlfaInsightHackathon/2.0", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AppError("RSS вернул HTTP " + response.status, 502);
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2000000) throw new AppError("RSS превышает 2 МБ", 502);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  signal.throwIfAborted();
  const xml = Buffer.concat(chunks).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new AppError("Недопустимый XML RSS", 502);
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    processEntities: false,
    isArray: (name) => name === "item" || name === "entry",
  });
  const doc = parser.parse(xml);
  if (!doc.rss?.channel && !doc.feed) throw new AppError("Ответ не является RSS или Atom", 502);
  const entries = array(doc.rss?.channel?.item ?? doc.feed?.entry), result = emptyFeedResult();
  for (const entry of entries.slice(0, 200)) {
    signal.throwIfAborted();
    try {
      const links = array(entry.link), link = links.find((l) => l?.["@_rel"] === "alternate") ?? links.find(l => !l?.["@_rel"]);
      const fullText = feedPlainText(entry.encoded ?? entry.content), summary = feedPlainText(entry.description ?? entry.summary);
      // Atom content can be an external src with no inline text. Do not fetch it.
      const text = fullText || summary;
      const saved = saveNews(db, {
        title: feedPlainText(entry.title), text,
        url: feedPlainText(typeof link === "object" ? link?.["@_href"] ?? textValue(link) : textValue(link)),
        // Atom 'updated' is modification time and cannot establish publication time.
        published: textValue(entry.pubDate || entry.published), modified: textValue(entry.updated),
        guid: textValue(entry.guid ?? entry.id), feed_url: url,
        content_scope: fullText ? "feed_content" : "feed_excerpt",
      });
      result.processed++;
      if (saved.ingestion_status === "duplicate") result.duplicates++; else if (saved.ingestion_status === "updated") result.updated++; else result.inserted++;
      if (saved.date_status !== "valid" || !saved.url || saved.available_at && Date.parse(saved.available_at) > Date.now()) result.quarantined++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result.quarantined++;
    }
  }
  return result;
}

export async function ingestFeeds(settings: Settings, db: Store, request: typeof fetch = fetch): Promise<FeedRefreshResult> {
  if (!settings.feeds.length) throw new AppError("RSS не настроен. Добавьте NEWS_FEEDS_JSON в .env или вставьте новость вручную.");
  const result = emptyFeedResult();
  for (const url of [...new Set(settings.feeds)].slice(0, 64)) {
    try { mergeFeedResult(result, await ingestFeed(url, db, request)); }
    catch { result.failed_hosts.push(new URL(url).hostname); }
  }
  return result;
}
