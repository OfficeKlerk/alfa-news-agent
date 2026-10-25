import { test } from "node:test";
import assert from "node:assert/strict";
import { ageDays, freshnessSummary, diversitySummary, fresherRelevantAvailable, meanOf } from "../retrieval-freshness.js";
import type { RankedEvidence } from "../retrieval-evaluation.js";

const row = (filename: string, page: number, published_at: string | null): RankedEvidence =>
  ({ filename, document_id: "doc:" + filename, page, published_at });
const AS_OF = "2026-10-24T00:00:00Z";

test("ageDays measures whole days, rejects a timezone-less as_of, and tolerates missing dates", () => {
  assert.equal(ageDays("2026-10-14T00:00:00Z", AS_OF), 10);
  assert.equal(ageDays("2026-10-24T00:00:00Z", AS_OF), 0);
  assert.equal(ageDays("2026-10-26T00:00:00Z", AS_OF), -2); // published after as_of
  assert.equal(ageDays(null, AS_OF), null);
  assert.equal(ageDays("not-a-date", AS_OF), null);
  assert.throws(() => ageDays("2026-10-14", "2026-10-24"), /explicit timezone/);
});

test("freshnessSummary reports newest/oldest/median age and the stale share over a threshold", () => {
  const rows = [row("a", 1, "2026-10-04T00:00:00Z"), row("a", 2, "2026-10-04T00:00:00Z"),
    row("b", 1, "2026-07-24T00:00:00Z"), row("c", 1, "2026-09-24T00:00:00Z"), row("d", 1, null)];
  const f = freshnessSummary(rows, AS_OF, 60);
  assert.equal(f.count, 5); assert.equal(f.dated, 4); assert.equal(f.undated, 1);
  assert.equal(f.newest_age_days, 20);   // 2026-10-04
  assert.equal(f.oldest_age_days, 92);   // 2026-07-24
  assert.equal(f.median_age_days, 25);   // median of [20,20,30,92] = (20+30)/2
  assert.equal(f.stale_share, 0.25);     // only the July page is older than 60 days
  assert.equal(f.future_dated, 0);
  assert.equal(freshnessSummary([], AS_OF).stale_share, null);
});

test("diversitySummary exposes single-document crowding (the 4-of-5 case)", () => {
  const crowded = [row("july", 12, "2026-07-22T00:00:00Z"), row("july", 13, "2026-07-22T00:00:00Z"),
    row("july", 19, "2026-07-22T00:00:00Z"), row("july", 9, "2026-07-22T00:00:00Z"), row("macro", 1, "2026-07-31T00:00:00Z")];
  const d = diversitySummary(crowded);
  assert.equal(d.sources, 5); assert.equal(d.distinct_documents, 2);
  assert.equal(d.max_pages_from_single_document, 4);
  assert.equal(d.top_document_share, 0.8);
  const varied = [row("a", 1, null), row("b", 1, null), row("c", 1, null)];
  assert.equal(diversitySummary(varied).top_document_share, 1 / 3);
  assert.equal(diversitySummary([]).top_document_share, null);
});

test("fresherRelevantAvailable flags an un-surfaced fresher relevant document", () => {
  const returned = [row("july", 9, "2026-07-22T00:00:00Z"), row("noise", 1, "2026-08-01T00:00:00Z")];
  // a relevant September review exists and is fresher than the returned July one -> true
  assert.equal(fresherRelevantAvailable(returned, ["july"], ["2026-07-22T00:00:00Z", "2026-09-14T00:00:00Z"], AS_OF), true);
  // only the returned July date is available -> nothing fresher
  assert.equal(fresherRelevantAvailable(returned, ["july"], ["2026-07-22T00:00:00Z"], AS_OF), false);
  // no relevant document returned -> not comparable
  assert.equal(fresherRelevantAvailable(returned, ["absent"], ["2026-09-14T00:00:00Z"], AS_OF), null);
});

test("meanOf averages present numbers and ignores nulls", () => {
  assert.equal(meanOf([{ x: 2 }, { x: 4 }, { x: null }], "x"), 3);
  assert.equal(meanOf([{ x: null }], "x"), null);
});
