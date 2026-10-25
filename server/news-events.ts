import { createHash } from "node:crypto";
import type { Json, News } from "./types.js";
import type { Store } from "./db.js";
import { ceremonialReport, classifyBusinessSubjects, generalTaxScope, SUBJECT_TAXONOMY_VERSION } from "./news-subjects.js";

export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
export function canonicalUrl(value: string): string {
  if (!value) return "";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP(S) URL required");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

/** Only explicit ISO/RFC timestamps or calendar dates; never the ingestion clock. */
export function normalizePublicationDate(input: unknown): { value: string | null; status: "valid" | "missing" | "invalid"; precision: "instant" | "day" | "unknown" } {
  if (input === undefined || input === null || input === "") return { value: null, status: "missing", precision: "unknown" };
  if (typeof input !== "string") return { value: null, status: "invalid", precision: "unknown" };
  const text = input.trim();
  if (!text) return { value: null, status: "missing", precision: "unknown" };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  const rfc = /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|UT|UTC|GMT)$/i.test(text);
  const ms = (day || iso || rfc) ? Date.parse(day ? text + "T23:59:59.999Z" : text) : NaN;
  // Date.parse silently rolls over impossible dates such as February 30.
  let calendarValid = true;
  if (day || iso) {
    const [year, month, date] = text.slice(0, 10).split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, date));
    calendarValid = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === date;
    if (iso) {
      const [hour, minute, second] = text.slice(11, 19).split(":").map(Number);
      calendarValid = calendarValid && hour < 24 && minute < 60 && second < 60;
    }
  } else if (rfc) {
    const match = text.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/)!;
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[2].toLowerCase());
    const check = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
    calendarValid = month >= 0 && check.getUTCMonth() === month && check.getUTCDate() === Number(match[1]);
    const time = text.match(/\s(\d{2}):(\d{2})(?::(\d{2}))?\s/)!;
    calendarValid = calendarValid && Number(time[1]) < 24 && Number(time[2]) < 60 && Number(time[3] ?? 0) < 60;
  }
  return Number.isFinite(ms) && calendarValid ? { value: new Date(ms).toISOString(), status: "valid", precision: day ? "day" : "instant" }
    : { value: null, status: "invalid", precision: "unknown" };
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function calendarDate(text: string): string | null {
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const startOfDay = (value: string | null) => value ? value.slice(0, 10) + "T00:00:00.000Z" : null;
  if (iso) return startOfDay(normalizePublicationDate(iso[0]).value);
  const ru = text.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i);
  return ru ? startOfDay(normalizePublicationDate(`${ru[3]}-${String(MONTHS.indexOf(ru[2].toLowerCase()) + 1).padStart(2, "0")}-${ru[1].padStart(2, "0")}`).value) : null;
}

