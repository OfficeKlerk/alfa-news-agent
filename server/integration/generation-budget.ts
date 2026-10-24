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
  const texts = draft.claims.map((c: Json) => typeof c?.text === "string" ? c.kind + ":" + c.text.trim().toLowerCase() : undefined).filter(Boolean);
  if (new Set(texts).size < texts.length) issues.push({ stage: "grounding", path: "/claims", rule: "Repeated claim text" });
  return issues;
}
