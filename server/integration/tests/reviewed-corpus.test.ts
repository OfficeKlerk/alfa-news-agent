import { developmentAccess } from "../access.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { Retrieval } from "../../retrieval.js";
import { saveNews } from "../../news.js";
import { readReviewedNews, importReviewedNews, textHash } from "../../reviewed-news.js";
import type { Json } from "../../types.js";
import { LegacyRetrieval } from "../retrieval.js";
import { LegacyAgent } from "../agent.js";
import { ContractClient } from "../client.js";
import { createGateway } from "../gateway.js";
import { envelope, validate, validateAnalysis } from "../contracts.js";
import { referenceDraft } from "../evaluation.js";

const asOf = "2026-10-24T18:00:00Z";
const bundlePath = resolve(ROOT, "data/reviewed_news.json");
const corpus: Json[] = JSON.parse(readFileSync(resolve(ROOT, "data/research.json"), "utf8"));
const registry = JSON.parse(readFileSync(resolve(ROOT, "data/demo/rag/corpus_manifest.json"), "utf8"));

async function harness() {
  const parent = resolve(ROOT, "var"); mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, "reviewed-corpus-"));
  const settings = { ...loadSettings({ LLM_MODE: "demo", LLM_API_KEY: "" }), data: resolve(ROOT, "data"), dbPath: join(folder, "news.sqlite3") };
  const db = new Store(settings); await db.initialize();
  const provider = new LegacyRetrieval(db, new Retrieval(db), settings);
  return { folder, settings, db, provider, close() {
    db.close();
    assert.ok(resolve(folder).startsWith(parent + "/") || resolve(folder).startsWith(parent + "\\"));
    rmSync(folder, { recursive: true, force: true });
  } };
}

test("bank corpus carries visually verified publication days without inventing a date for the gold issue", () => {
  assert.equal(corpus.length, 64); assert.equal(registry.documents.length, 9);
  assert.equal(new Set(corpus.map(p => p.document_id)).size, 9);
  assert.equal(registry.documents.filter((d: Json) => d.date_status === "verified").length, 8);
  assert.equal(corpus.filter(p => p.date).length, 56);
  for (const document of registry.documents as Json[]) {
    const pages = corpus.filter(p => p.document_id === document.document_id).sort((a,b) => a.page-b.page);
    assert.equal(pages.length, document.pages);
    assert.equal(textHash(JSON.stringify(pages.map(p => [p.id, p.text]))), document.ocr_text_sha256);
    assert.match(document.pdf_sha256, /^[a-f0-9]{64}$/);
    for (const page of pages) {
      assert.equal(page.date, document.date);
      assert.equal(page.publication_date_status, document.date_status);
      assert.equal(page.publication_metadata_id, document.document_id);
    }
    if (document.date_status === "verified") {
      assert.equal(document.verification.method, "visual_review_of_rendered_pdf");
      assert.equal(document.verification.page, 1);
      assert.ok(document.verification.printed_label.length > 5);
    }
  }
  const gold = registry.documents.find((d: Json) => d.filename === "Gold_digest_August26.pdf");
  assert.equal(gold.date, null); assert.equal(gold.date_status, "unknown");
  assert.deepEqual(gold.verification.pages_checked, [1,2,3,4,5,6,7,8]);
});

test("real OCR returns dated RAG excerpts, resolves exact citations, and excludes future/unknown documents", async () => {
  const h = await harness();
  try {
    const current = await h.provider.rag({ query: "ключевая ставка кредит", as_of: asOf, limit: 20 }, "bank-current");
    validate("RagDataResponse", current, true); assert.ok(current.data.items.length > 0);
    for (const source of current.data.items) {
      assert.equal(source.kind, "bank"); assert.equal(source.is_mock, false);
      assert.ok(Date.parse(source.published_at) <= Date.parse(asOf));
      const page = corpus.find(p => p.document_id === source.document_id && p.page === source.page);
      assert.ok(page && page.text.includes(source.excerpt));
      assert.equal(source.url, page.url);
    }
    const ids = current.data.items.map((s: Json) => s.id);
    const resolved = await h.provider.resolve({ source_ids: ids, as_of: asOf }, "bank-resolve");
    assert.deepEqual(resolved.data.unknown_ids, []); assert.deepEqual(resolved.data.items, current.data.items);
    const policy = registry.documents.find((d: Json) => d.filename.includes("Policy_Rate"));
    const before = await h.provider.rag({ query: "ключевая ставка", as_of: "2026-09-11T12:00:00Z", limit: 20 }, "bank-intraday");
    assert.ok(before.data.items.every((s: Json) => s.document_id !== policy.document_id));
    const future = await h.provider.resolve({ source_ids: current.data.items.filter((s: Json) => s.published_at > "2026-09-01").map((s: Json) => s.id), as_of: "2026-09-01T00:00:00Z" }, "bank-future");
    assert.deepEqual(future.data.items, []);
    const past = await h.provider.rag({ query: "ставка металлургия", as_of: "2020-01-01T00:00:00Z", limit: 20 }, "before-all-documents");
    assert.deepEqual(past.data.items, []);
    const gold = corpus.find(p => p.filename === "Gold_digest_August26.pdf")!;
    const unknown = await h.provider.resolve({ source_ids: ["research:"+gold.id+":c0"], as_of: asOf }, "gold-undated");
    assert.equal(unknown.data.unknown_ids.length, 1);
  } finally { h.close(); }
});

