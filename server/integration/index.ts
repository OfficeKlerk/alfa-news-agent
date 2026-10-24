import { createApplication } from "../app.js";
import { loadSettings, ROOT } from "../config.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createGateway } from "./gateway.js";
import { ContractClient } from "./client.js";
import { MockRetrieval, LegacyRetrieval, HttpRetrieval } from "./retrieval.js";
import { MockAgent, LegacyAgent, HttpAgent } from "./agent.js";

if (existsSync(resolve(ROOT, ".env"))) loadEnvFile(resolve(ROOT, ".env"));
const settings = loadSettings();
const runtime = await createApplication(settings);
const retrievalMode = process.env.RETRIEVAL_MODE ?? "http", agentMode = process.env.AGENT_MODE ?? "http";
if (!["mock", "legacy", "http"].includes(retrievalMode) || !["mock", "legacy", "http"].includes(agentMode)) throw new Error("Invalid integration provider mode");
const retrievalClient = new ContractClient(process.env.RETRIEVAL_URL ?? "http://127.0.0.1:8102");
const agentClient = new ContractClient(process.env.AGENT_URL ?? "http://127.0.0.1:8102", 2 * settings.timeout + 15000);
const retrieval = retrievalMode === "legacy" ? new LegacyRetrieval(runtime.db, runtime.retrieval, settings) : retrievalMode === "mock" ? new MockRetrieval()
  : new HttpRetrieval(retrievalClient);
const agent = agentMode === "legacy" ? new LegacyAgent(settings) : agentMode === "mock" ? new MockAgent()
  : new HttpAgent(agentClient);
const healthClients = [retrievalMode === "http" ? retrievalClient : null,
  agentMode === "http" ? new ContractClient(process.env.AGENT_URL ?? "http://127.0.0.1:8102", 3000) : null].filter((c): c is ContractClient => c !== null);
const app = createGateway({ ml: new ContractClient(process.env.ML_URL ?? "http://127.0.0.1:8101"), retrieval, agent, healthClients, legacy: runtime.app, maxContextBytes: settings.maxContextBytes });
const server = app.listen(settings.port, settings.host, () => console.log(`Integration: http://localhost:${settings.port}/integration | legacy UI: /`));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close(() => void runtime.close()); server.closeIdleConnections();
});
server.on("error", () => { void runtime.close(); process.exitCode = 1; });