/** Keep evidence as exact substrings while separating unrelated clauses and numbers. */
function clauses(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])|\n+|;\s*|,\s+(?=(?:а|но|однако|тогда как|при этом)\s)/)
    .map(value => value.trim()).filter(Boolean);
}
const speculative = (text: string) => /(?:может|могут|ожидается|ожидают|прогноз|предполага|планирует|обсуждает|возможно|предложил|якобы|слух|(?:^|\s)если\s|\?)/i.test(text);
const denied = (text: string) => /(?:опроверг|недостовер|оказал[а-я]*\s+ложн|фейк|(?:^|\s)не\s+(?:(?:будет|будут|стал[аио]?)\s+)?(?:сниз|повыс|увелич|ввел|введ|ввод|огранич|отмен|измен|продл|установ|утверд|приня|действ|примен|распространя|каса|подтверд))/i.test(text);
const excludedScope = (text: string) => /(?:не\s+(?:применя|распространя|каса|затрагива|участв|относи)|за\s+исключением|кроме\s|исключен[а-я]*\s+из)/i.test(text);
type RateObservation = { quote: string; direction: string; magnitude: number | null; level: number | null; date: string | null; forecast: boolean };
function rateObservation(quote: string): RateObservation | null {
  const lower = quote.toLowerCase().replaceAll("ё", "е").replace(/\s+/g," ");
  if (denied(lower)) return null;
  const issuer = "(?:совет директоров банка россии|банк россии|цб(?: рф)?)";
  const date = "(?:\\d{1,2}\\s+(?:" + MONTHS.join("|") + ")\\s+\\d{4}(?:\\s+года)?)";
  const action = "(?:снизил[аио]?|понизил[аио]?|повысил[аио]?|увеличил[аио]?|сохранил[аио]?|оставил[аио]?|решил[аио]?\\s+(?:снизить|повысить|сохранить|оставить)|принял\\s+решение\\s+(?:снизить|повысить|сохранить|оставить))";
  // The issuer must directly perform the action. "CBR said that another bank..."
  // must not attach that other bank's action or numeric delta to the CBR.
  const match = new RegExp(issuer + "\\s+(?:" + date + "\\s+)?(?:сегодня\\s+)?(" + action + ")\\s+ключев[а-я]*\\s+ставк[а-я]*", "i").exec(lower);
  if (!match) {
    const forecast = new RegExp(issuer + "\\s+(?:может|планирует|намерен)\\s+(?:снизить|повысить|сохранить|оставить)\\s+ключев[а-я]*\\s+ставк", "i").test(lower);
    return forecast ? { quote, direction: "unknown", magnitude: null, level: null, date: null, forecast: true } : null;
  }
  if (speculative(lower)) return { quote, direction: "unknown", magnitude: null, level: null, date: null, forecast: true };
  const tail = lower.slice(match.index + match[0].length);
  const direction = /сниз|пониз/.test(match[1]) ? "decrease" : /повыс|увелич/.test(match[1]) ? "increase" : "unchanged";
  // Delta must immediately qualify the key rate, never an unrelated later rate.
  const delta = /^\s+на\s+(\d+(?:[.,]\d+)?)\s*(б\.?\s*п\.?|базисн[а-я]*\s+пункт[а-я]*|процентн[а-я]*\s+пункт[а-я]*|п\.?\s*п\.?)(?:\s|[,.;]|$)/.exec(tail);
  const amount = delta ? Number(delta[1].replace(",", ".")) * (/процент|^п/.test(delta[2]) ? 100 : 1) : null;
  const magnitude = direction === "unchanged" ? 0 : amount !== null && Number.isFinite(amount) ? amount : null;
  const levelMatch = /^\s+(?:на\s+[\d.,]+\s*(?:б\.?\s*п\.?|базисн[а-я]*\s+пункт[а-я]*|процентн[а-я]*\s+пункт[а-я]*|п\.?\s*п\.?)\s*,?\s*)?(?:до|на уровне)\s+([\d]+(?:[.,]\d+)?)\s*%/.exec(tail);
  const number = levelMatch ? Number(levelMatch[1].replace(",", ".")) : null;
  const prefix = lower.slice(0, match.index + match[0].indexOf(match[1]));
  const eventDate = /(?:^|\s)(?:с|начиная с)\s+\d/.test(prefix) ? null : calendarDate(prefix);
  return { quote, direction, magnitude, level: number !== null && Number.isFinite(number) ? number : null, date: eventDate, forecast: false };
}

/** A key-rate HOLD stated without a specific, quotable issuer (e.g. "регулятор
 * сохраняет ключевую ставку"). Recognized ONLY as unchanged — never a directional
 * change and never a numeric delta/level — so the monitoring_only guardrail engages
 * without attributing the decision to the central bank. Strict CBR extraction
 * (rateObservation) remains the sole authority for a typed, identified decision. */
function unspecifiedRateHold(lower: string): boolean {
  if (!/ключев[а-я]*\s+ставк/.test(lower)) return false;
  if (/сниз|пониз|повыс|увелич/.test(lower)) return false; // any directional move is not a plain hold
  return /сохран[а-я]*\s+ключев[а-я]*\s+ставк/.test(lower)
    || /оставля[а-я]*\s+(?:без\s+изменени[а-я]*\s+)?ключев[а-я]*\s+ставк/.test(lower)
    || /оставил[аио]?\s+ключев[а-я]*\s+ставк/.test(lower)
    || /ключев[а-я]*\s+ставк[а-я]*\s+(?:сохран|оставл|остал|оставал|без\s+изменени|не\s+измен)/.test(lower);
}

