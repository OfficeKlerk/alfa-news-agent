"""Payment environment over all observed edges, independent of profile top_n."""

from collections import defaultdict
from decimal import Decimal
import json

from .io import decimal_share, division, exact_add, numeric, sector


def payment_environment(connection, company_id, edges, totals, available):
    """Classify amounts, never infer suppliers, ownership, currencies or losses.

    Missing group IDs are unknown, not evidence of external group membership.
    Coverage uses amount shares of the full directional flow, not just known cards.
    """
    result = {
        "available": available, "method": "observed_payment_environment_v1",
        "scope": "all_observed_nonself_payments",
        "evidence": {"sources": ["payments", "companies"],
                     "fields": ["PAYER", "BENEFICIARY", "PAY_AMT", "SYNTHETIC_U", "MAINOKVED_CODE", "GROUP_ID"],
                     "join": "payment counterparty ID = companies.SYNTHETIC_U"},
        "limitation": "Доли наблюдаемых сумм не доказывают поставки, контроль или финансовый ущерб. "
                      "Отсутствующая группа не означает отсутствие групповой связи; валюта и период неизвестны.",
        "in": None, "out": None,
    }
    if not available:
        return result
    ids = sorted({uid for uid, _ in edges})
    cards = {}
    # Stay below SQLite's variable limit; do not issue a query for every counterparty.
    for start in range(0, len(ids), 500):
        batch = ids[start:start + 500]
        placeholders = ",".join("?" for _ in batch)
        for row in connection.execute(f"SELECT id, group_id, data FROM companies WHERE id IN ({placeholders})", batch):
            cards[row["id"]] = (row["group_id"], json.loads(row["data"]))
    own = connection.execute("SELECT group_id FROM companies WHERE id=?", (company_id,)).fetchone()
    own_group = own[0] if own else None

    for direction in ("in", "out"):
        total = totals[direction]
        industry = defaultdict(lambda: {"amount": Decimal(0), "ids": []})
        groups = {key: {"amount": Decimal(0), "ids": []} for key in ("same_group", "other_group", "unknown")}
        known = {key: Decimal(0) for key in ("company_card", "industry", "group_membership")}
        counterparties_count = 0
        for (uid, edge_direction), edge in edges.items():
            if edge_direction != direction:
                continue
            counterparties_count += 1
            amount = edge["amount"]
            card = cards.get(uid)
            raw = card[1] if card else {}
            code = raw.get("MAINOKVED_CODE")
            industry_sector = sector(code)
            industry_key = (division(code), industry_sector) if industry_sector else (None, None)
            industry[industry_key]["amount"] = exact_add(industry[industry_key]["amount"], amount)
            industry[industry_key]["ids"].append(uid)
            if card is not None:
                known["company_card"] = exact_add(known["company_card"], amount)
            if industry_key[0] is not None:
                known["industry"] = exact_add(known["industry"], amount)
            group_key = "unknown"
            if own_group and card and card[0]:
                group_key = "same_group" if own_group == card[0] else "other_group"
                known["group_membership"] = exact_add(known["group_membership"], amount)
            groups[group_key]["amount"] = exact_add(groups[group_key]["amount"], amount)
            groups[group_key]["ids"].append(uid)

        def share(amount):
            return decimal_share(amount, total)

        def bucket(value):
            return {"amount": numeric(value["amount"]), "share_of_direction": share(value["amount"]),
                    "counterparties_count": len(value["ids"]),
                    "counterparty_ids": sorted(value["ids"])[:20],
                    "counterparty_ids_truncated": len(value["ids"]) > 20}

        # Explicit unknown bucket, even if its amount is zero.
        industry.setdefault((None, None), {"amount": Decimal(0), "ids": []})
        distribution = [{"okved_division": key[0], "sector": key[1], **bucket(value)}
                        for key, value in sorted(industry.items(), key=lambda pair: (pair[1]["amount"].copy_negate(), pair[0][0] or ""))]
        result[direction] = {
            "amount_total": numeric(total), "counterparties_count": counterparties_count,
            "coverage": {key: {"known_amount": numeric(amount), "unknown_amount": numeric(exact_add(total, amount.copy_negate())),
                               "known_share": share(amount), "unknown_share": share(exact_add(total, amount.copy_negate()))}
                         for key, amount in known.items()},
            "industry_distribution": distribution,
            "group_distribution": {key: bucket(value) for key, value in groups.items()},
        }
    return result
