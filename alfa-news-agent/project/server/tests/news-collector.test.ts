import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../config.js";
import { Store } from "../db.js";
import { NewsCollector } from "../news-collector.js";
import { feedPlainText, ingestFeed } from "../news.js";

const FEED = "https://news.example.org/rss";
const body = "Банк России сохранил ключевую ставку. Следующее решение будет принято после анализа данных.";
const rss = (content = body, link = "https://news.example.org/item") => `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
  <title>Новости кредитования компаний</title><description>Короткая аннотация новости без подробностей для анализа.</description>
  <content:encoded><![CDATA[${content}]]></content:encoded><link>${link}</link><pubDate>Fri, 23 Oct 2026 13:00:00 +0300</pubDate>
  </item></channel></rss>`;

function fixture(feeds = [FEED]) {
  const folder = mkdtempSync(join(tmpdir(), "alfa-news-collector-"));
  const settings = { dbPath: join(folder, "news.sqlite"), feeds, newsEnabled: true, newsPollSeconds: 1 } as Settings;
  const db = new Store(settings);
  db.connection.exec(`CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER);
    CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT);
    CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));`);
  return { db, settings, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const requestFor = (xml: string): typeof fetch => (async (_url, options) => {
  assert.equal(options?.redirect, "error");
  assert.ok(options?.signal);
  return new Response(xml);
}) as typeof fetch;

test("RSS uses normalized full inline content, publication time and stable versions", async () => {
  const f = fixture();
  try {
    const xml = rss("<p>Банк &amp; компании: ставка сохранена.</p><script>invented claim</script><p>Решение опубликовано &#50;&#51; октября.</p>");
    const first = await ingestFeed(FEED, f.db, requestFor(xml));
    assert.equal(first.inserted, 1);
    const article = f.db.news(f.db.get("SELECT id FROM news")!.id);
    assert.equal(article.text, "Банк & компании: ставка сохранена. Решение опубликовано 23 октября.");
    assert.equal(article.published, "2026-10-23T10:00:00.000Z");
    assert.equal(article.content_scope, "feed_content");
    assert.equal(article.warnings.includes("rss_excerpt_only_full_article_not_fetched"), false);
    assert.equal((await ingestFeed(FEED, f.db, requestFor(xml))).duplicates, 1);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news_versions")!.n, 1);
    const revised = await ingestFeed(FEED, f.db, requestFor(rss(body + " Публикация дополнена уточнением.")));
    assert.equal(revised.updated, 1);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news")!.n, 1);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news_versions")!.n, 2);
  } finally { f.close(); }
});

test("Atom external content is not fetched and excerpt/date limitations remain explicit", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const atom = `<feed><entry><title>Поставки оборудования</title><summary>&lt;p&gt;Изменились сроки поставки оборудования. Требуется проверка маршрута.&lt;/p&gt;</summary>
      <content src="https://unrequested.example/body"/><link rel="self" href="https://news.example.org/feed-entry"/>
      <link rel="alternate" href="https://news.example.org/article"/><updated>2026-10-23T10:00:00Z</updated></entry></feed>`;
    const batch = await ingestFeed(FEED, f.db, (async () => { calls++; return new Response(atom); }) as typeof fetch);
    const article = f.db.news(f.db.get("SELECT id FROM news")!.id);
    assert.equal(calls, 1);
    assert.equal(batch.quarantined, 1);
    assert.equal(article.url, "https://news.example.org/article");
    assert.equal(article.published, "", "updated must not establish first publication date");
    assert.equal(article.content_scope, "feed_excerpt");
    assert.ok(article.warnings.includes("rss_excerpt_only_full_article_not_fetched"));
    assert.ok(!article.text.includes("<p>"));
  } finally { f.close(); }
});

test("normalization handles XHTML, entities and nonprinting bytes without rendering HTML", () => {
  assert.equal(feedPlainText({ div: { p: ["Первый абзац", "Второй абзац"], "@_xmlns": "ignored" } }), "Первый абзац Второй абзац");
  assert.equal(feedPlainText("&lt;p&gt;Курс &amp; ставки&lt;/p&gt; &#x20bd; <style>bad</style> \u0001"), "Курс & ставки ₽");
});

