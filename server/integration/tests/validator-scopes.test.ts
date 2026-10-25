import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { productMark } from "../assertion-language.js";
import { profileFactRules } from "../profile-facts.js";
import { generationBudgetIssues } from "../generation-budget.js";
import { questionProfileIssues } from "../question-profile-grounding.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding } from "../grounding.js";
import { generatePrepared } from "../prepared-agent.js";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";

function fixture() {
  const s = evaluationCases()[0];
  Object.assign(s.input.profile.bank_products, { loan: true, leasing: false });
  Object.assign(s.input.profile.payment_summary, { incoming_count: 0, incoming_amount: 0, outgoing_count: 2, outgoing_amount: 200 });
  delete s.input.profile.payment_summary.counterparty_context;
  return s;
}

const productPaths = ["/bank_products/loan", "/bank_products/leasing"];
const paymentPaths = ["/payment_summary/incoming_count", "/payment_summary/incoming_amount", "/payment_summary/outgoing_count", "/payment_summary/outgoing_amount"];
function draft(s: ReturnType<typeof fixture>, text: string, paths: string[]) {
  const d = referenceDraft(s);
  d.claims[1].text = d.why_relevant = text;
  d.claims[1].profile_paths = paths;
  return d;
}

test("D1: each coordinated product keeps its own positive or negative mark", () => {
  const s = fixture();
  for (const text of [
    "Кредитный продукт отмечен и лизинг не отмечен.",
    "Кредитный продукт отмечен, а лизинг не отмечен.",
    "Отмечен кредитный продукт и не отмечен лизинг.",
    "Лизинг не отмечен и кредитный продукт отмечен.",
    "Кредитный продукт отмечен, а лизинг — нет.",
    "Кредитный продукт отмечен. Лизинг не отмечен.",
  ]) {
    assert.deepEqual(profileFactRules(text, s.input), [], text);
    validateGrounding(draft(s, text, productPaths), prepareContext(s.input));
  }
  for (const text of [
    "Кредитный продукт не отмечен и лизинг отмечен.",
    "Кредитный продукт отмечен и лизинг отмечен.",
    "Кредитный продукт не отмечен и лизинг не отмечен.",
  ]) assert.ok(profileFactRules(text, s.input).includes("Product mark contradicts the snapshot"), text);
});

test("shared product predicates and lists remain shared; a neighbouring predicate does not leak", () => {
  for (const text of ["Кредитный продукт и лизинг не отмечены.", "В снимке не отмечены кредитный продукт и лизинг.",
    "Продукты loan, leasing не отмечены."])
    for (const product of ["loan", "leasing"]) assert.equal(productMark(text, product), false, text);
  for (const product of ["rko", "payroll"]) assert.equal(productMark("В снимке отмечены РКО и зарплатный проект.", product), true);
  const text = "Продукты leasing, guarantee, deposit, factoring не отмечены.";
  for (const product of ["leasing", "guarantee", "deposit", "factoring"]) assert.equal(productMark(text, product), false);
  assert.equal(productMark("loan=true и leasing=false", "loan"), true);
  assert.equal(productMark("loan=true и leasing=false", "leasing"), false);
});

test("D2: separate incoming and outgoing predicates bind to their own snapshot fields", () => {
  const s = fixture();
  for (const text of [
    "Входящие платежи отсутствуют, исходящие платежи наблюдаются.",
    "Входящие платежи не наблюдаются и исходящие платежи есть.",
    "Входящие платежи равны нулю, исходящие платежи наблюдаются.",
    "Исходящие платежи наблюдаются, а входящие платежи отсутствуют.",
    "Не наблюдаются входящие платежи и наблюдаются исходящие платежи.",
    "Входящие платежи отсутствуют. Исходящие платежи наблюдаются.",
  ]) validateGrounding(draft(s, text, paymentPaths), prepareContext(s.input));
  for (const text of [
    "Входящие платежи наблюдаются, исходящие платежи отсутствуют.",
    "Входящие и исходящие платежи отсутствуют.",
    "Входящие и исходящие платежи наблюдаются.",
  ]) assert.throws(() => validateGrounding(draft(s, text, paymentPaths), prepareContext(s.input)), /Payment assertion contradicts/);
});

