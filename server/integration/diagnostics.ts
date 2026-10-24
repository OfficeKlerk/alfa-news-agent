import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ErrorObject } from "ajv";
import { ROOT } from "../config.js";
import type { Store } from "../db.js";
import type { FieldIssue, Json, ResponseDiagnostics } from "../types.js";

const definitions = JSON.parse(readFileSync(resolve(ROOT, "contracts/v1/schema.json"), "utf8")).$defs;
const rules: Record<string, string[]> = JSON.parse(readFileSync(resolve(ROOT, "contracts/diagnostic-rules.json"), "utf8"));
const fields = new Set<string>();
function names(node: Json) {
  if (node.properties) Object.keys(node.properties).forEach(key => fields.add(key));
  Object.values(node).forEach(value => {
    if (Array.isArray(value)) value.forEach(v => { if (v && typeof v === "object") names(v); });
    else if (value && typeof value === "object") names(value);
  });
}
names(definitions);
const types = new Set(["string", "object", "array", "integer", "number", "boolean", "null"]);

/** Never reflect unknown property names, model values, provider bodies or schema params. */
export function safePath(path: string): string {
  const expand = (node: Json): Json[] => node.$ref ? expand(definitions[node.$ref.replace("#/$defs/", "")] ?? {})
    : [node, ...[...node.allOf ?? [], ...node.anyOf ?? []].flatMap(expand)];
  let candidates: Json[] = Object.values(definitions).filter((v: any) => v.type === "object") as Json[];
  const safe: string[] = [];
  for (const part of path.split("/").filter(Boolean).slice(0, 12)) {
    const nodes = candidates.flatMap(expand);
    const numeric = /^(?:0|[1-9]\d{0,5})$/.test(part);
    const next = numeric ? nodes.filter(n => n.type === "array" && n.items).map(n => n.items)
      : nodes.filter(n => n.properties && Object.hasOwn(n.properties, part)).map(n => n.properties[part]);
    // Digits are safe only as array indices, never as attacker-chosen property names.
    safe.push(next.length || !numeric && fields.has(part) ? part : "[unknown]");
    if (!next.length) break;
    candidates = next;
  }
  return ("/" + safe.join("/")).slice(0, 500);
}
export function safeDiagnostics(value: ResponseDiagnostics): ResponseDiagnostics {
  const issues: FieldIssue[] = value.issues.slice(0, 10).filter(issue => rules[issue.stage]?.includes(issue.rule))
    .map(issue => ({ stage: issue.stage, path: safePath(issue.path), rule: issue.rule,
      ...(issue.expected && types.has(issue.expected) ? { expected: issue.expected } : {}),
      ...(typeof issue.limit === "number" && Number.isFinite(issue.limit) && Math.abs(issue.limit) <= 1e9 ? { limit: issue.limit } : {}) }));
  return { issues,
    ...(value.generation_id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.generation_id) ? { generation_id: value.generation_id } : {}),
    ...(value.attempts && Number.isInteger(value.attempts) && value.attempts >= 1 && value.attempts <= 2 ? { attempts: value.attempts } : {}),
    ...(value.max_attempts === 2 ? { max_attempts: 2 } : {}),
    ...(typeof value.draft_saved === "boolean" ? { draft_saved: value.draft_saved } : {}) };
}
export function describeDiagnostics(value: ResponseDiagnostics): string {
  const safe = safeDiagnostics(value);
  return safe.issues.map(i => `${i.path}: ${i.rule}${i.expected ? " " + i.expected : ""}${i.limit !== undefined ? " (limit " + i.limit + ")" : ""}`).join("; ");
}
export function diagnosticFailureMessage(code: string, value: ResponseDiagnostics): string {
  const summaries: Record<string, string> = {
    MODEL_AUTH_ERROR: "Провайдер отклонил ключ или доступ к модели.",
    MODEL_LIMIT: "Достигнут лимит вызовов или квота провайдера.",
    MODEL_TIMEOUT: "Истекло время ожидания модели.", MODEL_UNAVAILABLE: "Провайдер модели недоступен.",
    MODEL_RESPONSE_INVALID: "Ответ модели не прошёл проверку.",
  };
  const safe = safeDiagnostics(value);
  return `${summaries[code] ?? "Проверка ответа не пройдена."} ${safe.attempts ? `Попыток: ${safe.attempts}/${safe.max_attempts ?? 2}. ` : ""}${describeDiagnostics(safe)}`;
}
export function schemaIssues(errors: ErrorObject[] | null | undefined): FieldIssue[] {
  return (errors ?? []).slice(0, 10).map(error => {
    const property = error.keyword === "required" ? error.params.missingProperty
      : error.keyword === "additionalProperties" ? error.params.additionalProperty : undefined;
    const path = safePath(error.instancePath + (property ? "/" + property : ""));
    const rule = ({ type: "Expected type", required: "Required field missing", additionalProperties: "Unexpected field",
      uniqueItems: "Duplicate items", minItems: "Too few items", maxItems: "Too many items",
      minLength: "String is too short", maxLength: "String is too long", minimum: "Number is below minimum",
      maximum: "Number exceeds maximum", pattern: "String does not match required pattern",
      enum: "Value is not an allowed enum member", format: "Value does not match required format",
      const: "Value does not match required constant" } as Record<string, string>)[error.keyword] ?? "Value outside contract constraints";
    return { stage: "schema", path, rule,
      ...(error.keyword === "type" && types.has(error.params.type) ? { expected: error.params.type } : {}),
      ...(typeof error.params.limit === "number" && Number.isFinite(error.params.limit) && Math.abs(error.params.limit) <= 1e9 ? { limit: error.params.limit } : {}) };
  });
}

