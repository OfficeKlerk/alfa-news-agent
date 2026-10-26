import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { ROOT } from "../config.js";

// A small DOM harness executes the real browser entrypoint. No web server or LLM is used.
class Element {
  tagName: string; id = ""; parent: Element | null = null; children: Element[] = []; dataset: Record<string, string> = {};
  value = ""; type = ""; disabled = false; hidden = false; href = ""; open = false; className = ""; _text = "";
  attributes: Record<string, string> = {}; listeners: Record<string, Function[]> = {};
  constructor(tag: string) { this.tagName = tag.toLowerCase(); }
  get childNodes() { return this.children; } get firstChild() { return this.children[0]; }
  get textContent(): string { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this._text = String(value); this.children = []; }
  set innerHTML(_value: string) { throw new Error("UI must render untrusted news as text, never HTML"); }
  get classList() { return { toggle: (name: string, selected?: boolean) => { const classes = new Set(this.className.split(" ").filter(Boolean)); if (selected ?? !classes.has(name)) classes.add(name); else classes.delete(name); this.className = [...classes].join(" "); } }; }
  append(...children: Element[]) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { this._text = ""; for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, callback: Function) { (this.listeners[name] ||= []).push(callback); }
  async dispatch(name: string) { for (const callback of this.listeners[name] || []) await callback({ preventDefault() {}, target: this }); }
  getBoundingClientRect() { return { top: 200, bottom: 400 }; }
  querySelector(selector: string): Element | null {
    const matches = (element: Element) => {
      if (selector.startsWith('.')) return element.className.split(' ').includes(selector.slice(1));
      const data = selector.match(/^\[data-([a-z-]+)\]$/); if (data) return data[1].replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) in element.dataset;
      const typed = selector.match(/^(\w+)\[type=(\w+)\]$/); if (typed) return element.tagName === typed[1] && element.type === typed[2];
      return element.tagName === selector;
    };
    for (const child of this.children) { if (matches(child)) return child; const nested = child.querySelector(selector); if (nested) return nested; } return null;
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function browser(options: { saved?: any; cards?: any[]; history?: any[]; viewer?:string; storage?:Map<string,string>; statuses?:any; jobs?:any[]; beforeFetch?:(path:string)=>Promise<void>; questionJob?:any; questionFailure?:boolean } = {}) {
  const html = readFileSync(resolve(ROOT, "integration/live_ui/index.html"), "utf8");
  const script = readFileSync(resolve(ROOT, "integration/live_ui/app.js"), "utf8");
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => { const element = new Element(match[1]); element.id = match[2]; return [match[2], element]; }));
  const calls: { method: string; path: string; body?: any; headers?:any }[] = []; const timers: Function[] = [];
  const viewer=options.viewer??'test-viewer',storage=options.storage??new Map<string,string>();
  if(options.saved)storage.set('alfa.live.v2.'+viewer,JSON.stringify(options.saved));
  let feed = options.cards || []; let uuid=0; let feedPages: Record<string,any> | undefined;
  let statusFailure = false;
  const events: Record<string, Function[]> = {}, windowEvents: Record<string, Function[]> = {};
  let jobItems = options.jobs || [];
  const statuses: any = { generation_enabled: false, worker: {}, queue: { jobs: { queued: 1, deferred: 1 }, analyses: feed.length }, subscriptions: [{ company_id: "U1", audience_role: "cfo", enabled: true }], collector: { enabled: true, feeds: [{ url: "https://example.org/rss", last_success: "2026-10-25T12:00:00Z" }] } };
  Object.assign(statuses, options.statuses || {});
  const fetch = async (path: string, config: any) => {
    const method = config.method || "GET", body = config.body ? JSON.parse(config.body) : undefined;
    calls.push({ method, path, body,headers:config.headers }); let data: any;
    await options.beforeFetch?.(path);
    if (statusFailure && path.startsWith("/v1/live/status")) throw new Error("offline");
    if (path === '/v1/runtime') data = {generation_enabled:false,viewer_key:viewer};
    else if (path.startsWith('/v1/companies?')) data = { items: ["U1"] };
    else if (path === '/v1/companies/U1') data = { company_id: "U1", industry: { name: "Промышленность" }, geography: { region: "Москва" } };
    else if (path.startsWith('/v1/live/status')) data = statuses;
    else if (path.startsWith('/v1/live/feed')) data = feedPages ? feedPages[new URL(path,'https://example.org').searchParams.get('cursor') || ''] : { items: feed, next_cursor: null };
    else if (path.startsWith('/v1/live/jobs')) data = { items: jobItems };
    else if (path.includes('/questions')) { if (options.questionFailure) throw new Error('network failed'); data = options.questionJob || { id: 'q1', status: 'deferred', kind: 'question' }; }
    else if (path.includes('/favorite')) data = { id: "analysis1", favorite: body.favorite };
    else if (path.startsWith('/v1/live/analyses/')) data = { card: feed[0], history: options.history || [], versions: [] };
    else if (path === '/v1/live/subscriptions') { statuses.subscriptions = [body]; data = body; }
    else if (path === '/v1/live/scan') data = statuses.selection || {};
    else throw new Error("Unexpected request " + path);
    return { ok: true, status: 200, json: async () => ({ data, meta: { mode: "live" } }) };
  };
  const document = { hidden: false, addEventListener: (name:string, cb:Function) => { (events[name] ||= []).push(cb); }, getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const item = new Element('#text'); item.textContent = text; return item; } };
  const context = { document, window: { scrollY: 0, innerHeight: 800, addEventListener(name:string, cb:Function) { (windowEvents[name] ||= []).push(cb); }, scrollBy() {}, scrollTo() {} }, localStorage: { getItem: (key:string) => storage.get(key)??null, setItem: (key: string, value: string) => { storage.set(key,value); } },
    fetch, URL, URLSearchParams, Intl, Date, Set, Map, AbortController, crypto: { randomUUID: () => ++uuid === 1 ? 'request-key' : 'request-key-' + uuid }, requestAnimationFrame: (callback: Function) => callback(),
    setTimeout: () => 1, clearTimeout() {}, setInterval: (callback: Function) => { timers.push(callback); return 1; }, clearInterval() {}, console };
  await runInNewContext(`(async () => { ${script}\n })()`, context);
  await flush();
  return { nodes, calls, timers, storage, document,
    setStatus(value:any) { Object.assign(statuses,value); }, setJobs(value:any[]) { jobItems=value; }, setHistory(value:any[]) { options.history=value; }, setQuestionFailure(value:boolean) { options.questionFailure=value; }, failStatus(value:boolean) { statusFailure=value; },
    async event(name:string, windowEvent=false) { for (const cb of (windowEvent ? windowEvents : events)[name] || []) await cb(); await flush(); await flush(); }, get saved() { return JSON.parse(storage.get('alfa.live.v2.'+viewer)??'{}'); }, setFeed(items: any[]) { feed = items; }, setPages(pages:Record<string,any>) { feedPages=pages; }, async poll() { await timers[0](); await flush(); } };
}
const card = { id: "analysis1", seq: 1, news_id: "news1", company_id: "U1", revision: "r1", audience_role: "cfo", title: "<img src=x onerror=alert(1)>", created_at: 1792929600000, stale: false, favorite: false,
  analysis: { summary: "Событие и его влияние", why_relevant: "У компании есть кредит", recommendations: ["Проверить ставку"], grounding: { recommendations: [{ condition: "Если ставка плавающая", required_data: ["Условия договора"], claim_indexes: [0] }] }, claims: [{ kind: "fact", text: "Проверенный факт", source_ids: ["s1"] }], sources: [{ id: "s1", kind: "news", title: "Источник", url: "javascript:alert(1)", excerpt: "<script>unsafe</script>" }], missing_data: [], limitations: [] } };

