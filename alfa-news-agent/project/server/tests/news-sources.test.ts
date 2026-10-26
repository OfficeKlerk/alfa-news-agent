import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../db.js";
import type { Settings } from "../config.js";
import { NewsHttp, publicAddress, robotsAllowed, safeNewsUrl } from "../news-http.js";
import { extractArticleHtml, extractHtmlListing } from "../news-html.js";
import { NewsSourceIngestor, configuredNewsSources, parseNewsJson, parseNewsRss, type NewsSource } from "../news-sources.js";
import { saveNews } from "../news.js";

const URL = "https://news.example.org/article", FEED = "https://news.example.org/rss";
const source: NewsSource = { url:FEED, name:"Проверяемый источник", kind:"rss",hosts:["news.example.org"],articleSelectors:[".article-body"] };
const full = "Банк России опубликовал решение по ключевой ставке. Условия применения новых тарифов распространяются на новые договоры финансирования предприятий. Компаниям следует проверить сроки пересмотра ставок и действующие договоры. Изменения вступают в силу после официальной публикации решения.";
const html = (text=full) => `<html><head><meta property="article:published_time" content="2026-10-22T10:00:00+03:00"><link rel="canonical" href="${URL}"></head><body><h1>Условия кредитования компаний</h1><div class="article-body"><nav>Не включать меню</nav><div style="display: none">Скрытая ложная версия</div><p>${text}</p><div class="share">Поделиться</div></div></body></html>`;
const rss = (count=1) => `<rss><channel>${Array.from({length:count},(_,i)=>`<item><title>Условия кредитования компаний ${i}</title><description>Краткая аннотация экономической новости о кредитовании.</description><link>${URL}${i ? i : ""}</link><pubDate>Thu, 22 Oct 2026 10:00:00 +0300</pubDate></item>`).join("")}</channel></rss>`;
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"alfa-sources-")); const settings={dbPath:join(dir,"news.sqlite"),feeds:[FEED],newsFullTextEnabled:true,newsFullTextConcurrency:2} as Settings;
  const db=new Store(settings);
  db.connection.exec(`CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER);
    CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT);
    CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));`);
  return { db,settings,close(){db.close();rmSync(dir,{recursive:true,force:true})} };
}
const request = (article:()=>Response, count=1) => (async (url:any) => String(url)===FEED ? new Response(rss(count)) : String(url).endsWith("/robots.txt") ? new Response("User-agent: *\nAllow: /") : article()) as typeof fetch;
function due(db:Store) { const row=db.get("SELECT * FROM news_metadata")!;const meta=JSON.parse(row.payload);meta.full_text_next_attempt="2000-01-01T00:00:00.000Z";db.run("UPDATE news_metadata SET payload=? WHERE news_id=?",JSON.stringify(meta),row.news_id);db.run("UPDATE news_article_backlog SET next_attempt=0"); }

