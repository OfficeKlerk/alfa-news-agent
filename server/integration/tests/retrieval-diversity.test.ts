import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../db.js";
import { loadSettings } from "../../config.js";
import { Retrieval } from "../../retrieval.js";
import { LegacyRetrieval } from "../retrieval.js";
import type { Json } from "../../types.js";

const asOf = "2026-10-24T18:00:00Z";
const page = (document: string, number = 1, text = "ставка ".repeat(800), date: string | null = "2026-09-01") => ({
  id: `${document}:${number}`, document_id: document, filename: `${document}.pdf`, page: number,
  title: document, text, date, url: `https://example.org/${document}.pdf#page=${number}`,
});
function harness(pages: Json[]) {
  const settings = { ...loadSettings({LLM_MODE: "demo", LLM_API_KEY: ""}), dbPath: ":memory:" };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT)");
  for (const p of pages) db.run("INSERT INTO research VALUES(?,?)", p.id, JSON.stringify(p));
  const retrieval = new Retrieval(db);
  return { db, retrieval, adapter: new LegacyRetrieval(db, retrieval, settings) };
}

test("RAG starts with the strongest chunk of each matching document and fills spare places", () => {
  const h = harness([page("a"), page("a", 2), page("b"), page("c"), page("unrelated", 1, "океан")]);
  try {
    const rows = h.retrieval.research("ставка", 20, asOf);
    assert.deepEqual(rows.slice(0, 3).map(r => r.document_id), ["a", "b", "c"]);
    for (const first of rows.slice(0, 3)) {
      assert.equal(first.score, Math.max(...rows.filter(r => r.document_id === first.document_id).map(r => r.score)));
    }
    assert.ok(rows.length > 3);
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
    assert.ok(rows.every(r => r.document_id !== "unrelated"));
    for (const r of rows) assert.ok(rows.filter(s => s.document_id === r.document_id && s.page === r.page).length <= 2);
  } finally { h.db.close(); }
});

test("request limits preserve the same ranking prefix, including extra context", () => {
  const h = harness([page("a"), page("a", 2), page("b"), page("c")]);
  try {
    const all = h.retrieval.research("ставка", 20, asOf);
    for (const limit of [0, 1, 2, 3, 5, 8, 20]) {
      assert.deepEqual(h.retrieval.research("ставка", limit, asOf), all.slice(0, limit));
    }
  } finally { h.db.close(); }
});

test("a single document retains two chunks per page and empty searches stay empty", () => {
  const h = harness([page("a"), page("a", 2)]);
  try {
    assert.equal(h.retrieval.research("ставка", 20, asOf).length, 4);
    assert.deepEqual(h.retrieval.research("океан", 5, asOf), []);
    assert.deepEqual(h.retrieval.research("", 5, asOf), []);
  } finally { h.db.close(); }
});

test("diversity excludes unknown and future dates before selection and preserves resolvable citations", async () => {
  const pages = [page("unknown", 1, "ставка ".repeat(800), null), page("future", 1, "ставка ".repeat(800), "2027-01-01"), page("a"), page("b")];
  const h = harness(pages);
  try {
    const result = await h.adapter.rag({query: "ставка", limit: 20, as_of: asOf}, "diversity");
    const rows = result.data.items;
    assert.deepEqual(rows.slice(0, 2).map((r: Json) => r.document_id), ["a", "b"]);
    assert.ok(rows.every((r: Json) => ["a", "b"].includes(r.document_id) && Date.parse(r.published_at) <= Date.parse(asOf)));
    const resolved = await h.adapter.resolve({source_ids: rows.map((r: Json) => r.id), as_of: asOf}, "resolve");
    assert.deepEqual(resolved.data.unknown_ids, []);
    assert.deepEqual(resolved.data.items, rows);
    for (const r of rows) assert.ok(pages.find(p => p.document_id === r.document_id && p.page === r.page)!.text.includes(r.excerpt));
  } finally { h.db.close(); }
});

test("the highest scoring match remains first even when its document was inserted last", () => {
  const h = harness([page("weak", 1, "ставка океан корабль берег горизонт"), page("strong", 1, "ставка")]);
  try {
    const rows = h.retrieval.research("ставка", 2, asOf);
    assert.deepEqual(rows.map(r => r.document_id), ["strong", "weak"]);
    assert.ok(rows[0].score > rows[1].score);
  } finally { h.db.close(); }
});
