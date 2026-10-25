import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../../config.js";
import { Store } from "../../db.js";
import { saveNews } from "../../news.js";
import { articleToEvent, clusterEvents, validateEventDetails } from "../../news-events.js";
import type { Retrieval } from "../../retrieval.js";
import { LegacyRetrieval } from "../retrieval.js";
import { NewsCollector } from "../../news-collector.js";
import { validate } from "../contracts.js";

const summary="23 октября 2026 года Банк России сохранил ключевую ставку на уровне 14% годовых.";
const full=summary+" Регулятор оценил инфляцию и условия кредитования предприятий. Стоимость финансирования зависит от условий действующего договора и графика пересмотра ставки. Следующее заседание состоится после публикации новых экономических данных.";
function fixture(){
  const path=mkdtempSync(join(tmpdir(),"alfa-live-cluster-")),settings={dbPath:join(path,"test.sqlite"),feeds:["https://www.cbr.ru/rss/RssPress"]} as Settings;
  const db=new Store(settings);db.connection.exec(`CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER);
    CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT);
    CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));`);
  return {db,settings,retrieval:new LegacyRetrieval(db,{} as Retrieval,settings),close(){db.close();rmSync(path,{recursive:true,force:true})}};
}
const early={title:"Решение по ключевой ставке",text:summary,url:"https://www.finam.ru/publications/item/key-rate",published:"2026-10-23T10:00:00Z",content_scope:"feed_excerpt"};
const official={title:"Банк России сохранил ключевую ставку",text:full,url:"https://www.cbr.ru/press/key-rate",published:"2026-10-23T10:30:00Z",content_scope:"article_full",feed_url:"https://www.cbr.ru/rss/RssPress"};

