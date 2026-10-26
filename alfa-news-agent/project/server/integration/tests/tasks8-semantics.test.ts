import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding } from "../grounding.js";
import { cautiousLanguageRules } from "../cautious-language.js";
import { claimProfileRules, claimProfileSuggestions } from "../claim-profile-grounding.js";
import { generatePrepared } from "../prepared-agent.js";
import { generationBudgetIssues } from "../generation-budget.js";
import { generatedResponseSchema } from "../response-schema.js";
import { industryWording, repairInstruction, repairPlan, responseGuidance } from "../repair-guidance.js";
import { ANALYSIS_PROMPT } from "../analysis-prompts.js";
import { FORECAST_PAGE, FORECAST_QUOTE, withForecastResearch } from "../bank-forecast-case.js";

// TASKS8: REPORT8 answers that passed every check with a wrong meaning, as paired reject/allow regressions.
// Rejected strings are verbatim from tasks8-live / tasks8-rerun drafts; allowed strings are the corrected forms.
const rules = (text: string, input: Json) => cautiousLanguageRules(text, input);
const withProducts = (values: Json) => { const s = evaluationCases()[0]; Object.assign(s.input.profile.bank_products, values); return s; };
const allNull = { rko: null, guarantee: null, loan: null, leasing: null, deposit: null, payroll: null, factoring: null };

test("REPORT8 null control: null described as «отсутствие отметки» is rejected in conditions and limitations", () => {
  const s = withProducts(allNull);
  // rerun call-13 condition and limitation (rate-hold-unknown-products-control).
  for (const text of ["Если в снимке профиля null означает отсутствие отметки продукта, а не доказанное отсутствие всех долгов",
    "Отсутствие отметки о кредитных продуктах в профиле не доказывает отсутствие обязательств",
    "В профиле отсутствуют отметки кредитных продуктов", "В профиле не отмечены кредитные продукты, что не доказывает отсутствие обязательств"])
    assert.ok(rules(text, s.input).includes("Unknown product flag must remain unknown"), text);
  // The accepted claim of the same answer, and corrected wording, stay allowed.
  for (const text of ["В профиле компании U_100043 отсутствуют подтверждённые данные о наличии действующих кредитных продуктов (loan, leasing, factoring).",
    "Значение null не означает отсутствие отметки продукта: наличие кредитных продуктов неизвестно.",
    "Отметки кредитных продуктов неизвестны (null), а не отсутствуют.",
    "Отсутствие данных об отметке кредитных продуктов не доказывает отсутствие обязательств.",
    "Если в снимке отсутствуют отметки продуктов кредитования, лизинга и факторинга, потребуется проверка.",
    "Если бы null означал отсутствие отметки, вывод был бы другим, но это не так."])
    assert.deepEqual(rules(text, s.input), [], text);
  // The same limitation is correct when the marks are a known false.
  assert.deepEqual(rules("Отсутствие отметки о кредитных продуктах в профиле не доказывает отсутствие обязательств",
    withProducts({ ...allNull, loan: false }).input), []);
});

test("REPORT8 null control: the whole saved answer shape is rejected through validateGrounding", () => {
  const s = withProducts(allNull), context = prepareContext(s.input), d = referenceDraft(s);
  d.claims[1].text = d.why_relevant = "В профиле компании отсутствуют подтверждённые данные о наличии действующих кредитных продуктов (loan, leasing, factoring).";
  d.claims[1].profile_paths = ["/bank_products/loan", "/bank_products/leasing", "/bank_products/factoring"];
  d.missing_data = ["Условия договоров, если они есть"]; d.grounding.recommendations[0].required_data = d.missing_data;
  validateGrounding(d, context, false, true);
  d.claims[1].conditions = [d.grounding.recommendations[0].condition = "Если в снимке профиля null означает отсутствие отметки продукта, а не доказанное отсутствие всех долгов"];
  assert.throws(() => validateGrounding(d, context, false, true), (e: Json) => e.diagnostics.issues.some((i: Json) =>
    i.path === "/claims/1/conditions/0" && i.rule === "Unknown product flag must remain unknown"));
});

