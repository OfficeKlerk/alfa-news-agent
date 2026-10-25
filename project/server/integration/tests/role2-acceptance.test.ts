import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { Retrieval } from "../../retrieval.js";
import { ModelError, type Json } from "../../types.js";
import { LegacyRetrieval } from "../retrieval.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { adviceConstraints } from "../advice-policy.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { analysisDraft, validateGrounding } from "../grounding.js";
import { generatedResponseSchema } from "../response-schema.js";
import { QUESTION_PROMPT } from "../analysis-prompts.js";
import { safeDiagnostics, diagnosticFailureMessage } from "../diagnostics.js";

const reply = (draft: Json) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(draft) } }] });
const asOf = "2026-10-24T18:00:00Z";

test("question prompt contains one output contract and reasoning settings cannot replace response_format", () => {
  assert.match(QUESTION_PROMPT, /Верни только \{answer,claims,claim_indexes,limitations,missing_data\}/);
  assert.doesNotMatch(QUESTION_PROMPT, /Верни только JSON: \{summary|grounding содержит ровно|Связанный пример/);
  const settings = loadSettings({ LLM_REASONING_EFFORT: "low", LLM_RESPONSE_FORMAT: "json_schema",
    LLM_EXTRA_BODY_JSON: '{"chat_template_kwargs":{"enable_thinking":false}}' });
  assert.equal(settings.responseFormat, "json_schema"); assert.equal(settings.reasoningEffort, "low");
  assert.deepEqual(settings.extraBody, { chat_template_kwargs: { enable_thinking: false } });
  assert.throws(() => loadSettings({ LLM_EXTRA_BODY_JSON: '{"response_format":{"type":"text"}}' }), /не может переопределять response_format/);
});

for (const format of ["json_object", "json_schema"] as const) {
  test(`${format}: reviewed real news, dated bank OCR, rate-hold guard, repair and questions work together`, async () => {
    mkdirSync(resolve(ROOT, "var"), { recursive: true });
    const folder = mkdtempSync(resolve(ROOT, "var/role2-acceptance-"));
    const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test-only-key",
      LLM_BASE_URL: "https://provider.invalid/v1", LLM_RESPONSE_FORMAT: format, LLM_REASONING_EFFORT: "low" }),
      data: resolve(ROOT, "data"), dbPath: resolve(folder, "calls.sqlite3"),
      // Direct settings must also protect the response contract, bypassing env parsing.
      extraBody: { chat_template_kwargs: { enable_thinking: false }, response_format: { type: "text" } } };
    const db = new Store(settings);
    try {
      await db.initialize();
      const retrieval = new LegacyRetrieval(db, new Retrieval(db), settings);
      const news = await retrieval.search({ query: "", news_id: null, as_of: asOf, limit: 100 }, "reviewed-news");
      const event = news.data.items.find((e: Json) => e.sources.some((s: Json) => s.url === "https://www.cbr.ru/press/keypr/"));
      assert.ok(event); assert.equal(event.is_mock, false);
      const research = (await retrieval.rag({ query: "ключевая ставка кредит", as_of: asOf, limit: 3 }, "bank-rag")).data;
      assert.ok(research.items.length); assert.ok(research.items.every((s: Json) => s.published_at && !s.is_mock));
      const scenario = evaluationCases()[0];
      scenario.input.event = event; scenario.input.research = research; scenario.input.as_of = asOf;
      Object.assign(scenario.input.ranked_item, { news_id: event.news_id, event_id: event.event_id });
      const context = prepareContext(scenario.input);
      assert.equal(adviceConstraints(context.input).review_mode, "monitoring_only");
      const valid = () => {
        const draft = referenceDraft(scenario), bank = research.items[0], quote = bank.excerpt.slice(0, 180);
        draft.claims.push({ kind: "bank", text: quote, quote, source_ids: [bank.id] });
        draft.summary += "\n" + quote; draft.grounding.summary.push(2);
        validateGrounding(draft, context);
        return draft;
      };
      const providerCheck = new Ajv2020({ strict: false }).compile(generatedResponseSchema("GeneratedAnalysis").schema);
      assert.ok(providerCheck(valid()), JSON.stringify(providerCheck.errors));
      const mutations: [string, (v: Json) => void][] = [
        ["/recommendations/0", v => { v.recommendations[0] = { text: v.recommendations[0] }; }],
        ["/grounding/sources", v => { v.grounding.sources = []; }],
        ["/claims/2/quote", v => { v.claims[2].text = v.claims[2].quote = "Вымышленная цитата, которой нет в банковском OCR."; }],
      ];
      for (const [expectedPath, mutate] of mutations) {
        let calls = 0;
        const result = await generatePrepared(settings, db, scenario.input, "bank-repair", (async (_url, init) => {
          calls++; const payload = JSON.parse(String(init?.body));
          assert.equal(payload.response_format.type, format);
          assert.equal(payload.reasoning_effort, "low");
          assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
          assert.equal(JSON.parse(payload.messages[1].content).advice_constraints.review_mode, "monitoring_only");
          const draft = valid();
          if (calls === 1) mutate(draft);
          else {
            const repair = JSON.parse(payload.messages.at(-1).content);
            assert.ok(repair.issues.some((issue: Json) => issue.path === expectedPath));
            assert.equal(db.get("SELECT count(*) n FROM llm_rejected_drafts")!.n > 0, true);
          }
          return reply(draft);
        }) as typeof fetch);
        assert.equal(calls, 2); validateGrounding(analysisDraft(result.data), context, true);
        assert.deepEqual(result.data.sources, context.sources);
        assert.deepEqual(result.data.risks, []); assert.deepEqual(result.data.opportunities, []);
        let questions = 0;
        const draft = valid();
        const answered = await answerPrepared(settings, db, { company_id: scenario.input.company_id, analysis: result.data,
          prepared_input: scenario.input, question: "Какие условия проверить?", history: [] }, "bank-question", (async (_url, init) => {
          questions++;
          const payload = JSON.parse(String(init?.body)); assert.equal(payload.response_format.type, format);
          const answer = { answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1, 2],
            limitations: draft.limitations, missing_data: draft.missing_data };
          return reply(questions === 1 ? { ...answer, recommendations: [] } : answer);
        }) as typeof fetch);
        assert.equal(questions, 2); assert.ok(answered.data.source_ids.includes(research.items[0].id));
      }
      let calls = 0;
      await assert.rejects(generatePrepared(settings, db, scenario.input, "bank-invalid-twice", (async () => {
        calls++; const draft = valid(); mutations[2][1](draft); return reply(draft);
      }) as typeof fetch), (error: unknown) => {
        assert.ok(error instanceof ModelError); assert.equal(error.diagnostics!.attempts, 2);
        assert.equal(error.diagnostics!.issues[0].path, "/claims/2/quote"); return true;
      });
      assert.equal(calls, 2);
    } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
  });
}