/** Conservative, offline rules. Extract only from quoted source text; never invent entity IDs. */
export function extractEventDetails(input: Json): Json {
  const event = structuredClone(input);
  const prior = event.event_details ?? {};
  const details: Json = { direction: "unknown", magnitude: null, magnitude_unit: "unknown", effective_at: null,
    decision_status: "unknown", target_roles: [], target_okved_codes: [], evidence: [], ...prior };
  let changed = false;
  const inputHasSubjectCodes = Boolean(prior.subject_okved_codes?.length);
  const ceremony = ceremonialReport(String(event.title ?? ""));
  const broadTax = generalTaxScope((event.sources ?? []).map((s: Json) => s.excerpt ?? "").join("\n"));
  const rateFacts: RateObservation[] = (event.sources ?? []).flatMap((source: Json) => typeof source.excerpt === "string" ? clauses(source.excerpt).map(rateObservation).filter(Boolean) : []);
  const confirmedRates = rateFacts.filter(row => !row.forecast);
  const ambiguousRates = ["direction", "date", "level", "magnitude"].some(field => new Set(confirmedRates.map(row => row[field as keyof RateObservation]).filter(value => value !== null)).size > 1);
  const evidence = (field: string, quote: string, sourceId: string) => {
    if (!details.evidence.some((e: Json) => e.field === field && e.quote === quote && e.source_ids.includes(sourceId)))
      details.evidence.push({ field, quote, source_ids: [sourceId] });
    changed = true;
  };
  const set = (field: string, value: unknown, quote: string, sourceId: string) => {
    if (details[field] === null || details[field] === "unknown" || (Array.isArray(details[field]) && !details[field].length)) {
      details[field] = value; evidence(field, quote, sourceId);
    }
  };
  for (const source of event.sources ?? []) {
    if (!source.id || typeof source.excerpt !== "string") continue;
    for (const quote of clauses(source.excerpt)) {
      if (quote.length > 4000) continue;
      const lower = quote.toLowerCase().replaceAll("ё", "е");
      const uncertain = speculative(lower), negated = denied(lower);
      const rate = rateObservation(quote);
      if (rate) {
        if (!event.event_type || event.event_type === "other") { event.event_type = "rate_change"; evidence("event_type", quote, source.id); }
        if (event.event_type === "rate_change" && !ambiguousRates) {
          // In a multi-decision recap we retain only the topic, not a fabricated
          // single direction/date assembled from unrelated historical decisions.
          if (!rate.forecast || !confirmedRates.length) set("decision_status", rate.forecast ? "forecast" : "announced", quote, source.id);
          if (!rate.forecast) {
            set("direction", rate.direction, quote, source.id);
            if (rate.magnitude !== null) { set("magnitude", rate.magnitude, quote, source.id); set("magnitude_unit", "bps", quote, source.id); }
            if (!event.event_at && rate.date) { event.event_at = rate.date; evidence("event_at", quote, source.id); }
          }
        }
      } else if (!uncertain && !negated && unspecifiedRateHold(lower)) {
        // A rate hold by an unspecified regulator: type it as unchanged so the review
        // stays monitoring-only and no interest-rate shock is invented. Direction only —
        // no issuer, magnitude or level is claimed, so nothing is attributed to the CBR.
        if (!event.event_type || event.event_type === "other") { event.event_type = "rate_change"; evidence("event_type", quote, source.id); }
        if (event.event_type === "rate_change" && !ambiguousRates) set("direction", "unchanged", quote, source.id);
      }
      if (!uncertain && !negated && /(?:ввел[аио]?|введен[аы]?|установил[аио]?|запретил[аио]?|продлил[аио]?|ограничил[аио]?|отменил[аио]?|снизил[аио]?|повысил[аио]?|утвердил[аио]?|принял[аио]?|решил[аио]?|действует)/.test(lower)
        && (/(?:пошлин)/.test(lower) || /(?:запрет|квот|ограничени)/.test(lower) && /(?:экспорт|импорт|ввоз|вывоз)/.test(lower))) {
        if (!event.event_type || event.event_type === "other") { event.event_type = "trade_restriction"; evidence("event_type", quote, source.id); }
        if (event.event_type === "trade_restriction") {
          set("decision_status", "announced", quote, source.id);
          const roles: string[] = [];
          if (/экспорт|вывоз/.test(lower)) roles.push("exporter");
          if (/импорт|ввоз/.test(lower)) roles.push("importer");
          set("target_roles", roles, quote, source.id);
        }
      }
      // Classification describes the subject of a report; it does not prove that a
      // particular firm qualifies for a tax benefit or is affected by a restriction.
      if (!event.event_type || event.event_type === "other") {
        if (/(?<![а-я])(?:ндс(?![а-я])|налог[а-я]*|страхов[а-я]*\s+взнос[а-я]*|тариф[а-я]*\s+взнос[а-я]*)/.test(lower)
          && /(?:ставк|тариф|повыш|сниж|увелич|измен|разъясн|льгот|освобожд)/.test(lower)) {
          event.event_type = "tax_change"; evidence("event_type", quote, source.id);
        } else if (/(?:цен[а-я]*\s+на\s+(?:зерн|пшениц|нефт|металл|газ|продовольств)|индекс[а-я]*\s+(?:продовольственн[а-я]*\s+цен|зерновых)|продовольственн[а-я]*\s+индекс)/.test(lower)
          && /(?:вырос|рост|сниз|сократ|повыс|составил|увелич)/.test(lower) && !uncertain && !negated) {
          event.event_type = "commodity_price_change"; evidence("event_type", quote, source.id);
        }
      }
      if (!inputHasSubjectCodes && !broadTax && !ceremony && !excludedScope(lower)) {
        const codes = classifyBusinessSubjects(quote);
        if (codes.length) {
          details.subject_okved_codes = [...new Set([...(details.subject_okved_codes ?? []), ...codes])].sort();
          details.taxonomy_origin = "rule_inference";
          details.taxonomy_version = SUBJECT_TAXONOMY_VERSION;
          evidence("subject_okved_codes", quote, source.id);
        }
      }
      const code = quote.match(/ОКВЭД(?:\s*2)?(?:\s*[:—-])?\s+(\d{2}(?:\.\d{1,2}){0,2})(?!\d|\.\d)/i);
      if (code && !excludedScope(lower) && !negated && !uncertain && /(?:для|применяется|распространяется|организац|предприят)/i.test(quote)) {
        set("target_okved_codes", [code[1]], quote, source.id);
        if (!event.okved_divisions?.length) { event.okved_divisions = [code[1].slice(0, 2)]; evidence("okved_divisions", quote, source.id); }
      }
      const effective = quote.match(/(?:вступ(?:ает|ают|ит|ят|ил[аио]?)\s+в\s+силу|начина(?:ет|ют)\s+действовать|действу(?:ет|ют)|ввод(?:ится|ятся))\s+(?:с\s+)?(.{10,50})/i);
      if (effective && !uncertain && !negated) {
        const at = calendarDate(effective[1]);
        if (at) set("effective_at", at, quote, source.id);
      }
    }
  }
  // Key-rate policy is cross-sector. Collateral paragraphs about fuel, grain or
  // taxation do not narrow the scope of the central bank decision itself.
  if (event.event_type === "rate_change" && !inputHasSubjectCodes) {
    delete details.subject_okved_codes; delete details.taxonomy_origin; delete details.taxonomy_version;
    details.evidence = details.evidence.filter((row: Json) => row.field !== "subject_okved_codes");
  }
  if (event.event_type === "rate_change") {
    // A later paragraph may describe an independent tax/industry measure. A
    // policy-rate decision is not limited to that measure's explicit OKVED.
    if (!prior.target_okved_codes?.length) {
      details.target_okved_codes = [];
      details.evidence = details.evidence.filter((row: Json) => row.field !== "target_okved_codes");
    }
    if (!input.okved_divisions?.length) {
      event.okved_divisions = [];
      details.evidence = details.evidence.filter((row: Json) => row.field !== "okved_divisions");
    }
    // Retain an extracted effective date only when its own clause names the key
    // rate. Resolving ambiguous pronouns across unrelated measures is unsafe.
    if (!prior.effective_at && !details.evidence.some((row: Json) => row.field === "effective_at" && /ключев[а-я]*\s+ставк/i.test(row.quote))) {
      details.effective_at = null;
      details.evidence = details.evidence.filter((row: Json) => row.field !== "effective_at");
    }
  }
  if (changed || input.event_details) event.event_details = details;
  return event;
}

