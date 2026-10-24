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
      (url) => typeof url === "string" && new URL(url).protocol === "https:",
    )
  )
    throw new Error("NEWS_FEEDS_JSON должен содержать HTTPS-адреса");
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
  };
}