test("follow-up needs a supporting claim for the same direction and same local predicate", () => {
  const s = fixture(), text = "Входящие платежи отсутствуют, исходящие платежи наблюдаются.";
  const d = draft(s, text, paymentPaths);
  const answer = { answer: text, claims: d.claims, claim_indexes: [1] };
  assert.deepEqual(questionProfileIssues(answer, s.input), []);
  answer.claims[1].text = "Входящие платежи отсутствуют, исходящие платежи отсутствуют.";
  assert.ok(questionProfileIssues(answer, s.input).some(i => i.rule === "Question profile assertion needs matching claim and profile path"));
  answer.claims[1].text = text;
  answer.claims[1].profile_paths = ["/payment_summary/incoming_count"];
  assert.ok(questionProfileIssues(answer, s.input).length);
});

test("local predicate binding preserves conditional scope and adversative boundaries", () => {
  const s = fixture();
  assert.deepEqual(profileFactRules("Если кредитный продукт не отмечен и лизинг отмечен, уточнить профиль.", s.input), []);
  assert.ok(profileFactRules("Если кредитный продукт не отмечен, уточнить профиль, но лизинг отмечен.", s.input)
    .includes("Product mark contradicts the snapshot"));
  const claims = [{ kind: "ai", text: "Входящие платежи отсутствуют, исходящие платежи наблюдаются.", profile_paths: paymentPaths }];
  assert.deepEqual(questionProfileIssues({ answer: "Если входящие платежи наблюдаются и исходящие платежи отсутствуют, уточнить данные.", claims, claim_indexes: [0] }, s.input), []);
  assert.ok(questionProfileIssues({ answer: "Если входящие платежи наблюдаются, уточнить данные, но исходящие платежи отсутствуют.", claims, claim_indexes: [0] }, s.input).length);
});

test("D3: similar facts with a changed year, value, negation or entity are distinct", () => {
  const text = "В опубликованном сообщении министерство указало предварительный план развития транспортной инфраструктуры и дорожного строительства на 2026 год.";
  const pairs = [
    [text, text.replace("2026", "2027")],
    [text, text.replace("министерство", "правительство")],
    [text, text.replace("указало", "не указало")],
    [text.replace("2026", "-1"), text.replace("2026", "1")],
    [text.replace("2026", "15%"), text.replace("2026", "15")],
    [text.replace("министерство", "компания Альфа"), text.replace("министерство", "компания Бета")],
  ];
  for (const pair of pairs) assert.deepEqual(generationBudgetIssues({ claims: pair.map(text => ({ kind: "fact", text })) }), [], pair.join("\n"));
});

test("exact, punctuation and discourse-only near repetitions still trigger compact rebuild", () => {
  const text = "В опубликованном сообщении министерство указало предварительный план развития транспортной инфраструктуры и дорожного строительства на 2026 год.";
  for (const repeat of [text, text.replace(/\.$/, "!"), "Также " + text, text.replace("указало", "также указало")])
    assert.deepEqual(generationBudgetIssues({ claims: [{ kind: "fact", text }, { kind: "fact", text: repeat }] }).map(i => i.rule), ["Repeated claim text"]);
});

test("D1–D3 pass prepared generation on the first attempt without a repair", async () => {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const directory = mkdtempSync(resolve(ROOT, "var/validator-scopes-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test-only-secret" }), dbPath: resolve(directory, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  try {
    const scenarios: { s: ReturnType<typeof fixture>; d: Json }[] = [];
    for (const [text, paths] of [["Кредитный продукт отмечен и лизинг не отмечен.", productPaths],
      ["Входящие платежи отсутствуют, исходящие платежи наблюдаются.", paymentPaths]] as const) {
      const s = fixture(), d = draft(s, text, paths);
      scenarios.push({ s, d });
    }
    const s = fixture(), d = referenceDraft(s);
    const one = "В 2026 году планируется обновление информационной системы для участников рынка, включающее интерфейс подачи заявок, справочники организаций, проверку статуса документов и механизм уведомлений о ходе обработки обращений.";
    const two = one.replace("2026", "2027");
    s.input.event.text += "\n" + one + "\n" + two;
    s.input.event.sources[0].excerpt += "\n" + one + "\n" + two;
    d.claims.push(...[one, two].map(text => ({ kind: "fact", text, quote: text, source_ids: [s.input.event.sources[0].id] })));
    d.summary += "\n" + one + "\n" + two;
    d.grounding.summary = [0, 2, 3];
    scenarios.push({ s, d });
    for (const { s, d } of scenarios) {
      let calls = 0;
      const result = await generatePrepared(settings, db, s.input, "validator-scopes", (async () => {
        calls++;
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(d) } }] });
      }) as typeof fetch);
      assert.equal(calls, 1);
      assert.ok(!result.data.trace.some((step: Json) => step.step === "response_repair"));
    }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
