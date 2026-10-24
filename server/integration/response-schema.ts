import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";
import type { ResponseSchema } from "../llm.js";
import { GENERATION_CLAIM_LIMIT } from "./generation-budget.js";

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
export function generatedResponseSchema(name: "GeneratedAnalysis" | "GeneratedAnswer"): ResponseSchema {
  return { name, schema: capClaims(project(definitions[name]), GENERATION_CLAIM_LIMIT) };
}
