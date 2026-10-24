import type { Json } from "../types.js";
import { assertionClauses, mentionedProducts, productMark, qualifiedAssertion } from "./assertion-language.js";
import { questionProfileIssues } from "./question-profile-grounding.js";
import { paymentCoveragePaths, profileValue } from "./profile-paths.js";

/** Bind each asserted snapshot fact to its own claim, never to a neighbouring claim. */
export function claimProfileRules(claim: Json, input: Json): string[] {
  return [...claimProfileCheck(claim, input).issues];
}
/** Existing profile fields that would satisfy this claim's own path rules: repair hints, never auto-fixes. */
export function claimProfileSuggestions(claim: Json, input: Json): string[] {
  const paths: string[] = Array.isArray(claim?.profile_paths) ? claim.profile_paths : [];
  const coverage = paths.flatMap(path => { try { return paymentCoveragePaths(input.profile, path); } catch { return []; } });
  return [...new Set([...claimProfileCheck(claim, input).missing, ...coverage])].filter(path => {
    if (paths.includes(path)) return false;
    try { profileValue(input.profile, path); return true; } catch { return false; }
  });
}
function claimProfileCheck(claim: Json, input: Json) {
  const paths: string[] = claim.profile_paths ?? [], issues = new Set<string>(), missing = new Set<string>();
  const require = (condition: boolean, wanted: string[] = []) => {
    if (condition) return;
    issues.add("Profile claim assertion needs matching profile path");
    wanted.forEach(path => missing.add(path));
  };
  const texts = [claim.text, ...(claim.conditions ?? [])];
  const tradeContext = /внешнеторгов|торговл|фтс|trade_direction|currencies/iu.test(claim.text);
  for (const clause of texts.flatMap(text => assertionClauses(text))) {
    if (qualifiedAssertion(clause)) continue;
    for (const product of mentionedProducts(clause)) {
      if (productMark(clause, product) !== undefined || /(?:неизвест|не\s+подтвержден|сведени[а-яё]*[^.!?;]{0,20}нет)/iu.test(clause))
        require(paths.includes("/bank_products/" + product), ["/bank_products/" + product]);
    }
    if (/(?:продуктов[а-яё]*\s+отметк|банковск[а-яё]*\s+продукт)[^.!?;]{0,35}(?:отсутств|не\s+отмеч)|(?:отсутств|нет)[^.!?;]{0,25}продуктов[а-яё]*\s+отметк/iu.test(clause))
      require(Object.keys(input.profile.bank_products ?? {}).every(key => paths.includes("/bank_products/" + key)),
        Object.keys(input.profile.bank_products ?? {}).map(key => "/bank_products/" + key));
    if (/has_fts|(?:отметк|флаг)[^.!?;]{0,25}(?:фтс|внешнеторгов)|(?:фтс)[^.!?;]{0,25}(?:отметк|флаг)|внешнеторгов[а-яё]*\s+деятельност/iu.test(clause))
      require(paths.includes("/foreign_trade/has_fts") || paths.includes("/foreign_trade/trade_direction"), ["/foreign_trade/has_fts"]);
    if (/has_fts|фтс/iu.test(clause)) require(paths.includes("/foreign_trade/has_fts"), ["/foreign_trade/has_fts"]);
    if (/\bhas_fts\s*=\s*(?:true|false)\b/iu.test(clause)) {
      require(paths.includes("/foreign_trade/has_fts"), ["/foreign_trade/has_fts"]);
      const claimed = /\bhas_fts\s*=\s*true\b/iu.test(clause);
      if (input.profile.foreign_trade?.has_fts !== claimed) issues.add("Trade flags do not establish direction or payment currency");
    }
    if (/нет\s+отметк[а-яё]*\s+фтс|отметк[а-яё]*\s+фтс\s+отсутству[а-яё]*/iu.test(clause)
      && input.profile.foreign_trade?.has_fts !== false) issues.add("Trade flags do not establish direction or payment currency");
    // An unknown value is also a profile assertion and needs its own field.
    if (tradeContext && /неизвест|не\s+(?:установлен|задан|раскрыт)/iu.test(clause)) {
      const fields: string[] = [];
      if (/направлен[а-яё]*\s+торговл|trade_direction/iu.test(clause)) fields.push("trade_direction");
      if (/валют|currencies/iu.test(clause) && !/плат[её]ж|договор|обязательств/iu.test(clause)) fields.push("currencies");
      for (const field of fields) {
        require(paths.includes("/foreign_trade/" + field), ["/foreign_trade/" + field]);
        const value = input.profile.foreign_trade?.[field];
        if (value !== null && value !== undefined && value !== "unknown" && value !== "" && !(Array.isArray(value) && !value.length))
          issues.add("Trade flags do not establish direction or payment currency");
      }
    }
    // "Currency/period of payments is unknown" is a profile assertion about that exact field.
    if (/неизвест|не\s+(?:установлен|указан|задан|раскрыт)[а-яё]*/iu.test(clause)) {
      for (const [pattern, field] of [[/валют[а-яё]*[^.!?;]{0,30}плат[её]ж|плат[её]ж[а-яё]*[^.!?;]{0,30}валют/iu, "currency"],
        [/период[а-яё]*[^.!?;]{0,30}плат[её]ж|плат[её]ж[а-яё]*[^.!?;]{0,30}период/iu, "period"]] as const) {
        if (!pattern.test(clause)) continue;
        require(paths.includes("/payment_summary/" + field), ["/payment_summary/" + field]);
        const value = input.profile.payment_summary?.[field];
        if (value !== null && value !== undefined && value !== "unknown" && value !== "") issues.add("Payment assertion contradicts the snapshot");
      }
    }
    // Distribution evidence needs that direction's statistic and coverage, not
    // a count from the other direction. Count assertions use their scalar fields.
    const distribution = /дол[яиюеь]|распределен|структур|покрыти/iu.test(clause);
    if (distribution) {
      for (const [pattern, direction] of [[/входящ|поступлен/iu, "in"], [/исходящ|перечислен/iu, "out"]] as const) {
        if (!pattern.test(clause)) continue;
        const prefix = `/payment_summary/counterparty_context/${direction}/`;
        const coverageOnly = /покрыти|(?:известн|неизвестн)[а-яё]*\s+(?:отрасл|контрагент|групп)/iu.test(clause);
        require(coverageOnly
          ? ["industry", "group_membership"].some(kind => ["known_share", "unknown_share"].every(key => paths.includes(prefix + "coverage/" + kind + "/" + key)))
          : paths.some(path => path.startsWith(prefix) && /\/(?:industry|group)_distribution\//.test(path)
            && paymentCoveragePaths(input.profile, path).every(p => paths.includes(p))),
          coverageOnly ? ["known_share", "unknown_share"].map(key => prefix + "coverage/industry/" + key) : []);
      }
    } else if (/входящ[а-яё]*|исходящ[а-яё]*|период[а-яё]*\s+платеж|валют[а-яё]*\s+(?:и\s+период[а-яё]*\s+)?платеж/iu.test(clause.replaceAll("ё", "е"))) {
      for (const issue of questionProfileIssues({answer:clause,claims:[claim],claim_indexes:[0]}, input))
        issues.add(issue.rule === "Question profile assertion needs matching claim and profile path"
          ? "Profile claim assertion needs matching profile path" : issue.rule);
    }
  }
  return { issues, missing };
}
