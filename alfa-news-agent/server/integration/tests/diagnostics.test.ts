import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json, type ResponseDiagnostics } from "../../types.js";
import { ApiFault, validate } from "../contracts.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { boundary, errorBoundary } from "../gateway.js";
import { ContractClient } from "../client.js";
import { safeDiagnostics, safeDraft, saveRejectedDraft } from "../diagnostics.js";

const secret = "test-provider-secret-do-not-disclose";
const scenario = () => evaluationCases()[0];
const reply = (draft: Json) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(draft) } }] });
function ledger(format: "json_object" | "json_schema" = "json_object") {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/diagnostics-test-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: secret,
    LLM_BASE_URL: "https://provider.invalid/v1", LLM_RESPONSE_FORMAT: format }), dbPath: resolve(folder, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { settings, db, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
function failure(run: () => unknown): ApiFault {
  try { run(); assert.fail("Validation should reject the draft"); }
  catch (error) { assert.ok(error instanceof ApiFault); return error; }
}

test("schema errors contain safe JSON paths, expected types and bounded field issues", () => {
  const draft = referenceDraft(scenario());
  draft.recommendations[0] = { text: secret }; draft.grounding.limitations = [secret];
  draft.grounding[secret] = secret; delete draft.summary;
  const error = failure(() => validate("GeneratedAnalysis", draft, true));
  assert.ok(error.diagnostics!.issues.some(i => i.path === "/recommendations/0" && i.expected === "string"));
  assert.ok(error.diagnostics!.issues.some(i => i.path === "/grounding/limitations" && i.rule === "Unexpected field"));
  assert.ok(error.diagnostics!.issues.some(i => i.path === "/summary" && i.rule === "Required field missing"));
  assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), new RegExp(secret));
  draft.claims = Array(30).fill({});
  assert.equal(failure(() => validate("GeneratedAnalysis", draft, true)).diagnostics!.issues.length, 10);
  const long = referenceDraft(scenario()); long.recommendations = Array(11).fill("Проверить условия");
  assert.deepEqual(failure(() => validate("GeneratedAnalysis", long, true)).diagnostics!.issues[0],
    { stage: "schema", path: "/recommendations", rule: "Too many items", limit: 10 });
});

for (const format of ["json_object", "json_schema"] as const) {
  test(`${format}: repair receives verified field errors and the persisted structural draft`, async () => {
    const l = ledger(format), s = scenario(); let calls = 0;
    try {
      const result = await generatePrepared(l.settings, l.db, s.input, "diagnostic-repair", (async (_url, init) => {
        const payload = JSON.parse(String(init?.body)); calls++;
        if (calls === 1) {
          const bad = referenceDraft(s); bad.recommendations[0] = { text: secret };
          bad.grounding[secret] = secret; bad.claims[0].text = secret;
          return reply(bad);
        }
        const repair = JSON.parse(payload.messages.at(-1).content);
        assert.equal(payload.messages.length, 3);
        assert.equal(repair.issues.find((i: Json) => i.path === "/recommendations/0").expected, "string");
        const saved = l.db.all("SELECT * FROM llm_rejected_drafts");
        assert.equal(saved.length, 1); assert.equal(saved[0].attempt, 1);
        assert.deepEqual(repair.previous_draft, JSON.parse(saved[0].snapshot));
        assert.doesNotMatch(JSON.stringify(repair) + JSON.stringify(saved), new RegExp(secret));
        return reply(referenceDraft(s));
      }) as typeof fetch);
      assert.equal(calls, 2); validateGrounding(Object.fromEntries(Object.keys(referenceDraft(s)).map(k => [k, result.data[k]])), prepareContext(s.input), true);
      assert.ok(result.data.trace.some((t: Json) => t.step === "response_repair" && /diagnostic_id=/.test(t.detail)));
    } finally { l.close(); }
  });
}

test("grounding refusals identify quotes, profile paths, references, conditions and required data precisely", () => {
  const s = scenario(), context = prepareContext(s.input);
  const cases: [string, string, (v: Json) => void][] = [
    ["/claims/0/quote", "Quote not found in selected evidence", v => { v.claims[0].text = v.claims[0].quote = secret; }],
    ["/claims/1/profile_paths/0", "Unknown profile path", v => { v.claims[1].profile_paths = ["/industry/" + secret]; }],
    ["/grounding/recommendations/0/claim_indexes/0", "Unknown claim index", v => { v.grounding.recommendations[0].claim_indexes = [29]; }],
    ["/grounding/recommendations/0/condition", "Recommendation condition and required data must match: condition must match its AI claim", v => { v.grounding.recommendations[0].condition = secret; }],
    ["/grounding/recommendations/0/required_data", "Recommendation condition and required data must match: required_data must match missing_data", v => { v.grounding.recommendations[0].required_data = [secret]; }],
    ["/claims/1/source_ids/0", "Unknown claim source", v => { v.claims[1].source_ids[0] = secret; }],
  ];
  for (const [path, rule, mutate] of cases) {
    const bad = referenceDraft(s); mutate(bad);
    const error = failure(() => validateGrounding(bad, context));
    assert.deepEqual(error.diagnostics!.issues, [{ stage: "grounding", path, rule }]);
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), new RegExp(secret));
  }
});

