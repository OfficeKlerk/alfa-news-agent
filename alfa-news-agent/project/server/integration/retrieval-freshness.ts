/** Evaluation only: freshness (recency) and diversity (document concentration) of the
 * sources a retriever returns. Does not change serving, prompts, corpus or ordering.
 * Complements retrieval-evaluation.ts (correctness) with "is the returned evidence
 * recent and varied, or stale and crowded into one document?" (TEAM_TASKS2 #5). */
import { normalizePublicationDate } from "../news-events.js";
import type { RankedEvidence } from "./retrieval-evaluation.js";

const DAY_MS = 86_400_000;

function asOfMs(asOf: string): number {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms) || normalizePublicationDate(asOf).status !== "valid" ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)) throw new Error("as_of requires a valid timestamp with an explicit timezone");
  return ms;
}

/** Whole days between a source's publication and as_of. Positive = older than as_of;
 * negative = published after as_of (should never be served, surfaced as a signal).
 * null when the source carries no valid, explicit date. */
export function ageDays(publishedAt: string | null | undefined, asOf: string): number | null {
  const cutoff = asOfMs(asOf);
  const value = normalizePublicationDate(publishedAt ?? "").value;
  return value === null ? null : Math.round((cutoff - Date.parse(value)) / DAY_MS);
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Recency of the returned sources relative to as_of. staleAfterDays marks sources
 * older than that many days; it is a reporting threshold, not a serving filter. */
export function freshnessSummary(rows: RankedEvidence[], asOf: string, staleAfterDays = 90) {
  const ages = rows.map(r => ageDays(r.published_at, asOf));
  const dated = ages.filter((a): a is number => a !== null);
  return {
    count: rows.length,
    dated: dated.length,
    undated: rows.length - dated.length,
    newest_age_days: dated.length ? Math.min(...dated) : null,
    oldest_age_days: dated.length ? Math.max(...dated) : null,
    median_age_days: median(dated),
    stale_after_days: staleAfterDays,
    stale_share: dated.length ? dated.filter(a => a > staleAfterDays).length / dated.length : null,
    future_dated: dated.filter(a => a < 0).length,
  };
}

/** Document concentration of the returned sources. top_document_share near 1 means the
 * results are crowded into a single document (e.g. 4 of 5 pages from one review). */
export function diversitySummary(rows: RankedEvidence[]) {
  const perDocument = new Map<string, number>();
  for (const row of rows) perDocument.set(row.filename, (perDocument.get(row.filename) ?? 0) + 1);
  const counts = [...perDocument.values()];
  return {
    sources: rows.length,
    distinct_documents: perDocument.size,
    max_pages_from_single_document: counts.length ? Math.max(...counts) : 0,
    top_document_share: rows.length ? Math.max(0, ...counts) / rows.length : null,
  };
}

/** Does a dated relevant document exist that is fresher than the freshest relevant one
 * actually returned in the window? Flags "an available fresher review was not surfaced".
 * eligibleRelevantDates: publication dates of relevant documents already date-eligible
 * under as_of. Returns null when the query has no returned relevant source to compare. */
export function fresherRelevantAvailable(returned: RankedEvidence[], relevantFilenames: string[], eligibleRelevantDates: (string | null)[], asOf: string): boolean | null {
  const relevant = new Set(relevantFilenames);
  const returnedAges = returned.filter(r => relevant.has(r.filename)).map(r => ageDays(r.published_at, asOf)).filter((a): a is number => a !== null);
  if (!returnedAges.length) return null;
  const freshestReturned = Math.min(...returnedAges);
  const availableAges = eligibleRelevantDates.map(d => ageDays(d, asOf)).filter((a): a is number => a !== null);
  return availableAges.some(a => a >= 0 && a < freshestReturned);
}

/** Mean of a per-query numeric field, ignoring nulls. */
export function meanOf(rows: Record<string, unknown>[], key: string): number | null {
  const values = rows.map(r => r[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}
