import type { Json } from "../types.js";
import { extractEventDetails } from "../news-events.js";
import { ceremonialReport, generalTaxScope, classifyBusinessSubjects } from "../news-subjects.js";

export type SelectionDecision = { eligible: boolean; reason: string };
const decision = (eligible: boolean, reason: string): SelectionDecision => ({ eligible, reason });
const normalize = (value: unknown): string => String(value ?? "").toLowerCase().replaceAll("ё", "е").trim();
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.filter(row => row && typeof row === "object") : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
const hostOf = (value: unknown): string | null => {
  try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.hostname.toLowerCase() : null; }
  catch { return null; }
};
const official = (url: unknown, domains: string[]): boolean => { const host = hostOf(url); return Boolean(host && domains.some(domain => host === domain || host.endsWith('.' + domain))); };
const code = (value: unknown): string | null => typeof value === 'string' && /^\d{2}(?:\.\d{1,2}){0,2}$/.test(value.trim()) ? value.replaceAll('.', '') : null;
const negated = (text: string): boolean => /(?:опроверг|недостовер|(?:^|\s)не\s+(?:(?:будет|будут|стал[аио]?)\s+)?(?:ввел|введ|ввод|утверд|приня|измен|повыс|сниз|закрыл|отмен)|(?:не\s+планиру|никаких\s+изменени))/iu.test(text);
const speculative = (text: string): boolean => /(?:может|могут|планиру|намерен|предлож|обсужда|прогноз|ожида[ею]|возможн|предполага|(?:^|\s)(?:жд[её]т|ждут|надеется|надеются|рассчитывает|рассчитывают)(?:\s|$)|проект\s+закона|законопроект|если\s)/iu.test(text);
const operativePattern = /(?:ввел[аио]?|введ[её]н[а-я]*|вводит[а-я]*|вступ[а-я]*\s+в\s+силу|утвердил[аио]?|утвержд[её]н[а-я]*|принял[аио]?|принят[а-я]*|установил[аио]?|установлен[а-я]*|продлил[аио]?|продлен[а-я]*|отменил[аио]?|отменен[а-я]*|запретил[аио]?|запрещ[её]н[а-я]*|ограничил[аио]?|ограничен[а-я]*|повысил[аио]?|повышен[а-я]*|снизил[аио]?|снижен[а-я]*|увеличил[аио]?|увеличен[а-я]*|сократил[аио]?|сокращ[её]н[а-я]*|изменил[аио]?|изменен[а-я]*|вырос[а-я]*|снизил[а-я]*|сниз[а-я]*ся|увеличил[а-я]*сь|сократил[а-я]*сь|приостановил[аио]?|приостановлен[а-я]*|прекратил[аио]?|прекращ[её]н[а-я]*|остановил[аио]?|остановлен[а-я]*|возобновил[аио]?|возобновлен[а-я]*|закрыл[аио]?|закрыт[а-я]*|открыл[аио]?|открыт[а-я]*|запустил[аио]?|запущ[её]н[а-я]*|обанкротил[а-я]*|банкротств[а-я]*|дефолт|авари[яию]|перебо[ийя]|отключени[ея]|забастовк[аи]|задержк[аи]\s+поставок)/iu;
const businessObject = /(?:ключев[а-я]*\s+ставк|кредит|депозит|финансирован|налог|ндс|пошлин|квот|лицензи|санкци|тариф|стоимост|цен[а-я]*|поставк|экспорт|импорт|ввоз|вывоз|производств|мощност|предприяти|электростанци|электроэнерги|электросет|электроснабжен|перевозк|логистик|маршрут|порт[а-я]*|дорог|контракт|госзакуп|субсиди|закупк|оборудован|выручк|прибыл|убыт|спрос|сырь|топлив|инвестиц|валют|курс[а-я]*|банкрот|дефолт)/iu;
function operativeClauses(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])|\n+|;\s*/u)
    .map(part => part.trim()).filter(part => part && !negated(part) && !speculative(part) && operativePattern.test(part) && businessObject.test(part));
}
function peripheralTitle(title: string): boolean {
  return ceremonialReport(title)
    || /(?:матч|турнир|чемпионат|гол[а-я]*|медал|футбол|хокке|теннис)/iu.test(title) && /(?:победил|побед[ауе]|проиграл|выиграл|обыграл|забил|счет[а-я]*|финал)/iu.test(title)
    || /(?:прокурор|чиновник|министр|депутат)/iu.test(title) && /(?:задеклар|деклараци[яиюе]|владе[а-я]*|владел[а-я]*|имуществ[а-я]*|собственност[а-я]*)/iu.test(title);
}
function personalRhetoricWithoutBusinessEvent(title: string, body: string): boolean {
  const personalReaction = /(?:выш(?:ел|ла|ли)\s+из\s+себя|сорвал[а-я]*\s+на\s+крик|оскорбил[а-я]*|обозвал[а-я]*|перепалк[а-я]*|(?:назвал[а-я]*|ты|он)\s+(?:[^.!?:\n]{0,55}\s+)?(?:клоун[а-я]*|идиот[а-я]*|дурак[а-я]*|болван[а-я]*))/iu;
  if (!personalReaction.test(title)) return false;
  // Personal rhetoric is not itself a new economic event. Keep a report with a
  // separate concrete business change in its headline or lead, but do not let
  // retrospective deals, draft bills or stated motives deeper in the article
  // borrow the company's counterparty/industry exposure.
  const lead = body.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])|\n+/u).slice(0, 2).join('\n');
  return !operativeClauses(title + '\n' + lead).length;
}
function officialRateDecision(event: Json): boolean {
  const officialSources = rows(event.sources).filter(source => source.kind === 'news' && !source.is_mock && official(source.url, ['cbr.ru']));
  if (!officialSources.length) return false;
  // Re-extract from the original official source text. A generic rate topic, analyst
  // forecast or user-supplied EventDetails must never create universal exposure.
  const extracted = extractEventDetails({ ...event, event_type: 'other', event_details: undefined, sources: officialSources });
  const details = extracted.event_details;
  return extracted.event_type === 'rate_change' && ['announced', 'effective'].includes(details?.decision_status)
    && ['increase', 'decrease', 'unchanged'].includes(details?.direction)
    && rows(details?.evidence).some(item => item.field === 'decision_status' && /(?:банк[а-я]*\s+россии|цб)/iu.test(item.quote));
}