test("repeated grounding failure stops at two calls with saved drafts and a safe final diagnostic", async () => {
  const l = ledger(), s = scenario(); let calls = 0;
  try {
    await assert.rejects(generatePrepared(l.settings, l.db, s.input, "final-failure", (async () => {
      calls++; const bad = referenceDraft(s); bad.grounding.recommendations[0].condition = secret; return reply(bad);
    }) as typeof fetch), (error: unknown) => {
      assert.ok(error instanceof ModelError); assert.match(error.message, /2\/2.*\/grounding\/recommendations\/0\/condition/);
      assert.equal(error.diagnostics!.attempts, 2); assert.equal(error.diagnostics!.max_attempts, 2);
      assert.equal(error.diagnostics!.draft_saved, true); validate("ResponseDiagnostics", error.diagnostics);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), new RegExp(secret)); return true;
    });
    assert.equal(calls, 2);
    const rows = l.db.all("SELECT * FROM llm_rejected_drafts ORDER BY attempt");
    assert.deepEqual(rows.map(r => r.attempt), [1, 2]); assert.equal(rows[0].generation_id, rows[1].generation_id);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(secret));
  } finally { l.close(); }
});

test("invalid JSON records no raw text and still uses only one repair", async () => {
  const l = ledger(); let calls = 0;
  try {
    await assert.rejects(generatePrepared(l.settings, l.db, scenario().input, "parse", (async () => {
      calls++; return Response.json({ choices: [{ message: { content: "{\"" + secret } }] });
    }) as typeof fetch), (error: unknown) => {
      assert.ok(error instanceof ModelError); assert.equal(error.diagnostics!.issues[0].stage, "parse"); return true;
    });
    assert.equal(calls, 2); assert.doesNotMatch(JSON.stringify(l.db.all("SELECT * FROM llm_rejected_drafts")), new RegExp(secret));
  } finally { l.close(); }
});

test("transport failure during repair preserves previous diagnostics without any third call", async () => {
  for (const status of [401, 429, 500]) {
    const l = ledger(); let calls = 0;
    try {
      await assert.rejects(generatePrepared(l.settings, l.db, scenario().input, "repair-transport", (async () => {
        calls++; return calls === 1 ? reply({}) : new Response(secret, { status });
      }) as typeof fetch), (error: unknown) => {
        assert.ok(error instanceof ModelError); assert.notEqual(error.code, "MODEL_RESPONSE_INVALID");
        assert.equal(error.diagnostics!.attempts, 2); assert.equal(error.diagnostics!.draft_saved, true);
        assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), new RegExp(secret)); return true;
      });
      assert.equal(calls, 2); assert.equal(l.db.all("SELECT * FROM llm_rejected_drafts").length, 1);
    } finally { l.close(); }
  }
});

test("follow-up diagnostics use answer and claim_indexes paths rather than synthetic analysis fields", async () => {
  const l = ledger(), s = scenario(), draft = referenceDraft(s);
  const answer = { answer: draft.summary + " " + draft.why_relevant, claims: draft.claims,
    claim_indexes: [0, 29], limitations: draft.limitations, missing_data: draft.missing_data };
  assert.equal(failure(() => validateQuestionGrounding(answer, prepareContext(s.input))).diagnostics!.issues[0].path, "/claim_indexes/1");
  answer.claim_indexes = [0, 1]; answer.answer += " 987654321";
  assert.equal(failure(() => validateQuestionGrounding(answer, prepareContext(s.input))).diagnostics!.issues[0].path, "/answer");
  try {
    const analysis = (await generatePrepared(l.settings, l.db, s.input, "before-question", (async () => reply(draft)) as typeof fetch)).data;
    let calls = 0;
    await assert.rejects(answerPrepared(l.settings, l.db, { company_id: analysis.company_id, analysis,
      question: "Что проверить?", history: [], prepared_input: s.input }, "question-failure", (async () => {
      calls++; return reply({ ...answer, answer: { token: secret } });
    }) as typeof fetch), (error: unknown) => {
      assert.ok(error instanceof ModelError); assert.equal(error.diagnostics!.issues[0].path, "/answer");
      assert.equal(error.diagnostics!.issues[0].expected, "string"); return true;
    });
    assert.equal(calls, 2); assert.ok(l.db.all("SELECT * FROM llm_rejected_drafts").every(r => r.contract === "GeneratedAnswer"));
  } finally { l.close(); }
});

