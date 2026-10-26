import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../db.js";
import type { Settings } from "../../config.js";
import { Retrieval } from "../../retrieval.js";
import { saveNews } from "../../news.js";
import { LegacyRetrieval } from "../retrieval.js";

function harness() {
  const folder = mkdtempSync(join(tmpdir(), "alfa-ingestion-contract-"));
  const db = new Store({ dbPath: join(folder, "news.sqlite"), feeds: [] } as unknown as Settings);
  db.connection.exec("CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER); CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT); CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));");
  db.connection.exec("CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT)");
  return { db, retrieval: new LegacyRetrieval(db, new Retrieval(db)), close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const raw = (changes = {}) => ({ title: "Решение о ключевой ставке", text: "23 октября 2026 года Банк России снизил ключевую ставку на 100 б.п. до 17% годовых.", url: "https://example.org/a", published: "Fri, 23 Oct 2026 13:00:00 +0300", ...changes });

test("v1 filters undated, invalid and future articles; merges only sources available as of cutoff", async () => {
  const h = harness();
  try {
    const a = saveNews(h.db, raw());
    saveNews(h.db, raw({ url: "https://other.example/b", published: "2026-10-23T12:00:00Z", text: "23 октября 2026 года Банк России снизил ключевую ставку до 17% годовых. Об этом сообщил регулятор." }));
    saveNews(h.db, raw({ url: "https://example.org/missing", published: undefined }));
    saveNews(h.db, raw({ url: "https://example.org/invalid", published: "bad" }));
    saveNews(h.db, raw({ url: "https://example.org/future", published: "2099-01-01T10:00:00Z" }));
    const early = await h.retrieval.search({ as_of: "2026-10-23T11:00:00Z", limit: 20 }, "early");
    assert.equal(early.data.items.length, 1); assert.equal(early.data.items[0].sources.length, 1);
    assert.equal(early.data.items[0].event_type, "rate_change");
    const later = await h.retrieval.search({ as_of: "2026-10-23T13:00:00Z", limit: 20 }, "later");
    assert.equal(later.data.items.length, 1); assert.equal(later.data.items[0].sources.length, 2);
    assert.equal(later.data.items[0].published_at, early.data.items[0].published_at);
    const source = await h.retrieval.resolve({ source_ids: [a.source_id], as_of: "2026-10-23T09:00:00Z" }, "before");
    assert.deepEqual(source.data.unknown_ids, [a.source_id]);
    const resolved = await h.retrieval.resolve({ source_ids: later.data.items[0].sources.map((s: { id: string }) => s.id), as_of: "2026-10-23T13:00:00Z" }, "sources");
    assert.deepEqual(resolved.data.items, later.data.items[0].sources);
  } finally { h.close(); }
});

test("v1 reads historical article revisions without making a correction available in the past", async () => {
  const h = harness();
  try {
    const first = saveNews(h.db, raw());
    const second = saveNews(h.db, raw({ modified: "2026-10-24T10:00:00Z", text: "23 октября 2026 года Банк России сохранил ключевую ставку на уровне 17% годовых. Исправление опубликованной информации." }));
    const old = await h.retrieval.search({ news_id: first.id, as_of: "2026-10-23T15:00:00Z", limit: 1 }, "old");
    assert.equal(old.data.items[0].event_details.direction, "decrease");
    const current = await h.retrieval.search({ news_id: first.id, as_of: "2026-10-24T15:00:00Z", limit: 1 }, "current");
    assert.equal(current.data.items[0].event_details.direction, "unchanged");
    assert.equal(current.data.items[0].published_at, old.data.items[0].published_at);
    assert.equal(current.data.items[0].sources[0].published_at, "2026-10-24T10:00:00.000Z");
    const hidden = await h.retrieval.resolve({ source_ids: [second.source_id], as_of: "2026-10-23T15:00:00Z" }, "hidden");
    assert.deepEqual(hidden.data.unknown_ids, [second.source_id]);
    const legacySource = await h.retrieval.resolve({ source_ids: ["news:" + first.id], as_of: "2026-10-23T15:00:00Z" }, "legacy-source");
    assert.match(legacySource.data.items[0].excerpt, /снизил/);
  } finally { h.close(); }
});

test("pre-migration RFC dates project to ISO and ingest exposes quarantine instead of fabricated events", async () => {
  const h = harness();
  try {
    const legacy = raw();
    h.db.run("INSERT INTO news VALUES(?,?,?,?,?,?,?)", "legacy", legacy.title, legacy.text, legacy.url, legacy.published, "[]", 0);
    const result = await h.retrieval.search({ as_of: "2026-10-23T15:00:00Z", limit: 10 }, "legacy");
    assert.equal(result.data.items[0].published_at, "2026-10-23T10:00:00.000Z");
    const imported = await h.retrieval.ingest(raw({ url: "https://example.org/no-date", published: undefined }), "new");
    assert.equal(imported.data.item, null); assert.equal(imported.data.date_status, "missing");
    assert.ok(imported.data.warnings.includes("publication_date_missing"));
    const futureRevision = await h.retrieval.ingest(raw({ url: "https://example.org/future-revision", modified: "2099-01-01T00:00:00Z" }), "future-revision");
    assert.equal(futureRevision.data.item, null); assert.equal(futureRevision.data.date_status, "future");
    assert.ok(futureRevision.data.warnings.includes("revision_not_yet_available"));
  } finally { h.close(); }
});

test("day-only publication dates become available at the conservative UTC day boundary", async () => {
  const h = harness();
  try {
    const saved = saveNews(h.db, raw({ published: "2026-10-23" }));
    assert.ok(saved.warnings.includes("date_only_assumes_utc_end_of_day"));
    assert.equal((await h.retrieval.search({ as_of: "2026-10-23T12:00:00Z", limit: 10 }, "intraday")).data.items.length, 0);
    const result = await h.retrieval.search({ as_of: "2026-10-24T00:00:00Z", limit: 10 }, "nextday");
    assert.equal(result.data.items[0].published_at, "2026-10-23T23:59:59.999Z");
    assert.equal(result.data.items[0].sources[0].published_at, result.data.items[0].published_at);
    assert.equal(result.data.items[0].event_at, "2026-10-23T00:00:00.000Z", "a day boundary is not the observed publication instant");
  } finally { h.close(); }
});

test("RAG removes future and undated sources before the top-k cutoff and resolves canonical dates", async () => {
  const h = harness();
  try {
    for (const [id, date, text] of [
      ["future", "2099-01-01T00:00:00Z", "Кредитная ставка кредитная ставка"],
      ["undated", null, "Кредитная ставка кредитная ставка"],
      ["invalid", "30 Feb 2026 10:00:00 GMT", "Кредитная ставка кредитная ставка"],
      ["known", "Fri, 23 Oct 2026 13:00:00 +0300", "Кредитная ставка зависит от финансовой ситуации и условий конкретного договора."],
      ["day", "2026-10-23", "Ставка финансирования"],
    ]) h.db.run("INSERT INTO research VALUES(?,?)", id, JSON.stringify({ id, date, text, title: "Банковская аналитика", document_id: id, page: 1, url: "https://bank.example/" + id }));
    const result = await h.retrieval.rag({ query: "кредитная ставка", as_of: "2026-10-23T12:00:00Z", limit: 1 }, "rag-time");
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].id, "research:known:c0");
    assert.equal(result.data.items[0].published_at, "2026-10-23T10:00:00.000Z");
    const resolved = await h.retrieval.resolve({ source_ids: ["research:known:c0", "research:day:c0", "research:invalid:c0"], as_of: "2026-10-23T12:00:00Z" }, "rag-sources");
    assert.deepEqual(resolved.data.items, result.data.items);
    assert.deepEqual(resolved.data.unknown_ids, ["research:day:c0", "research:invalid:c0"]);
  } finally { h.close(); }
});