/** Re-derive a confirmed key-rate decision's typing from the event's own quoted
 * evidence, so the monitoring_only / direction guardrails cannot be silently
 * skipped by a caller that supplied an under-typed event (event_type "other" or a
 * rate_change with no direction). Scope is deliberately narrow: only the rate
 * fields are touched, and only when the quoted text confirms a definite direction
 * and the caller left the rate typing weaker than that evidence. Other event
 * classifications are left to the ranking service that produced the event. */
export function groundRateTyping(event: Json): Json {
  const RATE_FIELDS = ["direction", "magnitude", "magnitude_unit", "decision_status"];
  // Extract purely from the quoted evidence, ignoring whatever typing the caller
  // supplied, so the result reflects only what the source text actually supports.
  const probe = structuredClone(event);
  probe.event_type = "other";
  probe.event_details = { evidence: [] };
  const derived = extractEventDetails(probe);
  const dd = derived.event_details ?? {};
  if (derived.event_type !== "rate_change" || !dd.direction || dd.direction === "unknown") return event;
  const current = event.event_details?.direction;
  const underTyped = event.event_type !== "rate_change" || !current || current === "unknown";
  if (!underTyped) return event; // caller already typed the direction; trust it
  const out = structuredClone(event);
  out.event_type = "rate_change";
  const details = out.event_details && typeof out.event_details === "object"
    ? { ...out.event_details } : { evidence: [] };
  if (!Array.isArray(details.evidence)) details.evidence = [];
  for (const field of RATE_FIELDS) if (dd[field] !== undefined) details[field] = dd[field];
  const rateRows = (dd.evidence ?? []).filter((row: Json) => RATE_FIELDS.includes(row.field) || row.field === "event_type");
  details.evidence = [...details.evidence.filter((row: Json) => !RATE_FIELDS.includes(row.field) && row.field !== "event_type"), ...rateRows];
  if (!out.event_at && derived.event_at) {
    out.event_at = derived.event_at;
    const dateRow = (dd.evidence ?? []).find((row: Json) => row.field === "event_at");
    if (dateRow) details.evidence.push(dateRow);
  }
  out.event_details = details;
  return out;
}

