import { developmentAccess } from "../access.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT, type Settings } from "../../config.js";
import { Store } from "../../db.js";
import { saveNews } from "../../news.js";
import type { Json } from "../../types.js";
import { createGateway } from "../gateway.js";
import { ContractClient } from "../client.js";
import { envelope, validate } from "../contracts.js";
import type { AgentPort } from "../agent.js";
import { HttpRetrieval, MockRetrieval, type RetrievalPort } from "../retrieval.js";
import { evaluationCases } from "../evaluation.js";

const requestId = "live-runtime-test";
const headers = { "Content-Type": "application/json", "X-Request-ID": requestId };

async function harness(options: { analysisEnabled?: boolean; retrieval?: RetrievalPort; ml?: ContractClient } = {}) {
  const calls: string[] = [];
  const unexpected = async (name: string): Promise<never> => { calls.push(name); throw new Error("Unexpected provider call: " + name); };
  const ml = new ContractClient("http://ml.invalid", 500, (async () => unexpected("ml")) as typeof fetch);
  const agent: AgentPort = { analyze: () => unexpected("agent.analyze"), answer: () => unexpected("agent.answer") };
  const retrieval: RetrievalPort = {
    search: () => unexpected("retrieval.search"), rag: () => unexpected("retrieval.rag"), resolve: () => unexpected("retrieval.resolve"),
  };
  const server = createGateway({access:developmentAccess, ml, agent, retrieval, ...options }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  return {
    calls,
    async call(path: string, body?: Json) {
      const response = await fetch(base + path, {
        headers, method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() as Json };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("runtime exposes the configured generation gate without calling any provider", async () => {
  for (const analysisEnabled of [false, true, undefined]) {
    const h = await harness({ analysisEnabled });
    try {
      const result = await h.call("/v1/runtime");
      assert.equal(result.status, 200);
      validate("RuntimeDataResponse", result.value);
      assert.deepEqual(result.value.data, { generation_enabled: analysisEnabled !== false });
      assert.equal(result.value.meta.request_id, requestId);
      assert.deepEqual(h.calls, []);
    } finally { await h.close(); }
  }
});

test("disabled generation gates analyze, analyze-event and questions before validation or providers", async () => {
  const h = await harness({ analysisEnabled: false });
  try {
    for (const path of ["/v1/analyze", "/v1/analyze-event", "/v1/analyses/missing-session/questions"]) {
      // Express also accepts case variants and a final slash for these routes.
      for (const variant of [path, path + "/", path.toUpperCase(), path.toUpperCase() + "/"]) {
        const result = await h.call(variant, {});
        assert.equal(result.status, 503, variant);
        validate("Error", result.value);
        assert.equal(result.value.error.code, "DEPENDENCY_UNAVAILABLE", variant);
        assert.match(result.value.error.message, /Генерация выключена/);
        assert.equal(result.value.request_id, requestId);
      }
    }
    assert.deepEqual(h.calls, []);
    const runtime = await h.call("/v1/runtime");
    assert.equal(runtime.value.data.generation_enabled, false);
  } finally { await h.close(); }
});

test("enabled generation reaches ordinary request and session checks", async () => {
  const h = await harness({ analysisEnabled: true });
  try {
    for (const path of ["/v1/analyze", "/v1/analyze-event"])
      assert.equal((await h.call(path, {})).status, 422);
    const question = await h.call("/v1/analyses/missing-session/questions", { company_id: "U_A", question: "Что уточнить?" });
    assert.equal(question.status, 404);
    assert.equal(question.value.error.code, "NOT_FOUND");
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test("feed status is forwarded through the selected HTTP retrieval with its status and request ID", async () => {
  const seen: Json[] = [];
  let data: Json = {
    enabled: true, running: false, poll_seconds: 300, last_success: "2026-10-25T09:00:00Z",
    feeds: [{ url: "https://example.org/rss", last_attempt: "2026-10-25T09:05:00Z", last_success: "2026-10-25T09:00:00Z",
      last_error: "Не удалось загрузить или обработать RSS", next_attempt: "2026-10-25T09:10:00Z", consecutive_failures: 1 }],
  };
  const retrieval = new HttpRetrieval(new ContractClient("http://retrieval.invalid", 500, (async (url, init) => {
    seen.push({ url: String(url), method: init?.method, request_id: new Headers(init?.headers).get("X-Request-ID") });
    return Response.json(envelope(data, requestId, "live", ["status_test"]));
  }) as typeof fetch));
  const h = await harness({ analysisEnabled: false, retrieval });
  try {
    const result = await h.call("/v1/feeds/status");
    assert.equal(result.status, 200);
    validate("FeedStatusDataResponse", result.value);
    assert.deepEqual(result.value.data, data);
    assert.equal(result.value.meta.request_id, requestId);
    assert.deepEqual(result.value.meta.warnings, ["status_test"]);
    assert.deepEqual(seen, [{ url: "http://retrieval.invalid/v1/feeds/status", method: "GET", request_id: requestId }]);
    assert.deepEqual(h.calls, []);
    data = { ...data, poll_seconds: 0 };
    const invalid = await h.call("/v1/feeds/status");
    assert.equal(invalid.status, 502);
    assert.equal(invalid.value.error.code, "CONTRACT_VIOLATION");
  } finally { await h.close(); }
});

test("feed status rejects a malformed in-process provider and reports unsupported providers", async () => {
  const retrieval: RetrievalPort = {
    search: async () => { throw new Error("not used"); }, rag: async () => { throw new Error("not used"); }, resolve: async () => { throw new Error("not used"); },
    status: async id => envelope({ enabled: true, running: false, poll_seconds: 300, last_success: null, feeds: "invalid" }, id, "live"),
  };
  const malformed = await harness({ retrieval });
  try {
    const result = await malformed.call("/v1/feeds/status");
    assert.equal(result.status, 502);
    assert.equal(result.value.error.code, "CONTRACT_VIOLATION");
  } finally { await malformed.close(); }
  const unsupported = await harness();
  try {
    const result = await unsupported.call("/v1/feeds/status");
    assert.equal(result.status, 503);
    assert.equal(result.value.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(unsupported.calls, []);
  } finally { await unsupported.close(); }
});

test("RSS refresh gets a batch deadline while ordinary retrieval keeps its shorter timeout", async () => {
  const retrieval = new HttpRetrieval(new ContractClient("http://retrieval.invalid", 1, (async (_url, init) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    init?.signal?.throwIfAborted();
    return Response.json(envelope({ processed: 1, failed_hosts: [] }, requestId, "live"));
  }) as typeof fetch));
  const result = await retrieval.refresh({}, requestId);
  validate("FeedRefreshDataResponse", result);
  assert.equal(result.data.processed, 1);
  await assert.rejects(() => retrieval.status(requestId), { status: 504, code: "DEPENDENCY_TIMEOUT" });
});

test("generation disabled still permits ranking context and identifies selected article text as potentially incomplete", async () => {
  const { input } = evaluationCases()[0], paths: string[] = [];
  const ml = new ContractClient("http://ml.invalid", 500, (async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const data = path === "/v1/rank"
      ? { company_id: input.company_id, as_of: input.as_of, items: [input.ranked_item], excluded_future_news_ids: [], truncated: false }
      : structuredClone(input.profile);
    return Response.json(envelope(data, new Headers(init?.headers).get("X-Request-ID")!, "mock"));
  }) as typeof fetch);
  const h = await harness({ analysisEnabled: false, ml, retrieval: new MockRetrieval() });
  try {
    const result = await h.call("/v1/analysis-context", {
      company_id: input.company_id, event: input.event, as_of: input.as_of, audience_role: input.audience_role,
    });
    assert.equal(result.status, 200);
    validate("PreparedContextDataResponse", result.value);
    assert.ok(result.value.data.input.research.limitations.some((text: string) => /Анализ ограничен переданным текстом новости/.test(text)));
    assert.ok(result.value.data.input.research.limitations.some((text: string) => /полный текст страницы по ссылке не проверялся/.test(text)));
    assert.deepEqual(paths.sort(), ["/v1/companies/" + input.company_id, "/v1/rank"].sort());
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test("newsSeedMode none starts with no selected news and preserves collected news after reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alfa-live-seeds-")), data = join(directory, "data");
  mkdirSync(data);
  for (const [name, contents] of Object.entries({
    "df_Uid_data_hack.csv": "SYNTHETIC_U;MAINOKVED_NAME;REGION;REVENUE_COMPANY\nU_A;Производство;Москва;10\n",
    "df_Uid_payment_hack.csv": "BENEFICIARY;PAYER;PAY_AMT;PAY_CNT\n",
    "df_Fid_Uid_link_hack.csv": "SYNTHETIC_F;SYNTHETIC_U\n",
  })) writeFileSync(join(data, name + ".gz"), gzipSync(contents));
  writeFileSync(join(data, "research.json"), "[]");
  // Both files exist but would fail JSON parsing if startup attempted to load them.
  writeFileSync(join(data, "demo_news.json"), "fixture import must be disabled");
  writeFileSync(join(data, "reviewed_news.json"), "reviewed fixture import must be disabled");
  const settings: Settings = { root: ROOT, data, dbPath: join(directory, "app.sqlite3"), mode: "demo", newsSeedMode: "none",
    baseUrl: "https://provider.invalid/v1", apiKey: "", model: "test-only", maxCalls: 1, maxOutputTokens: 1000,
    maxPlanningTokens: 1000, timeout: 1000, host: "127.0.0.1", port: 0, feeds: [] };
  let db = new Store(settings);
  try {
    await db.initialize();
    assert.equal(db.get("SELECT count(*) AS n FROM news")!.n, 0);
    assert.equal(db.get("SELECT count(*) AS n FROM news_versions")!.n, 0);
    assert.equal(db.get("SELECT count(*) AS n FROM companies")!.n, 1);
    const saved = saveNews(db, { title: "Сообщение из подключённой ленты", text: "Получено новое сообщение из подключённого источника с известной датой публикации.",
      url: "https://example.org/collected", published: "2026-10-24T09:00:00Z", is_mock: false });
    assert.equal(saved.ingestion_status, "inserted");
    db.close(); db = new Store(settings);
    await db.initialize();
    assert.equal(db.get("SELECT count(*) AS n FROM news")!.n, 1);
    assert.equal(db.news(saved.id).is_demo, false);
    assert.equal(db.news(saved.id).url, "https://example.org/collected");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
