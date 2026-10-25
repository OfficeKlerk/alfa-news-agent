import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveStore, type LiveJob, type JobResult } from "../integration/live-store.js";
import { DeferredJobError, LiveWorker, PermanentJobError } from "../integration/live-worker.js";
import { envelope } from "../integration/contracts.js";

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "alfa-live-store-"));
  let clock = Date.parse("2026-10-25T10:00:00Z");
  const filename = join(path, "live.sqlite");
  let connection = new DatabaseSync(filename);
  let store = new LiveStore(connection, { now: () => clock });
  return { get store() { return store; }, advance(ms: number) { clock += ms; }, now: () => clock,
    reopen() { connection.close(); connection = new DatabaseSync(filename); store = new LiveStore(connection, { now: () => clock }); },
    close() { connection.close(); rmSync(path, { recursive: true, force: true }); } };
}
const input = (news = "news-1", company = "company-1", revision = "revision-1", role = "owner") => ({ company_id: company, news_id: news, revision, audience_role: role, payload: { event: { news_id: news, text: "Verified source text" } } });
const result = (job: LiveJob, suffix = ""): JobResult => ({ response: envelope(job.kind === "analysis"
  ? { id: "analysis-" + job.id + suffix, company_id: job.company_id, news_id: job.news_id, sources: [{ id: job.news_id, excerpt: "Verified source text", url: "https://example.org/article" }] }
  : { analysis_id: job.analysis_id, company_id: job.company_id, answer: "Verified answer", source_ids: [job.news_id] }, "request", "live"), context: { input: job.payload, sources: [{ id: job.news_id }] } });
function publish(store: LiveStore, news = "news-1", company = "company-1", revision = "revision-1", role = "owner") {
  const queued = store.enqueueAnalysis(input(news, company, revision, role));
  const job = store.claim("fixture", 1000)!;
  assert.equal(job.id, queued.id);
  const completed = result(job);
  assert.equal(store.complete(job, completed), true);
  return store.getAnalysis(completed.response.data.id, company)!;
}

test("subscriptions, queued jobs, validated cards and context survive a database reopen", () => {
  const f = fixture();
  try {
    f.store.subscribe({ company_id: "company-1", audience_role: "owner", limit: 7, min_score: 0.4 });
    f.store.touchSubscription("company-1", "owner", f.now() + 5000);
    const queued = f.store.enqueueAnalysis(input());
    f.reopen();
    assert.equal(f.store.subscriptions()[0].limit, 7);
    assert.equal(f.store.dueSubscriptions().length, 0);
    const claimed = f.store.claim("restarted")!;
    assert.equal(claimed.id, queued.id);
    const response = result(claimed);
    assert.equal(f.store.complete(claimed, response), true);
    f.reopen();
    const saved = f.store.getAnalysis(response.response.data.id, "company-1")!;
    assert.deepEqual(saved.context, response.context);
    assert.deepEqual(saved.sources, response.response.data.sources);
    assert.equal(f.store.getJob(queued.id, "company-1")!.status, "succeeded");
    assert.equal(f.store.getJob(queued.id, "other"), null);
    assert.equal(f.store.getAnalysis(saved.id, "other"), null);
    assert.equal(f.store.feed("other").items.length, 0);
    assert.equal(f.store.analysisCounts("company-1").published, 1);
    assert.equal(f.store.jobs("company-1")[0].id, queued.id);
    assert.equal(f.store.jobs("other").length, 0);
    assert.deepEqual(f.store.heads("company-1", "owner"), [{ news_id: "news-1", revision: "revision-1" }]);
    assert.equal(f.store.heads("company-1", "accountant").length, 0);
  } finally { f.close(); }
});

