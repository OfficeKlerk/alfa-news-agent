import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";
import { prepareContext } from "./context.js";
import { analysisDraft, validateGrounding } from "./grounding.js";

export interface EvaluationCase { id: string; input: Json; expectations: string[]; comparison_group?: string }
export const REVIEW_CRITERIA = ["company_context", "causal_reasoning", "source_support", "conditional_actions", "uncertainty"];
export function evaluationCases(): EvaluationCase[] {
  const profile = JSON.parse(readFileSync(resolve(ROOT, "contracts/v1/examples/profile-response.json"), "utf8")).data;
  const event = JSON.parse(readFileSync(resolve(ROOT, "integration/fixtures/events.json"), "utf8"))[0];
  const research = JSON.parse(readFileSync(resolve(ROOT, "integration/fixtures/research.json"), "utf8"));
  const input = { company_id: profile.company_id, profile, event, as_of: "2026-10-23T00:00:00Z", audience_role: "cfo", is_mock: true,
    ranked_item: { news_id: event.news_id, event_id: event.event_id, score: 0.8, score_kind: "mock",
      reasons: [{ code: "fixture", text: "Учебный признак финансирования", profile_paths: ["/bank_products/loan"] }], warnings: ["synthetic_evaluation"] },
    research: { items: research.slice(0, 1), limitations: ["Синтетические сценарии оценки, не банковская аналитика и не human gold."] } };
  const borrower: EvaluationCase = { id: "rate_borrower", input, comparison_group: "same_rate_event",
    expectations: ["Отметить loan=true, но не придумывать остаток долга и плавающую ставку.", "Отделить возможное удорожание будущего финансирования от уже подтверждённого эффекта."] };
  const depositor = structuredClone(borrower); depositor.id = "rate_nonborrower";
  depositor.input.company_id = depositor.input.profile.company_id = "U_RATE_B";
  depositor.input.profile.bank_products.loan = false; depositor.input.profile.bank_products.deposit = true;
  depositor.input.profile.provenance.company_raw_fields.SYNTHETIC_U = "U_RATE_B";
  depositor.input.profile.provenance.company_raw_fields.CL_PRODUCT_LOA_MARK = "0.0";
  depositor.input.profile.provenance.company_raw_fields.CL_PRODUCT_DEP_MARK = "1.0";
  depositor.input.profile.relevance_signals = [];
  depositor.input.ranked_item.reasons = [{ code: "fixture", text: "Кредит не отмечен; депозит отмечен", profile_paths: ["/bank_products/loan", "/bank_products/deposit"] }];
  depositor.expectations = ["Не приписывать действующий кредит при loan=false.", "Ответ должен отличаться от rate_borrower по подтверждённой экспозиции, без обещания доходности."];
  const unrelated = structuredClone(borrower); unrelated.id = "unrelated_region"; delete unrelated.comparison_group;
  unrelated.input.event = { ...structuredClone(event), news_id: "unrelated", event_id: "unrelated", title: "Учебное открытие парка в другом регионе",
    text: "Синтетическое событие: в Калининградской области открыли муниципальный парк.", event_type: "regional_event", okved_divisions: [], regions: ["Калининградская область"] };
  unrelated.input.event.sources = [{ ...event.sources[0], id: "news:unrelated", title: unrelated.input.event.title, excerpt: unrelated.input.event.text }];
  Object.assign(unrelated.input.ranked_item, { news_id: "unrelated", event_id: "unrelated", score: 0,
    reasons: [{ code: "fixture", text: "Подтверждённая экспозиция отсутствует", profile_paths: ["/geography/region"] }] });
  unrelated.expectations = ["Сказать, что связь с бизнесом не подтверждена предоставленными данными.", "Не выдумывать риск, договор или необходимость банковского продукта ради заполнения раздела."];
  const incomplete = structuredClone(borrower); incomplete.id = "incomplete_profile"; delete incomplete.comparison_group;
  incomplete.input.profile.bank_products.loan = null; incomplete.input.profile.provenance.company_raw_fields.CL_PRODUCT_LOA_MARK = null;
  incomplete.input.profile.relevance_signals = [];
  incomplete.expectations = ["Не превращать неизвестное наличие кредита в true или false.", "Явно запросить наличие обязательств, тип ставки и сроки переоценки; ограничить уверенность."];
  const noRag = structuredClone(borrower); noRag.id = "no_rag"; delete noRag.comparison_group; noRag.input.research.items = [];
  noRag.expectations = ["Не выдавать свои выводы за позицию банка.", "Сообщить об отсутствии банковских материалов; не создавать bank-цитаты."];
  return [borrower, depositor, unrelated, incomplete, noRag];
}

/** Reference output written by developers. It verifies the pipeline, not the quality of an external LLM. */
export function referenceDraft(test: EvaluationCase): Json {
  const input = test.input, source = input.event.sources[0], loan = input.profile.bank_products.loan;
  const unrelated = test.id === "unrelated_region";
  const text = unrelated ? "Связь открытия парка с бизнесом компании не подтверждена предоставленными данными."
    : loan === true ? "Кредитный продукт отмечен в профиле. Влияние на стоимость обслуживания зависит от условий ставки договора."
    : loan === false ? "Кредитный продукт не отмечен. Подтверждённого действующего кредита из этого профиля не следует."
    : "Наличие кредита неизвестно. Влияние ставки на обязательства компании пока не подтверждено.";
  const paths = unrelated ? ["/geography/region"] : ["/bank_products/loan"];
  const condition = unrelated ? "Если география фактических операций не связана с местом события" : "Если договоры компании предусматривают изменение ставки";
  const missing = loan === null ? ["Наличие кредитных обязательств", "Тип ставки и сроки переоценки"] : ["Условия договоров"];
  return { summary: source.excerpt, why_relevant: text,
    claims: [{ kind: "fact", text: source.excerpt, quote: source.excerpt, source_ids: [source.id] },
      { kind: "ai", text, quote: "", source_ids: ["company:" + input.company_id, source.id], profile_paths: paths, conditions: [condition] }],
    risks: [], opportunities: [], recommendations: unrelated ? [] : ["Уточнить договорную экспозицию компании"],
    limitations: ["Условия договоров и причинное влияние не подтверждены.", ...(!input.research.items.length ? ["Банковские материалы отсутствуют."] : [])],
    missing_data: missing, grounding: { summary: [0], why_relevant: [1], risks: [], opportunities: [],
      recommendations: unrelated ? [] : [{ claim_indexes: [1], condition, required_data: missing }] } };
}
export function evaluateResult(test: EvaluationCase, analysis: Json) {
  validateGrounding(analysisDraft(analysis), prepareContext(test.input), true);
  return { case_id: test.id, comparison_group: test.comparison_group ?? null, mechanical_checks: "passed",
    semantic_review: "pending", expectations: test.expectations,
    review: Object.fromEntries(REVIEW_CRITERIA.map(key => [key, { score: null, evidence: "" }])),
    input: test.input, analysis };
}