/** A bounded structural draft: keep schema field names and types, never free text or unknown keys. */
export function safeDraft(value: unknown, contract: string): unknown {
  let budget = 250;
  function snapshot(item: unknown, schema: Json | undefined, depth: number): unknown {
    if (--budget < 0 || depth > 12) return "[truncated]";
    if (schema?.$ref) schema = definitions[schema.$ref.replace("#/$defs/", "")];
    if (typeof item === "string") return schema?.enum?.includes(item) ? item : "[string]";
    if (typeof item === "number") return "[number]";
    if (item === null || typeof item === "boolean") return item;
    if (Array.isArray(item)) return item.slice(0, 30).map(v => snapshot(v, schema?.items, depth + 1))
      .concat(item.length > 30 ? ["[truncated]"] : []);
    if (item && typeof item === "object") {
      const entries = Object.entries(item), known = entries.filter(([key]) => schema?.properties && Object.hasOwn(schema.properties, key));
      return Object.fromEntries([...known.map(([key, v]) => [key, snapshot(v, schema!.properties[key], depth + 1)]),
        ...(known.length !== entries.length ? [["[unknown_fields]", entries.length - known.length]] : [])]);
    }
    return "[unparseable]";
  }
  return snapshot(value, definitions[contract], 0);
}

/** Separate local diagnostic ledger, bounded to the last 100 rejected drafts per database. */
export function saveRejectedDraft(db: Store, generationId: string, attempt: number, contract: string,
  draft: unknown, issues: FieldIssue[]) {
  db.connection.exec(`CREATE TABLE IF NOT EXISTS llm_rejected_drafts(
    id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    contract TEXT NOT NULL, snapshot TEXT NOT NULL, diagnostics TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run("INSERT INTO llm_rejected_drafts(id,generation_id,attempt,contract,snapshot,diagnostics) VALUES(?,?,?,?,?,?)",
    randomUUID(), generationId, attempt, contract, JSON.stringify(safeDraft(draft, contract)),
    JSON.stringify(safeDiagnostics({ issues, generation_id: generationId, attempts: attempt, max_attempts: 2, draft_saved: true })));
  db.connection.exec("DELETE FROM llm_rejected_drafts WHERE rowid NOT IN (SELECT rowid FROM llm_rejected_drafts ORDER BY rowid DESC LIMIT 100)");
}
