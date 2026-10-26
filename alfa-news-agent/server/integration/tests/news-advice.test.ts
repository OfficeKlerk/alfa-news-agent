import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { prepareQuestionContext } from "../prepared-agent.js";
import { adviceConstraints } from "../advice-policy.js";
import { groundRateTyping, extractEventDetails } from "../../news-events.js";

// Synthetic adversarial fixtures test validation only; no generated/model-quality result is claimed.
function rateCase() {
  const scenario = evaluationCases()[0], event = scenario.input.event;
  const quote = "Банк России сохранил ключевую ставку на уровне 14%.";
  event.text = event.sources[0].excerpt = quote;
  event.event_details = { direction: "unchanged", magnitude: 0, magnitude_unit: "bps", effective_at: null,
    decision_status: "announced", target_roles: [], target_okved_codes: [],
    evidence: ["direction", "magnitude", "magnitude_unit", "decision_status"]
      .map(field => ({ field, quote, source_ids: [event.sources[0].id] })) };
  return scenario;
}
function savedQuestion(): Json {
  const scenario = rateCase(), context = prepareContext(scenario.input);
  return { company_id: scenario.input.company_id, question: "Какие условия уточнить?", history: [],
    as_of: scenario.input.as_of, audience_role: scenario.input.audience_role, prepared_input: scenario.input,
    analysis: { ...referenceDraft(scenario), id: "saved-analysis", company_id: scenario.input.company_id,
      news_id: scenario.input.event.news_id, created_at: "2026-10-24T00:00:00Z", sources: context.sources,
      mode: "live", trace: [{ step: "prepared_context", detail: "sha256=" + context.sha256 }] } };
}
test("a sourced policy rate cannot be laundered into a company loss, including sections and notes", () => {
  const scenario = rateCase(), context = prepareContext(scenario.input);
  validateGrounding(referenceDraft(scenario), context);
  for (const mutate of [
    (v: Json) => { v.claims[1].text = "При пересмотре договора компания потеряет 14% выручки."; },
    (v: Json) => { v.why_relevant = "Расходы компании увеличатся на 14%."; },
    (v: Json) => { v.recommendations[0] = "Сократить стоимость кредита на 14%."; },
    (v: Json) => { v.missing_data.push("Прогнозируемая прибыль 14%"); },
    (v: Json) => { v.limitations.push("Возможные потери 14%"); },
    (v: Json) => { v.missing_data.push("Ожидается результат 987654"); },
  ]) { const draft = referenceDraft(scenario); mutate(draft); assert.throws(() => validateGrounding(draft, context)); }
});
test("follow-up keeps exact quoted rate but blocks reusing it as an AI return", () => {
  const scenario = rateCase(), context = prepareContext(scenario.input), draft = referenceDraft(scenario);
  const answer = { answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1],
    limitations: draft.limitations, missing_data: draft.missing_data };
  validateQuestionGrounding(answer, context);
  answer.answer += " Доход компании вырастет на 14%.";
  assert.throws(() => validateQuestionGrounding(answer, context), /financial figures/);
});
test("recommendation conditions and missing inputs must be linked, not decorative references", () => {
  const scenario = evaluationCases()[0], context = prepareContext(scenario.input);
  const wrongCondition = referenceDraft(scenario); wrongCondition.grounding.recommendations[0].condition = "Если в новостях есть любые изменения";
  assert.throws(() => validateGrounding(wrongCondition, context), /condition and required data/);
  const hiddenData = referenceDraft(scenario); hiddenData.grounding.recommendations[0].required_data = ["Валюта договора"];
  assert.throws(() => validateGrounding(hiddenData, context), /condition and required data/);
});
test("rate hold and known target mismatch restrict output; score alone does not establish applicability", () => {
  const held = rateCase(), context = prepareContext(held.input), draft = referenceDraft(held);
  assert.equal(adviceConstraints(held.input).review_mode, "monitoring_only");
  draft.risks = ["Новый шок стоимости финансирования."]; draft.grounding.risks = [[1]];
  assert.throws(() => validateGrounding(draft, context), /review only/);
  const unrelated = evaluationCases()[2];
  unrelated.input.ranked_item.score_kind = "manual_feature_baseline";
  unrelated.input.ranked_item.score = 3.2; // A high arbitrary score cannot override the typed mismatch.
  unrelated.input.ranked_item.feature_contributions = [{ feature: "industry_subject_mismatch", value: 1,
    coefficient: 0, contribution: 0, scale: "raw_score", profile_paths: ["/industry/okved_code"], source_ids: [] }];
  assert.equal(adviceConstraints(unrelated.input).review_mode, "applicability_check");
  const bad = referenceDraft(unrelated); bad.opportunities = ["Срочно приобрести новый банковский продукт"]; bad.grounding.opportunities = [[1]];
  assert.throws(() => validateGrounding(bad, prepareContext(unrelated.input)), /review only/);
  unrelated.input.ranked_item.feature_contributions.push({ ...unrelated.input.ranked_item.feature_contributions[0], feature: "graph_in_share", value: 0.2 });
  assert.equal(adviceConstraints(unrelated.input).review_mode, "indirect_exposure_check");
  delete unrelated.input.ranked_item.feature_contributions; unrelated.input.ranked_item.score = 0;
  assert.equal(adviceConstraints(unrelated.input).review_mode, "conditional_review");
});
test("an under-typed rate hold is grounded from its quoted evidence, not trusted as typed, before guardrails run", () => {
  // The live run reported a confirmed rate hold arriving as event_type "other"
  // with no direction, which let a draft invent a rate increase. prepareContext
  // must re-derive the typing from the source text so monitoring_only engages.
  const scenario = rateCase();
  const event = scenario.input.event;
  const quote = event.sources[0].excerpt as string; // "Банк России сохранил ключевую ставку..."
  event.event_type = "other";
  event.event_details = { direction: "unknown", magnitude: null, magnitude_unit: "unknown", effective_at: null,
    decision_status: "unknown", target_roles: [], target_okved_codes: [], evidence: [] };
  const context = prepareContext(scenario.input);
  assert.equal(context.input.event.event_type, "rate_change");
  assert.equal(context.input.event.event_details.direction, "unchanged");
  assert.equal(context.input.event.event_details.magnitude, 0);
  assert.equal(adviceConstraints(context.input).review_mode, "monitoring_only");
  assert.ok(adviceConstraints(context.input).no_new_risk_or_opportunity);
  // Grounded evidence must still quote the source exactly, and the quote carries 14%.
  assert.ok(context.input.event.event_details.evidence.every((row: Json) => quote.includes(row.quote)));
  // A draft that invents a shock on the normalized hold is rejected.
  const draft = referenceDraft(scenario);
  draft.risks = ["Новое повышение ставки удорожает финансирование."]; draft.grounding.risks = [[1]];
  assert.throws(() => validateGrounding(draft, context), /review only/);
});
test("grounding a rate hold leaves non-rate events untouched (no over-classification)", () => {
  const park = evaluationCases()[2]; // "unrelated_region", a regional_event about a municipal park
  assert.equal(groundRateTyping(park.input.event).event_type, "regional_event");
  // An already-typed hold is trusted as-is (idempotent, no duplicate evidence rows).
  const held = rateCase().input.event;
  const before = JSON.stringify(held);
  assert.equal(JSON.stringify(groundRateTyping(held)), before);
});
test("a rate hold by an unspecified regulator is typed unchanged so no shock is invented, without attributing the CBR", () => {
  // demo-rate from data/demo_news.json: "регулятор сохраняет ключевую ставку" — no
  // quotable issuer. It must still engage monitoring_only (TEAM_TASKS2 #3), while the
  // strict CBR path and directional abstention stay intact.
  const quote = "Синтетический сценарий: регулятор сохраняет ключевую ставку, а неопределённость относительно сроков её изменения остаётся высокой.";
  const scenario = rateCase();
  const event = scenario.input.event;
  event.text = event.sources[0].excerpt = quote;
  event.event_type = "other";
  event.event_details = { direction: "unknown", magnitude: null, magnitude_unit: "unknown", effective_at: null,
    decision_status: "unknown", target_roles: [], target_okved_codes: [], evidence: [] };
  const context = prepareContext(scenario.input);
  assert.equal(context.input.event.event_type, "rate_change");
  assert.equal(context.input.event.event_details.direction, "unchanged");
  assert.equal(adviceConstraints(context.input).review_mode, "monitoring_only");
  assert.ok(adviceConstraints(context.input).no_new_risk_or_opportunity);
  // Evidence quotes the source and names no central bank — nothing is attributed to the CBR.
  const rows = context.input.event.event_details.evidence;
  assert.ok(rows.length && rows.every((r: Json) => quote.includes(r.quote) && !/банк россии|цб/i.test(r.quote)));
  // A draft that invents a rate shock on this hold is rejected.
  const draft = referenceDraft(scenario);
  draft.risks = ["Сохранение ставки удорожает обслуживание лизинга."]; draft.grounding.risks = [[1]];
  assert.throws(() => validateGrounding(draft, context), /review only/);
});
test("the unspecified-regulator hold stays conservative: directional moves and non-rate text are not reclassified", () => {
  const src = (excerpt: string) => ({ event_type: "other", sources: [{ id: "s", excerpt }] });
  // A raise by an unspecified actor is NOT turned into unchanged (no fabricated direction, no CBR).
  const raise = extractEventDetails(src("Регулятор повысил ключевую ставку до 16%."));
  assert.notEqual(raise.event_details?.direction, "unchanged");
  // A strict CBR hold is still fully typed (regression).
  const cbr = extractEventDetails(src("Совет директоров Банка России сохранил ключевую ставку 14%."));
  assert.equal(cbr.event_type, "rate_change");
  assert.equal(cbr.event_details.direction, "unchanged");
  assert.equal(cbr.event_details.decision_status, "announced");
  // A commercial bank's deposit-rate hold is not a key-rate decision.
  const deposit = extractEventDetails(src("Банк сохранил ставку по вкладам на прежнем уровне."));
  assert.notEqual(deposit.event_type, "rate_change");
});
test("unknown direction, forecast, disputed facts and absent product flags retain uncertainty", () => {
  const input = evaluationCases()[3].input;
  assert.equal(adviceConstraints(input).review_mode, "needs_event_details");
  assert.ok(adviceConstraints(input).missing_financing_flags.includes("loan"));
  assert.ok(!adviceConstraints(input).financing_products_marked.includes("loan"));
  input.profile.bank_products.loan = false;
  assert.ok(!adviceConstraints(input).missing_financing_flags.includes("loan"));
  input.event.event_details = { decision_status: "forecast", direction: "decrease" };
  assert.equal(adviceConstraints(input).review_mode, "scenario_only");
  input.event.fact_status = "disputed";
  assert.equal(adviceConstraints(input).review_mode, "source_verification");
});
test("live follow-up revalidates original company, event, ranking, time, source registry and hash", () => {
  const input = savedQuestion(), context = prepareQuestionContext(input);
  assert.deepEqual(context.input.ranked_item, input.prepared_input.ranked_item);
  assert.equal(context.input.event.event_details.direction, "unchanged");
  for (const mutate of [
    (v: Json) => { delete v.prepared_input; },
    (v: Json) => { v.company_id = "U_OTHER"; },
    (v: Json) => { v.analysis.company_id = "U_OTHER"; },
    (v: Json) => { v.prepared_input.profile.company_id = "U_OTHER"; },
    (v: Json) => { v.analysis.news_id = "other-news"; },
    (v: Json) => { v.as_of = "2026-10-24T00:00:00Z"; },
    (v: Json) => { v.prepared_input.as_of = "2026-10-24T00:00:00Z"; v.as_of = v.prepared_input.as_of; },
    (v: Json) => { v.prepared_input.ranked_item.score = 0.1; },
    (v: Json) => { v.analysis.sources[0].excerpt = v.analysis.sources[0].excerpt.replace(v.company_id, "U_OTHER"); },
    (v: Json) => { v.analysis.sources.push(v.analysis.sources[0]); },
    (v: Json) => { v.analysis.trace = []; },
    (v: Json) => { v.prepared_input.research.items[0].published_at = "2027-01-01T00:00:00Z"; },
    (v: Json) => { v.analysis.sources.find((s: Json) => s.kind === "bank").published_at = "2027-01-01T00:00:00Z"; },
    (v: Json) => { v.prepared_input.research.items[0].published_at = null; },
    (v: Json) => { v.history = Array.from({ length: 11 }, () => ({ question: "Q", answer: "A" })); },
  ]) { const value = structuredClone(input); mutate(value); assert.throws(() => prepareQuestionContext(value)); }
});