function eventIdentity(event: Json): string {
  // Deliberately limited to unambiguous CBR decisions; broad topic similarity is not identity.
  const details = event.event_details;
  if (event.event_type === "rate_change" && details?.decision_status === "announced" && details.direction !== "unknown") {
    const candidates = (event.sources as Json[]).flatMap(source => clauses(source.excerpt).map(rateObservation)).filter((row): row is RateObservation => row !== null && !row.forecast && row.direction === details.direction);
    const levels = [...new Set(candidates.map(row => row.level).filter(level => level !== null))];
    if (levels.length === 1) return "event:" + fingerprint(JSON.stringify([Boolean(event.is_mock), "cbr", "key_rate", (event.event_at ?? event.published_at).slice(0, 10), details.direction, levels[0]]));
  }
  return "event:" + fingerprint(JSON.stringify([Boolean(event.is_mock), event.published_at.slice(0, 10), String(event.title).toLowerCase().replace(/\s+/g, " ").trim(), String(event.text ?? "").toLowerCase().replace(/\s+/g, " ").trim()]));
}

export function articleToEvent(article: Json): Json | null {
  const published = normalizePublicationDate(article.published);
  if (!published.value || (!article.url && !article.is_demo)) return null;
  const sourceId = article.source_id ?? "news:" + article.id;
  const event = extractEventDetails({ news_id: article.id, event_id: article.id, title: article.title, text: article.text,
    event_type: "other", published_at: published.value, event_at: null, fact_status: "reported", okved_divisions: [], countries: [], regions: [], company_ids: [], entity_mapping_source: null,
    sources: [{ id: sourceId, kind: "news", title: article.title, url: article.url || "https://example.invalid/demo/" + article.id,
      excerpt: article.title + "\n" + article.text, document_id: null, page: null, published_at: article.available_at ?? published.value, is_mock: Boolean(article.is_demo) }], is_mock: Boolean(article.is_demo) });
  if (article.content_scope || article.material_version_id || article.version_id) event.content = {
    scope: article.content_scope ?? "provided", material_revision: article.material_version_id ?? article.version_id ?? sourceId,
    version_id: article.version_id ?? sourceId, warnings: article.warnings ?? [] };
  event.event_id = eventIdentity(event);
  return event;
}