test("invalid XML, unsafe redirects, oversized feeds and nonfeed HTML remain rejected", async () => {
  const f = fixture();
  try {
    for (const xml of ["<!DOCTYPE rss [<!ENTITY x 'bad'>]>" + rss(), "x".repeat(2000001), "<html><body>Not a feed</body></html>", "<rss><channel>"])
      await assert.rejects(ingestFeed(FEED, f.db, requestFor(xml)));
    await assert.rejects(ingestFeed(FEED, f.db, (async (_url, options) => {
      assert.equal(options?.redirect, "error"); return new Response("", { status: 302 });
    }) as typeof fetch), /HTTP 302/);
    await assert.rejects(ingestFeed("https://user:password@example.org/feed", f.db, requestFor(rss())), /без учётных данных/);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news")!.n, 0);
  } finally { f.close(); }
});

test("a high-volume feed does not silently discard everything beyond thirty entries", async () => {
  const f = fixture();
  try {
    const entries = Array.from({ length: 100 }, (_, i) => `<item><title>Новость экономики ${i}</title><description>${body}</description><link>https://news.example.org/${i}</link><pubDate>Fri, 23 Oct 2026 13:00:00 +0300</pubDate></item>`).join("");
    const batch = await ingestFeed(FEED, f.db, requestFor(`<rss><channel>${entries}</channel></rss>`));
    assert.equal(batch.processed, 100);
    assert.equal(batch.inserted, 100);
  } finally { f.close(); }
});

test("a feed containing only unusable articles is reported as failed instead of a successful collection", async () => {
  const f = fixture();
  const collector = new NewsCollector(f.settings, f.db, { request: requestFor("<rss><channel><item><title>Новость без текста</title><description>Кратко</description></item></channel></rss>") });
  try {
    const result = await collector.refresh();
    assert.equal(result.processed, 0);
    assert.equal(result.quarantined, 1);
    assert.deepEqual(result.failed_hosts, ["news.example.org"]);
    assert.equal(collector.status().last_success, null);
    assert.match(collector.status().feeds[0].last_error!, /нет пригодных записей/);
  } finally { await collector.stop(); f.close(); }
});

test("failed feed is isolated; durable backoff survives restart and clears on successful retry", async () => {
  const badUrl = "https://broken.example.org/rss", f = fixture([badUrl, FEED]);
  let now = Date.parse("2026-10-25T09:00:00Z"), failing = true;
  const calls: string[] = [];
  const request = (async url => { calls.push(String(url)); return failing && url === badUrl ? new Response("", { status: 503 }) : new Response(rss(body, String(url) + "/article")); }) as typeof fetch;
  const first = new NewsCollector(f.settings, f.db, { now: () => now, request });
  let second: NewsCollector | undefined;
  try {
    const result = await first.refresh({ force: false });
    assert.deepEqual(result.failed_hosts, ["broken.example.org"]);
    assert.equal(result.inserted, 1);
    assert.equal(first.status().feeds[0].last_error, "RSS вернул HTTP 503");
    assert.equal(first.status().last_success, "2026-10-25T09:00:00.000Z");
    await first.refresh({ force: false });
    assert.equal(calls.length, 2, "not-due feeds must not be fetched");
    now += 1000;
    await first.refresh({ force: false });
    assert.equal(first.status().feeds[0].consecutive_failures, 2);
    assert.equal(first.status().feeds[0].next_attempt, "2026-10-25T09:00:03.000Z");
    await first.stop();
    second = new NewsCollector(f.settings, f.db, { now: () => now, request });
    assert.equal(second.status().feeds[0].consecutive_failures, 2);
    now += 1000;
    await second.refresh({ force: false });
    assert.equal(calls.filter(url => url === badUrl).length, 2, "restart must preserve failed-feed backoff");
    failing = false;
    await second.refresh();
    assert.equal(second.status().feeds[0].consecutive_failures, 0);
    assert.equal(second.status().feeds[0].last_error, null);
    assert.equal(second.status().feeds[0].last_success, "2026-10-25T09:00:02.000Z");
  } finally { await first.stop(); await second?.stop(); f.close(); }
});

