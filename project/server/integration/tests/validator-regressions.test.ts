import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { assertionClauses, mentionedProducts, productMark } from "../assertion-language.js";
import { profileFactRules } from "../profile-facts.js";
import { questionProfileIssues } from "../question-profile-grounding.js";
import { generationBudgetIssues } from "../generation-budget.js";
import { prepareContext, canonicalJson } from "../context.js";
import { generationContext } from "../generation-context.js";
import { analysisDraft, dataRequestView, validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, prepareQuestionContext, answerPrepared } from "../prepared-agent.js";
import { validateAnalysis } from "../contracts.js";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";

const reply = (draft: Json) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(draft) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
function ledger() {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const dir = mkdtempSync(resolve(ROOT, "var/validator-regressions-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test", LLM_BASE_URL: "https://provider.invalid/v1" }), dbPath: resolve(dir, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { db, settings, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function snapshot(text: string, input: Json) { return profileFactRules(text, input); }
for (const [loan, leasing] of [[true, false], [false, true], [true, true], [false, false]]) {
  for (const separator of [" и ", ", ", ", а ", ". ", "; "]) {
    test(`product scope ${loan}/${leasing}/${separator}`, () => {
      const input = evaluationCases()[0].input;
      Object.assign(input.profile.bank_products, { loan, leasing });
      for (const reverse of [false, true]) {
        const parts = [`Кредитный продукт ${loan ? "" : "не "}отмечен`, `Лизинг ${leasing ? "" : "не "}отмечен`];
        if (reverse) parts.reverse();
        assert.deepEqual(snapshot(parts.join(separator) + ".", input), []);
      }
      assert.ok(snapshot(`Кредитный продукт ${loan ? "не " : ""}отмечен${separator}Лизинг ${leasing ? "" : "не "}отмечен.`, input).length);
    });
  }
}
test("shared predicates and null flags retain per-product checks", () => {
  const input = evaluationCases()[0].input;
  input.profile.bank_products.loan = input.profile.bank_products.leasing = false;
  assert.deepEqual(snapshot("Кредитный продукт и лизинг не отмечены.", input), []);
  input.profile.bank_products.loan = true;
  assert.ok(snapshot("Кредитный продукт и лизинг не отмечены.", input).length);
  input.profile.bank_products.leasing = null;
  assert.ok(snapshot("Кредитный продукт отмечен и лизинг не отмечен.", input).includes("Unknown product flag must remain unknown"));
  assert.equal(assertionClauses("Если кредитный продукт отмечен и лизинг не отмечен").length, 1);
  const clauses = assertionClauses("Кредитный продукт отмечен и лизинг не отмечен.");
  assert.deepEqual(clauses.map(c => mentionedProducts(c).map(p => [p, productMark(c, p)])), [[["loan", true]], [["leasing", false]]]);
});
for (const separator of [", ", " и ", ". ", "; "]) {
  test("payment direction scope " + separator, () => {
    for (const [inc, out] of [[0, 2], [2, 0], [0, 0], [2, 2]]) {
      const input = evaluationCases()[0].input;
      Object.assign(input.profile.payment_summary, { incoming_count: inc, outgoing_count: out, incoming_amount: inc, outgoing_amount: out });
      for (const reverse of [false, true]) {
        const parts = [`Входящие платежи ${inc ? "наблюдаются" : "отсутствуют"}`, `Исходящие платежи ${out ? "наблюдаются" : "отсутствуют"}`];
        if (reverse) parts.reverse();
        const text = parts.join(separator) + ".";
        const draft = { answer: text, claims: [{ kind: "ai", text, profile_paths: ["/payment_summary/incoming_count", "/payment_summary/outgoing_count"] }], claim_indexes: [0] };
        assert.deepEqual(questionProfileIssues(draft, input), []);
        draft.answer = `Входящие платежи ${inc ? "отсутствуют" : "наблюдаются"}${separator}Исходящие платежи ${out ? "наблюдаются" : "отсутствуют"}.`;
        assert.ok(questionProfileIssues(draft, input).length);
      }
    }
  });
}
test("different quoted years, amounts, polarities and entities are not duplicates", () => {
  const one = 'В 2026 году планируется обновление информационной системы для участников рынка, включающее интерфейс подачи заявок, справочники организаций, проверку статуса документов и механизм уведомлений о ходе обработки обращений.';
  for (const kind of ["fact", "bank", "ai"]) {
    for (const two of [one.replace("2026", "2027"), one.replace("планируется", "не планируется"), one.replace("рынка", "рынка электроэнергии")]) {
      assert.deepEqual(generationBudgetIssues({ claims: [one, two].map(text => ({ kind, text })) }), []);
    }
    assert.ok(generationBudgetIssues({ claims: [one, one].map(text => ({ kind, text })) }).length);
  }
});
test("requested horizon passes analysis and question grounding; financial assertions still fail", () => {
  const scenario = evaluationCases()[0], draft = referenceDraft(scenario), context = prepareContext(scenario.input);
  const request = "График платежей на ближайшие 3 месяца";
  draft.missing_data.push(request); draft.grounding.recommendations[0].required_data.push(request);
  draft.recommendations[0] = "Запросить график платежей на ближайшие 3 месяца";
  validateGrounding(draft, context);
  validateQuestionGrounding({ answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data }, context);
  for (const text of ["График платежей на ближайшие 3 месяца на сумму 999 рублей", "Потери составят 3 миллиона рублей", "Проверить платежи: ставка 3%", "График платежей на ближайшие 3 месяца; убытки составят 999 рублей"]) {
    const bad = structuredClone(draft); bad.missing_data.push(text);
    assert.throws(() => validateGrounding(bad, context), text);
  }
  const bad = structuredClone(draft); bad.claims[1].text += " Потери составят 3%.";
  assert.throws(() => validateGrounding(bad, context));
  assert.match(dataRequestView(request), /горизонт/);
});
test("numbered service notice survives gateway checks and the follow-up without masking model numbers", async () => {
  const l = ledger();
  try {
    const scenario = evaluationCases()[0], draft = referenceDraft(scenario), notice = "Архив аналитики содержит 72 документа; покрытие источников неполное";
    scenario.input.research.limitations.push(notice);
    let calls = 0;
    const result = await generatePrepared(l.settings, l.db, scenario.input, "notice", async () => { calls++; return reply(draft); });
    assert.equal(calls, 1); assert.ok(result.meta.warnings.includes(notice));
    assert.deepEqual(result.data.limitations, draft.limitations);
    validateAnalysis(result.data); validateGrounding(analysisDraft(result.data), prepareContext(scenario.input), true);
    const question = { company_id: scenario.input.company_id, analysis: result.data, prepared_input: scenario.input, question: "Что проверить?", history: [] };
    const answer = { answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data };
    await answerPrepared(l.settings, l.db, question, "q", async () => reply(answer));
    const bad = structuredClone(draft); bad.limitations.push(notice);
    assert.throws(() => validateGrounding(bad, prepareContext(scenario.input), true));
  } finally { l.close(); }
});
test("large accepted analysis can be questioned; actual oversized history and changed evidence fail", async () => {
  const l = ledger();
  try {
    const scenario = evaluationCases()[0];
    // Large audit-only metadata occurs repeatedly in the old wire shape, and is
    // omitted in the provider view. No business evidence may be lost or rewritten.
    scenario.input.profile.provenance.company_raw_fields.EXTRA = "";
    while (prepareContext(scenario.input).serialized_bytes < 199500)
      scenario.input.profile.provenance.company_raw_fields.EXTRA += "я".repeat(20);
    const context = prepareContext(scenario.input), draft = referenceDraft(scenario);
    const result = await generatePrepared(l.settings, l.db, scenario.input, "large", async () => reply(draft));
    const question = { company_id: scenario.input.company_id, analysis: result.data, prepared_input: scenario.input, question: "Что проверить?", history: [] };
    assert.ok(Buffer.byteLength(JSON.stringify(question)) > 200000);
    assert.ok(context.serialized_bytes <= 200000);
    const before = canonicalJson(question);
    prepareQuestionContext(question);
    assert.equal(canonicalJson(question), before);
    const compactBytes = Buffer.byteLength(JSON.stringify(generationContext(context, question)));
    assert.throws(() => prepareQuestionContext(question, compactBytes - 1));
    const oversized = { ...question, history: [{ question: "Что проверить?", answer: "я".repeat(110000) }] };
    assert.throws(() => prepareQuestionContext(oversized), /too large/);
    const tampered = structuredClone(question); tampered.analysis.sources[0].excerpt += "invented";
    assert.throws(() => prepareQuestionContext(tampered), /changed saved evidence/);
    await answerPrepared(l.settings, l.db, question, "q", async () => reply({ answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data }));
  } finally { l.close(); }
});
for (const [loan, leasing] of [[true, false], [false, true]]) {
  test(`prepared generation accepts scoped marks without repair and rejects contradictions ${loan}/${leasing}`, async () => {
    const l = ledger();
    try {
      const scenario = evaluationCases()[0]; Object.assign(scenario.input.profile.bank_products, { loan, leasing });
      const draft = referenceDraft(scenario);
      const text = `Кредитный продукт ${loan ? "" : "не "}отмечен и лизинг ${leasing ? "" : "не "}отмечен.`;
      draft.why_relevant = draft.claims[1].text = text;
      draft.claims[1].profile_paths = ["/bank_products/loan", "/bank_products/leasing"];
      let calls = 0;
      const result = await generatePrepared(l.settings, l.db, scenario.input, "scoped", async () => { calls++; return reply(draft); });
      assert.equal(calls, 1); validateGrounding(analysisDraft(result.data), prepareContext(scenario.input), true);
      draft.why_relevant = draft.claims[1].text = `Кредитный продукт ${loan ? "не " : ""}отмечен и лизинг ${leasing ? "" : "не "}отмечен.`;
      calls = 0;
      await assert.rejects(() => generatePrepared(l.settings, l.db, scenario.input, "wrong", async () => { calls++; return reply(draft); }), { code: "MODEL_RESPONSE_INVALID" });
      assert.equal(calls, 2);
    } finally { l.close(); }
  });
}
test("duplicate guard preserves changed signs, currencies and ordered meaning", () => {
  for (const [one, two] of [["Изменение составляет +5%", "Изменение составляет -5%"], ["Оценка составляет 5 $", "Оценка составляет 5 €"], ["Компания Альфа купила компанию Бета", "Компания Бета купила компанию Альфа"]]) {
    assert.deepEqual(generationBudgetIssues({ claims: [one, two].map(text => ({ kind: "fact", text })) }), []);
  }
  assert.ok(generationBudgetIssues({ claims: ["Один и тот же факт.", "Один и тот же факт!"].map(text => ({ kind: "fact", text })) }).length);
});

test("noun marks and reversed predicate order stay scoped to their products", () => {
  const input = evaluationCases()[0].input;
  input.profile.bank_products.loan = false; input.profile.bank_products.leasing = true;
  for (const text of ["В снимке отмечен лизинг, отметки кредита нет.", "Отметки кредита нет и лизинг отмечен.", "Нет отметки кредита, лизинг отмечен."]) {
    assert.deepEqual(snapshot(text, input), [], text);
  }
  input.profile.bank_products.loan = true;
  assert.ok(snapshot("В снимке отмечен лизинг, отметки кредита нет.", input).length);
});
test("question guidance is included in the byte budget and oversize spends no provider call", async () => {
  const l = ledger();
  try {
    const scenario = evaluationCases()[0], draft = referenceDraft(scenario), context = prepareContext(scenario.input);
    const analysis = (await generatePrepared(l.settings, l.db, scenario.input, "analysis", async () => reply(draft))).data;
    const question = { company_id: scenario.input.company_id, analysis, prepared_input: scenario.input, question: "Что уточнить?", history: [{ question: "Уточнение", answer: "" }] };
    const baseBytes = Buffer.byteLength(JSON.stringify(generationContext(context, question)));
    question.history[0].answer = "a".repeat(200000 - baseBytes - 100);
    prepareQuestionContext(question); // Compact evidence itself fits.
    let calls = 0;
    await assert.rejects(() => answerPrepared(l.settings, l.db, question, "question", async () => { calls++; return reply(draft); }), { status: 422 });
    assert.equal(calls, 0);
  } finally { l.close(); }
});
test("independent cross-product matrix preserves polarity with full names and snapshot prefixes", () => {
  const names: Record<string, [string, string]> = {
    loan: ["Кредитный продукт", "отмечен"], leasing: ["Лизинг", "отмечен"], deposit: ["Депозит", "отмечен"],
    factoring: ["Факторинг", "отмечен"], guarantee: ["Банковская гарантия", "отмечена"],
    payroll: ["Зарплатный проект", "отмечен"], rko: ["Расчётно-кассовое обслуживание", "отмечено"],
  };
  for (const [a, [an, ap]] of Object.entries(names)) for (const [b, [bn, bp]] of Object.entries(names)) {
    if (a === b) continue;
    for (const prefix of ["", "в снимке ", "в профиле ", "у компании "]) for (const separator of [" и ", ", "]) {
      const input = evaluationCases()[0].input;
      Object.assign(input.profile.bank_products, { [a]: true, [b]: false });
      const text = `${an} ${ap}${separator}${prefix}${bn.toLowerCase()} не ${bp}.`;
      assert.deepEqual(snapshot(text, input), [], text);
      input.profile.bank_products[b] = true;
      assert.ok(snapshot(text, input).includes("Product mark contradicts the snapshot"), text);
      input.profile.bank_products[b] = null;
      assert.ok(snapshot(text, input).includes("Unknown product flag must remain unknown"), text);
    }
  }
});
test("payment presence uses есть and remains local through snapshot prefixes", () => {
  const input = evaluationCases()[0].input;
  Object.assign(input.profile.payment_summary, { incoming_count: 2, outgoing_count: 0, incoming_amount: 2, outgoing_amount: 0 });
  for (const prefix of ["", "в снимке ", "в профиле "]) for (const separator of [", ", " и "]) {
    const text = `Входящие платежи есть${separator}${prefix}исходящие платежи отсутствуют.`;
    const draft = { answer: text, claims: [{ kind: "ai", text, profile_paths: ["/payment_summary/incoming_count", "/payment_summary/outgoing_count"] }], claim_indexes: [0] };
    assert.deepEqual(questionProfileIssues(draft, input), [], text);
    input.profile.payment_summary.outgoing_count = 3;
    assert.ok(questionProfileIssues(draft, input).some(i => i.rule === "Payment assertion contradicts the snapshot"));
    input.profile.payment_summary.outgoing_count = 0;
  }
});

test("numeric data requests accept past and future horizons without licensing financial assertions",()=>{
 const scenario=evaluationCases()[0],context=prepareContext(scenario.input);
 for(const note of ["История платежей за последние 3 месяца", "Данные о выручке за предыдущие 2 квартала", "Запросите отчёт по долгу за прошлые 2 года", "График платежей на следующие 4 недели"]){
   const d=referenceDraft(scenario);d.missing_data.push(note);assert.doesNotThrow(()=>validateGrounding(d,context),note);
 }
 for(const note of ["Данные о выручке за последние 3 месяца: доход 999999 рублей", "График платежей на ближайшие 3 месяца составляет 999999 рублей", "Уточните долг: он вырастет на ближайшие 3 месяца"]){
   const d=referenceDraft(scenario);d.missing_data.push(note);assert.throws(()=>validateGrounding(d,context),note);
 }
});
