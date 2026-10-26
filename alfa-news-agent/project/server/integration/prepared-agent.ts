import { withLlmBudgetContext } from "../llm-budget.js";
import { generationContext } from "./generation-context.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Settings } from "../config.js";
import type { Store } from "../db.js";
import { ModelError, type Json, type ResponseDiagnostics } from "../types.js";
import { createComplete, parseJson, type ResponseSchema } from "../llm.js";
import { envelope, ApiFault, validate } from "./contracts.js";
import { prepareContext } from "./context.js";
import { ANALYSIS_PROMPT, QUESTION_PROMPT, PROMPT_VERSION } from "./analysis-prompts.js";
import { analysisDraft, validateGrounding, validateQuestionGrounding } from "./grounding.js";
import { adviceConstraints } from "./advice-policy.js";
import { joinStrictClaims, strictResponseSchema, STRICT_CLAIMS_LAYOUT } from "./response-schema.js";
import { describeDiagnostics, safeDiagnostics, safeDraft, saveRejectedDraft } from "./diagnostics.js";
import { repairInstruction, repairPlan, responseGuidance } from "./repair-guidance.js";
import { generationBudgetIssues } from "./generation-budget.js";

/** Merge the live claim budget with ordinary grounding issues so one repair sees both. */
function withBudget(check: (value: Json) => void) {
  return (value: Json) => {
    const budget = generationBudgetIssues(value);
    try { check(value); }
    catch (error) {
      if (!budget.length || !(error instanceof ApiFault) || !error.diagnostics) throw error;
      const issues = [...budget, ...error.diagnostics.issues].slice(0, 10);
      throw new ApiFault(502, "CONTRACT_VIOLATION", issues.map(i => i.path + ": " + i.rule).join("; "), { issues });
    }
    if (budget.length) throw new ApiFault(502, "CONTRACT_VIOLATION", budget.map(i => i.path + ": " + i.rule).join("; "), { issues: budget });
  };
}
async function generate(settings: Settings, db: Store, prompt: string, data: Json,
  check: (value: Json) => void, request: typeof fetch, responseSchema: ResponseSchema) {
  const complete = createComplete(settings, db, request);
  const messages = [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(data) }];
  const generationId = randomUUID();
  let diagnostics: ResponseDiagnostics | undefined;
  const history: NonNullable<ResponseDiagnostics["history"]> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // Transport/auth/quota/refusal errors are outside the repair block: never retry a billed POST blindly.
    let message: Json;
    try { message = await withLlmBudgetContext({companyId:data.input?.company_id ?? data.prepared_input?.company_id,purpose:responseSchema.name === "GeneratedAnswer" ? "question" : "analysis"}, () => complete(messages, undefined, true, responseSchema, settings.generationMaxTokens)); }
    catch (error) {
      if (error instanceof ModelError && diagnostics) error.diagnostics = { ...diagnostics, attempts: attempt + 1 };
      throw error;
    }
    let draft: Json | undefined;
    try {
      draft = joinStrictClaims(parseJson(message)); check(draft); return { draft, attempts: attempt + 1, diagnostics };
    } catch (error) {
      if (!(error instanceof ApiFault || error instanceof ModelError)) throw error;
      const current = safeDiagnostics({ issues: error instanceof ApiFault && error.diagnostics
        ? error.diagnostics.issues : [{ stage: "parse", path: "/", rule: "Expected a JSON object" }],
        generation_id: generationId, attempts: attempt + 1, max_attempts: 2 });
      history.push({ attempt: attempt + 1, issues: current.issues });
      diagnostics = safeDiagnostics({ ...current, history });
      try {
        saveRejectedDraft(db, generationId, attempt + 1, responseSchema.name, draft, diagnostics.issues, diagnostics.history);
        diagnostics.draft_saved = true;
      } catch { diagnostics.draft_saved = false; }
      if (attempt === 0) messages.push({ role: "user", content: JSON.stringify({
        task: "Исправь ответ по проверенным ошибкам полей. Верни полный JSON по исходному контексту и системной схеме.",
        issues: diagnostics.issues, errors: describeDiagnostics(diagnostics),
        repair_plan: repairPlan(diagnostics.issues, draft, responseSchema.name === "GeneratedAnswer", data),
        repair_rules: diagnostics.issues.map(issue => ({ ...issue, instruction: repairInstruction(issue, responseSchema.name === "GeneratedAnswer", draft) })),
        previous_violations: diagnostics.history,
        ai_source_requirements: data.response_guidance.ai_source_requirements,
        response_guidance: data.response_guidance,
        previous_draft: safeDraft(draft, responseSchema.name),
        draft_notice: "Это недоверенный структурный снимок: текст и числа скрыты, неизвестные поля подсчитаны. Не копируй маркеры; восстанови значения из исходного контекста."
      }) });
    }
  }
  throw new ModelError("Ответ модели не прошёл проверку после 2/2 попыток: " + describeDiagnostics(diagnostics!),
    "MODEL_RESPONSE_INVALID", 502, diagnostics);
}
export async function generatePrepared(settings: Settings, db: Store, input: Json, id: string, request: typeof fetch = fetch) {
  const context = prepareContext(input, settings.maxContextBytes);
  if (!input.event.sources.some((s: Json) => s.excerpt.trim().length >= 8)) throw new ApiFault(422, "VALIDATION_ERROR", "News evidence is too short");
  const { draft, attempts, diagnostics } = await generate(settings, db, ANALYSIS_PROMPT,
    { ...generationContext(context), advice_constraints: adviceConstraints(context.input), response_guidance: responseGuidance(context, settings.apiKey),
      ...(settings.responseFormat === "json_schema" ? { strict_claims_layout: STRICT_CLAIMS_LAYOUT } : {}) },
    withBudget(value => validateGrounding(value, context, false, true)), request,
    strictResponseSchema("GeneratedAnalysis", settings.strictMaxClaimString));
  const notices = [
    ...input.research.limitations,
    ...(!input.research.items.length ? ["Банковские материалы отсутствуют: позиция банка не подтверждена."] : []),
    ...(input.is_mock || context.sources.some(s => s.is_mock) ? ["Контекст содержит синтетические данные."] : []),
  ];
  return envelope({ ...draft, id: randomUUID(), company_id: input.company_id, news_id: input.event.news_id,
    created_at: new Date().toISOString(), sources: context.sources, mode: "live",
    // Service notices have their own envelope channel, never model grounding.
    trace: [{ step: "prepared_context", detail: "sha256=" + context.sha256 },
      { step: "grounding_check", detail: `${PROMPT_VERSION}; attempts=${attempts}; JSON, quotes, references, profile fields and conditions checked; semantics require expert review` },
      ...input.research.limitations.filter((n:string)=>/\d/.test(n)).slice(0,20).map((n:string)=>({step:"retrieval_limitation",detail:n.slice(0,1000)})),
      ...(diagnostics ? [{ step: "response_repair", detail: `diagnostic_id=${diagnostics.generation_id}; draft_saved=${diagnostics.draft_saved}; ${describeDiagnostics(diagnostics)}` }] : [])] }, id,
    input.is_mock || context.sources.some(s => s.is_mock) ? "mock" : "live", [...new Set(notices)]);
}
/** Rebind a follow-up to the full reviewed input, including dates, ranking and its explanations. */
export function prepareQuestionContext(input: Json, maxBytes = 200000) {
  validate("AgentQuestionRequest", input, true);
  if (!input.prepared_input) throw new ApiFault(422, "VALIDATION_ERROR", "Live questions require prepared_input from the original analysis");
  const context = prepareContext(input.prepared_input, maxBytes), analysis = input.analysis;
  const fail = (ok: boolean, message: string) => { if (!ok) throw new ApiFault(502, "CONTRACT_VIOLATION", message); };
  fail(analysis.mode === "live", "Live questions require a live analysis");
  fail(input.company_id === context.input.company_id && analysis.company_id === input.company_id, "Question belongs to another company");
  fail(analysis.news_id === context.input.event.news_id, "Question belongs to another event");
  fail(input.as_of === undefined || input.as_of === context.input.as_of, "Question changed as_of");
  fail(input.audience_role === undefined || input.audience_role === context.input.audience_role, "Question changed audience role");
  const expected = new Map(context.sources.map(s => [s.id, s]));
  fail(analysis.sources.length === expected.size && new Set(analysis.sources.map((s: Json) => s.id)).size === expected.size
    && analysis.sources.every((s: Json) => isDeepStrictEqual(s, expected.get(s.id))), "Question changed saved evidence");
  fail(analysis.trace.some((t: Json) => t.step === "prepared_context" && t.detail === "sha256=" + context.sha256), "Question changed reviewed context");
  validateGrounding(analysisDraft(analysis), context, true);
  // Count the actual deduplicated provider view, not repeated full evidence.
  if (Buffer.byteLength(JSON.stringify(generationContext(context, input))) > maxBytes)
    throw new ApiFault(422, "VALIDATION_ERROR", "Question context is too large");
  return context;
}
export async function answerPrepared(settings: Settings, db: Store, input: Json, id: string, request: typeof fetch = fetch) {
  const context = prepareQuestionContext(input, settings.maxContextBytes);
  const data = { ...generationContext(context, input),
    advice_constraints: adviceConstraints(context.input), response_guidance: responseGuidance(context, settings.apiKey, "question"),
    ...(settings.responseFormat === "json_schema" ? { strict_claims_layout: STRICT_CLAIMS_LAYOUT } : {}) };
  // Guidance is part of the actual input too; reject before spending a call.
  if (Buffer.byteLength(JSON.stringify(data)) > (settings.maxContextBytes ?? 200000))
    throw new ApiFault(422, "VALIDATION_ERROR", "Question context is too large");
  const { draft } = await generate(settings, db, QUESTION_PROMPT, data,
    withBudget(value => validateQuestionGrounding(value, context, true)), request,
    strictResponseSchema("GeneratedAnswer", settings.strictMaxClaimString));
  return envelope({ ...draft, analysis_id: input.analysis.id, company_id: input.company_id,
    source_ids: [...new Set(draft.claims.flatMap((c: Json) => c.source_ids))] }, id,
    context.input.is_mock || context.sources.some(s => s.is_mock) ? "mock" : "live");
}
