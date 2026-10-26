import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadSettings, ROOT } from "../config.js";
import { Store } from "../db.js";
import { createComplete } from "../llm.js";
import { budgetStatus, reserveLlmCall, settleLlmCall, withLlmBudgetContext } from "../llm-budget.js";
import { ModelError } from "../types.js";
function fixture(extra = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "alfa-budget-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "fixture-only", LLM_BASE_URL: "https://provider.invalid/v1" }),
    dbPath: resolve(dir, "budget.sqlite3"), maxCalls: 100, maxDailyTokens: 1_000_000,
    maxCompanyDailyCalls: 20, questionReserveCalls: 0, questionReserveTokens: 0, ...extra };
  const db = new Store(settings);
  return { settings, db, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const limited = (error: unknown) => error instanceof ModelError && error.code === "MODEL_LIMIT" && error.status === 429;
const response = () => Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
test("shared durable reservations limit concurrent connections and preserve question calls after reopening", () => {
  const f = fixture({ maxCalls: 4, questionReserveCalls: 2 }), second = new Store(f.settings);
  try {
    const first = reserveLlmCall(f.settings, f.db, {}, 256, { companyId: "A", purpose: "analysis" });
    reserveLlmCall(f.settings, second, {}, 256, { companyId: "B", purpose: "analysis" });
    assert.throws(() => reserveLlmCall(f.settings, second, {}, 256), limited);
    settleLlmCall(f.db, first, { prompt_tokens: 20, completion_tokens: 10 });
    const reopened = new Store(f.settings);
    try {
      reserveLlmCall(f.settings, reopened, {}, 256, { companyId: "A", purpose: "question" });
      reserveLlmCall(f.settings, reopened, {}, 256, { companyId: "B", purpose: "question" });
      assert.throws(() => reserveLlmCall(f.settings, reopened, {}, 256, { purpose: "question" }), limited);
      const status = budgetStatus(f.settings, reopened);
      assert.equal(status.used.calls, 4); assert.equal(status.used.uncertain_calls, 3);
      assert.equal(status.remaining.calls, 0); assert.match(status.resets_at, /T21:00:00.000Z$/);
    } finally { reopened.close(); }
  } finally { second.close(); f.close(); }
});
test("token reserve survives missing usage and network failures, while actual usage is reconciled", async () => {
  const f = fixture({ maxDailyTokens: 2500, questionReserveTokens: 1000, maxOutputTokens: 256 });
  try {
    const complete = createComplete(f.settings, f.db, (async () => { throw new TypeError("network failed"); }) as typeof fetch);
    await assert.rejects(complete([]), limited);
    assert.equal(budgetStatus(f.settings, f.db).used.calls, 0);
  } finally { f.close(); }
  const g = fixture({ maxDailyTokens: 2500, questionReserveTokens: 1000, maxOutputTokens: 256 });
  try {
    const complete = createComplete(g.settings, g.db, (async () => { throw new TypeError("network failed"); }) as typeof fetch);
    await assert.rejects(complete([], undefined, true), /Не удалось получить ответ/);
    const charged = budgetStatus(g.settings, g.db).used.tokens;
    assert.ok(charged > 256);
    await assert.rejects(complete([], undefined, true), limited);
    await withLlmBudgetContext({ companyId: "A", purpose: "question" }, () => createComplete(g.settings, g.db, (async () => response()) as typeof fetch)([], undefined, true));
    assert.equal(budgetStatus(g.settings, g.db).used.tokens, charged + 30);
    assert.equal(budgetStatus(g.settings, g.db).used.uncertain_calls, 1);
    const id = reserveLlmCall(g.settings, g.db, {}, 256, { purpose: "question" });
    settleLlmCall(g.db, id, { prompt_tokens: 2 });
    assert.ok(budgetStatus(g.settings, g.db).used.tokens >= charged + 30 + 256 + 512);
  } finally { g.close(); }
});
test("questions consuming their reserved share do not leave an unusable remainder", () => {
  const f = fixture({ maxCalls: 4, questionReserveCalls: 2 });
  try {
    reserveLlmCall(f.settings, f.db, {}, 256, { purpose: "question" });
    reserveLlmCall(f.settings, f.db, {}, 256, { purpose: "question" });
    assert.equal(budgetStatus(f.settings, f.db).remaining.analysis_calls, 2);
    reserveLlmCall(f.settings, f.db, {}, 256, { purpose: "analysis" });
    reserveLlmCall(f.settings, f.db, {}, 256, { purpose: "analysis" });
    assert.equal(budgetStatus(f.settings, f.db).remaining.calls, 0);
  } finally { f.close(); }
});
test("company quotas are independent and keep room for questions", () => {
  const f = fixture({ maxCompanyDailyCalls: 5, questionReserveCalls: 10 });
  try {
    for (let i = 0; i < 4; i++) reserveLlmCall(f.settings, f.db, {}, 256, { companyId: "A", purpose: "analysis" });
    assert.throws(() => reserveLlmCall(f.settings, f.db, {}, 256, { companyId: "A", purpose: "analysis" }), limited);
    reserveLlmCall(f.settings, f.db, {}, 256, { companyId: "A", purpose: "question" });
    assert.throws(() => reserveLlmCall(f.settings, f.db, {}, 256, { companyId: "A", purpose: "question" }), limited);
    reserveLlmCall(f.settings, f.db, {}, 256, { companyId: "B", purpose: "analysis" });
    assert.equal(budgetStatus(f.settings, f.db, "A").company!.remaining_calls, 0);
  } finally { f.close(); }
});
test("missing key does not reserve a paid call; provider-reported total includes hidden completion tokens", async () => {
  const f = fixture();
  try {
    await assert.rejects(createComplete({ ...f.settings, apiKey: "" }, f.db)([]), error => error instanceof ModelError && error.code === "MODEL_AUTH_ERROR");
    assert.equal(budgetStatus(f.settings, f.db).used.calls, 0);
    const id = reserveLlmCall(f.settings, f.db, {}, 256);
    settleLlmCall(f.db, id, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 20 });
    assert.equal(budgetStatus(f.settings, f.db).used.tokens, 20);
  } finally { f.close(); }
});
test("independent processes cannot race beyond a shared daily call cap", async () => {
  const f = fixture({ maxCalls: 2 });
  try {
    budgetStatus(f.settings, f.db);
    const script = `import {Store} from ${JSON.stringify(pathToFileURL(resolve(ROOT, "server/db.ts")).href)};
      import {reserveLlmCall} from ${JSON.stringify(pathToFileURL(resolve(ROOT, "server/llm-budget.ts")).href)};
      const s=${JSON.stringify(f.settings)}, db=new Store(s);
      try {reserveLlmCall(s,db,{},256);process.stdout.write('reserved');}
      catch(e) {process.stdout.write(e.code ?? 'unexpected');} finally {db.close();}`;
    const run = () => new Promise<string>((accept, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; child.stdout.on("data", v => out += v); child.stderr.on("data", v => err += v);
      child.on("error", reject); child.on("close", code => code === 0 ? accept(out) : reject(new Error(err)));
    });
    const results = await Promise.all(Array.from({ length: 5 }, run));
    assert.equal(results.filter(v => v === "reserved").length, 2);
    assert.equal(results.filter(v => v === "MODEL_LIMIT").length, 3);
    assert.equal(budgetStatus(f.settings, f.db).used.calls, 2);
  } finally { f.close(); }
});
