import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../../config.js';
import type { Json } from '../../types.js';
import { envelope } from '../contracts.js';
import { LiveStore } from '../live-store.js';
import { LiveService, profileRevision } from '../live-service.js';
import { createAnalysisEngine } from '../analysis-engine.js';
import { prepareContext } from '../context.js';
import { evaluationCases, referenceDraft } from '../evaluation.js';
import type { ContractClient } from '../client.js';

function fixture() {
  const db = new DatabaseSync(':memory:'), store = new LiveStore(db);
  const profile = structuredClone(evaluationCases()[0].input.profile), item = structuredClone(evaluationCases()[0].input.event);
  Object.assign(item, { news_id: 'news-race', event_id: 'event-race', title: 'Компания увеличила производство и запустила новый цех',
    text: 'Компания увеличила производство стали и запустила новый цех. Предприятие подтвердило начало поставок продукции покупателям и обновило сведения о производственных мощностях.',
    event_type: 'other', published_at: new Date(Date.now() - 3600000).toISOString(), fact_status: 'confirmed', company_ids: [profile.company_id], entity_mapping_source: 'controlled-race-fixture',
    is_mock: false, content: { scope: 'article_full', material_revision: 'A', version_id: 'A', warnings: [] } });
  delete item.event_details;
  item.sources = [{ ...item.sources[0], id: 'news:race', title: item.title, excerpt: item.text, url: 'https://publisher.example/race', published_at: item.published_at, is_mock: false }];
  const state = { profile, event: item, generations: 0, answers: 0, duringGeneration: null as (() => void) | null, duringAnswer: null as (() => void) | null };
  const ml = { call: async (path: string, _schema: string, id: string, body?: Json) => {
    if (path.startsWith('/v1/companies/')) return envelope(structuredClone(state.profile), id, 'live');
    return envelope({ company_id: profile.company_id, as_of: body!.as_of, items: body!.events.map((event: Json) => ({ news_id: event.news_id, event_id: event.event_id, score: 0.8, score_kind: 'manual_feature_baseline', reasons: [{ code: 'direct_company_match', text: 'Controlled company binding', profile_paths: ['/company_id'] }], warnings: [], feature_contributions: [{ feature: 'direct_company_match', value: 1, coefficient: 1, contribution: 1, scale: 'raw_score', profile_paths: ['/company_id'], source_ids: ['news:race'] }] })), excluded_future_news_ids: [], truncated: false }, id, 'live');
  } } as ContractClient;
  const retrieval = { search: async (_body: Json, id: string) => envelope({ items: [structuredClone(state.event)], next_offset: null, total_candidates: 1 }, id, 'live'),
    rag: async (_body: Json, id: string) => envelope({ items: [], limitations: [] }, id, 'live'), resolve: async (_body: Json, id: string) => envelope({ items: [], unknown_ids: [] }, id, 'live') };
  const agent = {
    analyze: async (input: Json, id: string) => {
      state.generations++; const context = prepareContext(input), draft = referenceDraft({ id: 'race', input, expectations: [] });
      const response = envelope({ ...draft, id: randomUUID(), company_id: profile.company_id, news_id: item.news_id, created_at: new Date().toISOString(), mode: 'live', sources: context.sources, trace: [{ step: 'prepared_context', detail: 'sha256=' + context.sha256 }] }, id, 'live');
      state.duringGeneration?.(); return response;
    },
    answer: async (input: Json, id: string) => {
      state.answers++; const draft = referenceDraft({ id: 'race', input: input.prepared_input, expectations: [] });
      const response = envelope({ analysis_id: input.analysis.id, company_id: profile.company_id, answer: draft.summary + ' ' + draft.why_relevant, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data, source_ids: [...new Set(draft.claims.flatMap((claim: Json) => claim.source_ids))] }, id, 'live');
      state.duringAnswer?.(); return response;
    }
  };
  const engine = createAnalysisEngine({ ml, retrieval, agent });
  const settings = { ...loadSettings({ LLM_MODE: 'live', NEWS_SEED_MODE: 'none' }), analysisEnabled: true };
  const service = new LiveService({ settings, store, ml, retrieval, engine });
  const subscription = store.subscribe({ company_id: profile.company_id, audience_role: 'cfo', limit: 5, min_score: 0.2 });
  return { state, store, service, company: profile.company_id,
    async publish() { await service.discover(subscription); await service.worker.tick(); const card = store.feed(profile.company_id).items[0]; assert.ok(card); return card; },
    reviseSource() { state.event.content.material_revision = 'B'; state.event.content.version_id = 'B'; },
    reviseProfile() { state.profile.bank_products.loan = !state.profile.bank_products.loan; },
    async close() { await service.stop(); db.close(); } };
}