/** Shared by legacy and v1 feeds: return the latest observed eligible revision. */
export function newsArticlesAsOf(db: Store, asOf: string, newsId?: string): News[] {
  const cutoff = new Date(asOf).toISOString();
  const rows = newsId ? [{ id: newsId }] : db.all("SELECT id FROM news");
  const out: News[] = [];
  for (const row of rows) {
    // Observation order breaks equal timestamp ties and prevents a corrected,
    // obsolete future-dated revision from becoming current again in the future.
    const version = db.get("SELECT payload FROM news_versions WHERE news_id=? AND available_at<=? ORDER BY rowid DESC LIMIT 1", row.id, cutoff);
    const hasVersions = db.get("SELECT 1 FROM news_versions WHERE news_id=? LIMIT 1", row.id);
    if (!version && hasVersions) continue;
    const article: News = version ? JSON.parse(version.payload) : db.news(row.id);
    const at = normalizePublicationDate(article.published).value;
    if (at && at <= cutoff && (!article.available_at || Date.parse(article.available_at) <= Date.parse(cutoff))) out.push(article);
  }
  return out;
}

export function clusterEvents(events: Json[]): Json[] {
  const grouped = new Map<string, Json>();
  const members = new Map<string,Json[]>();
  // First announcement defines freshness; later reporting adds evidence, not recency.
  for (const event of [...events].sort((a, b) => a.published_at.localeCompare(b.published_at) || a.news_id.localeCompare(b.news_id))) {
    members.set(event.event_id,[...(members.get(event.event_id) ?? []),event]);
    const prior = grouped.get(event.event_id);
    if (!prior) { grouped.set(event.event_id, structuredClone(event)); continue; }
    for (const source of event.sources) if (!prior.sources.some((s: Json) => s.id === source.id)) prior.sources.push(source);
    if (event.event_details && prior.event_details) {
      for (const field of ["direction", "magnitude", "magnitude_unit", "effective_at", "decision_status", "target_roles", "target_okved_codes", "subject_okved_codes"]) {
        const old = prior.event_details[field], incoming = event.event_details[field];
        if ((old == null || old === "unknown" || Array.isArray(old) && !old.length) && incoming !== undefined) {
          prior.event_details[field] = structuredClone(incoming);
          if (field === "subject_okved_codes" && incoming.length) {
            prior.event_details.taxonomy_origin = event.event_details.taxonomy_origin;
            prior.event_details.taxonomy_version = event.event_details.taxonomy_version;
          }
        }
        else if (["magnitude", "effective_at"].includes(field) && old != null && incoming != null && old !== incoming) prior.fact_status = "disputed";
      }
      for (const row of event.event_details.evidence) if (!prior.event_details.evidence.some((e: Json) => JSON.stringify(e) === JSON.stringify(row))) prior.event_details.evidence.push(row);
    }
  }
  for (const [eventId,group] of members) {
    if (group.length < 2 || !group.some(event => event.content)) continue;
    const merged=grouped.get(eventId)!;
    // The logical news ID and first publication stay stable. Full evidence may
    // come from a later source, and must agree with the promoted content scope.
    const quality=(event:Json) => (({article_full:3,feed_content:2,provided:1,feed_excerpt:0} as Record<string,number>)[event.content?.scope as string] ?? 1);
    const official=(event:Json) => event.event_type === "rate_change" && event.sources.some((source:Json)=> {
      try { return /(?:^|\.)cbr\.ru$/i.test(new URL(source.url).hostname); } catch { return false; }
    }) ? 1 : 0;
    const preferred=[...group].sort((a,b)=>quality(b)-quality(a) || official(b)-official(a) || b.text.length-a.text.length || a.published_at.localeCompare(b.published_at) || a.news_id.localeCompare(b.news_id))[0];
    merged.title=preferred.title;merged.text=preferred.text;
    const revisions=[...new Set(group.map(event => event.content?.material_revision ?? fingerprint(JSON.stringify([event.title,event.text,event.published_at]))))].sort();
    const warnings=new Set<string>(preferred.content?.warnings ?? []);
    for (const member of group) if (member !== preferred) for (const warning of member.content?.warnings ?? []) {
      if (/rss_excerpt_only_full_article_not_fetched|full_article_fetch_failed|full_article_waiting_for_fetch_slot/.test(warning)) warnings.add("cluster_has_partial_secondary_sources");
      else if (/source_text_truncated/.test(warning)) warnings.add("cluster_has_truncated_secondary_sources");
      else warnings.add(warning);
    }
    merged.content={scope:preferred.content?.scope ?? "provided",
      material_revision:revisions.length===1 ? revisions[0] : fingerprint(JSON.stringify(revisions)),
      version_id:"cluster:"+fingerprint(JSON.stringify(merged.sources.map((source:Json)=>source.id).sort())),
      warnings:[...warnings]};
  }
  return [...grouped.values()].sort((a, b) => b.published_at.localeCompare(a.published_at) || a.news_id.localeCompare(b.news_id));
}