test("unknown numeric property names are hidden and transport failures keep their own safe explanation", () => {
  const sanitized = safeDiagnostics({ issues: [{ stage: "schema", path: "/grounding/123456", rule: "Unexpected field" }] });
  assert.equal(sanitized.issues[0].path, "/grounding/[unknown]");
  const arrayIndex = safeDiagnostics({ issues: [{ stage: "schema", path: "/grounding/risks/0/1", rule: "Duplicate items" }] });
  assert.equal(arrayIndex.issues[0].path, "/grounding/risks/0/1");
  assert.match(diagnosticFailureMessage("MODEL_AUTH_ERROR", sanitized), /отклонил ключ/);
  assert.match(diagnosticFailureMessage("MODEL_LIMIT", sanitized), /лимит вызовов/);
});

test("product v1 adapter preserves diagnostic ID, field errors and snapshot failure for the UI", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const context = createContext({ window: {}, URLSearchParams, location: { search: "?api=v1" },
    console: { info() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    fetch: async () => ({ ok: false, status: 502, json: async () => ({ request_id: "test-request", error: {
      code: "MODEL_RESPONSE_INVALID", message: "/recommendations/0: Expected type string",
      diagnostics: { generation_id: id, draft_saved: false, issues: [{ stage: "schema", path: "/recommendations/0", rule: "Expected type", expected: "string" }] }
    } }) }) });
  runInContext(readFileSync(resolve(ROOT, "frontend/v1-adapter.js"), "utf8"), context);
  await assert.rejects(context.window.__V1.handle("/api/analysis", { method: "POST", body: JSON.stringify({ news_id: "real-news" }) }), (error: Json) => {
    assert.match(error.message, /Expected type string/); assert.ok(error.message.includes(id));
    assert.match(error.message, /снимок черновика не сохранён/); assert.equal(error.requestId, "test-request");
    assert.equal(error.diagnostics.generation_id, id); return true;
  });
});

test("tuning harness includes diagnostics and enforces --max-calls even when a reply needs repair", () => {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/tuning-acceptance-"));
  try {
    const fake = resolve(folder, "fake provider.mjs"), calls = resolve(folder, "calls.txt"), report = resolve(folder, "report.json");
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';
globalThis.fetch = async () => { appendFileSync(process.env.TEST_CALLS_FILE, 'call\\n');
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'test-only-secret'})}}]}); };\n`);
    // Node's ESM --import requires a file URL for Windows drive-letter paths.
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(fake).href,
      resolve(ROOT, "scripts/tune_model.ts"), "--max-output", "6000", "--reasoning", "low", "--cases", "rate_borrower",
      "--max-calls", "1", "--out", report], { cwd: folder, encoding: "utf8", timeout: 20000,
      env: { ...process.env, LLM_API_KEY: "test-only-secret", LLM_BASE_URL: "https://provider.invalid/v1",
        LLM_MODEL: "qwen/qwen3.6-35b-a3b", LLM_ALLOWED_MODELS_JSON: '["qwen/qwen3.6-35b-a3b"]',
        LLM_EXTRA_BODY_JSON: "", LLM_RESPONSE_FORMAT: "json_object", MAX_DAILY_LLM_CALLS: "100", TEST_CALLS_FILE: calls } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(readFileSync(calls, "utf8"), "call\n");
    const text = readFileSync(report, "utf8"), result = JSON.parse(text);
    assert.equal(result.runs.length, 1); assert.equal(result.runs[0].calls, 1);
    assert.equal(result.runs[0].ok, false); assert.equal(result.runs[0].diagnostics.draft_saved, true);
    assert.equal(result.runs[0].diagnostics.max_attempts, 2);
    assert.doesNotMatch(text + child.stdout + child.stderr, /test-only-secret/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
