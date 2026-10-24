import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";
import type { ResponseSchema } from "../llm.js";
import { GENERATION_BANK_CLAIM_LIMIT, GENERATION_CLAIM_LIMIT } from "./generation-budget.js";

const definitions = JSON.parse(readFileSync(resolve(ROOT, "contracts/v1/schema.json"), "utf8")).$defs;

/** Provider-only projection of the canonical contracts. Local validators remain authoritative. */
function project(node: Json): Json {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    if (!definitions[name]) throw new Error("Unknown response schema reference: " + node.$ref);
    if (name === "Claim") {
      // Strict mode requires every property to be required. Separate quote claims from AI
      // claims instead of introducing null/empty optional fields that our contract rejects.
      const claim = definitions.Claim;
      return { anyOf: [["fact", "bank"], ["ai"]].map(kinds => {
        const fields = kinds[0] === "ai" ? Object.keys(claim.properties) : claim.required;
        return project({ type: "object", additionalProperties: false, required: fields,
          properties: Object.fromEntries(fields.map((key: string) => [key,
            key === "kind" ? { enum: kinds, type: "string" } : claim.properties[key]])) });
      }) };
    }
    return project(definitions[name]);
  }
  // uniqueItems is not part of the provider's strict subset. The unchanged local
  // contracts still enforce it, along with all source and semantic grounding checks.
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "uniqueItems")
    .map(([key, value]) => [key, Array.isArray(value)
      ? value.map(item => item && typeof item === "object" ? project(item) : item)
      : value && typeof value === "object" ? project(value) : value]));
}

/** Strict providers enforce the live claim budget; local validators enforce it for json_object. */
function capClaims(node: Json, limit: number, key = ""): Json {
  if (Array.isArray(node)) return node.map(item => item && typeof item === "object" ? capClaims(item, limit) : item);
  const value: Json = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, v && typeof v === "object" ? capClaims(v, limit, k) : v]));
  if (key === "claims" && value.type === "array") value.maxItems = Math.min(value.maxItems ?? limit, limit);
  if (value.type === "array" && value.items?.type === "integer" && value.items.maximum !== undefined)
    value.items = { ...value.items, maximum: Math.min(value.items.maximum, limit - 1) }, value.maxItems = Math.min(value.maxItems ?? limit, limit);
  return value;
}
/** Optional provider-only cap on claim text/quote length (REPORT8: the strict question grew to 6000 tokens).
 * Off by default: no provider has confirmed maxLength in strict mode; the longest saved verbatim quote is 846 chars. */
function capClaimStrings(node: Json, limit: number): Json {
  if (Array.isArray(node)) return node.map(item => item && typeof item === "object" ? capClaimStrings(item, limit) : item);
  const value: Json = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, v && typeof v === "object" ? capClaimStrings(v, limit) : v]));
  if (value.type === "object" && value.properties?.kind && value.properties?.quote)
    for (const key of ["text", "quote"]) if (value.properties[key]) value.properties[key] = { ...value.properties[key], maxLength: limit };
  return value;
}
export function generatedResponseSchema(name: "GeneratedAnalysis" | "GeneratedAnswer", maxClaimString?: number): ResponseSchema {
  const schema = capClaims(project(definitions[name]), GENERATION_CLAIM_LIMIT);
  return { name, schema: maxClaimString ? capClaimStrings(schema, maxClaimString) : schema };
}

/** REPORT9: strict answers filled all 8 slots with 1 fact + 7 bank and no ai, which a single anyOf list allows.
 * Strict providers get three typed arrays instead; the server joins them back in this order before any validation. */
export const STRICT_CLAIM_GROUPS = [
  { key: "fact_claims", kind: "fact", minItems: 1, maxItems: 2 },
  { key: "bank_claims", kind: "bank", minItems: 0, maxItems: GENERATION_BANK_CLAIM_LIMIT },
  { key: "ai_claims", kind: "ai", minItems: 1, maxItems: GENERATION_CLAIM_LIMIT - 2 - GENERATION_BANK_CLAIM_LIMIT },
] as const;
export const STRICT_CLAIMS_LAYOUT = "Строгий формат: вместо claims верни fact_claims (1–2 дословные цитаты новостей), bank_claims (0–3 дословные цитаты bank-источников) и ai_claims (минимум один ai-вывод). "
  + "Сервер соединяет их в один список claims в порядке fact_claims, bank_claims, ai_claims; все индексы в grounding/claim_indexes и в ошибках /claims/N считаются по этому объединённому списку с нуля. "
  + "Пример: 1 fact, 0 bank, 2 ai — индексы 0 (fact), 1 и 2 (ai).";
export function strictResponseSchema(name: "GeneratedAnalysis" | "GeneratedAnswer", maxClaimString?: number): ResponseSchema {
  const { schema } = generatedResponseSchema(name, maxClaimString);
  const branches: Json[] = schema.properties.claims.items.anyOf;
  const branch = (kind: string) => {
    const base = structuredClone(branches.find(b => b.properties.kind.enum.includes(kind))!);
    base.properties.kind = { type: "string", enum: [kind] };
    // REPORT9 run C: with "^/" alone, strict providers filled profile_paths with twenty "/" (Duplicate items locally).
    if (base.properties.profile_paths) base.properties.profile_paths = { ...base.properties.profile_paths,
      items: { ...base.properties.profile_paths.items, pattern: "^/[a-z_]+(?:/[A-Za-z0-9_]+)*$" }, maxItems: 10 };
    return base;
  };
  const properties: Json = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (key !== "claims") { properties[key] = value; continue; }
    for (const g of STRICT_CLAIM_GROUPS) properties[g.key] = { type: "array", items: branch(g.kind), minItems: g.minItems, maxItems: g.maxItems };
  }
  const required = (schema.required as string[]).flatMap(key => key === "claims" ? STRICT_CLAIM_GROUPS.map(g => g.key) : [key]);
  return { name, schema: { ...schema, properties, required } };
}
/** Join typed strict arrays into the canonical claims list. Anything else is left for the contract to reject. */
export function joinStrictClaims(draft: Json): Json {
  if (!draft || typeof draft !== "object" || Array.isArray(draft) || "claims" in draft
    || !STRICT_CLAIM_GROUPS.every(g => Array.isArray(draft[g.key]))) return draft;
  const { fact_claims, bank_claims, ai_claims, ...rest } = draft;
  return { ...rest, claims: [...fact_claims, ...bank_claims, ...ai_claims] };
}
