import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "../db.js";
import type { Json } from "../types.js";
import { validate, validateAnalysis, type Envelope } from "./contracts.js";

export class PublicationError extends Error {}

export type LiveJobStatus = "queued" | "running" | "deferred" | "succeeded" | "failed" | "superseded" | "unknown";
export type LiveJob = {
  id: string; kind: "analysis" | "question"; company_id: string; news_id: string; revision: string;
  audience_role: string; analysis_id: string | null; payload: Json; status: LiveJobStatus;
  owner?: string | null; attempts: number; max_attempts: number; priority: number; next_attempt: number;
  lease_owner: string | null; lease_token: string | null; lease_until: number | null;
  result: Envelope | null; error: string | null; created_at: number; updated_at: number;
};
export type Subscription = { company_id: string; audience_role: string; limit: number; min_score: number; enabled: boolean; next_scan: number; last_scan: number | null; error: string | null };
export type SavedAnalysis = { seq: number; id: string; company_id: string; news_id: string; revision: string; audience_role: string; response: Envelope; context: Json | null; sources: Json[]; created_at: number; stale: boolean; favorite: boolean; history: Json[] };
export type AnalysisJobInput = { company_id: string; news_id: string; revision: string; audience_role: string; payload: Json; priority?: number; max_attempts?: number };
export type JobResult = { response: Envelope; context?: Json };
const json = (value: unknown): string => JSON.stringify(value);
const key = (...parts: unknown[]): string => createHash("sha256").update(json(parts)).digest("hex");
const bounded = (n: number, min: number, max: number, label: string): number => {
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
};
const required = (value: string, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`Invalid ${label}`);
  return value;
};

