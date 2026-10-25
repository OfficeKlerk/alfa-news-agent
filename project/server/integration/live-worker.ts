import { randomUUID } from "node:crypto";
import { LiveStore, type JobResult, type LiveJob } from "./live-store.js";

export class DeferredJobError extends Error {
  constructor(message: string, readonly retryAt: number) { super(message); }
}
export { DeferredJobError as DeferJob };
export class PermanentJobError extends Error {}
export type LiveJobHandler = (job: LiveJob, signal: AbortSignal) => Promise<JobResult>;
export type LiveWorkerOptions = {
  concurrency?: number; leaseMs?: number; pollMs?: number; enabled?: () => boolean;
  owner?: string; onError?: (error: unknown) => void;
};

/** Bounded worker with database leases, fencing, heartbeat and explicit generation deferrals. */
export class LiveWorker {
  readonly owner: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  constructor(readonly store: LiveStore, private readonly handler: LiveJobHandler, private readonly options: LiveWorkerOptions = {}) {
    this.owner = options.owner ?? randomUUID();
    this.concurrency = options.concurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollMs = options.pollMs ?? 1000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 16) throw new Error("Worker concurrency must be 1..16");
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 50 || this.leaseMs > 3_600_000) throw new Error("Invalid worker lease");
    if (!Number.isFinite(this.pollMs) || this.pollMs < 10 || this.pollMs > 60_000) throw new Error("Invalid worker poll interval");
  }
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const poll = () => { void this.tick().catch(error => this.options.onError?.(error)); };
    this.timer = setInterval(poll, this.pollMs); this.timer.unref(); poll();
  }
  async tick(): Promise<void> {
    if (this.stopping || this.options.enabled?.() === false) return;
    const started: Promise<void>[] = [];
    while (!this.stopping && this.active.size < this.concurrency) {
      const job = this.store.claim(this.owner, this.leaseMs);
      if (!job) break;
      const controller = new AbortController();
      // Defer handler start until active contains the job, including synchronously throwing handlers.
      const promise = Promise.resolve().then(() => this.run(job, controller)).finally(() => this.active.delete(job.id));
      this.active.set(job.id, { controller, promise }); started.push(promise);
    }
    await Promise.all(started);
  }
  private async run(job: LiveJob, controller: AbortController): Promise<void> {
    const heartbeat = setInterval(() => {
      try { if (!this.store.heartbeat(job, this.leaseMs)) controller.abort(new Error("Worker lease lost")); }
      catch (error) { controller.abort(error); this.options.onError?.(error); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      const result = await this.handler(job, controller.signal);
      if (controller.signal.aborted) this.store.fail(job, "worker_interrupted", { retryable: true });
      else this.store.complete(job, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DeferredJobError) this.store.defer(job, message, error.retryAt);
      else this.store.fail(job, message, { retryable: !(error instanceof PermanentJobError) });
    } finally { clearInterval(heartbeat); }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const { controller } of this.active.values()) controller.abort(new Error("Worker stopping"));
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
  }
  status(): { running: boolean; active: number; concurrency: number; owner: string } {
    return { running: Boolean(this.timer) && !this.stopping, active: this.active.size, concurrency: this.concurrency, owner: this.owner };
  }
}
