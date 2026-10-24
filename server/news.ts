import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Settings } from "./config.js";
import type { Store } from "./db.js";
import { tags } from "./retrieval.js";
import { AppError, type Json, type News } from "./types.js";
import { canonicalUrl, fingerprint, normalizePublicationDate } from "./news-events.js";
export function saveNews(db: Store, data: Json): News & { ingestion_status: string } {
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
    ?? (url ? db.get("SELECT id AS news_id FROM news WHERE url=? ORDER BY id LIMIT 1", url) : undefined);
  const id = known?.news_id ?? fingerprint(identity);
  const old = known ? db.news(id) : undefined;
  const incomingDate = normalizePublicationDate(data.published ?? data.published_at);
  const priorDate = normalizePublicationDate(old?.published);
  const published = priorDate.value ? priorDate : incomingDate;
  const publicationPrecision = priorDate.value && old?.published_precision ? old.published_precision : published.precision;
  const modified = normalizePublicationDate(data.modified ?? data.modified_at);
  const contentChanged = Boolean(old && (old.title !== title || old.text !== text));
  const validModified = modified.value && (!published.value || modified.value >= published.value) ? modified.value : null;
  const availableAt = contentChanged ? (validModified && (!old?.available_at || validModified > old.available_at) ? validModified : fetchedAt)
    : (old?.available_at ?? validModified ?? published.value);
  const versionId = fingerprint(JSON.stringify([title, text, published.value, availableAt]));
  const dateStatus = published.status === "valid" && (published.value! > fetchedAt || availableAt && availableAt > fetchedAt) ? "future" : published.status;
  const warnings: string[] = [];
  if (published.status !== "valid") warnings.push("publication_date_" + published.status);
  else if (published.value! > fetchedAt) warnings.push("publication_date_future");
  if (availableAt && availableAt > fetchedAt) warnings.push("revision_not_yet_available");
  if (!url) warnings.push("missing_source_url");
  if (publicationPrecision === "day") warnings.push("date_only_assumes_utc_end_of_day");
  if (modified.status === "invalid" || modified.value && !validModified) warnings.push("invalid_modified_date");
  if (incomingDate.value && priorDate.value && incomingDate.value !== priorDate.value) warnings.push("original_publication_date_preserved");
  if (contentChanged && !validModified) warnings.push("revision_time_unknown_available_from_fetch");
  const metadata = { date_status: dateStatus, published_precision: publicationPrecision,
    published_raw: priorDate.value ? old?.published_raw ?? old?.published : data.published ?? data.published_at ?? null,
    modified_at: validModified ?? (!contentChanged ? old?.modified_at ?? null : null), fetched_at: fetchedAt, available_at: availableAt, source_id: "news:" + id + ":" + versionId, warnings };
  const article = { id, title, text, url, published: published.value ?? "", tags: tags(title + " " + text), is_demo: false, ...metadata };
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
    db.connection.exec("COMMIT");
  } catch (error) { db.connection.exec("ROLLBACK"); throw error; }
  return { ...db.news(id), ingestion_status: !old ? "inserted" : contentChanged || !priorDate.value && published.value ? "updated" : "duplicate" };
}
const array = (value: any): any[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const textValue = (value: any): string =>
  value == null ? "" : typeof value === "object" ? textValue(value["#text"] ?? value["@_href"]) : String(value);
export async function ingestFeeds(settings: Settings, db: Store, request: typeof fetch = fetch) {
  if (!settings.feeds.length)
    throw new AppError("RSS не настроен. Добавьте NEWS_FEEDS_JSON в .env или вставьте новость вручную.");
  let processed = 0;
  const counts = { inserted: 0, updated: 0, duplicates: 0, quarantined: 0 };
  const failed_hosts: string[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    processEntities: false,
    isArray: (name) => name === "item" || name === "entry",
  });
  for (const url of settings.feeds.slice(0, 5)) {
    try {
      const response = await request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "User-Agent": "AlfaInsightHackathon/2.0" },
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2000000) throw new Error("RSS превышает 2 МБ");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const xml = Buffer.concat(chunks).toString("utf8");
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Недопустимый XML");
      const doc = parser.parse(xml),
        entries = array(doc.rss?.channel?.item ?? doc.feed?.entry);
      for (const entry of entries.slice(0, 30)) {
        try {
          const links = array(entry.link),
            link = links.find((l) => l?.["@_rel"] === "alternate") ?? links[0];
          const saved = saveNews(db, {
            title: textValue(entry.title),
            text: textValue(entry.description ?? entry.summary ?? entry.content),
            url: textValue(link),
            // Atom 'updated' is modification time and cannot establish publication time.
            published: textValue(entry.pubDate || entry.published),
            modified: textValue(entry.updated),
            guid: textValue(entry.guid ?? entry.id), feed_url: url,
          });
          processed++;
          if (saved.ingestion_status === "duplicate") counts.duplicates++; else if (saved.ingestion_status === "updated") counts.updated++; else counts.inserted++;
          if (saved.date_status !== "valid" || !saved.url || saved.available_at && Date.parse(saved.available_at) > Date.now()) counts.quarantined++;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
    } catch {
      failed_hosts.push(new URL(url).hostname);
    }
  }
  return { processed, failed_hosts, ...counts };
}
