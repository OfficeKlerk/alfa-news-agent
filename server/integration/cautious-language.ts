import type { Json } from "../types.js";
import { eventInterpretation } from "./event-interpretation.js";
import { profileFactRules } from "./profile-facts.js";
import { assertionClauses, qualifiedAssertion } from "./assertion-language.js";

export function rankingEvidence(input: Json) {
  const rows: Json[] = input.ranked_item?.feature_contributions ?? [];
  const nonzero = rows.filter(row => Number.isFinite(row.contribution) && row.contribution !== 0);
  return {
    available: rows.length > 0, nonzero_count: nonzero.length,
    nonzero_contributions: nonzero.slice(0, 64).map(row => ({ feature: row.feature, contribution: row.contribution })),
    truncated: nonzero.length > 64,
    freshness_only_confirmed: nonzero.length > 0 && nonzero.every(row => row.feature === "freshness"),
    rule: "Учитываются все ненулевые contribution, включая отрицательные, без взаимного погашения. Отсутствие таблицы или только нули не доказывают, что ранжирование основано исключительно на свежести. Это описание вклада в модель, не доказательство причинной связи." };
}

/** Narrow, conservative language guard, not a general semantic verifier. Quoted evidence is excluded by the caller. */
export function cautiousLanguageRules(text: string, input: Json): string[] {
  const issues = new Set<string>(profileFactRules(text, input));
  const clauses = assertionClauses(text);
  // Compare explicit industry statements with sourced event interpretation, not the rank score.
  const relation = input.event ? eventInterpretation(input).industry.relation : "unknown";
  for (const clause of clauses) {
    const industry = /отрасл[а-яё]*[^.!?;]{0,90}?(не\s+совпада[а-яё]*|совпада[а-яё]*)[^.!?;]{0,60}(?:тематик|новост|событи)/iu.exec(clause);
    if (industry && !qualifiedAssertion(clause)) {
      const asserted = /^не\s/iu.test(industry[1]) ? "mismatch" : "match";
      if (relation !== asserted) issues.add("Industry relation assertion contradicts prepared event");
    }
    // Noun forms: "отраслевое несоответствие" is the same claim as "не совпадает".
    const noun = /отраслев[а-яё]*\s+(не)?соответстви[а-яё]*/iu.exec(clause);
    // Qualify the noun phrase itself: "несоответствие ...: новость не доказывает Y" still asserts it.
    const nounPhrase = noun ? clause.slice(noun.index).split(/[:,—–]/)[0] : "";
    if (noun && !industry && !/(?:^|[\s,])если\s/iu.test(clause.slice(0, noun.index + 1)) && !/не\s+(?:установлен|подтвержд|определ|выявлен|доказан)[а-яё]*|неизвест/iu.test(nounPhrase)) {
      if (relation !== (noun[1] ? "mismatch" : "match")) issues.add("Industry relation assertion contradicts prepared event");
    }
    // Industry match never establishes participation in a programme, contracts or budget funding.
    const participation = /(?:компани[яиюей]*|предприяти[еяю]*|организаци[яиюей]*)[^.!?;\n]{0,60}(?<!не\s)(?:получа[а-яё]*|получит|участву[а-яё]*|является\s+(?:участник|получател|исполнител)[а-яё]*|заключил[а-яё]*|име[а-яё]*|выполня[а-яё]*)[^.!?;\n]{0,40}(?:бюджетн[а-яё]*\s+(?:средств|финансировани|субсиди)|госконтракт|государственн[а-яё]*\s+(?:контракт|заказ|программ|субсиди))/iu.test(clause);
    if (participation && !qualifiedAssertion(clause) && !/не\s+(?:подтвержд|установлен|доказан|известн)[а-яё]*|неизвест|требует\s+проверк|нужно\s+провер/iu.test(clause))
      issues.add("Project participation or budget funding is not established");
    const scoped = qualifiedAssertion(clause) || /не\s+(?:подтвержд[а-яё]*|установлен[а-яё]*|доказан[а-яё]*)\s*,?\s*(?:что\s+)?(?:отсутств|нет\s+связ)|в\s+(?:предоставленных|имеющихся)\s+данных[^.!?;]{0,30}связ|(?:подтвержд[её]нн|доказанн|установленн)[а-яё]*\s+(?:прям[а-яё]*\s+)?связ/iu.test(clause);
    const absence = /(?:прям[а-яё]*\s+)?связ[а-яё]*[^.!?;\n]{0,100}(?:отсутству[а-яё]*|не\s+существу[а-яё]*|исключен[а-яё]*)|(?:нет|не\s+имеется)\s+(?:прям[а-яё]*\s+)?связ[а-яё]*|компани[а-яё]*[^.!?;\n]{0,60}(?:не\s+связан[а-яё]*|не\s+име[а-яё]*\s+связ)|(?:новост[а-яё]*|событи[а-яё]*)[^.!?;\n]{0,60}не\s+влияет\s+на\s+компани[а-яё]*/iu.test(clause);
    const reverseAbsence = /(?:отсутству[а-яё]*|исключен[а-яё]*)\s+(?:прям[а-яё]*\s+)?связ[а-яё]*/iu.test(clause);
    const noImpact = /(?:новост[а-яё]*|событи[а-яё]*|решени[а-яё]*)[^.!?;\n]{0,130}не\s+оказывает\s+(?:прям[а-яё]*\s+)?(?:воздействия|влияния)\s+на\s+компани[а-яё]*/iu.test(clause);
    if ((absence || reverseAbsence || noImpact) && !scoped) issues.add("Unconfirmed linkage must not be stated as proven absence");
    const ranking = /ранжир|рейтинг|релевантност|оценк[а-яё]*|score/iu.test(clause);
    const onlyAge = /(?:исключительно|только|лишь)[^.!?;\n]{0,45}(?:свежест|давност|новизн)|(?:свежест|давност)[^.!?;\n]{0,45}единственн/iu.test(clause);
    const qualified = /не\s+только|не\s+исключительно|нельзя|не\s+(?:подтвержд|доказ|установл)|нет\s+основан/iu.test(clause);
    if (ranking && onlyAge && !qualified && !rankingEvidence(input).freshness_only_confirmed)
      issues.add("Freshness-only ranking explanation is not supported by contributions");
  }
  return [...issues];
}
export function cautiousLanguageRule(text: string, input: Json): string | undefined { return cautiousLanguageRules(text, input)[0]; }
