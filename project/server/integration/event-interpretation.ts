import type { Json } from "../types.js";
import { extractEventDetails } from "../news-events.js";

/** Apply the existing sourced extractor before ML, including manually entered news. */
export const prepareEventForRanking = (event: Json): Json => extractEventDetails(event);

/** Source-bound interpretation hints, not new event facts or output validation. */
export function eventInterpretation(input: Json) {
  const event = extractEventDetails(input.event), details = event.event_details ?? {};
  const industry = input.profile.industry ?? {};
  const code = (value: unknown): string | null => typeof value === "string" && /^\d{2}(?:\.\d{1,2}){0,2}$/.test(value)
    ? value.replaceAll(".", "") : null;
  const companyCode = code(industry.okved_code) ?? code(industry.okved_division);
  const explicit = details.target_okved_codes ?? [], subjects = details.subject_okved_codes ?? [];
  const selectors: string[] = explicit.length ? explicit : subjects;
  const codes = selectors.map(code).filter((s): s is string => s !== null);
  const matches = companyCode !== null && codes.some(c => companyCode.startsWith(c));
  const coarse = companyCode !== null && codes.some(c => c.startsWith(companyCode) && c !== companyCode);
  const relation = !companyCode || !codes.length ? "unknown" : matches ? "match" : coarse ? "unknown" : "mismatch";
  const field = explicit.length ? "target_okved_codes" : "subject_okved_codes";
  const evidence = (details.evidence ?? []).filter((r: Json) => r.field === field);
  const observations: { stage: string; quote: string; source_ids: string[] }[] = [];
  for (const source of event.sources ?? []) {
    if (typeof source.excerpt !== "string" || !source.id) continue;
    for (const quote of source.excerpt.split(/(?<=[.!?])\s+|\n+/).map((s: string) => s.trim())) {
      if (quote.length > 1000 || !/(?:гост|стандарт)/i.test(quote)) continue;
      const text = quote.toLowerCase().replaceAll("ё", "е");
      // A completed programme/project is not an adopted standard. Require the
      // adoption verb to govern the standard itself, rather than another noun.
      const standard = "(?:гост[а-я]*|стандарт[а-я]*)";
      const qualifier = "(?:(?:нов[а-я]*|межгосударственн[а-я]*|национальн[а-я]*|техническ[а-я]*)\\s+){0,3}";
      const adoption = new RegExp("(?:утвердил[аио]?|принял[аио]?|утвержден[а-я]*|принят[а-я]*)\\s+" + qualifier + standard
        + "|" + standard + "\\s+(?:были?\\s+)?(?:утвержден[а-я]*|принят[а-я]*)", "i");
      const negated = /(?:не\s+(?:(?:был[аи]?|будет|будут)\s+)?(?:принят|утвержд|разработ|вступ|начат)|опроверг|недостовер)/.test(text);
      const speculative = /(?:может|могут|планиру|предстоит|если|предлага|намерен|будет|будут)/.test(text);
      let stage: string | null = null;
      if (!negated && !speculative && /(?:приступ[а-я]*\s+к\s+разработк|начал[а-я]*\s+разработк|начат[а-я]*\s+разработк|разрабатыва[а-я]*|ведется\s+разработка)/.test(text)) stage = "development";
      else if (/обсужд|дискусси/.test(text)) stage = "discussion";
      else if (!negated && !speculative && adoption.test(text)) stage = "adopted";
      else if (!negated && !speculative && /(?:вступил[а-я]*\s+в\s+силу|введен[а-я]*\s+в\s+действие)/.test(text)) stage = "in_force_reported";
      else if (!negated && /(?:вступает|вступит)\s+в\s+силу/.test(text)) stage = "entry_into_force_announced";
      else if (/(?:проект[а-я]*\s+(?:нов[а-я]*\s+)?(?:гост|стандарт)|(?:гост|стандарт)[а-я]*.{0,30}проект)/.test(text)) stage = "draft";
      if (stage && observations.length < 8 && !observations.some(r => r.stage === stage && r.quote === quote && r.source_ids[0] === source.id)) {
        observations.push({ stage, quote, source_ids: [source.id] });
      }
    }
  }
  const stages = [...new Set(observations.map(o => o.stage))];
  return {
    version: "event-interpretation-v1",
    rate_hold: event.event_type === "rate_change" && details.direction === "unchanged" ? {
      key_rate_unchanged: true, company_financing_terms_unchanged: null, market_financing_terms_unchanged: null,
      required_data: ["Условия договоров, если они есть", "Тип ставки и даты пересмотра", "Актуальные банковские предложения и комиссии"],
      evidence: (details.evidence ?? []).filter((r: Json) => r.field === "direction"),
    } : null,
    industry: { relation, basis: explicit.length ? "explicit_target_codes" : subjects.length ? "inferred_subject_codes" : "not_established",
      company_profile_paths: [industry.okved_code ? "/industry/okved_code" : "/industry/okved_division"],
      subject_codes: selectors, evidence, contract_participation_inferred: false },
    standards: { stage: stages.length === 1 ? stages[0] : stages.length ? "mixed" : "unknown", observations,
      mandatory_for_company: null, note: "Стадия относится к сообщению об источнике, не доказывает обязательность для компании; разные стадии и объекты не объединять." },
  };
}
