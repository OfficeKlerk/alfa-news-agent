import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";
import { truncationCause } from "../../llm.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding } from "../grounding.js";
import { generatePrepared } from "../prepared-agent.js";
import { generationBudgetIssues } from "../generation-budget.js";
import { joinStrictClaims, STRICT_CLAIM_GROUPS, strictResponseSchema } from "../response-schema.js";
import { industryWording, repairInstruction, repairPlan } from "../repair-guidance.js";
import { ANALYSIS_PROMPT, PROMPT_VERSION } from "../analysis-prompts.js";

// REPORT9 (live check of TASKS8): strict answers without ai claims, new loop forms, rate-up-borrower repair.
const split = (draft: Json) => {
  const { claims, ...rest } = draft;
  const order = ["fact", "bank", "ai"], sorted = [...claims].sort((a: Json, b: Json) => order.indexOf(a.kind) - order.indexOf(b.kind));
  assert.deepEqual(sorted, claims, "fixture claims must already be in fact, bank, ai order");
  return { ...rest, fact_claims: claims.filter((c: Json) => c.kind === "fact"), bank_claims: claims.filter((c: Json) => c.kind === "bank"), ai_claims: claims.filter((c: Json) => c.kind === "ai") };
};

test("strict schema: typed arrays require an ai claim and cap bank claims; REPORT9's 1 fact + 7 bank is rejected", () => {
  for (const name of ["GeneratedAnalysis", "GeneratedAnswer"] as const) {
    const schema = strictResponseSchema(name).schema;
    assert.equal(schema.properties.claims, undefined);
    assert.deepEqual(STRICT_CLAIM_GROUPS.map(g => g.key).every(k => schema.required.includes(k)), true);
    assert.equal(schema.properties.ai_claims.minItems, 1); assert.equal(schema.properties.bank_claims.maxItems, 3);
    assert.ok(STRICT_CLAIM_GROUPS.reduce((n, g) => n + g.maxItems, 0) <= 8, "total stays within the live claim budget");
    assert.deepEqual(schema.properties.ai_claims.items.properties.kind.enum, ["ai"]);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), "strict mode: every property required");
  }
  const check = new Ajv2020({ strict: false }).compile(strictResponseSchema("GeneratedAnalysis").schema);
  const s = evaluationCases()[0], d = referenceDraft(s);
  assert.ok(check(split(d)), JSON.stringify(check.errors));
  const bank = { kind: "bank", text: "Тестовый фрагмент для проверки", quote: "Тестовый фрагмент для проверки", source_ids: ["research:demo-bank:p1"] };
  const report9 = { ...split(d), bank_claims: Array(7).fill(bank), ai_claims: [] };
  assert.equal(check(report9), false);
  assert.equal(check({ ...split(d), ai_claims: [] }), false, "no ai claim");
  assert.equal(check({ ...split(d), bank_claims: Array(4).fill(bank) }), false, "four bank claims");
  assert.equal(check({ ...split(d), ai_claims: [{ ...d.claims[0] }] }), false, "a fact in ai_claims");
});

test("strict join: typed arrays become the canonical list in fact, bank, ai order; anything else is left to the contract", () => {
  const s = evaluationCases()[0], d = referenceDraft(s), context = prepareContext(s.input);
  const joined = joinStrictClaims(split(d));
  assert.deepEqual(joined.claims, d.claims); assert.equal(joined.ai_claims, undefined);
  validateGrounding(joined, context, false, true);
  assert.equal(joinStrictClaims(d), d, "canonical drafts are unchanged");
  const partial = { ...split(d) }; delete partial.ai_claims;
  assert.equal(joinStrictClaims(partial), partial);
  assert.throws(() => validateGrounding(partial, context));
});

test("strict end to end: the provider sees typed arrays and the layout note; a typed reply is accepted", async () => {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/llm-test-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "local-test-secret", LLM_BASE_URL: "https://provider.invalid/v1",
    LLM_RESPONSE_FORMAT: "json_schema" }), dbPath: resolve(folder, "calls.sqlite3"), maxCalls: 10, questionReserveCalls: 0, timeout: 1000 };
  const db = new Store(settings), s = evaluationCases()[0]; let payload: Json = {}, calls = 0;
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  try {
    const result = await generatePrepared(settings, db, s.input, "strict", (async (_url, init) => {
      calls++; payload = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(split(referenceDraft(s))) } }] });
    }) as typeof fetch);
    assert.equal(calls, 1);
    assert.ok(payload.response_format.json_schema.schema.properties.ai_claims);
    assert.match(JSON.parse(payload.messages[1].content).strict_claims_layout, /fact_claims, bank_claims, ai_claims/);
    assert.deepEqual(result.data.claims, referenceDraft(s).claims);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("truncation diagnosis names REPORT9's structural loop and the «не содержит информации» enumeration", () => {
  // tasks8-verify-b call-03: after 4 claims the model repeated an escaped grounding fragment inside a string.
  const structural = '{"claims":[{"kind":"fact","text":"Совет директоров сохранил ставку."}],"why_relevant":"' + Array(40).fill(',"grounding\\":[0,1,2,3],"').join("\n");
  assert.match(truncationCause(structural), /структурное зацикливание: поле grounding повторено 40 раз/);
  const claim = (text: string) => JSON.stringify({ kind: "ai", text, quote: "", source_ids: [] });
  const absent = '{"claims":[' + ["о новых договорах", "о рефинансировании", "о гарантиях", "о валюте"].map(x => claim("Событие не содержит информации " + x + ".")).join(",");
  assert.match(truncationCause(absent), /перечень того, о чём новость не сообщает: 4 таких claims из 4/);
  // A complete ordinary answer is not called a loop.
  assert.match(truncationCause(JSON.stringify(referenceDraft(evaluationCases()[0]))), /Обычная причина/);
});