/** Additional semantic checks beyond the JSON schema, shared by imports and public requests. */
export function validateEventDetails(event: Json): void {
  if (event.event_details === undefined) return;
  const details = event.event_details;
  const fields = new Set(["direction", "magnitude", "magnitude_unit", "effective_at", "decision_status", "target_roles", "target_okved_codes", "subject_okved_codes", "event_type", "event_at", "okved_divisions"]);
  if (!details || typeof details !== "object" || !Array.isArray(details.evidence)) throw new Error("event_details.evidence is required");
  const sources = new Map((event.sources ?? []).map((source: Json) => [source.id, source]));
  const supported = new Set<string>();
  for (const row of details.evidence) {
    if (!row || !fields.has(row.field) || typeof row.quote !== "string" || !row.quote.trim() || !Array.isArray(row.source_ids) || !row.source_ids.length)
      throw new Error("Invalid event_details evidence");
    for (const id of row.source_ids) {
      const source = sources.get(id) as Json | undefined;
      if (!source || typeof source.excerpt !== "string" || !source.excerpt.includes(row.quote)) throw new Error("Event evidence must quote each referenced source exactly");
    }
    supported.add(row.field);
  }
  for (const field of ["direction", "magnitude", "magnitude_unit", "effective_at", "decision_status", "target_roles", "target_okved_codes", "subject_okved_codes"]) {
    const value = details[field];
    if (value !== undefined && value !== null && value !== "unknown" && (!Array.isArray(value) || value.length) && !supported.has(field)) throw new Error("Missing event evidence for " + field);
  }
  if (details.magnitude !== null && details.magnitude !== undefined && (typeof details.magnitude !== "number" || !Number.isFinite(details.magnitude) || details.magnitude < 0 || !["bps", "percentage_points", "percent"].includes(details.magnitude_unit))) throw new Error("Magnitude requires a nonnegative finite value and a known unit");
  if (details.magnitude == null && details.magnitude_unit && details.magnitude_unit !== "unknown") throw new Error("Magnitude unit without magnitude");
  if (details.direction === "unchanged" && details.magnitude != null && details.magnitude !== 0) throw new Error("Unchanged direction cannot have a nonzero magnitude");
  if (details.subject_okved_codes?.length && (details.taxonomy_origin !== "rule_inference" || details.taxonomy_version !== SUBJECT_TAXONOMY_VERSION)) throw new Error("Thematic codes require the known inference taxonomy version");
}
