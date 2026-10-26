/** Export reproducible extraction inputs/results without reading labels or weights.
 * The script uses stdlib; the repository's existing tsx loader resolves internal
 * .js import specifiers to .ts sources:
 * node --import tsx scripts/extract_personalization_events.ts --mode curated --input ... --out ...
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { articleToEvent, extractEventDetails, normalizePublicationDate, validateEventDetails } from "../server/news-events.ts";

type RecordValue = Record<string, any>;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!["--mode", "--input", "--out"].includes(args[i]) || !args[i + 1] || options.has(args[i]))
    throw new Error("Usage: --mode curated|articles --input INPUT.json --out OUTPUT.json");
  options.set(args[i], args[i + 1]);
}
const mode = options.get("--mode"), inputPath = options.get("--input"), outputPath = options.get("--out");
if (!["curated", "articles"].includes(mode ?? "") || !inputPath || !outputPath)
  throw new Error("--mode curated|articles, --input and --out are required");
if (resolve(inputPath) === resolve(outputPath)) throw new Error("Output must not overwrite frozen extraction input");

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing " + name);
  return value;
}

function publication(value: unknown): string {
  const normalized = normalizePublicationDate(value);
  if (!normalized.value) throw new Error("Missing or invalid publication date; audit must not replace it with now");
  return normalized.value;
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Invalid " + name);
  return [...value];
}

function curatedEvent(input: RecordValue): RecordValue {
  if (input.is_mock || !Array.isArray(input.sources) || !input.sources.length) throw new Error("Expected real source-backed event");
  const published = publication(input.published_at);
  const title = requiredString(input.title, "title");
  const sources = input.sources.map((source: RecordValue) => {
    if (source.is_mock) throw new Error("Mock source in real-news audit");
    const url = requiredString(source.url, "source URL"), excerpt = requiredString(source.excerpt, "source excerpt");
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("HTTP(S) source URL required");
    return { id: "audit:" + sha256(url + "\n" + excerpt).slice(0, 24), kind: "news", title,
      url, excerpt, document_id: null, page: null,
      published_at: source.published_at ? publication(source.published_at) : published, is_mock: false };
  });
  // Exact public Event/Evidence whitelist. In particular, semantic_context,
  // research_context, target labels and previously annotated event_details are absent.
  const event: RecordValue = { news_id: requiredString(input.news_id, "news_id"), event_id: requiredString(input.event_id, "event_id"),
    title, text: sources.map((source: RecordValue) => source.excerpt).join("\n"),
    event_type: requiredString(input.event_type, "event_type"), published_at: published,
    event_at: input.event_at ? publication(input.event_at) : null, fact_status: input.fact_status ?? "reported",
    okved_divisions: strings(input.okved_divisions, "okved_divisions"), countries: strings(input.countries, "countries"),
    regions: strings(input.regions, "regions"), company_ids: strings(input.company_ids, "company_ids"),
    entity_mapping_source: input.entity_mapping_source ?? null, sources, is_mock: false };
  if (input.split_group_id) event.split_group_id = requiredString(input.split_group_id, "split_group_id");
  return event;
}

const inputBytes = readFileSync(inputPath);
const inputs: RecordValue[] = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(inputs) || !inputs.length) throw new Error("Input must be a nonempty array");
const seen = new Set<string>();
const records = inputs.map(input => {
  let before: RecordValue, after: RecordValue;
  if (mode === "curated") {
    before = curatedEvent(input);
    after = extractEventDetails(before);
  } else {
    if (input.is_mock || input.is_demo) throw new Error("Mock article in real-news audit");
    const id = requiredString(input.article_id, "article_id");
    // Never pass manual types, industry tags, semantic metadata or labels through.
    const article = { id, title: requiredString(input.title, "title"), text: requiredString(input.text, "text"),
      url: requiredString(input.url, "URL"), published: publication(input.published_at), is_demo: false,
      source_id: "audit:" + sha256(input.url + "\n" + input.text).slice(0, 24) };
    const extracted = articleToEvent(article);
    if (!extracted) throw new Error("Article rejected: " + id);
    after = extracted;
    // Historical raw-RSS adapter behaviour: other, no typed dimensions. Its
    // sources are retained, but extracted fields/identity must not leak into it.
    before = { news_id: id, event_id: id, title: article.title, text: article.text,
      event_type: "other", published_at: article.published, event_at: null, fact_status: "reported",
      okved_divisions: [], countries: [], regions: [], company_ids: [], entity_mapping_source: null,
      sources: structuredClone(after.sources), is_mock: false };
  }
  if (seen.has(before.news_id)) throw new Error("Duplicate news_id: " + before.news_id);
  seen.add(before.news_id);
  validateEventDetails(after);
  return { news_id: before.news_id, before, after };
});
const output = {
  schema_version: "personalization_extraction_v1", mode, input_sha256: sha256(inputBytes),
  extractor_sha256: sha256(readFileSync(new URL("../server/news-events.ts", import.meta.url))),
  taxonomy_sha256: sha256(readFileSync(new URL("../server/news-subjects.ts", import.meta.url))),
  exporter_sha256: sha256(readFileSync(new URL(import.meta.url))),
  source_availability_policy: "preserve explicit source date, otherwise inherit conservative event publication date",
  limitation: "Actual historical source facts, but text is an AI factual paraphrase; this is not an original full-text extraction benchmark.",
  records,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ mode, events: records.length, with_details: records.filter(row => row.after.event_details).length,
  non_other_after: records.filter(row => row.after.event_type !== "other").length, output: outputPath }));
