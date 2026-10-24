import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Settings } from "../config.js";
import type { Store } from "../db.js";
import { ModelError, type Json } from "../types.js";
import { createComplete, parseJson } from "../llm.js";
import { envelope, ApiFault, validate } from "./contracts.js";
import { prepareContext } from "./context.js";
import { ANALYSIS_PROMPT, QUESTION_PROMPT, PROMPT_VERSION } from "./analysis-prompts.js";
import { analysisDraft, validateGrounding, validateQuestionGrounding } from "./grounding.js";
import { adviceConstraints } from "./advice-policy.js";

async function generate(settings: Settings, db: Store, prompt: string, data: Json,
  check: (value: Json) => void, request: typeof fetch) {
  const complete = createComplete(settings, db, request);
  const messages = [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(data) }];
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // Transport/auth/quota/refusal errors are outside the repair block: never retry a billed POST blindly.
    const message = await complete(messages, undefined, true);
    try {
      const draft = parseJson(message); check(draft); return { draft, attempts: attempt + 1 };
    } catch (error) {
      if (!(error instanceof ApiFault || error instanceof ModelError)) throw error;
      reason = error.message;
      messages.push({ role: "user", content: "Проверка JSON не пройдена: " + reason + ". Сформируй заново по исходному контексту, строго по системной схеме." });
    }
  }
  throw new ModelError("Ответ модели не прошёл проверку: " + reason);
}
export async function generatePrepared(settings: Settings, db: Store, input: Json, id: string, request: typeof fetch = fetch) {
  const context = prepareContext(input, settings.maxContextBytes);
  if (!input.event.sources.some((s: Json) => s.excerpt.trim().length >= 8)) throw new ApiFault(422, "VALIDATION_ERROR", "News evidence is too short");
  const { draft, attempts } = await generate(settings, db, ANALYSIS_PROMPT,
    { ...context, advice_constraints: adviceConstraints(context.input) }, value => validateGrounding(value, context), request);
  const notices = [
    ...input.research.limitations,
    ...(!input.research.items.length ? ["Банковские материалы отсутствуют: позиция банка не подтверждена."] : []),
    ...(input.is_mock || context.sources.some(s => s.is_mock) ? ["Контекст содержит синтетические данные."] : []),
  ];
  return envelope({ ...draft, id: randomUUID(), company_id: input.company_id, news_id: input.event.news_id,
    created_at: new Date().toISOString(), sources: context.sources, mode: "live",
    limitations: [...new Set([...draft.limitations, ...notices])],
    trace: [{ step: "prepared_context", detail: "sha256=" + context.sha256 },
      { step: "grounding_check", detail: `${PROMPT_VERSION}; attempts=${attempts}; JSON, quotes, references, profile fields and conditions checked; semantics require expert review` }] }, id,
    input.is_mock || context.sources.some(s => s.is_mock) ? "mock" : "live");
}
/** Rebind a follow-up to the full reviewed input, including dates, ranking and its explanations. */
export function prepareQuestionContext(input: Json, maxBytes = 200000) {
  if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) throw new ApiFault(422, "VALIDATION_ERROR", "Question context is too large");
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
  return context;
}
export async function answerPrepared(settings: Settings, db: Store, input: Json, id: string, request: typeof fetch = fetch) {
  const context = prepareQuestionContext(input, settings.maxContextBytes);
  const { draft } = await generate(settings, db, QUESTION_PROMPT,
    { ...input, as_of: context.input.as_of, audience_role: context.input.audience_role,
      advice_constraints: adviceConstraints(context.input) }, value => validateQuestionGrounding(value, context), request);
  return envelope({ ...draft, analysis_id: input.analysis.id, company_id: input.company_id,
    source_ids: [...new Set(draft.claims.flatMap((c: Json) => c.source_ids))] }, id,
    context.input.is_mock || context.sources.some(s => s.is_mock) ? "mock" : "live");
}