test("complete official CBR evidence replaces an earlier teaser while first announcement and sources remain",()=>{
  const f=fixture();try{
    const first=saveNews(f.db,early),cbr=saveNews(f.db,official),event=clusterEvents([articleToEvent(first)!,articleToEvent(cbr)!])[0];
    assert.equal(event.news_id,first.id);assert.equal(event.published_at,"2026-10-23T10:00:00.000Z");assert.equal(event.text,full);assert.equal(event.title,official.title);assert.equal(event.content.scope,"article_full");assert.equal(event.sources.length,2);
    assert.ok(event.content.warnings.includes("cluster_has_partial_secondary_sources"));assert.ok(!event.content.warnings.includes("rss_excerpt_only_full_article_not_fetched"));
    validate("Event",event,true);validateEventDetails(event);
    // A long complete media report still does not displace the official decision.
    const media=articleToEvent({...first,content_scope:"article_full",text:full.repeat(3)})!;
    assert.equal(clusterEvents([media,articleToEvent(cbr)!])[0].text,full);
  }finally{f.close()}
});
test("single-news worker lookup returns the exact cluster revision and keeps requested logical ID",async()=>{
  const f=fixture();try{
    const first=saveNews(f.db,early),cbr=saveNews(f.db,official);
    const list=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",query:"",limit:100},"list");
    const direct=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",query:"",limit:1,news_id:first.id},"direct");
    assert.deepEqual(direct.data.items[0],list.data.items[0]);
    const byCbr=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",query:"",limit:1,news_id:cbr.id},"official");
    assert.equal(byCbr.data.items[0].news_id,cbr.id);assert.equal(byCbr.data.items[0].content.material_revision,list.data.items[0].content.material_revision);assert.equal(byCbr.data.items[0].sources.length,2);
  }finally{f.close()}
});
test("a secondary article correction changes aggregate material revision, cosmetic changes do not",async()=>{
  const f=fixture();try{
    const first=saveNews(f.db,early);saveNews(f.db,official);
    const query={as_of:"2026-10-25T20:00:00Z",query:"",limit:1,news_id:first.id};
    const before=(await f.retrieval.search(query,"before")).data.items[0];
    const revised={...early,text:summary+" Исправление: предыдущее заседание состоялось 12 сентября.",modified:"2026-10-24T10:00:00Z"};
    saveNews(f.db,revised);
    const after=(await f.retrieval.search(query,"after")).data.items[0];
    assert.equal(after.news_id,before.news_id);assert.equal(after.event_id,before.event_id);assert.notEqual(after.content.material_revision,before.content.material_revision);assert.equal(after.text,full);
    saveNews(f.db,{...revised,text:revised.text.replaceAll(" ","  "),modified:"2026-10-24T11:00:00Z"});
    const cosmetic=(await f.retrieval.search(query,"cosmetic")).data.items[0];assert.equal(cosmetic.content.material_revision,after.content.material_revision);
    assert.notEqual(cosmetic.content.version_id,after.content.version_id,"exact citation snapshots still change");
  }finally{f.close()}
});
test("legacy articles without ingestion metadata retain their previous Event shape",()=>{
  const event=articleToEvent({id:"legacy",title:official.title,text:full,url:official.url,published:official.published,is_demo:false})!;
  assert.equal("content" in event,false);
});
test("publication-window filtering retains complete cluster evidence and never refreshes old story age",async()=>{
  const f=fixture();try{
    const older=saveNews(f.db,{...early,published:"2026-10-22T10:00:00Z"});saveNews(f.db,official);
    const window=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",since:"2026-10-22T00:00:00Z",query:"",limit:100},"window");
    const direct=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",query:"",news_id:older.id,limit:1},"known");
    const reprint=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",since:"2026-10-23T00:00:00Z",query:"",limit:100},"reprint");
    assert.equal(reprint.data.items.length,0,"later reporting does not rejuvenate the original event");
    assert.deepEqual(window.data.items[0],direct.data.items[0]);assert.equal(window.data.items[0].sources.length,2);
    saveNews(f.db,{...official,text:full+" Новое уточнение решения.",modified:"2026-10-24T10:00:00Z"});
    const after=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",since:"2026-10-24T00:00:00Z",query:"",limit:100},"old");
    assert.equal(after.data.items.length,0,"article download/correction must not make an old event fresh");
    const known=await f.retrieval.search({as_of:"2026-10-25T20:00:00Z",query:"",news_id:older.id,limit:1},"known-revision");
    assert.equal(known.data.items.length,1);assert.notEqual(known.data.items[0].content.material_revision,direct.data.items[0].content.material_revision);
  }finally{f.close()}
});
test("collector status distinguishes full articles, excerpts, discovery backlog and extraction failures",async()=>{
  const f=fixture(),collector=new NewsCollector(f.settings,f.db);
  try{
    saveNews(f.db,official);saveNews(f.db,{...early,feed_url:official.feed_url});
    f.db.run("INSERT INTO news_article_backlog VALUES(?,?,?,?,?,?,?)",early.url,official.feed_url,JSON.stringify(early),1,1,0,"HTTP 403");
    const status=collector.status();assert.equal(status.feeds[0].article_count,2);assert.equal(status.feeds[0].full_text_count,1);assert.equal(status.feeds[0].excerpt_count,1);assert.equal(status.feeds[0].discovered_count,1);assert.equal(status.feeds[0].pending_full_text_count,1);assert.equal(status.feeds[0].full_text_errors,1);validate("FeedStatusData",status,true);
  }finally{await collector.stop();f.close()}
});
test("a corrected future publication leaves quarantine only from observation time",async()=>{
  const f=fixture();try{
    const quarantined=saveNews(f.db,{...official,published:"2999-01-01T10:00:00Z"});assert.equal(quarantined.date_status,"future");
    const corrected=saveNews(f.db,official);assert.equal(corrected.id,quarantined.id);assert.equal(corrected.date_status,"valid");assert.equal(corrected.ingestion_status,"updated");assert.equal(corrected.published,"2026-10-23T10:30:00.000Z");assert.equal(corrected.published_raw,official.published);
    assert.ok(corrected.warnings.includes("future_publication_date_corrected_available_from_fetch"));assert.equal(corrected.available_at,corrected.fetched_at);
    const historical=await f.retrieval.search({as_of:"2026-10-23T12:00:00Z",query:"",limit:100},"before-correction");assert.equal(historical.data.items.length,0);
    const future=await f.retrieval.search({as_of:"2999-01-02T12:00:00Z",query:"",limit:100},"after-original-date");assert.equal(future.data.items[0].sources[0].id,corrected.source_id,"quarantined future snapshot never becomes current again");
    const polled=saveNews(f.db,official);assert.equal(polled.ingestion_status,"duplicate");assert.equal(polled.source_id,corrected.source_id);
  }finally{f.close()}
});
test("publisher canonical URL changes preserve article identity and immutable source history",()=>{
  const f=fixture();try{
    const original="https://www.cbr.ru/press/rss-link",first=saveNews(f.db,{...official,original_url:original});
    const changed=saveNews(f.db,{...official,url:"https://www.cbr.ru/press/correct-canonical",original_url:original});
    assert.equal(changed.id,first.id);assert.equal(changed.ingestion_status,"updated");assert.equal(changed.material_version_id,first.material_version_id);assert.notEqual(changed.source_id,first.source_id);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news")!.n,1);assert.equal(f.db.get("SELECT COUNT(*) n FROM news_versions")!.n,2);
    const polled=saveNews(f.db,{...official,url:changed.url,original_url:original});assert.equal(polled.source_id,changed.source_id);assert.equal(polled.ingestion_status,"duplicate");
  }finally{f.close()}
});
test("equal-text excerpt to full-article upgrade becomes visible without a fake material change",async()=>{
  const f=fixture();try{
    const excerpt=saveNews(f.db,{...official,content_scope:"feed_excerpt"}),complete=saveNews(f.db,official);
    assert.equal(complete.material_version_id,excerpt.material_version_id);assert.equal(complete.material_revision,false);assert.notEqual(complete.source_id,excerpt.source_id);assert.equal(complete.ingestion_status,"updated");assert.equal(complete.available_at,complete.fetched_at);
    const before=await f.retrieval.search({as_of:"2026-10-23T11:00:00Z",query:"",limit:1,news_id:excerpt.id},"before-verification");assert.equal(before.data.items[0].content.scope,"feed_excerpt");
    const now=await f.retrieval.search({as_of:new Date(Date.now()+1000).toISOString(),query:"",limit:1,news_id:excerpt.id},"after-verification");assert.equal(now.data.items[0].content.scope,"article_full");assert.ok(!now.data.items[0].content.warnings.includes("rss_excerpt_only_full_article_not_fetched"));
    assert.equal(now.data.items[0].content.material_revision,before.data.items[0].content.material_revision);
  }finally{f.close()}
});