test("live UI reload and periodic refresh only read saved results and never generate or subscribe", async () => {
  const b = await browser({ saved: { company: "U1", role: "cfo", expanded: [] } });
  await b.poll();
  assert.ok(b.calls.some(call => call.path.startsWith('/v1/live/feed')));
  assert.ok(b.calls.some(call => call.path.startsWith('/v1/live/status')));
  assert.equal(b.calls.every(call => call.method === 'GET'), true);
  assert.equal(b.saved.company, 'U1');
  assert.match(b.nodes.get('model-notice')!.textContent, /пока не подключена/);
  assert.equal(b.nodes.get('empty-title')!.textContent, 'Готовых выводов пока нет');
});

test("untrusted news is text-only, dangerous source URLs are omitted and ready cards arrive automatically", async () => {
  const b = await browser({ saved: { company: "U1", role: "cfo" }, cards: [card] });
  const rendered = b.nodes.get('feed')!.children[0];
  assert.match(rendered.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(rendered.textContent, /<script>unsafe<\/script>/);
  assert.equal(rendered.querySelector('.source')!.querySelector('a'), null);
  const newer = { ...card, id: 'analysis2', seq: 2, news_id: 'news2', title: 'Новая публикация' };
  b.setFeed([newer, card]); await b.poll();
  assert.equal(b.nodes.get('feed')!.children.length, 2);
  assert.equal(b.calls.every(call => call.method === 'GET'), true);
});

test("favorite and question are explicit mutations with company binding and an idempotency key", async () => {
  const b = await browser({ saved: { company: "U1", role: "cfo" }, cards: [card] });
  const article = b.nodes.get('feed')!.children[0];
  await article.querySelector('.favorite')!.dispatch('click');
  const favorite = b.calls.find(call => call.path.endsWith('/favorite'))!;
  assert.deepEqual(JSON.parse(JSON.stringify(favorite.body)), { company_id: 'U1', favorite: true });
  const section = article.querySelector('.question-section')!;
  section.querySelector('textarea')!.value = 'Какие условия договора проверить?';
  await section.querySelector('form')!.dispatch('submit');
  const question = b.calls.find(call => call.path.endsWith('/questions'))!;
  assert.equal(question.body.company_id, 'U1');
  assert.equal(question.body.idempotency_key, 'request-key');
  assert.equal(question.body.question, 'Какие условия договора проверить?');
  assert.equal(section.querySelector('textarea')!.value, 'Какие условия договора проверить?');
});


test("browser drafts and restored selections are bound to the authenticated viewer, including two employees of one company",async()=>{
 const storage=new Map<string,string>();
 const secret={company:'U1',role:'cfo',expanded:['analysis1'],drafts:{analysis1:{text:'Alice private question'}}};
 storage.set('alfa.live.v1',JSON.stringify(secret));
 storage.set('alfa.live.v2.alice',JSON.stringify(secret));
 const alice=await browser({viewer:'alice',storage,cards:[card]});
 assert.equal(alice.nodes.get('feed')!.querySelector('textarea')!.value,'Alice private question');
 const bob=await browser({viewer:'bob',storage,cards:[card]});
 assert.equal(bob.calls.some(c=>c.path.startsWith('/v1/live/feed')),false,'another employee cannot restore Alice selection/drafts');
 assert.equal(storage.get('alfa.live.v2.alice')!.includes('Alice private question'),true);
 assert.equal(alice.calls.filter(c=>c.path!='/v1/runtime').every(c=>c.headers['X-Viewer-Key']==='alice'),true);
 assert.equal(bob.calls.filter(c=>c.path!='/v1/runtime').every(c=>c.headers['X-Viewer-Key']==='bob'),true);
});

test('live summary refreshes from server and never retains the previous role selection', async () => {
  const b = await browser({saved:{company:'U1',role:'cfo'}, statuses:{generation_enabled:true,selection:{considered:10,eligible:2,queued:1,scanned_at:'2026-10-26T10:00:00Z'}}});
  assert.match(b.nodes.get('feed-description')!.textContent,/проверено 10, значимых 2/);
  b.setStatus({selection:{considered:25,eligible:4,queued:2}}); await b.poll();
  assert.match(b.nodes.get('feed-description')!.textContent,/проверено 25, значимых 4/);
  b.setStatus({selection:null}); await b.poll();
  assert.match(b.nodes.get('feed-description')!.textContent,/ещё не выполнялся/);
  assert.doesNotMatch(b.nodes.get('feed-description')!.textContent,/проверено 25/);
  assert.ok(b.calls.every(c=>c.method==='GET'));
});

test('journal displays source links and distinct selection and job statuses without generating',async()=>{
 const b=await browser({saved:{company:'U1'},jobs:[{id:'j1',title:'Ожидает ответа',kind:'analysis',status:'unknown'}],statuses:{selection:{items:[{title:'<script>unsafe</script>',selected:false,reason:'below_relevance_threshold',source_url:'https://example.org/news'},{title:'Bad URL',reason:'awaiting_full_text',source_url:'javascript:alert(1)'}]}}});
 await b.nodes.get('journal-toggle')!.dispatch('click');
 assert.equal(b.nodes.get('event-journal')!.hidden,false);
 const rows=b.nodes.get('journal-events')!.children;
 assert.equal(rows.length,3);
 assert.match(rows[0].textContent,/Исход запроса уточняется/);
 assert.match(rows[1].textContent,/<script>unsafe<\/script>/);
 assert.equal(rows[1].querySelector('a')!.href,'https://example.org/news');
 assert.equal(rows[2].querySelector('a'),null);
 assert.match(b.nodes.get('journal-description')!.textContent,/не полный архив/);
 assert.ok(b.calls.every(c=>c.method==='GET'));
 await b.nodes.get('journal-close')!.dispatch('click');
 assert.equal(b.nodes.get('event-journal')!.hidden,true);
});

test('journal pages the entire latest selection instead of silently truncating it',async()=>{
 const b=await browser({saved:{company:'U1'},statuses:{selection:{items:Array.from({length:31},(_,i)=>({title:'Event '+i,reason:'below_relevance_threshold'}))}}});
 await b.nodes.get('journal-toggle')!.dispatch('click');
 assert.equal(b.nodes.get('journal-events')!.children.length,25);
 assert.equal(b.nodes.get('journal-next')!.disabled,false);
 await b.nodes.get('journal-next')!.dispatch('click');
 assert.equal(b.nodes.get('journal-events')!.children.length,6);
 assert.equal(b.nodes.get('journal-next')!.disabled,true);
 b.setStatus({selection:{items:[]}}); await b.poll();
 assert.match(b.nodes.get('journal-page')!.textContent,/0 событий/);
 assert.equal(b.nodes.get('journal-prev')!.disabled,true);
});

test('stop disables only the selected subscription and keeps polling saved results',async()=>{
 const b=await browser({saved:{company:'U1',role:'cfo'},statuses:{generation_enabled:true,queue:{jobs:{},analyses:0}}});
 await b.nodes.get('pause-subscription')!.dispatch('click');await flush();await flush();
 const mutations=b.calls.filter(c=>c.method==='POST');
 assert.equal(mutations.length,1);
 assert.equal(mutations[0].path,'/v1/live/subscriptions');
 assert.equal(mutations[0].body.enabled,false);
 assert.equal(mutations[0].body.company_id,'U1');
 assert.equal(mutations[0].body.audience_role,'cfo');
 assert.match(b.nodes.get('notice')!.textContent,/могут завершиться и расходовать бюджет/);
 assert.equal(b.nodes.get('scan')!.disabled,true);
 const before=b.calls.length;await b.poll();
 assert.ok(b.calls.length>before);
 assert.ok(b.calls.slice(before).every(c=>c.method==='GET'));
});

test('only confirmed running analysis for the selected role shows preparation',async()=>{
 const b=await browser({saved:{company:'U1'},statuses:{generation_enabled:true,queue:{jobs:{running:9,unknown:3},analyses:20}},jobs:[{id:'other',kind:'analysis',company_id:'U1',audience_role:'ceo',status:'running'}]});
 assert.equal(b.nodes.get('empty-title')!.textContent,'Готовых выводов пока нет');
 assert.equal(b.nodes.get('activity-spinner')!.hidden,true);
 b.setJobs([{id:'right',kind:'analysis',company_id:'U1',audience_role:'cfo',status:'running'}]);await b.poll();
 assert.equal(b.nodes.get('empty-title')!.textContent,'Готовим выводы');assert.equal(b.nodes.get('activity-spinner')!.hidden,false);
 b.setJobs([{id:'right',kind:'analysis',company_id:'U1',audience_role:'cfo',status:'failed',error:'Provider timeout'}]);await b.poll();
 assert.equal(b.nodes.get('empty-title')!.textContent,'Готовых выводов пока нет');assert.equal(b.nodes.get('activity-spinner')!.hidden,true);
 assert.equal(b.nodes.get('card-count')!.textContent,'0');
});

test('read spinner follows an actual request and connection failures keep saved cards',async()=>{
 let release!:()=>void,hold=false;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const b=await browser({saved:{company:'U1'},cards:[card],beforeFetch:async path=>{if(hold&&path.startsWith('/v1/live/status'))await gate;}});
 hold=true;const polling=b.poll();await flush();
 assert.match(b.nodes.get('activity-title')!.textContent,/Обновляем ленту/);
 assert.equal(b.nodes.get('activity-spinner')!.hidden,false);
 release();await polling;
 b.failStatus(true);await b.poll();
 assert.match(b.nodes.get('activity-description')!.textContent,/последние доступные результаты/);
 assert.equal(b.nodes.get('feed')!.children.length,1);
 b.failStatus(false);await b.poll();
 assert.doesNotMatch(b.nodes.get('activity-title')!.textContent,/Не удалось обновить/);
});

test('returning to a visible page refreshes with GET only and unavailable budget is not zero',async()=>{
 const b=await browser({saved:{company:'U1'},statuses:{budget:{error:'budget_unavailable'}}});
 assert.equal(b.nodes.get('budget-count')!.textContent,'Недоступен');
 b.document.hidden=true;let before=b.calls.length;await b.poll();assert.equal(b.calls.length,before);
 b.document.hidden=false;await b.event('visibilitychange');assert.ok(b.calls.length>before);
 before=b.calls.length;await b.event('pageshow',true);assert.ok(b.calls.length>before);
 assert.ok(b.calls.every(c=>c.method==='GET'));
});

test('changing feed filter during a stop request cannot leave the activity or polling stuck',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const b=await browser({saved:{company:'U1'},statuses:{generation_enabled:true,queue:{jobs:{},analyses:0}},beforeFetch:async path=>{if(path==='/v1/live/subscriptions')await gate;}});
 await b.nodes.get('pause-subscription')!.dispatch('click');await flush();
 assert.match(b.nodes.get('activity-title')!.textContent,/Останавливаем/);
 await b.nodes.get('favorite-cards')!.dispatch('click');await flush();
 release();await flush();await flush();
 assert.doesNotMatch(b.nodes.get('activity-title')!.textContent,/Останавливаем/);
 const before=b.calls.length;await b.poll();assert.ok(b.calls.length>before);
});

