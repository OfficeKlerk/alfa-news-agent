"""Build an indexed SQLite snapshot from the three CSV sources, without an LLM."""

import json
import os
import sqlite3
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .io import PRODUCTS, REVENUE_MULTIPLIERS, csv_rows, division, flag, number, source_info

SCHEMA_VERSION = "1.0"


class Audit:
    def __init__(self):
        self.rows = Counter()
        self.issues = Counter()
        self.examples = []
        self.missing_fields = Counter()

    def issue(self, kind, source, record):
        self.issues[kind] += 1
        if len(self.examples) < 50:
            self.examples.append({"issue": kind, "source": source, "record": record})

    def as_dict(self):
        return {"rows": dict(self.rows), "issues": dict(self.issues), "issue_examples": self.examples,
                "missing_company_fields": dict(self.missing_fields)}


def build_database(companies, database, links=None, payments=None, revenue_unit="unknown"):
    """Atomically replace database only after a successful load and index build.

    Bad payment records are skipped and audited. Repeated directed payment rows
    are additive because no unique transaction identifier is provided.
    Duplicate company IDs retain all variants; conflicting fields become unknown.
    """
    if revenue_unit not in REVENUE_MULTIPLIERS:
        raise ValueError("revenue_unit must be unknown, rub or thousand_rub")
    destination = Path(database).resolve()
    inputs = {"companies": companies, "links": links, "payments": payments}
    if any(path and Path(path).resolve() == destination for path in inputs.values()):
        raise ValueError("Database must not overwrite a source CSV")
    sources = {key: source_info(path) for key, path in inputs.items() if path}
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix="context-", suffix=".sqlite", dir=destination.parent)
    os.close(handle)
    conn = None
    audit = Audit()
    try:
        conn = sqlite3.connect(temporary)
        conn.executescript("""
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE companies (
                id TEXT PRIMARY KEY, group_id TEXT, division TEXT,
                revenue TEXT, source_record INTEGER NOT NULL, data TEXT NOT NULL
            );
            CREATE TABLE company_variants (company TEXT NOT NULL, source_record INTEGER PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE links (person TEXT NOT NULL, company TEXT NOT NULL,
                source_record INTEGER NOT NULL, PRIMARY KEY (person, company));
            CREATE TABLE payments (payer TEXT NOT NULL, beneficiary TEXT NOT NULL,
                amount TEXT NOT NULL, count INTEGER NOT NULL, source_record INTEGER NOT NULL);
        """)
        with conn:
            for record, row in csv_rows(companies, ["SYNTHETIC_U"]):
                audit.rows["companies_read"] += 1
                audit.missing_fields.update(key for key, value in row.items() if value is None)
                uid = row["SYNTHETIC_U"]
                if not uid:
                    audit.issue("missing_company_id", "companies", record)
                    continue
                revenue = number(row.get("REVENUE_COMPANY"))
                if row.get("REVENUE_COMPANY") and revenue is None:
                    audit.issue("invalid_revenue", "companies", record)
                for column in [*PRODUCTS.values(), "FTS_FLAG", "NEGATIVEMARK"]:
                    if row.get(column) is not None and flag(row[column]) is None:
                        audit.issue("invalid_boolean:" + column, "companies", record)
                if row.get("MAINOKVED_CODE") and division(row["MAINOKVED_CODE"]) is None:
                    audit.issue("invalid_okved", "companies", record)
                try:
                    conn.execute("INSERT INTO companies VALUES (?, ?, ?, ?, ?, ?)",
                                 (uid, row.get("GROUP_ID"), division(row.get("MAINOKVED_CODE")),
                                  str(revenue) if revenue is not None else None, record,
                                  json.dumps(row, ensure_ascii=False)))
                except sqlite3.IntegrityError:
                    existing = conn.execute("SELECT source_record, data FROM companies WHERE id=?", (uid,)).fetchone()
                    old = json.loads(existing[1])
                    conn.execute("INSERT OR IGNORE INTO company_variants VALUES (?, ?, ?)", (uid, existing[0], existing[1]))
                    conn.execute("INSERT INTO company_variants VALUES (?, ?, ?)", (uid, record, json.dumps(row, ensure_ascii=False)))
                    agreed = {key: old.get(key) if old.get(key) == row.get(key) else None for key in old.keys() | row.keys()}
                    agreed_revenue = number(agreed.get("REVENUE_COMPANY"))
                    conn.execute("UPDATE companies SET group_id=?, division=?, revenue=?, data=? WHERE id=?",
                                 (agreed.get("GROUP_ID"), division(agreed.get("MAINOKVED_CODE")),
                                  str(agreed_revenue) if agreed_revenue is not None else None,
                                  json.dumps(agreed, ensure_ascii=False), uid))
                    audit.issue("duplicate_company_id", "companies", record)
                else:
                    audit.rows["companies_loaded"] += 1
            if links:
                for record, row in csv_rows(links, ["SYNTHETIC_F", "SYNTHETIC_U"]):
                    audit.rows["links_read"] += 1
                    if not row["SYNTHETIC_F"] or not row["SYNTHETIC_U"]:
                        audit.issue("missing_relationship_id", "links", record)
                        continue
                    result = conn.execute("INSERT OR IGNORE INTO links VALUES (?, ?, ?)",
                                          (row["SYNTHETIC_F"], row["SYNTHETIC_U"], record))
                    if not result.rowcount:
                        audit.issue("duplicate_person_company_link", "links", record)
                    else:
                        audit.rows["links_loaded"] += 1
            if payments:
                batch = []
                for record, row in csv_rows(payments, ["PAYER", "BENEFICIARY", "PAY_AMT", "PAY_CNT"]):
                    audit.rows["payments_read"] += 1
                    amount, count = number(row["PAY_AMT"]), number(row["PAY_CNT"])
                    if (not row["PAYER"] or not row["BENEFICIARY"] or amount is None
                            or count is None or count != count.to_integral() or count > 2**63 - 1):
                        audit.issue("invalid_payment", "payments", record)
                        continue
                    if row["PAYER"] == row["BENEFICIARY"]:
                        audit.issue("self_payment_excluded", "payments", record)
                        continue
                    batch.append((row["PAYER"], row["BENEFICIARY"], str(amount), int(count), record))
                    audit.rows["payments_loaded"] += 1
                    if len(batch) >= 10000:
                        conn.executemany("INSERT INTO payments VALUES (?, ?, ?, ?, ?)", batch)
                        batch.clear()
                conn.executemany("INSERT INTO payments VALUES (?, ?, ?, ?, ?)", batch)
            conn.executescript("""
                CREATE INDEX company_variants_id ON company_variants(company);
                CREATE INDEX company_group ON companies(group_id);
                CREATE INDEX company_division ON companies(division);
                CREATE INDEX links_company ON links(company);
                CREATE INDEX payments_payer ON payments(payer);
                CREATE INDEX payments_beneficiary ON payments(beneficiary);
            """)
            audit.rows["payment_participants_without_company"] = conn.execute("""
                SELECT COUNT(*) FROM (
                    SELECT payer AS id FROM payments UNION SELECT beneficiary AS id FROM payments
                ) p LEFT JOIN companies c ON c.id=p.id WHERE c.id IS NULL
            """).fetchone()[0]
            audit.rows["linked_companies_without_card"] = conn.execute("""
                SELECT COUNT(DISTINCT l.company) FROM links l
                LEFT JOIN companies c ON c.id=l.company WHERE c.id IS NULL
            """).fetchone()[0]
            audit.rows["companies_with_multiple_records"] = conn.execute("SELECT COUNT(DISTINCT company) FROM company_variants").fetchone()[0]
            metadata = {"schema_version": SCHEMA_VERSION, "sources": sources,
                        "revenue_unit": revenue_unit, "audit": audit.as_dict(),
                        "built_at": datetime.now(timezone.utc).isoformat()}
            conn.executemany("INSERT INTO metadata VALUES (?, ?)",
                             [(key, json.dumps(value, ensure_ascii=False)) for key, value in metadata.items()])
        conn.close()
        conn = None
        os.replace(temporary, destination)
        return metadata
    finally:
        if conn is not None:
            conn.close()
        if os.path.exists(temporary):
            os.unlink(temporary)
