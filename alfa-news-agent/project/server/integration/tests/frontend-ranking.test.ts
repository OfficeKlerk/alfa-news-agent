import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { Json } from "../../types.js";

const adapter = readFileSync(new URL("../../../frontend/v1-adapter.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../../../frontend/app.js", import.meta.url), "utf8");

function browser(ranked: Json[]) {
  const elements = new Map<string, Json>();
  const storage = new Map<string, string>();
  const events = ranked.map(item => ({ news_id: item.news_id, title: "Тест новости " + item.news_id,
    published_at: "2026-10-24T10:00:00Z", is_mock: false }));
  const context = createContext({
    window: {}, location: { search: "?api=v1" }, URLSearchParams, URL,
    console: { info() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    document: { addEventListener() {}, querySelectorAll: () => [], querySelector: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", checked: false,
        addEventListener() {}, classList: { toggle() {} } });
      return elements.get(selector);
    } },
    fetch: async (path: string) => {
      // App startup stays pending so the test can exercise the real adapter and
      // renderer directly without a server, browser navigation or model call.
      if (path === "/v1/health" || path === "/v1/companies") return new Promise(() => {});
      if (path === "/v1/tools/search_news") return { ok: true, json: async () => ({ data: { items: events } }) };
      if (path === "/v1/rank") return { ok: true, json: async () => ({ data: { items: ranked } }) };
      throw new Error("Unexpected browser request: " + path);
    },
  });
  runInContext(adapter, context, { filename: "v1-adapter.js" });
  runInContext(app, context, { filename: "app.js" });
  return {
    async feed() {
      const result = await context.window.__V1.handle("/api/feed?demo=1", { headers: { "X-Company-ID": "U_TEST" } });
      return result.items as Json[];
    },
    render(items: Json[]) {
      context.testFeedItems = items;
      runInContext("state.news = testFeedItems; renderFeed();", context);
      return elements.get("#feed")!.innerHTML as string;
    },
  };
}

function item(news_id: string, score: unknown, score_kind?: unknown): Json {
  return { news_id, event_id: news_id, score, score_kind, feature_version: "company_event_v2",
    reasons: [{ text: "Синтетический тест отображения" }], warnings: [] };
}

test("frontend adapter preserves raw baseline scores without percentage or importance conversion", async () => {
  const page = browser([item("large", 1.068452, "manual_feature_baseline"),
    item("negative", -.25, "manual_feature_baseline"), item("zero", 0, "manual_feature_baseline"),
    item("missing", null, "manual_feature_baseline")]);
  const items = await page.feed();
  assert.deepEqual(Array.from(items, news => news.score), [1.068452, -.25, 0, null]);
  assert.ok(items.every(news => news.score_kind === "manual_feature_baseline" && news.feature_version === "company_event_v2"));
  assert.ok(items.every(news => !Object.hasOwn(news, "priority") && !Object.hasOwn(news, "relevance")));
  const html = page.render(items);
  assert.match(html, /Баллы по правилам/);
  assert.match(html, /Балл 1,06845/);
  assert.match(html, /Балл -0,25/);
  assert.match(html, /Балл 0</);
  assert.match(html, /Балл недоступен/);
  assert.doesNotMatch(html, /107|\/ 100|Высокий приоритет|Средний приоритет|Низкий приоритет/);
  assert.equal((html.match(/class="priority low"/g) ?? []).length, 4);
});

test("uncalibrated logistic and mock scores have distinct labels without probabilities", async () => {
  const page = browser([item("model", .93, "logistic_relevance_uncalibrated"), item("mock", .8, "mock")]);
  const items = await page.feed();
  assert.equal(items[0].score, .93);
  assert.equal(items[1].score, .8);
  const html = page.render(items);
  assert.match(html, /Модель · без калибровки/);
  assert.match(html, /Тестовая оценка/);
  assert.match(html, /Балл 0,93/);
  assert.match(html, /Балл 0,8/);
  assert.doesNotMatch(html, /93%|80%|\/ 100|Высокий приоритет/);
});

test("unknown scales and invalid or missing scores do not fall back to a zero probability", async () => {
  const page = browser([item("unknown", .8), item("absent", undefined, "mock"),
    item("string", "0.8", "manual_feature_baseline"), item("infinite", Infinity, "mock"),
    item("prototype", .5, "__proto__")]);
  const items = await page.feed();
  assert.equal(items[0].score_kind, null);
  assert.equal(items[0].score, .8);
  for (const news of items.slice(1, 4)) assert.equal(news.score, null);
  const html = page.render(items);
  assert.match(html, /Шкала не указана/);
  assert.equal((html.match(/Балл недоступен/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Балл 0<|\/ 100|Высокий приоритет/);
});

test("legacy feed keeps its existing explicitly scaled index", () => {
  const page = browser([]);
  const html = page.render([{ id: "legacy", title: "Старый формат", published: "2026-10-24", reasons: ["Сигнал"],
    relevance: 54, priority: "Средний", is_demo: false }]);
  assert.match(html, /Средний приоритет/);
  assert.match(html, /Индекс 54 \/ 100/);
});
