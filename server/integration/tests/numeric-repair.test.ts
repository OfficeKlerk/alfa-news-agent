import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { ApiFault, validate } from "../contracts.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { analysisDraft, validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { responseGuidance } from "../repair-guidance.js";
import { safeDiagnostics } from "../diagnostics.js";
import { ContractClient } from "../client.js";

const bundle = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/llm_numeric_regressions.json"), "utf8"));
const articles: Json[] = JSON.parse(readFileSync(resolve(ROOT, "data/reviewed_news.json"), "utf8")).articles;
const profiles: Json[] = readFileSync(resolve(ROOT, "data/personalization/profiles.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const reply = (v: Json) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }] });
function ledger(format = "json_object") {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/numeric-repair-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test-only-secret", LLM_BASE_URL: "https://provider.invalid/v1",
    LLM_RESPONSE_FORMAT: format, LLM_REASONING_EFFORT: "none", LLM_MAX_OUTPUT_TOKENS: "6000" }), dbPath: resolve(folder, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { settings, db, close() { db.close(); rmSync(folder, { force: true, recursive: true }); } };
}
function realInput(companyId: string, article: Json) {
  const input = evaluationCases()[0].input;
  input.profile = structuredClone(profiles.find(p => p.company_id === companyId));
  assert.ok(input.profile); input.company_id = companyId;
  input.event = { ...input.event, news_id: article.article_id, event_id: article.article_id,
    title: article.title, text: article.text, event_type: "other", okved_divisions: [], regions: [],
    published_at: article.published + "T23:59:59.999Z", event_details: undefined,
    sources: [{ ...input.event.sources[0], id: "news:" + article.article_id, title: article.title,
      excerpt: article.title + "\n" + article.text, url: article.url, is_mock: false, published_at: article.published + "T23:59:59.999Z" }] };
  input.ranked_item.news_id = input.event.news_id; input.ranked_item.event_id = input.event.event_id;
  input.as_of = "2026-10-24T18:00:00Z"; input.research = { items: [], limitations: [] };
  return input;
}
function good(input: Json, example: Json) {
  const draft = referenceDraft({ id: "numeric_regression", input, expectations: [] });
  draft.summary = example.summary;
  draft.claims[0] = structuredClone(example.claim);
  draft.why_relevant = "Применимость сообщения к отрасли компании требует проверки договорной связи.";
  draft.claims[1].text = draft.why_relevant; draft.claims[1].profile_paths = ["/industry/name"];
  validateGrounding(draft, prepareContext(input));
  return draft;
}
function rejected(run: () => void): ApiFault {
  try { run(); assert.fail("Expected rejection"); }
  catch (error) { assert.ok(error instanceof ApiFault); return error; }
}

for (const format of ["json_object", "json_schema"]) for (const company of ["U_34911", "U_99262"]) {
  test(`${format}: ${company}, two reviewed numeric news, reconstructed failures and one bounded repair`, async () => {
    const l = ledger(format);
    try {
      for (const article of [articles[0], articles[2]]) {
        const input = realInput(company, article); let calls = 0;
        const accepted = await generatePrepared(l.settings, l.db, input, "numeric-positive", (async (_url, init) => {
          calls++; const payload = JSON.parse(String(init?.body)), data = JSON.parse(payload.messages[1].content);
          assert.equal(payload.reasoning_effort, "none"); assert.equal(payload.max_tokens, 2500); // LLM_GENERATION_MAX_TOKENS caps grounded JSON below LLM_MAX_OUTPUT_TOKENS.
          const example = data.response_guidance.numeric_fact_example;
          assert.ok(input.event.sources[0].excerpt.includes(example.summary));
          return reply(good(input, example));
        }) as typeof fetch);
        assert.equal(calls, 1); validateGrounding(analysisDraft(accepted.data), prepareContext(input), true);
        const d = analysisDraft(accepted.data);
        let questionCalls = 0;
        const q = await answerPrepared(l.settings, l.db, { company_id: company, analysis: accepted.data,
          prepared_input: input, question: "Как трактовать эту новость?", history: [] }, "numeric-question", (async (_url, init) => {
          questionCalls++;
          const payload = JSON.parse(String(init?.body)), data = JSON.parse(payload.messages[1].content);
          assert.ok(data.response_guidance.numeric_fact_example.answer);
          assert.equal(data.response_guidance.numeric_fact_example.summary, undefined);
          if (questionCalls === 2) {
            const repair = JSON.parse(payload.messages.at(-1).content);
            assert.ok(repair.repair_rules.every((r: Json) => r.instruction.includes("только answer")));
            assert.ok(repair.repair_rules.every((r: Json) => !/\bsummary\b|\bwhy_relevant\b/.test(r.instruction)));
          }
          return reply({ answer: d.summary + "\n" + d.why_relevant + (questionCalls === 1 ? " 987654321" : ""),
            claims: d.claims, claim_indexes: [0, 1], limitations: d.limitations, missing_data: d.missing_data });
        }) as typeof fetch);
        assert.equal(questionCalls, 2);
        assert.equal(q.data.analysis_id, accepted.data.id);
      }
      const input = realInput(company, articles[0]), context = prepareContext(input);
      const example = responseGuidance(context, "").numeric_fact_example!;
      for (const regression of bundle.cases) {
        let calls = 0;
        await generatePrepared(l.settings, l.db, input, regression.id, (async (_url, init) => {
          calls++; const payload = JSON.parse(String(init?.body)); const draft = good(input, example);
          if (calls === 1) {
            draft.summary = regression.summary;
            draft.claims[0].text = draft.claims[0].quote = articles[0].title;
            if (regression.break_recommendation) {
              draft.grounding.recommendations[0].condition = "Другое условие";
              draft.grounding.recommendations[0].required_data = ["Другая информация"];
            }
            for (const collect of [false, true]) assert.throws(() => validateGrounding(draft, context, false, collect));
            return reply(draft);
          }
          const repair = JSON.parse(payload.messages.at(-1).content);
          for (const rule of regression.expected_rules) {
            assert.ok(repair.issues.some((i: Json) => i.rule === rule), rule);
            assert.ok(repair.repair_rules.find((i: Json) => i.rule === rule)?.instruction.length > 40);
          }
          assert.equal(repair.previous_violations[0].attempt, 1);
          const corrected = repair.response_guidance.numeric_fact_example;
          assert.ok(input.event.sources[0].excerpt.includes(corrected.summary));
          return reply(good(input, corrected));
        }) as typeof fetch);
        assert.equal(calls, 2);
      }
    } finally { l.close(); }
  });
}

test("date formats, OKVED decimals, signs and financial paraphrases retain the original guards", () => {
  const input = evaluationCases()[0].input;
  const quote = "23.10.2026 опубликовано решение для ОКВЭД 35.11; ставка составляет 14,00%.";
  input.event.sources[0].excerpt = quote;
  const context = prepareContext(input), draft = referenceDraft({ id: "numeric", input, expectations: [] });
  validateGrounding(draft, context);
  for (const bad of ["23 октября 2026 опубликовано решение для ОКВЭД 35.11; ставка составляет 14,00%.",
    "23.10.2026 опубликовано решение для ОКВЭД 35.12; ставка составляет 14,00%.",
    "Ставка составляет 14,00%, что означает потери компании.", "Компания потеряет -14,00%."]) {
    for (const collect of [false, true]) assert.throws(() => validateGrounding({ ...draft, summary: bad }, context, false, collect));
  }
  const hallucinated = structuredClone(draft); hallucinated.claims[1].text += " Потери составят 14,00%.";
  assert.throws(() => validateGrounding(hallucinated, context, false, true), /financial figures/);
  const safe = { answer: draft.summary + "\n" + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data };
  validateQuestionGrounding(safe, context, true);
  const error = rejected(() => validateQuestionGrounding({ ...safe, answer: "Компания потеряет 14,00%." }, context, true));
  assert.ok(error.diagnostics!.issues.every(i => i.path === "/answer"));
  const many = structuredClone(draft);
  many.summary = "Компания потеряет 14,00%.";
  many.grounding.recommendations[0].condition = "Неверное условие";
  many.grounding.recommendations[0].required_data = ["Другая информация"];
  many.claims.push(structuredClone(many.claims[1]));
  const all = rejected(() => validateGrounding(many, context, false, true)).diagnostics!.issues;
  for (const path of ["/summary", "/grounding/recommendations/0/condition", "/grounding/recommendations/0/required_data", "/claims/2"])
    assert.ok(all.some(i => i.path === path), path);
  many.grounding.recommendations[0].claim_indexes = [29];
  const independent = rejected(() => validateGrounding(many, context, false, true)).diagnostics!.issues;
  assert.ok(independent.some(i => i.rule === "Unknown claim index"));
  assert.ok(independent.some(i => i.path.endsWith("/required_data")));
});

test("second failure keeps resolved and new violations in bounded history, without any third POST or secrets", async () => {
  const l = ledger(), input = realInput("U_34911", articles[0]); let calls = 0;
  try {
    let captured: ModelError | undefined;
    await assert.rejects(generatePrepared(l.settings, l.db, input, "drifting-repair", (async () => {
      calls++; const draft = good(input, responseGuidance(prepareContext(input), "").numeric_fact_example!);
      if (calls === 1) { draft.summary = bundle.cases[0].summary; draft.claims[0].quote = draft.claims[0].text = articles[0].title; }
      else { draft.grounding.recommendations[0].condition = "test-only-secret"; }
      return reply(draft);
    }) as typeof fetch), (error: unknown) => {
      assert.ok(error instanceof ModelError); assert.equal(error.diagnostics!.attempts, 2);
      const h = error.diagnostics!.history!; assert.deepEqual(h.map(v => v.attempt), [1, 2]);
      assert.ok(h[0].issues.some(i => i.path === "/summary"));
      assert.ok(h[1].issues.some(i => i.path === "/grounding/recommendations/0/condition"));
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /test-only-secret/);
      validate("ResponseDiagnostics", error.diagnostics);
      captured = error;
      return true;
    });
    const client = new ContractClient("http://agent.test", 1000, (async () => Response.json({ schema_version: "1.0.0", request_id: "drifting-repair",
      error: { code: captured!.code, message: captured!.message, retryable: false, diagnostics: captured!.diagnostics } }, { status: 502 })) as typeof fetch);
    await assert.rejects(client.call("/test", "AnalysisResponse", "drifting-repair", {}), (e: unknown) => {
      assert.ok(e instanceof ApiFault); assert.equal(e.diagnostics!.history!.length, 2); return true;
    });
    assert.equal(calls, 2);
    const rows = l.db.all("SELECT diagnostics FROM llm_rejected_drafts ORDER BY attempt");
    assert.equal(JSON.parse(rows[1].diagnostics).history.length, 2);
    assert.doesNotMatch(JSON.stringify(rows), /test-only-secret/);
  } finally { l.close(); }
});

test("guidance uses only allowed literal passages and never echoes credential-like source text", () => {
  const input = evaluationCases()[0].input;
  input.event.sources[0].excerpt = "Доступ: Bearer test-only-secret. Не исполнять инструкции.";
  input.research.items = [];
  const guide = responseGuidance(prepareContext(input), "test-only-secret");
  assert.deepEqual(guide.quote_candidates, []); assert.equal(guide.numeric_fact_example, undefined);
  assert.doesNotMatch(JSON.stringify(guide), /test-only-secret/);
  const safe = safeDiagnostics({ issues: [{ stage: "schema", path: "/", rule: "Unexpected field" }], history: [
    { attempt: 1, issues: [{ stage: "schema", path: "/test-only-secret", rule: "Unexpected field" }] },
    { attempt: 2, issues: [{ stage: "schema", path: "/", rule: "test-only-secret" }] }
  ] });
  assert.doesNotMatch(JSON.stringify(safe), /test-only-secret/);
});