test("legacy feed keeps the eligible previous revision when a future correction is queued", async () => {
  const h = harness();
  try {
    h.db.company = id => ({ id, name: id, industry: "Торговля", region: "Москва", revenue: 0, products: ["Кредиты"], foreign_trade: false, top_partners: [], data_notes: [] });
    const first = saveNews(h.db, raw());
    saveNews(h.db, raw({ modified: "2099-01-01T00:00:00Z", text: "Банк России сохранил ключевую ставку на уровне 17% годовых. Будущая версия сообщения." }));
    const feed = new Retrieval(h.db).feed("example", false);
    assert.equal(feed.length, 1); assert.equal(feed[0].id, first.id);
    assert.match(feed[0].text, /снизил/);
    const v1 = await h.retrieval.search({ as_of: new Date().toISOString(), limit: 10 }, "legacy-consistency");
    assert.equal(v1.data.items[0].text, feed[0].text);
  } finally { h.close(); }
});

test("research supports evidence publication fields consistently before top-k and during source resolution", async () => {
  const h = harness();
  try {
    for (const [id, values] of [
      ["future", { published_at: "2099-01-01T00:00:00Z", date: "2020-01-01" }],
      ["current", { published_at: "2026-10-23T10:00:00Z" }],
    ] as const) h.db.run("INSERT INTO research VALUES(?,?)", id, JSON.stringify({ id, ...values, text: "Кредитная ставка влияет на стоимость финансирования компании.", title: "Ставка", document_id: id, page: 1, url: "https://bank.example/" + id }));
    const result = await h.retrieval.rag({ query: "кредитная ставка", as_of: "2026-10-23T12:00:00Z", limit: 1 }, "rag-publication");
    assert.deepEqual(result.data.items.map((row: { id: string }) => row.id), ["research:current:c0"]);
    const resolved = await h.retrieval.resolve({ source_ids: ["research:current:c0", "research:future:c0"], as_of: "2026-10-23T12:00:00Z" }, "rag-publication-resolve");
    assert.deepEqual(resolved.data.items, result.data.items);
    assert.deepEqual(resolved.data.unknown_ids, ["research:future:c0"]);
  } finally { h.close(); }
});

test("revision ties follow observation order and obsolete future versions never revive", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-24T10:00:00Z") });
  const h = harness();
  try {
    const first = saveNews(h.db, raw());
    saveNews(h.db, raw({ modified: "2099-01-01T00:00:00Z", text: "Банк России сохранил ключевую ставку на уровне 17% годовых. Ошибочная будущая версия." }));
    saveNews(h.db, raw({ text: "Банк России снизил ключевую ставку на 50 б.п. до 16% годовых. Первое исправление." }));
    const last = saveNews(h.db, raw({ text: "Банк России снизил ключевую ставку на 50 б.п. до 15% годовых. Последнее исправление." }));
    for (const as_of of ["2026-10-24T10:00:00Z", "2100-01-01T00:00:00Z"]) {
      const result = await h.retrieval.search({ news_id: first.id, as_of, limit: 1 }, "latest-observed");
      assert.equal(result.data.items[0].sources[0].id, last.source_id);
      assert.match(result.data.items[0].text, /Последнее исправление/);
    }
  } finally { h.close(); }
});
