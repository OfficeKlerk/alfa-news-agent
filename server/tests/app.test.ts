
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import { createApplication } from '../app.js';
import { ROOT, ROLES, type Settings } from '../config.js';
import { createComplete, parseJson, type Complete } from '../llm.js';
import { validate, Agent } from '../agent.js';
import { Store } from '../db.js';
import { ingestFeeds } from '../news.js';
import type { Json, Analysis } from '../types.js';

type Runtime = Awaited<ReturnType<typeof createApplication>>;
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'alfa-node-')), data = join(folder, 'data'); mkdirSync(data);
  const files: Record<string, string> = {
    'df_Uid_data_hack.csv': 'SYNTHETIC_U;MAINOKVED_NAME;MAINOKVED_CODE;REGION;REVENUE_COMPANY;CL_PRODUCT_LOA_MARK;FTS_FLAG;GROUP_ID\nU_1;Производство стали;24.10;Москва;100000;1;0;G_1\nU_2;Разработка программ;62.01;Казань;20000;0;1;G_2\n',
    'df_Uid_payment_hack.csv': 'BENEFICIARY;PAYER;PAY_AMT;PAY_CNT\nU_2;U_1;123;2\n',
    'df_Fid_Uid_link_hack.csv': 'SYNTHETIC_F;SYNTHETIC_U\nF_1;U_1\nF_1;U_2\n'
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(data, name + '.gz'), gzipSync(content));
  writeFileSync(join(data, 'research.json'), JSON.stringify([{ id: 'd:p1', document_id: 'd', title: 'Кредит и ставка', page: 1, url: 'https://example.org/bank', text: 'Кредитная ставка может влиять на стоимость финансирования. Данных о конкретном договоре нет.', extraction: 'ocr' }]));
  writeFileSync(join(data, 'demo_news.json'), JSON.stringify([
    { id: 'n1', title: 'Кредитная ставка', text: 'Учебное событие: изменились кредитные ставки. Условия конкретного кредита неизвестны.', tags: ['rates'], published: '2026-10-22' },
    { id: 'n2', title: 'Импорт оборудования', text: 'Учебное событие: изменились сроки импорта оборудования. Применимость зависит от маршрута.', tags: ['trade'], published: '2026-10-22' }
  ]));
  const settings: Settings = { root: ROOT, data, dbPath: join(folder, 'app.sqlite3'), mode: 'demo', baseUrl: 'https://example.org/v1', apiKey: '', model: 'qwen/qwen3.6-35b-a3b', maxCalls: 20, maxOutputTokens: 6000, maxPlanningTokens: 4000, timeout: 1000, host: '127.0.0.1', port: 0, feeds: [] };
  return { folder, settings };
}