test("REPORT8 metal-borrower: a product mark read as usage is rejected; the mark itself is allowed", () => {
  const s = withProducts({ loan: true, leasing: true });
  for (const text of ["Компания U_23929 осуществляет производство профилей с помощью холодной штамповки или гибки (ОКВЭД 24.33) и использует продукты финансирования (loan, leasing).",
    "Компания использует лизинг.", "Компания пользуется кредитными продуктами банка."])
    assert.ok(rules(text, s.input).includes("Product flags do not establish debt or contract terms"), text);
  for (const text of ["В снимке профиля отмечены продукты лизинга и кредита, но наличие действующих договоров и их условия не установлены.",
    "В снимке отмечены продукты финансирования (loan, leasing); их использование и действующие договоры не подтверждены.",
    "Компания имеет отметку о продукте лизинга, что формирует потенциальный канал влияния, если действующий договор существует.",
    "Если компания использует лизинг с плавающей ставкой, стоимость обслуживания может измениться."])
    assert.deepEqual(rules(text, s.input), [], text);
});

test("REPORT8 rate-up-borrower-no-rag: «действующих кредитов» and «параметры действующих договоров» presume contracts", () => {
  const s = withProducts({ loan: true, leasing: true });
  for (const text of ["Увеличение стоимости обслуживания действующих кредитов и лизинговых обязательств при наличии плавающей ставки.",
    "Однако параметры действующих договоров и их условия не установлены, поэтому прямое влияние повышения ставки на финансовые результаты компании не подтверждено.",
    "Типы ставок по действующим договорам"])
    assert.ok(rules(text, s.input).includes("Product flags do not establish debt or contract terms"), text);
  for (const text of ["Наличие действующих договоров и их условия не установлены.",
    "Потенциальный канал, если действующий договор существует и его условия чувствительны к ставке.",
    "Условия действующих договоров, если они есть", "В снимке отмечен продукт лизинга; действующий договор и остаток неизвестны.",
    "Стоимость обслуживания обязательств компании может измениться, если действующие договоры привязаны к ключевой ставке."])
    assert.deepEqual(rules(text, s.input), [], text);
});

test("REPORT8 trade-foreign: an FTS mark is not activity, and «отметка о внешней торговле» needs /foreign_trade/has_fts", () => {
  const s = evaluationCases()[0];
  for (const text of ["Компания осуществляет внешнеторговую деятельность, но конкретные маршруты и поставщики не раскрыты", "Компания занимается внешней торговлей."])
    assert.ok(rules(text, s.input).includes("Trade flags do not establish direction or payment currency"), text);
  for (const text of ["В снимке есть отметка ФТС; внешнеторговая деятельность и её направление не подтверждены.",
    "Если компания осуществляет импорт оборудования по маршруту, упомянутому в новости"])
    assert.deepEqual(rules(text, s.input), [], text);
  // rerun call-04 claim 1: direction and currency paths are present, the mark path is not.
  const claim = { kind: "ai", text: "Компания имеет отметку о внешней торговле, однако направление торговли и валюты операций неизвестны. Связь с новостью не подтверждена предоставленными данными.",
    quote: "", source_ids: ["company:U_A", "news:demo-rate"], profile_paths: ["/foreign_trade/trade_direction", "/foreign_trade/currencies"],
    conditions: ["Если компания осуществляет импорт оборудования по маршруту, упомянутому в новости"] };
  assert.deepEqual(claimProfileRules(claim, s.input), ["Profile claim assertion needs matching profile path"]);
  assert.deepEqual(claimProfileSuggestions(claim, s.input), ["/foreign_trade/has_fts"]);
  assert.deepEqual(claimProfileRules({ ...claim, profile_paths: ["/foreign_trade/has_fts", ...claim.profile_paths] }, s.input), []);
  for (const text of ["Отмечена внешнеэкономическая деятельность.", "Есть флаг ВЭД в снимке."])
    assert.deepEqual(claimProfileSuggestions({ ...claim, text }, s.input), ["/foreign_trade/has_fts"], text);
});

