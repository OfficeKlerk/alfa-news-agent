/** Evaluation only: does not change serving, prompts, corpus or retrieval ordering. */
import { normalizePublicationDate } from "../news-events.js";
import type { Json } from "../types.js";

export interface EvaluationQuery { id: string; query: string; expected: string[]; topic?: string }
export interface RankedEvidence { filename: string; document_id: string; page: number; source_id?: string; published_at?: string | null; excerpt_sha256?: string; score?: number }

export function validateEvaluationInputs(pages: Json[], input: unknown): EvaluationQuery[] {
  if (!Array.isArray(pages) || !pages.length) throw new Error("Corpus must contain pages");
  const ids = new Set<string>(), pageKeys = new Set<string>(), names = new Map<string,string>(), documents = new Map<string,string>();
  for (const page of pages) {
    const key = JSON.stringify([page.document_id, page.page]);
    if (typeof page.id !== "string" || !page.id || ids.has(page.id) || typeof page.document_id !== "string" || !page.document_id ||
        typeof page.filename !== "string" || !page.filename || typeof page.text !== "string" ||
        !Number.isInteger(page.page) || page.page < 1 || pageKeys.has(key)) throw new Error("Invalid or repeated corpus page");
    if (names.has(page.filename) && names.get(page.filename) !== page.document_id) throw new Error("Ambiguous document filename");
    if (documents.has(page.document_id) && documents.get(page.document_id) !== page.filename) throw new Error("Ambiguous document ID");
    names.set(page.filename,page.document_id); documents.set(page.document_id,page.filename); ids.add(page.id); pageKeys.add(key);
  }
  const queries = (input as Json)?.queries;
  if (!Array.isArray(queries) || !queries.length) throw new Error("Query set is empty");
  const seen = new Set<string>();
  for (const q of queries) {
    if (!q || typeof q.id !== "string" || !q.id || seen.has(q.id) || typeof q.query !== "string" || !q.query.trim() || q.query.length > 500 ||
        !Array.isArray(q.expected) || !q.expected.length || new Set(q.expected).size !== q.expected.length ||
        q.expected.some((f: unknown) => typeof f !== "string" || !names.has(f))) throw new Error("Invalid query ID/text/expected document");
    seen.add(q.id);
  }
  return queries;
}

export function eligibleGroundTruth(query: EvaluationQuery, pages: Json[], asOf: string) {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff) || normalizePublicationDate(asOf).status !== "valid" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)) throw new Error("as_of requires a valid timestamp with an explicit timezone");
  const expected: string[] = [], blocked: { filename: string; reason: string }[] = [];
  for (const filename of query.expected) {
    const dates = pages.filter(p => p.filename === filename).map(p => normalizePublicationDate(p.published_at ?? p.published ?? p.date).value);
    if (dates.some(d => d !== null && Date.parse(d) <= cutoff)) expected.push(filename);
    else blocked.push({ filename, reason: dates.some(d => d !== null) ? "future_publication" : "unknown_or_invalid_publication_date" });
  }
  return { expected, blocked };
}

export function uniqueDocuments(rows: RankedEvidence[]): RankedEvidence[] {
  const seen = new Set<string>();
  return rows.filter(row => { if (seen.has(row.filename)) return false; seen.add(row.filename); return true; });
}

/** MRR@k is truncated at k; repeated chunks cannot multiply document recall. */
export function retrievalMetrics(rankedFiles: string[], expected: string[], k: number) {
  if (!Number.isInteger(k) || k < 1 || !expected.length || new Set(expected).size !== expected.length) throw new Error("Metrics require k>=1 and nonempty unique targets");
  const top = rankedFiles.slice(0,k), relevant = new Set(expected), found = new Set(top.filter(f => relevant.has(f)));
  const rank = top.findIndex(f => relevant.has(f));
  return { hit_at_k: Number(found.size > 0), recall_at_k: found.size / relevant.size, mrr_at_k: rank < 0 ? 0 : 1/(rank+1) };
}

export function aggregateMetrics(rows: { ranked: string[]; expected: string[] }[], k: number) {
  const eligible = rows.filter(r => r.expected.length > 0);
  if (!eligible.length) return { n: 0, hit_at_k: null, recall_at_k: null, mrr_at_k: null };
  const scores = eligible.map(r => retrievalMetrics(r.ranked,r.expected,k));
  const mean = (key: keyof ReturnType<typeof retrievalMetrics>) => scores.reduce((sum,row)=>sum+row[key],0)/scores.length;
  return { n:eligible.length, hit_at_k:mean("hit_at_k"), recall_at_k:mean("recall_at_k"), mrr_at_k:mean("mrr_at_k") };
}

export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  if (values.some(v => !Number.isFinite(v) || v < 0) || quantile < 0 || quantile > 1) throw new Error("Invalid latency samples");
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(quantile*sorted.length)-1)];
}

export function validateReference(reference: Json, queries: EvaluationQuery[], eligiblePages: Json[], k=5) {
  const names = new Set(eligiblePages.map(p=>p.filename)), keys = Object.keys(reference?.queries ?? {});
  if (reference?._retriever !== "bm25_lexical_reference" || reference.k !== k ||
      keys.length !== queries.length || queries.some(q=>!keys.includes(q.id))) throw new Error("Reference has wrong method/k/query set");
  for (const q of queries) {
    const items = reference.queries[q.id];
    if (!Array.isArray(items) || items.length > k || new Set(items.map((r: Json)=>r.filename)).size !== items.length ||
        items.some((r: Json)=>!names.has(r.filename) || !eligiblePages.some(p=>p.document_id===r.document_id && p.filename===r.filename && p.page===r.page) || !Number.isFinite(r.score))) throw new Error("Invalid BM25 reference document/page");
  }
}