test('profile changes during generation prevent publication before the next scanner cycle', async () => {
  const f = fixture();
  try {
    f.state.duringGeneration = () => f.reviseProfile();
    const sub = f.store.subscriptions()[0]; await f.service.discover(sub); await f.service.worker.tick();
    assert.equal(f.state.generations, 1);
    assert.equal(f.store.feed(f.company).items.length, 0, 'a card personalized to an obsolete profile must not publish');
    assert.ok(f.store.jobs(f.company).every(job => job.status !== 'succeeded'));
  } finally { await f.close(); }
});

test('a source correction before a question is noticed even when discovery has not run again', async () => {
  const f = fixture();
  try {
    const card = await f.publish();
    const job = f.store.enqueueQuestion({ company_id: f.company, analysis_id: card.id, question: 'Какие условия уточнить?', idempotency_key: 'before' });
    f.reviseSource(); await f.service.worker.tick();
    assert.equal(f.state.answers, 0, 'no paid question may use a source known to be superseded');
    assert.notEqual(f.store.getJob(job.id)!.status, 'succeeded');
    assert.equal(f.store.getAnalysis(card.id, f.company)!.history.length, 0);
  } finally { await f.close(); }
});

for (const changed of ['source', 'profile'] as const) test(changed + ' changes during a question cannot publish an obsolete answer', async () => {
  const f = fixture();
  try {
    const card = await f.publish();
    const job = f.store.enqueueQuestion({ company_id: f.company, analysis_id: card.id, question: 'Какие условия уточнить?', idempotency_key: changed });
    f.state.duringAnswer = () => changed === 'source' ? f.reviseSource() : f.reviseProfile();
    await f.service.worker.tick();
    assert.equal(f.state.answers, 1);
    assert.notEqual(f.store.getJob(job.id)!.status, 'succeeded');
    assert.equal(f.store.getAnalysis(card.id, f.company)!.history.length, 0);
    assert.equal(f.store.getAnalysis(card.id, f.company)!.stale, true);
  } finally { await f.close(); }
});

test('unchanged context allows one durable question answer without regenerating its card', async () => {
  const f = fixture();
  try {
    const card = await f.publish();
    const job = f.store.enqueueQuestion({ company_id: f.company, analysis_id: card.id, question: 'Какие условия уточнить?', idempotency_key: 'unchanged' });
    await f.service.worker.tick(); await f.service.worker.tick();
    assert.equal(f.state.generations, 1); assert.equal(f.state.answers, 1);
    assert.equal(f.store.getJob(job.id)!.status, 'succeeded');
    assert.equal(f.store.getAnalysis(card.id, f.company)!.history.length, 1);
  } finally { await f.close(); }
});


test('profile semantic revision ignores database rebuild timestamps, global file digests and source row renumbering', () => {
  const profile = structuredClone(evaluationCases()[0].input.profile);
  profile.provenance = { ...profile.provenance, company: { source: 'companies', file: 'companies.csv', records: [10], records_total: 1 },
    sources: { companies: { file: 'companies.csv', sha256: 'old-sha', bytes: 100 } }, snapshot_built_at: '2026-10-24T10:00:00Z' };
  const rebuilt = structuredClone(profile);
  rebuilt.provenance.snapshot_built_at = '2026-10-25T10:00:00Z';
  rebuilt.provenance.sources.companies.sha256 = 'unrelated-company-changed-file-sha';
  rebuilt.provenance.sources.companies.bytes = 123;
  rebuilt.provenance.company.records = [200];
  assert.equal(profileRevision(rebuilt), profileRevision(profile));
});

test('profile semantic revision still changes for a bank product, counterparty concentration or raw company fact', () => {
  const profile = structuredClone(evaluationCases()[0].input.profile);
  const product = structuredClone(profile); product.bank_products.loan = !product.bank_products.loan;
  assert.notEqual(profileRevision(product), profileRevision(profile));
  const payments = structuredClone(profile);
  payments.payment_summary = { ...payments.payment_summary, concentration: { in: { largest_share: 0.2 }, out: { largest_share: 0.8 } } };
  assert.notEqual(profileRevision(payments), profileRevision(profile));
  const raw = structuredClone(profile);
  raw.provenance = { ...raw.provenance, company_raw_fields: { ...raw.provenance?.company_raw_fields, ORGANIZATION_FACT: 'changed substantive datum' } };
  assert.notEqual(profileRevision(raw), profileRevision(profile));
});
