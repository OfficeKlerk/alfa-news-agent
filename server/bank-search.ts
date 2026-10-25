import type { Store } from "./db.js";
import type { Json } from "./types.js";
import { normalizePublicationDate } from "./news-events.js";
const STOP = new Set('как что для это при или был была были будет если есть все его она они еще уже так где который которые также после перед между через около более менее года год данные компании'.split(' '));
export function searchTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().replaceAll('ё', 'е').match(/[а-яa-z0-9]{2,}/g) ?? []).filter(t => !STOP.has(t)))];
}
/** Persistent FTS5/BM25 index. A transactional revision avoids stale indexes after inserts, edits and deletes. */
export class BankSearch {
  constructor(private db: Store) {
    db.connection.exec("BEGIN IMMEDIATE");
    try {
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS bank_index_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, indexed_revision INTEGER NOT NULL, version INTEGER NOT NULL);
      INSERT OR IGNORE INTO bank_index_state VALUES(1,1,0,0);
      CREATE TRIGGER IF NOT EXISTS bank_research_insert AFTER INSERT ON research BEGIN UPDATE bank_index_state SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS bank_research_update AFTER UPDATE ON research BEGIN UPDATE bank_index_state SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS bank_research_delete AFTER DELETE ON research BEGIN UPDATE bank_index_state SET revision=revision+1 WHERE id=1; END;
      CREATE TABLE IF NOT EXISTS bank_chunks(id TEXT UNIQUE NOT NULL, document_id TEXT NOT NULL, page_key TEXT NOT NULL, published_at TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bank_index_pending(source_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS bank_research_insert_v2 AFTER INSERT ON research BEGIN INSERT OR IGNORE INTO bank_index_pending VALUES(NEW.id); END;
      CREATE TRIGGER IF NOT EXISTS bank_research_update_v2 AFTER UPDATE ON research BEGIN INSERT OR IGNORE INTO bank_index_pending VALUES(OLD.id); INSERT OR IGNORE INTO bank_index_pending VALUES(NEW.id); END;
      CREATE TRIGGER IF NOT EXISTS bank_research_delete_v2 AFTER DELETE ON research BEGIN INSERT OR IGNORE INTO bank_index_pending VALUES(OLD.id); END;
      CREATE VIRTUAL TABLE IF NOT EXISTS bank_fts USING fts5(body, title, tokenize='unicode61');
    `);
    if (!db.all('PRAGMA table_info(bank_chunks)').some(column => column.name === 'source_id'))
      db.connection.exec("ALTER TABLE bank_chunks ADD COLUMN source_id TEXT NOT NULL DEFAULT ''");
    db.connection.exec('CREATE INDEX IF NOT EXISTS bank_chunks_source ON bank_chunks(source_id)');
    db.connection.exec('COMMIT');
    } catch (error) { db.connection.exec('ROLLBACK'); throw error; }
  }
  private ensure() {
    const current = this.db.get('SELECT * FROM bank_index_state WHERE id=1')!;
    if (current.revision === current.indexed_revision && current.version === 2) return;
    this.db.connection.exec('BEGIN IMMEDIATE');
    try {
      const state = this.db.get('SELECT * FROM bank_index_state WHERE id=1')!;
      if (state.revision !== state.indexed_revision || state.version !== 2) {
        const rebuild = state.version !== 2;
        const changed = rebuild ? this.db.all('SELECT id AS source_id FROM research ORDER BY id')
          : this.db.all('SELECT source_id FROM bank_index_pending ORDER BY source_id');
        if (rebuild) this.db.connection.exec('DELETE FROM bank_fts; DELETE FROM bank_chunks;');
        const put = this.db.connection.prepare('INSERT INTO bank_chunks(id,document_id,page_key,published_at,payload,source_id) VALUES(?,?,?,?,?,?)');
        const index = this.db.connection.prepare('INSERT INTO bank_fts(rowid,body,title) VALUES(?,?,?)');
        for (const { source_id } of changed) {
          if (!rebuild) {
            this.db.run('DELETE FROM bank_fts WHERE rowid IN (SELECT rowid FROM bank_chunks WHERE source_id=?)', source_id);
            this.db.run('DELETE FROM bank_chunks WHERE source_id=?', source_id);
          }
          const row = this.db.get('SELECT payload FROM research WHERE id=?', source_id);
          if (!row) continue; // A deletion is part of the same atomic index update.
          const doc = JSON.parse(row.payload);
          if (typeof doc.id !== 'string' || typeof doc.text !== 'string') throw new Error('Invalid research document');
          const date = normalizePublicationDate(doc.published_at ?? doc.published ?? doc.date).value;
          for (let start = 0; start < doc.text.length; start += 1400) {
            const text = doc.text.slice(Math.max(0, start - 150), start + 1600);
            const item = { ...doc, id: doc.id + ':c' + start, text };
            const document = String(doc.document_id ?? doc.filename ?? doc.id);
            const result = put.run(item.id, document, JSON.stringify([document, doc.page]), date, JSON.stringify(item), source_id);
            index.run(result.lastInsertRowid, searchTerms(text).join(' '), searchTerms(String(doc.title ?? '')).join(' '));
          }
        }
        this.db.run('DELETE FROM bank_index_pending');
        this.db.run('UPDATE bank_index_state SET indexed_revision=revision,version=2 WHERE id=1');
      }
      this.db.connection.exec('COMMIT');
    } catch (error) { this.db.connection.exec('ROLLBACK'); throw error; }
  }
  search(query: string, limit: number, asOf?: string): Json[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new Error('Invalid research limit');
    if (!limit) return [];
    const terms = searchTerms(query).slice(0, 64);
    if (!terms.length) return [];
    this.ensure();
    // Prefixes match inflection without interpolating user operators into MATCH.
    const match = terms.map(term => '"' + term.slice(0, term.length > 5 ? 5 : term.length) + '"*').join(' OR ');
    const cutoff = asOf ? normalizePublicationDate(asOf.replace(/(\.\d{3})\d+(?=Z|[+-])/i, "$1")).value : null;
    if (asOf && !cutoff) throw new Error('Invalid research as_of');
    const rows = this.db.all(`WITH matched AS MATERIALIZED (
      SELECT c.id,c.document_id,c.page_key,c.published_at,c.payload,bm25(bank_fts,1.0,3.0) AS rank
      FROM bank_fts JOIN bank_chunks c ON c.rowid=bank_fts.rowid
      WHERE bank_fts MATCH ? AND (? IS NULL OR c.published_at IS NOT NULL AND c.published_at<=?)
    ), pages AS (
      SELECT *,row_number() OVER(PARTITION BY page_key ORDER BY rank,id) AS page_row FROM matched
    ), documents AS (
      SELECT *,row_number() OVER(PARTITION BY document_id ORDER BY rank,id) AS document_row FROM pages WHERE page_row<=2
    ) SELECT payload,rank FROM documents ORDER BY (document_row=1) DESC,rank,id LIMIT ?`, match, cutoff, cutoff, limit);
    return rows.map(row => ({ ...JSON.parse(row.payload), score: -Number(row.rank) }));
  }
}
