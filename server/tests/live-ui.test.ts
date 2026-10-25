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
async function browser(options: { saved?: any; cards?: any[]; history?: any[]; viewer?:string; storage?:Map<string,string> } = {}) {
  const html = readFileSync(resolve(ROOT, "integration/live_ui/index.html"), "utf8");
  const script = readFileSync(resolve(ROOT, "integration/live_ui/app.js"), "utf8");
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => { const element = new Element(match[1]); element.id = match[2]; return [match[2], element]; }));
  const calls: { method: string; path: string; body?: any; headers?:any }[] = []; const timers: Function[] = [];
  const viewer=options.viewer??'test-viewer',storage=options.storage??new Map<string,string>();
  if(options.saved)storage.set('alfa.live.v2.'+viewer,JSON.stringify(options.saved));
  let feed = options.cards || [];
  const statuses = { generation_enabled: false, worker: {}, queue: { jobs: { queued: 1, deferred: 1 }, analyses: feed.length }, subscriptions: [{ company_id: "U1", audience_role: "cfo", enabled: true }], collector: { enabled: true, feeds: [{ url: "https://example.org/rss", last_success: "2026-10-25T12:00:00Z" }] } };
  const fetch = async (path: string, config: any) => {
    const method = config.method || "GET", body = config.body ? JSON.parse(config.body) : undefined;
    calls.push({ method, path, body,headers:config.headers }); let data: any;
    if (path === '/v1/runtime') data = {generation_enabled:false,viewer_key:viewer};
    else if (path.startsWith('/v1/companies?')) data = { items: ["U1"] };
    else if (path === '/v1/companies/U1') data = { company_id: "U1", industry: { name: "Промышленность" }, geography: { region: "Москва" } };
    else if (path.startsWith('/v1/live/status')) data = statuses;
    else if (path.startsWith('/v1/live/feed')) data = { items: feed, next_cursor: null };
    else if (path.startsWith('/v1/live/jobs')) data = { items: [] };
    else if (path.includes('/questions')) data = { id: "q1", status: "deferred", kind: "question" };
    else if (path.includes('/favorite')) data = { id: "analysis1", favorite: body.favorite };
    else if (path.startsWith('/v1/live/analyses/')) data = { card: feed[0], history: options.history || [], versions: [] };
    else if (path === '/v1/live/subscriptions') data = body;
    else throw new Error("Unexpected request " + path);
    return { ok: true, status: 200, json: async () => ({ data, meta: { mode: "live" } }) };
  };
  const document = { hidden: false, getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const item = new Element('#text'); item.textContent = text; return item; } };
  const context = { document, window: { scrollY: 0, innerHeight: 800, addEventListener() {}, scrollBy() {}, scrollTo() {} }, localStorage: { getItem: (key:string) => storage.get(key)??null, setItem: (key: string, value: string) => { storage.set(key,value); } },
    fetch, URL, URLSearchParams, Intl, Date, Set, Map, AbortController, crypto: { randomUUID: () => "request-key" }, requestAnimationFrame: (callback: Function) => callback(),
    setTimeout: () => 1, clearTimeout() {}, setInterval: (callback: Function) => { timers.push(callback); return 1; }, clearInterval() {}, console };
  await runInNewContext(`(async () => { ${script}\n })()`, context);
  await flush();
  return { nodes, calls, timers, storage, get saved() { return JSON.parse(storage.get('alfa.live.v2.'+viewer)??'{}'); }, setFeed(items: any[]) { feed = items; }, async poll() { await timers[0](); await flush(); } };
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
  assert.match(b.nodes.get('empty-title')!.textContent, /ожидают модель/);
});

test("untrusted news is text-only, dangerous source URLs are omitted and new cards wait for explicit display", async () => {
  const b = await browser({ saved: { company: "U1", role: "cfo" }, cards: [card] });
  const rendered = b.nodes.get('feed')!.children[0];
  assert.match(rendered.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(rendered.textContent, /<script>unsafe<\/script>/);
  assert.equal(rendered.querySelector('.source')!.querySelector('a'), null);
  const newer = { ...card, id: 'analysis2', seq: 2, news_id: 'news2', title: 'Новая публикация' };
  b.setFeed([newer, card]); await b.poll();
  assert.equal(b.nodes.get('feed')!.children.length, 1);
  assert.equal(b.nodes.get('new-cards')!.hidden, false);
  await b.nodes.get('new-cards')!.dispatch('click');
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
  assert.equal(section.querySelector('textarea')!.value, '');
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