test("parallel refresh calls share work and a separate database connection cannot duplicate it", async () => {
  const f = fixture();
  const secondDb = new Store(f.settings);
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new NewsCollector(f.settings, f.db, { request: (async () => { calls++; await gate; return new Response(rss()); }) as typeof fetch });
  const second = new NewsCollector(f.settings, secondDb, { request: requestFor(rss()) });
  try {
    const pending = first.refresh();
    assert.equal(first.refresh(), pending);
    assert.equal(first.refresh(), pending);
    assert.equal(calls, 1);
    assert.equal(second.status().running, true);
    await assert.rejects(second.refresh(), (error: any) => error.status === 409);
    release();
    assert.equal((await pending).inserted, 1);
    assert.equal(second.status().running, false);
    assert.equal((await second.refresh()).duplicates, 1);
  } finally { release(); await first.stop(); await second.stop(); secondDb.close(); f.close(); }
});

test("expired process lease is recovered after restart without manual cleanup", async () => {
  const f = fixture();
  let now = Date.parse("2026-10-25T09:00:00Z");
  const collector = new NewsCollector(f.settings, f.db, { now: () => now, request: requestFor(rss()) });
  try {
    f.db.run("INSERT INTO news_collector_lease VALUES('feeds','terminated-process',?)", now + 1000);
    await assert.rejects(collector.refresh(), (error: any) => error.status === 409);
    now += 1001;
    assert.equal((await collector.refresh({ force: false })).inserted, 1);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news_collector_lease")!.n, 0);
  } finally { await collector.stop(); f.close(); }
});

test("start collects immediately and on schedule; repeated start does not create another loop", async () => {
  const f = fixture();
  let calls = 0, secondCall!: () => void;
  const twice = new Promise<void>(resolve => { secondCall = resolve; });
  const collector = new NewsCollector(f.settings, f.db, { request: (async () => { calls++; if (calls === 2) secondCall(); return new Response(rss()); }) as typeof fetch });
  let deadline: NodeJS.Timeout | undefined;
  try {
    collector.start(); collector.start();
    await Promise.race([twice, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("periodic poll did not run")), 3000); })]);
    await collector.stop();
    assert.equal(calls, 2);
    assert.equal(collector.status().running, false);
  } finally { clearTimeout(deadline); await collector.stop(); f.close(); }
});

test("stop aborts active HTTP, releases its lease and allows a fresh instance to recover", async () => {
  const f = fixture();
  let requested = false;
  const first = new NewsCollector(f.settings, f.db, { request: (async (_url, options) => {
    requested = true;
    return await new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true }));
  }) as typeof fetch });
  let next: NewsCollector | undefined;
  try {
    first.start();
    assert.equal(requested, true);
    await first.stop();
    assert.equal(first.status().running, false);
    assert.equal(first.status().feeds[0].consecutive_failures, 0, "intentional shutdown is not a failed feed");
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news_collector_lease")!.n, 0);
    next = new NewsCollector(f.settings, f.db, { request: requestFor(rss()) });
    assert.equal((await next.refresh({ force: false })).inserted, 1);
  } finally { await first.stop(); await next?.stop(); f.close(); }
});

test("disabled collection performs no automatic network requests but allows explicit refresh", async () => {
  const f = fixture(); f.settings.newsEnabled = false;
  let calls = 0;
  const collector = new NewsCollector(f.settings, f.db, { request: (async () => { calls++; return new Response(rss()); }) as typeof fetch });
  try {
    collector.start();
    assert.equal(calls, 0);
    assert.equal(collector.status().enabled, false);
    await collector.refresh();
    assert.equal(calls, 1);
  } finally { await collector.stop(); f.close(); }
});