test("snapshot failure is explicit and does not prevent bounded repair", async () => {
  const l = ledger(); let calls = 0;
  l.db.connection.exec("CREATE TABLE llm_rejected_drafts(wrong_column TEXT)");
  try {
    await assert.rejects(generatePrepared(l.settings, l.db, scenario().input, "storage-failure", (async () => {
      calls++; return reply({ summary: secret });
    }) as typeof fetch), (error: unknown) => {
      assert.ok(error instanceof ModelError); assert.equal(error.diagnostics!.draft_saved, false);
      assert.doesNotMatch(error.message, new RegExp(secret)); return true;
    });
    assert.equal(calls, 2);
  } finally { l.close(); }
});

test("snapshots and local retention are bounded and contain no arbitrary strings or numbers", () => {
  const l = ledger(), id = "11111111-1111-4111-8111-111111111111";
  const draft = { claims: Array(100).fill({ text: secret, kind: "ai", source_ids: [secret], conditions: [secret],
    profile_paths: [secret], quote: secret, [secret]: { token: secret } }), recommendations: [123456789] };
  const snapshot = JSON.stringify(safeDraft(draft, "GeneratedAnalysis"));
  assert.doesNotMatch(snapshot, new RegExp(secret + "|123456789")); assert.ok(snapshot.length < 30_000);
  try {
    for (let i = 0; i < 105; i++) saveRejectedDraft(l.db, id, 1, "GeneratedAnalysis", draft,
      [{ stage: "schema", path: "/recommendations/0", rule: "Expected type", expected: "string" }]);
    assert.equal(l.db.all("SELECT * FROM llm_rejected_drafts").length, 100);
  } finally { l.close(); }
});

test("safe diagnostics survive provider HTTP, contract client, error boundary and browser SDK", async () => {
  const diagnostics: ResponseDiagnostics = { generation_id: "11111111-1111-4111-8111-111111111111", attempts: 2,
    max_attempts: 2, draft_saved: true, issues: [{ stage: "schema", path: "/recommendations/0", rule: "Expected type", expected: "string" }] };
  const provider = express(); boundary(provider);
  provider.post("/v1/agent/analyze", () => { throw new ModelError(secret, "MODEL_RESPONSE_INVALID", 502, diagnostics); });
  provider.use(errorBoundary);
  const providerServer = provider.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => providerServer.once("listening", resolve));
  const address = providerServer.address(); assert.ok(address && typeof address !== "string");
  const client = new ContractClient("http://127.0.0.1:" + address.port);
  const gateway = express(); boundary(gateway);
  gateway.post("/test", async (_req, res) => { await client.call("/v1/agent/analyze", "AnalysisResponse", res.locals.requestId, {}); });
  gateway.use(errorBoundary);
  const server = gateway.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const gatewayAddress = server.address(); assert.ok(gatewayAddress && typeof gatewayAddress !== "string");
  try {
    const { AlfaApi } = await import(new URL("../../../integration/frontend/client.js", import.meta.url).href);
    await assert.rejects(new AlfaApi("http://127.0.0.1:" + gatewayAddress.port).request("/test", {}), (error: Json) => {
      assert.equal(error.status, 502); assert.equal(error.code, "MODEL_RESPONSE_INVALID");
      assert.deepEqual(error.diagnostics, diagnostics); assert.match(error.message, /recommendations\/0: Expected type string/);
      assert.doesNotMatch(error.message, new RegExp(secret)); assert.ok(error.requestId); return true;
    });
    const sanitized = safeDiagnostics({ issues: [{ stage: "schema", path: "/grounding/" + secret, rule: "Unexpected field" }] });
    assert.equal(sanitized.issues[0].path, "/grounding/[unknown]");
    assert.throws(() => validate("ResponseDiagnostics", { issues: [{ stage: "schema", path: "/", rule: secret }] }));
    const malicious = new ContractClient("http://provider.invalid", 100, (async (_url, init) => Response.json({
      schema_version: "1.0.0", request_id: (init!.headers as Json)["X-Request-ID"],
      error: { code: "MODEL_RESPONSE_INVALID", message: secret, retryable: false,
        diagnostics: { issues: [{ stage: "parse", path: "/", rule: "Unexpected field" }] } }
    }, { status: 502 })) as typeof fetch);
    await assert.rejects(malicious.call("/test", "AnalysisResponse", "safe-error", {}), (error: unknown) => {
      assert.ok(error instanceof ApiFault); assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal(error.message, "Provider returned invalid diagnostics"); return true;
    });
  } finally {
    server.closeAllConnections(); providerServer.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => providerServer.close(() => resolve()))]);
  }
});
