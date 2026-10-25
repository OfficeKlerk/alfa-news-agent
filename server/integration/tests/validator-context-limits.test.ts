import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadSettings } from "../../config.js";
import { Store } from "../../db.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { analysisDraft, validateGrounding } from "../grounding.js";
import { generatePrepared, prepareQuestionContext, answerPrepared } from "../prepared-agent.js";
import { budgetStatus } from "../../llm-budget.js";
import type { Json } from "../../types.js";
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "alfa-context-limit-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "fixture-only", LLM_BASE_URL: "https://provider.invalid/v1" }), dbPath: resolve(dir, "calls.sqlite3") };
  const db = new Store(settings);
  return { settings, db, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function reply(content: Json) { return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 20 } }); }
test("D4: requested data period is accepted without authorizing financial predictions or extra assertions", () => {
  const scenario = evaluationCases()[0], context = prepareContext(scenario.input);
  for (const period of ["График платежей на ближайшие 3 месяца", "Данные о выручке за последние 12 месяцев"]) {
    const d = referenceDraft(scenario); d.missing_data = [period]; d.recommendations = ["Запросить " + period.toLowerCase()];
    d.grounding.recommendations[0].required_data = [period];
    validateGrounding(d, context);
  }
  for (const value of ["График платежей на ближайшие 3 месяца, платежи составят 9 рублей", "Прибыль снизится на 3%", "Расходы составят 300 миллионов", "Кредит на 3 месяца"]) {
    const d = referenceDraft(scenario); d.missing_data = [value]; d.grounding.recommendations[0].required_data = [value];
    assert.throws(() => validateGrounding(d, context), /Unsupported|Financial|financial/);
  }
  const d = referenceDraft(scenario); d.claims[1].text += " Выручка вырастет за 3 месяца.";
  assert.throws(() => validateGrounding(d, context), /Unsupported numeric|financial/);
});
test("D5: numeric retrieval metadata does not invalidate a grounded answer at its publication boundary", async () => {
  const f = fixture(), scenario = evaluationCases()[0];
  scenario.input.research.limitations = ["Архив аналитики содержит 72 документа; покрытие источников неполное"];
  try {
    const result = await generatePrepared(f.settings, f.db, scenario.input, "numeric-notice", (async () => reply(referenceDraft(scenario))) as typeof fetch);
    validateGrounding(analysisDraft(result.data), prepareContext(scenario.input), true);
    assert.ok(result.meta.warnings.includes(scenario.input.research.limitations[0]));
    assert.ok(result.data.trace.some((s: Json) => s.step === "retrieval_limitation" && s.detail.includes("72")));
    assert.match(scenario.input.research.limitations[0], /72/, "original audit context stays unchanged");
    assert.equal(budgetStatus(f.settings, f.db).used.calls, 1);
  } finally { f.close(); }
});
test("D6: a near-limit accepted context permits a first question; tampered evidence and unbounded history remain rejected", async () => {
  const f = fixture(), scenario = evaluationCases()[0];
  try {
    // Expand only provenance, which is audit data and is omitted from provider prompts.
    scenario.input.profile.provenance.company_raw_fields.audit_padding = "x".repeat(80000);
    const size = prepareContext(scenario.input).serialized_bytes;
    f.settings.maxContextBytes = size;
    const draft = referenceDraft(scenario);
    const analysis = (await generatePrepared(f.settings, f.db, scenario.input, "near-limit", (async () => reply(draft)) as typeof fetch)).data;
    const input = { company_id: analysis.company_id, analysis, question: "Что нужно уточнить?", history: [], prepared_input: scenario.input };
    assert.ok(Buffer.byteLength(JSON.stringify(input)) > size, "reproduces the old raw-envelope limit");
    prepareQuestionContext(input, size);
    const answer = { answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data };
    await answerPrepared(f.settings, f.db, input, "followup", (async () => reply(answer)) as typeof fetch);
    assert.equal(f.db.get("SELECT purpose FROM llm_budget_reservations ORDER BY call_id DESC LIMIT 1")!.purpose, "question");
    const altered = structuredClone(input); altered.analysis.sources[0].excerpt += "changed";
    assert.throws(() => prepareQuestionContext(altered, size), /changed saved evidence/);
    const oversized = { ...input, history: Array.from({ length: 10 }, () => ({ question: "x".repeat(1000), answer: "x".repeat(size) })) };
    assert.throws(() => prepareQuestionContext(oversized, size), /too large/);
  } finally { f.close(); }
});
