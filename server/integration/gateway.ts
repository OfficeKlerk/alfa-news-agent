import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import { AppError, ModelError, type Json } from "../types.js";
import { ApiFault, validate, validateAnalysis, envelope, type Envelope } from "./contracts.js";
import { ContractClient } from "./client.js";
import { companySource, type AgentPort } from "./agent.js";
import type { RetrievalPort } from "./retrieval.js";
import { prepareContext } from "./context.js";
import { analysisDraft, validateGrounding, validateQuestionGrounding } from "./grounding.js";

export function boundary(app: ReturnType<typeof express>) {
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const id = req.get("X-Request-ID") ?? "";
    res.locals.requestId = /^[A-Za-z0-9_:.\-]{1,160}$/.test(id) ? id : randomUUID();
    res.set({ "X-Request-ID": res.locals.requestId, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const started = performance.now();
    res.on("finish", () => {
      if (process.env.INTEGRATION_LOG === "1") console.log(JSON.stringify({ request_id: res.locals.requestId,
        method: req.method, route: req.route?.path ?? "unmatched", status: res.statusCode, elapsed_ms: Math.round(performance.now() - started) }));
    });
    if (req.method === "POST" && req.get("Origin")) {
      try { if (new URL(req.get("Origin")!).host !== req.get("Host")) throw new Error(); }
      catch { next(new ApiFault(403, "FORBIDDEN", "Invalid Origin")); return; }
    }
    next();
  });
  app.use(express.json({ limit: 1_000_000, strict: true }));
}
export function checkBody(req: Request, schema: string) {
  if (!req.is("application/json")) throw new ApiFault(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json");
  validate(schema, req.body);
}
export function send(res: Response, schema: string, value: Envelope) {
  validate(schema, value, true);
  res.json(value);
}
export function errorBoundary(error: Json, _req: Request, res: Response, _next: NextFunction) {
  const fault = error instanceof ApiFault ? error : error instanceof ModelError ? new ApiFault(error.status, error.code, error.message)
    : error instanceof AppError ? new ApiFault(error.status, error.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", error.message)
    : new ApiFault(error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500,
      error.type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : error.type === "entity.parse.failed" ? "VALIDATION_ERROR" : "INTERNAL_ERROR", "Request failed");
  res.status(fault.status).json({ schema_version: "1.0.0", request_id: res.locals.requestId,
    error: { code: fault.code, message: fault.message, retryable: [429, 503, 504].includes(fault.status) } });
}
function combine(values: Envelope[], data: Json, id: string): Envelope {
  const mode = values.some(v => v.meta.mode === "mock") ? "mock" : values.some(v => v.meta.mode === "demo") ? "demo" : "live";
  return envelope(data, id, mode, [...new Set(values.flatMap(v => v.meta.warnings))]);
}
function binding(condition: boolean, message: string) {
  if (!condition) throw new ApiFault(502, "CONTRACT_VIOLATION", message);
}

export function createGateway(options: { ml: ContractClient; retrieval: RetrievalPort; agent: AgentPort; healthClients?: ContractClient[]; legacy?: ReturnType<typeof express>; maxSessions?: number; ttlMs?: number; maxContextBytes?: number }) {
  const app = express(); boundary(app);
  const sessions = new Map<string, { response: Envelope; context: ReturnType<typeof prepareContext>; history: Json[]; expires: number; busy: boolean }>();
  let active = 0;
  let reservedSessions = 0;
  const prune = () => { for (const [id, s] of sessions) if (s.expires < Date.now() && !s.busy) sessions.delete(id); };
  const bounded = async <T,>(task: () => Promise<T>) => {
    if (active >= 2) throw new ApiFault(429, "BUSY", "Two analyses are already running");
    active++;
    try { return await task(); } finally { active--; }
  };
  app.get("/v1/health", async (_req, res) => {
    const values = await Promise.all([options.ml, ...options.healthClients ?? []].map(client => client.call("/v1/health", "HealthDataResponse", res.locals.requestId)));
    send(res, "HealthDataResponse", combine(values, { status: "ok", service: "gateway" }, res.locals.requestId));
  });
  app.get("/v1/companies", async (req, res) => {
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 20);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiFault(422, "VALIDATION_ERROR", "Invalid pagination");
    send(res, "CompaniesDataResponse", await options.ml.call(`/v1/companies?offset=${offset}&limit=${limit}`, "CompaniesDataResponse", res.locals.requestId));
  });
  app.get("/v1/companies/:company_id", async (req, res) => {
    validate("AnalyzeRequest", { company_id: req.params.company_id, news_id: "check", as_of: new Date().toISOString(), audience_role: "cfo" });
    const value = await options.ml.call("/v1/companies/" + encodeURIComponent(req.params.company_id), "ProfileResponse", res.locals.requestId);
    binding(value.data.company_id === req.params.company_id, "Wrong company from ML");
    send(res, "ProfileResponse", value);
  });
  app.post("/v1/rank", async (req, res) => {
    checkBody(req, "RankRequest");
    const cutoff = Date.parse(req.body.as_of);
    for (const event of req.body.events as Json[]) {
      if (Date.parse(event.published_at) <= cutoff && event.sources.some((source: Json) =>
        source.published_at && Date.parse(source.published_at) > cutoff)) {
        throw new ApiFault(422, "VALIDATION_ERROR", "News evidence is later than the ranking date");
      }
    }
    const result = await options.ml.call("/v1/rank", "RankDataResponse", res.locals.requestId, req.body);
    binding(result.data.company_id === req.body.company_id && result.data.as_of === req.body.as_of, "Wrong rank context");
    binding(result.data.items.every((item: Json) => req.body.events.some((event: Json) => event.news_id === item.news_id && event.event_id === item.event_id)), "Rank returned an unknown event");
    send(res, "RankDataResponse", result);
  });
  app.get("/v1/learning/status", async (req, res) => {
    send(res, "LearningStatusDataResponse", await options.ml.call("/v1/learning/status", "LearningStatusDataResponse",
      res.locals.requestId, undefined, { "X-Learning-Token": req.get("X-Learning-Token") ?? "" }));
  });
  app.post("/v1/learning/feedback", async (req, res) => {
    checkBody(req, "FeedbackRequest");
    send(res, "FeedbackDataResponse", await options.ml.call("/v1/learning/feedback", "FeedbackDataResponse",
      res.locals.requestId, req.body, { "X-Learning-Token": req.get("X-Learning-Token") ?? "" }));
  });
  app.post("/v1/tools/search_news", async (req, res) => {
    checkBody(req, "SearchRequest");
    send(res, "SearchDataResponse", await options.retrieval.search(req.body, res.locals.requestId));
  });
  app.post("/v1/news", async (req, res) => {
    checkBody(req, "IngestRequest");
    if (!options.retrieval.ingest) throw new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "News import requires a writable retrieval provider");
    send(res, "IngestDataResponse", await options.retrieval.ingest(req.body, res.locals.requestId));
  });
  app.post("/v1/feeds/refresh", async (req, res) => {
    checkBody(req, "FeedRefreshRequest");
    if (!options.retrieval.refresh) throw new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "RSS refresh requires a writable retrieval provider");
    send(res, "FeedRefreshDataResponse", await options.retrieval.refresh(req.body, res.locals.requestId));
  });
  app.post("/v1/tools/rag_bank_analytics", async (req, res) => {
    checkBody(req, "RagRequest");
    send(res, "RagDataResponse", await options.retrieval.rag(req.body, res.locals.requestId));
  });
  app.post("/v1/tools/resolve_sources", async (req, res) => {
    checkBody(req, "ResolveRequest");
    send(res, "ResolveDataResponse", await options.retrieval.resolve(req.body, res.locals.requestId));
  });
  const assemble = async (body: Json, id: string) => {
      const [profile, news] = await Promise.all([
        options.ml.call("/v1/companies/" + encodeURIComponent(body.company_id), "ProfileResponse", id),
        body.event ? Promise.resolve(envelope({ items: [body.event] }, id, body.event.is_mock ? "mock" : "live", ["user_supplied_event"]))
          : options.retrieval.search({ query: "", as_of: body.as_of, limit: 1, news_id: body.news_id }, id),
      ]);
      validate("SearchDataResponse", news, true);
      binding(profile.data.company_id === body.company_id, "Wrong company from ML");
      const event = news.data.items[0];
      if (!event) throw new ApiFault(404, "NOT_FOUND", "News not found at as_of");
      if (Date.parse(event.published_at) > Date.parse(body.as_of)) throw new ApiFault(422, "VALIDATION_ERROR", "News is later than analysis date");
      binding(event.news_id === (body.event?.news_id ?? body.news_id), "Wrong event");
      const [rank, research] = await Promise.all([
        options.ml.call("/v1/rank", "RankDataResponse", id, { company_id: body.company_id, events: [event], as_of: body.as_of, limit: 1 }),
        options.retrieval.rag({ query: event.title.slice(0, 500), as_of: body.as_of, limit: 5 }, id),
      ]);
      validate("RagDataResponse", research, true);
      binding(rank.data.company_id === body.company_id && rank.data.as_of === body.as_of, "Wrong rank context");
      const item = rank.data.items[0];
      binding(Boolean(item) && item.news_id === event.news_id && item.event_id === event.event_id, "Wrong ranked event");
      binding(research.data.items.every((s: Json) => s.kind === "bank" && s.published_at && Date.parse(s.published_at) <= Date.parse(body.as_of)), "RAG must return dated bank evidence no later than as_of");
      const inputs = [profile, news, rank, research];
      const input = { company_id: body.company_id, profile: profile.data, event, ranked_item: item, research: research.data,
        as_of: body.as_of, audience_role: body.audience_role, is_mock: inputs.some(v => v.meta.mode === "mock") };
      validate("AgentRequest", input, true);
      return { inputs, input, context: prepareContext(input, options.maxContextBytes), event, research };
  };
  app.post("/v1/analysis-context", async (req, res) => {
    checkBody(req, "AnalysisEventRequest");
    const { inputs, context } = await assemble(req.body, res.locals.requestId);
    send(res, "PreparedContextDataResponse", combine(inputs, context, res.locals.requestId));
  });
  const analyze = async (req: Request, res: Response) => {
    checkBody(req, req.path === "/v1/analyze-event" ? "AnalysisEventRequest" : "AnalyzeRequest");
    const response = await bounded(async () => {
      prune();
      if (sessions.size + reservedSessions >= (options.maxSessions ?? 100)) throw new ApiFault(429, "BUSY", "Session storage full; wait for expiry or restart development stack");
      reservedSessions++;
      try {
      const id = res.locals.requestId, body = req.body;
      const { input, inputs, context, event, research } = await assemble(body, id);
      if (body.expected_context_sha256 && body.expected_context_sha256 !== context.sha256)
        throw new ApiFault(409, "CONFLICT", "Context changed; review a new preview before generating");
      const answer = await options.agent.analyze(structuredClone(input), id);
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
      const result = combine([...inputs, ...additional, answer], answer.data, id);
      validate("AnalysisResponse", result, true);
      binding(!sessions.has(result.data.id), "Agent reused an analysis ID");
      sessions.set(result.data.id, { response: result, context, history: [], expires: Date.now() + (options.ttlMs ?? 3_600_000), busy: false });
      return result;
      } finally { reservedSessions--; }
    });
    send(res, "AnalysisResponse", response);
  };
  app.post("/v1/analyze", analyze);
  app.post("/v1/analyze-event", analyze);
  const session = (id: string, cid: string) => {
    prune(); const value = sessions.get(id);
    if (!value || value.response.data.company_id !== cid) throw new ApiFault(404, "NOT_FOUND", "Analysis not found for company");
    return value;
  };
  app.get("/v1/analyses/:analysis_id", (req, res) => {
    const cid = String(req.query.company_id ?? "");
    if (!cid) throw new ApiFault(422, "VALIDATION_ERROR", "company_id is required");
    const s = session(req.params.analysis_id, cid);
    send(res, "AnalysisResponse", { ...s.response, meta: { ...s.response.meta, request_id: res.locals.requestId } });
  });
  app.post("/v1/analyses/:analysis_id/questions", async (req, res) => {
    checkBody(req, "QuestionRequest");
    const s = session(req.params.analysis_id, req.body.company_id);
    if (s.busy) throw new ApiFault(409, "CONFLICT", "Another question is running for this analysis");
    s.busy = true;
    try {
      const result = await bounded(() => options.agent.answer(structuredClone({ ...req.body, analysis: s.response.data, history: s.history.slice(-10),
        as_of: s.context.input.as_of, audience_role: s.context.input.audience_role, prepared_input: s.context.input }), res.locals.requestId));
      validate("AnswerResponse", result, true);
      const ids = new Set(s.response.data.sources.map((source: Json) => source.id));
      binding(result.data.analysis_id === req.params.analysis_id && result.data.company_id === req.body.company_id && result.data.source_ids.every((id: string) => ids.has(id)), "Answer changed context or sources");
      if (s.response.data.mode === "live") {
        const draft = Object.fromEntries(["answer", "claims", "claim_indexes", "limitations", "missing_data"].map(key => [key, result.data[key]]));
        validateQuestionGrounding(draft, s.context);
        binding(result.data.claims.every((c: Json) => c.source_ids.every((id: string) => result.data.source_ids.includes(id))), "Answer citation list omits claim evidence");
      }
      s.history.push({ question: req.body.question, answer: result.data.answer });
      s.history = s.history.slice(-10);
      send(res, "AnswerResponse", combine([s.response, result], result.data, res.locals.requestId));
    } finally { s.busy = false; }
  });
  app.use("/v1", (_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
  app.get("/integration", (_req, res) => res.sendFile(resolve(ROOT, "integration/frontend/index.html")));
  app.get("/learning", (_req, res) => res.sendFile(resolve(ROOT, "integration/learning_ui/index.html")));
  app.get("/integration/client.js", (_req, res) => res.sendFile(resolve(ROOT, "integration/frontend/client.js")));
  app.use("/analysis", (_req, res, next) => {
    res.set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"); next();
  }, express.static(resolve(ROOT, "integration/analysis_ui"), { dotfiles: "deny", index: "index.html" }));
  if (options.legacy) app.use(options.legacy);
  app.use((_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
  app.use(errorBoundary);
  return app;
}