test("budget: near-copies and «не содержит информации» lists get one compact rebuild; distinct product claims do not", () => {
  const s = evaluationCases()[0], d = referenceDraft(s);
  const near = structuredClone(d); near.claims.push({ ...d.claims[1], text: d.claims[1].text.replace(/\.$/, "") + "!" });
  assert.deepEqual(generationBudgetIssues(near).map(i => i.rule), ["Repeated claim text"]);
  // rerun call-08: one claim per product differs by one word and is not a copy.
  const products = structuredClone(d); products.claims.splice(1, 1,
    { ...d.claims[1], text: "В снимке отмечен продукт лизинга. Потенциальный канал, если действующий договор существует и его условия чувствительны к ставке." },
    { ...d.claims[1], text: "В снимке отмечен продукт кредита. Потенциальный канал, если действующий договор существует и его условия чувствительны к ставке." });
  assert.deepEqual(generationBudgetIssues(products), []);
  const absent = structuredClone(d); absent.claims.push({ ...d.claims[1], text: "Событие не содержит информации о новых договорах." },
    { ...d.claims[1], text: "Новость не сообщает о рефинансировании компании." });
  const issues = generationBudgetIssues(absent);
  assert.deepEqual(issues.map(i => i.rule), ["Speculative absence enumeration"]);
  assert.equal(repairPlan(issues, absent, false, { input: s.input }).mode, "rebuild_compact");
  assert.match(repairInstruction(issues[0]), /missing_data/);
  const one = structuredClone(d); one.claims.push({ ...d.claims[1], text: "Событие не содержит информации о новых договорах." });
  assert.deepEqual(generationBudgetIssues(one), []);
});

test("REPORT9 rate-up-borrower: an ai claim without a profile basis is deleted, and the exact industry wording is always given", () => {
  const s = evaluationCases()[0], d = referenceDraft(s);
  d.claims.push({ kind: "ai", text: "Событие относится к категории синтетического теста. Связь не подтверждена предоставленными данными.",
    quote: "", source_ids: d.claims[1].source_ids, profile_paths: [], conditions: ["Если событие реально"] });
  const issue = { stage: "schema" as const, path: "/claims/2/profile_paths", rule: "Too few items" };
  assert.match(repairInstruction(issue, false, d), /удали claim целиком.*не добавляй путь отрасли/s);
  const plan = repairPlan([issue], d, false, { input: s.input });
  assert.deepEqual(plan.industry_wording, industryWording(s.input));
  assert.equal(repairPlan([issue], d, false, {}).industry_wording, undefined, "no input, no wording");
});

test("prompt v14 forbids «не содержит информации» lists and repeated fields", () => {
  assert.equal(PROMPT_VERSION, "company-news-grounded-v14");
  assert.match(ANALYSIS_PROMPT, /Не перечисляй, о чём новость не сообщает/);
  assert.match(ANALYSIS_PROMPT, /Каждое поле ответа пиши ровно один раз/);
});

test("REPORT9 run C: strict profile_paths need a real segment, so twenty «/» no longer fit the provider schema", () => {
  const check = new Ajv2020({ strict: false }).compile(strictResponseSchema("GeneratedAnalysis").schema);
  const s = evaluationCases()[0], d = split(referenceDraft(s));
  assert.ok(check(d), JSON.stringify(check.errors));
  assert.equal(check({ ...d, ai_claims: [{ ...d.ai_claims[0], profile_paths: Array(20).fill("/") }] }), false);
  assert.equal(check({ ...d, ai_claims: [{ ...d.ai_claims[0], profile_paths: Array(11).fill(0).map((_, i) => "/bank_products/p" + i) }] }), false);
  for (const path of ["/bank_products/loan", "/payment_summary/counterparty_context/in/industry_distribution/0/share_of_direction", "/foreign_trade/has_fts"])
    assert.ok(check({ ...d, ai_claims: [{ ...d.ai_claims[0], profile_paths: [path] }] }), path);
});

test("REPORT9 run C power-software: «не оказывает прямого воздействия на деятельность компании» is proven absence; the scoped form is allowed", async () => {
  const { cautiousLanguageRules } = await import("../cautious-language.js");
  const s = evaluationCases()[0];
  assert.ok(cautiousLanguageRules("Разработка новых ГОСТов в сфере электроэнергетики не оказывает прямого воздействия на деятельность компании, так как её профильная отрасль не совпадает с тематикой новости.", s.input)
    .includes("Unconfirmed linkage must not be stated as proven absence"));
  for (const text of ["Прямое воздействие разработки стандартов на деятельность компании не подтверждено предоставленными данными.",
    "Связь не подтверждена предоставленными данными."])
    assert.ok(!cautiousLanguageRules(text, s.input).includes("Unconfirmed linkage must not be stated as proven absence"), text);
});
