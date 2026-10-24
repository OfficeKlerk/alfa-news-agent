import type { Json } from "../types.js";
import { assertionClauses, mentionedProducts, productMark, qualifiedAssertion } from "./assertion-language.js";
import { questionProfileIssues } from "./question-profile-grounding.js";
import { paymentCoveragePaths } from "./profile-paths.js";

/** Bind each asserted snapshot fact to its own claim, never to a neighbouring claim. */
export function claimProfileRules(claim: Json, input: Json): string[] {
  const paths: string[] = claim.profile_paths ?? [], issues = new Set<string>();
  const require = (condition: boolean) => { if (!condition) issues.add("Profile claim assertion needs matching profile path"); };
  for (const clause of assertionClauses(claim.text)) {
    if (qualifiedAssertion(clause)) continue;
    for (const product of mentionedProducts(clause)) {
      if (productMark(clause, product) !== undefined || /(?:неизвест|не\s+подтвержден|сведени[а-яё]*[^.!?;]{0,20}нет)/iu.test(clause))
        require(paths.includes("/bank_products/" + product));
    }
    if (/(?:продуктов[а-яё]*\s+отметк|банковск[а-яё]*\s+продукт)[^.!?;]{0,35}(?:отсутств|не\s+отмеч)|(?:отсутств|нет)[^.!?;]{0,25}продуктов[а-яё]*\s+отметк/iu.test(clause))
      require(Object.keys(input.profile.bank_products ?? {}).every(key => paths.includes("/bank_products/" + key)));
    if (/has_fts|(?:отметк|флаг)[^.!?;]{0,25}(?:фтс|внешнеторгов)|(?:фтс)[^.!?;]{0,25}(?:отметк|флаг)|внешнеторгов[а-яё]*\s+деятельност/iu.test(clause))
      require(paths.includes("/foreign_trade/has_fts") || paths.includes("/foreign_trade/trade_direction"));
    if (/has_fts|фтс/iu.test(clause)) require(paths.includes("/foreign_trade/has_fts"));
    if (/\bhas_fts\s*=\s*(?:true|false)\b/iu.test(clause)) {
      require(paths.includes("/foreign_trade/has_fts"));
      const claimed = /\bhas_fts\s*=\s*true\b/iu.test(clause);
      if (input.profile.foreign_trade?.has_fts !== claimed) issues.add("Trade flags do not establish direction or payment currency");
    }
    if (/нет\s+отметк[а-яё]*\s+фтс|отметк[а-яё]*\s+фтс\s+отсутству[а-яё]*/iu.test(clause)
      && input.profile.foreign_trade?.has_fts !== false) issues.add("Trade flags do not establish direction or payment currency");
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
            && paymentCoveragePaths(input.profile, path).every(p => paths.includes(p))));
      }
    } else if (/входящ[а-яё]*|исходящ[а-яё]*|период[а-яё]*\s+платеж|валют[а-яё]*\s+(?:и\s+период[а-яё]*\s+)?платеж/iu.test(clause.replaceAll("ё", "е"))) {
      for (const issue of questionProfileIssues({answer:clause,claims:[claim],claim_indexes:[0]}, input))
        issues.add(issue.rule === "Question profile assertion needs matching claim and profile path"
          ? "Profile claim assertion needs matching profile path" : issue.rule);
    }
  }
  return [...issues];
}