test("expired leases recover after crash and fence every stale worker mutation", () => {
  const f = fixture();
  try {
    f.store.enqueueAnalysis(input());
    const old = f.store.claim("worker-a", 100)!;
    assert.equal(f.store.claim("worker-b", 100), null);
    f.advance(101); f.reopen();
    const replacement = f.store.claim("worker-b", 100)!;
    assert.equal(replacement.id, old.id);
    assert.notEqual(replacement.lease_token, old.lease_token);
    assert.equal(f.store.complete(old, result(old)), false);
    assert.equal(f.store.heartbeat(old, 100), false);
    assert.equal(f.store.defer(old, "stale", f.now() + 500), false);
    assert.equal(f.store.fail(old, "stale"), false);
    assert.equal(f.store.complete(replacement, result(replacement)), true);
    assert.equal(f.store.complete(replacement, result(replacement)), false);
    assert.equal(f.store.feed("company-1").items.length, 1);
  } finally { f.close(); }
});

test("idempotent enqueue cannot resurrect an old revision; updates retain an explicitly stale old card", () => {
  const f = fixture();
  try {
    const initial = publish(f.store);
    const oldJob = f.store.enqueueAnalysis(input());
    assert.equal(oldJob.status, "succeeded");
    const updated = f.store.enqueueAnalysis(input("news-1", "company-1", "revision-2"));
    assert.equal(f.store.enqueueAnalysis(input("news-1", "company-1", "revision-2")).id, updated.id);
    assert.equal(f.store.getAnalysis(initial.id, "company-1")!.stale, true);
    assert.equal(f.store.feed("company-1").items[0].stale, true);
    f.store.enqueueAnalysis(input());
    assert.equal(f.store.getAnalysis(initial.id, "company-1")!.stale, true);
    const job = f.store.claim("worker")!;
    assert.equal(job.id, updated.id);
    f.store.complete(job, result(job));
    assert.equal(f.store.feed("company-1").items.length, 1);
    assert.equal(f.store.feed("company-1").items[0].revision, "revision-2");
    assert.equal(f.store.getAnalysis(initial.id, "company-1")!.stale, true);
    assert.equal(f.store.status().analyses, 2);
    assert.deepEqual(f.store.versions("company-1", "news-1", "owner").map(version => version.revision), ["revision-2", "revision-1"]);
    assert.equal(f.store.versions("other", "news-1", "owner").length, 0);
  } finally { f.close(); }
});

test("a superseding revision aborts old in-flight publication and irrelevant revisions invalidate without new generation", () => {
  const f = fixture();
  try {
    f.store.enqueueAnalysis(input());
    const old = f.store.claim("worker")!;
    f.store.enqueueAnalysis(input("news-1", "company-1", "revision-2"));
    assert.equal(f.store.getJob(old.id)!.status, "superseded");
    assert.equal(f.store.complete(old, result(old)), false);
    const next = f.store.claim("worker")!;
    f.store.complete(next, result(next));
    const saved = f.store.feed("company-1").items[0];
    f.store.invalidate("company-1", "news-1", "owner", "revision-3", "no_longer_relevant");
    assert.equal(f.store.getAnalysis(saved.id, "company-1")!.stale, true);
    assert.equal(f.store.claim("worker"), null);
    assert.throws(() => f.store.enqueueQuestion({ company_id: "company-1", analysis_id: saved.id, question: "Question?", idempotency_key: "q" }), /superseded/);
  } finally { f.close(); }
});

test("questions are idempotent, prioritized, serialized per analysis and preserve full response history", () => {
  const f = fixture();
  try {
    const analysis = publish(f.store);
    const data = { company_id: analysis.company_id, analysis_id: analysis.id, question: "What changed?", idempotency_key: "click-one" };
    const first = f.store.enqueueQuestion(data);
    assert.equal(f.store.enqueueQuestion(data).id, first.id);
    assert.throws(() => f.store.enqueueQuestion({ ...data, question: "A different question" }), /Idempotency key/);
    assert.throws(() => f.store.enqueueQuestion({ ...data, company_id: "other" }), /not found/);
    const second = f.store.enqueueQuestion({ ...data, question: "What can I do?", idempotency_key: "click-two" });
    f.store.enqueueAnalysis(input("news-2"));
    const q1 = f.store.claim("worker-1")!;
    assert.equal(q1.kind, "question");
    assert.equal(q1.id, first.id, "equal timestamps must preserve question insertion order");
    const concurrent = f.store.claim("worker-2")!;
    assert.equal(concurrent.kind, "analysis", "another question on the same analysis must wait for ordered history");
    f.store.complete(q1, result(q1));
    const q2 = f.store.claim("worker-2")!;
    assert.equal(q2.kind, "question");
    assert.notEqual(q2.id, q1.id);
    f.store.complete(q2, result(q2));
    f.reopen();
    const saved = f.store.getAnalysis(analysis.id, analysis.company_id)!;
    assert.equal(saved.history.length, 2);
    assert.equal(saved.history[0].question, "What changed?");
    assert.equal(saved.history[1].question, "What can I do?");
    assert.equal(saved.history[0].response.data.answer, "Verified answer");
    assert.equal(f.store.getJob(second.id)!.status, "succeeded");
  } finally { f.close(); }
});

