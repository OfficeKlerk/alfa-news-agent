import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../types.js";
import type { Settings } from "../../config.js";
import { Store } from "../../db.js";
import { Retrieval } from "../../retrieval.js";
import { saveNews } from "../../news.js";
import { LegacyRetrieval } from "../retrieval.js";
import { sourceBalancedCandidates } from "../news-candidates.js";

function event(id: string, host: string): Json {
  return { news_id: id, sources: [{ kind: "news", url: `https://${host}/${id}` }] };
}

test("busy publisher cannot remove a sparse publisher before personalization", () => {
  const busy = Array.from({ length: 100 }, (_, i) => event("busy" + i, "tass.ru"));
  const sparse = [event("rate", "www.cbr.ru"), event("other", "cbr.ru")];
  const selected = sourceBalancedCandidates([...busy, ...sparse], 100);
  assert.equal(selected.balanced, true);
  assert.equal(selected.items.length, 100);
  assert.deepEqual(selected.items.slice(-2).map(item => item.news_id), ["rate", "other"]);
  assert.deepEqual(selected.items.slice(0, -2), busy.slice(0, 98), "source quotas must preserve ordering and fill all free slots");
});

test("balanced candidates preserve global order, single-source behavior and bounded size", () => {
  const mixed = [event("a1", "a.test"), event("a2", "www.a.test"), event("b1", "b.test"), event("a3", "a.test"), event("b2", "b.test")];
  assert.deepEqual(sourceBalancedCandidates(mixed, 3).items.map(item => item.news_id), ["a1", "a2", "b1"]);
  assert.deepEqual(sourceBalancedCandidates(mixed, 4).items.map(item => item.news_id), ["a1", "a2", "b1", "b2"]);
  assert.deepEqual(sourceBalancedCandidates(mixed, 10), { items: mixed, balanced: false });
  assert.deepEqual(sourceBalancedCandidates([mixed[0], mixed[1], mixed[3]], 2), { items: mixed.slice(0, 2), balanced: false });
});

test("real retrieval retains an older rate announcement after 100 newer reports, with metadata warnings", async () => {
  const folder = mkdtempSync(join(tmpdir(), "alfa-news-candidates-"));
  const settings = { dbPath: join(folder, "news.sqlite"), feeds: [] as string[] } as Settings, db = new Store(settings);
  db.connection.exec(`CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER);
    CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT);
    CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));`);
  try {
    const rate = saveNews(db, { title: "Решение Банка России", text: "Банк России сохранил ключевую ставку на прежнем уровне. Решение опубликовано официально.",
      url: "https://www.cbr.ru/rate", published: "2026-10-23T10:00:00Z", content_scope: "feed_excerpt", feed_url: "https://www.cbr.ru/rss" });
    for (let i = 0; i < 100; i++) saveNews(db, { title: "Новости предприятия " + i,
      text: "Предприятие сообщает о текущей работе. Дополнительных решений для компаний в сообщении нет.",
      url: "https://tass.ru/item/" + i, published: "2026-10-24T10:00:00Z" });
    const retrieval = new LegacyRetrieval(db, new Retrieval(db), settings);
    const body = { query: "", as_of: "2026-10-25T10:00:00Z", limit: 100, news_id: null };
    const response = await retrieval.search(body, "balanced-candidates");
    assert.equal(response.data.items.length, 100);
    assert.ok(response.data.items.some((item: Json) => item.news_id === rate.id));
    assert.ok(response.meta.warnings.includes("source_balanced_candidate_window"));
    assert.ok(response.meta.warnings.includes("rss_excerpt_only_full_article_not_fetched"));
    const direct = await retrieval.search({ ...body, news_id: rate.id, limit: 1 }, "explicit-news");
    assert.equal(direct.data.items[0].news_id, rate.id);
    assert.equal(direct.meta.warnings.includes("source_balanced_candidate_window"), false);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("promoted official full text keeps its publisher slot even when a teaser announced the event first", () => {
  const busy = Array.from({length:100},(_,i)=>event("reprint"+i,"finam.ru"));
  const decision = {news_id:"first-teaser",title:"Официальное решение Банка России",text:"Полный текст решения",sources:[
    {kind:"news",url:"https://finam.ru/early",title:"Короткий анонс",excerpt:"Анонс"},
    {kind:"news",url:"https://www.cbr.ru/press/decision",title:"Официальное решение Банка России",excerpt:"Полный текст решения"},
  ]};
  const selected=sourceBalancedCandidates([...busy,decision],10);
  assert.ok(selected.items.includes(decision));assert.equal(selected.items.length,10);
});
