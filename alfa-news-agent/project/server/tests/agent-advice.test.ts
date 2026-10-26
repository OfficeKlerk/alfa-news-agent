import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, validate } from "../agent.js";
import { Store } from "../db.js";
import { Retrieval } from "../retrieval.js";
import { ROOT, type Settings } from "../config.js";
import type { Company, News, Json } from "../types.js";

class AuditStore extends Store {
  profile: Company = { id: "AUDIT", name: "Тестовый профиль", industry: "Производство стали", region: "Москва",
    revenue: 0, products: ["Кредиты"], foreign_trade: false, top_partners: [], data_notes: [] };
  events: Record<string, News> = { original: { id: "original", title: "Учебная ставка",
    text: "Синтетическая новость: условия финансирования изменились. Условия договора неизвестны.",
    url: "https://example.invalid/news", published: "2020-01-01", tags: ["rates"], is_demo: true } };
  override company() { return structuredClone(this.profile); }
  override news(id: string) { return structuredClone(this.events[id]); }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "advice-audit-"));
  const settings: Settings = { root: ROOT, data: dir, dbPath: join(dir, "test.sqlite3"), mode: "demo",
    baseUrl: "https://unused.invalid", apiKey: "", model: "offline-test", maxCalls: 20, maxOutputTokens: 6000,
    maxPlanningTokens: 4000, timeout: 1000, host: "127.0.0.1", port: 0, feeds: [] };
  const db = new AuditStore(settings);
  db.connection.exec("CREATE TABLE analyses(cache_key TEXT PRIMARY KEY, company_id TEXT, news_id TEXT, payload TEXT);"
    + "CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT); CREATE TABLE news(id TEXT PRIMARY KEY);"
    + "CREATE TABLE chats(id INTEGER PRIMARY KEY,company_id TEXT,analysis_id TEXT,question TEXT,answer TEXT)");
  const retrieval = new Retrieval(db);
  return { settings, db, retrieval, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const noModel = async (): Promise<Json> => { throw new Error("This fixture must not call any model"); };
const candidate = (a: Json) => Object.fromEntries(["summary", "why_relevant", "claims", "risks", "opportunities", "actions", "limitations"]
  .map(key => [key, structuredClone(a[key])]));

test("legacy cache invalidates after profile, news metadata or bank corpus changes", async () => {
  const f = fixture();
  try {
    const agent = new Agent(f.settings, f.db, f.retrieval, noModel);
    const first = await agent.analyze("AUDIT", "original", "cfo");
    assert.equal((await agent.analyze("AUDIT", "original", "cfo")).cached, true);
    f.db.profile.products = [];
    const second = await agent.analyze("AUDIT", "original", "cfo");
    assert.equal(second.cached, false); assert.notEqual(first.id, second.id);
    f.db.events.original.title = "Исправленный заголовок";
    const third = await agent.analyze("AUDIT", "original", "cfo");
    assert.equal(third.cached, false); assert.notEqual(second.id, third.id);
    f.db.run("INSERT INTO research VALUES(?,?)", "new", JSON.stringify({ id: "new", title: "Ставка", text: "Ставка и кредит: исторический контекст.", published_at: "2020-01-01" }));
    assert.equal((await agent.analyze("AUDIT", "original", "cfo")).cached, false);
  } finally { f.close(); }
});
test("legacy live context includes ranking and time; future/undated bank chunks and unrelated/future news are excluded", async () => {
  const f = fixture();
  try {
    const initial = await new Agent(f.settings, f.db, f.retrieval, noModel).analyze("AUDIT", "original", "cfo");
    for (const [id, date] of [["past", "2020-01-01"], ["future", "2099-01-01"], ["undated", null]])
      f.db.run("INSERT INTO research VALUES(?,?)", id, JSON.stringify({ id, title: "Ставка: " + id,
        text: "Ставка и кредит: историческая аналитика " + id, published_at: date }));
    for (const [id, date, text] of [["past-news", "2020-01-02", "Ставка кредит финансирование"],
      ["future-news", "2099-01-02", "Ставка кредит финансирование"], ["unrelated-news", "2020-01-02", "Погода и музей"]]) {
      f.db.events[id] = { ...f.db.events.original, id, published: date, text };
      f.db.run("INSERT INTO news VALUES(?)", id);
    }
    f.settings.mode = "live";
    const seen: Json[][] = []; let call = 0;
    const agent = new Agent(f.settings, f.db, f.retrieval, async messages => {
      seen.push(structuredClone(messages)); call++;
      if (call === 1) return { tool_calls: ["search_research", "find_related_news"].map((name, i) =>
        ({ id: "tool-" + i, function: { name, arguments: JSON.stringify({ query: "ставка кредит" }) } })) };
      if (call === 2) return { content: "Контекст получен" };
      return { content: JSON.stringify(candidate(initial)) };
    });
    const result = await agent.analyze("AUDIT", "original", "cfo", true);
    const user = JSON.parse(seen[0][1].content);
    assert.equal(user.ranking.score_kind, "legacy_manual_heuristic");
    assert.deepEqual(user.ranking.reasons, f.retrieval.rank(f.db.profile, f.db.events.original).reasons);
    assert.ok(Number.isFinite(Date.parse(user.as_of))); assert.equal(result.as_of, user.as_of);
    assert.deepEqual(result.sources.filter(s => s.kind === "bank").map(s => s.id), ["research:past:c0"]);
    assert.ok(result.sources.some(s => s.id === "news:past-news"));
    assert.ok(!result.sources.some(s => s.id.includes("future") || s.id.includes("undated") || s.id.includes("unrelated")));
  } finally { f.close(); }
});
test("legacy facts must quote every cited source and shared numeric tokens do not establish company loss", async () => {
  const f = fixture();
  try {
    const original = await new Agent(f.settings, f.db, f.retrieval, noModel).analyze("AUDIT", "original", "cfo");
    const sources = Object.fromEntries(original.sources.map(s => [s.id, s]));
    assert.deepEqual(validate(candidate(original), sources), []);
    const invented = candidate(original); invented.claims[0].text = "Компания обязана изменить договор";
    assert.ok(validate(invented, sources).some(e => e.includes("дословной цитатой")));
    sources["news:original"].text += " Ключевая ставка составляет 14%.";
    const laundered = candidate(original); laundered.claims[1].text = "Расходы компании вырастут на 14%.";
    assert.ok(validate(laundered, sources).some(e => e.includes("финансовый вывод")));
  } finally { f.close(); }
});
test("legacy follow-up rejects a mismatched saved identity and invented financial amounts", async () => {
  const f = fixture();
  try {
    const original = await new Agent(f.settings, f.db, f.retrieval, noModel).analyze("AUDIT", "original", "cfo");
    const corrupted = { ...original, company_id: "OTHER" };
    f.db.run("UPDATE analyses SET payload=? WHERE cache_key=?", JSON.stringify(corrupted), original.id);
    await assert.rejects(new Agent(f.settings, f.db, f.retrieval, noModel).answer("AUDIT", original.id, "Что проверить?"), /контексту/);
    f.settings.mode = "live";
    f.db.run("UPDATE analyses SET payload=? WHERE cache_key=?", JSON.stringify({ ...original, mode: "live", model: f.settings.model }), original.id);
    const agent = new Agent(f.settings, f.db, f.retrieval, async () => ({ content: JSON.stringify({
      answer: "Компания потеряет 14% прибыли.", source_ids: ["company", "news:original"] }) }));
    await assert.rejects(agent.answer("AUDIT", original.id, "Какие потери?"), /финансовый вывод/);
    assert.equal(f.db.get("SELECT count(*) n FROM chats")!.n, 0);
  } finally { f.close(); }
});
