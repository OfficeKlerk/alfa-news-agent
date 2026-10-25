import { createHash, randomUUID } from "node:crypto";
import type { Settings } from "../config.js";
import { ModelError, type Json } from "../types.js";
import type { ContractClient } from "./client.js";
import { ApiFault, type Envelope } from "./contracts.js";
import type { RetrievalPort } from "./retrieval.js";
import type { AnalysisEngine } from "./analysis-engine.js";
import type { PreparedContext } from "./grounding.js";
import { prepareEventForRanking } from "./event-interpretation.js";
import { LiveStore, type LiveJob, type SavedAnalysis, type Subscription } from "./live-store.js";
import { LiveWorker, DeferredJobError, PermanentJobError, UnknownJobError } from "./live-worker.js";
import { selectReason } from "./live-selection.js";

import { canonicalJson } from "./context.js";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Provenance stays in the evidence snapshot, but rebuilding files must not change business facts. */
export function profileRevision(profile: Json): string {
  const semantic = (value: any): any => {
    if (Array.isArray(value)) return value.map(semantic);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key, child]) => !(key === "source" && child && typeof child === "object" && ("records" in child || "file" in child)))
      .map(([key, child]) => [key, key === "provenance" ? {company_raw_fields: (child as Json)?.company_raw_fields ?? {}} : semantic(child)]));
  };
  return hash(semantic(profile));
}
export function analysisRevision(event: Json, profileHash: string): string {
  return hash(["live-v2", event.published_at, event.content?.material_revision ?? [event.title, event.text], profileHash]);
}
/** Keep the same publication-window rule as retrieval's complete event clusters. */
function inPublicationWindow(event: Json, since: number): boolean {
  return typeof event.published_at === "string" && Date.parse(event.published_at) >= since;
}
export function moscowDayStart(now = Date.now()): number { return Math.floor((now + 10_800_000) / 86_400_000) * 86_400_000 - 10_800_000; }
export function publicCard(saved: SavedAnalysis): Json {
  return { id: saved.id, seq: saved.seq, company_id: saved.company_id, news_id: saved.news_id, revision: saved.revision,
    audience_role: saved.audience_role, title: saved.context?.input?.event?.title ?? saved.response.data.sources.find((s: Json) => s.kind === "news")?.title ?? "Новость",
    created_at: saved.created_at, stale: saved.stale, favorite: saved.favorite, analysis: saved.response.data };
}
export function publicJob(job: LiveJob): Json {
  return { id: job.id, kind: job.kind, company_id: job.company_id, status: job.status,
    title: job.payload.event?.title ?? job.payload.question ?? "Новость", news_id: job.news_id, analysis_id: job.analysis_id,
    attempts: job.attempts, error: job.error, next_attempt: job.next_attempt, created_at: job.created_at, updated_at: job.updated_at, result: job.result };
}
export type LiveServiceOptions = { settings: Settings; store: LiveStore; ml: ContractClient; retrieval: RetrievalPort; engine: AnalysisEngine;
  budget?: (companyId?: string) => Promise<Json>; now?: () => number };

