import express from "express";
import { MockRetrieval } from "./retrieval.js";
import { MockAgent } from "./agent.js";
import { boundary, checkBody, send, errorBoundary } from "./gateway.js";
import { ApiFault, envelope } from "./contracts.js";

const app = express(); boundary(app);
const retrieval = new MockRetrieval(), agent = new MockAgent();
app.get("/v1/health", (_req, res) => send(res, "HealthDataResponse", envelope({ status: "ok", service: "mocks" }, res.locals.requestId, "mock")));
for (const [path, requestSchema, responseSchema, action] of [
  ["/v1/tools/search_news", "SearchRequest", "SearchDataResponse", retrieval.search.bind(retrieval)],
  ["/v1/tools/rag_bank_analytics", "RagRequest", "RagDataResponse", retrieval.rag.bind(retrieval)],
  ["/v1/tools/resolve_sources", "ResolveRequest", "ResolveDataResponse", retrieval.resolve.bind(retrieval)],
  ["/v1/agent/analyze", "AgentRequest", "AnalysisResponse", agent.analyze.bind(agent)],
  ["/v1/agent/questions", "AgentQuestionRequest", "AnswerResponse", agent.answer.bind(agent)],
] as const) app.post(path, async (req, res) => { checkBody(req, requestSchema); send(res, responseSchema, await action(req.body, res.locals.requestId)); });
app.use((_req, _res, next) => next(new ApiFault(404, "NOT_FOUND", "Route not found")));
app.use(errorBoundary);
const server = app.listen(Number(process.env.PORT ?? 8102), process.env.HOST ?? "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