test('restored company is reflected in the selector and missing usage is not rendered as zero',async()=>{
 const b=await browser({saved:{company:'U1'},statuses:{budget:{used:{calls:null,tokens:null},limits:{calls:100}}}});
 assert.equal(b.nodes.get('company-list')!.value,'U1');
 assert.equal(b.nodes.get('budget-count')!.textContent,'— / 100');
 assert.match(b.nodes.get('budget-summary')!.textContent,/токены: —/);
});

test('non-ready, stale and other-scope feed entries do not replace a ready card',async()=>{
 const b=await browser({saved:{company:'U1'},cards:[card,{...card,id:'stale',stale:true},{...card,id:'failed',status:'failed'},{...card,id:'other-role',audience_role:'ceo'},{...card,id:'other-company',company_id:'U2'}]});
 assert.equal(b.nodes.get('feed')!.children.length,1);assert.equal(b.nodes.get('card-count')!.textContent,'1');
 b.setFeed([card,{...card,id:'failed-2',status:'failed'}]);await b.poll();
 assert.equal(b.nodes.get('feed')!.children.length,1);
 b.setFeed([{...card,stale:true}]);await b.poll();assert.equal(b.nodes.get('feed')!.children.length,0);assert.equal(b.nodes.get('card-count')!.textContent,'0');
});

