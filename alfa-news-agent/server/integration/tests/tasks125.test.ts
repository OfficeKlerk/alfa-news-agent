import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { cautiousLanguageRules } from "../cautious-language.js";
import { profileFactRules } from "../profile-facts.js";
import { ApiFault, validate } from "../contracts.js";

const reply = (d: Json) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(d) } }] });
function fixture() {
  const s = evaluationCases()[0];
  Object.assign(s.input.profile.bank_products, { rko: true, payroll: true, loan: false, leasing: false, deposit: false, guarantee: false, factoring: false });
  Object.assign(s.input.profile.payment_summary, { incoming_count: 2, outgoing_count: 3, incoming_amount: 10, outgoing_amount: 20, currency: null, period: null });
  Object.assign(s.input.profile.foreign_trade, { has_fts: false, currencies: null });
  return s;
}
function question(s = fixture()) {
  const d = referenceDraft(s);
  return { answer: d.summary + "\n" + d.why_relevant, claims: d.claims, claim_indexes: [0, 1], limitations: d.limitations, missing_data: d.missing_data };
}
function addProfileClaim(q: Json, s: Json, text: string, paths: string[]) {
  q.claim_indexes.push(q.claims.length);
  q.claims.push({ kind: "ai", text, quote: "", source_ids: ["company:" + s.input.company_id, s.input.event.sources[0].id],
    profile_paths: paths, conditions: ["Если нужно проверить данные снимка"] });
}

test("observed reversed absence wording is rejected, including separate qualifications", () => {
  const s = fixture();
  for (const text of ["Отсутствует прямая связь между новостью и компанией.",
    "Связь не подтверждена. Отсутствует прямая связь между новостью и компанией.",
    "Связь не подтверждена, но прямая связь отсутствует.",
    "Решение регулятора о сохранении ставки не оказывает прямого воздействия на компанию, так как в снимке отсутствует отметка о наличии кредитных продуктов.",
    "Связь не подтверждена, однако отсутствует прямая связь."]) {
    assert.ok(cautiousLanguageRules(text, s.input).includes("Unconfirmed linkage must not be stated as proven absence"), text);
    const d = referenceDraft(s); d.limitations.push(text);
    assert.throws(() => validateGrounding(d, prepareContext(s.input), false, true), /proven absence/);
    const q = question(s); q.answer += "\n" + text;
    assert.throws(() => validateQuestionGrounding(q, prepareContext(s.input), true), /proven absence/);
  }
  for (const text of ["Связь не подтверждена предоставленными данными.",
    "Подтверждённая связь отсутствует.",
    "Из неполного графа не следует, что отсутствует прямая связь.",
    "Если прямая связь отсутствует, нужно уточнить применимость.",
    "Проверить, отсутствует ли прямая связь."]) assert.deepEqual(cautiousLanguageRules(text, s.input), [], text);
});

test("debt and currency absence cannot be inferred by reversing the word order", () => {
  const s = fixture();
  for (const text of ["Долги отсутствуют.", "Кредиты у компании отсутствуют.",
    "loan=false, но долги отсутствуют."]) assert.ok(profileFactRules(text, s.input).includes("Product flags do not establish debt or contract terms"), text);
  for (const text of ["Валютные операции отсутствуют (has_fts=false).", "Валютные платежи у компании отсутствуют.",
    "Валюты не подтверждены, однако валютные операции отсутствуют."]) assert.ok(profileFactRules(text, s.input).includes("Trade flags do not establish direction or payment currency"), text);
  for (const text of ["has_fts=false не доказывает, что валютные операции отсутствуют.",
    "Отсутствие отметки не означает, что долги отсутствуют.",
    "Не подтверждено, что долги отсутствуют.",
    "Если валютные операции отсутствуют, нужно уточнить договоры.",
    "Проверить, отсутствуют ли валютные операции."]) assert.deepEqual(profileFactRules(text, s.input), [], text);
});

