import { bankQuery } from "./bank-query.js";
import { isDeepStrictEqual } from "node:util";
import type { Json } from "../types.js";
import { ApiFault, validate, validateAnalysis, envelope, type Envelope } from "./contracts.js";
import type { ContractClient } from "./client.js";
import { companySource, type AgentPort } from "./agent.js";
import type { RetrievalPort } from "./retrieval.js";
import { prepareContext } from "./context.js";
import { prepareEventForRanking } from "./event-interpretation.js";
import { analysisDraft, validateGrounding, validateQuestionGrounding } from "./grounding.js";
export function combined(values: Envelope[], data: Json, id: string): Envelope {
 const mode = values.some(v=>v.meta.mode==="mock") ? "mock" : values.some(v=>v.meta.mode==="demo") ? "demo" : "live";
 return envelope(data,id,mode,[...new Set(values.flatMap(v=>v.meta.warnings))]);
}
function binding(ok: boolean, message: string) { if(!ok) throw new ApiFault(502,"CONTRACT_VIOLATION",message); }
export type AnalysisEngine = ReturnType<typeof createAnalysisEngine>;
/** Shared validation boundary for manual and queued generation. */
export function createAnalysisEngine(options: {secured?:boolean;ml:ContractClient;retrieval:RetrievalPort;agent:AgentPort;maxContextBytes?:number}) {
  const assemble = async (body: Json, id: string) => {
      const [profile, news] = await Promise.all([
        options.ml.call("/v1/companies/" + encodeURIComponent(body.company_id), "ProfileResponse", id),
        body.event ? Promise.resolve(envelope({ items: [body.event] }, id, body.event.is_mock ? "mock" : "live", ["user_supplied_event"]))
          : options.retrieval.search({ query: "", as_of: body.as_of, limit: 1, news_id: body.news_id }, id),
      ]);
      validate("SearchDataResponse", news, true);
      binding(profile.data.company_id === body.company_id, "Wrong company from ML");
      const sourceEvent = news.data.items[0];
      const event = sourceEvent ? prepareEventForRanking(sourceEvent) : undefined;
      if (!event) throw new ApiFault(404, "NOT_FOUND", "News not found at as_of");
      if (Date.parse(event.published_at) > Date.parse(body.as_of)) throw new ApiFault(422, "VALIDATION_ERROR", "News is later than analysis date");
      binding(event.news_id === (body.event?.news_id ?? body.news_id), "Wrong event");
      const [rank, research] = await Promise.all([
        options.ml.call("/v1/rank", "RankDataResponse", id, { company_id: body.company_id, events: [event], as_of: body.as_of, limit: 1 }),
        options.retrieval.rag({ query: bankQuery(event, profile.data), as_of: body.as_of, limit: 5 }, id),
      ]);
      validate("RagDataResponse", research, true);
      binding(rank.data.company_id === body.company_id && rank.data.as_of === body.as_of, "Wrong rank context");
      const item = rank.data.items[0];
      binding(Boolean(item) && item.news_id === event.news_id && item.event_id === event.event_id, "Wrong ranked event");
      binding(research.data.items.every((s: Json) => s.kind === "bank" && s.published_at && Date.parse(s.published_at) <= Date.parse(body.as_of)), "RAG must return dated bank evidence no later than as_of");
      const inputs = [profile, news, rank, research];
      const evidenceLimitations = [
        ...(body.event && body.event.content?.scope !== "article_full" ? ["Анализ ограничен переданным текстом новости. Он может быть анонсом RSS или сокращённым фрагментом; полный текст страницы по ссылке не проверялся."] : []),
        ...(news.meta.warnings.includes("rss_excerpt_only_full_article_not_fetched") ? ["Доступен текст из RSS; полный текст статьи по ссылке не загружался. Выводы ограничены предоставленным фрагментом."] : []),
        ...([...news.meta.warnings, ...(event.content?.warnings ?? [])].includes("source_text_truncated_18000") ? ["Текст источника сокращён при загрузке; отсутствие сведений во фрагменте не доказывает их отсутствие в статье."] : []),
      ];
      const input = { company_id: body.company_id, profile: profile.data, event, ranked_item: item, research: { ...research.data, limitations: [...research.data.limitations, ...evidenceLimitations] },
        as_of: body.as_of, audience_role: body.audience_role, is_mock: inputs.some(v => v.meta.mode === "mock") };
      validate("AgentRequest", input, true);
      if(options.secured && input.is_mock) throw new ApiFault(422,"VALIDATION_ERROR","Production requires real inputs");
      return { inputs, input, context: prepareContext(input, options.maxContextBytes), event, research };
  };
  const generate = async(body:Json,id:string, prepared?:Awaited<ReturnType<typeof assemble>>,signal?:AbortSignal) => {
      const { input, inputs, context, event, research } = prepared ?? await assemble(body, id);
      if (body.expected_context_sha256 && body.expected_context_sha256 !== context.sha256)
        throw new ApiFault(409, "CONFLICT", "Context changed; review a new preview before generating");
      const answer = await options.agent.analyze(structuredClone(input), id,signal);
      validateAnalysis(answer.data);
      binding(answer.data.company_id === body.company_id && answer.data.news_id === event.news_id, "Agent changed company or news");
      if (answer.data.mode === "live") validateGrounding(analysisDraft(answer.data), context, true);
      const allowed = new Map<string, Json>([companySource(input), ...event.sources, ...research.data.items].map((s: Json) => [s.id, s]));
      const extraIds = answer.data.sources.filter((s: Json) => !allowed.has(s.id)).map((s: Json) => s.id);
      const additional: Envelope[] = [];
      if (extraIds.length) {
        binding(answer.data.mode !== "live", "Prepared generation cannot add sources outside reviewed context");
        binding(extraIds.length <= 50, "Too many additional sources");
        const resolved = await options.retrieval.resolve({ source_ids: extraIds, as_of: body.as_of }, id);
        validate("ResolveDataResponse", resolved, true);
        binding(resolved.data.unknown_ids.length === 0 && resolved.data.items.length === extraIds.length, "Agent used unregistered sources");
        for (const s of resolved.data.items) {
          binding(extraIds.includes(s.id) && s.kind !== "company" && s.published_at && Date.parse(s.published_at) <= Date.parse(body.as_of), "Invalid additional source");
          allowed.set(s.id, s);
        }
        additional.push(resolved);
      }
      binding(answer.data.sources.every((s: Json) => { const old = allowed.get(s.id); return old && isDeepStrictEqual(s, old); }), "Agent invented or changed evidence");
      const result = combined([...inputs, ...additional, answer], answer.data, id);
      validate("AnalysisResponse", result, true);
      return {response:result,context};
  };
  const answer = async(saved:{response:Envelope;context:ReturnType<typeof prepareContext>;history:Json[]}, question:string,id:string,signal?:AbortSignal) => {
    const s=saved, analysisId=s.response.data.id, companyId=s.response.data.company_id;
    const result=await options.agent.answer(structuredClone({company_id:companyId,question,analysis:s.response.data,
      history:s.history.slice(-10).map(h=>({question:h.question,answer:h.answer})),as_of:s.context.input.as_of,
      audience_role:s.context.input.audience_role,prepared_input:s.context.input}),id,signal);
    validate("AnswerResponse",result,true);
    const ids=new Set(s.response.data.sources.map((source:Json)=>source.id));
    binding(result.data.analysis_id===analysisId && result.data.company_id===companyId && result.data.source_ids.every((sid:string)=>ids.has(sid)),"Answer changed context or sources");
    if(s.response.data.mode==="live") {
      const draft=Object.fromEntries(["answer","claims","claim_indexes","limitations","missing_data"].map(k=>[k,result.data[k]]));
      validateQuestionGrounding(draft,s.context);
      binding(result.data.claims.every((c:Json)=>c.source_ids.every((sid:string)=>result.data.source_ids.includes(sid))),"Answer citation list omits claim evidence");
    }
    return combined([s.response,result],result.data,id);
  };
  const recover = async(id:string,company:string,kind:"analysis"|"question") => options.agent.recover ? options.agent.recover(id,company,kind) : {state:"unsupported"};
  return {assemble,generate,answer,recover};
}
