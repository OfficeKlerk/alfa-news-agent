import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadSettings } from "../server/config.js";
import { Store } from "../server/db.js";
import { generatePrepared } from "../server/integration/prepared-agent.js";
import { evaluationCases } from "../server/integration/evaluation.js";
import { PROMPT_VERSION } from "../server/integration/analysis-prompts.js";
import { ModelError, type ResponseDiagnostics } from "../server/types.js";
import { safeDiagnostics } from "../server/integration/diagnostics.js";

// Model-settings tuning harness (TEAM_TASKS #3). Sweeps a small grid of model x
// output-token limit x reasoning budget over a few evaluation cases, runs the REAL
// /v1 analyze pipeline through the gateway, and records for each run whether a full
// valid grounded answer came back, the latency, the measured token spend and an
// estimated rouble cost. It never accepts a key on the command line: set LLM_API_KEY
// in .env so it is not pasted into a shell history or a chat.

const args = process.argv.slice(2);
const flag = (name: string, fallback = "") => args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback;
const list = (name: string, fallback: string) => (flag(name, fallback) || fallback).split(",").map(s => s.trim()).filter(Boolean);

const settings = loadSettings();
if (!settings.apiKey.trim()) throw new Error("Укажите LLM_API_KEY в .env (не в командной строке и не в чат).");

const models = list("--models", settings.model);
const outputs = list("--max-output", "6000,12000,16000").map(Number);
const reasonings = list("--reasoning", "default"); // default = leave unset; or none|minimal|low|medium|high
const caseIds = list("--cases", "rate_borrower,no_rag");
const contextBytes = Number(flag("--context-bytes", String(settings.maxContextBytes ?? 200000)));
const maxCalls = Number(flag("--max-calls", "12"));
const timeoutSec = Number(flag("--timeout", String(settings.timeout / 1000)));
const out = resolve(flag("--out", "var/model-tuning/results.json"));
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error("--max-calls: целое >=1");
if (outputs.some(n => !Number.isInteger(n) || n < 256)) throw new Error("--max-output: целые >=256");
if (reasonings.some(r => !["default", "none", "minimal", "low", "medium", "high"].includes(r))) throw new Error("--reasoning: default|none|minimal|low|medium|high");

const allCases = new Map(evaluationCases().map(c => [c.id, c]));
for (const id of caseIds) if (!allCases.has(id)) throw new Error(`Неизвестный кейс: ${id}. Доступны: ${[...allCases.keys()].join(", ")}`);

const prices = existsSync(resolve("data/demo/model_prices.json"))
  ? JSON.parse(readFileSync(resolve("data/demo/model_prices.json"), "utf8")).prices ?? {} : {};
const cost = (model: string, prompt: number, completion: number) => {
  const p = prices[model]; if (!p) return null;
  return +(prompt / 1000 * p.input + completion / 1000 * p.output).toFixed(4);
};

const grid: { model: string; maxOutput: number; reasoning: string }[] = [];
for (const model of models) for (const maxOutput of outputs) for (const reasoning of reasonings) grid.push({ model, maxOutput, reasoning });
console.log(`Сетка: ${grid.length} комбинаций x ${caseIds.length} кейсов = ${grid.length * caseIds.length} прогонов (до ~2 вызовов каждый). Жёсткий лимит вызовов: ${maxCalls}.`);
console.log(`Цены — ПЛЕЙСХОЛДЕР из model_prices.json (не официальный тариф).`);

mkdirSync(dirname(out), { recursive: true });
const dbPath = resolve("var/model-tuning/calls.sqlite3");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Store({ ...settings, dbPath });
db.connection.exec("CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");

const spent = () => (db.get("SELECT count(*) n FROM llm_calls")!.n as number);
const report = { task: "TEAM_TASKS#3 model settings", prompt_version: PROMPT_VERSION, base_url: settings.baseUrl,
  created_at: new Date().toISOString(), hard_call_limit: maxCalls, context_bytes: contextBytes, runs: [] as any[] };