test("REPORT8 rate-hold-no-financing: a copied prompt rule is rejected; a concrete channel is allowed", () => {
  const s = evaluationCases()[0];
  for (const text of ["Связь с контрагентом допускает только условный косвенный канал.", "См. response_guidance.industry_wording."])
    assert.ok(rules(text, s.input).includes("Prompt rule copied into the answer"), text);
  for (const text of ["Канал через контрагентов не подтверждён: нужно проверить договоры с крупнейшими получателями платежей.",
    "Связь не подтверждена предоставленными данными."])
    assert.deepEqual(rules(text, s.input), [], text);
  // v13 rewrote the copied sentences as instructions; none of them is left in the prompt verbatim.
  for (const copied of ["Связь с контрагентом допускает только условный косвенный канал", "Дата публикации не является датой вступления в силу",
    "Принятие программы разработки не равно принятию стандарта"]) assert.ok(!ANALYSIS_PROMPT.includes(copied), copied);
});

test("REPORT8 rate-up-borrower: Unused claim repair names the indexes, the renumbering and the industry-only claim", () => {
  const s = evaluationCases()[0], d = referenceDraft(s);
  // rerun call-08 shape: fact, two product claims, one industry-only claim; why_relevant uses only claim 1.
  d.claims.push({ ...d.claims[1], text: "В снимке отмечен продукт кредита. Потенциальный канал, если действующий договор существует и его условия чувствительны к ставке." },
    { ...d.claims[1], text: industryWording(s.input).use, profile_paths: ["/industry/okved_code"] });
  const issues = ["/claims/2", "/claims/3"].map(path => ({ stage: "grounding" as const, path, rule: "Unused claim" }));
  const plan = repairPlan(issues, d, false, { input: s.input });
  assert.equal(plan.mode, "targeted_fix");
  assert.deepEqual(plan.unused_claims.indexes, [2, 3]);
  assert.deepEqual(plan.unused_claims.delete_renumber, { 0: 0, 1: 1 });
  assert.deepEqual(plan.unused_claims.prefer_delete, [3]);
  assert.match(plan.unused_claims.actions.join(" "), /why_relevant/);
  // Applying the "delete" action yields a draft that passes the unchanged validators.
  const fixed = { ...d, claims: d.claims.slice(0, 2) };
  validateGrounding(fixed, prepareContext(s.input), false, true);
  // A question names claim_indexes instead of grounding sections; no hint without unused claims.
  assert.match(repairPlan(issues, d, true, { input: s.input }).unused_claims.actions[0], /claim_indexes/);
  assert.equal(repairPlan([], d, false, { input: s.input }).unused_claims, undefined);
});

test("REPORT8 rate-hold-leasing call-05: «Too few items» for claims asks for a fact and an ai claim, not one claim", () => {
  assert.match(repairInstruction({ stage: "schema", path: "/claims", rule: "Too few items" }), /минимум два claims.*fact.*ai/s);
  assert.match(repairInstruction({ stage: "schema", path: "/grounding/summary", rule: "Too few items" }), /fact-цитаты/);
  assert.match(ANALYSIS_PROMPT, /Уникальность не означает сокращение до одного claim/);
});

function ledger(env: Record<string, string> = {}) {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/llm-test-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "local-test-secret", LLM_BASE_URL: "https://provider.invalid/v1",
    LLM_MODEL: "qwen/qwen3.6-35b-a3b", LLM_ALLOWED_MODELS_JSON: '["qwen/qwen3.6-35b-a3b"]', LLM_MAX_OUTPUT_TOKENS: "6000", ...env }),
    dbPath: resolve(folder, "calls.sqlite3"), maxCalls: 10, questionReserveCalls: 0, timeout: 1000 };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { settings, db, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
async function firstPayload(env: Record<string, string>) {
  const l = ledger(env), s = evaluationCases()[0]; let payload: Json = {};
  try {
    await generatePrepared(l.settings, l.db, s.input, "cap", (async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(referenceDraft(s)) } }] });
    }) as typeof fetch);
  } finally { l.close(); }
  return payload;
}