test("reviewed primary news installs in an existing demo DB and never relabels demo or overwrites a later revision", async () => {
  const h = await harness();
  try {
    const articles = readReviewedNews(bundlePath);
    const demoCount = h.db.get("SELECT count(*) n FROM news WHERE is_demo=1")!.n;
    assert.equal(demoCount, 6);
    const result = await h.provider.search({ query: "", news_id: null, as_of: asOf, limit: 100 }, "mixed");
    for (const article of articles) {
      const event = result.data.items.find((e: Json) => e.sources.some((s: Json) => s.url === article.url));
      assert.ok(event); assert.equal(event.is_mock, false);
      assert.ok(event.sources.every((s: Json) => s.is_mock === false));
      assert.equal(event.text, article.text);
      assert.ok(event.sources.some((s: Json) => s.excerpt === article.title + "\n" + article.text));
    }
    assert.ok(result.data.items.some((e: Json) => e.is_mock === true));
    assert.equal(importReviewedNews(h.db, bundlePath).inserted, 0);
    const first = articles[0];
    const revised = saveNews(h.db, { ...first, text: first.text + "\nПроверочная последующая редакция, не часть первичного снимка.", modified: "2026-10-24T10:00:00Z" });
    await h.db.initialize();
    assert.equal(h.db.news(revised.id).text, revised.text);
    assert.equal(h.db.get("SELECT count(*) n FROM news WHERE is_demo=1")!.n, demoCount);
    // Upgrade path: an existing DB with only demo rows receives the same reviewed set.
    h.db.run("DELETE FROM news_versions WHERE news_id IN (SELECT id FROM news WHERE is_demo=0)");
    h.db.run("DELETE FROM news_metadata WHERE news_id IN (SELECT id FROM news WHERE is_demo=0)");
    h.db.run("DELETE FROM news WHERE is_demo=0");
    await h.db.initialize();
    assert.equal(h.db.get("SELECT count(*) n FROM news WHERE is_demo=0")!.n, articles.length);
  } finally { h.close(); }
});

test("corrupted reviewed source text/date or synthetic flags fail validation before import", async () => {
  const h = await harness();
  try {
    const before = h.db.get("SELECT count(*) n FROM news")!.n;
    for (const update of [{text:"Подменённый текст, который не является проверенным первоисточником."}, {published:"2026-10-01"}, {is_mock:true}]) {
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8")); Object.assign(bundle.articles[0], update);
      const file = join(h.folder, "corrupt.json"); writeFileSync(file, JSON.stringify(bundle));
      assert.throws(() => importReviewedNews(h.db, file), /Invalid reviewed/);
      assert.equal(h.db.get("SELECT count(*) n FROM news")!.n, before);
    }
  } finally { h.close(); }
});

