import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadSettings, type Settings } from "../../config.js";
import type { Json } from "../../types.js";
import { ApiFault, envelope, validate } from "../contracts.js";
import { LiveStore } from "../live-store.js";
import { LiveService, analysisRevision, profileRevision, moscowDayStart } from "../live-service.js";
import { createAnalysisEngine } from "../analysis-engine.js";
import { prepareContext } from "../context.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import type { ContractClient } from "../client.js";

// Controlled fixtures exercise the real orchestration and validation boundary.
// No HTTP collector or external/paid language model is called in these tests.
function event(id = "event-one", revision = "r1"): Json {
  const result = structuredClone(evaluationCases()[0].input.event);
  Object.assign(result, { news_id: id, event_id: id, title: "Компания увеличила производство стали и запустила новый цех",
    text: "Компания увеличила производство стали и запустила новый цех. Предприятие подтвердило начало поставок продукции покупателям; изменение производственных мощностей опубликовано в сообщении компании.",
    event_type: "other", published_at: "2026-10-24T12:00:00Z", event_at: null, fact_status: "confirmed",
    is_mock: false, company_ids: ["U_A"], entity_mapping_source: "controlled-fixture-mapping",
    content: { scope: "article_full", material_revision: revision, version_id: revision, warnings: [] } });
  delete result.event_details;
  result.sources = [{ ...result.sources[0], id: "news:" + id, title: result.title, url: "https://publisher.example/" + id,
    excerpt: result.text, published_at: result.published_at, is_mock: false }];
  return result;
}
function fixture(settingsExtra: Partial<Settings> = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "alfa-live-service-")), path = resolve(directory, "live.sqlite3");
  let db = new DatabaseSync(path);
  const state = { now: Date.parse("2026-10-25T12:00:00Z"), events: [event()], generations: 0, answers: 0, searches: 0,
    rankable: true, responseMode: "live", invalid: false, duringGeneration: null as (() => void) | null,
    failure: null as ApiFault | null, paged: false, hiddenFromWindow: new Set<string>(), searchBodies: [] as Json[], scores: {} as Record<string, number> };
  const profile = structuredClone(evaluationCases()[0].input.profile);
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "", NEWS_SEED_MODE: "none" }),
    analysisEnabled: false, liveCompanyNewsLimit: 2, liveWorkerConcurrency: 2, ...settingsExtra };
  const ranked = (e: Json) => ({ news_id: e.news_id, event_id: e.event_id, score: state.rankable ? state.scores[e.news_id] ?? 0.8 : 0.01,
    score_kind: "logistic_relevance_uncalibrated", reasons: [{ code: "fixture", text: "Verified mapping in controlled test", profile_paths: ["/company_id"] }], warnings: [],
    feature_contributions: [{ feature: "direct_company_match", value: state.rankable ? 1 : 0, coefficient: 1, contribution: state.rankable ? 1 : 0,
      scale: "logit", profile_paths: ["/company_id"], source_ids: [e.sources[0].id] }] });
  const ml = { call: async (url: string, responseSchema: string, id: string, body?: Json) => {
    let result;
    if (url.startsWith("/v1/companies/")) result = envelope({ ...structuredClone(profile), company_id: decodeURIComponent(url.split("/").at(-1)!) }, id, "live");
    else {
      assert.equal(url, "/v1/rank"); validate("RankRequest", body, true);
      result = envelope({ company_id: body!.company_id, as_of: body!.as_of, items: body!.events.map(ranked), excluded_future_news_ids: [], truncated: false }, id, "live");
    }
    validate(responseSchema, result, true); return result;
  } } as ContractClient;
  const retrieval = {
    search: async (body: Json, id: string) => {
      validate("SearchRequest", body, true); state.searchBodies.push(structuredClone(body)); state.searches++;
      const matches = state.events.filter(e => body.news_id ? e.news_id === body.news_id : !state.hiddenFromWindow.has(e.news_id)
        && (!body.since || Date.parse(e.published_at) >= Date.parse(body.since)));
      const offset = body.offset ?? 0, limit = state.paged && !body.news_id ? 1 : body.limit;
      const items = matches.slice(offset, offset + limit);
      const result = envelope({ items, total_candidates: matches.length, next_offset: offset + items.length < matches.length ? offset + items.length : null }, id, "live");
      validate("SearchDataResponse", result, true); return result;
    },
    rag: async (body: Json, id: string) => { validate("RagRequest", body, true); return envelope({ items: [], limitations: [] }, id, "live"); },
    resolve: async (_body: Json, id: string) => envelope({ items: [], unknown_ids: [] }, id, "live"),
  };
  const agent = {
    analyze: async (input: Json, id: string) => {
      state.generations++;
      if (state.failure) throw state.failure;
      const context = prepareContext(input), draft = referenceDraft({ id: "controlled", input, expectations: [] });
      if (state.invalid) draft.claims[0].quote = "Invented source quote";
      const response = envelope({ ...draft, id: randomUUID(), company_id: input.company_id, news_id: input.event.news_id,
        created_at: new Date(state.now).toISOString(), sources: context.sources, mode: state.responseMode,
        trace: [{ step: "prepared_context", detail: "sha256=" + context.sha256 }] }, id, state.responseMode as "live" | "mock");
      state.duringGeneration?.(); return response;
    },
    answer: async (input: Json, id: string) => {
      state.answers++;
      const draft = referenceDraft({ id: "controlled", input: input.prepared_input, expectations: [] });
      return envelope({ analysis_id: input.analysis.id, company_id: input.company_id,
        answer: draft.summary + " " + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1],
        limitations: draft.limitations, missing_data: draft.missing_data,
        source_ids: [...new Set(draft.claims.flatMap((c: Json) => c.source_ids))] }, id, "live");
    },
  };
  const engine = createAnalysisEngine({ ml, retrieval, agent });
  let store = new LiveStore(db, { now: () => state.now });
  let service = new LiveService({ settings, store, ml, retrieval, engine, now: () => state.now });
  return { state, settings, profile, path, get db() { return db; }, get store() { return store; }, get service() { return service; },
    subscribe(role = "cfo", limit = settings.liveCompanyNewsLimit!) { return store.subscribe({ company_id: "U_A", audience_role: role, limit, min_score: 0.2 }); },
    async reopen() { await service.stop(); db.close(); db = new DatabaseSync(path); store = new LiveStore(db, { now: () => state.now });
      service = new LiveService({ settings, store, ml, retrieval, engine, now: () => state.now }); },
    async close() { await service.stop(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("no-key discovery validates SearchRequest pagination, queues work, and defers without consuming attempts across restart", async () => {
  const f = fixture();
  try {
    f.state.events.push(event("event-two")); f.state.paged = true;
    const sub = f.subscribe();
    const result = await f.service.discover(sub);
    assert.equal(result.queued, 2); assert.equal(f.state.generations, 0);
    const pages = f.state.searchBodies.filter(body => body.news_id === null);
    assert.deepEqual(pages.map(body => body.offset), [0, 1]);
    await f.service.worker.tick();
    for (const job of f.store.jobs("U_A")) { assert.equal(job.status, "deferred"); assert.equal(job.attempts, 0); assert.equal(job.error, "generation_disabled_no_key"); }
    await f.reopen(); f.state.now += 61_000;
    await f.service.worker.tick();
    assert.equal(f.state.generations, 0); assert.equal(f.store.jobs("U_A").length, 2);
    assert.ok(f.store.jobs("U_A").every(job => job.attempts === 0 && job.status === "deferred"));
  } finally { await f.close(); }
});

test("repeated scans are idempotent and daily company quota includes pending work across roles", async () => {
  const f = fixture({ liveCompanyNewsLimit: 1 });
  try {
    f.state.events.push(event("event-two"));
    const cfo = f.subscribe(), ceo = f.subscribe("ceo");
    assert.equal((await f.service.discover(cfo)).queued, 1);
    assert.equal((await f.service.discover(cfo)).queued, 0);
    assert.equal((await f.service.discover(ceo)).queued, 0);
    assert.equal(f.store.jobs("U_A").length, 1);
    await f.service.worker.tick();
    f.state.now += 86_400_000;
    assert.equal((await f.service.discover(cfo)).queued, 0, "yesterday's unfinished work still reserves a slot");
    assert.equal(f.state.generations, 0);
  } finally { await f.close(); }
});

function officialRateEvent(): Json {
  const result = event("official-rate");
  result.title = "Банк России принял решение сохранить ключевую ставку на уровне 14,00% годовых";
  result.text = "23 октября 2026 года Совет директоров Банка России принял решение сохранить ключевую ставку на уровне 14,00% годовых. Решение вступает в силу 26 октября 2026 года. Следующее заседание состоится в декабре.";
  Object.assign(result.sources[0], {title:result.title,excerpt:result.text,url:"https://www.cbr.ru/press/PR/?file=23102026_133000key.htm"});
  return result;
}

test("an official nationwide event replaces unstarted lower-priority work without changing its ML score or exceeding the company quota", async () => {
  const f = fixture({liveCompanyNewsLimit:1});
  try {
    const sub=f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    const original=f.store.jobs("U_A")[0];
    f.state.events.push(officialRateEvent()); f.state.scores["official-rate"]=0.08;
    const result=await f.service.discover(sub);
    assert.equal(result.reprioritized,1); assert.equal(result.queued,1);
    assert.equal(f.store.getJob(original.id)!.error,"selection_priority_replaced");
    assert.equal(f.store.analysisCounts("U_A").pending,1);
    const rate=f.store.jobs("U_A").find(job=>job.news_id==="official-rate")!;
    assert.ok(rate.priority>2); assert.equal(rate.payload.selection.score,0.08);
    assert.equal(rate.payload.selection.reason,"official_key_rate_context_for_all_companies");
    assert.equal((await f.service.discover(sub)).queued,0,"equal candidates cannot oscillate");
    assert.equal(f.state.generations,0);
    f.state.events=f.state.events.filter(e=>e.news_id!=="official-rate");
    assert.equal((await f.service.discover(sub)).queued,1,"deprioritized job can resume when a slot becomes available");
    assert.equal(f.store.getJob(original.id)!.status,"queued");
    assert.equal(f.store.getJob(original.id)!.payload.reanalysis,false);
  } finally {await f.close();}
});

test("a completed or running analysis cannot be displaced to evade the daily cap", async () => {
  for (const completed of [false,true]) {
    const f=fixture({liveCompanyNewsLimit:1,analysisEnabled:completed});
    try {
      const sub=f.subscribe(); await f.service.discover(sub);
      if (completed) await f.service.worker.tick(); else assert.ok(f.store.claim("controlled-running",60000));
      f.state.events.push(officialRateEvent()); f.state.scores["official-rate"]=0.08;
      const result=await f.service.discover(sub);
      assert.equal(result.queued,0); assert.equal(result.reprioritized,0);
      assert.equal(result.items.find((row:Json)=>row.news_id==="official-rate").reason,"company_daily_limit");
      assert.equal(f.store.analysisCounts("U_A",moscowDayStart(f.state.now)).reserved,1);
    } finally {await f.close();}
  }
});

test("validated cards survive restart and repeated feed/detail/favorite reads never generate", async () => {
  const f = fixture({ analysisEnabled: true, liveCompanyNewsLimit: 1 });
  try {
    const sub = f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    assert.equal(f.state.generations, 1);
    const saved = f.store.feed("U_A").items[0]; assert.ok(saved); assert.equal(saved.stale, false);
    assert.equal(f.store.favorite("U_A", saved.id, true), true);
    await f.reopen();
    for (let i = 0; i < 3; i++) {
      assert.equal(f.store.feed("U_A", { favorites: true }).items[0].id, saved.id);
      assert.equal(f.store.getAnalysis(saved.id, "U_A")!.context!.sha256, saved.context!.sha256);
    }
    await f.service.discover(f.store.subscriptions()[0]); await f.service.worker.tick();
    assert.equal(f.state.generations, 1);
    assert.equal(f.store.feed("U_OTHER").items.length, 0); assert.equal(f.store.getAnalysis(saved.id, "U_OTHER"), null);
    f.state.events.push(event("event-two"));
    const capped = await f.service.discover(f.store.subscriptions()[0]);
    assert.equal(capped.queued, 0); assert.equal(capped.filters.company_daily_limit, 1);
    f.state.now += 86_400_000;
    assert.equal((await f.service.discover(f.store.subscriptions()[0])).queued, 1);
  } finally { await f.close(); }
});

test("material corrections queue a new version despite daily cap and irrelevant corrections stale old cards", async () => {
  const f = fixture({ analysisEnabled: true, liveCompanyNewsLimit: 1 });
  try {
    const sub = f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    const original = f.store.feed("U_A").items[0];
    f.state.events[0] = event("event-one", "r2");
    const corrected = await f.service.discover(sub);
    assert.equal(corrected.filters.material_revision_queued, 1); assert.equal(f.store.getAnalysis(original.id, "U_A")!.stale, true);
    await f.service.worker.tick();
    assert.equal(f.store.versions("U_A", "event-one", "cfo").length, 2);
    assert.equal(f.store.feed("U_A").items[0].stale, false);
    f.state.events[0] = event("event-one", "r3"); f.state.rankable = false;
    const filtered = await f.service.discover(sub);
    assert.equal(filtered.queued, 0); assert.equal(filtered.filtered, 1);
    assert.equal(f.store.feed("U_A").items[0].stale, true);
    assert.equal(f.state.generations, 2);
  } finally { await f.close(); }
});

test("an old head outside the candidate window is rechecked and invalidated when corrected or removed", async () => {
  const f = fixture({ analysisEnabled: true });
  try {
    const sub = f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    const card = f.store.feed("U_A").items[0];
    f.state.hiddenFromWindow.add("event-one"); f.state.events[0] = event("event-one", "r2"); f.state.rankable = false;
    const revised = await f.service.discover(sub);
    assert.equal(revised.considered, 1); assert.equal(revised.filtered, 1);
    assert.ok(f.state.searchBodies.some(body => body.news_id === "event-one"));
    assert.equal(f.store.getAnalysis(card.id, "U_A")!.stale, true);
    f.state.events = []; await f.service.discover(sub);
    assert.equal(f.store.heads("U_A", "cfo")[0].revision, "unavailable");
    assert.equal(f.state.generations, 1);
  } finally { await f.close(); }
});

for (const kind of ["invalid", "mock"] as const) test(kind + " generation never publishes a live card", async () => {
  const f = fixture({ analysisEnabled: true });
  try {
    f.state.invalid = kind === "invalid"; f.state.responseMode = kind === "mock" ? "mock" : "live";
    await f.service.discover(f.subscribe()); await f.service.worker.tick();
    assert.equal(f.state.generations, 1); assert.equal(f.store.feed("U_A").items.length, 0);
    assert.equal(f.store.jobs("U_A")[0].status, "failed");
  } finally { await f.close(); }
});

test("budget exhaustion defers to Moscow reset while new collection/discovery and status remain available", async () => {
  const f = fixture({ analysisEnabled: true });
  try {
    f.state.failure = new ApiFault(429, "MODEL_LIMIT", "controlled quota exhaustion");
    const sub = f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    const first = f.store.jobs("U_A")[0];
    assert.equal(first.status, "deferred"); assert.equal(first.next_attempt, moscowDayStart(f.state.now) + 86_400_000);
    assert.equal(first.attempts, 0);
    f.state.events.push(event("event-two")); assert.equal((await f.service.discover(sub)).queued, 1);
    const status = await f.service.status("U_A"); assert.equal(status.queue.jobs.deferred, 1); assert.equal(status.queue.jobs.queued, 1);
    assert.equal(f.state.generations, 1); assert.ok(f.state.searches > 1);
  } finally { await f.close(); }
});

test("worker rechecks relevance before spending and source revision before publication", async () => {
  const f = fixture({ analysisEnabled: true });
  try {
    const sub = f.subscribe(); await f.service.discover(sub); f.state.rankable = false;
    await f.service.worker.tick(); assert.equal(f.state.generations, 0); assert.equal(f.store.feed("U_A").items.length, 0);
    f.state.rankable = true; f.state.events[0] = event("event-one", "r2");
    await f.service.discover(sub);
    f.state.duringGeneration = () => { f.state.events[0] = event("event-one", "r3"); };
    await f.service.worker.tick();
    assert.equal(f.state.generations, 1); assert.equal(f.store.feed("U_A").items.length, 0);
    assert.ok(f.store.jobs("U_A").every(job => ["failed", "superseded"].includes(job.status)));
  } finally { await f.close(); }
});

test("questions are scoped to saved company, preserve history, and become unavailable after correction", async () => {
  const f = fixture({ analysisEnabled: true });
  try {
    const sub = f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    const analysis = f.store.feed("U_A").items[0];
    assert.throws(() => f.store.enqueueQuestion({ company_id: "U_OTHER", analysis_id: analysis.id, question: "Что проверить?", idempotency_key: "q-other" }), /not found/);
    const question = f.store.enqueueQuestion({ company_id: "U_A", analysis_id: analysis.id, question: "Какие договоры проверить?", idempotency_key: "q1" });
    await f.service.worker.tick();
    assert.equal(f.store.getJob(question.id)!.status, "succeeded"); assert.equal(f.state.answers, 1);
    assert.equal(f.store.getAnalysis(analysis.id, "U_A")!.history.length, 1);
    await f.reopen(); assert.equal(f.store.getAnalysis(analysis.id, "U_A")!.history.length, 1);
    f.state.events[0] = event("event-one", "r2"); await f.service.discover(f.store.subscriptions()[0]);
    assert.throws(() => f.store.enqueueQuestion({ company_id: "U_A", analysis_id: analysis.id, question: "Что изменилось?", idempotency_key: "q2" }), /superseded/);
  } finally { await f.close(); }
});


test("expired primary pending jobs release quota, while historical cards remain valid and fresh corrections retain a window", async () => {
  const pending = fixture({ liveCompanyNewsLimit: 1 });
  try {
    const sub = pending.subscribe(); await pending.service.discover(sub); await pending.service.worker.tick();
    const old = pending.store.jobs("U_A")[0]; pending.state.now += 8 * 86_400_000;
    const fresh = event("fresh-news"); fresh.published_at = fresh.sources[0].published_at = new Date(pending.state.now - 3600000).toISOString();
    pending.state.events.push(fresh);
    const selected = await pending.service.discover(sub);
    assert.equal(selected.expired_pending, 1); assert.equal(selected.queued, 1);
    assert.equal(pending.store.getJob(old.id)!.status, "superseded");
    assert.equal(pending.store.getJob(old.id)!.error, "publication_window_expired");
    assert.equal(pending.store.analysisCounts("U_A").pending, 1);
    assert.equal(pending.state.generations, 0);
  } finally { await pending.close(); }
  const history = fixture({ analysisEnabled: true, liveCompanyNewsLimit: 1 });
  try {
    const sub = history.subscribe(); await history.service.discover(sub); await history.service.worker.tick();
    const card = history.store.feed("U_A").items[0]; history.state.now += 8 * 86_400_000;
    assert.equal((await history.service.discover(sub)).queued, 0);
    assert.equal(history.store.getAnalysis(card.id, "U_A")!.stale, false, "age alone does not invalidate a historical result");
    history.settings.analysisEnabled = false; history.state.events[0] = event("event-one", "corrected-old");
    assert.equal((await history.service.discover(sub)).queued, 1);
    await history.service.worker.tick(); history.state.now += 61_000;
    assert.equal((await history.service.discover(sub)).expired_pending, 0, "fresh correction does not expire with original article date");
    const correction = history.store.jobs("U_A").find(job => job.status === "deferred")!;
    assert.equal(correction.payload.reanalysis, true);
    history.state.now += 8 * 86_400_000;
    assert.equal((await history.service.discover(sub)).expired_pending, 1);
    assert.equal(history.store.getJob(correction.id)!.error, "publication_window_expired");
  } finally { await history.close(); }
});

test("worker refuses an expired first analysis even before the next discovery pass", async () => {
  const f = fixture({ analysisEnabled: true });
  try {
    await f.service.discover(f.subscribe()); f.state.now += 8 * 86_400_000;
    await f.service.worker.tick();
    assert.equal(f.state.generations, 0); assert.equal(f.store.feed("U_A").items.length, 0);
    assert.equal(f.store.jobs("U_A")[0].error, "publication_window_expired");
    assert.equal(f.store.analysisCounts("U_A").pending, 0);
  } finally { await f.close(); }
});

test("publication-date corrections change analysis revision even if material text hash is unchanged", () => {
  const a = event(), b = structuredClone(a); b.published_at = "2026-10-23T12:00:00Z";
  assert.notEqual(analysisRevision(a, "same-profile"), analysisRevision(b, "same-profile"));
});

test("discovery queues a historical correction after a question worker already advanced the head, despite today's quota", async () => {
  const f = fixture({ analysisEnabled: true, liveCompanyNewsLimit: 1 });
  try {
    const sub = f.subscribe(); await f.service.discover(sub); await f.service.worker.tick();
    const oldCard = f.store.feed("U_A").items[0];
    f.state.now += 8 * 86_400_000;
    const fresh = event("fresh-news"); fresh.published_at = fresh.sources[0].published_at = new Date(f.state.now - 3600000).toISOString();
    f.state.events.push(fresh);
    assert.equal((await f.service.discover(sub)).queued, 1); await f.service.worker.tick();
    assert.equal(f.store.analysisCounts("U_A", moscowDayStart(f.state.now)).reserved, 1);
    const question = f.store.enqueueQuestion({ company_id: "U_A", analysis_id: oldCard.id, question: "Какие договоры проверить?", idempotency_key: "old-correction" });
    f.state.events[0] = event("event-one", "corrected-after-question-queued");
    await f.service.worker.tick();
    assert.equal(f.state.answers, 0); assert.equal(f.store.getJob(question.id)!.status, "superseded");
    const revision = analysisRevision(f.state.events[0], profileRevision(f.profile));
    assert.equal(f.store.heads("U_A", "cfo").find(head => head.news_id === "event-one")!.revision, revision);
    const discovery = await f.service.discover(sub);
    assert.equal(discovery.queued, 1, "head invalidation is not evidence that a new revision was processed");
    assert.equal(discovery.filters.material_revision_queued, 1);
    const correction = f.store.jobs("U_A").find(job => job.kind === "analysis" && job.revision === revision)!;
    assert.equal(correction.payload.reanalysis, true);
    await f.service.worker.tick();
    assert.equal(f.store.versions("U_A", "event-one", "cfo").length, 2);
    assert.equal(f.store.feed("U_A").items.find(card => card.news_id === "event-one")!.stale, false);
  } finally { await f.close(); }
});
