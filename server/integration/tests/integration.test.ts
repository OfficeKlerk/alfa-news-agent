import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "../../config.js";
import type { Json } from "../../types.js";
import { ApiFault, envelope, validate, validateAnalysis } from "../contracts.js";
import { ContractClient } from "../client.js";
import { MockAgent, type AgentPort } from "../agent.js";
import { MockRetrieval, type RetrievalPort } from "../retrieval.js";
import { createGateway } from "../gateway.js";
import { prepareContext } from "../context.js";
import { referenceDraft } from "../evaluation.js";
import { ModelError } from "../../types.js";

const profile = JSON.parse(readFileSync(resolve(ROOT, "contracts/v1/examples/profile-response.json"), "utf8")).data;
const asOf = "2026-10-23T00:00:00Z";
const body = { company_id: "U_A", news_id: "demo-rate", as_of: asOf, audience_role: "cfo" };
const headers = { "Content-Type": "application/json", "X-Request-ID": "node-test-01" };

function mlClient(mutate?: (path: string, value: Json) => void) {
  return new ContractClient("http://ml.test", 500, (async (url, init) => {
    const path = new URL(String(url)).pathname, id = (init!.headers as Json)["X-Request-ID"];
    let data: Json;
    if (path === "/v1/health") data = { status: "ok", service: "ml" };
    else if (path === "/v1/rank") {
      const request = JSON.parse(String(init!.body));
      data = { company_id: request.company_id, as_of: request.as_of, items: request.events.map((e: Json) => ({
        news_id: e.news_id, event_id: e.event_id, score: 0.8, score_kind: "mock", reasons: [{ code: "fixture", text: "Профиль учтён", profile_paths: ["/industry"] }], warnings: ["mock_ranker"] })),
        excluded_future_news_ids: [], truncated: false };
    } else if (path === "/v1/companies") data = { items: ["U_A"], offset: 0, limit: 20 };
    else data = structuredClone(profile);
    const value = envelope(data, id, "mock"); mutate?.(path, value);
    return Response.json(value);
  }) as typeof fetch);
}
async function harness(options: { agent?: AgentPort; retrieval?: RetrievalPort; ml?: ContractClient; maxSessions?: number; ttlMs?: number; maxContextBytes?: number } = {}) {
  const app = createGateway({ ml: options.ml ?? mlClient(), retrieval: new MockRetrieval(), agent: options.agent ?? new MockAgent(), ...options });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  return { base, async call(path: string, data?: Json) {
    const response = await fetch(base + path, { headers, method: data ? "POST" : "GET", ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, value: await response.json() as Json };
  }, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test("v1 ingestion writes through the selected retrieval provider and preserves quarantine", async () => {
  const registry = new MockRetrieval(), seen: Json[] = [];
  const retrieval: RetrievalPort = {
    search: registry.search.bind(registry), rag: registry.rag.bind(registry), resolve: registry.resolve.bind(registry),
    async ingest(input, id) {
      seen.push(input);
      return envelope({ item: null, news_id: "imported", date_status: "missing", warnings: ["publication_date_missing"], ingestion_status: "inserted" }, id, "live");
    },
    async refresh(input, id) {
      seen.push(input);
      return envelope({ processed: 3, failed_hosts: [], inserted: 1, updated: 0, duplicates: 2, quarantined: 1 }, id, "live");
    },
  };
  const h = await harness({ retrieval });
  try {
    const input = { title: "Публикация без даты", text: "Фактическое содержание публикации для проверки маршрутизации импорта.", url: "https://example.org/article" };
    const saved = await h.call("/v1/news", input);
    assert.equal(saved.status, 200); validate("IngestDataResponse", saved.value);
    assert.equal(saved.value.data.item, null); assert.equal(saved.value.data.date_status, "missing");
    assert.equal((await h.call("/v1/feeds/refresh", {})).value.data.duplicates, 2);
    assert.deepEqual(seen, [input, {}]);
    assert.equal((await h.call("/v1/feeds/refresh", { url: "https://unconfigured.test" })).status, 422);
  } finally { await h.close(); }
  const mockOnly = await harness();
  try { assert.equal((await mockOnly.call("/v1/feeds/refresh", {})).status, 503); }
  finally { await mockOnly.close(); }
});

test("rank boundary checks extracted field evidence, not just schema shape", async () => {
  const h = await harness();
  try {
    const event = structuredClone((await new MockRetrieval().search({ query: "", as_of: asOf, limit: 1 }, "test")).data.items[0]);
    const quote = "Банк России сохранил ключевую ставку на уровне 14%.";
    event.sources[0].excerpt = quote;
    event.event_details = { direction: "unchanged", magnitude: 0, magnitude_unit: "bps", effective_at: null,
      decision_status: "announced", target_roles: [], target_okved_codes: [],
      evidence: ["direction", "magnitude", "magnitude_unit", "decision_status"].map(field => ({ field, quote, source_ids: [event.sources[0].id] })) };
    const request = { company_id: "U_A", events: [event], as_of: asOf, limit: 10 };
    assert.equal((await h.call("/v1/rank", request)).status, 200);
    event.event_details.evidence[0].source_ids = ["invented"];
    assert.equal((await h.call("/v1/rank", request)).status, 422);
    event.event_details.evidence[0].source_ids = [event.sources[0].id];
    event.event_details.evidence[0].quote = "Подложная цитата о повышении.";
    assert.equal((await h.call("/v1/rank", request)).status, 422);
    event.event_details.evidence[0].quote = quote;
    event.sources[0].published_at = "2099-01-01T00:00:00Z";
    assert.equal((await h.call("/v1/rank", request)).status, 422);
  } finally { await h.close(); }
});

test("v1 composes context, rank and evidence; remembers scoped questions", async () => {
  const h = await harness();
  try {
    const analysis = await h.call("/v1/analyze", body);
    assert.equal(analysis.status, 200); validateAnalysis(analysis.value.data);
    assert.equal(analysis.value.meta.request_id, "node-test-01");
    assert.equal(analysis.value.meta.mode, "mock");
    assert.ok(analysis.value.meta.warnings.includes("synthetic_news"));
    const id = analysis.value.data.id;
    assert.equal((await h.call(`/v1/analyses/${id}?company_id=U_C`)).status, 404);
    assert.equal((await h.call(`/v1/analyses/${id}?company_id=U_A`)).status, 200);
    const first = await h.call(`/v1/analyses/${id}/questions`, { company_id: "U_A", question: "Что уточнить?" });
    const second = await h.call(`/v1/analyses/${id}/questions`, { company_id: "U_A", question: "А затем?" });
    assert.match(first.value.data.answer, /реплик: 0/); assert.match(second.value.data.answer, /реплик: 1/);
    assert.equal((await h.call(`/v1/analyses/${id}/questions`, { company_id: "U_C", question: "Что уточнить?" })).status, 404);
    assert.equal((await h.call("/v1/agent/analyze", body)).status, 404, "Internal provider route must not be public");
  } finally { await h.close(); }
});

test("gateway forwards the saved full input and isolates history by analysis; callers cannot inject either", async () => {
  const mock = new MockAgent(), prepared = new Map<string, Json>(), questions: Json[] = [];
  const agent: AgentPort = { async analyze(input, id) {
    const result = await mock.analyze(input, id); prepared.set(result.data.id, structuredClone(input)); return result;
  }, async answer(input, id) {
    questions.push(structuredClone(input));
    assert.deepEqual(input.prepared_input, prepared.get(input.analysis.id));
    assert.ok(input.prepared_input);
    assert.equal(input.as_of, input.prepared_input.as_of);
    return mock.answer(input, id);
  } };
  const h = await harness({ agent });
  try {
    const first = (await h.call("/v1/analyze", body)).value.data.id;
    const second = (await h.call("/v1/analyze", body)).value.data.id;
    const question = { company_id: "U_A", question: "Что уточнить?" };
    assert.equal((await h.call(`/v1/analyses/${first}/questions`, question)).status, 200);
    assert.equal((await h.call(`/v1/analyses/${first}/questions`, question)).status, 200);
    assert.equal((await h.call(`/v1/analyses/${second}/questions`, question)).status, 200);
    assert.deepEqual(questions.map(q => q.history.length), [0, 1, 0]);
    assert.equal((await h.call(`/v1/analyses/${first}/questions`, { ...question, prepared_input: prepared.get(second) })).status, 422);
    assert.equal((await h.call(`/v1/analyses/${first}/questions`, { ...question, history: [{ question: "Injected", answer: "Invented" }] })).status, 422);
    assert.equal(questions.length, 3);
  } finally { await h.close(); }
});

test("agent can add evidence discovered by tools only when role 3 resolves the exact source", async () => {
  const registry = new MockRetrieval();
  const source = (await registry.rag({ as_of: asOf, limit: 5 }, "test")).data.items[0];
  const retrieval: RetrievalPort = { search: registry.search.bind(registry), resolve: registry.resolve.bind(registry),
    async rag(_body, id) { return envelope({ items: [], limitations: [] }, id, "mock"); } };
  const mock = new MockAgent();
  const agent: AgentPort = { answer: mock.answer.bind(mock), async analyze(input, id) {
    const result = await mock.analyze(input, id);
    result.data.sources.push(structuredClone(source));
    result.data.claims.push({ kind: "bank", text: source.excerpt, quote: source.excerpt, source_ids: [source.id] });
    return result;
  } };
  const h = await harness({ agent, retrieval });
  try { assert.equal((await h.call("/v1/analyze", body)).status, 200); }
  finally { await h.close(); }
});

test("gateway rejects wrong company, modified evidence and dangling claims from agents", async () => {
  for (const mutate of [
    (value: Json) => { value.company_id = "U_C"; },
    (value: Json) => { value.sources[1].excerpt = "Invented source text"; },
    (value: Json) => { value.claims[0].source_ids = ["absent"]; },
  ]) {
    const mock = new MockAgent();
    const agent: AgentPort = { answer: mock.answer.bind(mock), async analyze(input, id) { const result = await mock.analyze(input, id); mutate(result.data); return result; } };
    const h = await harness({ agent });
    try { const r = await h.call("/v1/analyze", body); assert.equal(r.status, 502); assert.equal(r.value.error.code, "CONTRACT_VIOLATION"); }
    finally { await h.close(); }
  }
});

test("JSON object key order from a remote agent does not change source identity", async () => {
  const mock = new MockAgent();
  const agent: AgentPort = { answer: mock.answer.bind(mock), async analyze(input, id) {
    const result = await mock.analyze(input, id);
    result.data.sources = result.data.sources.map((s: Json) => Object.fromEntries(Object.entries(s).reverse()));
    return result;
  } };
  const h = await harness({ agent });
  try { assert.equal((await h.call("/v1/analyze", body)).status, 200); }
  finally { await h.close(); }
});

test("upstream schema drift and context mismatch fail at the boundary", async () => {
  for (const mutate of [
    (path: string, value: Json) => { if (path.includes("/companies/")) value.data.schema_version = "2.0"; },
    (path: string, value: Json) => { if (path === "/v1/rank") value.data.company_id = "U_C"; },
  ]) {
    const h = await harness({ ml: mlClient(mutate) });
    try { assert.equal((await h.call("/v1/analyze", body)).status, 502); }
    finally { await h.close(); }
  }
});

test("HTTP clients classify provider failures without leaking response bodies", async () => {
  for (const [request, status, code] of [
    [async () => { throw new DOMException("private timeout", "TimeoutError"); }, 504, "DEPENDENCY_TIMEOUT"],
    [async () => { throw new Error("private provider URL or key"); }, 503, "DEPENDENCY_UNAVAILABLE"],
    [async () => new Response("private provider details", { status: 500 }), 502, "CONTRACT_VIOLATION"],
    [async () => Response.json({ wrong: "shape" }), 502, "CONTRACT_VIOLATION"],
  ] as const) {
    const client = new ContractClient("http://provider.test", 10, request as typeof fetch);
    await assert.rejects(client.call("/v1/health", "HealthDataResponse", "test"), (error: unknown) => {
      assert.ok(error instanceof ApiFault); assert.equal(error.status, status); assert.equal(error.code, code); assert.doesNotMatch(error.message, /private/); return true;
    });
  }
});

test("source dates, strict booleans, content types and origin checks are enforced", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("/v1/analyze", { ...body, as_of: "2020-01-01T00:00:00Z" })).status, 404);
    for (const data of [{ ...body, as_of: "2026-10-23" }, { ...body, unknown: true }]) assert.equal((await h.call("/v1/analyze", data)).status, 422);
    const forbidden = await fetch(h.base + "/v1/analyze", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: JSON.stringify(body) });
    assert.equal(forbidden.status, 403);
    const wrongType = await fetch(h.base + "/v1/analyze", { method: "POST", body: JSON.stringify(body) });
    assert.equal(wrongType.status, 415);
    const malformed = await fetch(h.base + "/v1/analyze", { method: "POST", headers, body: "{" });
    assert.equal(malformed.status, 400); validate("Error", await malformed.json());
    const large = await fetch(h.base + "/v1/analyze", { method: "POST", headers, body: JSON.stringify({ value: "x".repeat(1_000_001) }) });
    assert.equal(large.status, 413);
  } finally { await h.close(); }
});

