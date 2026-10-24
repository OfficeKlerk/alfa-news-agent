import { importReviewedNews } from "./reviewed-news.js";
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import { parse } from 'csv-parse';
import type { Settings } from './config.js';
import { AppError, type Company, type Json, type News } from './types.js';

export const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const PRODUCTS: Record<string, string> = { CL_PRODUCT_LOA_MARK: 'Кредиты', CL_PRODUCT_LEA_MARK: 'Лизинг', CL_PRODUCT_GAR_MARK: 'Гарантии', CL_PRODUCT_DEP_MARK: 'Депозиты', CL_PRODUCT_RKO_MARK: 'РКО', CL_PRODUCT_ZPP_MARK: 'Зарплатный проект', FACTORING_MARK: 'Факторинг' };

export class Store {
  readonly connection: DatabaseSync;
  constructor(public settings: Settings) {
    mkdirSync(dirname(settings.dbPath), { recursive: true });
    this.connection = new DatabaseSync(settings.dbPath);
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=45000');
  }
  all(sql: string, ...args: SQLInputValue[]): Json[] { return this.connection.prepare(sql).all(...args); }
  get(sql: string, ...args: SQLInputValue[]): Json | undefined { return this.connection.prepare(sql).get(...args); }
  run(sql: string, ...args: SQLInputValue[]) { return this.connection.prepare(sql).run(...args); }
  close() { this.connection.close(); }
  async initialize() {
    this.connection.exec(
      'CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,industry TEXT,region TEXT,revenue REAL,payload TEXT);' +
      'CREATE TABLE IF NOT EXISTS payments(payer TEXT,beneficiary TEXT,amount REAL,count INTEGER);' +
      'CREATE TABLE IF NOT EXISTS links(person TEXT,company TEXT);' +
      'CREATE TABLE IF NOT EXISTS news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER);' +
      'CREATE TABLE IF NOT EXISTS news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT);' +
      'CREATE TABLE IF NOT EXISTS news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));' +
      'CREATE INDEX IF NOT EXISTS news_version_available ON news_versions(available_at);' +
      'CREATE TABLE IF NOT EXISTS research(id TEXT PRIMARY KEY,payload TEXT);' +
      'CREATE TABLE IF NOT EXISTS analyses(cache_key TEXT PRIMARY KEY,company_id TEXT,news_id TEXT,payload TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);' +
      'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,company_id TEXT,status TEXT,payload TEXT,error TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);' +
      'CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY,company_id TEXT,analysis_id TEXT,question TEXT,answer TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);' +
      'CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0);' +
      'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);');
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      if (!this.get("SELECT 1 FROM metadata WHERE key='import_complete'")) {
        this.connection.exec('DELETE FROM companies; DELETE FROM payments; DELETE FROM links');
        await this.importCsv('df_Uid_data_hack.csv', 'INSERT OR REPLACE INTO companies VALUES(?,?,?,?,?)', r => [r.SYNTHETIC_U, r.MAINOKVED_NAME ?? '', r.REGION ?? '', number(r.REVENUE_COMPANY), JSON.stringify(r)]);
        await this.importCsv('df_Uid_payment_hack.csv', 'INSERT INTO payments VALUES(?,?,?,?)', r => [r.PAYER, r.BENEFICIARY, number(r.PAY_AMT), Math.trunc(number(r.PAY_CNT))]);
        await this.importCsv('df_Fid_Uid_link_hack.csv', 'INSERT INTO links VALUES(?,?)', r => [r.SYNTHETIC_F, r.SYNTHETIC_U]);
        this.run("INSERT INTO metadata VALUES('import_complete','1')");
      }
      this.connection.exec('CREATE INDEX IF NOT EXISTS payment_payer ON payments(payer); CREATE INDEX IF NOT EXISTS payment_beneficiary ON payments(beneficiary); CREATE INDEX IF NOT EXISTS link_company ON links(company); CREATE INDEX IF NOT EXISTS link_person ON links(person); CREATE INDEX IF NOT EXISTS company_revenue ON companies(revenue DESC);');
      const documents: Json[] = JSON.parse(readFileSync(join(this.settings.data, 'research.json'), 'utf8'));
      const putDocument = this.connection.prepare('INSERT OR REPLACE INTO research VALUES(?,?)');
      for (const doc of documents) putDocument.run(doc.id, JSON.stringify(doc));
      if (!this.get('SELECT 1 FROM news LIMIT 1')) {
        const items: Json[] = JSON.parse(readFileSync(join(this.settings.data, 'demo_news.json'), 'utf8'));
        const insert = this.connection.prepare('INSERT INTO news VALUES(?,?,?,?,?,?,?)');
        for (const n of items) insert.run(n.id, n.title, n.text, n.url ?? '', n.published, JSON.stringify(n.tags), 1);
      }
      this.connection.exec('COMMIT');
    } catch (error) { this.connection.exec('ROLLBACK'); throw error; }
    importReviewedNews(this, join(this.settings.data, 'reviewed_news.json'));
  }
  private async importCsv(filename: string, sql: string, convert: (row: Json) => SQLInputValue[]) {
    const input = createReadStream(join(this.settings.data, filename + '.gz'));
    const gzip = createGunzip();
    const parser = parse({ delimiter: ';', columns: true, bom: true });
    // Forward upstream errors to the iterator so failed imports roll back cleanly.
    input.on('error', error => parser.destroy(error));
    gzip.on('error', error => parser.destroy(error));
    input.pipe(gzip).pipe(parser);
    const insert = this.connection.prepare(sql);
    try { for await (const row of parser) insert.run(...convert(row)); }
    finally { input.destroy(); gzip.destroy(); parser.destroy(); }
  }
  company(id: string): Company {
    const row = this.get('SELECT * FROM companies WHERE id=?', id);
    if (!row) throw new AppError('Компания не найдена', 404);
    const raw = JSON.parse(row.payload);
    return { id, name: 'Компания ' + id, industry: row.industry, region: row.region, revenue: row.revenue,
      products: Object.entries(PRODUCTS).filter(([key]) => number(raw[key]) === 1).map(([, label]) => label),
      foreign_trade: number(raw.FTS_FLAG) === 1, trade_country: raw.FTS_COUNTRY_NAME ?? '',
      workers: raw.AMOUNT_WORKERS_FNS_GRADATION ?? '', group_id: raw.GROUP_ID ?? '',
      outgoing: this.get('SELECT count(*) n,coalesce(sum(amount),0) total FROM payments WHERE payer=?', id)!,
      incoming: this.get('SELECT count(*) n,coalesce(sum(amount),0) total FROM payments WHERE beneficiary=?', id)!,
      top_partners: this.all("SELECT p.beneficiary id,coalesce(x.industry,'Неизвестна') industry,sum(p.amount) amount FROM payments p LEFT JOIN companies x ON p.beneficiary=x.id WHERE p.payer=? GROUP BY p.beneficiary ORDER BY amount DESC LIMIT 5", id),
      related_company_ids: this.all('SELECT DISTINCT b.company FROM links a JOIN links b ON a.person=b.person WHERE a.company=? AND b.company<>? LIMIT 20', id, id).map(r => r.company), raw,
      data_notes: ['Единицы REVENUE_COMPANY и период платежей не подтверждены: суммы показаны как в исходном файле.', 'Наличие продукта не раскрывает сумму, ставку или условия договора.', 'Идентификаторы обезличены. Связь через физлицо не доказывает владение.'] };
  }
  news(id: string): News {
    const row = this.get('SELECT * FROM news WHERE id=?', id);
    if (!row) throw new AppError('Новость не найдена', 404);
    const metadata = this.get('SELECT payload FROM news_metadata WHERE news_id=?', id);
    return { ...row, ...(metadata ? JSON.parse(metadata.payload) : {}), tags: JSON.parse(row.tags), is_demo: Boolean(row.is_demo) } as News;
  }
}