describe('Node.js prototype: data, API and agent contracts', { concurrency: false }, () => {
  let folder: string, settings: Settings, runtime: Runtime, server: Server, base: string;
  beforeEach(async () => {
    ({ folder, settings } = fixture());
    runtime = await createApplication(settings, { complete: async () => { throw new Error('Demo must never call a model'); } });
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); base = 'http://127.0.0.1:' + address.port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close(); rmSync(folder, { recursive: true, force: true });
  });
  async function request(path: string, body?: Json, cid = 'U_1') {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Company-ID': cid }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Json };
  }
  async function job(nid = 'n1', cid = 'U_1', force = false) {
    const response = await request('/api/analysis', { news_id: nid, force }, cid); assert.equal(response.status, 202);
    for (let i = 0; i < 100; i++) {
      const current = await request('/api/jobs/' + response.body.job_id, undefined, cid);
      if (['completed','failed'].includes(current.body.status)) return current.body;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Job did not complete');
  }
  async function demo(): Promise<Analysis> { const result = await job(); assert.equal(result.status, 'completed', result.error); return result.result; }
  function candidate(a: Analysis): Json { return Object.fromEntries(['summary','why_relevant','claims','risks','opportunities','actions','limitations'].map(key => [key, structuredClone(a[key])])); }

  it('imports data, profiles, payment directions and related companies', async () => {
    const { body: company } = await request('/api/companies/U_1');
    assert.deepEqual(company.products, ['Кредиты']); assert.equal(company.outgoing.total, 123); assert.deepEqual(company.related_company_ids, ['U_2']);
    assert.equal(runtime.db.company('U_2').incoming.total, 123);
    const bootstrap = await request('/api/bootstrap'); assert.equal(bootstrap.body.stats.companies, 2); assert.equal(bootstrap.body.key_configured, false);
    assert.equal((await request('/api/companies?q=U_1')).body.items[0].id, 'U_1');
    assert.equal((await request('/api/companies?offset=bad')).status, 400);
    assert.equal((await request('/api/research?q=ставка')).body.items.length, 1);
  });
  it('personalizes the feed and filters synthetic news', async () => {
    assert.equal((await request('/api/feed')).body.items[0].id, 'n1');
    assert.equal((await request('/api/feed', undefined, 'U_2')).body.items[0].id, 'n2');
    assert.deepEqual((await request('/api/feed?demo=0')).body.items, []);
    assert.equal((await request('/api/feed', undefined, '')).status, 400);
  });
  it('adds and deduplicates a new event without code changes', async () => {
    const news = { title: 'Новая новость об импорте', text: 'Изменены правила импорта оборудования. Компаниям нужно проверить условия своих контрактов.', url: 'https://example.org/news', published: '2026-10-22T09:00:00Z' };
    const a = await request('/api/news', news), b = await request('/api/news', news);
    assert.equal(a.status, 201); assert.equal(a.body.id, b.body.id); assert.equal(a.body.is_demo, false);
    assert.equal((await request('/api/feed?demo=0')).body.items[0].id, a.body.id);
    const result = await job(a.body.id); assert.equal(result.status, 'completed'); assert.equal(result.result.is_demo_news, false);
    assert.equal((await request('/api/news', { ...news, url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await request('/api/news', { title: 'short', text: 'short' })).status, 400);
  });
  it('completes async demo, validates sources, caches, scopes and answers questions', async () => {
    const analysis = await demo();
    assert.equal(analysis.mode, 'demo'); assert.equal(analysis.is_demo_news, true);
    assert.deepEqual(validate(analysis, Object.fromEntries(analysis.sources.map(s => [s.id, s]))), []);
    assert.equal((await job()).result.cached, true); assert.equal((await job('n1','U_1',true)).result.cached, false);
    assert.equal((await request('/api/analyses/' + analysis.id)).status, 200);
    const answer = await request('/api/analyses/' + analysis.id + '/questions', { question: 'Что проверить в договоре?' });
    assert.match(answer.body.answer, /без LLM/); assert.equal(runtime.db.get('SELECT count(*) n FROM chats')!.n, 1);
    assert.equal((await request('/api/analyses/' + analysis.id, undefined, 'U_2')).status, 404);
    assert.equal((await request('/api/analyses/' + analysis.id + '/questions', { question: 'Что проверить?' }, 'U_2')).status, 404);
    const queued = await request('/api/analysis', { news_id: 'n1' }); await runtime.queue.idle();
    assert.equal((await request('/api/jobs/' + queued.body.job_id, undefined, 'U_2')).status, 404);
  });
  it('rejects fake bank quotes, malformed claims and fabricated source ids', async () => {
    const analysis = await demo(), sources = Object.fromEntries(analysis.sources.map(s => [s.id, s]));
    const invalid = candidate(analysis); invalid.claims.push({ kind: 'bank', text: 'Банк гарантирует прибыль компании', quote: 'Банк гарантирует прибыль компании', source_ids: ['research:fake'] });
    assert.ok(validate(invalid, sources).length);
    invalid.claims = [null, { kind: 'bank', text: null, quote: 'Банк гарантирует прибыль компании', source_ids: Object.keys(sources) }]; assert.ok(validate(invalid, sources).length);
    const doc = analysis.sources.find(s => s.kind === 'bank')!;
    const valid = candidate(analysis); valid.claims.push({ kind: 'bank', text: doc.text, quote: doc.text, source_ids: [doc.id] }); assert.deepEqual(validate(valid, sources), []);
  });
  it('performs live tools and one repair with sanitized protocol messages', async () => {
    const valid = candidate(await demo()), invalid = structuredClone(valid); invalid.claims[0].source_ids = ['invented'];
    settings.mode = 'live'; settings.apiKey = 'test';
    const responses = [
      { role: 'assistant', content: null, reasoning_content: 'provider-private', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'search_research', arguments: '{"query":"кредит ставка"}' } }] },
      { role: 'assistant', content: 'Контекст собран' }, { role: 'assistant', content: JSON.stringify(invalid) }, { role: 'assistant', content: JSON.stringify(valid) }
    ];
    const seen: Json[][] = [];
    const complete: Complete = async messages => { seen.push(structuredClone(messages)); assert.ok(responses.length); return responses.shift()!; };
    const agent = new Agent(settings, runtime.db, runtime.retrieval, complete);
    const result = await agent.analyze('U_1','n1',ROLES[0],true);
    assert.equal(result.mode,'live'); assert.ok(result.trace.some(t => t.step === 'repair')); assert.ok(result.trace.some(t => t.step === 'search_research'));
    assert.ok(seen[1].some(m => m.role === 'tool' && m.tool_call_id === 'call1'));
    assert.ok(!JSON.stringify(seen).includes('provider-private')); assert.equal(responses.length,0);
    const a = await new Agent(settings, runtime.db, runtime.retrieval, async messages => {
      assert.equal(JSON.parse(messages[1].content).history.length, 0);
      return { content: JSON.stringify({ answer: 'Проверьте условия договора.', source_ids: ['company','news:n1'] }) };
    }).answer('U_1',result.id,'Что проверить?'); assert.equal(a.mode,'live');
  });
  it('fails closed for invalid model results and requires a live key', async () => {
    settings.mode = 'live';
    assert.equal((await request('/api/analysis', { news_id: 'n1' })).status, 502);
    const agent = new Agent(settings,runtime.db,runtime.retrieval,async () => ({ role: 'assistant', content: '{}' }));
    await assert.rejects(agent.analyze('U_1','n1',ROLES[0],true), /итоговую проверку.*summary/);
    assert.equal(runtime.db.get('SELECT count(*) n FROM analyses')!.n,0);
    assert.throws(() => parseJson({ content: '[]' }), /JSON/);
    assert.deepEqual(parseJson({ content: '\x60\x60\x60json\n{"ok":true}\n\x60\x60\x60' }), { ok: true });
  });
  it('sends the real gateway contract and stores usage with no network in demo tests', async () => {
    settings.apiKey = 'test-placeholder';
    const seen: { url: string; options: RequestInit }[] = [];
    const fake = (async (url, options) => { seen.push({ url: String(url), options: options! }); return Response.json({ choices: [{ message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }); }) as typeof fetch;
    const complete = createComplete(settings,runtime.db,fake);
    await complete([{ role: 'user', content: 'Контекст' }], [{ type: 'function' }]);
    await complete([],undefined,true);
    assert.equal(seen[0].url,settings.baseUrl + '/chat/completions');
    assert.equal((seen[0].options.headers as Json).Authorization,'Bearer test-placeholder');
    const body = JSON.parse(String(seen[0].options.body)); assert.equal(body.model,settings.model); assert.equal(body.tool_choice,'auto');
    assert.deepEqual(JSON.parse(String(seen[1].options.body)).response_format,{ type: 'json_object' });
    assert.equal(body.max_tokens,4000); assert.equal(JSON.parse(String(seen[1].options.body)).max_tokens,6000);
    assert.equal(seen[0].options.redirect,'error'); assert.equal(runtime.db.get('SELECT sum(prompt_tokens+completion_tokens) n FROM llm_calls')!.n,32);
  });
  it('reserves local limits before parallel requests and counts failed attempts', async () => {
    settings.apiKey = 'test'; settings.maxCalls = 1; let calls = 0;
    const fake = (async () => { calls++; throw new Error('Secret-key-in-provider-message'); }) as typeof fetch;
    const complete = createComplete(settings,runtime.db,fake);
    const results = await Promise.allSettled([complete([]),complete([])]);
    assert.equal(calls,1); assert.ok(results.every(r => r.status === 'rejected'));
    assert.ok(!JSON.stringify(results.map(r => r.status === 'rejected' ? r.reason.message : '')).includes('Secret'));
    assert.equal(runtime.db.get('SELECT count(*) n FROM llm_calls')!.n,1);
  });
  it('never relays provider error bodies', async () => {
    settings.apiKey = 'test';
    const complete = createComplete(settings,runtime.db,(async () => new Response('Secret-provider-body',{ status:401 })) as typeof fetch);
    await assert.rejects(complete([]), error => error instanceof Error && error.message === 'Ключ отклонён API.');
  });
  it('protects static server files, same origin and JSON body limits', async () => {
    for (const path of ['/.env','/server/config.ts','/backend/config.py','/../backend/config.py','/%2e%2e/server/config.ts']) assert.equal((await fetch(base + path)).status,404);
    assert.equal((await fetch(base + '/')).status,200); assert.equal((await fetch(base + '/app.js')).status,200);
    assert.equal((await fetch(base + '/api/news',{ method:'POST', headers: { 'Content-Type':'application/json',Origin:'https://evil.example' }, body:'{}' })).status,403);
    for (const body of ['[]','null','{']) assert.equal((await fetch(base + '/api/news',{ method:'POST',headers:{ 'Content-Type':'application/json' },body })).status,400);
    assert.equal((await fetch(base + '/api/news',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ text:'x'.repeat(80001) }) })).status,413);
    assert.equal((await request('/api/analysis',{news_id:'n1',role:'unknown'})).status,400);
  });
  it('imports RSS and Atom and rejects entity declarations, redirects and oversize feeds', async () => {
    settings.feeds = ['https://example.org/rss'];
    const rss = '<rss><channel><item><title>Новости кредитования</title><description>Изменились условия кредитования компаний. Требуется проверка действующих договоров.</description><link>https://example.org/news</link></item></channel></rss>';
    const a = await ingestFeeds(settings,runtime.db,(async () => new Response(rss)) as typeof fetch); assert.equal(a.processed,1);
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Импорт оборудования</title><summary>Изменились сроки импорта оборудования. Применимость зависит от маршрута и условий.</summary><link href="https://example.org/atom"/><updated>2026-10-22</updated></entry></feed>';
    const b = await ingestFeeds(settings,runtime.db,(async () => new Response(atom)) as typeof fetch); assert.equal(b.processed,1);
    assert.ok(runtime.db.all('SELECT url FROM news').some(n => n.url === 'https://example.org/atom'));
    for (const xml of ['<!DOCTYPE rss [<!ENTITY x "bad">]>' + rss, 'x'.repeat(2000001)]) assert.deepEqual((await ingestFeeds(settings,runtime.db,(async () => new Response(xml)) as typeof fetch)).failed_hosts,['example.org']);
    assert.equal((await ingestFeeds(settings,runtime.db,(async (_url,options) => { assert.equal(options?.redirect,'error'); return new Response('',{ status:302 }); }) as typeof fetch)).failed_hosts.length,1);
  });
  it('retains chats and cached analyses across restart and fails interrupted jobs', async () => {
    const analysis = await demo();
    await runtime.agent.answer('U_1',analysis.id,'Что проверить?');
    runtime.db.run("INSERT INTO jobs(id,company_id,status) VALUES('interrupted','U_1','running')");
    await runtime.close();
    runtime = await createApplication(settings);
    assert.equal(runtime.db.get("SELECT status FROM jobs WHERE id='interrupted'")!.status,'failed');
    assert.equal(runtime.db.get('SELECT count(*) n FROM chats')!.n,1);
    assert.equal((await runtime.agent.analyze('U_1','n1',ROLES[0])).cached,true);
  });
  it('rolls back failed imports and permits a successful retry', async () => {
    const other = fixture(); const path = join(other.settings.data,'df_Uid_payment_hack.csv.gz');
    rmSync(path); const db = new Store(other.settings);
    try {
      await assert.rejects(db.initialize()); assert.equal(db.get('SELECT count(*) n FROM companies')!.n,0);
      writeFileSync(path,gzipSync('PAYER;BENEFICIARY;PAY_AMT;PAY_CNT\nU_1;U_2;123;2\n'));
      await db.initialize(); assert.equal(db.company('U_1').outgoing.total,123);
    } finally { db.close(); rmSync(other.folder,{recursive:true,force:true}); }
  });

  it('bounds accepted jobs to ten and concurrently executes at most two analyses', async () => {
    const valid = candidate(await demo());
    const other = fixture(); other.settings.mode = 'live'; other.settings.apiKey = 'test';
    let blocked = true, planningCalls = 0;
    const gates: (() => void)[] = [];
    const complete: Complete = async (_messages, tools) => {
      if (tools) { planningCalls++; if (blocked) await new Promise<void>(resolve => gates.push(resolve)); return { role: 'assistant', content: 'Контекст собран' }; }
      return { role: 'assistant', content: JSON.stringify(valid) };
    };
    const queued = await createApplication(other.settings, { complete });
    const listener = queued.app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve => listener.once('listening',resolve));
    const address = listener.address(); assert.ok(address && typeof address !== 'string');
    const endpoint = 'http://127.0.0.1:' + address.port;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const response = await fetch(endpoint + '/api/analysis', { method:'POST', headers:{ 'Content-Type':'application/json','X-Company-ID':'U_1' }, body:JSON.stringify({news_id:'n1',force:true}) });
        assert.equal(response.status,202); ids.push((await response.json() as Json).job_id);
      }
      const rejected = await fetch(endpoint + '/api/analysis',{method:'POST',headers:{'Content-Type':'application/json','X-Company-ID':'U_1'},body:'{"news_id":"n1"}'});
      assert.equal(rejected.status,429); await rejected.json(); assert.equal(planningCalls,2); assert.equal(queued.queue.size,10);
      blocked = false; gates.splice(0).forEach(resolve => resolve()); await queued.queue.idle();
      assert.equal(queued.queue.size,0); assert.equal(planningCalls,10);
      assert.equal(queued.db.get("SELECT count(*) n FROM jobs WHERE status='completed'")!.n,10);
      for (const id of ids) assert.equal(queued.db.get('SELECT company_id FROM jobs WHERE id=?',id)!.company_id,'U_1');
    } finally {
      blocked = false; gates.splice(0).forEach(resolve => resolve()); listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve())); await queued.close(); rmSync(other.folder,{recursive:true,force:true});
    }
  });

  it('reports output truncation explicitly, records usage and avoids a blind repair', async () => {
    settings.apiKey = 'test'; settings.mode = 'live'; let calls = 0;
    const complete = createComplete(settings,runtime.db,(async (_url,options) => {
      calls++;
      if (!JSON.parse(String(options?.body)).response_format) return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Контекст собран'}}],usage:{prompt_tokens:10,completion_tokens:1}});
      return Response.json({ choices:[{ finish_reason:'length',message:{role:'assistant',content:'{"summary":"incomplete'} }],usage:{prompt_tokens:10,completion_tokens:6000} });
    }) as typeof fetch);
    const agent = new Agent(settings,runtime.db,runtime.retrieval,complete);
    await assert.rejects(agent.analyze('U_1','n1',ROLES[0],true),/обрезан по лимиту длины/);
    assert.equal(calls,2); assert.equal(runtime.db.get('SELECT sum(completion_tokens) n FROM llm_calls')!.n,6001);
    assert.equal(runtime.db.get('SELECT count(*) n FROM analyses')!.n,0);
  });

  it('identifies a company-only fact by claim number without accepting a false news citation', async () => {
    const analysis = await demo(), sources = Object.fromEntries(analysis.sources.map(s => [s.id,s]));
    const result = candidate(analysis);
    result.claims.unshift({kind:'fact',text:'В профиле компании отмечен кредит.',quote:'',source_ids:['company']});
    const errors = validate(result,sources);
    assert.equal(errors.length,1); assert.match(errors[0],/Утверждение 1: fact не связан с новостью/);
    assert.match(errors[0],/Не добавляй ID новости без фактического основания/);
    result.claims.shift(); assert.deepEqual(validate(result,sources),[]);
  });

  it('distinguishes timeout, network and malformed JSON without leaking provider details', async () => {
    settings.apiKey='test';
    const timeout = createComplete(settings,runtime.db,(async () => {throw new DOMException('Secret-provider-body','TimeoutError');}) as typeof fetch);
    await assert.rejects(timeout([]),error => error instanceof Error && /Истекло время ожидания/.test(error.message) && !error.message.includes('Secret'));
    const network = createComplete(settings,runtime.db,(async () => {throw Object.assign(new TypeError('Secret-provider-body'),{cause:{code:'ECONNRESET'}});}) as typeof fetch);
    await assert.rejects(network([]),error => error instanceof Error && /ECONNRESET/.test(error.message) && !error.message.includes('Secret'));
    const malformed = createComplete(settings,runtime.db,(async () => new Response('Secret-provider-body')) as typeof fetch);
    await assert.rejects(malformed([]),error => error instanceof Error && /некорректный JSON/.test(error.message) && !error.message.includes('Secret'));
    const bootstrap = await request('/api/bootstrap'); assert.equal(bootstrap.body.request_timeout_ms,settings.timeout+10000);
  });
});
