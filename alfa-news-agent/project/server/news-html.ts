import { parse } from "parse5";
import { AppError, type Json } from "./types.js";
import { safeNewsUrl } from "./news-http.js";

type Node = { nodeName?: string; tagName?: string; value?: string; attrs?: {name:string;value:string}[]; childNodes?: Node[]; parentNode?: Node };
const attr = (node: Node, name: string): string => node.attrs?.find(a => a.name === name)?.value ?? "";
const walk = (node: Node): Node[] => [node, ...(node.childNodes ?? []).flatMap(walk)];
export const htmlDocument = (html: string): Node => parse(html) as Node;
function match(node: Node, selector: string): boolean {
  const tag = selector.match(/^[\w-]+/)?.[0], id = selector.match(/#([\w-]+)/)?.[1];
  if (!node.tagName || tag && node.tagName !== tag.toLowerCase() || id && attr(node,"id") !== id) return false;
  for (const cls of selector.matchAll(/\.([\w-]+)/g)) if (!attr(node,"class").split(/\s+/).includes(cls[1])) return false;
  for (const prop of selector.matchAll(/\[([\w:-]+)(?:\s*=\s*["']?([^\]"']+)["']?)?\]/g)) {
    if (!node.attrs?.some(a => a.name === prop[1]) || prop[2] && attr(node,prop[1]) !== prop[2]) return false;
  }
  return true;
}
/** Intentionally limited selector language: tag, .class, #id, [attribute], descendants and commas. */
export function selectHtml(node: Node, selectors: string): Node[] {
  const result = new Set<Node>();
  for (const selector of selectors.split(",").map(s => s.trim()).filter(Boolean)) {
    const parts = selector.match(/(?:[^\s\[]|\[[^\]]*\])+/g) ?? [];
    for (const candidate of walk(node)) {
      if (!match(candidate,parts.at(-1) ?? "")) continue;
      let ancestor = candidate.parentNode, index = parts.length - 2;
      while (ancestor && index >= 0) { if (match(ancestor,parts[index])) index--; ancestor = ancestor.parentNode; }
      if (index < 0) result.add(candidate);
    }
  }
  return [...result];
}
export function htmlText(node: Node): string {
  if (["script","style","nav","header","footer","aside","form","button","noscript","svg"].includes(node.tagName ?? "")) return "";
  if (attr(node,"aria-hidden") === "true" || node.attrs?.some(a => a.name === "hidden") || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node,"style"))) return "";
  if (/(?:^|\s)(?:share|social-share|related-articles|recommended|advertisement|ads)(?:\s|$)/i.test(attr(node,"class"))) return "";
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(htmlText).join(" ").replace(/\s+/g," ").trim();
}
const rawText = (node: Node): string => node.value ?? (node.childNodes ?? []).map(rawText).join("");
export function metadataHtml(doc: Node, names: string[]): string {
  for (const node of selectHtml(doc,"meta")) if (names.includes(attr(node,"property")) || names.includes(attr(node,"name")) || names.includes(attr(node,"itemprop"))) {
    const value = attr(node,"content").trim(); if (value) return value;
  }
  return "";
}
function structuredArticles(doc: Node): Json[] {
  const results: Json[] = [];
  const inspect = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (!value || typeof value !== "object") return;
    const obj = value as Json, types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
    if (types.some((type:unknown) => ["Article","NewsArticle","ReportageNewsArticle","BlogPosting"].includes(String(type)))) results.push(obj);
    if (obj["@graph"]) inspect(obj["@graph"]);
  };
  for (const script of selectHtml(doc,'script[type="application/ld+json"]')) try { inspect(JSON.parse(rawText(script))); } catch { /* Bad publisher JSON cannot establish evidence. */ }
  return results;
}
export interface ArticleExtraction { title: string; text: string; url: string; published: string; modified: string; extraction_method: string }
export function extractArticleHtml(html: string, url: string, hosts: string[], selectors: string[] = []): ArticleExtraction {
  const doc = htmlDocument(html), records = structuredArticles(doc);
  if (records.some(r => r.isAccessibleForFree === false || r.isAccessibleForFree === "false")) throw new AppError("Статья ограничена подпиской; полный текст недоступен",502);
  const record = records.find(r => typeof r.articleBody === "string" && r.articleBody.length >= 200) ?? records[0] ?? {};
  const canonical = selectHtml(doc,'link[rel="canonical"]')[0];
  const original = canonical && attr(canonical,"href") ? safeNewsUrl(new URL(attr(canonical,"href"),url).toString(),hosts).toString() : url;
  let text = typeof record.articleBody === "string" ? htmlText(htmlDocument(record.articleBody)) : "", method = "jsonld_articleBody";
  if (text.length < 200) {
    text = "";
    for (const selector of [...selectors,'[itemprop="articleBody"]',"article"]) {
      const candidates = selectHtml(doc,selector).map(htmlText).sort((a,b) => b.length-a.length);
      if (candidates[0]?.length >= 200) { text = candidates[0]; method = "html:" + selector; break; }
    }
  }
  // Never promote the whole page/nav or a meta description to full article evidence.
  if (text.length < 200) throw new AppError("Не удалось извлечь достаточный полный текст статьи",502);
  const title = String(record.headline ?? metadataHtml(doc,["og:title","twitter:title"]) ?? "") || htmlText(selectHtml(doc,"h1")[0] ?? doc);
  const published = String(record.datePublished ?? metadataHtml(doc,["article:published_time","datePublished","publish_date","pubdate"]) ?? "") || attr(selectHtml(doc,"time[datetime]")[0] ?? {},"datetime");
  const modified = String(record.dateModified ?? metadataHtml(doc,["article:modified_time","dateModified"]) ?? "");
  return { title: title.trim(), text, url: original, published, modified, extraction_method: method };
}
export interface HtmlListingOptions { itemSelector: string; linkSelector?: string; titleSelector?: string; dateSelector?: string; linkPattern?: string }
export function extractHtmlListing(html: string, url: string, hosts: string[], options: HtmlListingOptions): Json[] {
  const doc = htmlDocument(html), seen = new Set<string>(), rows: Json[] = [];
  for (const item of selectHtml(doc,options.itemSelector).slice(0,200)) {
    const link = options.linkSelector ? selectHtml(item,options.linkSelector)[0] : item.tagName === "a" ? item : selectHtml(item,"a")[0];
    if (!link || !attr(link,"href")) continue;
    try {
      const target = safeNewsUrl(new URL(attr(link,"href"),url).toString(),hosts).toString();
      if (seen.has(target) || options.linkPattern && !new RegExp(options.linkPattern).test(new URL(target).pathname)) continue;
      seen.add(target);
      const titleNode = options.titleSelector ? selectHtml(item,options.titleSelector)[0] : link;
      const dateNode = options.dateSelector ? selectHtml(item,options.dateSelector)[0] : undefined;
      let published = dateNode ? attr(dateNode,"datetime") || htmlText(dateNode) : "";
      const ruDate = published.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
      if (ruDate) published = `${ruDate[3]}-${ruDate[2]}-${ruDate[1]}`;
      const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
      const wordDate = published.toLowerCase().match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/);
      if (wordDate) published = `${wordDate[3]}-${String(months.indexOf(wordDate[2])+1).padStart(2,"0")}-${wordDate[1].padStart(2,"0")}`;
      rows.push({ title: titleNode ? htmlText(titleNode) : "", text: "", url: target, published, feed_url: url, content_scope: "feed_excerpt" });
    } catch { /* A listing is untrusted: reject off-site/private links individually. */ }
  }
  return rows;
}
