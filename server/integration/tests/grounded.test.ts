import { generationProfile } from "../generation-context.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { createComplete } from "../../llm.js";
import { evaluationCases, referenceDraft, evaluateResult } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { PROMPT_VERSION } from "../analysis-prompts.js";

function ledger(maxCalls = 20) {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/llm-test-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "local-test-secret", LLM_BASE_URL: "https://provider.invalid/v1",
    LLM_MODEL: "qwen/qwen3.6-35b-a3b", LLM_ALLOWED_MODELS_JSON: '["qwen/qwen3.6-35b-a3b"]' }),
    dbPath: resolve(folder, "calls.sqlite3"), maxCalls, timeout: 25 };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { settings, db, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const reply = (content: Json, extra: Json = {}) => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop", ...extra }], usage: { prompt_tokens: 20, completion_tokens: 10 } });

for (const scenario of evaluationCases()) {
  test("evaluation pipeline: " + scenario.id, () => {
    const context = prepareContext(scenario.input);
    validateGrounding(referenceDraft(scenario), context);
    const result = evaluateResult(scenario, referenceDraft(scenario));
    assert.equal(result.mechanical_checks, "passed"); assert.equal(result.semantic_review, "pending");
    assert.ok(Object.values(result.review).every((r: any) => r.score === null));
  });
}
test("one event keeps distinct business profiles, false/null and raw ML scale", () => {
  const cases = evaluationCases(), a = prepareContext(cases[0].input), b = prepareContext(cases[1].input), c = prepareContext(cases[3].input);
  assert.equal(a.input.event.news_id, b.input.event.news_id); assert.notEqual(a.sha256, b.sha256);
  assert.equal(b.input.profile.bank_products.loan, false); assert.equal(c.input.profile.bank_products.loan, null);
  assert.equal(a.input.profile.scale.revenue_rub, null); assert.equal(a.input.profile.scale.revenue_unit, "unknown");
  assert.notEqual(referenceDraft(cases[0]).why_relevant, referenceDraft(cases[1]).why_relevant);
  const baseline = structuredClone(cases[0].input); baseline.ranked_item.score = 3.2; baseline.ranked_item.score_kind = "manual_feature_baseline";
  assert.equal(prepareContext(baseline).input.ranked_item.score, 3.2);
});
test("context rejects future, duplicate, oversized and cross-company evidence", () => {
  const base = evaluationCases()[0].input;
  for(const mutate of [
    (v: Json) => { v.profile.company_id = "U_OTHER"; },
    (v: Json) => { v.ranked_item.event_id = "wrong"; },
    (v: Json) => { v.event.published_at = "2027-01-01T00:00:00Z"; },
    (v: Json) => { v.event.sources[0].published_at = "2027-01-01T00:00:00Z"; },
    (v: Json) => { v.event.sources.push(v.event.sources[0]); },
    (v: Json) => { v.research.items[0].published_at = null; },
  ]) { const value = structuredClone(base); mutate(value); assert.throws(() => prepareContext(value)); }
  assert.throws(() => prepareContext(base, 10), /too large/);
});
test("grounding blocks invented facts/numbers, incorrect links, whole objects, unknown fields and absent conditions", () => {
  const scenario = evaluationCases()[0], context = prepareContext(scenario.input);
  for(const mutate of [
    (v: Json) => { v.claims[0].text = "Компания потеряет выручку"; },
    (v: Json) => { v.claims[0].text = v.claims[0].quote = "Несуществующая цитата из реального источника"; },
    (v: Json) => { v.claims[1].source_ids = ["company:OTHER", scenario.input.event.sources[0].id]; },
    (v: Json) => { v.claims[1].profile_paths = ["/bank_products"]; },
    (v: Json) => { v.claims[1].profile_paths = ["/bank_products/does_not_exist"]; },
    (v: Json) => { v.claims[1].profile_paths = ["/provenance/company_raw_fields/REVENUE_COMPANY"]; },
    (v: Json) => { v.claims[1].conditions = []; },
    (v: Json) => { v.claims[1].text += " Потери составят 17%."; },
    (v: Json) => { v.risks = ["Потери составят 17%."]; v.grounding.risks = [[1]]; },
    (v: Json) => { v.grounding.summary = [1]; },
    (v: Json) => { v.grounding.recommendations[0].claim_indexes = [29]; },
    (v: Json) => { v.grounding.recommendations[0].required_data = []; },
    (v: Json) => { v.grounding.recommendations = []; },
  ]) { const value = referenceDraft(scenario); mutate(value); assert.throws(() => validateGrounding(value, context)); }
});
test("unknown fields require explicit missing data and limitations", () => {
  const scenario = evaluationCases()[3], context = prepareContext(scenario.input), draft = referenceDraft(scenario);
  draft.missing_data = []; assert.throws(() => validateGrounding(draft, context), /Unknown business field/);
  draft.missing_data = ["Наличие кредита"]; draft.limitations = []; assert.throws(() => validateGrounding(draft, context));
});
test("a bank quote cannot be fabricated when no RAG was supplied", () => {
  const scenario = evaluationCases()[4], draft = referenceDraft(scenario);
  draft.claims.push({ kind:"bank", text:"Банк подтверждает снижение риска", quote:"Банк подтверждает снижение риска", source_ids:["bank:invented"] });
  assert.throws(() => validateGrounding(draft, prepareContext(scenario.input)));
});
test("live generation sends full original context, repairs once and exposes deterministic notices", async () => {
  const l = ledger(), scenario = evaluationCases()[4]; let calls = 0; const seen: Json[] = [];
  try {
    const result = await generatePrepared(l.settings, l.db, scenario.input, "grounded-test", (async (_url, init) => {
      calls++; const payload = JSON.parse(String(init?.body)); seen.push(payload);
      if(calls === 1) return reply({summary:"Invalid"}); return reply(referenceDraft(scenario));
    }) as typeof fetch);
    assert.equal(calls, 2); assert.equal(result.data.mode, "live");
    assert.ok(result.meta.warnings.some((s: string) => s.includes("Банковские материалы отсутствуют")));
    assert.ok(result.meta.warnings.some((s: string) => s.includes("синтетические")));
    const prepared = JSON.parse(seen[0].messages[1].content);
    assert.deepEqual(prepared.input.profile, generationProfile(scenario.input.profile)); assert.equal(prepared.sha256, prepareContext(scenario.input).sha256);
    assert.deepEqual(prepared.input.ranked_item, scenario.input.ranked_item);
    assert.equal(prepared.advice_constraints.review_mode, "needs_event_details");
    assert.ok(result.data.trace[1].detail.includes(PROMPT_VERSION)); assert.doesNotMatch(JSON.stringify(seen), /local-test-secret/);
  } finally { l.close(); }
});
test("live questions ground their claims in the saved company and source context", async () => {
  const l = ledger(), scenario = evaluationCases()[0], draft = referenceDraft(scenario);
  try {
    const analysis = (await generatePrepared(l.settings,l.db,scenario.input,"analysis", (async () => reply(draft)) as typeof fetch)).data;
    const answer = {answer:draft.summary + " " + draft.why_relevant,claims:draft.claims,claim_indexes:[0,1],limitations:draft.limitations,missing_data:draft.missing_data};
    const result = await answerPrepared(l.settings,l.db,{company_id:analysis.company_id,analysis,question:"Что уточнить?",history:[],prepared_input:scenario.input},"question",(async (_url, init) => {
      const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      assert.deepEqual(supplied.prepared_input.ranked_item, scenario.input.ranked_item);
      assert.equal(supplied.as_of, scenario.input.as_of);
      assert.equal(supplied.advice_constraints.review_mode, "needs_event_details");
      return reply(answer);
    }) as typeof fetch);
    validateQuestionGrounding(answer,prepareContext(scenario.input)); assert.equal(result.data.analysis_id,analysis.id);
    assert.equal(result.meta.mode, "mock", "synthetic source provenance is retained in a follow-up");
    assert.ok(result.data.source_ids.includes("company:" + scenario.input.company_id));
    const bad = {...answer, claims:structuredClone(answer.claims)}; bad.claims[1].profile_paths = ["/foreign_trade/nonexistent"];
    assert.throws(() => validateQuestionGrounding(bad,prepareContext(scenario.input)));
  } finally { l.close(); }
});
test("transport errors never cause a repair and never expose provider secrets", async () => {
  for(const [status, code, expected] of [[401,"MODEL_AUTH_ERROR",502],[403,"MODEL_AUTH_ERROR",502],[429,"MODEL_LIMIT",429],[500,"MODEL_UNAVAILABLE",503],[400,"MODEL_RESPONSE_INVALID",502]] as const) {
    const l = ledger(); let calls = 0;
    try { await assert.rejects(generatePrepared(l.settings,l.db,evaluationCases()[0].input,"error",(async () => {calls++; return new Response("private-key-and-error",{status});}) as typeof fetch),
      (e: unknown) => {assert.ok(e instanceof ModelError); assert.equal(e.code,code); assert.equal(e.status,expected); assert.doesNotMatch(e.message,/private-key/); return true;}); assert.equal(calls,1); }
    finally { l.close(); }
  }
});
test("invalid JSON is repaired only once; truncation, refusal and oversize have no repair", async () => {
  for(const [response, expectedCalls] of [
    [() => Response.json({choices:[{message:{content:"{"}}]}),2],
    [() => reply({}, {finish_reason:"length"}),1],
    [() => Response.json({choices:[{message:{refusal:"No",content:null}}]}),1],
    [() => new Response("x".repeat(1001)),1],
  ] as const) { const l = ledger(); l.settings.maxResponseBytes = 1000; let calls = 0;
    try {await assert.rejects(generatePrepared(l.settings,l.db,evaluationCases()[0].input,"error",(async () => {calls++; return response();}) as typeof fetch),ModelError); assert.equal(calls,expectedCalls);}
    finally { l.close(); }
  }
});
test("deadline aborts a waiting request; local quota blocks the next request", async () => {
  const l = ledger(1);
  try {
    const request = (async (_url, init) => {
      // Keep the fake transport alive until the real AbortSignal deadline fires.
      await new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Deadline failed")),1000);
        init!.signal!.addEventListener("abort",() => { clearTimeout(timer); reject(init!.signal!.reason); },{once:true}); });
      throw new Error("Unreachable");
    }) as typeof fetch;
    await assert.rejects(createComplete(l.settings,l.db,request)([],undefined,true),(e: unknown) => e instanceof ModelError && e.code === "MODEL_TIMEOUT");
    await assert.rejects(createComplete(l.settings,l.db,request)([],undefined,true),(e: unknown) => e instanceof ModelError && e.code === "MODEL_LIMIT");
    assert.equal(l.db.get("SELECT count(*) n FROM llm_calls")!.n,1);
  } finally { l.close(); }
});
test("UI discards late company/news responses and blocks unsafe source URLs", async () => {
  const {AnalysisState, safeUrl} = await import(pathToFileURL(resolve(ROOT,"integration/analysis_ui/state.js")).href);
  const state = new AnalysisState(), old = state.start(); state.preview = {}; state.result = {};
  state.reset(); const current = state.start(); assert.equal(state.current(old),false); assert.equal(state.current(current),true);
  assert.equal(state.preview,null); assert.equal(state.result,null); assert.equal(old.signal.aborted,true);
  for(const value of ["javascript:alert(1)","data:text/html,bad","https://user:pass@example.org","//example.org",null]) assert.equal(safeUrl(value),null);
  assert.equal(safeUrl("https://example.org/news"),"https://example.org/news");
});
test("context fingerprints ignore JSON object key order while retaining business changes", () => {
  const input = evaluationCases()[0].input;
  const reverse = (v: any): any => Array.isArray(v) ? v.map(reverse) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([k,value]) => [k,reverse(value)])) : v;
  const a = prepareContext(input), b = prepareContext(reverse(input));
  assert.equal(a.sha256,b.sha256); assert.equal(a.sources[0].excerpt,b.sources[0].excerpt);
  const changed = structuredClone(input); changed.profile.bank_products.loan = false;
  assert.notEqual(a.sha256,prepareContext(changed).sha256);
});
test("blank generated sections cannot pass source checks with meaningless whitespace", () => {
  const scenario = evaluationCases()[0], context = prepareContext(scenario.input);
  for(const key of ["summary","why_relevant","recommendations","limitations","missing_data"]) {
    const draft = referenceDraft(scenario); draft[key] = Array.isArray(draft[key]) ? [" \n\t"] : " \n\t";
    assert.throws(() => validateGrounding(draft,context));
  }
  const withNotices = referenceDraft(scenario); withNotices.limitations = Array(21).fill("Явное ограничение");
  validateGrounding(withNotices,context,true);
  withNotices.limitations[20] = "  "; assert.throws(() => validateGrounding(withNotices,context,true),/Blank limitation/);
});
test("every citation of a factual quote must contain that quote", () => {
  const scenario = evaluationCases()[0], second = structuredClone(scenario.input.event.sources[0]);
  second.id = "news:second"; second.excerpt = "Другой текст не подтверждает дословную цитату.";
  scenario.input.event.sources.push(second);
  const draft = referenceDraft(scenario); draft.claims[0].source_ids.push(second.id);
  assert.throws(() => validateGrounding(draft,prepareContext(scenario.input)),/Quote not found/);
});
test("company identifier digits and a reversed numeric sign are not financial support", () => {
  const scenario = evaluationCases()[0]; scenario.input.company_id = scenario.input.profile.company_id = "U_35074";
  let draft = referenceDraft(scenario); draft.claims[1].text += " Компания U_35074.";
  validateGrounding(draft,prepareContext(scenario.input));
  draft.claims[1].text += " Потери составят 35074.";
  assert.throws(() => validateGrounding(draft,prepareContext(scenario.input)),/Unsupported numeric/);
  scenario.input.event.sources[0].excerpt += " Ставка изменилась на 5 единиц.";
  draft = referenceDraft(scenario); draft.claims[1].text += " Ставка изменилась на -5 единиц.";
  assert.throws(() => validateGrounding(draft,prepareContext(scenario.input)),/Unsupported numeric/);
});
test("source links decode to the actual DOM id, including colon-delimited citation IDs", async () => {
  const { sourceAnchor } = await import(pathToFileURL(resolve(ROOT,"integration/analysis_ui/state.js")).href);
  for(const id of ["news:demo-rate","company:U_35074","research:document:p1:c0"]) {
    const anchor = sourceAnchor(id), url = new URL(anchor.href,"http://localhost:8000/analysis/");
    assert.equal(decodeURIComponent(url.hash.slice(1)),anchor.id);
  }
});