/** A generation gate, not a new learned score: freshness, broad topics and unknown exposure
 * cannot spend the generation budget. Eligible events still receive conditional advice. */
export function selectReason(event: Json, ranked: Json, profile: Json, minScore: number): SelectionDecision {
  if (!event || !ranked || !profile || ranked.news_id !== event.news_id || ranked.event_id !== event.event_id || !profile.company_id)
    return decision(false, 'ranking_context_mismatch');
  if (event.is_mock || ranked.score_kind === 'mock' || rows(event.sources).some(source => source.is_mock)) return decision(false, 'synthetic_data_not_live');
  if (event.fact_status === 'disputed') return decision(false, 'disputed_event_requires_review');
  const sources = rows(event.sources).filter(source => source.kind === 'news' && hostOf(source.url));
  if (!sources.length) return decision(false, 'original_source_missing');
  const content = event.content || {};
  if (content.scope === 'feed_excerpt' || strings(content.warnings).some(warning => /full_article_fetch_failed|rss_excerpt_only_full_article_not_fetched/u.test(warning)))
    return decision(false, 'awaiting_full_text');
  if (strings(content.warnings).some(warning => /source_text_truncated/u.test(warning))) return decision(false, 'source_text_truncated');
  const body = String(event.text || '').trim(), title = String(event.title || '').trim();
  if (body.length < 100 || body.split(/\s+/u).length < 10) return decision(false, 'insufficient_source_text');
  if (peripheralTitle(title)) return decision(false, 'peripheral_or_ceremonial_topic');
  if (officialRateDecision(event)) return decision(true, 'official_key_rate_context_for_all_companies');
  if (speculative(title) || /(?:проект[а-я]*\s+(?:[а-я]+\s+){0,3}бюджет|обсуд[а-я]*\s+(?:[а-я]+\s+){0,3}бюджет)/iu.test(title))
    return decision(false, 'forecast_or_proposal_requires_review');
  if (personalRhetoricWithoutBusinessEvent(title, body)) return decision(false, 'personal_rhetoric_without_business_event');
  // A digest can contain useful facts, but one compound article must not combine
  // a grain price observation, a proposed subsidy and another company's investment
  // into a single company-specific event. A single-event weekly report is allowed.
  if (/(?:за\s+недел|итоги\s+недели|главное\s+за|обзор\s+(?:новостей|событий)|дайджест)/iu.test(title)
    && ((body.match(/(?:Подробнее|Читать\s+далее)/gu) || []).length >= 2 || classifyBusinessSubjects(body).length >= 4))
    return decision(false, 'multi_event_roundup_requires_extraction');
  if (event.event_type === 'rate_change' && !/ключев[а-я]*\s+ставк/iu.test(title)
    && !/(?:банк\s+россии|цб|совет\s+директоров\s+банка\s+россии).{0,80}(?:сохрани|повыс|сниз|решен).{0,40}ключев[а-я]*\s+ставк/iu.test(body.slice(0, 400)))
    return decision(false, 'rate_topic_is_background');
  const clauses = operativeClauses(title + '\n' + body);
  if (!clauses.length) return decision(false, 'no_confirmed_business_change');
  const details = event.event_details || {};
  if (details.decision_status === 'forecast') return decision(false, 'forecast_requires_review');
  // An official nationwide general tax rule is useful context, but does not assert
  // that this particular company is a taxpayer or qualifies for an exemption.
  if (event.event_type === 'tax_change' && sources.some(source => official(source.url, ['nalog.gov.ru', 'minfin.gov.ru', 'government.ru', 'pravo.gov.ru']))
    && clauses.some(clause => generalTaxScope(clause))) return decision(true, 'official_general_tax_context');
  if (!Number.isFinite(ranked.score) || !Number.isFinite(minScore) || ranked.score < minScore) return decision(false, 'below_relevance_threshold');
  const sourceIds = new Set(sources.map(source => source.id));
  const feature = (name: string): number => {
    const entry = rows(ranked.feature_contributions).find(item => item.feature === name && Number.isFinite(item.value) && item.value > 0
      && strings(item.source_ids).some(id => sourceIds.has(id)));
    return entry?.value || 0;
  };
  const direct = strings(event.company_ids).includes(profile.company_id) && typeof event.entity_mapping_source === 'string' && event.entity_mapping_source.trim();
  if (direct && feature('direct_company_match')) return decision(true, 'verified_company_event');
  const companyCode = code(profile.industry?.okved_code) || code(profile.industry?.okved_division);
  const targets = strings(details.target_okved_codes), subjects = strings(details.subject_okved_codes), selectors = targets.length ? targets : subjects;
  const match = selectors.some(selector => { const prefix = code(selector); return prefix && companyCode?.startsWith(prefix); });
  const unknown = selectors.some(selector => { const prefix = code(selector); return prefix && (!companyCode || prefix.startsWith(companyCode) && prefix !== companyCode); });
  const graphMatch = feature('graph_in_share') > 0 || feature('graph_out_share') > 0 || feature('related_company_match') > 0;
  // Counterparties can be exposed even when the company's own industry differs;
  // this supports a check of concentration, not an invented supply-chain claim.
  if (graphMatch) return decision(true, 'verified_counterparty_exposure_check');
  if (selectors.length && !match && !unknown) return decision(false, 'explicit_industry_mismatch');
  if (feature('target_role_mismatch')) return decision(false, 'target_role_mismatch');
  const products = profile.bank_products || {};
  if (event.event_type === 'rate_change' && (feature('rate_financing') && [products.loan, products.leasing, products.factoring].some(value => value === true)
    || feature('rate_deposit') && products.deposit === true)) return decision(true, 'verified_bank_product_exposure');
  const trade = profile.foreign_trade || {};
  if (event.event_type === 'fx_change' && feature('fx_trade') && trade.has_fts === true) return decision(true, 'verified_foreign_trade_currency_exposure');
  const industryFeature = feature('industry_match') || feature('industry_exact_match') || feature('industry_subject_match');
  const legacyDivision = !selectors.length && strings(event.okved_divisions).includes(String(profile.industry?.okved_division));
  if (industryFeature && (match || legacyDivision)) return decision(true, 'verified_industry_business_change');
  const countries = new Set(strings(trade.countries).map(normalize));
  if (feature('country_match') && trade.has_fts === true && strings(event.countries).some(country => countries.has(normalize(country))))
    return decision(true, 'verified_trade_country_change');
  const region = normalize(profile.geography?.region);
  if (feature('region_match') && region && strings(event.regions).some(value => normalize(value) === region)
    && clauses.some(clause => /(?:электроснабж|электроэнерг|отключен|авари|павод|наводнен|дорог|перевозк|порт|ограничен|запрещен|чрезвычай)/iu.test(clause)))
    return decision(true, 'verified_regional_business_disruption');
  return decision(false, 'no_verified_company_exposure');
}
