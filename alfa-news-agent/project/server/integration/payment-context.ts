import type { Json } from "../types.js";

/** Optional in old snapshots. Checks arithmetic/provenance shape, never business causality. */
export function validatePaymentContext(profile: Json) {
  const summary = profile.payment_summary ?? {}, context = summary.counterparty_context;
  if (context === undefined) return;
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error("Invalid payment context: " + message); };
  const equal = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
  check(context.available === summary.available, "availability disagrees with payment summary");
  if (!context.available) {
    check(context.in === null && context.out === null, "unavailable source has directional statistics");
    check(summary.incoming_amount === null && summary.outgoing_amount === null, "unavailable source has payment amounts"); return;
  }
  for (const [direction, field] of [["in", "incoming_amount"], ["out", "outgoing_amount"]]) {
    const flow = context[direction];
    check(flow !== null && typeof flow === "object", "available source lacks a direction");
    const total = flow.amount_total;
    check(summary[field] !== null && equal(total, summary[field]), "direction total disagrees with summary");
    const share = (amount: number, value: number | null) => check(total === 0 ? value === null : value !== null && equal(value, amount / total),
      "share does not use the full directional amount or zero denominator");
    for (const coverage of Object.values(flow.coverage) as Json[]) {
      check(equal(coverage.known_amount + coverage.unknown_amount, total), "coverage amounts do not sum to total");
      share(coverage.known_amount, coverage.known_share); share(coverage.unknown_amount, coverage.unknown_share);
    }
    for (const kind of ["industry", "group_membership"])
      check(flow.coverage[kind].known_amount <= flow.coverage.company_card.known_amount + Math.max(1e-12, total * 1e-9),
        "known " + kind + " exceeds known company cards");
    const buckets = (rows: Json[]) => {
      check(equal(rows.reduce((sum, row) => sum + row.amount, 0), total), "bucket amounts do not sum to total");
      check(rows.reduce((sum, row) => sum + row.counterparties_count, 0) === flow.counterparties_count, "bucket counts do not sum to direction count");
      const seen = new Set<string>();
      for (const row of rows) {
        share(row.amount, row.share_of_direction);
        check(row.counterparty_ids.length === Math.min(row.counterparties_count, 20)
          && row.counterparty_ids_truncated === (row.counterparties_count > 20), "bucket ID sample and truncation disagree");
        check(!row.counterparty_ids.some((id: string) => seen.has(id)), "counterparty repeated across buckets");
        row.counterparty_ids.forEach((id: string) => seen.add(id));
      }
    };
    const industries: Json[] = flow.industry_distribution, codes = industries.map(row => row.okved_division);
    check(new Set(codes).size === codes.length && codes.filter(code => code === null).length === 1, "industry buckets need unique codes and one unknown bucket");
    check(industries.every(row => (row.okved_division === null) === (row.sector === null)), "unknown industry must remain unknown");
    buckets(industries);
    check(equal(industries.filter(row => row.okved_division !== null).reduce((sum, row) => sum + row.amount, 0), flow.coverage.industry.known_amount),
      "industry distribution disagrees with coverage");
    const groups = flow.group_distribution;
    if (!profile.group.group_id) check(flow.coverage.group_membership.known_amount === 0
      && ["same_group", "other_group"].every(key => groups[key].counterparties_count === 0 && groups[key].amount === 0),
      "group classification requires a known own group");
    buckets(Object.values(groups));
    check(equal(groups.same_group.amount + groups.other_group.amount, flow.coverage.group_membership.known_amount), "group distribution disagrees with coverage");
    check(equal(groups.unknown.amount, flow.coverage.group_membership.unknown_amount), "unknown group amount disagrees with coverage");
  }
}