test('queued question keeps its draft through reload; failed answer preserves previous dialogue',async()=>{
 const storage=new Map<string,string>();const question='Что проверить по этой новости?';
 const job={id:'q1',analysis_id:'analysis1',company_id:'U1',audience_role:'cfo',kind:'question',status:'queued',created_at:1000,title:question};
 const b=await browser({saved:{company:'U1',expanded:['analysis1']},cards:[card],history:[{question:'Ранее',answer:'Сохранённый ответ'}],questionJob:job,storage});
 const section=b.nodes.get('feed')!.querySelector('.question-section')!;section.querySelector('textarea')!.value=question;await section.querySelector('form')!.dispatch('submit');await flush();
 assert.equal(section.querySelector('textarea')!.value,question);assert.equal(b.saved.drafts.analysis1.job_id,'q1');assert.equal(section.querySelector('.question-submit')!.disabled,true);
 const reloaded=await browser({storage,cards:[card],history:[{question:'Ранее',answer:'Сохранённый ответ'},{question,answer:'Не показывать этот ответ',status:'failed'}],jobs:[{...job,status:'failed',error:'MODEL_RESPONSE_INVALID'}]});
 await reloaded.poll();await flush();const s=reloaded.nodes.get('feed')!.querySelector('.question-section')!;
 assert.equal(s.querySelector('textarea')!.value,question);assert.match(s.textContent,/Сохранённый ответ/);assert.doesNotMatch(s.textContent,/Не показывать этот ответ/);assert.match(s.querySelector('[data-question-status]')!.textContent,/Ответ не подготовлен/);assert.equal(s.querySelector('[data-question-status]')!.dataset.pending,'false');
});