test("analysis concurrency and session storage are bounded", { timeout: 5000 }, async () => {
  let started = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void; const both = new Promise<void>(resolve => { ready = resolve; });
  const mock = new MockAgent();
  const agent: AgentPort = { answer: mock.answer.bind(mock), async analyze(input, id) { started++; if (started === 2) ready(); await gate; return mock.analyze(input, id); } };
  const h = await harness({ agent });
  try {
    const a = h.call("/v1/analyze", body), b = h.call("/v1/analyze", body);
    await both;
    assert.equal((await h.call("/v1/analyze", body)).status, 429);
    release(); assert.equal((await a).status, 200); assert.equal((await b).status, 200);
  } finally { release(); await h.close(); }
  const full = await harness({ maxSessions: 1 });
  try { assert.equal((await full.call("/v1/analyze", body)).status, 200); assert.equal((await full.call("/v1/analyze", body)).status, 429); }
  finally { await full.close(); }
  const expired = await harness({ ttlMs: -1 });
  try { const a = await expired.call("/v1/analyze", body); assert.equal((await expired.call(`/v1/analyses/${a.value.data.id}?company_id=U_A`)).status, 404); }
  finally { await expired.close(); }
});

test("manual baseline keeps its own scale", () => {
  const item = { news_id: "n", event_id: "e", score: 3.2, score_kind: "manual_feature_baseline", reasons: [{ code: "industry", text: "evidence", profile_paths: ["/industry"] }], warnings: [] };
  validate("RankedItem", item);
  assert.throws(() => validate("RankedItem", { ...item, score_kind: "logistic_relevance_uncalibrated" }));
});

