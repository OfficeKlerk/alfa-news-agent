"""One-hop relevance across ALL observed payments, independent of profile top_n."""

from decimal import Decimal
import json
import re

from company_context.io import decimal_share, exact_add, exact_sum, flag, numeric
from .contracts import normalized, validate_event


class PaymentGraph:
    def __init__(self, store, company_id):
        self.store = store
        self.company_id = company_id
        self.available = "payments" in store.metadata["sources"]
        self.edges = {"in": {}, "out": {}}
        self.related = {}
        for row in store.connection.execute("""
                SELECT b.id, a.source_record AS own_record, b.source_record AS other_record
                FROM companies a JOIN companies b ON a.group_id=b.group_id
                WHERE a.id=? AND b.id<>a.id AND a.group_id IS NOT NULL""", (company_id,)):
            self.related.setdefault(row["id"], []).append({"kind": "same_group", "source": "companies",
                "records": [row["own_record"], row["other_record"]]})
        for row in store.connection.execute("""
                SELECT b.company, a.source_record AS own_record, b.source_record AS other_record
                FROM links a JOIN links b ON a.person=b.person WHERE a.company=? AND b.company<>?""", (company_id, company_id)):
            self.related.setdefault(row["company"], []).append({"kind": "shared_person", "source": "links",
                "records": [row["own_record"], row["other_record"]]})
        # Each indexed query streams all rows for this client, rather than the top-N profile.
        for direction, owner, other in (("out", "payer", "beneficiary"), ("in", "beneficiary", "payer")):
            query = f"""SELECT p.{other} AS other, p.amount, p.source_record,
                        c.data, c.division, c.source_record AS card_record
                        FROM payments p LEFT JOIN companies c ON c.id=p.{other}
                        WHERE p.{owner}=?"""
            for row in store.connection.execute(query, (company_id,)):
                edge = self.edges[direction].setdefault(row["other"], {
                    "amount": Decimal(0), "records": [], "records_total": 0,
                    "raw": json.loads(row["data"]) if row["data"] else None,
                    "division": row["division"], "card_record": row["card_record"],
                })
                edge["amount"] = exact_add(edge["amount"], Decimal(row["amount"]))
                edge["records_total"] += 1
                if len(edge["records"]) < 20:
                    edge["records"].append(row["source_record"])

    def exposure(self, event, evidence_limit=20, feature_version="company_event_v1"):
        validate_event(event)
        from .features import feature_names
        feature_names(feature_version)
        event_details = event.get("event_details") or {}
        targets = event_details.get("target_okved_codes", []) if feature_version == "company_event_v2" else []
        subjects = event_details.get("subject_okved_codes", []) if feature_version == "company_event_v2" and not targets else []
        selectors = targets or subjects
        if not isinstance(evidence_limit, int) or not 1 <= evidence_limit <= 1000:
            raise ValueError("evidence_limit must be 1..1000")
        result = {"available": self.available, "method": "one_hop_payment_share_v2" if feature_version == "company_event_v2" else "one_hop_payment_share_v1",
                  "scope": "all_observed_payment_rows", "company_id": self.company_id,
                  "event_id": event["event_id"], "sources": self.store.metadata["sources"],
                  "limitation": "Доля наблюдаемых платежей — признак релевантности, не доля убытка. Роли, валюта и период неизвестны."}
        if selectors:
            result["industry_basis"] = "explicit_target_okved" if targets else "rule_subject_taxonomy"
        result["related_company_matches"] = [
            {"company_id": uid, "connections": self.related[uid][:20],
             "connections_total": len(self.related[uid]), "connections_truncated": len(self.related[uid]) > 20,
             "entity_mapping_source": event["entity_mapping_source"],
             "limitation": "Общая группа или физлицо не доказывают владение или контроль."}
            for uid in sorted(set(event.get("company_ids", [])) & self.related.keys())]
        for direction, edges in self.edges.items():
            total = exact_sum(edge["amount"] for edge in edges.values())
            covered = Decimal(0)
            matched = Decimal(0)
            details = []
            for uid, edge in edges.items():
                raw = edge["raw"] or {}
                reasons, known = [], False
                target_mismatch = False
                if event.get("company_ids"):
                    known = True  # explicit same-namespace mapping supplied upstream
                    if uid in event["company_ids"]:
                        reasons.append("mapped_company_id")
                if selectors:
                    code = str(raw.get("MAINOKVED_CODE") or "").strip()
                    if re.fullmatch(r"\d{2}(?:\.\d{1,2}){0,2}", code):
                        flat = code.replace(".", "")
                        matches = any(flat.startswith(target.replace(".", "")) for target in selectors)
                        coarser = any(target.replace(".", "").startswith(flat) for target in selectors)
                        target_mismatch = not matches and not coarser
                        known |= matches or not coarser
                        if matches:
                            reasons.append("MAINOKVED_CODE" if targets else "MAINOKVED_CODE:subject_taxonomy")
                elif event.get("okved_divisions"):
                    known |= edge["division"] is not None
                    if edge["division"] in event["okved_divisions"]:
                        reasons.append("MAINOKVED_CODE")
                if event.get("regions"):
                    known |= raw.get("REGION") is not None
                    if not target_mismatch and normalized([raw.get("REGION")]) & normalized(event["regions"]):
                        reasons.append("REGION")
                if event.get("countries"):
                    countries = re.split(r"[,;|]", raw.get("FTS_COUNTRY_NAME") or "")
                    fts = flag(raw.get("FTS_FLAG"))
                    known |= fts is False or bool(normalized(countries))
                    if not target_mismatch and fts is not False and normalized(countries) & normalized(event["countries"]):
                        reasons.append("FTS_COUNTRY_NAME")
                if known:
                    covered = exact_add(covered, edge["amount"])
                if reasons:
                    # A counterparty matching several attributes is counted only once.
                    matched = exact_add(matched, edge["amount"])
                    details.append({"company_id": uid, "amount_raw": numeric(edge["amount"]),
                                    "matched_fields": reasons, "company_record": edge["card_record"],
                                    "payment_records": edge["records"], "records_total": edge["records_total"],
                                    "records_truncated": edge["records_total"] > len(edge["records"]),
                                    "entity_mapping_source": event.get("entity_mapping_source")})
            details.sort(key=lambda item: (-item["amount_raw"], item["company_id"]))
            result[direction] = {
                "total_amount_raw": numeric(total) if self.available else None,
                "matched_amount_raw": numeric(matched) if self.available else None,
                "matched_share": decimal_share(matched, total),
                "attribute_coverage_share": decimal_share(covered, total),
                "matched_counterparties": len(details), "evidence": details[:evidence_limit],
                "evidence_truncated": len(details) > evidence_limit,
            }
        return result