test('question clears only after a completed response actually appears in history',async()=>{
 const question='Какие данные нужны?';const job={id:'q1',analysis_id:'analysis1',company_id:'U1',kind:'question',status:'queued',created_at:1000,title:question};
 const b=await browser({saved:{company:'U1',expanded:['analysis1']},cards:[card],questionJob:job});const s=b.nodes.get('feed')!.querySelector('.question-section')!;
 s.querySelector('textarea')!.value=question;await s.querySelector('form')!.dispatch('submit');
 b.setJobs([{...job,status:'succeeded'}]);await b.poll();await flush();assert.equal(s.querySelector('textarea')!.value,question);
 b.setHistory([{question,answer:'Новый готовый ответ',created_at:2000}]);await b.poll();await flush();
 assert.match(s.textContent,/Новый готовый ответ/);assert.equal(s.querySelector('textarea')!.value,'');assert.equal(b.saved.drafts.analysis1,undefined);assert.equal(s.querySelector('.question-submit')!.disabled,false);
});

test('unknown question delivery keeps the same key and cannot trigger a blind second request',async()=>{
 const b=await browser({saved:{company:'U1'},cards:[card],questionFailure:true});const s=b.nodes.get('feed')!.querySelector('.question-section')!;s.querySelector('textarea')!.value='Сохраните мой вопрос';
 await s.querySelector('form')!.dispatch('submit');assert.equal(s.querySelector('textarea')!.value,'Сохраните мой вопрос');assert.match(s.querySelector('[data-question-status]')!.textContent,/Отправка уточняется/);assert.equal(s.querySelector('[data-question-status]')!.dataset.pending,'false');
 b.setQuestionFailure(false);await s.querySelector('form')!.dispatch('submit');
 const calls=b.calls.filter(c=>c.path.endsWith('/questions'));assert.equal(calls.length,2);assert.equal(calls[0].body.idempotency_key,calls[1].body.idempotency_key);
});

