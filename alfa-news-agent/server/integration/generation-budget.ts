import type { FieldIssue, Json } from "../types.js";

/** Live generation budget. The canonical contract still accepts 2–30 claims in saved analyses. */
export const GENERATION_CLAIM_LIMIT = 8;
export const GENERATION_BANK_CLAIM_LIMIT = 3;

/** Reject an overgrown draft as a whole instead of repairing each copied quote. */
export function generationBudgetIssues(draft: Json): FieldIssue[] {
  if (!Array.isArray(draft?.claims)) return [];
  const issues: FieldIssue[] = [];
  if (draft.claims.length > GENERATION_CLAIM_LIMIT)
    issues.push({ stage: "grounding", path: "/claims", rule: "Too many claims for a compact answer", limit: GENERATION_CLAIM_LIMIT });
  if (draft.claims.filter((c: Json) => c?.kind === "bank").length > GENERATION_BANK_CLAIM_LIMIT)
    issues.push({ stage: "grounding", path: "/claims", rule: "Too many bank claims", limit: GENERATION_BANK_CLAIM_LIMIT });
  // REPORT8 truncations were loops of one claim; a complete draft with a copy gets the same compact rebuild.
  // Punctuation-only copies remain duplicates; changing one word may change a fact.
  const texts: { kind: string; norm: string; quantities: string }[] = draft.claims.filter((c: Json) => typeof c?.text === "string").map((c: Json) => {
    const norm = c.text.toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\d]+/gu, " ").trim();
    const quantities = JSON.stringify(c.text.match(/[+−-]?\d+(?:[.,]\d+)?|[%₽$€£]/gu) ?? []);
    return { kind: c.kind, norm: norm.split(" ").filter((word: string) => !/^(?:также|же|именно|соответственно)$/.test(word)).join(" "), quantities };
  });
  // Verbatim evidence is allowed to differ by one meaningful token (a year,
  // amount, entity or negation). Lexical similarity cannot establish fact identity.
  // Reject exact normalized repetitions, not merely overlapping vocabularies.
  const near = (a: typeof texts[number], b: typeof texts[number]) => a.kind === b.kind && a.norm === b.norm && a.quantities === b.quantities;
  if (texts.some((a, i) => texts.slice(i + 1).some(b => near(a, b)))) issues.push({ stage: "grounding", path: "/claims", rule: "Repeated claim text" });
  // REPORT8 transport-dentist and REPORT9 bank-forecast grew into lists of what the news does not say.
  if (draft.claims.filter((c: Json) => c?.kind === "ai" && typeof c.text === "string" && SPECULATIVE_ABSENCE.test(c.text)).length >= 2)
    issues.push({ stage: "grounding", path: "/claims", rule: "Speculative absence enumeration" });
  return issues;
}
export const SPECULATIVE_ABSENCE = /(?:новост[а-яё]*|событи[а-яё]*|сообщени[а-яё]*)\s+не\s+(?:содерж[а-яё]*|сообща[а-яё]*|упомина[а-яё]*|указыва[а-яё]*)\s+(?:информаци[а-яё]*|сведени[а-яё]*|данн[а-яё]*)?/iu;
