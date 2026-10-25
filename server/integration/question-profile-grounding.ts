import type { FieldIssue, Json } from "../types.js";
import { assertionClauses, mentionedProducts, productMark, qualifiedAssertion, subjectAssertions } from "./assertion-language.js";

const paymentMentions = {
  incoming: /входящ[а-яё]*\s+(?:плат[её]ж|поступлен)|поступлен[а-яё]*\s+на\s+сч[её]т/iu,
  outgoing: /исходящ[а-яё]*\s+плат[её]ж/iu,
};
const sharedPaymentMention = /входящ[а-яё]*\s+и\s+исходящ[а-яё]*\s+плат[её]ж/iu;
const paymentSubject = new RegExp([...Object.values(paymentMentions), sharedPaymentMention].map(re => `(?:${re.source})`).join("|"), "iu");
const paymentPredicate = /равны\s+нулю|отсутствуют|(?:не\s+)?наблюдаются|имеются|(?<![\p{L}])есть(?![\p{L}])|зафиксированы/iu;
const paymentAssertions = (text: string) => subjectAssertions(text, paymentSubject, paymentPredicate);

function paymentState(text: string): "zero" | "absent" | "present" | undefined {
  if (/равны\s+нулю/iu.test(text)) return "zero";
  if (/отсутствуют|не\s+наблюдаются/iu.test(text)) return "absent";
  if (/наблюдаются|имеются|есть|зафиксированы/iu.test(text)) return "present";
  return undefined;
}

/** Targeted coverage for product/payment assertions in follow-ups, not a general NLP proof.
 * Only referenced AI claims can support generated profile prose. Literal source quotes
 * are checked by the ordinary quote validator and excluded here. */
export function questionProfileIssues(answer: Json, input: Json): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const claims: Json[] = answer.claim_indexes.map((i: number) => answer.claims[i]).filter((c: Json) => c?.kind === "ai");
  const generated = answer.claim_indexes.map((i: number) => answer.claims[i]).filter((c: Json) => c && c.kind !== "ai")
    .reduce((text: string, c: Json) => text.split(c.quote).join(" "), answer.answer);
  const add = (rule = "Question profile assertion needs matching claim and profile path") => {
    if (!issues.some(i => i.rule === rule)) issues.push({ stage: "grounding", path: "/answer", rule });
  };
  for (const clause of assertionClauses(generated)) {
    if (qualifiedAssertion(clause)) continue;
    for (const product of mentionedProducts(clause)) {
      const mark = productMark(clause, product);
      if (!claims.some(c => c.profile_paths?.includes("/bank_products/" + product)
        && assertionClauses(c.text).some(part => !qualifiedAssertion(part) && mentionedProducts(part).includes(product)
          && (mark === undefined || productMark(part, product) === mark)))) add();
    }
    for (const direction of ["incoming", "outgoing"] as const) {
      const mentionsDirection = (text: string) => paymentMentions[direction].test(text) || sharedPaymentMention.test(text);
      const local = paymentAssertions(clause).find(mentionsDirection);
      if (!local) continue;
      const state = paymentState(local);
      const paths = state === "zero" ? [`/payment_summary/${direction}_amount`]
        : [`/payment_summary/${direction}_count`, `/payment_summary/${direction}_amount`];
      if (!claims.some(c => paths.some(path => c.profile_paths?.includes(path))
        && assertionClauses(c.text).some(part => !qualifiedAssertion(part)
          && paymentAssertions(part).some(assertion => mentionsDirection(assertion)
            && (state === undefined || paymentState(assertion) === state))))) add();
      const payment = input.profile.payment_summary;
      const count = payment?.[direction + "_count"], amount = payment?.[direction + "_amount"];
      const knownPresence = typeof count === "number" ? count > 0 : typeof amount === "number" && amount > 0 ? true : undefined;
      if (state === "present" && knownPresence !== true || state === "absent" && knownPresence !== false
        || state === "zero" && amount !== 0) add("Payment assertion contradicts the snapshot");
    }
    for (const [pattern, path] of [[/валют[а-яё]*\s+(?:и\s+период[а-яё]*\s+)?плат[её]ж|плат[её]ж[а-яё]*[^.!?;]{0,30}валют/iu, "/payment_summary/currency"],
      [/период[а-яё]*\s+плат[её]ж|плат[её]ж[а-яё]*[^.!?;]{0,30}период/iu, "/payment_summary/period"]] as const) {
      if (pattern.test(clause) && !claims.some(c => c.profile_paths?.includes(path)
        && assertionClauses(c.text).some(part => !qualifiedAssertion(part) && pattern.test(part)))) add();
    }
  }
  return issues;
}