test("a material revision supersedes outstanding questions as well as analysis jobs", () => {
  const f = fixture();
  try {
    const analysis = publish(f.store);
    f.store.enqueueQuestion({ company_id: analysis.company_id, analysis_id: analysis.id, question: "Question?", idempotency_key: "q" });
    const question = f.store.claim("worker")!;
    f.store.enqueueAnalysis(input("news-1", "company-1", "revision-2"));
    assert.equal(f.store.complete(question, result(question)), false);
    assert.equal(f.store.getJob(question.id)!.status, "superseded");
    assert.equal(f.store.getAnalysis(analysis.id, "company-1")!.history.length, 0);
  } finally { f.close(); }
});

test("feed keysets exclude newly published items across pages and favorites are scoped and survive revisions", () => {
  const f = fixture();
  try {
    const first = publish(f.store, "news-1");
    publish(f.store, "news-2"); publish(f.store, "news-3");
    publish(f.store, "other-news", "company-2"); publish(f.store, "role-news", "company-1", "revision-1", "accountant");
    const page = f.store.feed("company-1", { audience_role: "owner", limit: 1 });
    assert.equal(page.items[0].news_id, "news-3");
    assert.ok(page.next_cursor);
    publish(f.store, "news-4");
    const rest = f.store.feed("company-1", { audience_role: "owner", cursor: page.next_cursor!, limit: 10 });
    assert.deepEqual(rest.items.map(i => i.news_id), ["news-2", "news-1"]);
    assert.throws(() => f.store.feed("company-2", { audience_role: "owner", cursor: page.next_cursor! }), /cursor/);
    assert.throws(() => f.store.feed("company-1", { audience_role: "accountant", cursor: page.next_cursor! }), /cursor/);
    assert.equal(f.store.favorite("company-2", first.id, true), false);
    assert.equal(f.store.favorite("company-1", first.id, true), true);
    assert.deepEqual(f.store.feed("company-1", { favorites: true }).items.map(i => i.news_id), ["news-1"]);
    const revised = publish(f.store, "news-1", "company-1", "revision-2");
    assert.equal(revised.favorite, true);
    assert.equal(f.store.feed("company-1", { favorites: true }).items[0].id, revised.id);
    assert.equal(f.store.favorite("company-1", revised.id, false), true);
    assert.equal(f.store.feed("company-1", { favorites: true }).items.length, 0);
  } finally { f.close(); }
});

test("publication rejects wrong company, wrong news and mocked generation without saving a card", () => {
  const f = fixture();
  try {
    f.store.enqueueAnalysis(input());
    const job = f.store.claim("worker")!;
    const wrongCompany = result(job); wrongCompany.response.data.company_id = "other";
    assert.throws(() => f.store.complete(job, wrongCompany), /company mismatch/);
    const wrongNews = result(job); wrongNews.response.data.news_id = "other";
    assert.throws(() => f.store.complete(job, wrongNews), /news mismatch/);
    const mocked = result(job); mocked.response.meta.mode = "mock";
    assert.throws(() => f.store.complete(job, mocked), /mock/);
    assert.equal(f.store.status().analyses, 0);
    assert.equal(f.store.getJob(job.id)!.status, "running");
    assert.equal(f.store.complete(job, result(job)), true);
  } finally { f.close(); }
});

