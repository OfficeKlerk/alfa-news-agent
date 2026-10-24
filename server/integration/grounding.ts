import type { Json } from "../types.js";
import { ApiFault, validate } from "./contracts.js";
import type { prepareContext } from "./context.js";
import { adviceConstraints } from "./advice-policy.js";

export type PreparedContext = ReturnType<typeof prepareContext>;
const roots = new Set(["industry", "scale", "company_attributes", "bank_products", "foreign_trade", "geography",
  "dataset_position", "group", "related_companies", "counterparties", "payment_summary"]);
function reject(message: string): never { throw new ApiFault(502, "CONTRACT_VIOLATION", message); }
const nonblank = (s: unknown) => typeof s === "string" && Boolean(s.trim());
export function profileValue(profile: Json, path: string): unknown {
  const parts = path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!roots.has(parts[0]) || parts.some(s => ["__proto__", "prototype", "constructor", "source", "evidence", "limitation"].includes(s))) reject("Invalid business profile path");
  if (parts[0] === "payment_summary" && parts[1] === "counterparty_context" && ["method", "scope"].includes(parts[2]))
    reject("Payment aggregation metadata is not a business fact");
  let value: any = profile;
  for (const key of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) reject("Unknown profile path");
    value = value[key];
  }
  if (value !== null && typeof value === "object" && !(Array.isArray(value) && value.every(v => v === null || typeof v !== "object"))) reject("Profile path must select a concrete value");
  return value;
}
function numbers(text: string) {
  return text.replace(/(\d)[\s\u00a0\u202f](?=\d{3}(?:\D|$))/g, "$1").match(/[-+−]?\d+(?:[.,]\d+)?/g)?.map(s => s.replace(",", ".").replace("−", "-").replace(/^\+/, "")) ?? [];
}
/** Financial figures belong in verbatim fact/bank quotes, not generated company impact.
 * Token membership alone would accept "company loses 14%" from a 14% policy rate.
 * This deliberately conservative lexical guard is not a general semantic validator.
 */
