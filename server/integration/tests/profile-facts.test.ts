import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { profileFacts, profileFactRules } from "../profile-facts.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { responseGuidance } from "../repair-guidance.js";
import { generatePrepared } from "../prepared-agent.js";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";

function fixture(loan: boolean | null = false) {
  const scenario = evaluationCases()[0];
  Object.assign(scenario.input.profile.bank_products, { loan, leasing: true });
  Object.assign(scenario.input.profile.foreign_trade, { has_fts: false, trade_direction: null, currencies: null });
  Object.assign(scenario.input.profile.payment_summary, { currency: null, period: null });
  return scenario;
}

test("profile guidance retains false, null and a known zero without inventing contracts", () => {
  const s = fixture(null);
  s.input.profile.payment_summary.incoming_amount = 0;
  s.input.profile.payment_summary.outgoing_amount = null;
  const facts = profileFacts(s.input);
  assert.equal(facts.products.find(p => p.path.endsWith("loan"))!.state, "unknown");
  assert.equal(facts.products.find(p => p.path.endsWith("leasing"))!.state, "marked_in_snapshot");
  assert.equal(facts.payments.incoming_amount, 0);
  assert.equal(facts.payments.outgoing_amount, null);
  assert.equal(facts.trade.has_fts, false);
  assert.deepEqual(responseGuidance(prepareContext(s.input), "").profile_facts, facts);
});

test("false product mark cannot prove absence of debt, and true cannot prove a contract", () => {
  const s = fixture();
  for (const text of [
    "У компании нет долгов.", "У компании отсутствуют кредиты с плавающей ставкой.",
    "В профиле loan=false, поэтому компания не имеет кредитов.",
    "Компания использует лизинг.", "Компания имеет кредит с плавающей ставкой.",
    "Договоры лизинга предусматривают плавающую ставку.",
  ]) assert.ok(profileFactRules(text, s.input).includes("Product flags do not establish debt or contract terms"), text);
  for (const text of [
    "Кредитный продукт не отмечен в снимке.", "В профиле отмечен продукт лизинга.",
    "Отсутствие отметки не означает, что у компании нет долгов.",
    "Наличие кредитных обязательств неизвестно.", "Если компания использует лизинг, нужно уточнить договоры.",
    "Проверить, имеет ли компания кредит с плавающей ставкой.",
  ]) assert.deepEqual(profileFactRules(text, s.input), [], text);
});

test("null loan flag cannot become either true or false", () => {
  const s = fixture(null);
  for (const text of ["loan=false", "loan=true", "Кредитный продукт не отмечен.", "Кредитный продукт отмечен."])
    assert.ok(profileFactRules(text, s.input).includes("Unknown product flag must remain unknown"), text);
  assert.deepEqual(profileFactRules("Наличие кредитного продукта неизвестно; уточнить обязательства.", s.input), []);
  s.input.profile.bank_products.leasing = null;
  assert.ok(profileFactRules("leasing=false", s.input).includes("Unknown product flag must remain unknown"));
  assert.ok(profileFactRules("Продукт лизинга отмечен.", s.input).includes("Unknown product flag must remain unknown"));
});

test("FTS and countries do not establish trade direction or absence of currency payments", () => {
  for (const has_fts of [false, true, null]) {
    const s = fixture(); Object.assign(s.input.profile.foreign_trade, { has_fts, countries: ["КИТАЙ"] });
    for (const text of ["У компании отсутствуют валютные платежи.", "У компании нет валютных операций.",
      "Компания импортирует оборудование из Китая.", "Компания является экспортёром."])
      assert.ok(profileFactRules(text, s.input).includes("Trade flags do not establish direction or payment currency"), text);
    for (const text of ["Направление внешней торговли и валюты неизвестны.",
      "Если компания импортирует оборудование, нужно уточнить маршруты.",
      "has_fts=false не доказывает, что у компании нет валютных платежей."])
      assert.deepEqual(profileFactRules(text, s.input), [], text);
  }
});