test("loop protection: grounded generation is capped below LLM_MAX_OUTPUT_TOKENS, and the cap cannot be overridden", async () => {
  assert.equal((await firstPayload({})).max_tokens, 2500);
  assert.equal((await firstPayload({ LLM_GENERATION_MAX_TOKENS: "1800" })).max_tokens, 1800);
  assert.equal((await firstPayload({ LLM_MAX_OUTPUT_TOKENS: "1000" })).max_tokens, 1000);
  for (const key of ["max_tokens", "max_completion_tokens"]) for (const name of ["LLM_EXTRA_BODY_JSON", "LLM_STRICT_EXTRA_BODY_JSON"])
    assert.throws(() => loadSettings({ LLM_MODE: "live", [name]: JSON.stringify({ [key]: 9000 }) }), new RegExp(name + " не может переопределять " + key));
  // The repetition guard is unchanged: a complete draft with a copied claim still needs a compact rebuild.
  const s = evaluationCases()[0], d = referenceDraft(s); d.claims.push({ ...d.claims[1] });
  assert.deepEqual(generationBudgetIssues(d).map(i => i.rule), ["Repeated claim text"]);
});

test("strict route: LLM_STRICT_EXTRA_BODY_JSON is sent only with json_schema, LLM_EXTRA_BODY_JSON with both", async () => {
  const route = JSON.stringify({ provider: { order: ["DeepInfra"], allow_fallbacks: false } });
  const strict = await firstPayload({ LLM_RESPONSE_FORMAT: "json_schema", LLM_STRICT_EXTRA_BODY_JSON: route, LLM_EXTRA_BODY_JSON: '{"seed":7}' });
  assert.equal(strict.response_format.type, "json_schema");
  assert.deepEqual(strict.provider, { order: ["DeepInfra"], allow_fallbacks: false }); assert.equal(strict.seed, 7);
  const plain = await firstPayload({ LLM_STRICT_EXTRA_BODY_JSON: route, LLM_EXTRA_BODY_JSON: '{"seed":7}' });
  assert.equal(plain.response_format.type, "json_object"); assert.equal(plain.provider, undefined); assert.equal(plain.seed, 7);
  // Unset by default: no unconfirmed provider field reaches a paid request.
  assert.equal((await firstPayload({ LLM_RESPONSE_FORMAT: "json_schema" })).provider, undefined);
});

test("strict schema: optional claim text/quote maxLength is provider-only and off by default", () => {
  const branches = (schema: Json) => schema.properties.claims.items.anyOf;
  for (const branch of branches(generatedResponseSchema("GeneratedAnalysis").schema)) {
    assert.equal(branch.properties.text.maxLength, undefined); assert.equal(branch.properties.quote.maxLength, undefined);
  }
  for (const name of ["GeneratedAnalysis", "GeneratedAnswer"] as const) for (const branch of branches(generatedResponseSchema(name, 1000).schema)) {
    assert.equal(branch.properties.text.maxLength, 1000); assert.equal(branch.properties.quote.maxLength, 1000);
  }
  // The longest saved verbatim quote (846 chars) and every guidance passage (≤900) must still fit.
  assert.throws(() => loadSettings({ LLM_MODE: "live", LLM_STRICT_MAX_CLAIM_STRING: "500" }));
  assert.equal(loadSettings({ LLM_MODE: "live", LLM_STRICT_MAX_CLAIM_STRING: "1000" }).strictMaxClaimString, 1000);
});