test("OpenAPI 3.1 can be parsed and resolved without network references", async () => {
  const parser = createRequire(import.meta.url)("@apidevtools/swagger-parser");
  const api = await parser.validate(resolve(ROOT, "contracts/v1/openapi.json"));
  assert.equal(api.openapi, "3.1.0");
  assert.ok(api.paths["/v1/rank"].post.requestBody.content["application/json"].schema.properties.events);
});

test("learning gateway forwards only supplied reviewer token and validates feedback", async () => {
  const seen: string[] = [];
  const ml = new ContractClient("http://ml.test", 500, (async (_url, init) => {
    const token = (init!.headers as Record<string, string>)["X-Learning-Token"];
    seen.push(token);
    const id = (init!.headers as Record<string, string>)["X-Request-ID"];
    if (!token) return Response.json({ schema_version: "1.0.0", request_id: id,
      error: { code: "FORBIDDEN", message: "Reviewer token required", retryable: false } }, { status: 403 });
    const data = init!.body ? { accepted: 1, duplicates: 0 } : {
      active_version: "baseline", paused: false, labels: { train: 0, validation: 0, gate: 0 },
      consumed_gate_groups: 0, last_run: null, thresholds: {} };
    return Response.json(envelope(data, id, "live"));
  }) as typeof fetch);
  const h = await harness({ ml });
  try {
    assert.equal((await h.call("/v1/learning/status")).status, 403);
    const response = await fetch(h.base + "/v1/learning/status", { headers: { ...headers, "X-Learning-Token": "test-reviewer" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.active_version, "baseline");
    const feedback = { ranking_id: "ranking-1", company_id: "U_A", ratings: [
      { event_id: "e1", policy_group_id: "e1", label: 2, reason: "Relevant exposure", source_reviewed: true }] };
    const saved = await fetch(h.base + "/v1/learning/feedback", { method: "POST",
      headers: { ...headers, "X-Learning-Token": "test-reviewer" }, body: JSON.stringify(feedback) });
    assert.equal(saved.status, 200);
    assert.deepEqual(seen, ["", "test-reviewer", "test-reviewer"]);
    assert.equal((await h.call("/v1/learning/feedback", { ...feedback, ratings: [{ ...feedback.ratings[0], source_reviewed: false }] })).status, 422);
    assert.equal((await fetch(h.base + "/learning")).status, 200);
  } finally { await h.close(); }
});

test("preview has no agent calls; selected events and context hashes are enforced", async () => {
  let calls = 0;
  const mock = new MockAgent();
  const agent: AgentPort = { answer: mock.answer.bind(mock), async analyze(input,id) { calls++; return mock.analyze(input,id); } };
  const h = await harness({agent});
  try {
    const event = (await new MockRetrieval().search({query:"",as_of:asOf,limit:1},"test")).data.items[0];
    const request = {company_id:"U_A",event,as_of:asOf,audience_role:"cfo"};
    const preview = await h.call("/v1/analysis-context",request);
    assert.equal(preview.status,200); assert.equal(calls,0); validate("PreparedContextDataResponse",preview.value);
    assert.deepEqual(preview.value.data.input.event,event);
    const stale = await h.call("/v1/analyze-event",{...request,expected_context_sha256:"0".repeat(64)});
    assert.equal(stale.status,409); assert.equal(calls,0);
    const result = await h.call("/v1/analyze-event",{...request,expected_context_sha256:preview.value.data.sha256});
    assert.equal(result.status,200); assert.equal(calls,1); assert.equal(result.value.data.news_id,event.news_id);
    const future = await h.call("/v1/analysis-context",{...request,as_of:"2020-01-01T00:00:00Z"}); assert.equal(future.status,422);
  } finally { await h.close(); }
});
test("gateway repeats live grounding checks even if an agent claims the result is valid", async () => {
  const mock = new MockAgent(); let tamper = false;
  const agent: AgentPort = {answer:mock.answer.bind(mock), async analyze(input,id) {
    const result = await mock.analyze(input,id);
    Object.assign(result.data,referenceDraft({id:"test",input,expectations:[]}),{mode:"live",sources:prepareContext(input).sources});
    if(tamper) result.data.claims[0].text = "Компания понесёт потери";
    return result;
  }};
  const h = await harness({agent});
  try { assert.equal((await h.call("/v1/analyze",body)).status,200); tamper = true;
    const result = await h.call("/v1/analyze",body); assert.equal(result.status,502); assert.equal(result.value.error.code,"CONTRACT_VIOLATION");
  } finally { await h.close(); }
});
test("analysis UI serves only static assets with CSP; sensitive files are unavailable", async () => {
  const h = await harness();
  try {
    for(const path of ["/analysis/","/analysis/app.js","/analysis/styles.css","/analysis/state.js"]) {
      const r = await fetch(h.base + path); assert.equal(r.status,200); assert.match(r.headers.get("content-security-policy")!,/script-src 'self'/);
    }
    for(const path of ["/analysis/.env","/analysis/server/config.ts","/analysis/%2e%2e/%2e%2e/.env"]) assert.equal((await fetch(h.base+path)).status,404);
  } finally { await h.close(); }
});

test("live follow-ups retain analysis date, role and grounded company/source context", async () => {
  const mock = new MockAgent(); let saved: Json, tamper = false;
  const agent: AgentPort = { async analyze(input,id) {
    saved = referenceDraft({id:"test",input,expectations:[]});
    const value = await mock.analyze(input,id); Object.assign(value.data,saved,{mode:"live",sources:prepareContext(input).sources}); return value;
  }, async answer(input,id) {
    assert.equal(input.as_of,asOf); assert.equal(input.audience_role,"cfo");
    const claims = structuredClone(saved.claims); if(tamper) claims[0].quote = "Источник этого не говорил";
    return envelope({analysis_id:input.analysis.id,company_id:input.company_id,answer:saved.summary + " " + saved.why_relevant,
      claims,claim_indexes:[0,1],limitations:saved.limitations,missing_data:saved.missing_data,
      source_ids:[...new Set(claims.flatMap((c: Json) => c.source_ids))]},id,"live");
  }};
  const h = await harness({agent});
  try { const a = await h.call("/v1/analyze",body); assert.equal(a.status,200);
    const path = `/v1/analyses/${a.value.data.id}/questions`;
    assert.equal((await h.call(path,{company_id:"U_A",question:"Что уточнить?"})).status,200);
    tamper = true; const bad = await h.call(path,{company_id:"U_A",question:"А затем?"}); assert.equal(bad.status,502);
  } finally { await h.close(); }
});
test("model error types reach the UI without turning into generic validation failures", async () => {
  const mock = new MockAgent();
  const agent: AgentPort = {answer:mock.answer.bind(mock),async analyze() {throw new ModelError("Лимит исчерпан","MODEL_LIMIT",429);}};
  const h = await harness({agent});
  try { const r = await h.call("/v1/analyze",body); assert.equal(r.status,429); assert.equal(r.value.error.code,"MODEL_LIMIT"); assert.equal(r.value.error.retryable,true); }
  finally { await h.close(); }
});
test("a pending analysis reserves its session slot before a second request can spend a call", async () => {
  let started!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const mock = new MockAgent(), agent: AgentPort = {answer:mock.answer.bind(mock),async analyze(input,id) {
    calls++; started(); await gate; return mock.analyze(input,id);
  }};
  const h = await harness({agent,maxSessions:1});
  try { const first = h.call("/v1/analyze",body); await ready;
    assert.equal((await h.call("/v1/analyze",body)).status,429); assert.equal(calls,1);
    release(); assert.equal((await first).status,200);
  } finally { release(); await h.close(); }
});
test("preview applies the configured context limit before calling an agent", async () => {
  const h = await harness({maxContextBytes:1000});
  try {
    const event = (await new MockRetrieval().search({query:"",as_of:asOf,limit:1},"test")).data.items[0];
    const result = await h.call("/v1/analysis-context",{company_id:"U_A",event,as_of:asOf,audience_role:"cfo"});
    assert.equal(result.status,422); assert.equal(result.value.error.code,"VALIDATION_ERROR");
  } finally { await h.close(); }
});
