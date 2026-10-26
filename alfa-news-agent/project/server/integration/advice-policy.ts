import type { Json } from "../types.js";
import { eventInterpretation } from "./event-interpretation.js";

/** Conservative output scope derived from typed event/ranking facts, never from a score threshold.
 * This is a guardrail for a review, not a model of loss or an instruction to transact.
 */
export function adviceConstraints(input: Json) {
  const details = input.event.event_details ?? {}, products = input.profile.bank_products ?? {};
  const values = new Map<string, number>((input.ranked_item?.feature_contributions ?? [])
    .map((row: Json) => [row.feature, row.value]));
  const positive = (names: string[]) => names.some(name => (values.get(name) ?? 0) > 0);
  const direct = positive(["direct_company_match"]);
  const indirect = positive(["related_company_match", "graph_in_share", "graph_out_share"]);
  const mismatch = positive(["industry_target_mismatch", "industry_subject_mismatch", "target_role_mismatch"]);
  const mode = input.event.fact_status === "disputed" ? "source_verification"
    : mismatch && !direct ? indirect ? "indirect_exposure_check" : "applicability_check"
    : input.event.event_type === "rate_change" && details.direction === "unchanged" ? "monitoring_only"
    : details.decision_status === "forecast" ? "scenario_only"
    : input.event.event_type === "rate_change" && (!details.direction || details.direction === "unknown") ? "needs_event_details"
    : "conditional_review";
  return {
    version: "conditional-news-advice-v1", review_mode: mode,
    event_interpretation: eventInterpretation(input),
    no_new_risk_or_opportunity: mode === "applicability_check" || mode === "monitoring_only",
    financing_products_marked: ["loan", "leasing", "factoring"].filter(name => products[name] === true),
    missing_financing_flags: ["loan", "leasing", "factoring"].filter(name => products[name] == null),
    contract_terms_supplied: false,
    rules: ["Ранжирование выбирает проверяемые каналы, его коэффициенты не измеряют финансовый эффект.",
      "Флаги продуктов не подтверждают остатки, условия ставки, срок переоценки и новые обязательства.",
      ...(mode === "monitoring_only" ? ["Ставка сохранена. Не создавай новый шок, risks и opportunities пусты; допустимы наблюдение и проверка договоров."] : []),
      ...(mode === "applicability_check" ? ["Прямое отраслевое/продуктовое соответствие не подтверждено. risks и opportunities пусты; сначала уточни применимость."] : []),
      ...(mode === "indirect_exposure_check" ? ["Проверь передачу эффекта через отмеченную связь; не переносись автоматически от контрагента к обязанностям компании."] : []),
      ...(mode === "source_verification" ? ["Сначала проверь спорные сведения по первичному источнику."] : []),
      ...(mode === "scenario_only" ? ["Прогноз рассматривается как условный сценарий, а не принятое решение."] : []),
      ...(mode === "needs_event_details" ? ["Направление решения неизвестно. Сначала уточни событие; не предполагай повышение или снижение."] : [])],
  };
}
