import { executionConfiguration } from './execution-config.js';
import { DurableAgent } from "../model-execution.js";
import { accessFromEnv } from "./access.js";
import { createApplication } from "../app.js";
import { loadSettings, ROOT } from "../config.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createGateway } from "./gateway.js";
import { ContractClient } from "./client.js";
import { MockRetrieval, LegacyRetrieval, HttpRetrieval } from "./retrieval.js";
import { LiveStore } from "./live-store.js";
import type { LiveService } from "./live-service.js";
import { budgetStatus } from "../llm-budget.js";
import { randomUUID } from "node:crypto";
import { MockAgent, LegacyAgent, HttpAgent } from "./agent.js";

if (existsSync(resolve(ROOT, ".env"))) loadEnvFile(resolve(ROOT, ".env"));
const settings = loadSettings();
const access = await accessFromEnv({...process.env, LLM_MODE: settings.mode});
const internalHeaders: Record<string,string> = process.env.INTERNAL_API_TOKEN ? {"X-Internal-Token":process.env.INTERNAL_API_TOKEN} : {};
const client = (url:string, timeout=5000) => new ContractClient(url,timeout,fetch,internalHeaders);
const retrievalMode = process.env.RETRIEVAL_MODE ?? "http", agentMode = process.env.AGENT_MODE ?? "http";
if (!["mock", "legacy", "http"].includes(retrievalMode) || !["mock", "legacy", "http"].includes(agentMode)) throw new Error("Invalid integration provider mode");
if (access.secured && (retrievalMode === "mock" || agentMode === "mock" || agentMode === "legacy" && settings.mode !== "live")) throw new Error("Authenticated deployment requires real providers");
const runtime = await createApplication({ ...settings, newsEnabled: settings.newsEnabled && retrievalMode === "legacy" });
const retrievalClient = client(process.env.RETRIEVAL_URL ?? "http://127.0.0.1:8102");
const agentClient = client(process.env.AGENT_URL ?? "http://127.0.0.1:8102", 2 * settings.timeout + 15000);
const retrieval = retrievalMode === "legacy" ? new LegacyRetrieval(runtime.db, runtime.retrieval, settings, runtime.collector, !access.secured) : retrievalMode === "mock" ? new MockRetrieval()
  : new HttpRetrieval(retrievalClient);
const agent = agentMode === "legacy" ? (settings.mode === "live" ? new DurableAgent(runtime.db,new LegacyAgent(settings),executionConfiguration(settings)) : new LegacyAgent(settings)) : agentMode === "mock" ? new MockAgent()
  : new HttpAgent(agentClient);
const healthClients = [retrievalMode === "http" ? retrievalClient : null,
  agentMode === "http" ? client(process.env.AGENT_URL ?? "http://127.0.0.1:8102", 3000) : null].filter((c): c is ContractClient => c !== null);
const app = createGateway({ access, ml: client(process.env.ML_URL ?? "http://127.0.0.1:8101"), retrieval, agent, healthClients, legacy: runtime.app, maxContextBytes: settings.maxContextBytes, analysisEnabled: settings.analysisEnabled, settings,
  liveStore: settings.liveEnabled ? new LiveStore(runtime.db) : undefined,
  budget: async(companyId) => agentMode === "http" ? (await agentClient.call("/v1/budget" + (companyId ? "?company_id=" + encodeURIComponent(companyId) : ""), "BudgetStatusDataResponse", randomUUID(), undefined, {}, 5000)).data : budgetStatus(settings,runtime.db,companyId) });
const live = app.locals.live as LiveService | undefined;
if (live) {
  const initial:unknown=JSON.parse(process.env.LIVE_COMPANY_IDS_JSON ?? "[]");
  if (!Array.isArray(initial)||initial.length>(settings.liveMaxCompanies ?? 100)||!initial.every(cid=>typeof cid==="string"&&/^[A-Za-z0-9_.:-]{1,160}$/.test(cid))) throw new Error("Invalid LIVE_COMPANY_IDS_JSON");
  const companies = new Set([...live.store.subscriptions().filter(s=>s.enabled).map(s=>s.company_id),...initial]);
  if (companies.size > (settings.liveMaxCompanies ?? 100)) throw new Error("LIVE_COMPANY_IDS_JSON exceeds company limit");
  // Discovery validates each profile and records transient dependency failures;
  // optional startup subscriptions must not crash the HTTP service while ML boots.
  for (const company_id of initial) live.store.subscribe({company_id,audience_role:"cfo",limit:settings.liveCompanyNewsLimit ?? 5,min_score:settings.liveMinScore ?? 0.2});
  live.start();
}
const server = app.listen(settings.port, settings.host, () => console.log(`Integration: http://localhost:${settings.port}${live ? "/live/" : "/integration"}`));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close(); server.closeIdleConnections();
  void (async()=>{await live?.stop(); await runtime.close();})();
});
server.on("error", () => { void (async()=>{await live?.stop();await runtime.close();})(); process.exitCode = 1; });