test("source HTTP rejects private URLs, credentials, nonstandard ports and escaped private addresses",async()=>{
  for(const url of ["http://public.example.org/a","https://127.0.0.1/a","https://2130706433/a","https://10.1.2.3/a","https://169.254.169.254/a","https://[::1]/","https://[::ffff:127.0.0.1]/","https://localhost/a","https://service.local/a","https://u:p@example.org/a","https://example.org:8443/a"]) assert.throws(()=>safeNewsUrl(url));
  for(const ip of ["127.1.2.3","192.168.0.5","172.17.0.1","100.64.0.1","192.0.2.3","2001:db8::1","2001:0000::1","2002:a00:1::"]) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress("8.8.8.8"),true);assert.equal(publicAddress("2606:4700:4700::1111"),true);
});
test("redirects stay within trusted source hosts and cannot reach the metadata service",async()=>{
  let calls=0;const transport=(async()=>{calls++;return new Response("",{status:302,headers:{location:"https://169.254.169.254/latest/meta-data/"}})}) as typeof fetch;
  await assert.rejects(new NewsHttp(transport).read(FEED,{hosts:source.hosts}));assert.equal(calls,1);
  await assert.rejects(new NewsHttp((async()=>new Response("",{status:302,headers:{location:"https://evil.example.net/article"}})) as typeof fetch).read(FEED,{hosts:source.hosts}),/доменов/);
});
test("HTTP bounds bytes and follows a bounded same-host redirect",async()=>{
  const transport=(async(url:any)=>String(url)===FEED ? new Response("",{status:302,headers:{location:"/next"}}) : new Response("ok")) as typeof fetch;
  assert.equal((await new NewsHttp(transport).read(FEED,{hosts:source.hosts})).text,"ok");
  await assert.rejects(new NewsHttp((async()=>new Response("123456")) as typeof fetch).read(FEED,{maxBytes:5}),/размер/);
});
test("robots matching honors longest rule, specific agent and query patterns",()=>{
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /private\nAllow: /private/public","/private/a"),false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /private\nAllow: /private/public","/private/public/a"),true);
  assert.equal(robotsAllowed("User-agent: *\nAllow: /\nUser-agent: AlfaNewsCollector\nDisallow: /article$","/article"),false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /*?preview=*","/article?preview=1"),false);
});
test("full text obeys robots and does not fetch a prohibited article",async()=>{
  const calls:string[]=[];
  const http=new NewsHttp((async(url:any)=>{calls.push(String(url));return new Response("User-agent: *\nDisallow: /article")}) as typeof fetch);
  await assert.rejects(http.read(URL,{hosts:source.hosts,robots:true}),/robots/);assert.deepEqual(calls,["https://news.example.org/robots.txt"]);
});
test("HTML extractor uses article evidence, excludes hidden/menu content and preserves original link/date",()=>{
  const article=extractArticleHtml(html(),URL,source.hosts,source.articleSelectors);
  assert.equal(article.text,full);assert.equal(article.title,"Условия кредитования компаний");assert.equal(article.published,"2026-10-22T10:00:00+03:00");assert.equal(article.url,URL);
  assert.throws(()=>extractArticleHtml(`<html><meta name="description" content="${full}"><nav>${full}</nav></html>`,URL,source.hosts),/полный текст/);
});
test("JSON-LD article body is accepted; paid articles and cross-domain canonicals are rejected",()=>{
  const jsonld={"@context":"https://schema.org","@type":"NewsArticle",headline:"Публичная новость",articleBody:full,datePublished:"2026-10-22T10:00:00Z"};
  assert.equal(extractArticleHtml(`<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`,URL,source.hosts).text,full);
  assert.throws(()=>extractArticleHtml(`<script type="application/ld+json">${JSON.stringify({...jsonld,isAccessibleForFree:false})}</script>`,URL,source.hosts),/подпиской/);
  assert.throws(()=>extractArticleHtml(html().replace(URL,"https://evil.example.net/a"),URL,source.hosts),/доменов/);
});
test("HTML listing extracts official date and ignores unrelated/unsafe links",()=>{
  const listing=`<div class="item"><span class="date">25 Октября 2026</span><a href="/article/10">Новая налоговая форма</a></div><div class="item"><a href="https://localhost/secret">Bad link</a></div>`;
  const rows=extractHtmlListing(listing,FEED,source.hosts,{itemSelector:".item",dateSelector:".date",linkPattern:"^/article/"});
  assert.equal(rows.length,1);assert.equal(rows[0].published,"2026-10-25");assert.equal(rows[0].url,"https://news.example.org/article/10");assert.equal(rows[0].text,"");
});
test("JSON API supports nested fields and tabular columns without inventing dates",()=>{
  const api:NewsSource={...source,kind:"json",json:{itemsPath:"news.data",columnsPath:"news.columns",fields:{title:"title",text:"body",url:"id",published:"published"},urlPrefix:"https://news.example.org/n",timezone:"+03:00"}};
  const rows=parseNewsJson(JSON.stringify({news:{columns:["id","title","body","published"],data:[[12,"Новость","<p>Подробности</p>","2026-10-22 10:00:00"]]}}),api);
  assert.equal(rows[0].url,"https://news.example.org/n12");assert.equal(rows[0].published,"2026-10-22T10:00:00+03:00");assert.equal(rows[0].text,"Подробности");
  assert.throws(()=>parseNewsJson('{"news":{}}',api),/структуру/);
});
test("RSS decodes link entities before canonicalization and does not treat Atom updated as publication",()=>{
  const rows=parseNewsRss(rss().replace(URL,URL+"?utm_source=x&amp;id=5"),source);assert.equal(rows[0].url,URL+"?utm_source=x&id=5");
  const atom=parseNewsRss('<feed><entry><title>Новость</title><summary>Описание</summary><link href="https://news.example.org/a"/><updated>2026-10-22T10:00:00Z</updated></entry></feed>',source);assert.equal(atom[0].published,"");
});
test("full article ingestion persists complete evidence, retries corrections and deduplicates stable polls",async()=>{
  const f=fixture();let text=full;
  try{
    const ingestor=new NewsSourceIngestor(f.settings,f.db,request(()=>new Response(html(text),{headers:{"content-type":"text/html"}})));
    assert.equal((await ingestor.ingest(source)).inserted,1);
    const id=f.db.get("SELECT id FROM news")!.id,first=f.db.news(id);assert.equal(first.content_scope,"article_full");assert.equal(first.text,full);
    assert.equal((await ingestor.ingest(source)).duplicates,1);assert.equal(f.db.get("SELECT COUNT(*) n FROM news_versions")!.n,1);
    due(f.db);text=full+" Дополнение: ставка составляет 18 процентов.";
    assert.equal((await ingestor.ingest(source)).updated,1);const next=f.db.news(id);assert.notEqual(next.material_version_id,first.material_version_id);assert.equal(next.material_revision,true);
    assert.equal(f.db.get("SELECT COUNT(*) n FROM news_article_documents")!.n,2);assert.equal(f.db.get("SELECT COUNT(*) n FROM news_versions")!.n,2);
  }finally{f.close()}
});
test("failed full-text refresh keeps prior complete evidence and exact citation version",async()=>{
  const f=fixture();let failed=false;
  try{const ingestor=new NewsSourceIngestor(f.settings,f.db,request(()=>failed ? new Response("",{status:503}) : new Response(html(),{headers:{"content-type":"text/html"}})));
    await ingestor.ingest(source);const id=f.db.get("SELECT id FROM news")!.id,first=f.db.news(id);due(f.db);failed=true;
    await ingestor.ingest(source);const next=f.db.news(id);assert.equal(next.source_id,first.source_id);assert.equal(next.text,full);assert.equal(next.content_scope,"article_full");assert.match(next.full_text_error,/503/);assert.ok(next.warnings.includes("full_article_refresh_failed_prior_version_retained"));
  }finally{f.close()}
});
test("failed extraction remains explicitly excerpt and article refresh cap progresses across polls",async()=>{
  const f=fixture();f.settings.newsFullTextMaxPerSource=1;let calls=0;
  try{const ingestor=new NewsSourceIngestor(f.settings,f.db,request(()=>{calls++;return new Response("<html>Short teaser</html>",{headers:{"content-type":"text/html"}})},3));
    await ingestor.ingest(source);assert.equal(calls,1);await ingestor.ingest(source);assert.equal(calls,2);await ingestor.ingest(source);assert.equal(calls,3);await ingestor.ingest(source);assert.equal(calls,3,"failed articles keep their retry deadline over repeated polls");
    const rows=f.db.all("SELECT payload FROM news_metadata").map(r=>JSON.parse(r.payload));assert.equal(rows.filter(r=>r.content_scope==="article_full").length,0);assert.ok(rows.some(r=>r.warnings.includes("full_article_fetch_failed")));
  }finally{f.close()}
});
test("material hashes ignore cosmetic spaces but retain changed numbers and full text beyond analysis cap",()=>{
  const f=fixture();try{
    const input={title:"Налоговые условия компаний",text:full,url:URL,published:"2026-10-22T10:00:00Z",content_scope:"article_full"};
    const one=saveNews(f.db,input),spaces=saveNews(f.db,{...input,text:full.replaceAll(" ","  ")});assert.equal(spaces.material_version_id,one.material_version_id);assert.equal(spaces.material_revision,false);
    const text="Сведения о налогах и тарифах. ".repeat(1000)+" Ставка 18 процентов.";const a=saveNews(f.db,{...input,text}),b=saveNews(f.db,{...input,text:text.replace("18 процентов","19 процентов")});
    assert.equal(a.text,b.text);assert.notEqual(a.material_version_id,b.material_version_id);assert.notEqual(a.source_id,b.source_id);assert.equal(b.material_revision,true);assert.ok(b.warnings.includes("source_text_truncated_18000"));
  }finally{f.close()}
});
test("configured feeds are not silently truncated to five",()=>{
  const sources=configuredNewsSources({feeds:Array.from({length:12},(_,i)=>`https://source${i}.example.org/rss`)} as Settings);assert.equal(sources.length,12);
});
test("unfetched short teasers survive restart and leaving the RSS window",async()=>{
  const f=fixture();f.settings.newsFullTextMaxPerSource=1;let first=true;let reopened:Store|undefined;
  const transport=(async(url:any)=>{
    if(String(url)===FEED)return new Response(rss(first ? 2 : 1).replaceAll("Краткая аннотация экономической новости о кредитовании.",""));
    if(String(url).endsWith("/robots.txt"))return new Response("User-agent: *\nAllow: /");
    return new Response(html().replace(`href="${URL}"`,`href="${String(url)}"`),{headers:{"content-type":"text/html"}});
  }) as typeof fetch;
  try{
    await new NewsSourceIngestor(f.settings,f.db,transport).ingest(source);assert.equal(f.db.get("SELECT COUNT(*) n FROM news_article_backlog")!.n,2);assert.equal(f.db.get("SELECT COUNT(*) n FROM news")!.n,1);
    first=false;reopened=new Store(f.settings);await new NewsSourceIngestor(f.settings,reopened,transport).ingest(source);
    assert.equal(reopened.get("SELECT COUNT(*) n FROM news")!.n,2);assert.equal(reopened.get("SELECT COUNT(*) n FROM news WHERE url=?",URL+"1")!.n,1);
  }finally{reopened?.close();f.close()}
});
