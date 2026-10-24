import { createHash } from "node:crypto";
import { ApiFault, validate } from "./contracts.js";
import type { Json } from "../types.js";
import { groundRateTyping, validateEventDetails } from "../news-events.js";

/** Sort object keys only: arrays, null, false and numeric values keep their meaning. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
  return JSON.stringify(sorted(value));
}

export function companySource(input: Json): Json {
  return { id: "company:" + input.company_id, kind: "company", title: "Компания " + input.company_id,
    url: null, excerpt: canonicalJson(input.profile), document_id: null, page: null,
    published_at: null, is_mock: input.is_mock };
}
export function prepareContext(input: Json, maxBytes = 200_000) {
  validate("AgentRequest", input, true);
  // Derive a confirmed key-rate decision's typing from the quoted evidence before
  // any guardrail reads it, so a rate hold supplied as event_type "other" (or with
  // no direction) still engages monitoring_only instead of inviting an invented shock.
  input = { ...input, event: groundRateTyping(input.event) };
  const fail = (condition: boolean, message: string) => {
    if (!condition) throw new ApiFault(502, "CONTRACT_VIOLATION", message);
  };
  fail(input.profile.company_id === input.company_id, "Profile belongs to another company");
  fail(input.ranked_item.news_id === input.event.news_id && input.ranked_item.event_id === input.event.event_id, "Rank belongs to another event");
  try { validateEventDetails(input.event); }
  catch { throw new ApiFault(502, "CONTRACT_VIOLATION", "Event details are not grounded in supplied news evidence"); }
  const cutoff = Date.parse(input.as_of);
  fail(Date.parse(input.event.published_at) <= cutoff, "Future news");
  fail(input.event.sources.every((s: Json) => s.published_at && Date.parse(s.published_at) <= cutoff), "Undated or future news evidence");
  fail(input.research.items.every((s: Json) => s.kind === "bank" && s.published_at && Date.parse(s.published_at) <= cutoff), "Undated or future bank evidence");
  const sources = [companySource(input), ...input.event.sources, ...input.research.items];
  fail(new Set(sources.map(s => s.id)).size === sources.length, "Duplicate source ID");
  const serialized = canonicalJson({ input, sources });
  const serialized_bytes = Buffer.byteLength(serialized);
  if (serialized_bytes > maxBytes) throw new ApiFault(422, "VALIDATION_ERROR", "Context is too large; reduce input explicitly");
  return { input, sources, sha256: createHash("sha256").update(serialized).digest("hex"), serialized_bytes };
}