test("new question facts need matching referenced claims AND precise product/payment fields", () => {
  const s = fixture(), context = prepareContext(s.input), q = question(s);
  // Reproduces the observed extra prose with correct values but only old claim references.
  const text = "В снимке отмечены РКО и зарплатный проект. Продукты leasing, guarantee, deposit, factoring не отмечены. Наблюдаются входящие и исходящие платежи. Валюта и период платежей неизвестны.";
  q.answer += "\n" + text;
  assert.throws(() => validateQuestionGrounding(q, context, true), /Question profile assertion needs/);
  const paths = ["rko", "payroll", "leasing", "guarantee", "deposit", "factoring"].map(p => "/bank_products/" + p);
  paths.push("/payment_summary/incoming_count", "/payment_summary/outgoing_count", "/payment_summary/currency", "/payment_summary/period");
  addProfileClaim(q, s, text, paths);
  validateQuestionGrounding(q, context, true);
  const wrongPath = structuredClone(q); wrongPath.claims[2].profile_paths = ["/industry/name"];
  assert.throws(() => validateQuestionGrounding(wrongPath, context, true), /Question profile assertion needs/);
  const wrongText = structuredClone(q); wrongText.claims[2].text = "Отрасль известна, договоры нужно проверить.";
  assert.throws(() => validateQuestionGrounding(wrongText, context, true), /Question profile assertion needs/);
  const unreferenced = structuredClone(q); unreferenced.claim_indexes = [0, 1];
  assert.throws(() => validateQuestionGrounding(unreferenced, context, true), /Question profile assertion needs/);
  const conditional = structuredClone(q); conditional.claims[2].text = "Если в снимке отмечены РКО и зарплатный проект, нужно проверить договоры.";
  assert.throws(() => validateQuestionGrounding(conditional, context, true), /Question profile assertion needs/);
});

test("correct paths cannot launder wrong product values or nonexistent observed payments", () => {
  const s = fixture(), context = prepareContext(s.input);
  for (const text of ["В снимке отмечен депозит.", "Продукты leasing, deposit отмечены.", "loan=true"]) {
    const q = question(s); q.answer += "\n" + text;
    addProfileClaim(q, s, text, ["/bank_products/deposit", "/bank_products/leasing", "/bank_products/loan"]);
    assert.throws(() => validateQuestionGrounding(q, context, true), /Product mark contradicts/);
  }
  s.input.profile.bank_products.payroll = null;
  const unknown = question(s); unknown.answer += "\nВ снимке отмечен зарплатный проект.";
  addProfileClaim(unknown, s, "В снимке отмечен зарплатный проект.", ["/bank_products/payroll"]);
  assert.throws(() => validateQuestionGrounding(unknown, prepareContext(s.input), true), /Unknown product flag/);
  s.input.profile.payment_summary.incoming_count = 0;
  const payments = question(s); payments.answer += "\nНаблюдаются входящие платежи.";
  addProfileClaim(payments, s, "Наблюдаются входящие платежи.", ["/payment_summary/incoming_count"]);
  assert.throws(() => validateQuestionGrounding(payments, prepareContext(s.input), true), /Payment assertion contradicts/);
});

test("zero observed amount differs from absent transactions and unknown amounts", () => {
  const s = fixture(); s.input.profile.payment_summary.incoming_amount = 0;
  const q = question(s), text = "Входящие платежи равны нулю.";
  q.answer += "\n" + text;
  addProfileClaim(q, s, text, ["/payment_summary/incoming_amount"]);
  validateQuestionGrounding(q, prepareContext(s.input), true);
  s.input.profile.payment_summary.incoming_amount = null;
  assert.throws(() => validateQuestionGrounding(q, prepareContext(s.input), true), /Unknown payment metadata|Payment assertion contradicts/);
  const countOnly = fixture(), p = question(countOnly);
  p.answer += "\n" + text; addProfileClaim(p, countOnly, text, ["/payment_summary/incoming_count"]);
  assert.throws(() => validateQuestionGrounding(p, prepareContext(countOnly.input), true), /Question profile assertion needs/);
});

