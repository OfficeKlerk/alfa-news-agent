import type { Access } from "./access.js";
import { createAnalysisEngine } from "./analysis-engine.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { ROOT, type Settings } from "../config.js";
import { LiveService, publicCard, publicJob } from "./live-service.js";
import type { LiveStore } from "./live-store.js";
import { AppError, ModelError, type Json } from "../types.js";
import { ApiFault, validate, validateAnalysis, envelope, type Envelope } from "./contracts.js";
import { ContractClient } from "./client.js";
import { companySource, type AgentPort } from "./agent.js";
import type { RetrievalPort } from "./retrieval.js";
import { prepareContext } from "./context.js";
import { prepareEventForRanking } from "./event-interpretation.js";
import { analysisDraft, validateGrounding, validateQuestionGrounding } from "./grounding.js";
import { safeDiagnostics, diagnosticFailureMessage } from "./diagnostics.js";

export function boundary(app: ReturnType<typeof express>, localHostsOnly = false) {
  app.set("case sensitive routing", true);
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
    if (localHostsOnly) {
      // Loopback binding alone does not stop DNS rebinding from a browser tab.
      // Validate the actual Host, never a client-controlled forwarding header.
      const host = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(req.get("Host") ?? "");
      if (!host || host[2] !== undefined && (Number(host[2]) < 1 || Number(host[2]) > 65535)) {
        next(new ApiFault(403, "FORBIDDEN", "Invalid local Host")); return;
      }
    }
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
  const fault = error instanceof ApiFault ? error : error instanceof ModelError ? new ApiFault(error.status, error.code, error.message, error.diagnostics)
    : error instanceof AppError ? new ApiFault(error.status, error.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", error.message)
    : new ApiFault(error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500,
      error.type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : error.type === "entity.parse.failed" ? "VALIDATION_ERROR" : "INTERNAL_ERROR", "Request failed");
  const diagnostics = fault.diagnostics ? safeDiagnostics(fault.diagnostics) : undefined;
  const details = diagnostics?.issues.length ? diagnostics : undefined;
  res.status(fault.status).json({ schema_version: "1.0.0", request_id: res.locals.requestId,
    error: { code: fault.code, message: details
      ? diagnosticFailureMessage(fault.code, details)
      : fault.diagnostics ? "Response validation failed: invalid diagnostics" : fault.message,
      retryable: !["MODEL_OUTCOME_UNKNOWN","OPERATION_CONFLICT","MODEL_OPERATION_CLOSED","MODEL_UNAVAILABLE","MODEL_TIMEOUT"].includes(fault.code)
        && (fault.code !== "MODEL_LIMIT" || error.budgetExhausted === true) && [429, 503, 504].includes(fault.status), ...(details ? { diagnostics: details } : {}) } });
}
function combine(values: Envelope[], data: Json, id: string): Envelope {
  const mode = values.some(v => v.meta.mode === "mock") ? "mock" : values.some(v => v.meta.mode === "demo") ? "demo" : "live";
  return envelope(data, id, mode, [...new Set(values.flatMap(v => v.meta.warnings))]);
}
function binding(condition: boolean, message: string) {
  if (!condition) throw new ApiFault(502, "CONTRACT_VIOLATION", message);
}

export function createGateway(options: { access: Access; ml: ContractClient; retrieval: RetrievalPort; agent: AgentPort; healthClients?: ContractClient[]; legacy?: ReturnType<typeof express>; maxSessions?: number; ttlMs?: number; maxContextBytes?: number; analysisEnabled?: boolean; liveStore?: LiveStore; settings?: Settings; budget?: (companyId?:string)=>Promise<Json> }) {
  const app = express();
  boundary(app, !options.access.secured && options.settings?.liveEnabled === true && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(options.settings.host));
  options.access.install(app);
  app.use((req,res,next)=>{
    const expected=res.locals.principal ? createHash("sha256").update(res.locals.principal.subject).digest("hex") : "development";
    if(req.get("X-Viewer-Key") && req.get("X-Viewer-Key")!==expected)throw new ApiFault(409,"SESSION_CHANGED","Session identity changed; reload the page");
    next();
  });
  if (options.access.secured) app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = ((body: Json) => {
      if (body?.meta?.mode === "mock" || body?.data?.mode === "demo" || body?.data?.mode === "mock"
        || body?.data?.sources?.some((s: Json) => s.is_mock)
        || body?.data?.items?.some((item: Json) => item?.is_mock || item?.score_kind === "mock"))
        throw new ApiFault(502, "CONTRACT_VIOLATION", "Production dependencies returned synthetic data or a demonstration answer");
      return json(body);
    }) as typeof res.json;
    next();
  });
  const engine = createAnalysisEngine({...options, secured: options.access.secured});
  const live = options.liveStore && options.settings ? new LiveService({store: options.liveStore, settings: options.settings, ml: options.ml, retrieval: options.retrieval, engine, budget: options.budget}) : undefined;
  app.locals.live = live;
  const sessions = new Map<string, { response: Envelope; context: ReturnType<typeof prepareContext>; history: Json[]; owner?: string; expires: number; busy: boolean }>();
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
  app.get("/v1/runtime", (_req, res) => {
    send(res, "RuntimeDataResponse", envelope({ generation_enabled: options.analysisEnabled !== false, viewer_key: res.locals.principal ? createHash("sha256").update(res.locals.principal.subject).digest("hex") : "development" }, res.locals.requestId, "live"));
  });
  app.use((req, _res, next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    if (options.analysisEnabled === false && req.method === "POST" &&
        (["/v1/analyze", "/v1/analyze-event"].includes(path) || /^\/v1\/analyses\/[^/]+\/questions$/.test(path)))
      return next(new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "Генерация выключена. Настройте ключ LLM и запустите с --with-llm; сбор и ранжирование доступны."));
    if (live && req.method === "POST" && (["/v1/analyze", "/v1/analyze-event"].includes(path) || /^\/v1\/analyses\/[^/]+\/questions$/.test(path)))
      return next(new ApiFault(409, "CONFLICT", "В постоянном режиме используйте /live/: генерация выполняется через сохраняемую очередь."));
    next();
  });
  app.get("/v1/companies", async (req, res) => {
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 20);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiFault(422, "VALIDATION_ERROR", "Invalid pagination");
    if (res.locals.principal) {
      const items = res.locals.principal.companies.slice(offset, offset + limit);
      return send(res, "CompaniesDataResponse", envelope({ items, offset, limit }, res.locals.requestId, "live"));
    }
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
    const rankRequest = { ...req.body, events: req.body.events.map(prepareEventForRanking) };
    const result = await options.ml.call("/v1/rank", "RankDataResponse", res.locals.requestId, rankRequest);
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
  app.get("/v1/feeds/status", async (_req, res) => {
    if (!options.retrieval.status) throw new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "Collector status requires a real retrieval provider");
    send(res, "FeedStatusDataResponse", await options.retrieval.status(res.locals.requestId));
  });
  app.post("/v1/tools/rag_bank_analytics", async (req, res) => {
    checkBody(req, "RagRequest");
    send(res, "RagDataResponse", await options.retrieval.rag(req.body, res.locals.requestId));
  });
  app.post("/v1/tools/resolve_sources", async (req, res) => {
    checkBody(req, "ResolveRequest");
    send(res, "ResolveDataResponse", await options.retrieval.resolve(req.body, res.locals.requestId));
  });
  const { assemble } = engine;
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
      const {response:result,context} = await engine.generate(body,id);
      binding(!sessions.has(result.data.id), "Agent reused an analysis ID");
      sessions.set(result.data.id, { response: result, context, history: [], owner: res.locals.principal?.subject, expires: Date.now() + (options.ttlMs ?? 3_600_000), busy: false });
      return result;
      } finally { reservedSessions--; }
    });
    send(res, "AnalysisResponse", response);
  };
  app.post("/v1/analyze", analyze);
  app.post("/v1/analyze-event", analyze);
  const session = (id: string, cid: string, owner?: string) => {
    prune(); const value = sessions.get(id);
    if (!value || value.response.data.company_id !== cid || value.owner !== owner) throw new ApiFault(404, "NOT_FOUND", "Analysis not found for company");
    return value;
  };
  app.get("/v1/analyses/:analysis_id", (req, res) => {
    const cid = String(req.query.company_id ?? "");
    if (!cid) throw new ApiFault(422, "VALIDATION_ERROR", "company_id is required");
    const s = session(req.params.analysis_id, cid, res.locals.principal?.subject);
    send(res, "AnalysisResponse", { ...s.response, meta: { ...s.response.meta, request_id: res.locals.requestId } });
  });
  app.post("/v1/analyses/:analysis_id/questions", async (req, res) => {
    checkBody(req, "QuestionRequest");
    const s = session(req.params.analysis_id, req.body.company_id, res.locals.principal?.subject);
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
  if (live) {
    const actor=(res:Response):string|undefined=>{
      const subject=res.locals.principal?.subject;
      if(options.access.secured && !subject)throw new ApiFault(401,"UNAUTHORIZED","Authenticated identity required");
      return subject;
    };
    const scope = (req: Request) => {
      const company_id = String(req.query.company_id ?? ""), audience_role = String(req.query.audience_role ?? "cfo");
      validate("LiveScanRequest", {company_id, audience_role}); return {company_id, audience_role};
    };
    const result = (res: Response, schema: string, data: Json) => send(res,schema,envelope(data,res.locals.requestId,"live"));
    app.get("/v1/live/feed", (req,res) => {
      const s=scope(req), limit=Number(req.query.limit ?? 20);
      if (!Number.isSafeInteger(limit)||limit<1||limit>100||req.query.favorites !== undefined && !["0","1"].includes(String(req.query.favorites))) throw new ApiFault(422,"VALIDATION_ERROR","Invalid pagination");
      try {
        const page=live.store.feed(s.company_id,{audience_role:s.audience_role,limit,cursor:req.query.cursor === undefined ? undefined : String(req.query.cursor),favorites:req.query.favorites==="1",owner:actor(res)});
        result(res,"LiveFeedDataResponse",{...page,items:page.items.map(publicCard)});
      } catch(error) { if(error instanceof Error && /cursor/i.test(error.message)) throw new ApiFault(422,"VALIDATION_ERROR","Invalid cursor"); throw error; }
    });
    app.post("/v1/live/subscriptions",async(req,res)=>{checkBody(req,"LiveSubscribeRequest"); result(res,"LiveSubscriptionDataResponse",await live.subscribe(req.body));});
    app.post("/v1/live/scan",async(req,res)=>{checkBody(req,"LiveScanRequest"); result(res,"LiveStatusDataResponse",await live.scan(req.body.company_id,req.body.audience_role));});
    app.get("/v1/live/status",async(req,res)=>{ const s=req.query.company_id === undefined ? undefined : scope(req); result(res,"LiveStatusDataResponse",await live.status(s?.company_id,s?.audience_role,actor(res)));});
    app.get("/v1/budget",async(req,res)=>{ const s=req.query.company_id === undefined ? undefined : scope(req); if(!options.budget) throw new ApiFault(503,"DEPENDENCY_UNAVAILABLE","Budget unavailable"); result(res,"BudgetStatusDataResponse",await options.budget(s?.company_id));});
    app.get("/v1/live/jobs",(req,res)=>{ const s=scope(req),limit=Number(req.query.limit ?? 50); if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new ApiFault(422,"VALIDATION_ERROR","Invalid limit"); result(res,"LiveJobsDataResponse",{items:live.store.jobs(s.company_id,limit,actor(res)).map(publicJob)});});
    app.get("/v1/live/jobs/:job_id",(req,res)=>{const s=scope(req),job=live.store.getJob(req.params.job_id,s.company_id,actor(res)); if(!job) throw new ApiFault(404,"NOT_FOUND","Job not found for company"); result(res,"LiveJobDataResponse",publicJob(job));});
    app.get("/v1/live/analyses/:analysis_id",(req,res)=>{
      const s=scope(req),card=live.store.getAnalysis(req.params.analysis_id,s.company_id,actor(res)); if(!card) throw new ApiFault(404,"NOT_FOUND","Analysis not found for company");
      result(res,"LiveDetailDataResponse",{card:publicCard(card),history:card.history,versions:live.store.versions(s.company_id,card.news_id,card.audience_role).map(v=>({id:v.id,revision:v.revision,created_at:v.created_at,stale:v.stale}))});
    });
    app.post("/v1/live/analyses/:analysis_id/favorite",(req,res)=>{checkBody(req,"LiveFavoriteRequest"); const ok=live.store.favorite(req.body.company_id,req.params.analysis_id,req.body.favorite,actor(res)); if(!ok) throw new ApiFault(404,"NOT_FOUND","Analysis not found for company"); result(res,"LiveFavoriteDataResponse",{id:req.params.analysis_id,favorite:req.body.favorite});});
    app.post("/v1/live/analyses/:analysis_id/questions",(req,res)=>{
      checkBody(req,"LiveQuestionRequest");
      try { const job=live.store.enqueueQuestion({...req.body,owner:actor(res),analysis_id:req.params.analysis_id}); res.status(202); result(res,"LiveJobDataResponse",publicJob(job)); }
      catch(error) { if(error instanceof Error && ["Analysis not found","Analysis superseded","Idempotency key reused with different question","Previous question unresolved","Recovery review required"].includes(error.message)) throw new ApiFault(error.message==="Analysis not found"?404:409,error.message==="Analysis not found"?"NOT_FOUND":"CONFLICT",error.message); throw error; }
    });
    app.get("/",(_req,res)=>res.redirect("/live/"));
    app.get("/analysis",(_req,res)=>res.redirect("/live/"));
    app.get("/analysis/",(_req,res)=>res.redirect("/live/"));
    app.use("/live",(_req,res,next)=>{res.set("Content-Security-Policy","default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");next();},express.static(resolve(ROOT,"integration/live_ui"),{dotfiles:"deny",index:"index.html"}));
  }
  app.use("/v1", (_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
  app.get("/integration", (_req, res) => res.sendFile(resolve(ROOT, "integration/frontend/index.html")));
  app.get("/learning", (_req, res) => res.sendFile(resolve(ROOT, "integration/learning_ui/index.html")));
  app.get("/integration/client.js", (_req, res) => res.sendFile(resolve(ROOT, "integration/frontend/client.js")));
  app.use("/analysis", (_req, res, next) => {
    res.set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"); next();
  }, express.static(resolve(ROOT, "integration/analysis_ui"), { dotfiles: "deny", index: "index.html" }));
  if (options.legacy && !live) app.use(options.legacy);
  app.use((_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
  app.use(errorBoundary);
  return app;
}
