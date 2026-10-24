import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import type { FormatsPlugin } from "ajv-formats";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";
import { validateEventDetails } from "../news-events.js";
import { validatePaymentContext } from "./payment-context.js";

export class ApiFault extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const schema = JSON.parse(readFileSync(resolve(ROOT, "contracts/v1/schema.json"), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: false });
(createRequire(import.meta.url)("ajv-formats") as FormatsPlugin)(ajv);
ajv.addSchema(schema);
export function validate(name: string, value: unknown, output = false): asserts value is Json {
  const check = ajv.getSchema(`urn:alfa:integration:v1#/$defs/${name}`);
  if (!check) throw new Error("Unknown contract: " + name);
  if (!check(value)) throw new ApiFault(output ? 502 : 422, output ? "CONTRACT_VIOLATION" : "VALIDATION_ERROR", "JSON violates " + name);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const item = node as Json;
    if (item.company_id && item.schema_version && item.payment_summary && item.industry) validatePaymentContext(item);
    if (item.news_id && item.event_id && item.event_type && Array.isArray(item.sources)) {
      if (new Set(item.sources.map((source: Json) => source.id)).size !== item.sources.length) throw new Error("Repeated event source ID");
      validateEventDetails(item);
    }
    Object.values(item).forEach(visit);
  };
  try { visit(value); }
  catch { throw new ApiFault(output ? 502 : 422, output ? "CONTRACT_VIOLATION" : "VALIDATION_ERROR", "Event evidence or payment aggregates are invalid"); }
}
export type Envelope = { meta: { schema_version: string; request_id: string; mode: "mock" | "demo" | "live"; warnings: string[] }; data: Json };
export function envelope(data: Json, requestId: string, mode: "mock" | "demo" | "live", warnings: string[] = []): Envelope {
  return { meta: { schema_version: "1.0.0", request_id: requestId, mode, warnings }, data };
}
export function validateAnalysis(value: Json) {
  validate("Analysis", value, true);
  const sources = new Map<string, Json>(value.sources.map((s: Json) => [s.id, s]));
  if (sources.size !== value.sources.length) throw new ApiFault(502, "CONTRACT_VIOLATION", "Repeated source ID");
  const kinds = new Set(value.claims.map((c: Json) => c.kind));
  if (!kinds.has("fact") || !kinds.has("ai")) throw new ApiFault(502, "CONTRACT_VIOLATION", "Analysis needs fact and ai claims");
  for (const claim of value.claims) {
    const refs: Json[] = claim.source_ids.map((id: string) => sources.get(id));
    if (refs.some(ref => !ref)) throw new ApiFault(502, "CONTRACT_VIOLATION", "Unknown source ID");
    if (claim.kind === "fact" && !refs.some(s => s.kind === "news")) throw new ApiFault(502, "CONTRACT_VIOLATION", "Fact needs news evidence");
    if (claim.kind === "ai" && !(refs.some(s => s.kind === "company") && refs.some(s => s.kind === "news"))) throw new ApiFault(502, "CONTRACT_VIOLATION", "AI claim needs company and news evidence");
    if (claim.kind === "bank" && (!claim.quote.trim() || claim.text !== claim.quote || !refs.some(s => s.kind === "bank" && s.excerpt.includes(claim.quote)))) throw new ApiFault(502, "CONTRACT_VIOLATION", "Bank quote is not in evidence");
  }
}