test("questions, warnings and literal evidence do not become asserted product facts", () => {
  const s = fixture(), q = question(s);
  q.answer += "\nУточнить условия лизинга. Если депозит отмечен, проверить договоры. Отметка не доказывает, что компания использует лизинг.";
  validateQuestionGrounding(q, prepareContext(s.input), true);
  const text = "Валютные операции отсутствуют. Отсутствует прямая связь между новостью и компанией.";
  s.input.event.text = s.input.event.sources[0].excerpt = text;
  const literal = question(s); validateQuestionGrounding(literal, prepareContext(s.input), true);
});

for (const format of ["json_object", "json_schema"]) {
  test(`${format}: source repair supplies both anchors, retains history and stops after two calls`, async () => {
    mkdirSync(resolve(ROOT, "var"), { recursive: true });
    const folder = mkdtempSync(resolve(ROOT, "var/tasks125-"));
    const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test-only-secret", LLM_RESPONSE_FORMAT: format }), dbPath: resolve(folder, "calls.sqlite3") };
    const db = new Store(settings);
    db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
    const s = fixture(); let calls = 0;
    try {
      const result = await generatePrepared(settings, db, s.input, "both-sources", (async (_url, init) => {
        calls++; const payload = JSON.parse(String(init?.body)), data = JSON.parse(payload.messages[1].content);
        const d = referenceDraft(s), expected = ["company:" + s.input.company_id, s.input.event.sources[0].id];
        assert.deepEqual(data.response_guidance.ai_source_requirements.source_ids_example, expected);
        if (calls === 1) d.claims[1].source_ids = expected.slice(0, 1);
        else {
          const repair = JSON.parse(payload.messages.at(-1).content);
          assert.deepEqual(repair.ai_source_requirements.source_ids_example, expected);
          assert.match(repair.repair_rules[0].instruction, /одновременно/);
          assert.equal(repair.previous_violations.length, 1);
          d.claims[1].source_ids = repair.ai_source_requirements.source_ids_example;
        }
        return reply(d);
      }) as typeof fetch);
      assert.equal(calls, 2); assert.equal(result.data.mode, "live");
      let questionCalls = 0;
      const answered = await answerPrepared(settings, db, { company_id: s.input.company_id, analysis: result.data,
        question: "Какие продукты отмечены?", history: [], prepared_input: s.input }, "new-facts", (async (_url, init) => {
        questionCalls++; const q = question(s); const text = "В снимке отмечены РКО и зарплатный проект.";
        q.answer += "\n" + text;
        if (questionCalls > 1) {
          const payload = JSON.parse(String(init?.body)), repair = JSON.parse(payload.messages.at(-1).content);
          assert.ok(repair.repair_rules.some((i: Json) => /profile_paths/.test(i.instruction)));
          addProfileClaim(q, s, text, ["/bank_products/rko", "/bank_products/payroll"]);
        }
        return reply(q);
      }) as typeof fetch);
      assert.equal(questionCalls, 2); assert.match(answered.data.answer, /РКО/);
      let failed = 0;
      await assert.rejects(generatePrepared(settings, db, s.input, "drift", (async () => {
        const d = referenceDraft(s); d.claims[1].source_ids = ++failed === 1 ? ["company:" + s.input.company_id] : [s.input.event.sources[0].id];
        return reply(d);
      }) as typeof fetch), (e: unknown) => {
        assert.ok(e instanceof ModelError); assert.equal(e.diagnostics!.history!.length, 2);
        validate("ResponseDiagnostics", e.diagnostics);
        assert.match(e.diagnostics!.history![0].issues[0].rule, /selected news/);
        assert.match(e.diagnostics!.history![1].issues[0].rule, /selected company/);
        return true;
      });
      assert.equal(failed, 2);
    } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
  });
}

test("coverage diagnostics keep only contract paths and survive sanitization", () => {
  const s = fixture(), q = question(s); q.answer += "\nВ снимке отмечены РКО и зарплатный проект.";
  try { validateQuestionGrounding(q, prepareContext(s.input), true); assert.fail("Expected failure"); }
  catch (e) { assert.ok(e instanceof ApiFault); validate("ResponseDiagnostics", { ...e.diagnostics, attempts: 1, max_attempts: 2 }); }
});