test('terminal timeout stays in the journal and does not promise an automatic retry',async()=>{
 const b=await browser({saved:{company:'U1'},cards:[card],jobs:[{id:'fail',kind:'analysis',status:'failed',title:'Failed event',error:'Provider timeout'}]});
 assert.equal(b.nodes.get('feed')!.children.length,1);assert.doesNotMatch(b.nodes.get('activity-title')!.textContent,/ошиб|timeout/i);
 await b.nodes.get('journal-toggle')!.dispatch('click');assert.match(b.nodes.get('journal-events')!.textContent,/завершилась без результата/);assert.doesNotMatch(b.nodes.get('journal-events')!.textContent,/будет повторена/);
});

test('switching role while a company profile is loading keeps the requested company',async()=>{
 let release!:()=>void,blocked=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 const b=await browser({beforeFetch:async path=>{if(blocked&&path==='/v1/companies/U1')await gate;}});
 blocked=true;b.nodes.get('company-list')!.value='U1';await b.nodes.get('company-list')!.dispatch('change');await flush();
 b.nodes.get('role')!.value='ceo';await b.nodes.get('role')!.dispatch('change');release();await flush();await flush();
 assert.match(b.nodes.get('profile')!.textContent,/U1/);assert.ok(b.calls.some(c=>c.path.startsWith('/v1/live/feed')&&c.path.includes('audience_role=ceo')));
});

test('a ready-only server can remove a stale card by omission without leaving it in the feed',async()=>{
 const b=await browser({saved:{company:'U1'},cards:[card,{...card,id:'keep',news_id:'n2',seq:2}]});
 b.setFeed([{...card,id:'keep',news_id:'n2',seq:2}]);await b.poll();assert.equal(b.nodes.get('feed')!.children.length,1);assert.equal(b.nodes.get('card-count')!.textContent,'1');
 b.setFeed([]);await b.poll();assert.equal(b.nodes.get('feed')!.children.length,0);assert.equal(b.nodes.get('card-count')!.textContent,'0');
});