test("reviewed real news passes gateway context/rank/analysis with exact bank quotes and no external LLM", async () => {
  const h = await harness();
  const profile = JSON.parse(readFileSync(resolve(ROOT,"contracts/v1/examples/profile-response.json"),"utf8")).data;
  const ml = new ContractClient("http://ml.test", 1000, (async (url, init) => {
    const requestId = (init!.headers as Json)["X-Request-ID"];
    if (new URL(String(url)).pathname !== "/v1/rank") return Response.json(envelope(structuredClone(profile), requestId, "mock"));
    const body = JSON.parse(String(init!.body));
    return Response.json(envelope({ company_id:body.company_id, as_of:body.as_of,
      items:body.events.map((e: Json)=>({news_id:e.news_id,event_id:e.event_id,score:0.8,score_kind:"mock",reasons:[{code:"fixture",text:"Тест ранжирования",profile_paths:["/industry"]}],warnings:["mock_ranker"]})),
      excluded_future_news_ids:[],truncated:false },requestId,"mock"));
  }) as typeof fetch);
  let generated = 0, lastInput: Json | undefined;
  const fakeModel: typeof fetch = async (_url, init) => {
    assert.ok(lastInput); generated++;
    const draft = referenceDraft({id:"rate_borrower",input:lastInput,expectations:[]});
    if (lastInput.research.items.length) {
      const source = lastInput.research.items[0], quote = source.excerpt.slice(0,180);
      draft.claims.push({kind:"bank",text:quote,quote,source_ids:[source.id]});
      draft.summary += "\n" + quote; draft.grounding.summary.push(2);
    }
    assert.ok(JSON.parse(String(init!.body)).messages.length > 0);
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(draft)}}],usage:{prompt_tokens:1,completion_tokens:1}});
  };
  const agent = new LegacyAgent({...h.settings,mode:"live",apiKey:"test-only-no-external-key"},fakeModel);
  const app = createGateway({ access: developmentAccess,ml,retrieval:h.provider,agent:{
    analyze(input,id){lastInput=input;return agent.analyze(input,id);},answer:agent.answer.bind(agent),
  }});
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const address=server.address();assert.ok(address && typeof address!=="string");
  const post=async(route:string,body:Json)=>{const response=await fetch("http://127.0.0.1:"+address.port+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await response.json() as Json;assert.equal(response.status,200,JSON.stringify(value));return value;};
  try {
    const found=await post("/v1/tools/search_news",{query:"",news_id:null,as_of:asOf,limit:100});
    let bankClaims=0;
    for(const article of readReviewedNews(bundlePath)) {
      const event=found.data.items.find((e:Json)=>e.sources.some((s:Json)=>s.url===article.url));assert.ok(event);
      const context=await post("/v1/analysis-context",{company_id:"U_A",event,as_of:asOf,audience_role:"cfo"});assert.ok(context.data);
      const result=await post("/v1/analyze",{company_id:"U_A",news_id:event.news_id,as_of:asOf,audience_role:"cfo"});
      validate("AnalysisResponse",result,true);validateAnalysis(result.data);
      const source=result.data.sources.find((s:Json)=>s.url===article.url);
      assert.ok(source);assert.equal(source.is_mock,false);assert.equal(source.excerpt,article.title+"\n"+article.text);
      for(const claim of result.data.claims.filter((c:Json)=>c.kind==="bank")) {
        bankClaims++;
        const bank=result.data.sources.find((s:Json)=>s.id===claim.source_ids[0]);
        assert.equal(bank.kind,"bank");assert.ok(bank.published_at);assert.ok(bank.excerpt.includes(claim.quote));assert.equal(claim.text,claim.quote);
      }
    }
    assert.equal(generated,readReviewedNews(bundlePath).length);assert.ok(bankClaims>0);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));h.close();}
});

test("production retrieval excludes synthetic seeds before limit and cannot resolve their source IDs", async () => {
  const h = await harness();
  try {
    const provider = new LegacyRetrieval(h.db, new Retrieval(h.db), h.settings, undefined, false);
    const mixed = await h.provider.search({query:"",as_of:asOf,limit:100},"mixed");
    const synthetic = mixed.data.items.filter((e:Json)=>e.is_mock).flatMap((e:Json)=>e.sources.map((s:Json)=>s.id));
    assert.ok(synthetic.length);
    const all = await provider.search({query:"",as_of:asOf,limit:100},"production");
    assert.ok(all.data.items.length);assert.equal(all.meta.mode,"live");
    assert.ok(all.data.items.every((e:Json)=>!e.is_mock && e.sources.every((s:Json)=>!s.is_mock)));
    const short = await provider.search({query:"",as_of:asOf,limit:1},"limited");
    assert.deepEqual(short.data.items,all.data.items.slice(0,1));
    const denied = await provider.resolve({source_ids:synthetic,as_of:asOf},"denied");
    assert.deepEqual(denied.data.items,[]);assert.deepEqual(denied.data.unknown_ids,synthetic);
  } finally {h.close();}
});
