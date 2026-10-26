"""Read-only API for the news ranking/agent module."""

import json
import re
import sqlite3
from collections import defaultdict
from decimal import Decimal, localcontext
from pathlib import Path

from .build import SCHEMA_VERSION
from .exposure import payment_environment
from .io import PRODUCTS, REVENUE_MULTIPLIERS, decimal_share, exact_add, exact_sum, flag, number, numeric, sector
from .signals import relevance_signals


class ContextStore:
    def __init__(self, database):
        self.connection = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
        self.connection.row_factory = sqlite3.Row
        try:
            self.metadata = {row["key"]: json.loads(row["value"])
                             for row in self.connection.execute("SELECT * FROM metadata")}
            if self.metadata.get("schema_version") != SCHEMA_VERSION:
                raise ValueError("Unsupported context database version; rebuild the database")
        except Exception:
            self.close()
            raise

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _source(self, source, records, total=None):
        return {"source": source, "file": self.metadata["sources"][source]["file"],
                "records": records, "records_total": len(records) if total is None else total,
                "records_truncated": total is not None and total > len(records)}

    def list_companies(self, limit=20, offset=0, large_only=False):
        """Stable, bounded listing. Large-company filtering needs confirmed units."""
        if not 1 <= limit <= 1000 or offset < 0:
            raise ValueError("limit must be 1..1000; offset must be non-negative")
        multiplier = REVENUE_MULTIPLIERS[self.metadata["revenue_unit"]]
        if large_only and multiplier is None:
            raise ValueError("Set revenue units when building the database before filtering large companies")
        # Decimal comparison also works for raw revenues stored in scientific notation.
        found = []
        skipped = 0
        for row in self.connection.execute("SELECT id, revenue FROM companies ORDER BY id"):
            if large_only and (row["revenue"] is None or Decimal(row["revenue"]) * multiplier <= 15_000_000_000):
                continue
            if skipped < offset:
                skipped += 1
                continue
            found.append(row["id"])
            if len(found) == limit:
                break
        return found

    def _position(self, company):
        if not company["division"]:
            return {"available": False, "reason": "unknown_okved_division", "market_share": None}
        peers = self.connection.execute("SELECT revenue FROM companies WHERE division=?", (company["division"],))
        values = [Decimal(row[0]) for row in peers if row[0] is not None]
        value = Decimal(company["revenue"]) if company["revenue"] is not None else None
        total = exact_sum(values)
        ordered = sorted(values)
        n = len(ordered)
        median = (ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2) if n else None
        return {
            "available": value is not None and n > 0,
            "comparison_basis": "provided_dataset_same_two_digit_okved",
            "okved_division": company["division"],
            "companies_with_known_revenue": n,
            "revenue_rank": 1 + sum(other > value for other in values) if value is not None else None,
            "revenue_percentile": float(Decimal(sum(other <= value for other in values)) / n) if value is not None and n else None,
            "median_revenue_raw": numeric(median),
            "share_of_observed_revenue": float(value / total) if value is not None and total else None,
            "market_share": None,
            "limitation": "Выборка не является полным рынком. Период выручки и полнота покрытия не подтверждены.",
            "evidence": {"source": "companies", "fields": ["MAINOKVED_CODE", "REVENUE_COMPANY"],
                         "filter": {"okved_division": company["division"]}},
        }

    def _payments(self, uid, top_n):
        edges = {}
        totals = {"in": Decimal(0), "out": Decimal(0)}
        counts = {"in": 0, "out": 0}
        for direction, query in [
            ("out", "SELECT beneficiary AS other, amount, count, source_record FROM payments WHERE payer=? AND beneficiary<>payer"),
            ("in", "SELECT payer AS other, amount, count, source_record FROM payments WHERE beneficiary=? AND payer<>beneficiary"),
        ]:
            for row in self.connection.execute(query, (uid,)):
                edge = edges.setdefault((row["other"], direction),
                                        {"amount": Decimal(0), "count": 0, "records": [], "records_total": 0})
                amount = Decimal(row["amount"])
                edge["amount"] = exact_add(edge["amount"], amount)
                edge["count"] += row["count"]
                edge["records_total"] += 1
                if len(edge["records"]) < 20:
                    edge["records"].append(row["source_record"])
                totals[direction] = exact_add(totals[direction], amount)
                counts[direction] += row["count"]
        result = []
        ranked = sorted(edges.items(), key=lambda pair: (pair[1]["amount"].copy_negate(), *pair[0]))
        for (other, direction), edge in ranked[:top_n]:
            card = self.connection.execute("SELECT data FROM companies WHERE id=?", (other,)).fetchone()
            raw = json.loads(card[0]) if card else {}
            result.append({
                "company_id": other, "direction": direction,
                "pay_amount": numeric(edge["amount"]), "pay_count": edge["count"],
                "share_of_direction": decimal_share(edge["amount"], totals[direction]),
                "role": "получатель платежей" if direction == "out" else "отправитель платежей",
                "company_card_available": card is not None,
                "industry": {"okved_code": raw.get("MAINOKVED_CODE"), "name": raw.get("MAINOKVED_NAME")},
                "source": self._source("payments", edge["records"], edge["records_total"]),
            })
        concentration = {}
        for direction in ("in", "out"):
            amounts = sorted((e["amount"] for (_, d), e in edges.items() if d == direction), reverse=True)
            total = totals[direction]
            with localcontext() as context:
                context.prec = 28
                hhi = float(sum(((amount / total)**2 for amount in amounts), Decimal(0))) if total else None
            concentration[direction] = {
                "counterparties_count": len(amounts),
                "largest_share": decimal_share(amounts[0], total) if amounts else None,
                "top_5_share": decimal_share(exact_sum(amounts[:5]), total),
                "hhi": hhi,
            }
        available = "payments" in self.metadata["sources"]
        return result, {
            "available": available,
            "incoming_amount": numeric(totals["in"]) if available else None,
            "outgoing_amount": numeric(totals["out"]) if available else None,
            "incoming_count": counts["in"] if available else None,
            "outgoing_count": counts["out"] if available else None,
            "counterparty_directions_total": len(edges), "counterparties_truncated": len(edges) > top_n,
            "concentration": concentration, "currency": None, "period": None,
            "counterparty_context": payment_environment(self.connection, uid, edges, totals, available),
            "limitation": "Только наблюдаемые платежи; валюта, период и договорные роли не заданы.",
        }

    def get_company_profile(self, company_id, top_n=20):
        if not 1 <= top_n <= 1000:
            raise ValueError("top_n must be 1..1000")
        company = self.connection.execute("SELECT * FROM companies WHERE id=?", (company_id,)).fetchone()
        if company is None:
            raise KeyError(f"Unknown company: {company_id}")
        row = json.loads(company["data"])
        products = {key: flag(row.get(column)) for key, column in PRODUCTS.items()}
        revenue = number(row.get("REVENUE_COMPANY"))
        multiplier = REVENUE_MULTIPLIERS[self.metadata["revenue_unit"]]
        revenue_rub = revenue * multiplier if revenue is not None and multiplier is not None else None
        countries = sorted(set(filter(None, (value.strip() for value in re.split(r"[,;|]", row.get("FTS_COUNTRY_NAME") or "")))))
        fts = flag(row.get("FTS_FLAG"))
        variants = self.connection.execute("SELECT source_record, data FROM company_variants WHERE company=? ORDER BY source_record", (company_id,)).fetchall()
        raw_variants = [json.loads(item["data"]) for item in variants]
        conflicting_fields = sorted(key for key in row if len({item.get(key) for item in raw_variants}) > 1)
        warnings = []
        if variants:
            warnings.append("duplicate_company_records")
        if conflicting_fields:
            warnings.append("conflicting_company_records")
        missing = [key for key in ["MAINOKVED_CODE", "MAINOKVED_NAME", "REVENUE_COMPANY", "REGION",
                                  "CITY", "FTS_FLAG", *PRODUCTS.values()] if row.get(key) is None]
        for column in [*PRODUCTS.values(), "FTS_FLAG", "NEGATIVEMARK"]:
            if row.get(column) is not None and flag(row[column]) is None:
                warnings.append("unrecognized_boolean:" + column)
        if row.get("REVENUE_COMPANY") is not None and revenue is None:
            warnings.append("invalid_revenue")
        if row.get("MAINOKVED_CODE") and sector(row["MAINOKVED_CODE"]) is None:
            warnings.append("unknown_okved_sector")
        if multiplier is None:
            warnings.append("revenue_unit_unknown")
        if fts is False and countries:
            warnings.append("fts_flag_conflicts_with_countries")
        if fts is True and not countries:
            warnings.append("fts_countries_missing")
        for source in ("links", "payments"):
            if source not in self.metadata["sources"]:
                warnings.append(source + "_not_provided")
        if self.metadata["audit"]["issues"]:
            warnings.append("source_dataset_has_quality_issues; see dataset_audit")
        group_rows = []
        if company["group_id"]:
            group_rows = self.connection.execute("SELECT id, revenue, source_record FROM companies WHERE group_id=? ORDER BY id",
                                                 (company["group_id"],)).fetchall()
        group_values = [Decimal(c["revenue"]) for c in group_rows if c["revenue"] is not None]
        related = defaultdict(lambda: {"people": set(), "records": set()})
        for link in self.connection.execute("""
            SELECT b.company, a.person, a.source_record AS own_record, b.source_record AS other_record
            FROM links a JOIN links b ON a.person=b.person
            WHERE a.company=? AND b.company<>? ORDER BY b.company, a.person
        """, (company_id, company_id)):
            related[link["company"]]["people"].add(link["person"])
            related[link["company"]]["records"].update([link["own_record"], link["other_record"]])
        counterparties, payment_summary = self._payments(company_id, top_n)
        profile = {
            "schema_version": SCHEMA_VERSION, "company_id": company_id,
            "industry": {"okved_code": row.get("MAINOKVED_CODE"), "name": row.get("MAINOKVED_NAME"),
                         "sector": sector(row.get("MAINOKVED_CODE")), "okved_division": company["division"]},
            "scale": {"revenue_raw": numeric(revenue), "revenue_unit": self.metadata["revenue_unit"],
                      "revenue_rub": numeric(revenue_rub),
                      "is_large_business": revenue_rub > 15_000_000_000 if revenue_rub is not None else None,
                      "employees_band": row.get("AMOUNT_WORKERS_FNS_GRADATION") or row.get("AMOUNT_WORKERS_SPARK_GRADATION"),
                      "employees_fns_band": row.get("AMOUNT_WORKERS_FNS_GRADATION"),
                      "employees_spark_band": row.get("AMOUNT_WORKERS_SPARK_GRADATION")},
            "company_attributes": {
                "organization_type": row.get("ORG_TYPE"), "ownership_form": row.get("OKFS_NAME"),
                "age_band": row.get("COMPANY_AGE_YEARS_GRADATION"), "development_stage": row.get("ECO_MARK_LABEL"),
                "client_type": row.get("CL_TYPE"), "key_owner_mark": flag(row.get("NEGATIVEMARK")),
            },
            "bank_products": products,
            "foreign_trade": {"has_fts": fts, "countries": countries, "trade_direction": None, "currencies": None},
            "geography": {"region": row.get("REGION"), "city": row.get("CITY")},
            "dataset_position": self._position(company),
            "group": {"group_id": company["group_id"], "members": [c["id"] for c in group_rows[:top_n]],
                      "members_total": len(group_rows), "members_truncated": len(group_rows) > top_n,
                      "observed_revenue_raw_sum": numeric(exact_sum(group_values)) if group_values else None,
                      "members_with_known_revenue": len(group_values),
                      "limitation": "Наблюдаемые участники; сумма выручки не консолидирована, внутригрупповой оборот не исключён.",
                      "source": self._source("companies", [c["source_record"] for c in group_rows[:top_n]], len(group_rows))},
            "related_companies": [{"company_id": uid, "shared_people_count": len(value["people"]),
                                   "source": self._source("links", sorted(value["records"])[:20], len(value["records"]))}
                                  for uid, value in sorted(related.items())[:top_n]],
            "related_companies_total": len(related), "related_companies_truncated": len(related) > top_n,
            "counterparties": counterparties, "payment_summary": payment_summary,
            "data_quality": {"missing_fields": missing, "warnings": warnings, "conflicting_fields": conflicting_fields, "company_records_total": len(variants) or 1},
            "provenance": {"company": self._source("companies", [v["source_record"] for v in variants[:20]] if variants else [company["source_record"]], len(variants) or 1),
                           "company_record_variants": [{"record": v["source_record"], "fields": json.loads(v["data"])} for v in variants[:20]],
                           "company_record_variants_truncated": len(variants) > 20,
                           "company_raw_fields": row, "sources": self.metadata["sources"],
                           "snapshot_built_at": self.metadata["built_at"],
                           "record_numbering": "logical CSV records, header=1",
                           "signal_method": "deterministic_rules_v2",
                           "weight_meaning": "эвристический приоритет темы; не вероятность и не оценка ущерба"},
        }
        profile["relevance_signals"] = relevance_signals(profile)
        return profile

    # Short alias for callers that prefer store.profile(id).
    profile = get_company_profile
