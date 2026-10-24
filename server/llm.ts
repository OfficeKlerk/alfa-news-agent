import type { Store } from "./db.js";
import { RESERVED_BODY_KEYS, type Settings } from "./config.js";
import { ModelError, type Json } from "./types.js";
import { SPECULATIVE_ABSENCE } from "./integration/generation-budget.js";
export type ResponseSchema = { name: string; schema: Json };
export type Complete = (messages: Json[], tools?: Json[], jsonMode?: boolean, responseSchema?: ResponseSchema, maxTokens?: number) => Promise<Json>;
export function parseJson(message: Json): Json {
  try {
    const text = (message.content ?? "")
      .trim()
      .replace(/^\x60{3}(?:json)?\s*/i, "")
      .replace(/\x60{3}\s*$/, "");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ModelError("Модель не вернула JSON по схеме.");
  }
}
const STRUCTURE_FIELDS = ["summary", "why_relevant", "grounding", "risks", "opportunities", "recommendations", "limitations", "missing_data", "answer", "claim_indexes"];
/** Name the usual cause of a truncated JSON without keeping its untrusted text. */
export function truncationCause(content: unknown): string {
  const texts = typeof content === "string" ? [...content.matchAll(/"text":"((?:[^"\\]|\\.){8,})"/g)].map(m => m[1]) : [];
  const repeats = texts.length - new Set(texts).size;
  if (repeats > 0) return "Причина — зацикливание: в обрезанном тексте " + texts.length + " claim-текстов, из них " + repeats + " повторов.";
  // REPORT9: a contract field repeated in place (e.g. "grounding":[0,1,2,3] dozens of times), named only from our own field list.
  // The loop may sit inside a string, so the key can appear as grounding\": as well as "grounding":.
  const field = typeof content === "string" ? STRUCTURE_FIELDS.map(key => ({ key, n: content.match(new RegExp(key + '\\\\?"\\s*:', "g"))?.length ?? 0 }))
    .sort((a, b) => b.n - a.n)[0] : undefined;
  if (field && field.n >= 5) return "Причина — структурное зацикливание: поле " + field.key + " повторено " + field.n + " раз.";
  const absent = texts.filter(text => SPECULATIVE_ABSENCE.test(text)).length;
  if (absent >= 3) return "Причина — перечень того, о чём новость не сообщает: " + absent + " таких claims из " + texts.length + ".";
  return "Обычная причина — разрастание claims или пересказ контекста, а не малый лимит; проверьте размер контекста и число claims.";
}
export function createComplete(settings: Settings, db: Store, request: typeof fetch = fetch): Complete {
  return async (messages, tools, jsonMode = false, responseSchema, maxTokens) => {
    if (!settings.apiKey.trim()) throw new ModelError("Нет LLM_API_KEY. Укажите ключ в .env и перезапустите сервер.", "MODEL_AUTH_ERROR");
    let base: URL;
    try { base = new URL(settings.baseUrl); } catch { throw new ModelError("Некорректный адрес LLM API."); }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
      throw new ModelError("Для API нужен HTTPS-адрес без учётных данных и параметров.");
    const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    // No await inside the reservation: parallel jobs cannot overspend the local count limit.
    db.connection.exec("BEGIN IMMEDIATE");
    let callId: number | bigint;
    try {
      if (db.get("SELECT count(*) n FROM llm_calls WHERE day=?", day)!.n >= settings.maxCalls)
        throw new ModelError("Достигнут локальный лимит вызовов модели за день (сброс в 00:00 МСК).", "MODEL_LIMIT", 429);
      callId = db.run("INSERT INTO llm_calls(day,model) VALUES(?,?)", day, settings.model).lastInsertRowid;
      db.connection.exec("COMMIT");
    } catch (error) {
      db.connection.exec("ROLLBACK");
      throw error;
    }
    // A technical cap, not a prompt plea: REPORT8 loops ran to 6000 tokens while accepted answers stayed under 1800.
    const outputLimit = jsonMode ? Math.min(settings.maxOutputTokens, maxTokens ?? settings.maxOutputTokens) : settings.maxPlanningTokens;
    const strict = jsonMode && settings.responseFormat === "json_schema" && !!responseSchema;
    const payload: Json = {
      model: settings.model,
      messages,
      max_tokens: outputLimit,
      temperature: 0.2,
    };
    if (tools?.length) Object.assign(payload, { tools, tool_choice: "auto" });
    if (jsonMode) payload.response_format = strict
      ? { type: "json_schema", json_schema: { ...responseSchema!, strict: true } }
      : { type: "json_object" };
    // Preserve the master branch's reasoning controls alongside the response contract.
    if (settings.reasoningEffort) payload.reasoning_effort = settings.reasoningEffort;
    // Provider routing is configuration, never hardcoded: LLM_EXTRA_BODY_JSON for every call,
    // LLM_STRICT_EXTRA_BODY_JSON only for json_schema calls (REPORT8: strict requests routed to AkashML came back empty).
    for (const extra of [settings.extraBody, strict ? settings.strictExtraBody : undefined])
      if (extra) for (const [key, value] of Object.entries(extra))
        if (!RESERVED_BODY_KEYS.includes(key)) payload[key] = value;
    try {
      const response = await request(settings.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + settings.apiKey,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(settings.timeout),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const errors: Record<number, string> = {
          401: "Ключ отклонён API.",
          403: "У ключа нет доступа.",
          429: "Лимит API или общий бюджет исчерпан.",
        };
        throw new ModelError(errors[response.status] ?? "API модели вернул HTTP " + response.status + ".",
          [401, 403].includes(response.status) ? "MODEL_AUTH_ERROR" : response.status === 429 ? "MODEL_LIMIT" : response.status >= 500 ? "MODEL_UNAVAILABLE" : "MODEL_RESPONSE_INVALID",
          response.status === 429 ? 429 : response.status >= 500 ? 503 : 502);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ModelError("Пустой ответ API модели.");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > (settings.maxResponseBytes ?? 1000000)) throw new ModelError("Ответ API превышает лимит размера.");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const result: Json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!result || typeof result !== "object" || !Array.isArray(result.choices) || !result.choices.length)
        throw new ModelError("API модели вернул неожиданный формат ответа.");
      const choice = result.choices?.[0];
      const message = choice?.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new ModelError("API модели вернул неожиданный формат ответа.");
      const tokens = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0;
      db.run(
        "UPDATE llm_calls SET prompt_tokens=?,completion_tokens=? WHERE id=?",
        tokens(result.usage?.prompt_tokens),
        tokens(result.usage?.completion_tokens),
        callId,
      );
      // Token usage is recorded even when the provider truncates the answer.
      // A truncated response is not repairable JSON: do not spend another call on a blind repair.
      if (choice.finish_reason === "length" || choice.finish_reason === "max_tokens") {
        throw new ModelError(
          jsonMode
            ? "Ответ модели обрезан по лимиту длины (" + outputLimit + " выходных токенов): JSON неполный и не сохранён как результат. " + truncationCause(message.content) + " Увеличение LLM_GENERATION_MAX_TOKENS или LLM_MAX_OUTPUT_TOKENS не является исправлением само по себе."
            : "Ответ модели при выборе инструментов обрезан по лимиту длины. Увеличьте LLM_MAX_PLANNING_TOKENS, сократите контекст или смените модель.",
        );
      }
      if (message.refusal || choice.finish_reason === "content_filter") throw new ModelError("Модель отказалась сформировать ответ.");
      // An empty body is a provider failure, not a draft: it must never reach parse/repair.
      if (jsonMode && (typeof message.content !== "string" || !message.content.trim())) {
        const native = choice.provider_specific_fields?.native_finish_reason;
        throw new ModelError("Провайдер вернул пустой ответ без JSON (finish_reason=" + String(choice.finish_reason)
          + (typeof native === "string" && /^\w{1,30}$/.test(native) ? ", native_finish_reason=" + native : "")
          + ", выходных токенов: " + tokens(result.usage?.completion_tokens)
          + (typeof result.provider === "string" && /^[\w .-]{1,40}$/.test(result.provider) ? ", провайдер " + result.provider : "")
          + "). Черновик не создан, repair не выполнялся: это сбой маршрута или провайдера, а не ответ модели.");
      }
      return message;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      const details = error as { name?: string; cause?: { code?: string } };
      if (details?.name === "TimeoutError" || details?.name === "AbortError") {
        throw new ModelError(
          "Истекло время ожидания API модели (" +
            settings.timeout / 1000 +
            " с). Увеличьте LLM_TIMEOUT_SECONDS или повторите запрос.", "MODEL_TIMEOUT", 504,
        );
      }
      if (error instanceof SyntaxError) throw new ModelError("API модели вернул некорректный JSON.");
      const code = details?.cause?.code;
      const allowedCodes = ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"];
      throw new ModelError(
        "Не удалось получить ответ API модели. Проверьте соединение и адрес API." +
          (code && allowedCodes.includes(code) ? " Код: " + code + "." : ""), "MODEL_UNAVAILABLE", 503,
      );
    }
  };
}