test('refresh reconciles loaded pages without losing an older ready card at the next cursor',async()=>{
 const b=await browser({saved:{company:'U1'},cards:[card]});
 b.setPages({'':{items:[{...card,id:'new',seq:2,news_id:'n2'}],next_cursor:'next'},next:{items:[card],next_cursor:null}});
 await b.poll();assert.equal(b.nodes.get('feed')!.children.length,2);assert.ok(b.calls.some(c=>c.path.includes('cursor=next')));
 assert.equal(b.nodes.get('card-count')!.textContent,'2');
});

test('a failed refresh of the next page preserves the last complete ready window',async()=>{
 let fail=false;const b=await browser({saved:{company:'U1'},cards:[card],beforeFetch:async path=>{if(fail&&path.includes('cursor=next'))throw new Error('offline');}});
 b.setPages({'':{items:[{...card,id:'new',seq:2,news_id:'n2'}],next_cursor:'next'}});fail=true;
 await b.poll();assert.equal(b.nodes.get('feed')!.children.length,1);assert.equal(b.nodes.get('feed')!.children[0].dataset.analysisId,'analysis1');
});

test('reload during question submission restores a safe same-key check instead of an endless spinner',async()=>{
 const question='Вопрос до перезагрузки';const b=await browser({saved:{company:'U1',expanded:['analysis1'],drafts:{analysis1:{key:'original-key',text:question,status:'submitting'}}},cards:[card]});
 const s=b.nodes.get('feed')!.querySelector('.question-section')!;assert.equal(s.querySelector('textarea')!.value,question);assert.equal(s.querySelector('.question-submit')!.disabled,false);assert.equal(s.querySelector('[data-question-status]')!.dataset.pending,'false');
 await s.querySelector('form')!.dispatch('submit');assert.equal(b.calls.find(c=>c.path.endsWith('/questions'))!.body.idempotency_key,'original-key');
});

test('filter changes while a question is being accepted do not orphan its saved job',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const b=await browser({saved:{company:'U1'},cards:[{...card,favorite:true}],beforeFetch:async path=>{if(path.endsWith('/questions'))await gate;}});
 const s=b.nodes.get('feed')!.querySelector('.question-section')!;s.querySelector('textarea')!.value='Не терять вопрос';const submitting=s.querySelector('form')!.dispatch('submit');await flush();
 await b.nodes.get('favorite-cards')!.dispatch('click');await flush();release();await submitting;await flush();
 assert.equal(b.saved.drafts.analysis1.job_id,'q1');assert.equal(b.saved.drafts.analysis1.text,'Не терять вопрос');
});

test('an older answer with the same text cannot clear an unresolved submission without its job ID',async()=>{
 const text='Повторяющийся вопрос';const b=await browser({saved:{company:'U1',expanded:['analysis1'],drafts:{analysis1:{text,key:'keep-key',status:'submission_unknown'}}},cards:[card],history:[{question:text,answer:'Старый ответ',created_at:500}]});
 await b.poll();await flush();const s=b.nodes.get('feed')!.querySelector('.question-section')!;
 assert.equal(s.querySelector('textarea')!.value,text);assert.equal(b.saved.drafts.analysis1.key,'keep-key');assert.match(s.querySelector('[data-question-status]')!.textContent,/Отправка уточняется/);
});

test('scoped feed totals and leased-running metadata from the server override company aggregates',async()=>{
 const b=await browser({saved:{company:'U1'},statuses:{queue:{jobs:{running:9},analyses:100}},jobs:[{id:'old',kind:'analysis',company_id:'U1',audience_role:'cfo',status:'running'}]});
 b.setPages({'':{items:[],next_cursor:null,total:0,visible_ids:[],available_count:0,running_tasks:0,has_running_tasks:false}});await b.poll();
 assert.equal(b.nodes.get('card-count')!.textContent,'0');assert.equal(b.nodes.get('queue-count')!.textContent,'0');assert.equal(b.nodes.get('empty-title')!.textContent,'Готовых выводов пока нет');
 b.setPages({'':{items:[],next_cursor:null,total:0,visible_ids:[],running_tasks:1,has_running_tasks:true}});await b.poll();assert.equal(b.nodes.get('empty-title')!.textContent,'Готовим выводы');assert.equal(b.nodes.get('queue-count')!.textContent,'1');
});