/** Owns only live_* tables. All publication and lease transitions are short SQLite transactions. */
export class LiveStore {
  readonly db: DatabaseSync;
  readonly now: () => number;
  constructor(store: Store | DatabaseSync, options: { now?: () => number } = {}) {
    this.db = store instanceof DatabaseSync ? store : store.connection;
    this.now = options.now ?? Date.now;
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS live_subscriptions(company_id TEXT NOT NULL,audience_role TEXT NOT NULL,item_limit INTEGER NOT NULL,min_score REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,next_scan INTEGER NOT NULL,last_scan INTEGER,error TEXT,PRIMARY KEY(company_id,audience_role));
      CREATE TABLE IF NOT EXISTS live_heads(company_id TEXT NOT NULL,news_id TEXT NOT NULL,audience_role TEXT NOT NULL,revision TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(company_id,news_id,audience_role));
      CREATE TABLE IF NOT EXISTS live_head_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT NOT NULL,news_id TEXT NOT NULL,audience_role TEXT NOT NULL,revision TEXT NOT NULL,changed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS live_head_versions_scope ON live_head_versions(company_id,news_id,audience_role,seq DESC);
      INSERT INTO live_head_versions(company_id,news_id,audience_role,revision,changed_at) SELECT h.company_id,h.news_id,h.audience_role,h.revision,h.updated_at FROM live_heads h WHERE NOT EXISTS(SELECT 1 FROM live_head_versions v WHERE v.company_id=h.company_id AND v.news_id=h.news_id AND v.audience_role=h.audience_role);
      CREATE TABLE IF NOT EXISTS live_jobs(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,company_id TEXT NOT NULL,news_id TEXT NOT NULL,revision TEXT NOT NULL,audience_role TEXT NOT NULL,analysis_id TEXT,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,priority REAL NOT NULL,next_attempt INTEGER NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until INTEGER,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS live_jobs_ready ON live_jobs(status,next_attempt,priority DESC,created_at);
      CREATE INDEX IF NOT EXISTS live_jobs_company ON live_jobs(company_id,news_id,audience_role);
      CREATE TABLE IF NOT EXISTS live_analyses(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,job_id TEXT NOT NULL UNIQUE,company_id TEXT NOT NULL,news_id TEXT NOT NULL,revision TEXT NOT NULL,audience_role TEXT NOT NULL,response TEXT NOT NULL,context TEXT,sources TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(company_id,news_id,revision,audience_role));
      CREATE INDEX IF NOT EXISTS live_analyses_feed ON live_analyses(company_id,audience_role,seq DESC);
      CREATE TABLE IF NOT EXISTS live_questions(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL UNIQUE,analysis_id TEXT NOT NULL,company_id TEXT NOT NULL,question TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS live_questions_history ON live_questions(company_id,analysis_id,seq);
      CREATE TABLE IF NOT EXISTS live_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),held INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS live_maintenance_audit(seq INTEGER PRIMARY KEY,actor TEXT NOT NULL,evidence TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS live_schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS live_user_favorites(company_id TEXT NOT NULL,owner TEXT NOT NULL,news_id TEXT NOT NULL,audience_role TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(company_id,owner,news_id,audience_role));
      CREATE TABLE IF NOT EXISTS live_favorites(company_id TEXT NOT NULL,news_id TEXT NOT NULL,audience_role TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(company_id,news_id,audience_role));`);
    this.migratePersonal();
  }
  private migratePersonal(): void {
    this.tx(()=>{
      for(const table of ["live_jobs","live_questions"]) {
        const columns=this.db.prepare("PRAGMA table_info("+table+")").all();
        if(!columns.some(c=>c.name==="owner"))this.db.exec("ALTER TABLE "+table+" ADD COLUMN owner TEXT");
      }
      if(!this.db.prepare('PRAGMA table_info(live_jobs)').all().some(c=>c.name==='last_recovery_check'))this.db.exec('ALTER TABLE live_jobs ADD COLUMN last_recovery_check INTEGER NOT NULL DEFAULT 0');
      this.db.exec("CREATE INDEX IF NOT EXISTS live_job_recovery ON live_jobs(status,last_recovery_check,updated_at);");
      this.db.exec("CREATE INDEX IF NOT EXISTS live_question_owner ON live_questions(company_id,owner,analysis_id,seq); CREATE INDEX IF NOT EXISTS live_job_owner ON live_jobs(company_id,owner,updated_at);");
      if(!this.db.prepare("SELECT 1 FROM live_schema_migrations WHERE version=2").get()) {
        // An older process may have paid before crashing. Never infer 'not sent' from a missing new journal.
        this.db.prepare("UPDATE live_jobs SET status='unknown',error='legacy_send_requires_review',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE status IN ('running','queued','deferred') AND attempts>0").run();
        this.db.prepare("INSERT INTO live_schema_migrations VALUES(2,?)").run(this.now());
      }
    });
  }
  private tx<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private job(row: any): LiveJob {
    let result=null,invalid=false;
    if(row.result)try {result=JSON.parse(row.result);validate(row.kind==="analysis"?"AnalysisResponse":"AnswerResponse",result,true);}catch {result=null;invalid=true;}
    return {...row,payload:JSON.parse(row.payload),result,error:row.error??(invalid?"stored_result_invalid":null)} as LiveJob;
  }
  subscribe(input: { company_id: string; audience_role: string; limit?: number; min_score?: number; enabled?: boolean }): Subscription {
    const cid = required(input.company_id, "company_id"), role = required(input.audience_role, "audience_role");
    const limit = bounded(input.limit ?? 10, 1, 100, "limit"), minScore = bounded(input.min_score ?? 0.35, 0, 1, "min_score");
    if (!Number.isInteger(limit)) throw new Error("Invalid limit");
    this.db.prepare(`INSERT INTO live_subscriptions(company_id,audience_role,item_limit,min_score,enabled,next_scan) VALUES(?,?,?,?,?,?)
      ON CONFLICT(company_id,audience_role) DO UPDATE SET item_limit=excluded.item_limit,min_score=excluded.min_score,enabled=excluded.enabled,next_scan=MIN(live_subscriptions.next_scan,excluded.next_scan)`)
      .run(cid, role, limit, minScore, input.enabled === false ? 0 : 1, this.now());
    return this.subscriptions().find(s => s.company_id === cid && s.audience_role === role)!;
  }
  subscriptions(): Subscription[] {
    return (this.db.prepare("SELECT company_id,audience_role,item_limit AS 'limit',min_score,enabled,next_scan,last_scan,error FROM live_subscriptions ORDER BY company_id,audience_role").all() as any[]).map(s => ({ ...s, enabled: Boolean(s.enabled) }));
  }
  dueSubscriptions(): Subscription[] { return this.subscriptions().filter(s => s.enabled && s.next_scan <= this.now()); }
  touchSubscription(companyId: string, role: string, nextScan: number, error: string | null = null): void {
    this.db.prepare("UPDATE live_subscriptions SET next_scan=?,last_scan=?,error=? WHERE company_id=? AND audience_role=?").run(nextScan, this.now(), error?.slice(0, 1000) ?? null, companyId, role);
  }
  enqueueAnalysis(input: AnalysisJobInput): LiveJob {
    const cid = required(input.company_id, "company_id"), nid = required(input.news_id, "news_id"), revision = required(input.revision, "revision"), role = required(input.audience_role, "audience_role");
    const priority = bounded(input.priority ?? 0, -10000, 10000, "priority");
    const identity = key("analysis", cid, nid, revision, role);
    return this.tx(() => {
      const previous = this.db.prepare("SELECT * FROM live_jobs WHERE idempotency_key=?").get(identity);
      // A repeated old revision must never move the current head backwards.
      if (previous) {
        const old = this.job(previous);
        const head = this.db.prepare("SELECT revision FROM live_heads WHERE company_id=? AND news_id=? AND audience_role=?").get(cid, nid, role);
        // Explicit invalidation establishes a return to a previously seen revision.
        // Reuse its published card, or revive work canceled solely by supersession.
        if (old.status === "superseded" && head?.revision === revision) {
          this.db.prepare("UPDATE live_jobs SET status='queued',payload=?,priority=?,attempts=0,next_attempt=?,error=NULL,updated_at=? WHERE id=?").run(json(input.payload), priority, this.now(), this.now(), old.id);
          return this.getJob(old.id)!;
        }
        return old;
      }
      this.invalidateRows(cid, nid, role, revision, "news_revision_superseded");
      return this.insert(identity, { ...input, kind: "analysis", analysis_id: null });
    });
  }
  /** Release one unused reservation for a more important event, preserving every source head and card. */
  supersedeLowerPriorityPending(companyId: string, incomingPriority: number): LiveJob | null {
    required(companyId, "company_id"); bounded(incomingPriority, -10000, 10000, "priority");
    return this.tx(() => {
      const row = this.db.prepare(`SELECT * FROM live_jobs WHERE company_id=? AND kind='analysis'
        AND status IN ('queued','deferred') AND attempts=0 AND priority<? AND priority<10
        AND json_type(payload,'$.reanalysis') IS NOT 'true'
        ORDER BY priority ASC,created_at DESC,rowid DESC LIMIT 1`).get(companyId, incomingPriority);
      if (!row) return null;
      this.db.prepare("UPDATE live_jobs SET status='superseded',error='selection_priority_replaced',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(this.now(), row.id);
      return this.getJob(String(row.id));
    });
  }
  /** Mark an old card stale even when the new revision no longer passes relevance filtering. */
  invalidate(companyId: string, newsId: string, role: string, revision: string, reason = "news_revision_superseded"): void {
    for (const value of [companyId, newsId, role, revision]) required(value, "revision scope");
    this.tx(() => this.invalidateRows(companyId, newsId, role, revision, reason));
  }
  private invalidateRows(companyId: string, newsId: string, role: string, revision: string, reason: string): void {
    const now = this.now();
    const old = this.db.prepare("SELECT revision FROM live_heads WHERE company_id=? AND news_id=? AND audience_role=?").get(companyId, newsId, role);
    if (old?.revision !== revision) this.db.prepare("INSERT INTO live_head_versions(company_id,news_id,audience_role,revision,changed_at) VALUES(?,?,?,?,?)").run(companyId, newsId, role, revision, now);
    this.db.prepare(`INSERT INTO live_heads VALUES(?,?,?,?,?) ON CONFLICT(company_id,news_id,audience_role) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`).run(companyId, newsId, role, revision, now);
    this.db.prepare("UPDATE live_jobs SET status='superseded',error=?,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE company_id=? AND news_id=? AND audience_role=? AND revision<>? AND status IN ('queued','running','deferred')").run(reason.slice(0, 1000), now, companyId, newsId, role, revision);
  }
  /** Counts published analyses and outstanding reservations created since a UTC day boundary. */
  analysisCounts(companyId: string, since = 0): { published: number; pending: number; reserved: number } {
    const published = Number(this.db.prepare("SELECT COUNT(*) n FROM live_analyses WHERE company_id=? AND created_at>=?").get(companyId, since)!.n);
    const pending = Number(this.db.prepare("SELECT COUNT(*) n FROM live_jobs WHERE company_id=? AND kind='analysis' AND status IN ('queued','running','deferred','unknown')").get(companyId)!.n);
    return { published, pending, reserved: published + pending };
  }
  enqueueQuestion(input: { company_id: string; analysis_id: string; question: string; idempotency_key: string; owner?: string; payload?: Json; max_attempts?: number }): LiveJob {
    required(input.idempotency_key, "idempotency_key");
    if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 10000) throw new Error("Invalid question");
    return this.tx(() => {
      if(this.recoveryHeld())throw new Error("Recovery review required");
      const analysis = this.getAnalysis(input.analysis_id, input.company_id, input.owner);
      if (!analysis) throw new Error("Analysis not found");
      if (analysis.stale || !this.available(input.company_id,analysis.audience_role,input.owner).some(row=>row.id===input.analysis_id)) throw new Error("Analysis superseded");
      const unknown=this.db.prepare("SELECT * FROM live_jobs WHERE company_id=? AND analysis_id=? AND owner IS ? AND kind='question' AND status='unknown'").get(input.company_id,input.analysis_id,input.owner??null);
      if(unknown){const old=this.job(unknown);if(old.payload.question===input.question)return old;throw new Error("Previous question unresolved");}
      const identity = key("question", input.company_id, input.owner ?? null, input.analysis_id, input.idempotency_key);
      const existing = this.db.prepare("SELECT * FROM live_jobs WHERE idempotency_key=?").get(identity);
      if (existing) {
        const job = this.job(existing);
        if (job.payload.question !== input.question) throw new Error("Idempotency key reused with different question");
        return job;
      }
      return this.insert(identity, { kind: "question", company_id: input.company_id, analysis_id: input.analysis_id, news_id: analysis.news_id, revision: analysis.revision, audience_role: analysis.audience_role,
        payload: { ...input.payload, question: input.question }, owner: input.owner, max_attempts: input.max_attempts, priority: 1000 });
    });
  }
  private insert(identity: string, input: AnalysisJobInput & { kind: "analysis" | "question"; analysis_id: string | null; owner?: string }): LiveJob {
    const id = randomUUID(), now = this.now();
    const attempts = bounded(input.max_attempts ?? 5, 1, 20, "max_attempts");
    if (!Number.isInteger(attempts)) throw new Error("Invalid max_attempts");
    const priority = bounded(input.priority ?? 0, -10000, 10000, "priority");
    this.db.prepare("INSERT INTO live_jobs(id,idempotency_key,kind,company_id,news_id,revision,audience_role,analysis_id,payload,status,max_attempts,priority,next_attempt,created_at,updated_at,owner) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)")
      .run(id, identity, input.kind, input.company_id, input.news_id, input.revision, input.audience_role, input.analysis_id, json(input.payload), attempts, priority, now, now, now, input.owner ?? null);
    return this.getJob(id)!;
  }
  getJob(id: string, companyId?: string, owner?: string): LiveJob | null {
    const row = companyId === undefined ? this.db.prepare("SELECT * FROM live_jobs WHERE id=?").get(id) : this.db.prepare("SELECT * FROM live_jobs WHERE id=? AND company_id=?"+(owner===undefined?"":" AND (kind='analysis' OR owner=?)")).get(id, companyId,...(owner===undefined?[]:[owner]));
    return row ? this.job(row) : null;
  }
  claim(owner: string, leaseMs = 60_000): LiveJob | null {
    required(owner, "owner"); bounded(leaseMs, 50, 3_600_000, "leaseMs");
    return this.tx(() => {
      if(this.recoveryHeld())return null;
      const now = this.now();
      this.db.prepare("UPDATE live_jobs SET status=CASE WHEN json_type(payload,'$.execution') IS NOT NULL THEN 'unknown' WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,error='worker_lease_expired',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<=?").run(now, now);
      const row = this.db.prepare(`SELECT * FROM live_jobs j WHERE status IN ('queued','deferred') AND next_attempt<=? AND attempts<max_attempts
        AND NOT (kind='question' AND EXISTS(SELECT 1 FROM live_jobs other WHERE other.kind='question' AND other.analysis_id=j.analysis_id AND other.company_id=j.company_id AND other.owner IS j.owner AND other.id<>j.id AND (other.status IN ('running','unknown') OR (other.status IN ('queued','deferred') AND other.rowid<j.rowid))))
        ORDER BY priority DESC,created_at,j.rowid LIMIT 1`).get(now);
      if (!row) return null;
      this.db.prepare("UPDATE live_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_token=?,lease_until=?,updated_at=? WHERE id=?").run(owner, randomUUID(), now + leaseMs, now, row.id);
      return this.getJob(String(row.id));
    });
  }
  private held(job: LiveJob): boolean {
    return Boolean(job.lease_token && this.db.prepare("SELECT 1 FROM live_jobs WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND lease_until>?").get(job.id, job.lease_owner, job.lease_token, this.now()));
  }
  heartbeat(job: LiveJob, leaseMs = 60_000): boolean {
    bounded(leaseMs, 50, 3_600_000, "leaseMs");
    return Number(this.db.prepare("UPDATE live_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND lease_until>?").run(this.now() + leaseMs, this.now(), job.id, job.lease_owner, job.lease_token, this.now()).changes) === 1;
  }
  complete(job: LiveJob, result: JobResult): boolean {
    return this.tx(() => {
      if (!this.held(job)) return false;
      const head = this.db.prepare("SELECT revision FROM live_heads WHERE company_id=? AND news_id=? AND audience_role=?").get(job.company_id, job.news_id, job.audience_role);
      if (head?.revision !== job.revision) return false;
      const { response } = result;
      if (response.meta.mode !== "live") throw new PublicationError("Live queue cannot publish demo or mock responses");
      if (response.data.company_id !== job.company_id) throw new PublicationError("Response company mismatch");
      try {
        validate(job.kind === "analysis" ? "AnalysisResponse" : "AnswerResponse", response, true);
        if (job.kind === "analysis") {
          validateAnalysis(response.data);
          if (response.data.mode !== "live") throw new Error("Analysis is not live");
          const input=result.context?.input;
          if (input && (input.company_id !== undefined && input.company_id !== job.company_id || input.audience_role !== undefined && input.audience_role !== job.audience_role)) throw new Error("Saved context scope mismatch");
        }
      } catch(error) { throw new PublicationError(error instanceof Error ? error.message : "Publication validation failed"); }
      const now = this.now();
      if (job.kind === "analysis") {
        const id = required(response.data.id, "analysis.id");
        if (response.data.news_id !== job.news_id) throw new PublicationError("Response news mismatch");
        this.db.prepare("INSERT INTO live_analyses(id,job_id,company_id,news_id,revision,audience_role,response,context,sources,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(id, job.id, job.company_id, job.news_id, job.revision, job.audience_role, json(response), result.context ? json(result.context) : null, json(response.data.sources ?? []), now);
      } else {
        if (!this.available(job.company_id,job.audience_role).some(row=>row.id===job.analysis_id)) throw new PublicationError("Parent analysis is not available");
        if (response.data.analysis_id !== job.analysis_id) throw new PublicationError("Response analysis mismatch");
        this.db.prepare("INSERT INTO live_questions(job_id,analysis_id,company_id,question,response,created_at,owner) VALUES(?,?,?,?,?,?,?)").run(job.id, job.analysis_id, job.company_id, job.payload.question, json(response), now, job.owner ?? null);
      }
      this.db.prepare("UPDATE live_jobs SET status='succeeded',result=?,error=NULL,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(json(response), now, job.id);
      return true;
    });
  }
  defer(job: LiveJob, reason: string, retryAt: number): boolean {
    if (!Number.isFinite(retryAt)) throw new Error("Invalid retry timestamp");
    return this.transition(job, "deferred", reason, Math.max(retryAt, this.now() + 1), true);
  }
  fail(job: LiveJob, error: string, options: { retryable?: boolean; retryAt?: number } = {}): boolean {
    const retry = options.retryable !== false && job.attempts < job.max_attempts;
    return this.transition(job, retry ? "queued" : "failed", error, options.retryAt ?? this.now() + Math.min(3_600_000, 1000 * 2 ** Math.max(0, job.attempts - 1)), false);
  }
  private transition(job: LiveJob, status: LiveJobStatus, error: string, retryAt: number, refundAttempt: boolean): boolean {
    return Number(this.db.prepare("UPDATE live_jobs SET status=?,error=?,next_attempt=?,attempts=MAX(0,attempts-?),lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND lease_until>?")
      .run(status, String(error).slice(0, 1000), retryAt, refundAttempt ? 1 : 0, this.now(), job.id, job.lease_owner, job.lease_token, this.now()).changes) === 1;
  }
  freezeExecution(job:LiveJob,execution:Json):Json {
    return this.tx(()=>{
      if(!this.held(job))throw new Error("Worker lease lost before send");
      const current=this.getJob(job.id)!;
      const snapshot=current.payload.execution??execution;
      const payload:Json={...current.payload,execution:snapshot};delete payload.dispatch_reviewed;
      this.db.prepare("UPDATE live_jobs SET payload=?,updated_at=? WHERE id=?").run(json(payload),this.now(),job.id);
      return snapshot;
    });
  }
  uncertain(job:LiveJob,reason:string):boolean {return this.transition(job,"unknown",reason,this.now(),false);}
  unknownJobs(limit=50):LiveJob[] {return this.db.prepare("SELECT * FROM live_jobs WHERE status='unknown' AND error<>'legacy_send_requires_review' ORDER BY last_recovery_check,updated_at LIMIT ?").all(limit).map(r=>this.job(r));}
  recoveryChecked(id:string):void {this.db.prepare("UPDATE live_jobs SET last_recovery_check=? WHERE id=? AND status='unknown'").run(this.now(),id);}
  /** Restore is an offline maintenance operation: pause ALL dispatch, including work lost from the backup window. */
  recoveryHeld():boolean {return !!this.db.prepare("SELECT 1 FROM live_maintenance WHERE id=1 AND held=1").get();}
  setRestoreHold(held:boolean,actor:string,evidence:string):number {
    if(!actor?.trim()||actor.length>255||evidence?.trim().length<12||evidence.length>2000)throw new Error("Administrator and recovery evidence required");
    return this.tx(()=>{
      this.db.prepare("INSERT INTO live_maintenance VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET held=excluded.held,updated_at=excluded.updated_at").run(held?1:0,this.now());
      this.db.prepare("INSERT INTO live_maintenance_audit(actor,evidence,action,created_at) VALUES(?,?,?,?)").run(actor,evidence,held?"restore_hold":"release_restore_hold",this.now());
      if(!held)return 0;
      return Number(this.db.prepare("UPDATE live_jobs SET status='unknown',error='restored_queue_requires_review',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE status IN ('queued','running','deferred','unknown')").run(this.now()).changes);
    });
  }
  closeUnknown(id:string,company:string,actor:string,evidence:string):void {
    if(!actor?.trim()||actor.length>255||evidence?.trim().length<12||evidence.length>2000)throw new Error("Administrator and evidence required");
    this.tx(()=>{
      if(this.getJob(id,company)?.status!=="unknown")throw new Error("No unresolved job");
      this.db.prepare("INSERT INTO live_maintenance_audit(actor,evidence,action,created_at) VALUES(?,?,?,?)").run(actor,evidence,"close_job_without_retry:"+id,this.now());
      this.failUnknown(id,"operator_closed_without_retry");
    });
  }
  reviewLegacy(id:string,company:string,actor:string,evidence:string):void {this.reviewUnknownConfirmed(id,company,actor,evidence,true);}
  reviewUnknownConfirmed(id:string,company:string,actor:string,evidence:string,legacyOnly=false):void {
    if(!actor.trim()||evidence.trim().length<12)throw new Error("Administrator and provider evidence required");
    this.tx(()=>{
      const job=this.getJob(id,company);
      if(job?.status!=="unknown"||(legacyOnly&&job.error!=="legacy_send_requires_review"))throw new Error("Not an unresolved legacy job");
      this.db.exec("CREATE TABLE IF NOT EXISTS live_legacy_review(seq INTEGER PRIMARY KEY,job_id TEXT,company_id TEXT,actor TEXT,evidence TEXT,created_at INTEGER)");
      this.db.prepare("INSERT INTO live_legacy_review(job_id,company_id,actor,evidence,created_at) VALUES(?,?,?,?,?)").run(id,company,actor,evidence,this.now());
      this.db.prepare("UPDATE live_jobs SET status='queued',attempts=MIN(attempts,max_attempts-1),error=NULL,payload=?,next_attempt=?,updated_at=? WHERE id=?").run(json({...job.payload,dispatch_reviewed:true}),this.now(),this.now(),id);
    });
  }
  resumeUnknown(id:string):void {this.db.prepare("UPDATE live_jobs SET status='queued',error=NULL,attempts=MIN(attempts,max_attempts-1),next_attempt=?,updated_at=? WHERE id=? AND status='unknown'").run(this.now(),this.now(),id);}
  failUnknown(id:string,error:string):void {this.db.prepare("UPDATE live_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='unknown'").run(error.slice(0,1000),this.now(),id);}
  getAnalysis(id: string, companyId: string, owner?: string): SavedAnalysis | null {
    const row = this.db.prepare("SELECT * FROM live_analyses WHERE id=? AND company_id=?").get(id, companyId);
    return row ? this.saved(row,owner) : null;
  }
  heads(companyId: string, role: string): { news_id: string; revision: string }[] {
    return this.db.prepare("SELECT news_id,revision FROM live_heads WHERE company_id=? AND audience_role=?").all(companyId, role).map(row => ({ news_id: String(row.news_id), revision: String(row.revision) }));
  }
  versions(companyId: string, newsId: string, role: string): SavedAnalysis[] { return this.analysisVersions(companyId, newsId, role); }
  jobs(companyId: string, limit = 50, owner?: string, role?:string): LiveJob[] {
    required(companyId, "company_id"); bounded(limit, 1, 200, "limit");
    if (!Number.isInteger(limit)) throw new Error("Invalid limit");
    return this.db.prepare("SELECT * FROM live_jobs WHERE company_id=?"+(owner===undefined?"":" AND (kind='analysis' OR owner=?)")+(role?" AND audience_role=?":"")+" ORDER BY updated_at DESC,rowid DESC LIMIT ?").all(companyId,...(owner===undefined?[]:[owner]),...(role?[role]:[]), limit).map(row => this.job(row));
  }
  analysisVersions(companyId: string, newsId: string, role: string): SavedAnalysis[] {
    return this.db.prepare("SELECT * FROM live_analyses WHERE company_id=? AND news_id=? AND audience_role=? ORDER BY seq DESC").all(companyId, newsId, role).map(row => this.saved(row));
  }
  private saved(row: any, owner?: string): SavedAnalysis {
    const head = this.db.prepare("SELECT revision FROM live_heads WHERE company_id=? AND news_id=? AND audience_role=?").get(row.company_id, row.news_id, row.audience_role);
    const history = this.db.prepare("SELECT q.question,q.response,q.created_at FROM live_questions q JOIN live_jobs j ON j.id=q.job_id AND j.kind='question' AND j.status='succeeded' AND j.company_id=q.company_id AND j.analysis_id=q.analysis_id AND j.owner IS q.owner AND j.result=q.response WHERE q.company_id=? AND q.analysis_id=? AND q.owner IS ? ORDER BY q.seq").all(row.company_id, row.id,owner ?? null).flatMap((q: any) => {
      try {const response = JSON.parse(q.response);validate("AnswerResponse",response,true);
        if(response.meta.mode!=="live" || response.data.company_id!==row.company_id || response.data.analysis_id!==row.id)return [];
        return [{ question:q.question,answer:response.data.answer,response,created_at:q.created_at }];
      } catch {return [];}
    });
    return { seq: row.seq, id: row.id, company_id: row.company_id, news_id: row.news_id, revision: row.revision, audience_role: row.audience_role,
      response: JSON.parse(row.response), context: row.context ? JSON.parse(row.context) : null, sources: JSON.parse(row.sources), created_at: row.created_at,
      stale: head?.revision !== row.revision, favorite: Boolean(owner===undefined ? this.db.prepare("SELECT 1 FROM live_favorites WHERE company_id=? AND news_id=? AND audience_role=?").get(row.company_id,row.news_id,row.audience_role) : this.db.prepare("SELECT 1 FROM live_user_favorites WHERE company_id=? AND owner=? AND news_id=? AND audience_role=?").get(row.company_id,owner,row.news_id,row.audience_role)), history };
  }
  /** One visibility predicate for feed and counters. The archive remains intact. */
  private available(companyId?: string, role?: string, owner?: string): any[] {
    const rows=this.db.prepare(`SELECT a.*,EXISTS(SELECT 1 FROM ${owner===undefined ? "live_favorites" : "live_user_favorites"} f
      WHERE f.company_id=a.company_id AND f.news_id=a.news_id AND f.audience_role=a.audience_role${owner===undefined ? "" : " AND f.owner=?"}) AS is_favorite
      FROM live_analyses a JOIN live_jobs j ON j.id=a.job_id AND j.kind='analysis' AND j.status='succeeded'
      AND j.company_id=a.company_id AND j.news_id=a.news_id AND j.audience_role=a.audience_role AND j.revision=a.revision AND j.result=a.response
      JOIN live_heads h ON h.company_id=a.company_id AND h.news_id=a.news_id AND h.audience_role=a.audience_role AND h.revision=a.revision
      WHERE 1=1${companyId ? " AND a.company_id=?" : ""}${role ? " AND a.audience_role=?" : ""} ORDER BY a.seq DESC`)
      .all(...(owner===undefined?[]:[owner]),...(companyId?[companyId]:[]),...(role?[role]:[]));
    return rows.filter(row=>{
      try {const response=JSON.parse(String(row.response)),context=row.context?JSON.parse(String(row.context)):null;
        if(context?.input&&(context.input.company_id!==undefined&&context.input.company_id!==row.company_id||context.input.audience_role!==undefined&&context.input.audience_role!==row.audience_role))return false;
        validate("AnalysisResponse",response,true);validateAnalysis(response.data);
        return response.meta.mode==="live" && response.data.mode==="live" && response.data.id===row.id && response.data.company_id===row.company_id && response.data.news_id===row.news_id;
      } catch {return false;}
    });
  }
  private running(companyId?:string,role?:string,owner?:string):number {
    return Number(this.db.prepare(`SELECT COUNT(*) n FROM live_jobs j WHERE status='running' AND lease_until>? AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
      AND EXISTS(SELECT 1 FROM live_heads h WHERE h.company_id=j.company_id AND h.news_id=j.news_id AND h.audience_role=j.audience_role AND h.revision=j.revision)`
      +(companyId?" AND company_id=?":"")+(role?" AND audience_role=?":"")+(owner===undefined?"":" AND (kind='analysis' OR owner=?)"))
      .get(this.now(),...(companyId?[companyId]:[]),...(role?[role]:[]),...(owner===undefined?[]:[owner]))!.n);
  }
  feed(companyId: string, options: { audience_role?: string; limit?: number; cursor?: string; favorites?: boolean; owner?: string } = {}): { items: SavedAnalysis[]; next_cursor: string | null; total:number; visible_ids:string[]; available_count:number; favorites_count:number; running_tasks:number; has_running_tasks:boolean } {
    required(companyId,"company_id");
    const limit=bounded(options.limit??20,1,100,"limit");if(!Number.isInteger(limit))throw new Error("Invalid limit");
    return this.tx(()=>{
      const role=options.audience_role??null,favorites=Boolean(options.favorites);
      let snapshot=Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM live_analyses").get()!.seq),after=snapshot+1;
      let head_snapshot=Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM live_head_versions").get()!.seq);
      if(options.cursor)try {
        if(options.cursor.length>2048)throw new Error();
        const cursor=JSON.parse(Buffer.from(options.cursor,"base64url").toString("utf8"));
        if(cursor.version!==2||cursor.company!==companyId||(cursor.owner??null)!==(options.owner??null)||cursor.role!==role||cursor.favorites!==favorites||!Number.isSafeInteger(cursor.snapshot)||!Number.isSafeInteger(cursor.after)||!Number.isSafeInteger(cursor.head_snapshot)||cursor.head_snapshot<0||cursor.snapshot<0||cursor.after<1||cursor.after>cursor.snapshot+1)throw new Error();
        ({snapshot,after,head_snapshot}=cursor);
      }catch {throw new Error("Invalid feed cursor");}
      const available=this.available(companyId,options.audience_role,options.owner),filtered=available.filter(row=>!favorites||row.is_favorite);
      const rows=filtered.filter(row=>Number(row.seq)<=snapshot&&Number(row.seq)<after&&this.db.prepare("SELECT revision FROM live_head_versions WHERE company_id=? AND news_id=? AND audience_role=? AND seq<=? ORDER BY seq DESC LIMIT 1").get(companyId,row.news_id,row.audience_role,head_snapshot)?.revision===row.revision);
      const page=rows.slice(0,limit),running=this.running(companyId,options.audience_role,options.owner);
      return {items:page.map(row=>this.saved(row,options.owner)),total:filtered.length,visible_ids:filtered.map(row=>String(row.id)),available_count:available.length,favorites_count:available.filter(row=>row.is_favorite).length,
        running_tasks:running,has_running_tasks:running>0,
        next_cursor:rows.length>limit?Buffer.from(json({version:2,company:companyId,owner:options.owner??null,role,favorites,snapshot,head_snapshot,after:page.at(-1)!.seq})).toString("base64url"):null};
    });
  }
  favorite(companyId: string, analysisId: string, selected: boolean, owner?: string): boolean {
    const analysis = this.getAnalysis(analysisId, companyId);
    if (!analysis) return false;
    if(owner!==undefined) {
      if(selected)this.db.prepare("INSERT OR IGNORE INTO live_user_favorites VALUES(?,?,?,?,?)").run(companyId,owner,analysis.news_id,analysis.audience_role,this.now());
      else this.db.prepare("DELETE FROM live_user_favorites WHERE company_id=? AND owner=? AND news_id=? AND audience_role=?").run(companyId,owner,analysis.news_id,analysis.audience_role);
      return true;
    }
    if (selected) this.db.prepare("INSERT OR IGNORE INTO live_favorites VALUES(?,?,?,?)").run(companyId, analysis.news_id, analysis.audience_role, this.now());
    else this.db.prepare("DELETE FROM live_favorites WHERE company_id=? AND news_id=? AND audience_role=?").run(companyId, analysis.news_id, analysis.audience_role);
    return true;
  }
  status(companyId?: string, owner?: string, role?: string): Json {
    return this.tx(()=>{
      const where=" WHERE 1=1"+(companyId?" AND company_id=?":"")+(role?" AND audience_role=?":"");
      const args=[...(companyId?[companyId]:[]),...(role?[role]:[])],personal=owner===undefined?"":" AND (kind='analysis' OR owner=?)",personalArgs=owner===undefined?[]:[owner];
      const counts:Record<string,number>={queued:0,running:0,deferred:0,succeeded:0,failed:0,superseded:0,unknown:0};
      for(const row of this.db.prepare("SELECT status,COUNT(*) n FROM live_jobs"+where+personal+" GROUP BY status").all(...args,...personalArgs))counts[String(row.status)]=Number(row.n);
      const available=this.available(companyId,role,owner),running=this.running(companyId,role,owner);
      return {jobs:counts,analyses:available.length,available_count:available.length,favorites_count:available.filter(row=>row.is_favorite).length,running_tasks:running,has_running_tasks:running>0,
        saved_versions:Number(this.db.prepare("SELECT COUNT(*) n FROM live_analyses"+where).get(...args)!.n),
        subscriptions:this.subscriptions().filter(s=>(!companyId||s.company_id===companyId)&&(!role||s.audience_role===role)),
        oldest_pending_at:this.db.prepare("SELECT MIN(created_at) oldest FROM live_jobs"+where+personal+" AND status IN ('queued','deferred')").get(...args,...personalArgs)!.oldest,
        recent_errors:this.db.prepare("SELECT id,kind,company_id,audience_role,status,error,updated_at FROM live_jobs"+where+personal+" AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 20").all(...args,...personalArgs)};
    });
  }
}