export function hasFinancialFigure(text: string): boolean {
  if (!/\d/.test(text)) return false;
  return /\d\s*(?:%|₽|\$|€|₣|£|руб|доллар|евро|юан|процент|б\.?\s*п\.?|базисн|п\.?\s*п\.?)/iu.test(text)
    || /(?:₽|\$|€|£)\s*\d/u.test(text)
    || text.split(/[.!?;\n]+/).some(part => /\d/.test(part)
      && /(?:выручк|прибыл|убыт|потер|экономи[яюи]|расход|затрат|доход|стоимост|себестоимост|ставк|долг|кредит|плат[её]ж|финансир|процент)/iu.test(part));
}
/** Structural/provenance checks, not a proof of factual truth or economic causality. */
export function validateGrounding(answer: Json, context: PreparedContext, serverNotices = false) {
  validate("GeneratedAnalysis", serverNotices && Array.isArray(answer.limitations)
    ? { ...answer, limitations: answer.limitations.slice(0, 20) } : answer, true);
  if (!answer.limitations.every(nonblank)) reject("Blank limitation");
  if (adviceConstraints(context.input).no_new_risk_or_opportunity && (answer.risks.length || answer.opportunities.length))
    reject("Unchanged rate or unconfirmed applicability allows review only, not new risks/opportunities");
  const sources = new Map<string, Json>(context.sources.map(s => [s.id, s]));
  const companyId = context.input.company_id as string;
  // A numeric suffix in an identifier is not financial evidence. Permit the literal ID in prose without admitting its number on its own.
  const withoutCompanyId = (text: string) => /[A-Za-z_:]/.test(companyId) ? text.split(companyId).join(" ") : text;
  const scan = (text: string) => numbers(withoutCompanyId(text));
  const supports: string[] = [];
  for (const c of answer.claims as Json[]) {
    if (!nonblank(c.text) || !c.source_ids.every((id: string) => sources.has(id))) reject("Unknown claim source or blank text");
    if (c.kind !== "ai") {
      const kind = c.kind === "fact" ? "news" : "bank";
      if (c.quote.trim().length < 8 || c.text !== c.quote || !c.source_ids.every((id: string) => sources.get(id)!.kind === kind)
        || !c.source_ids.every((id: string) => sources.get(id)!.excerpt.includes(c.quote))) reject("Quote not found in selected evidence");
      supports.push(c.quote);
    } else {
      if (c.quote !== "" || !c.source_ids.includes("company:" + context.input.company_id)
        || !c.source_ids.some((id: string) => context.input.event.sources.some((s: Json) => s.id === id))
        || !c.profile_paths?.length || !c.conditions?.length || !c.conditions.every(nonblank)) reject("AI claim needs company, news, business fields and conditions");
      const values = c.profile_paths.map((path: string) => profileValue(context.input.profile, path));
      if (values.some((v: unknown) => v === null || v === "unknown" || v === "" || Array.isArray(v) && !v.length)
        && (!answer.missing_data.some(nonblank) || !answer.limitations.some(nonblank))) reject("Unknown business field needs missing data and limitation");
      // Only selected news/bank excerpts and selected business values may supply numbers.
      const evidence = c.source_ids.filter((id: string) => sources.get(id)!.kind !== "company").map((id: string) => sources.get(id)!.excerpt).join(" ");
      supports.push(evidence + " " + JSON.stringify(values));
      const allowed = new Set(scan(supports.at(-1)!));
      if (scan(c.text + " " + c.conditions.join(" ")).some(n => !allowed.has(n))) reject("Unsupported numeric assertion");
      if (hasFinancialFigure(withoutCompanyId(c.text + " " + c.conditions.join(" ")))) reject("AI financial figures must be verbatim fact/bank quotes, not company impact");
    }
  }
  const used = new Set<number>();
  function section(text: string, indexes: number[], kind: string) {
    if (!indexes.length || indexes.some(i => i >= answer.claims.length)) reject("Unknown claim index");
    if (!indexes.some(i => answer.claims[i].kind === kind)) reject("Wrong evidence type for section");
    indexes.forEach(i => used.add(i));
    const allowed = new Set(indexes.flatMap(i => scan(supports[i])));
    if (scan(text).some(n => !allowed.has(n))) reject("Unsupported section number");
    // Only the exact quoted passage can carry a financial figure. Reusing its number elsewhere is not support.
    const generated = indexes.filter(i => answer.claims[i].kind !== "ai")
      .reduce((value, i) => value.split(answer.claims[i].quote).join(" "), text);
    if (hasFinancialFigure(withoutCompanyId(generated))) reject("Section financial figures must be verbatim fact/bank quotes");
  }
  const g = answer.grounding;
  section(answer.summary, g.summary, "fact"); section(answer.why_relevant, g.why_relevant, "ai");
  for (const key of ["risks", "opportunities", "recommendations"]) {
    if (answer[key].length !== g[key].length) reject("Section and grounding length mismatch");
    answer[key].forEach((text: string, i: number) => {
      const refs = key === "recommendations" ? g[key][i].claim_indexes : g[key][i];
      const rec = key === "recommendations" ? g[key][i] : null;
      if (rec && (!nonblank(rec.condition) || !rec.required_data.every(nonblank))) reject("Recommendation needs condition and required data");
      if (rec && (!refs.some((index: number) => answer.claims[index]?.kind === "ai" && answer.claims[index].conditions.includes(rec.condition))
        || !rec.required_data.every((item: string) => answer.missing_data.includes(item)))) reject("Recommendation condition and required data must match its AI claim and missing_data");
      section(text + (rec ? " " + rec.condition + " " + rec.required_data.join(" ") : ""), refs, "ai");
    });
  }
  const allowedNotes = new Set(supports.flatMap(value => scan(value)));
  for (const note of [...answer.limitations, ...answer.missing_data]) {
    if (scan(note).some(n => !allowedNotes.has(n))) reject("Unsupported limitation or missing-data number");
    if (hasFinancialFigure(withoutCompanyId(note))) reject("Financial figures are not allowed in limitations or missing_data");
  }
  if (used.size !== answer.claims.length) reject("Unused claim");
}
export function analysisDraft(value: Json) {
  return Object.fromEntries(["summary", "why_relevant", "claims", "risks", "opportunities", "recommendations", "limitations", "missing_data", "grounding"].map(key => [key, value[key]]));
}
export function validateQuestionGrounding(draft: Json, context: PreparedContext) {
  validate("GeneratedAnswer", draft, true);
  validateGrounding({ summary: draft.answer, why_relevant: draft.answer, claims: draft.claims,
    risks: [], opportunities: [], recommendations: [], limitations: draft.limitations, missing_data: draft.missing_data,
    grounding: { summary: draft.claim_indexes, why_relevant: draft.claim_indexes, risks: [], opportunities: [], recommendations: [] } }, context);
}
