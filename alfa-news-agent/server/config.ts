import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MODELS = [
  "google/gemma-4-26b-a4b-it",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.6-35b-a3b",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3-vl-30b-a3b-instruct",
  "moonshotai/kimi-k2.6",
];
export const ROLES = [
  "Финансовый директор",
  "Генеральный директор",
  "Руководитель казначейства",
];
export interface Settings {
  root: string;
  data: string;
  dbPath: string;
  mode: "demo" | "live";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxCalls: number;
  maxOutputTokens: number;
  maxPlanningTokens: number;
  /** Cap for grounded analysis/question JSON; accepted REPORT8 answers used at most 1767 output tokens. */
  generationMaxTokens?: number;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  /** Extra body fields for json_schema (strict) requests only, e.g. a provider route confirmed by the gateway owner. */
  strictExtraBody?: Record<string, unknown>;
  /** Optional provider-schema maxLength for claim text/quote; unset until a provider confirms support. */
  strictMaxClaimString?: number;
  timeout: number;
  maxContextBytes?: number;
  maxResponseBytes?: number;
  responseFormat?: "json_object" | "json_schema";
  host: string;
  port: number;
  feeds: string[];
  newsEnabled?: boolean;
  newsPollSeconds?: number;
  newsSeedMode?: "demo" | "reviewed" | "none";
  analysisEnabled?: boolean;
  maxDailyTokens?: number;
  maxCompanyDailyCalls?: number;
  questionReserveCalls?: number;
  questionReserveTokens?: number;
  newsFullTextEnabled?: boolean;
  newsFullTextConcurrency?: number;
  newsFullTextMaxPerSource?: number;
  newsFullTextRefreshSeconds?: number;
  newsSourceConcurrency?: number;
  liveEnabled?: boolean;
  liveScanSeconds?: number;
  liveLookbackDays?: number;
  liveMaxCandidates?: number;
  liveCompanyNewsLimit?: number;
  liveMaxCompanies?: number;
  liveWorkerConcurrency?: number;
  liveMinScore?: number;
}

function flag(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw new Error(name + " должен быть 0|1|false|true");
}

function integer(value: string | undefined, fallback: number, min = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < min)
    throw new Error("Неверное целое число в конфигурации");
  return number;
}