/** Discovery never calls the LLM. Only leased jobs may publish validated, company-bound results. */
export class LiveService {
  readonly store: LiveStore;
  readonly worker: LiveWorker;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private stopped = false;
  private lastError: string | null = null;
  private now: () => number;
  constructor(readonly options: LiveServiceOptions) {
    this.store = options.store; this.now = options.now ?? Date.now;
    this.store.db.exec("CREATE TABLE IF NOT EXISTS live_selection(company_id TEXT NOT NULL,audience_role TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(company_id,audience_role))");
    this.worker = new LiveWorker(this.store, (job, signal) => this.process(job, signal), { concurrency: options.settings.liveWorkerConcurrency ?? 2,
      onError: error => { this.lastError = error instanceof Error ? error.message : "Worker failure"; } });
  }
  get generationEnabled(): boolean { return this.options.settings.analysisEnabled !== false && this.options.settings.mode === "live" && !this.store.recoveryHeld(); }
  start(): void {
    if (this.timer) return;
    this.stopped = false; this.worker.start();
    this.timer = setInterval(() => { void this.scanDue(); }, (this.options.settings.liveScanSeconds ?? 60) * 1000);
    this.timer.unref(); void this.scanDue();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.scanning; await this.worker.stop(); }
  async subscribe(input: Json): Promise<Subscription> {
    const old = this.store.subscriptions();
    if (input.enabled !== false && !old.some(s => s.company_id === input.company_id && s.enabled)
      && new Set(old.filter(s => s.enabled).map(s => s.company_id)).size >= (this.options.settings.liveMaxCompanies ?? 100))
      throw new ApiFault(429, "BUSY", "Достигнут лимит подключённых компаний");
    const profile = await this.options.ml.call("/v1/companies/" + encodeURIComponent(input.company_id), "ProfileResponse", randomUUID());
    if (profile.data.company_id !== input.company_id || profile.meta.mode !== "live") throw new ApiFault(422, "VALIDATION_ERROR", "Нужен настоящий профиль компании");
    const subscription = this.store.subscribe({ company_id: input.company_id, audience_role: input.audience_role,
      limit: Math.min(input.limit ?? this.options.settings.liveCompanyNewsLimit ?? 5, this.options.settings.liveCompanyNewsLimit ?? 5),
      min_score: input.min_score ?? this.options.settings.liveMinScore ?? 0.2, enabled: input.enabled });
    // The user explicitly connected a company. Discovery can proceed independently of the HTTP response.
    if (subscription.enabled) void this.scanDue();
    return subscription;
  }
  scanDue(): Promise<void> {
    if (this.scanning) return this.scanning;
    if (this.stopped) return Promise.resolve();
    this.scanning = (async () => {
      if(this.store.recoveryHeld())return;
      // GET/status only: no paid model request is issued during recovery polling.
      for(const job of this.store.unknownJobs()) {
        try {
          const recovery:Json|undefined=await this.options.engine.recover?.(job.id,job.company_id,job.kind);
          if(recovery && ["succeeded","recoverable"].includes(recovery.state))this.store.resumeUnknown(job.id);
          else if(recovery?.state==="failed")this.store.failUnknown(job.id,"model_operation_failed: "+(recovery.error?.code??"failed"));
        } catch { /* Keep unknown across dependency failures. Never infer a failed send. */ }
        finally {this.store.recoveryChecked(job.id);}
      }
      for (const subscription of this.store.dueSubscriptions()) {
        if (this.stopped) break;
        try { await this.discover(subscription); this.lastError = null; }
        catch (error) {
          this.lastError = error instanceof Error ? error.message : "Discovery failure";
          this.store.touchSubscription(subscription.company_id, subscription.audience_role, this.now() + 60_000, this.lastError);
        }
      }
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  async scan(companyId: string, role: string): Promise<Json> {
    const sub = this.store.subscriptions().find(s => s.company_id === companyId && s.audience_role === role && s.enabled);
    if (!sub) throw new ApiFault(404, "NOT_FOUND", "Сначала подключите компанию к ленте");
    await this.scanning;
    this.store.touchSubscription(companyId, role, this.now());
    await this.scanDue();
    return this.selection(companyId, role) ?? {};
  }
  selection(companyId: string, role: string): Json | null {
    const row = this.store.db.prepare("SELECT payload FROM live_selection WHERE company_id=? AND audience_role=?").get(companyId, role);
    return row ? JSON.parse(String(row.payload)) : null;
  }
  /** Expiry releases reservations only; historical cards keep their original validity/head. */
  private expirePending(companyId: string, since: number): number {
    const jobs = this.store.db.prepare("SELECT id,payload,created_at FROM live_jobs WHERE company_id=? AND kind='analysis' AND status IN ('queued','deferred')").all(companyId);
    let expired = 0;
    for (const row of jobs) {
      const payload = JSON.parse(String(row.payload));
      const freshCorrection = payload.reanalysis === true && Number(row.created_at) >= since;
      if (freshCorrection || inPublicationWindow(payload.event ?? {}, since)) continue;
      expired += Number(this.store.db.prepare("UPDATE live_jobs SET status='superseded',error='publication_window_expired',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('queued','deferred')")
        .run(this.now(), row.id).changes);
    }
    return expired;
  }
  async discover(sub: Subscription): Promise<Json> {
    const { ml, retrieval, settings } = this.options, asOf = new Date(this.now()).toISOString(), id = randomUUID();
    const sinceMs = this.now() - (settings.liveLookbackDays ?? 7) * 86_400_000;
    const since = new Date(sinceMs).toISOString();
    const profile = await ml.call("/v1/companies/" + encodeURIComponent(sub.company_id), "ProfileResponse", id);
    if (profile.meta.mode !== "live" || profile.data.company_id !== sub.company_id) throw new Error("Non-live or mismatched company profile");
    const expiredPending = this.expirePending(sub.company_id, sinceMs);
    const profileHash = profileRevision(profile.data), events: Json[] = [], max = settings.liveMaxCandidates ?? 500;
    let offset = 0;
    for (;;) {
      const page = await retrieval.search({ query: "", news_id: null, as_of: asOf, since, limit: Math.min(25, max - offset), offset, candidate_limit: max }, id);
      if (page.meta.mode !== "live") throw new Error("Live discovery rejected synthetic news");
      events.push(...page.data.items);
      if (!page.data.items.length || page.data.next_offset == null || page.data.next_offset >= max) break;
      if (page.data.next_offset <= offset) throw new Error("Non-progressing news pagination");
      offset = page.data.next_offset;
    }
    const oldHeads = new Map(this.store.heads(sub.company_id, sub.audience_role).map(h => [h.news_id, h.revision]));
    // A correction must stale an existing card even outside today's candidate window or relevance filter.
    for (const newsId of oldHeads.keys()) if (!events.some(e => e.news_id === newsId)) {
      const page = await retrieval.search({ query: "", as_of: asOf, limit: 1, news_id: newsId }, id);
      if (page.meta.mode !== "live") throw new Error("Live revision check rejected synthetic news");
      if (page.data.items[0]) {
        const event = page.data.items[0], revision = analysisRevision(event, profileHash);
        const previous = oldHeads.get(newsId);
        // Unchanged historical cards are still valid snapshots, and must not consume
        // another rank/generation slot merely because a source was fetched again.
        const currentJob = this.store.db.prepare("SELECT 1 FROM live_jobs WHERE company_id=? AND news_id=? AND audience_role=? AND revision=? LIMIT 1").get(sub.company_id,newsId,sub.audience_role,revision);
        if (inPublicationWindow(event, sinceMs) || previous !== "filtered:" + revision && (previous !== revision || !currentJob)) events.push(event);
      } else this.store.invalidate(sub.company_id, newsId, sub.audience_role, "unavailable", "source_no_longer_available");
    }
    const ranked = new Map<string, Json>(), oversized = new Set<string>();
    let batch: Json[] = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const response = await ml.call("/v1/rank", "RankDataResponse", id,
        { company_id: sub.company_id, events: batch.map(prepareEventForRanking), as_of: asOf, limit: batch.length });
      if (response.meta.mode !== "live" || response.data.company_id !== sub.company_id || response.data.as_of !== asOf) throw new Error("Rank changed discovery context");
      for (const item of response.data.items) {
        if (!batch.some(e => e.news_id === item.news_id && e.event_id === item.event_id)) throw new Error("Rank returned unknown event");
        ranked.set(item.news_id, item);
      }
      batch = []; bytes = 0;
    };
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > 600_000) { oversized.add(event.news_id); continue; }
      if (batch.length >= 25 || bytes + size > 650_000) await flush();
      batch.push(event); bytes += size;
    }
    await flush();
    const decisions = events.map(event => {
      const item = ranked.get(event.news_id), revision = analysisRevision(event, profileHash), previous = oldHeads.get(event.news_id);
      const gate = oversized.has(event.news_id) ? { eligible: false, reason: "context_too_large" } : !item ? { eligible: false, reason: "ranking_missing" }
        : selectReason(event, item, profile.data, sub.min_score);
      // This is a queue policy, not a calibrated probability or a replacement ML score.
      const priority = (item?.score ?? 0) + (["official_key_rate_context_for_all_companies", "official_general_tax_context"].includes(gate.reason) ? 2 : 0);
      const effectiveRevision = gate.eligible ? revision : "filtered:" + revision;
      if (previous !== undefined && previous !== effectiveRevision) this.store.invalidate(sub.company_id,event.news_id,sub.audience_role,effectiveRevision,gate.eligible ? "news_revision_superseded" : "no_longer_relevant");
      if (gate.eligible) this.store.db.prepare("UPDATE live_jobs SET priority=? + CASE WHEN json_extract(payload,'$.reanalysis')=1 THEN 10 ELSE 0 END WHERE company_id=? AND news_id=? AND audience_role=? AND revision=? AND status IN ('queued','deferred')")
        .run(priority,sub.company_id,event.news_id,sub.audience_role,revision);
      return {event,item,revision,previous,gate,priority};
    });
    const limit = Math.min(sub.limit, settings.liveCompanyNewsLimit ?? 5);
    const remaining = () => Math.max(0, limit - this.store.analysisCounts(sub.company_id, moscowDayStart(this.now())).reserved);
    let slots = remaining(), queued = 0, eligible = 0, reprioritized = 0;
    const items: Json[] = [], filters: Record<string, number> = {};
    for (const {event,item,revision,previous,gate,priority} of decisions.sort((a,b) => b.priority - a.priority || b.event.published_at.localeCompare(a.event.published_at))) {
      const currentJob = this.store.db.prepare("SELECT status,error FROM live_jobs WHERE company_id=? AND news_id=? AND audience_role=? AND revision=? LIMIT 1").get(sub.company_id,event.news_id,sub.audience_role,revision);
      // A worker may already have advanced the head before discovery. The new
      // revision still needs a replacement job, even for an older publication.
      const changed = previous !== undefined && (previous !== revision || !currentJob);
      let selected = false, reason = gate.reason;
      if (gate.eligible) {
        eligible++;
        const replaced = currentJob?.status === "superseded" && currentJob.error === "selection_priority_replaced";
        const existing = previous === revision && currentJob && !replaced;
        slots = remaining();
        // Only an unstarted lower-priority analysis can release a reservation. Work
        // already paid for, questions, running jobs and corrections remain protected.
        if (!existing && !changed && slots <= 0 && this.store.analysisCounts(sub.company_id, moscowDayStart(this.now())).reserved === limit
          && this.store.supersedeLowerPriorityPending(sub.company_id,priority)) { reprioritized++; slots = remaining(); }
        if (existing) reason = "already_processed_or_queued";
        else if (slots <= 0 && !changed) reason = "company_daily_limit";
        else {
          const job = this.store.enqueueAnalysis({ company_id: sub.company_id, news_id: event.news_id, audience_role: sub.audience_role, revision,
            priority: priority + (changed ? 10 : 0), payload: { company_id: sub.company_id, audience_role: sub.audience_role,
              event, as_of: asOf, reanalysis: changed, profile_sha256: profileHash, selection: { score: item?.score ?? 0, reason: gate.reason } } });
          selected = true; queued++; slots = remaining();
          reason = changed ? "material_revision_queued" : gate.reason;
          if (job.status === "failed") { selected = false; reason = "previous_generation_failed"; }
        }
      }
      filters[reason] = (filters[reason] ?? 0) + 1;
      items.push({ news_id: event.news_id, title: event.title, score: item?.score ?? 0, selected, reason,
        source_url: event.sources.find((s: Json) => s.kind === "news")?.url ?? "" });
    }
    const result = { scanned_at: asOf, expired_pending: expiredPending, reprioritized, considered: events.length, eligible, queued, filtered: events.length - eligible, quota_remaining: slots, items, filters };
    this.store.db.prepare("INSERT INTO live_selection VALUES(?,?,?) ON CONFLICT(company_id,audience_role) DO UPDATE SET payload=excluded.payload")
      .run(sub.company_id, sub.audience_role, JSON.stringify(result));
    this.store.touchSubscription(sub.company_id, sub.audience_role, this.now() + (settings.liveScanSeconds ?? 60) * 1000);
    return result;
  }
  /** Check both inputs again before publication; collector and company updates can race a long model call. */
  private async assertCurrentRevision(job: LiveJob): Promise<void> {
    const [current, profile] = await Promise.all([
      this.options.retrieval.search({query:"",news_id:job.news_id,as_of:new Date(this.now()).toISOString(),limit:1},job.id),
      this.options.ml.call("/v1/companies/"+encodeURIComponent(job.company_id),"ProfileResponse",job.id),
    ]);
    if (current.meta.mode !== "live" || profile.meta.mode !== "live" || profile.data.company_id !== job.company_id)
      throw new PermanentJobError("current_context_mismatch");
    const event=current.data.items[0];
    if (event && event.news_id !== job.news_id) throw new PermanentJobError("current_news_mismatch");
    const revision=event ? analysisRevision(event,profileRevision(profile.data)) : "unavailable";
    if (revision !== job.revision) {
      this.store.invalidate(job.company_id,job.news_id,job.audience_role,revision,"news_or_company_revision_changed");
      this.store.touchSubscription(job.company_id,job.audience_role,this.now());
      throw new PermanentJobError("news_or_company_revision_changed");
    }
  }
  private async process(job: LiveJob, signal: AbortSignal) {
    if (!this.generationEnabled) throw new DeferredJobError("generation_disabled_no_key", this.now() + 60_000);
    try {
      // Check availability BEFORE freezing a dispatch. A missing record AFTER a timeout
      // is NOT proof that no payment happened (the agent database may have been restored).
      if(this.options.engine.recover) {
        const receipt:Json=await this.options.engine.recover(job.id,job.company_id,job.kind);
        if(receipt.state==="not_found" && job.payload.execution && !job.payload.dispatch_reviewed)throw new UnknownJobError("model_journal_missing_after_dispatch");
        if(["unknown","running"].includes(receipt.state))throw new UnknownJobError("model_receipt_unresolved");
        if(receipt.state==="failed")throw new PermanentJobError("model_operation_failed: "+(receipt.error?.code??"failed"));
      }
      if (job.kind === "question") {
        const saved = this.store.getAnalysis(job.analysis_id!, job.company_id, job.owner ?? undefined);
        if (!saved?.context || saved.stale) throw new PermanentJobError("analysis_superseded_or_missing");
        await this.assertCurrentRevision(job);
        if (signal.aborted) throw new DeferredJobError("worker_interrupted",this.now()+1000);
        const execution=this.store.freezeExecution(job,job.payload.execution ?? {saved:{...saved,context:saved.context},question:job.payload.question});
        const response = await this.options.engine.answer(execution.saved, execution.question, job.id,signal);
        if (response.meta.mode !== "live") throw new PermanentJobError("Synthetic answers cannot be published");
        await this.assertCurrentRevision(job);
        return { response };
      }
      const subscription = this.store.subscriptions().find(s=>s.company_id===job.company_id&&s.audience_role===job.audience_role);
      if (!subscription?.enabled) throw new DeferredJobError("subscription_paused",this.now()+60_000);
      let execution=job.payload.execution;
      if(!execution) {
        const asOf = new Date(this.now()).toISOString();
        const latest = await this.options.retrieval.search({query:"",news_id:job.news_id,as_of:asOf,limit:1},job.id);
        const event=latest.data.items[0];
        if(!event||latest.meta.mode!=="live")throw new PermanentJobError("source_no_longer_available");
        const since=this.now()-(this.options.settings.liveLookbackDays??7)*86_400_000;
        if(!inPublicationWindow(event,since)&&!(job.payload.reanalysis===true&&job.created_at>=since))throw new PermanentJobError("publication_window_expired");
        const body={...job.payload,event,as_of:asOf};
        const prepared=await this.options.engine.assemble(body,job.id);
        const revision=analysisRevision(event,profileRevision(prepared.input.profile));
        if(revision!==job.revision){this.store.invalidate(job.company_id,job.news_id,job.audience_role,revision);this.store.touchSubscription(job.company_id,job.audience_role,this.now());throw new PermanentJobError("news_or_company_changed_before_generation");}
        const gate=selectReason(event,prepared.input.ranked_item,prepared.input.profile,subscription.min_score);
        if(!gate.eligible){this.store.invalidate(job.company_id,job.news_id,job.audience_role,"filtered:"+revision,"no_longer_relevant");throw new PermanentJobError(gate.reason);}
        execution=this.store.freezeExecution(job,{body,prepared});
      }
      if(signal.aborted)throw new UnknownJobError("worker_interrupted_after_snapshot");
      const result=await this.options.engine.generate(execution.body,job.id,execution.prepared,signal);
      if (result.response.meta.mode !== "live" || result.response.data.mode !== "live") throw new PermanentJobError("Synthetic analyses cannot be published");
      await this.assertCurrentRevision(job);
      return result;
    } catch (error) {
      if((error instanceof ApiFault||error instanceof ModelError) && (["MODEL_OUTCOME_UNKNOWN","OPERATION_CONFLICT"].includes(error.code) || (["DEPENDENCY_TIMEOUT","DEPENDENCY_UNAVAILABLE"].includes(error.code)&&this.store.getJob(job.id)?.payload.execution)))throw new UnknownJobError(error.code);
      if (error instanceof ApiFault || error instanceof ModelError) {
        if(["MODEL_LIMIT","MODEL_AUTH_ERROR","MODEL_UNAVAILABLE","MODEL_TIMEOUT"].includes(error.code) && this.options.engine.recover) {
          const state=await this.options.engine.recover(job.id,job.company_id,job.kind);
          if(state.state==="failed")throw new PermanentJobError(error.code+": request rejected; operator review required");
        }
        if (error.code === "MODEL_LIMIT") throw new DeferredJobError("model_budget_exhausted", moscowDayStart(this.now()) + 86_400_000);
        if (error.code === "MODEL_AUTH_ERROR") throw new DeferredJobError("model_authorization_required", this.now() + 300_000);
        if ([400, 403, 404, 409, 413, 415, 422].includes(error.status) || ["MODEL_RESPONSE_INVALID", "MODEL_INVALID_RESPONSE", "CONTRACT_VIOLATION","OPERATION_CONFLICT"].includes(error.code))
          throw new PermanentJobError(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  }
  async status(companyId?: string, role = "cfo", owner?: string): Promise<Json> {
    const settled = await Promise.allSettled([this.options.retrieval.status?.(randomUUID()), this.options.budget?.(companyId)]);
    const collector = settled[0].status === "fulfilled" ? settled[0].value?.data ?? null : { error: "collector_unavailable" };
    const budget = settled[1].status === "fulfilled" ? settled[1].value ?? null : { error: "budget_unavailable" };
    return { generation_enabled: this.generationEnabled, recovery_review_required: this.store.recoveryHeld(), worker: this.worker.status(), queue: this.store.status(companyId, owner),
      subscriptions: this.store.subscriptions().filter(s => !companyId || s.company_id === companyId), budget, collector,
      selection: companyId ? this.selection(companyId, role) : null, error: companyId ? this.store.subscriptions().find(s=>s.company_id===companyId && s.audience_role===role)?.error ?? null : this.lastError };
  }
}
