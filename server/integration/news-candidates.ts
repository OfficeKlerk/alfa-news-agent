import type { Json } from "../types.js";

function publisher(event: Json): string {
  // Clustered events retain the first publication as their representative.
  // Allocate that event once, even when later reporting adds another source.
  const news = (event.sources ?? []).filter((item:Json)=>item.kind==="news");
  // A cluster can promote a full primary article over an earlier teaser. Its
  // publisher must retain a candidate slot instead of being hidden under the reprint.
  const source = news.find((item:Json)=>item.title===event.title && typeof event.text === "string" && item.excerpt?.includes(event.text)) ?? news[0] ?? event.sources?.[0];
  try { return new URL(source?.url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return "unknown"; }
}

/** Reserve candidates for each publisher before company ranking, then restore date order. */
export function sourceBalancedCandidates(events: Json[], limit: number): { items: Json[]; balanced: boolean } {
  if (events.length <= limit) return { items: events, balanced: false };
  const groups = new Map<string, Json[]>();
  for (const event of events) {
    const key = publisher(event), group = groups.get(key);
    if (group) group.push(event); else groups.set(key, [event]);
  }
  if (groups.size < 2) return { items: events.slice(0, limit), balanced: false };
  const selected = new Set<Json>();
  // Input groups and their rows are newest-first. Empty groups relinquish their
  // quota, so a sparse source cannot make the candidate window unnecessarily small.
  for (let position = 0; selected.size < limit; position++) {
    for (const group of groups.values()) {
      if (position < group.length) selected.add(group[position]);
      if (selected.size === limit) break;
    }
  }
  return { items: events.filter(event => selected.has(event)), balanced: true };
}