try {
  outer: for (const combo of grid) {
    for (const caseId of caseIds) {
      if (spent() >= maxCalls) { console.log(`Достигнут лимит вызовов (${maxCalls}); остановка.`); break outer; }
      const test = allCases.get(caseId)!;
      // A run may repair once; reserve only the remaining CLI budget for both calls.
      const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
      const today = db.get("SELECT count(*) n FROM llm_calls WHERE day=?", day)!.n as number;
      const runSettings = { ...settings, model: combo.model, maxOutputTokens: combo.maxOutput,
        maxCalls: Math.min(settings.maxCalls, today + maxCalls - spent()),
        maxContextBytes: contextBytes, timeout: timeoutSec * 1000,
        reasoningEffort: combo.reasoning === "default" ? undefined : combo.reasoning };
      const before = (db.get("SELECT max(id) m FROM llm_calls")!.m as number) ?? 0;
      const started = Date.now();
      let ok = false, error: string | null = null;
      let diagnostics: ResponseDiagnostics | undefined;
      try { await generatePrepared(runSettings, db, structuredClone(test.input), `tune-${combo.model}-${caseId}`); ok = true; }
      catch (e) {
        error = e instanceof Error ? e.message : "Model tuning failed";
        if (e instanceof ModelError && e.diagnostics) diagnostics = safeDiagnostics(e.diagnostics);
      }
      const latency_ms = Date.now() - started;
      const used = db.all("SELECT prompt_tokens,completion_tokens FROM llm_calls WHERE id>?", before) as any[];
      const prompt_tokens = used.reduce((s, r) => s + (r.prompt_tokens ?? 0), 0);
      const completion_tokens = used.reduce((s, r) => s + (r.completion_tokens ?? 0), 0);
      const run = { ...combo, case: caseId, ok, error, latency_ms, calls: used.length,
        prompt_tokens, completion_tokens, est_cost_rub: cost(combo.model, prompt_tokens, completion_tokens),
        ...(diagnostics ? { diagnostics } : {}) };
      report.runs.push(run);
      writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
      console.log(`${ok ? "OK  " : "FAIL"} ${combo.model} out=${combo.maxOutput} reason=${combo.reasoning} ${caseId} | ${latency_ms}ms | tok ${prompt_tokens}+${completion_tokens} | ${run.est_cost_rub ?? "?"}₽${error ? " | " + error : ""}`);
    }
  }
} finally { db.close(); }

// Aggregate per (model, maxOutput, reasoning): a combination is viable only if it
// produced a full valid grounded answer for EVERY tested case.
const byCombo = new Map<string, any[]>();
for (const r of report.runs) { const k = `${r.model}|${r.maxOutput}|${r.reasoning}`; (byCombo.get(k) ?? byCombo.set(k, []).get(k)!).push(r); }
const agg = [...byCombo.entries()].map(([k, runs]) => {
  const [model, maxOutput, reasoning] = k.split("|");
  const passed = runs.filter(r => r.ok).length;
  return { model, maxOutput: +maxOutput, reasoning, passed, total: runs.length,
    viable: passed === runs.length && runs.length === caseIds.length,
    avg_latency_ms: Math.round(runs.reduce((s, r) => s + r.latency_ms, 0) / runs.length),
    total_completion_tokens: runs.reduce((s, r) => s + r.completion_tokens, 0),
    total_cost_rub: runs.every(r => r.est_cost_rub != null) ? +runs.reduce((s, r) => s + r.est_cost_rub, 0).toFixed(4) : null };
});
// Prefer a viable combination with the smallest output budget, then lowest latency.
const recommended = agg.filter(a => a.viable)
  .sort((a, b) => a.maxOutput - b.maxOutput || a.avg_latency_ms - b.avg_latency_ms)[0] ?? null;
(report as any).aggregate = agg;
(report as any).recommended = recommended;
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

console.log("\n=== Сводка (viable = прошли все кейсы) ===");
for (const a of agg.sort((x, y) => Number(y.viable) - Number(x.viable) || x.maxOutput - y.maxOutput))
  console.log(`${a.viable ? "★" : " "} ${a.model} out=${a.maxOutput} reason=${a.reasoning}: ${a.passed}/${a.total} | ~${a.avg_latency_ms}ms | out_tok ${a.total_completion_tokens} | ${a.total_cost_rub ?? "?"}₽`);
console.log(recommended
  ? `\nРекомендация: LLM_MODEL=${recommended.model} LLM_MAX_OUTPUT_TOKENS=${recommended.maxOutput}` +
    (recommended.reasoning === "default" ? "" : ` LLM_REASONING_EFFORT=${recommended.reasoning}`) +
    ` (прошли все ${caseIds.length} кейса, ~${recommended.avg_latency_ms}ms).`
  : "\nНи одна комбинация не прошла все кейсы. Увеличьте --max-output, ограничьте reasoning (--reasoning none,low) или смените модель.");
console.log(`Потрачено вызовов: ${report.runs.reduce((s, r) => s + r.calls, 0)}. Результаты: ${out}`);