test("deferred generation retains its attempt budget and resumes after a restart", async () => {
  const f = fixture();
  try {
    const queued = f.store.enqueueAnalysis({ ...input(), max_attempts: 1 });
    const worker = new LiveWorker(f.store, async () => { throw new DeferredJobError("daily_budget_exhausted", f.now() + 1000); });
    await worker.tick();
    assert.equal(f.store.getJob(queued.id)!.status, "deferred");
    assert.equal(f.store.getJob(queued.id)!.attempts, 0);
    assert.equal(f.store.claim("other"), null);
    f.advance(1001); f.reopen();
    const resumed = new LiveWorker(f.store, async job => result(job));
    await resumed.tick();
    assert.equal(f.store.getJob(queued.id)!.status, "succeeded");
  } finally { f.close(); }
});

test("transient failures retry with backoff while permanent and exhausted jobs stop", async () => {
  const f = fixture();
  try {
    const job = f.store.enqueueAnalysis({ ...input(), max_attempts: 2 });
    const worker = new LiveWorker(f.store, async () => { throw new Error("upstream_timeout"); });
    await worker.tick();
    assert.equal(f.store.getJob(job.id)!.status, "queued");
    assert.equal(f.store.claim("other"), null);
    f.advance(1001); await worker.tick();
    assert.equal(f.store.getJob(job.id)!.status, "failed");
    const second = f.store.enqueueAnalysis(input("news-2"));
    const permanent = new LiveWorker(f.store, async () => { throw new PermanentJobError("invalid_result"); });
    await permanent.tick();
    assert.equal(f.store.getJob(second.id)!.status, "failed");
    assert.equal(f.store.getJob(second.id)!.attempts, 1);
  } finally { f.close(); }
});

test("worker bounds parallelism and disabled polling never runs generation", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) f.store.enqueueAnalysis(input("news-" + i));
    let calls = 0, active = 0, peak = 0;
    const worker = new LiveWorker(f.store, async job => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return result(job); }, { concurrency: 2 });
    const disabled = new LiveWorker(f.store, async job => { calls++; return result(job); }, { enabled: () => false });
    await disabled.tick();
    assert.equal(calls, 0);
    // Read-only APIs must not enqueue, claim or regenerate.
    f.store.feed("company-1"); f.store.status(); f.store.subscriptions();
    assert.equal(calls, 0);
    await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
    assert.equal(peak, 2); assert.equal(calls, 2);
    await worker.tick(); await worker.tick();
    assert.equal(calls, 5);
    assert.equal(f.store.status().jobs.succeeded, 5);
    await worker.stop();
  } finally { f.close(); }
});

test("two workers cannot claim the same job and heartbeat extends a long-running lease", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new LiveStore(db);
  try {
    store.enqueueAnalysis(input());
    let calls = 0;
    const handler = async (job: LiveJob) => { calls++; await new Promise(resolve => setTimeout(resolve, 180)); return result(job); };
    const first = new LiveWorker(store, handler, { leaseMs: 90 });
    const second = new LiveWorker(store, handler, { leaseMs: 90 });
    const running = first.tick();
    await new Promise(resolve => setTimeout(resolve, 120));
    await second.tick(); await running;
    assert.equal(calls, 1);
    assert.equal(store.status().jobs.succeeded, 1);
    await first.stop(); await second.stop();
  } finally { db.close(); }
});

test("worker stop aborts the handler and leaves recoverable work without publishing", async () => {
  const f = fixture();
  try {
    const queued = f.store.enqueueAnalysis(input());
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const worker = new LiveWorker(f.store, async (_job, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      throw new Error("unreachable");
    });
    const running = worker.tick(); await started; await worker.stop(); await running;
    assert.equal(f.store.getJob(queued.id)!.status, "queued");
    assert.equal(f.store.status().analyses, 0);
    f.advance(1001);
    await new LiveWorker(f.store, async job => result(job)).tick();
    assert.equal(f.store.getJob(queued.id)!.status, "succeeded");
  } finally { f.close(); }
});