test("bank budget: guidance offers one verbatim passage per bank source; ≤3 bank claims must still be verbatim", () => {
  const s = evaluationCases()[0], base = s.input.research.items[0];
  s.input.research.items = [1, 2, 3, 4].map(n => ({ ...base, id: "research:demo-bank:p" + n, document_id: "demo-bank-" + n, page: n,
    url: base.url.replace(/page=\d+/, "page=" + n), excerpt: `Тестовый фрагмент ${n}: условия конкретных договоров нужно уточнить. Это не позиция банка.` }));
  const context = prepareContext(s.input);
  const bank = responseGuidance(context, "local-test-secret").quote_candidates.filter((c: Json) => c.kind === "bank");
  assert.equal(bank.length, 3);
  for (const c of bank) {
    assert.ok(context.sources.find(x => x.id === c.source_id)!.excerpt.includes(c.quote));
    assert.ok(c.published_at && /исторический/.test(c.note));
  }
  const d = referenceDraft(s);
  d.claims.push(...bank.map((c: Json) => structuredClone(c.claim)));
  d.summary = [d.claims[0].quote, ...bank.map((c: Json) => c.quote)].join("\n"); d.grounding.summary = [0, 2, 3, 4];
  validateGrounding(d, context, false, true);
  assert.deepEqual(generationBudgetIssues(d), []);
  // REPORT8 strict answers: within the bank budget, a paraphrased bank quote is still rejected.
  const paraphrased = structuredClone(d); paraphrased.claims[4].text = paraphrased.claims[4].quote = "Банк считает, что условия договоров нужно уточнить.";
  paraphrased.summary = [d.claims[0].quote, d.claims[2].quote, d.claims[3].quote, paraphrased.claims[4].quote].join("\n");
  assert.throws(() => validateGrounding(paraphrased, context, false, true), (e: Json) => e.diagnostics.issues.some((i: Json) =>
    i.path === "/claims/4/quote" && i.rule === "Quote not found in selected evidence"));
  const fourth = structuredClone(d); fourth.claims.push({ ...structuredClone(d.claims[2]), text: "x".repeat(9) });
  assert.ok(generationBudgetIssues(fourth).some(i => i.rule === "Too many bank claims"));
});

test("positive bank case: the dated 11 September forecast of the 23 October meeting can ground a historical bank claim", () => {
  const s = evaluationCases()[0], input = withForecastResearch(s.input), context = prepareContext(input);
  const item = input.research.items[0];
  assert.match(item.id, /:c4200$/); assert.ok(item.excerpt.includes(FORECAST_QUOTE)); assert.ok(item.published_at < input.as_of);
  // REPORT8 used chunk c0 of the same page: it never contained the forecast.
  assert.ok(!JSON.parse(readFileSync(resolve(ROOT, "data/research.json"), "utf8")).find((r: Json) => r.id === FORECAST_PAGE).text.slice(0, 1600).includes(FORECAST_QUOTE));
  const d = referenceDraft({ ...s, input });
  d.claims.push({ kind: "bank", text: FORECAST_QUOTE, quote: FORECAST_QUOTE, source_ids: [item.id] });
  d.summary = d.claims[0].quote + "\n" + FORECAST_QUOTE; d.grounding.summary = [0, 2];
  // The model writes no date it cannot quote; the dated notice comes from research.limitations (FORECAST_LIMITATION).
  d.limitations.push("Банковская цитата — исторический прогноз, сделанный до решения, а не текущая позиция банка.");
  validateGrounding(d, context, false, true);
  assert.deepEqual(generationBudgetIssues(d), []);
  // A paraphrase of the forecast as the bank's current view is still not a verbatim quote.
  const current = structuredClone(d); current.claims[2].text = current.claims[2].quote = "Банк сейчас ожидает сохранения ставки";
  current.summary = d.claims[0].quote + "\n" + current.claims[2].quote;
  assert.throws(() => validateGrounding(current, context, false, true), /Quote not found in selected evidence/);
});
