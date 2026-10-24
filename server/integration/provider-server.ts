/** Standalone adapters for role 2 or 3; each process owns its own SQLite file. */
import express from "express";
import { createApplication } from "../app.js";
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
const runtime = await createApplication(settings);
const app = express(); boundary(app);
const retrieval = new LegacyRetrieval(runtime.db, runtime.retrieval, settings), agent = new LegacyAgent(settings);
app.get("/v1/health", (_req, res) => send(res, "HealthDataResponse", envelope({ status: "ok", service: kind }, res.locals.requestId, settings.mode === "demo" ? "demo" : "live")));
if (kind === "retrieval") {
  app.post("/v1/news", async (req, res) => { checkBody(req, "IngestRequest"); send(res, "IngestDataResponse", await retrieval.ingest(req.body, res.locals.requestId)); });
  app.post("/v1/feeds/refresh", async (req, res) => { checkBody(req, "FeedRefreshRequest"); send(res, "FeedRefreshDataResponse", await retrieval.refresh(req.body, res.locals.requestId)); });
  app.post("/v1/tools/search_news", async (req, res) => { checkBody(req, "SearchRequest"); send(res, "SearchDataResponse", await retrieval.search(req.body, res.locals.requestId)); });
  app.post("/v1/tools/rag_bank_analytics", async (req, res) => { checkBody(req, "RagRequest"); send(res, "RagDataResponse", await retrieval.rag(req.body, res.locals.requestId)); });
  app.post("/v1/tools/resolve_sources", async (req, res) => { checkBody(req, "ResolveRequest"); send(res, "ResolveDataResponse", await retrieval.resolve(req.body, res.locals.requestId)); });
} else {
  app.post("/v1/agent/analyze", async (req, res) => { checkBody(req, "AgentRequest"); send(res, "AnalysisResponse", await agent.analyze(req.body, res.locals.requestId)); });
  app.post("/v1/agent/questions", async (req, res) => { checkBody(req, "AgentQuestionRequest"); send(res, "AnswerResponse", await agent.answer(req.body, res.locals.requestId)); });
}
app.use((_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
app.use(errorBoundary);
const server = app.listen(settings.port, settings.host);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(() => void runtime.close()); server.closeIdleConnections(); });