test("queued question retries retain conversation order instead of answering a later question first", () => {
  const f = fixture();
  try {
    const analysis = publish(f.store);
    const scope = { company_id: analysis.company_id, analysis_id: analysis.id };
    const first = f.store.enqueueQuestion({ ...scope, question: "First?", idempotency_key: "first" });
    const second = f.store.enqueueQuestion({ ...scope, question: "Second?", idempotency_key: "second" });
    const claimed = f.store.claim("worker")!;
    assert.equal(claimed.id, first.id);
    f.store.defer(claimed, "budget", f.now() + 1000);
    assert.equal(f.store.claim("worker"), null);
    f.advance(1001);
    const resumed = f.store.claim("worker")!;
    assert.equal(resumed.id, first.id);
    f.store.complete(resumed, result(resumed));
    assert.equal(f.store.claim("worker")!.id, second.id);
  } finally { f.close(); }
});


test("a corrected article returning from A to B to A reuses the matching saved card without generation", () => {
  const f = fixture();
  try {
    const original = publish(f.store, "news-1", "company-1", "A");
    const changed = publish(f.store, "news-1", "company-1", "B");
    assert.equal(f.store.feed("company-1").items[0].id, changed.id);
    f.store.invalidate("company-1", "news-1", "owner", "A");
    const reused = f.store.enqueueAnalysis(input("news-1", "company-1", "A"));
    assert.equal(reused.status, "succeeded");
    assert.equal(f.store.claim("worker"), null);
    assert.equal(f.store.feed("company-1").items[0].id, original.id);
    assert.equal(f.store.feed("company-1").items[0].stale, false);
    assert.equal(f.store.status().analyses, 2);
  } finally { f.close(); }
});

test("head changes during pagination cannot repeat another version of the same article on later pages", () => {
  const f = fixture();
  try {
    publish(f.store, "news-1", "company-1", "A");
    publish(f.store, "news-2");
    const changed = publish(f.store, "news-1", "company-1", "B");
    const page = f.store.feed("company-1", { limit: 1 });
    assert.equal(page.items[0].id, changed.id);
    f.store.invalidate("company-1", "news-1", "owner", "A");
    const rest = f.store.feed("company-1", { limit: 20, cursor: page.next_cursor! });
    assert.deepEqual(rest.items.map(item => item.news_id), ["news-2"]);
  } finally { f.close(); }
});

test("an explicit return to a previously canceled revision resumes that task while fencing the old attempt", () => {
  const f = fixture();
  try {
    const original = f.store.enqueueAnalysis(input("news-1", "company-1", "A"));
    const oldAttempt = f.store.claim("old-worker")!;
    f.store.enqueueAnalysis(input("news-1", "company-1", "B"));
    f.store.invalidate("company-1", "news-1", "owner", "A");
    const resumed = f.store.enqueueAnalysis(input("news-1", "company-1", "A"));
    assert.equal(resumed.id, original.id);
    assert.equal(resumed.status, "queued");
    const current = f.store.claim("new-worker")!;
    assert.equal(current.id, original.id);
    assert.equal(f.store.complete(oldAttempt, result(oldAttempt)), false);
    assert.equal(f.store.complete(current, result(current)), true);
  } finally { f.close(); }
});

