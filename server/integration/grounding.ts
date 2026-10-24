import type { Json } from "../types.js";
import { ApiFault, validate } from "./contracts.js";
import type { prepareContext } from "./context.js";
import { adviceConstraints } from "./advice-policy.js";

export type PreparedContext = ReturnType<typeof prepareContext>;
const roots = new Set(["industry", "scale", "company_attributes", "bank_products", "foreign_trade", "geography",
  "dataset_position", "group", "related_companies", "counterparties", "payment_summary"]);
function reject(message: string, path = "/claims"): never {
  throw new ApiFault(502, "CONTRACT_VIOLATION", path + ": " + message,
    { issues: [{ stage: "grounding", path, rule: message }] });
}
const nonblank = (s: unknown) => typeof s === "string" && Boolean(s.trim());
export function profileValue(profile: Json, path: string, location = "/claims"): unknown {
  const parts = path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!roots.has(parts[0]) || parts.some(s => ["__proto__", "prototype", "constructor", "source", "evidence", "limitation"].includes(s))) reject("Invalid business profile path", location);
  if (parts[0] === "payment_summary" && parts[1] === "counterparty_context" && ["method", "scope"].includes(parts[2]))
    reject("Payment aggregation metadata is not a business fact", location);
  let value: any = profile;
  for (const key of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) reject("Unknown profile path", location);
    value = value[key];
  }
  if (value !== null && typeof value === "object" && !(Array.isArray(value) && value.every(v => v === null || typeof v !== "object"))) reject("Profile path must select a concrete value", location);
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
  if (!answer.limitations.every(nonblank)) reject("Blank limitation", "/limitations/" + answer.limitations.findIndex((v: unknown) => !nonblank(v)));
  if (adviceConstraints(context.input).no_new_risk_or_opportunity && (answer.risks.length || answer.opportunities.length))
    reject("Unchanged rate or unconfirmed applicability allows review only, not new risks/opportunities", answer.risks.length ? "/risks" : "/opportunities");
  const sources = new Map<string, Json>(context.sources.map(s => [s.id, s]));
  const companyId = context.input.company_id as string;
  // A numeric suffix in an identifier is not financial evidence. Permit the literal ID in prose without admitting its number on its own.
  const withoutCompanyId = (text: string) => /[A-Za-z_:]/.test(companyId) ? text.split(companyId).join(" ") : text;
  const scan = (text: string) => numbers(withoutCompanyId(text));
  const supports: string[] = [];
  for (const [index, c] of (answer.claims as Json[]).entries()) {
    const path = "/claims/" + index;
    if (!nonblank(c.text)) reject("Blank claim text", path + "/text");
    const unknownSource = c.source_ids.findIndex((id: string) => !sources.has(id));
    if (unknownSource !== -1) reject("Unknown claim source", path + "/source_ids/" + unknownSource);
    if (c.kind !== "ai") {
      const kind = c.kind === "fact" ? "news" : "bank";
      if (c.quote.trim().length < 8) reject("Quote must contain at least eight nonblank characters", path + "/quote");
      if (c.text !== c.quote) reject("Claim text must equal its verbatim quote", path + "/text");
      if (!c.source_ids.every((id: string) => sources.get(id)!.kind === kind)) reject("Quote source has the wrong evidence kind", path + "/source_ids");
      if (!c.source_ids.every((id: string) => sources.get(id)!.excerpt.includes(c.quote))) reject("Quote not found in selected evidence", path + "/quote");
      supports.push(c.quote);
    } else {
      if (c.quote !== "") reject("AI claim quote must be empty", path + "/quote");
      if (!c.source_ids.includes("company:" + context.input.company_id)) reject("AI claim needs the selected company source", path + "/source_ids");
      if (!c.source_ids.some((id: string) => context.input.event.sources.some((s: Json) => s.id === id))) reject("AI claim needs a selected news source", path + "/source_ids");
      if (!c.profile_paths?.length) reject("AI claim needs business profile paths", path + "/profile_paths");
      if (!c.conditions?.length || !c.conditions.every(nonblank)) reject("AI claim needs nonblank conditions", path + "/conditions");
      const values = c.profile_paths.map((pointer: string, i: number) => profileValue(context.input.profile, pointer, path + "/profile_paths/" + i));
      if (values.some((v: unknown) => v === null || v === "unknown" || v === "" || Array.isArray(v) && !v.length)
        && (!answer.missing_data.some(nonblank) || !answer.limitations.some(nonblank))) reject("Unknown business field needs missing data and limitation", !answer.missing_data.some(nonblank) ? "/missing_data" : "/limitations");
      // Only selected news/bank excerpts and selected business values may supply numbers.
      const evidence = c.source_ids.filter((id: string) => sources.get(id)!.kind !== "company").map((id: string) => sources.get(id)!.excerpt).join(" ");
      supports.push(evidence + " " + JSON.stringify(values));
      const allowed = new Set(scan(supports.at(-1)!));
      if (scan(c.text + " " + c.conditions.join(" ")).some(n => !allowed.has(n))) reject("Unsupported numeric assertion", path);
      if (hasFinancialFigure(withoutCompanyId(c.text + " " + c.conditions.join(" ")))) reject("AI financial figures must be verbatim fact/bank quotes, not company impact", path);
    }
  }
  const used = new Set<number>();
  function section(text: string, indexes: number[], kind: string, path: string, refsPath: string) {
    if (!indexes.length) reject("Unknown claim index", refsPath);
    const invalid = indexes.findIndex(i => i >= answer.claims.length);
    if (invalid !== -1) reject("Unknown claim index", refsPath + "/" + invalid);
    if (!indexes.some(i => answer.claims[i].kind === kind)) reject("Wrong evidence type for section", refsPath);
    indexes.forEach(i => used.add(i));
    const allowed = new Set(indexes.flatMap(i => scan(supports[i])));
    if (scan(text).some(n => !allowed.has(n))) reject("Unsupported section number", path);
    // Only the exact quoted passage can carry a financial figure. Reusing its number elsewhere is not support.
    const generated = indexes.filter(i => answer.claims[i].kind !== "ai")
      .reduce((value, i) => value.split(answer.claims[i].quote).join(" "), text);
    if (hasFinancialFigure(withoutCompanyId(generated))) reject("Section financial figures must be verbatim fact/bank quotes", path);
  }
  const g = answer.grounding;
  section(answer.summary, g.summary, "fact", "/summary", "/grounding/summary"); section(answer.why_relevant, g.why_relevant, "ai", "/why_relevant", "/grounding/why_relevant");
  for (const key of ["risks", "opportunities", "recommendations"]) {
    if (answer[key].length !== g[key].length) reject("Section and grounding length mismatch", "/grounding/" + key);
    answer[key].forEach((text: string, i: number) => {
      const refs = key === "recommendations" ? g[key][i].claim_indexes : g[key][i];
      const rec = key === "recommendations" ? g[key][i] : null;
      const path = "/" + key + "/" + i, groundingPath = "/grounding/" + key + "/" + i;
      const refsPath = groundingPath + (rec ? "/claim_indexes" : "");
      // Check references before dereferencing conditions; invalid indices have their own diagnostic.
      if (refs.some((index: number) => index >= answer.claims.length)) reject("Unknown claim index", refsPath + "/" + refs.findIndex((index: number) => index >= answer.claims.length));
      if (rec && !nonblank(rec.condition)) reject("Recommendation needs condition and required data", groundingPath + "/condition");
      if (rec && !rec.required_data.every(nonblank)) reject("Recommendation needs condition and required data", groundingPath + "/required_data");
      if (rec && !refs.some((index: number) => answer.claims[index]?.kind === "ai" && answer.claims[index].conditions.includes(rec.condition)))
        reject("Recommendation condition and required data must match: condition must match its AI claim", groundingPath + "/condition");
      if (rec && !rec.required_data.every((item: string) => answer.missing_data.includes(item)))
        reject("Recommendation condition and required data must match: required_data must match missing_data", groundingPath + "/required_data");
      section(text + (rec ? " " + rec.condition + " " + rec.required_data.join(" ") : ""), refs, "ai", path, refsPath);
    });
  }
  const allowedNotes = new Set(supports.flatMap(value => scan(value)));
  for (const key of ["limitations", "missing_data"]) for (const [i, note] of answer[key].entries()) {
    const path = "/" + key + "/" + i;
    if (scan(note).some(n => !allowedNotes.has(n))) reject("Unsupported limitation or missing-data number", path);
    if (hasFinancialFigure(withoutCompanyId(note))) reject("Financial figures are not allowed in limitations or missing_data", path);
  }
  if (used.size !== answer.claims.length) reject("Unused claim", "/claims/" + answer.claims.findIndex((_: Json, i: number) => !used.has(i)));
}
export function analysisDraft(value: Json) {
  return Object.fromEntries(["summary", "why_relevant", "claims", "risks", "opportunities", "recommendations", "limitations", "missing_data", "grounding"].map(key => [key, value[key]]));
}
export function validateQuestionGrounding(draft: Json, context: PreparedContext) {
  validate("GeneratedAnswer", draft, true);
  try { validateGrounding({ summary: draft.answer, why_relevant: draft.answer, claims: draft.claims,
    risks: [], opportunities: [], recommendations: [], limitations: draft.limitations, missing_data: draft.missing_data,
    grounding: { summary: draft.claim_indexes, why_relevant: draft.claim_indexes, risks: [], opportunities: [], recommendations: [] } }, context);
  } catch (error) {
    if (!(error instanceof ApiFault) || !error.diagnostics) throw error;
    const issues = error.diagnostics.issues.map(issue => ({ ...issue,
      path: issue.path.replace(/^\/(summary|why_relevant)(?=\/|$)/, "/answer")
        .replace(/^\/grounding\/(summary|why_relevant)(?=\/|$)/, "/claim_indexes") }));
    throw new ApiFault(error.status, error.code, issues.map(i => i.path + ": " + i.rule).join("; "), { issues });
  }
}
