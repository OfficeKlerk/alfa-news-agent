import { executionConfiguration } from './execution-config.js';
import { DurableAgent } from "../model-execution.js";
import { internalAccess } from "./internal-access.js";
/** Standalone adapters for role 2 or 3; each process owns its own SQLite file. */
import express from "express";
import { createApplication } from "../app.js";
import { budgetStatus } from "../llm-budget.js";
import { loadSettings, ROOT } from "../config.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { LegacyRetrieval } from "./retrieval.js";
import { LegacyAgent } from "./agent.js";
import { boundary, checkBody, send, errorBoundary } from "./gateway.js";
import { ApiFault, envelope } from "./contracts.js";

if (existsSync(resolve(ROOT, ".env"))) loadEnvFile(resolve(ROOT, ".env"));
const settings = loadSettings(), kind = process.env.SERVICE_KIND;
if (kind !== "agent" && kind !== "retrieval") throw new Error("SERVICE_KIND must be agent or retrieval");
if (process.env.AUTH_MODE !== "development" && kind === "agent" && settings.mode !== "live") throw new Error("Private production agent requires live mode");
const runtime = await createApplication({ ...settings, newsEnabled: settings.newsEnabled && kind === "retrieval" });
const app = express(); boundary(app); app.use(internalAccess({...process.env, LLM_MODE:settings.mode}));
const retrieval = new LegacyRetrieval(runtime.db, runtime.retrieval, settings, runtime.collector, process.env.AUTH_MODE === "development"), agent = settings.mode === "live" ? new DurableAgent(runtime.db,new LegacyAgent(settings),executionConfiguration(settings)) : new LegacyAgent(settings);
app.get("/v1/health", (_req, res) => send(res, "HealthDataResponse", envelope({ status: "ok", service: kind }, res.locals.requestId, settings.mode === "demo" ? "demo" : "live")));
if (kind === "retrieval") {
  app.get("/v1/feeds/status", async (_req, res) => send(res, "FeedStatusDataResponse", await retrieval.status(res.locals.requestId)));
  app.post("/v1/news", async (req, res) => { checkBody(req, "IngestRequest"); send(res, "IngestDataResponse", await retrieval.ingest(req.body, res.locals.requestId)); });
  app.post("/v1/feeds/refresh", async (req, res) => { checkBody(req, "FeedRefreshRequest"); send(res, "FeedRefreshDataResponse", await retrieval.refresh(req.body, res.locals.requestId)); });
  app.post("/v1/tools/search_news", async (req, res) => { checkBody(req, "SearchRequest"); send(res, "SearchDataResponse", await retrieval.search(req.body, res.locals.requestId)); });
  app.post("/v1/tools/rag_bank_analytics", async (req, res) => { checkBody(req, "RagRequest"); send(res, "RagDataResponse", await retrieval.rag(req.body, res.locals.requestId)); });
  app.post("/v1/tools/resolve_sources", async (req, res) => { checkBody(req, "ResolveRequest"); send(res, "ResolveDataResponse", await retrieval.resolve(req.body, res.locals.requestId)); });
} else {
  app.get("/v1/budget", (req, res) => {
    const companyId = req.query.company_id;
    if (Object.keys(req.query).some(key => key !== "company_id") || companyId !== undefined
      && (typeof companyId !== "string" || !/^[A-Za-z0-9_:.-]{1,160}$/.test(companyId)))
      throw new ApiFault(422, "VALIDATION_ERROR", "company_id must be a valid company identifier");
    send(res, "BudgetStatusDataResponse", envelope(budgetStatus(settings, runtime.db, companyId as string | undefined),
      res.locals.requestId, settings.mode === "demo" ? "demo" : "live"));
  });
  app.get("/v1/agent/operations/:id",async(req,res)=>{
    const company=req.query.company_id,kind=req.query.kind;
    if(typeof company!=="string"||!company||!["analysis","question"].includes(String(kind)))throw new ApiFault(422,"VALIDATION_ERROR","Company and operation kind required");
    if(!(agent instanceof DurableAgent))throw new ApiFault(503,"DEPENDENCY_UNAVAILABLE","Durable generation is not active");
    send(res,"AgentOperationDataResponse",envelope(await agent.recover(req.params.id,company,kind as "analysis"|"question"),res.locals.requestId,"live"));
  });
  app.use((_req, _res, next) => {
    if (settings.analysisEnabled === false) return next(new ApiFault(503, "DEPENDENCY_UNAVAILABLE", "Генерация выключена. Настройте ключ LLM и запустите с --with-llm; сбор и ранжирование уже доступны."));
    next();
  });
  const requestSignal=(res:express.Response)=>{
    const controller=new AbortController();
    res.once("close",()=>{if(!res.writableEnded)controller.abort();});
    return controller.signal;
  };
  app.post("/v1/agent/analyze", async (req, res) => { checkBody(req,"AgentRequest"); send(res,"AnalysisResponse",await agent.analyze(req.body,res.locals.requestId,requestSignal(res))); });
  app.post("/v1/agent/questions", async (req, res) => { checkBody(req,"AgentQuestionRequest"); send(res,"AnswerResponse",await agent.answer(req.body,res.locals.requestId,requestSignal(res))); });
}
app.use((_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
app.use(errorBoundary);
const server = app.listen(settings.port, settings.host);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void runtime.close().catch(() => { console.error("Provider shutdown failed"); process.exitCode = 1; });
  });
  server.closeIdleConnections();
}
server.on("error", () => { console.error("Provider HTTP server failed"); process.exitCode = 1; shutdown(); });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, shutdown);
