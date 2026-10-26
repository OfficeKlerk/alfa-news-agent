"""Semantic checks for observed payment aggregates at the service boundary.

Older frozen profiles can omit this optional block. Shares describe observed
amounts, not suppliers, ownership or prospective financial effects.
"""
from math import isclose


def validate_payment_context(profile):
    summary = profile.get("payment_summary", {})
    context = summary.get("counterparty_context")
    if context is None:
        return

    def check(ok, message):
        if not ok:
            raise ValueError("Invalid payment context: " + message)

    def equal(left, right):
        return isclose(left, right, rel_tol=1e-9, abs_tol=1e-12)

    check(context["available"] == summary["available"], "availability disagrees with payment summary")
    if not context["available"]:
        check(context["in"] is None and context["out"] is None, "unavailable source has directional statistics")
        check(summary["incoming_amount"] is None and summary["outgoing_amount"] is None, "unavailable source has payment amounts")
        return
    for direction, field in (("in", "incoming_amount"), ("out", "outgoing_amount")):
        flow = context[direction]
        check(isinstance(flow, dict), "available source lacks a direction")
        total = flow["amount_total"]
        check(summary[field] is not None and equal(total, summary[field]), "direction total disagrees with summary")

        def share(amount, value):
            check(value is None if total == 0 else value is not None and equal(value, amount / total),
                  "share does not use the full directional amount or zero denominator")

        for coverage in flow["coverage"].values():
            check(equal(coverage["known_amount"] + coverage["unknown_amount"], total), "coverage amounts do not sum to total")
            share(coverage["known_amount"], coverage["known_share"])
            share(coverage["unknown_amount"], coverage["unknown_share"])
        for kind in ("industry", "group_membership"):
            check(flow["coverage"][kind]["known_amount"] <= flow["coverage"]["company_card"]["known_amount"] + max(1e-12, total * 1e-9),
                  "known " + kind + " exceeds known company cards")

        def buckets(rows):
            check(equal(sum(row["amount"] for row in rows), total), "bucket amounts do not sum to total")
            check(sum(row["counterparties_count"] for row in rows) == flow["counterparties_count"], "bucket counts do not sum to direction count")
            seen = set()
            for row in rows:
                share(row["amount"], row["share_of_direction"])
                count, ids = row["counterparties_count"], row["counterparty_ids"]
                check(len(ids) == min(count, 20) and row["counterparty_ids_truncated"] == (count > 20), "bucket ID sample and truncation disagree")
                check(not seen.intersection(ids), "counterparty repeated across buckets")
                seen.update(ids)

        industries = flow["industry_distribution"]
        codes = [row["okved_division"] for row in industries]
        check(len(codes) == len(set(codes)) and codes.count(None) == 1, "industry buckets need unique codes and one unknown bucket")
        check(all((row["okved_division"] is None) == (row["sector"] is None) for row in industries), "unknown industry must remain unknown")
        buckets(industries)
        check(equal(sum(row["amount"] for row in industries if row["okved_division"] is not None), flow["coverage"]["industry"]["known_amount"]),
              "industry distribution disagrees with coverage")
        groups = flow["group_distribution"]
        if not profile["group"]["group_id"]:
            check(flow["coverage"]["group_membership"]["known_amount"] == 0
                  and all(groups[key]["counterparties_count"] == 0 and groups[key]["amount"] == 0 for key in ("same_group", "other_group")),
                  "group classification requires a known own group")
        buckets(list(groups.values()))
        check(equal(groups["same_group"]["amount"] + groups["other_group"]["amount"], flow["coverage"]["group_membership"]["known_amount"]),
              "group distribution disagrees with coverage")
        check(equal(groups["unknown"]["amount"], flow["coverage"]["group_membership"]["unknown_amount"]), "unknown group amount disagrees with coverage")