test("unknown payment metadata is not rubles, a year or zero; a known zero stays valid", () => {
  const s = fixture();
  s.input.profile.payment_summary.incoming_amount = null;
  for (const text of ["Платежи осуществляются в рублях.", "Расчеты идут только в долларах.",
    "Годовые поступления требуют проверки.", "Входящие платежи равны нулю."])
    assert.ok(profileFactRules(text, s.input).includes("Unknown payment metadata must remain unknown"), text);
  s.input.profile.payment_summary.incoming_amount = 0;
  assert.deepEqual(profileFactRules("Входящие платежи равны нулю.", s.input), []);
  s.input.profile.payment_summary.currency = "RUB";
  assert.deepEqual(profileFactRules("Платежи осуществляются в рублях.", s.input), []);
});

test("profile interpretation guards apply to sections, claims, notes and questions", () => {
  const s = fixture(), context = prepareContext(s.input);
  const bad = "У компании нет долгов.";
  for (const mutate of [
    (d: Json) => { d.claims[1].text = bad; }, (d: Json) => { d.why_relevant = bad; },
    (d: Json) => { d.summary = bad; }, (d: Json) => { d.limitations.push(bad); },
    (d: Json) => { d.missing_data.push(bad); }, (d: Json) => { d.recommendations[0] = bad; },
  ]) {
    const d = referenceDraft(s); mutate(d);
    assert.throws(() => validateGrounding(d, context), /Product flags do not establish/);
  }
  const d = referenceDraft(s);
  assert.throws(() => validateQuestionGrounding({ answer: bad, claims: d.claims,
    claim_indexes: [0, 1], limitations: d.limitations, missing_data: d.missing_data }, context), /Product flags do not establish/);
});

test("verbatim source quotes remain quotes instead of being reinterpreted as CSV flags", () => {
  const s = fixture(), quote = "Компания использует лизинг по опубликованному сообщению.";
  s.input.event.sources[0].excerpt = s.input.event.text = quote;
  const d = referenceDraft(s);
  validateGrounding(d, prepareContext(s.input));
});

for (const format of ["json_object", "json_schema"]) {
  test(`${format}: a wrong flag interpretation is repaired with explicit instructions within two calls`, async () => {
    mkdirSync(resolve(ROOT, "var"), { recursive: true });
    const directory = mkdtempSync(resolve(ROOT, "var/profile-facts-test-"));
    const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test-only-secret", LLM_RESPONSE_FORMAT: format }),
      dbPath: resolve(directory, "calls.sqlite3") };
    const db = new Store(settings);
    db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
    let calls = 0;
    try {
      const s = fixture();
      const result = await generatePrepared(settings, db, s.input, "profile-facts", (async (_url, init) => {
        calls++; const payload = JSON.parse(String(init?.body));
        assert.ok(JSON.parse(payload.messages[1].content).response_guidance.profile_facts);
        const d = referenceDraft(s);
        if (calls === 1) d.claims[1].text = d.why_relevant = "У компании отсутствуют кредиты с плавающей ставкой.";
        else {
          const repair = JSON.parse(payload.messages.at(-1).content);
          assert.ok(repair.repair_rules.some((r: Json) => r.rule === "Product flags do not establish debt or contract terms" && r.instruction.includes("loan=false")));
        }
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(d) } }] });
      }) as typeof fetch);
      assert.equal(calls, 2); assert.ok(result.data.trace.some((x: Json) => x.step === "response_repair"));
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}


test("explicit product marks cannot contradict known true and false snapshot values", () => {
  const s = fixture(false);
  for (const text of ["loan=true", "loan=1", "Кредитный продукт отмечен.", "leasing=false", "Продукт лизинга не отмечен."])
    assert.ok(profileFactRules(text, s.input).includes("Product mark contradicts the snapshot"), text);
  for (const text of ["loan=false", "loan=0", "Кредитный продукт не отмечен.", "leasing=true", "Продукт лизинга отмечен."])
    assert.deepEqual(profileFactRules(text, s.input), [], text);
});