export const RESERVED_BODY_KEYS = ["model", "messages", "stream", "response_format", "max_tokens", "max_completion_tokens"];
/** Provider-specific body fields from configuration. Core request fields and the token caps stay under our control. */
function extraBodyJson(values: NodeJS.ProcessEnv, name: string): Record<string, unknown> | undefined {
  if (!(values[name] ?? "").trim()) return undefined;
  const parsed: unknown = JSON.parse(values[name]!);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(name + " должен быть JSON-объектом");
  for (const key of RESERVED_BODY_KEYS)
    if (key in (parsed as object)) throw new Error(name + " не может переопределять " + key);
  return parsed as Record<string, unknown>;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const values: NodeJS.ProcessEnv = { ...env };
  const path = resolve(ROOT, ".env");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)) {
      const match = line.trim().match(/^([^#=]+)=(.*)$/);
      if (match && values[match[1].trim()] === undefined)
        values[match[1].trim()] = match[2]
          .trim()
          .replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  const mode = values.LLM_MODE ?? "demo";
  const model = values.LLM_MODEL ?? "qwen/qwen3.6-35b-a3b";
  if (mode !== "demo" && mode !== "live")
    throw new Error("LLM_MODE должен быть demo или live");
  const responseFormat = values.LLM_RESPONSE_FORMAT ?? "json_object";
  if (responseFormat !== "json_object" && responseFormat !== "json_schema")
    throw new Error("LLM_RESPONSE_FORMAT должен быть json_object или json_schema");
  const allowed: unknown = JSON.parse(values.LLM_ALLOWED_MODELS_JSON ?? JSON.stringify(MODELS));
  if (!Array.isArray(allowed) || !allowed.every(m => typeof m === "string" && m.trim()) || !allowed.includes(model))
    throw new Error("Модель отсутствует в списке разрешённых");

  // Reasoning models spend the output budget on hidden reasoning tokens before any
  // JSON is emitted; these knobs bound or disable that so a valid answer fits the limit.
  const reasoningEffort = (values.LLM_REASONING_EFFORT ?? "").trim() || undefined;
  if (reasoningEffort && !["none", "minimal", "low", "medium", "high"].includes(reasoningEffort))
    throw new Error("LLM_REASONING_EFFORT должен быть none|minimal|low|medium|high");
  // Escape hatch for provider-specific knobs (e.g. {\"chat_template_kwargs\":{\"enable_thinking\":false}}
  // or {\"reasoning\":{\"max_tokens\":1024}}) merged shallowly into the request body.
  const extraBody = extraBodyJson(values, "LLM_EXTRA_BODY_JSON");
  const strictExtraBody = extraBodyJson(values, "LLM_STRICT_EXTRA_BODY_JSON");

  const feeds: unknown = JSON.parse(values.NEWS_FEEDS_JSON ?? "[]");
  if (
    !Array.isArray(feeds) ||
    !feeds.every(
      (url) => typeof url === "string" && new URL(url).protocol === "https:"
        && !new URL(url).username && !new URL(url).password,
    )
  )
    throw new Error("NEWS_FEEDS_JSON должен содержать HTTPS-адреса");
  if (feeds.length > 64) throw new Error("NEWS_FEEDS_JSON поддерживает не более 64 источников");
  const newsSeedMode = values.NEWS_SEED_MODE ?? "demo";
  if (!["demo", "reviewed", "none"].includes(newsSeedMode)) throw new Error("NEWS_SEED_MODE должен быть demo|reviewed|none");
  const newsEnabled = flag(values.NEWS_ENABLED, false, "NEWS_ENABLED");
  if (newsEnabled && !feeds.length) throw new Error("Для NEWS_ENABLED=1 задайте NEWS_FEEDS_JSON");
  return {
    root: ROOT,
    data: resolve(values.DATA_DIR ?? resolve(ROOT, "data")),
    // Separate database prevents the new runtime from changing the old prototype's state.
    dbPath: resolve(values.DB_PATH ?? resolve(ROOT, "var", "app-node.sqlite3")),
    mode,
    baseUrl: (
      values.LLM_BASE_URL ?? "https://changellenge.up.railway.app/v1"
    ).replace(/\/+$/, ""),
    apiKey: values.LLM_API_KEY ?? "",
    responseFormat,
    model,
    maxCalls: integer(values.MAX_DAILY_LLM_CALLS, 100),
    maxOutputTokens: integer(values.LLM_MAX_OUTPUT_TOKENS, 6000, 256),
    maxPlanningTokens: integer(values.LLM_MAX_PLANNING_TOKENS, 6000, 256),
    generationMaxTokens: integer(values.LLM_GENERATION_MAX_TOKENS, 2500, 256),
    reasoningEffort,
    extraBody,
    strictExtraBody,
    strictMaxClaimString: values.LLM_STRICT_MAX_CLAIM_STRING ? integer(values.LLM_STRICT_MAX_CLAIM_STRING, 0, 900) : undefined,
    timeout: integer(values.LLM_TIMEOUT_SECONDS, 120, 1) * 1000,
    maxContextBytes: integer(values.LLM_MAX_CONTEXT_BYTES, 200000, 1000),
    maxResponseBytes: integer(values.LLM_MAX_RESPONSE_BYTES, 1000000, 1000),
    host: values.HOST ?? "127.0.0.1",
    port: integer(values.PORT, 8000),
    feeds,
    newsEnabled,
    newsPollSeconds: integer(values.NEWS_POLL_SECONDS, 300, 30),
    newsSeedMode: newsSeedMode as Settings["newsSeedMode"],
    analysisEnabled: flag(values.ANALYSIS_ENABLED, true, "ANALYSIS_ENABLED"),
    maxDailyTokens: integer(values.MAX_DAILY_LLM_TOKENS, 2_000_000),
    maxCompanyDailyCalls: integer(values.MAX_COMPANY_DAILY_LLM_CALLS, 20),
    questionReserveCalls: integer(values.LLM_QUESTION_RESERVE_CALLS, Math.min(10, Math.floor(integer(values.MAX_DAILY_LLM_CALLS, 100) / 5))),
    questionReserveTokens: integer(values.LLM_QUESTION_RESERVE_TOKENS, Math.min(200_000, Math.floor(integer(values.MAX_DAILY_LLM_TOKENS, 2_000_000) / 5))),
    newsFullTextEnabled: flag(values.NEWS_FULL_TEXT_ENABLED, false, "NEWS_FULL_TEXT_ENABLED"),
    newsFullTextMaxPerSource: Math.min(100, integer(values.NEWS_FULL_TEXT_MAX_PER_SOURCE, 20, 1)),
    newsFullTextConcurrency: Math.min(8, integer(values.NEWS_FULL_TEXT_CONCURRENCY, 3, 1)),
    newsFullTextRefreshSeconds: integer(values.NEWS_FULL_TEXT_REFRESH_SECONDS, 3600, 60),
    newsSourceConcurrency: Math.min(8, integer(values.NEWS_SOURCE_CONCURRENCY, 3, 1)),
    liveEnabled: flag(values.LIVE_PIPELINE_ENABLED, false, "LIVE_PIPELINE_ENABLED"),
    liveScanSeconds: integer(values.LIVE_SCAN_SECONDS, 60, 10),
    liveLookbackDays: Math.min(90, integer(values.LIVE_LOOKBACK_DAYS, 7, 1)),
    liveMaxCandidates: Math.min(1000, integer(values.LIVE_MAX_CANDIDATES, 500, 1)),
    liveCompanyNewsLimit: Math.min(50, integer(values.LIVE_COMPANY_NEWS_LIMIT, 5, 1)),
    liveMaxCompanies: Math.min(1000, integer(values.LIVE_MAX_COMPANIES, 100, 1)),
    liveWorkerConcurrency: Math.min(8, integer(values.LIVE_WORKER_CONCURRENCY, 2, 1)),
    liveMinScore: 0.2,
  };
}
