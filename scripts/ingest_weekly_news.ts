/** Exercise the actual SQLite ingestion/retrieval path on downloaded primary articles.
 * All original text and the temporary database stay under the explicitly chosen cache.
 * This script never invokes an LLM or imports demo company/news fixtures.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const options = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!["--input", "--out", "--module-root", "--as-of"].includes(args[i]) || !args[i + 1] || options.has(args[i]))
    throw new Error("Usage: --input articles.json --out PRIVATE/events.json [--module-root ROOT] [--as-of ISO]");
  options.set(args[i], args[i + 1]);
}
if (!options.has("--input") || !options.has("--out")) throw new Error("Input and private output are required");
const inputPath = resolve(options.get("--input")!), outputPath = resolve(options.get("--out")!);
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const privateRoot = join(root, "var");
// Resolve existing ancestors too: a symlink under var/ must not export source
// excerpts into a public data/ directory or overwrite the input corpus.
function canonicalPath(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}
const realOutput = canonicalPath(outputPath), inside = relative(privateRoot, realOutput);
if (!inside || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || isAbsolute(inside))
  throw new Error("Full source text output must stay under ignored repository var/.");
if (canonicalPath(inputPath) === realOutput) throw new Error("Do not overwrite the source corpus");
const moduleRoot = resolve(options.get("--module-root") ?? ".");
const importSource = (name: string) => import(pathToFileURL(join(moduleRoot, "server", name)).href);
const { loadSettings } = await importSource("config.ts");
const { Store } = await importSource("db.ts");
const { Retrieval } = await importSource("retrieval.ts");
const { LegacyRetrieval } = await importSource("integration/retrieval.ts");
const inputBytes = readFileSync(inputPath), articles = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(articles) || !articles.length || articles.length > 100) throw new Error("Expected 1..100 articles");
if (new Set(articles.map(a => a.article_id)).size !== articles.length) throw new Error("Duplicate corpus ID");
mkdirSync(dirname(outputPath), { recursive: true });
const temp = mkdtempSync(join(dirname(outputPath), "ingestion-"));
const settings = { ...loadSettings(), apiKey: "", dbPath: join(temp, "news.sqlite3"), feeds: [] };
const db = new Store(settings);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
try {
  // News-only store: company profiles come from the read-only Python store below.
  db.connection.exec("CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER); CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT); CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT); CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));");
  const provider = new LegacyRetrieval(db, new Retrieval(db), settings);
  const mappings: any[] = [];
  for (const article of articles) {
    if (article.text_kind !== "primary_article_text" || article.is_mock) throw new Error("Original real article required");
    if (article.content_sha256 !== hash(article.text)) throw new Error("Source content hash mismatch");
    const body = { title: article.title, text: article.text, url: article.url, published: article.published_at };
    const first = (await provider.ingest(body, "weekly-import")).data;
    if (first.date_status !== "valid" || !first.item) throw new Error("Article not eligible: " + article.article_id);
    const tracking = new URL(article.url); tracking.searchParams.set("utm_source", "audit-repeat");
    const repeat = (await provider.ingest({ ...body, url: tracking.href }, "weekly-repeat")).data;
    if (repeat.news_id !== first.news_id || repeat.ingestion_status !== "duplicate") throw new Error("Duplicate import created a different item");
    mappings.push({ article_id: article.article_id, news_id: first.news_id, url: article.url,
      content_sha256: article.content_sha256, ingestion_status: first.ingestion_status,
      repeat_status: repeat.ingestion_status, date_status: first.date_status, warnings: first.warnings });
  }
  const asOf = options.get("--as-of") ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("Invalid as_of");
  const result = await provider.search({ company_id: "audit", as_of: asOf, query: "", limit: 100 }, "weekly-search");
  const events = result.data.items;
  const ids = [...new Set(events.flatMap((e: any) => e.sources.map((s: any) => s.id)))];
  const resolved = (await provider.resolve({ source_ids: ids, as_of: asOf }, "weekly-sources")).data;
  if (resolved.unknown_ids.length || resolved.items.length !== ids.length) throw new Error("Source resolution incomplete");
  const registry = new Map(resolved.items.map((s: any) => [s.id, s]));
  for (const event of events) for (const source of event.sources) {
    if ((registry.get(source.id) as any)?.excerpt !== source.excerpt) throw new Error("Resolved evidence changed");
  }
  const beforeWeek = "2026-10-18T20:59:59.999Z";
  const earlier = (await provider.search({ company_id: "audit", as_of: beforeWeek, query: "", limit: 100 }, "weekly-past")).data.items;
  if (earlier.length) throw new Error("Future publication leaked into pre-week selection");
  const codeHashes = Object.fromEntries(["news.ts", "news-events.ts", "news-subjects.ts", "integration/retrieval.ts"].map(n => ["server/" + n, hash(readFileSync(join(moduleRoot, "server", n)))]));
  const output = { schema_version: "weekly_news_ingestion_v1", as_of: asOf, input_sha256: hash(inputBytes), code_hashes: codeHashes,
    input_kind: "original_primary_article_text", articles: mappings, events,
    checks: { imported: mappings.length, repeated_imports: mappings.length, stored_articles: db.get("SELECT count(*) n FROM news").n,
      returned_events: events.length, resolved_sources: ids.length, publications_before_week: earlier.length, llm_calls: 0 } };
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output.checks));
} finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
