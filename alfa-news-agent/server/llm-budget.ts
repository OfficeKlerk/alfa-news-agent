import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "./db.js";
import type { Settings } from "./config.js";
import { ModelError } from "./types.js";

export type LlmBudgetContext = { companyId?: string; purpose: "analysis" | "question" };
type BudgetSettings = Settings & { maxDailyTokens?: number; maxCompanyDailyCalls?: number; questionReserveCalls?: number; questionReserveTokens?: number };
const context = new AsyncLocalStorage<LlmBudgetContext>();
const initialized = new WeakSet<object>();
export function withLlmBudgetContext<T>(metadata: LlmBudgetContext, action: () => T): T { return context.run(metadata, action); }
function initialize(db: Store) {
  if (initialized.has(db.connection)) return;
  db.connection.exec(`CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS llm_budget_reservations(call_id INTEGER PRIMARY KEY,company_id TEXT,purpose TEXT NOT NULL,
      reserved_prompt INTEGER NOT NULL,reserved_completion INTEGER NOT NULL,charged_prompt INTEGER NOT NULL,charged_completion INTEGER NOT NULL,
      state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS llm_calls_day ON llm_calls(day);
    CREATE INDEX IF NOT EXISTS llm_budget_company ON llm_budget_reservations(company_id,call_id);`);
  initialized.add(db.connection);
}
function limits(settings: BudgetSettings) {
  const calls = settings.maxCalls, tokens = settings.maxDailyTokens ?? 2_000_000;
  const companyCalls = settings.maxCompanyDailyCalls ?? 20;
  // Old callers with a tiny test/development limit must still be able to make one call.
  const reserveCalls = Math.min(settings.questionReserveCalls ?? 0, Math.max(0, calls - 1));
  const reserveTokens = Math.min(settings.questionReserveTokens ?? 0, tokens);
  return { calls, tokens, company_calls: companyCalls, question_reserve_calls: reserveCalls,
    question_reserve_tokens: reserveTokens, company_question_reserve_calls: Math.min(reserveCalls, Math.floor(companyCalls / 5)) };
}
export function budgetDay(now = Date.now()) { return new Date(now + 3 * 3600000).toISOString().slice(0, 10); }
function resetAt(day: string) { return new Date(Date.parse(day + "T00:00:00+03:00") + 86400000).toISOString(); }
function usage(db: Store, day: string, companyId?: string) {
  // Calls made by earlier versions remain part of the same daily budget.
  const row = db.get(`SELECT count(*) calls,
    coalesce(sum(coalesce(b.charged_prompt,c.prompt_tokens)+coalesce(b.charged_completion,c.completion_tokens)),0) tokens,
    coalesce(sum(CASE WHEN b.purpose='question' THEN 0 ELSE 1 END),0) analysis_calls,
    coalesce(sum(CASE WHEN b.purpose='question' THEN 0 ELSE coalesce(b.charged_prompt,c.prompt_tokens)+coalesce(b.charged_completion,c.completion_tokens) END),0) analysis_tokens,
    coalesce(sum(CASE WHEN b.state IN ('reserved','uncertain') THEN 1 ELSE 0 END),0) uncertain_calls
    FROM llm_calls c LEFT JOIN llm_budget_reservations b ON b.call_id=c.id WHERE c.day=?`
    + (companyId ? " AND b.company_id=?" : ""), ...[day, ...(companyId ? [companyId] : [])])!;
  return { calls: Number(row.calls), tokens: Number(row.tokens), uncertain_calls: Number(row.uncertain_calls), analysis_calls: Number(row.analysis_calls), analysis_tokens: Number(row.analysis_tokens) };
}
export function budgetStatus(settings: BudgetSettings, db: Store, companyId?: string, now = Date.now()) {
  initialize(db);
  const day = budgetDay(now), cap = limits(settings), used = usage(db, day);
  const company = companyId ? usage(db, day, companyId) : undefined;
  return { day, timezone: "Europe/Moscow", resets_at: resetAt(day), limits: cap, used,
    remaining: { calls: Math.max(0, cap.calls - used.calls), tokens: Math.max(0, cap.tokens - used.tokens),
      analysis_calls: Math.max(0, Math.min(cap.calls - used.calls, cap.calls - cap.question_reserve_calls - used.analysis_calls)),
      analysis_tokens: Math.max(0, Math.min(cap.tokens - used.tokens, cap.tokens - cap.question_reserve_tokens - used.analysis_tokens)) },
    ...(company ? { company: { company_id: companyId, ...company, remaining_calls: Math.max(0, cap.company_calls - company.calls) } } : {}),
    accounting: "Provider usage when present; full reservation retained for missing usage, crashes or transport failures" };
}
export function reserveLlmCall(settings: BudgetSettings, db: Store, payload: unknown, outputLimit: number,
  metadata = context.getStore() ?? { purpose: "analysis" as const }, now = Date.now(), onReserve?: (id: number | bigint) => void): number | bigint {
  initialize(db);
  // A byte upper bound is deliberately conservative across provider tokenizers; include framing overhead.
  const reservedPrompt = Buffer.byteLength(JSON.stringify(payload), "utf8") + 512;
  const day = budgetDay(now), cap = limits(settings), isQuestion = metadata.purpose === "question";
  db.connection.exec("BEGIN IMMEDIATE");
  try {
    const used = usage(db, day), company = metadata.companyId ? usage(db, day, metadata.companyId) : undefined;
    const callCap = cap.calls - (isQuestion ? 0 : cap.question_reserve_calls);
    const tokenCap = cap.tokens - (isQuestion ? 0 : cap.question_reserve_tokens);
    const companyCap = cap.company_calls - (isQuestion ? 0 : cap.company_question_reserve_calls);
    const requestTokens = reservedPrompt + outputLimit;
    if (used.calls + 1 > cap.calls || used.tokens + requestTokens > cap.tokens
      || !isQuestion && (used.analysis_calls + 1 > callCap || used.analysis_tokens + requestTokens > tokenCap)
      || company && (company.calls + 1 > cap.company_calls || !isQuestion && company.analysis_calls + 1 > companyCap)) {
      const error = new ModelError("Достигнут общий или корпоративный бюджет модели. Сбор продолжается; генерация отложена до сброса в 00:00 МСК. Резерв вопросов сохраняется.", "MODEL_LIMIT", 429);
      Object.assign(error, { retryAt: resetAt(day), budgetExhausted: true });
      throw error;
    }
    const id = db.run("INSERT INTO llm_calls(day,model) VALUES(?,?)", day, settings.model).lastInsertRowid;
    const timestamp = new Date(now).toISOString();
    db.run("INSERT INTO llm_budget_reservations VALUES(?,?,?,?,?,?,?,?,?,?)", id, metadata.companyId ?? null, metadata.purpose,
      reservedPrompt, outputLimit, reservedPrompt, outputLimit, "reserved", timestamp, timestamp);
    onReserve?.(id);
    db.connection.exec("COMMIT"); return id;
  } catch (error) { db.connection.exec("ROLLBACK"); throw error; }
}
/** Missing/incomplete usage never turns a potentially billed request into zero tokens. */
export function settleLlmCall(db: Store, id: number | bigint, providerUsage?: unknown) {
  const value = providerUsage as Record<string, unknown> | null | undefined;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const known = value && valid(value.prompt_tokens) && valid(value.completion_tokens);
  db.connection.exec("BEGIN IMMEDIATE");
  try {
    if (known) {
      const prompt = value.prompt_tokens as number;
      const completion = Math.max(value.completion_tokens as number, valid(value.total_tokens) ? value.total_tokens - prompt : 0);
      db.run("UPDATE llm_calls SET prompt_tokens=?,completion_tokens=? WHERE id=?", prompt, completion, id);
      db.run("UPDATE llm_budget_reservations SET charged_prompt=?,charged_completion=?,state='settled',updated_at=? WHERE call_id=?", prompt, completion, new Date().toISOString(), id);
    } else db.run("UPDATE llm_budget_reservations SET state='uncertain',updated_at=? WHERE call_id=? AND state='reserved'", new Date().toISOString(), id);
    db.connection.exec("COMMIT");
  } catch (error) { db.connection.exec("ROLLBACK"); throw error; }
}