test("important news replaces only the lowest unstarted analysis reservation, preserving protected work and history", () => {
  const f = fixture();
  try {
    const saved = publish(f.store);
    f.store.enqueueQuestion({ company_id: "company-1", analysis_id: saved.id, question: "Existing question?", idempotency_key: "existing" });
    const answered = f.store.claim("fixture")!;
    assert.equal(f.store.complete(answered, result(answered)), true);
    const deferred = f.store.enqueueAnalysis({ ...input("deferred"), priority: 0.1 });
    const deferredAttempt = f.store.claim("fixture")!;
    assert.equal(f.store.defer(deferredAttempt, "generation_disabled", f.now() + 60_000), true);
    const retry = f.store.enqueueAnalysis({ ...input("already-tried"), priority: -50 });
    assert.equal(f.store.fail(f.store.claim("fixture")!, "temporary", { retryAt: f.now() + 60_000 }), true);
    const running = f.store.enqueueAnalysis({ ...input("running"), priority: -20 });
    assert.equal(f.store.claim("active-worker")!.id, running.id);
    const question = f.store.enqueueQuestion({ company_id: "company-1", analysis_id: saved.id, question: "Pending question?", idempotency_key: "pending" });
    const protectedCorrection = f.store.enqueueAnalysis({ ...input("correction"), payload: { reanalysis: true }, priority: -10 });
    const protectedImportant = f.store.enqueueAnalysis({ ...input("already-important"), priority: 10 });
    const otherCompany = f.store.enqueueAnalysis({ ...input("other", "company-2"), priority: -100 });
    const higher = f.store.enqueueAnalysis({ ...input("higher"), priority: 0.5 });
    const headsBefore = f.store.heads("company-1", "owner");
    const versionsBefore = f.store.versions("company-1", "news-1", "owner");
    const replaced = f.store.supersedeLowerPriorityPending("company-1", 20)!;
    assert.equal(replaced.id, deferred.id);
    assert.equal(replaced.status, "superseded");
    assert.equal(replaced.error, "selection_priority_replaced");
    assert.equal(replaced.attempts, 0);
    assert.equal(f.store.getJob(running.id)!.status, "running");
    assert.equal(f.store.getJob(retry.id)!.status, "queued");
    for (const job of [question, protectedCorrection, protectedImportant, otherCompany, higher]) assert.equal(f.store.getJob(job.id)!.status, "queued");
    assert.deepEqual(f.store.heads("company-1", "owner"), headsBefore);
    assert.deepEqual(f.store.versions("company-1", "news-1", "owner"), versionsBefore);
    assert.equal(f.store.getAnalysis(saved.id, "company-1")!.history.length, 1);
    assert.equal(f.store.getJob(answered.id)!.status, "succeeded");
  } finally { f.close(); }
});

test("equal or lower priority cannot replace pending work and protected priorities cannot be preempted", () => {
  const f = fixture();
  try {
    const ordinary = f.store.enqueueAnalysis({ ...input(), priority: 0.7 });
    assert.equal(f.store.supersedeLowerPriorityPending("company-1", 0.7), null);
    assert.equal(f.store.supersedeLowerPriorityPending("company-1", 0.6), null);
    assert.equal(f.store.supersedeLowerPriorityPending("company-2", 20), null);
    assert.equal(f.store.getJob(ordinary.id)!.status, "queued");
    assert.throws(() => f.store.supersedeLowerPriorityPending("company-1", Number.NaN), /Invalid priority/);
    assert.equal(f.store.supersedeLowerPriorityPending("company-1", 0.8)!.id, ordinary.id);
    const protectedJob = f.store.enqueueAnalysis({ ...input("protected"), priority: 10 });
    assert.equal(f.store.supersedeLowerPriorityPending("company-1", 20), null);
    assert.equal(f.store.getJob(protectedJob.id)!.status, "queued");
  } finally { f.close(); }
});

test("a preempted revision resumes with its new priority and the same idempotent job", () => {
  const f = fixture();
  try {
    const original = f.store.enqueueAnalysis({ ...input(), priority: 0.3 });
    assert.equal(f.store.supersedeLowerPriorityPending("company-1", 0.8)!.id, original.id);
    const revived = f.store.enqueueAnalysis({ ...input(), payload: { refreshed: true }, priority: 10.8 });
    assert.equal(revived.id, original.id);
    assert.equal(revived.priority, 10.8);
    assert.equal(revived.status, "queued");
    assert.equal(revived.error, null);
    assert.equal(revived.attempts, 0);
    assert.deepEqual(revived.payload, { refreshed: true });
    assert.equal(f.store.supersedeLowerPriorityPending("company-1", 20), null);
    assert.equal(f.store.claim("worker")!.id, original.id);
    assert.equal(f.store.claim("second-worker"), null);
  } finally { f.close(); }
});
