import type { Json } from "../types.js";
import { ApiFault } from "./contracts.js";

function reject(message: string, path: string): never {
  throw new ApiFault(502, "CONTRACT_VIOLATION", path + ": " + message,
    { issues: [{ stage: "grounding", path, rule: message }] });
}
const roots = new Set(["industry", "scale", "company_attributes", "bank_products", "foreign_trade", "geography",
  "dataset_position", "group", "related_companies", "counterparties", "payment_summary"]);
export function profileValue(profile: Json, path: string, location = "/claims"): unknown {
  const parts = path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!roots.has(parts[0]) || parts.some(s => ["__proto__", "prototype", "constructor", "source", "evidence", "limitation"].includes(s))) reject("Invalid business profile path", location);
  if (parts[0] === "payment_summary" && parts[1] === "counterparty_context" && ["method", "scope"].includes(parts[2]))
    reject("Payment aggregation metadata is not a business fact", location);
  let value: any = profile;
  for (const key of parts) {
    if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key)) reject("Invalid business profile path", location);
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) reject("Unknown profile path", location);
    value = value[key];
  }
  if (value !== null && typeof value === "object" && !(Array.isArray(value) && value.every(v => v === null || typeof v !== "object"))) reject("Profile path must select a concrete value", location);
  return value;
}

export function paymentCoveragePaths(profile: Json, path: string): string[] {
  const match = /^(\/payment_summary\/counterparty_context\/(?:in|out))\/(industry_distribution\/|group_distribution\/)/.exec(path);
  if (!match) return [];
  const kind = match[2] === "industry_distribution/" ? "industry" : "group_membership";
  return ["known_share", "unknown_share"].map(key => `${match[1]}/coverage/${kind}/${key}`)
    .filter(pointer => { try { profileValue(profile, pointer); return true; } catch { return false; } });
}

export interface ProfilePathEntry {
  path: string;
  type: "string" | "number" | "boolean" | "null" | "array";
  unknown: boolean;
  coverage_paths: string[];
}
/** Guidance is a bounded subset; the resolver, not this list, is the validation authority. */
export function profilePathIndex(profile: Json, limit = 64) {
  const maxEntries = Math.min(128, Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 64)));
  const candidates = new Map<string, ProfilePathEntry>();
  let visited = 0, truncated = false;
  const service = new Set(["source", "evidence", "limitation", "method", "scope", "provenance", "data_quality", "relevance_signals", "counterparty_ids"]);
  const walk = (value: unknown, path: string, depth: number) => {
    if (++visited > 4000 || depth > 14) { truncated = true; return; }
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value) && value.every(v => v === null || typeof v !== "object")) {
        // Arrays of scalar values are legal; arrays of objects are traversed by real indices.
      } else {
        const entries = Array.isArray(value) ? value.slice(0, 3).map((v, i) => [String(i), v] as const) : Object.entries(value);
        if (Array.isArray(value) && value.length > 3) truncated = true;
        for (const [key, child] of entries) {
          if (!service.has(key) && !["__proto__", "prototype", "constructor"].includes(key))
            walk(child, path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"), depth + 1);
        }
        return;
      }
    }
    try {
      const checked = profileValue(profile, path);
      if (checked !== null && !Array.isArray(checked) && !["string", "number", "boolean"].includes(typeof checked)) return;
      if (typeof checked === "number" && !Number.isFinite(checked)) return;
      candidates.set(path, { path, type: checked === null ? "null" : Array.isArray(checked) ? "array" : typeof checked as ProfilePathEntry["type"],
        unknown: checked === null || checked === "unknown" || checked === "" || Array.isArray(checked) && !checked.length,
        coverage_paths: paymentCoveragePaths(profile, path) });
    } catch { /* Never advertise a path the validator rejects. */ }
  };
  // Visit the key payment block first so very large unrelated arrays cannot starve it.
  for (const root of ["payment_summary", ...[...roots].filter(k => k !== "payment_summary")])
    if (Object.hasOwn(profile, root)) walk(profile[root], "/" + root, 0);
  const priority = (path: string) => /^\/(industry|bank_products|geography)\//.test(path)
    || /\/coverage\/[^/]+\/(?:known_share|unknown_share)$/.test(path) ? 0
    : /\/industry_distribution\/\d+\/(?:share_of_direction|sector|okved_division)$/.test(path) ? 1
    : /\/counterparty_context\//.test(path) ? 2 : 3;
  const selected = new Map<string, ProfilePathEntry>();
  for (const entry of [...candidates.values()].sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path))) {
    if (entry.coverage_paths.some(path => !candidates.has(path))) { truncated = true; continue; }
    const group = [entry, ...entry.coverage_paths.map(p => candidates.get(p)).filter((v): v is ProfilePathEntry => Boolean(v))];
    const needed = group.filter(v => !selected.has(v.path));
    if (selected.size + needed.length > maxEntries) { truncated = true; continue; }
    needed.forEach(v => selected.set(v.path, v));
  }
  return { entries: [...selected.values()], truncated, max_entries: maxEntries,
    rule: "Выбирай только несколько нужных существующих путей из entries, а не копируй весь индекс в claims. Массив объектов целиком запрещён: используй /industry_distribution/0/share_of_direction и связанные coverage_paths, если они есть в этом индексе. Индекс неполный; отсутствие пути в нём не означает ноль или отсутствие связи. source/evidence/limitation и метаданные не являются бизнес-основаниями." };
}
