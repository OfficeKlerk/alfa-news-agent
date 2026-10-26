import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../db.js";
import type { Settings } from "../config.js";
import { saveNews, ingestFeeds } from "../news.js";
import { articleToEvent, canonicalUrl, clusterEvents, extractEventDetails, normalizePublicationDate, validateEventDetails } from "../news-events.js";

export function newsStore() {
  const folder = mkdtempSync(join(tmpdir(), "alfa-news-normalization-"));
  const settings = { dbPath: join(folder, "news.sqlite"), feeds: ["https://example.org/feed"] } as Settings;
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE news(id TEXT PRIMARY KEY,title TEXT,text TEXT,url TEXT,published TEXT,tags TEXT,is_demo INTEGER); CREATE TABLE news_metadata(news_id TEXT PRIMARY KEY,identity TEXT UNIQUE,payload TEXT); CREATE TABLE news_versions(news_id TEXT,version_id TEXT,available_at TEXT,payload TEXT,PRIMARY KEY(news_id,version_id));");
  return { db, settings, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const article = (changes = {}) => ({ id: "a", title: "Решение Банка России", text: "23 октября 2026 года Банк России снизил ключевую ставку на 100 б.п. до 17% годовых.", url: "https://example.org/a", published: "2026-10-23T10:00:00Z", is_demo: false, ...changes });

test("publication normalization preserves timezone and rejects ambiguous or impossible dates", () => {
  assert.equal(normalizePublicationDate("Fri, 23 Oct 2026 13:00:00 +0300").value, "2026-10-23T10:00:00.000Z");
  assert.equal(normalizePublicationDate("2026-10-23T13:00:00+03:00").value, "2026-10-23T10:00:00.000Z");
  assert.equal(normalizePublicationDate("2026-10-23").precision, "day");
  assert.equal(normalizePublicationDate("2026-10-23").value, "2026-10-23T23:59:59.999Z");
  assert.equal(normalizePublicationDate(undefined).status, "missing");
  for (const value of ["2026-02-30", "30 Feb 2026 09:00:00 GMT", "23 Oct 2026 24:00:00 +0000", "2026-10-23T13:00:00", "2026-10-23T24:00:00Z", "tomorrow", "10/11/2026", 123]) assert.equal(normalizePublicationDate(value).status, "invalid", String(value));
});

test("rate decisions have exact evidence, distinguish holds from changes, and preserve curated metadata", () => {
  const cut = articleToEvent(article())!;
  assert.equal(cut.event_type, "rate_change");
  assert.equal(cut.event_details.direction, "decrease");
  assert.equal(cut.event_details.magnitude, 100);
  assert.equal(cut.event_details.magnitude_unit, "bps");
  validateEventDetails(cut);
  const held = articleToEvent(article({ text: "23 октября 2026 года Банк России сохранил ключевую ставку на уровне 17% годовых." }))!;
  assert.equal(held.event_details.direction, "unchanged"); assert.equal(held.event_details.magnitude, 0);
  assert.notEqual(cut.event_id, held.event_id);
  const points = articleToEvent(article({ text: "Банк России снизил ключевую ставку на 1 процентный пункт до 17% годовых." }))!;
  assert.equal(points.event_details.magnitude, 100); assert.equal(points.event_details.magnitude_unit, "bps");
  const relative = articleToEvent(article({ text: "Банк России снизил ключевую ставку на 5% относительно прежнего значения." }))!;
  assert.equal(relative.event_details.magnitude, null, "relative percent must not be parsed as percentage points");
  const curated = extractEventDetails({ ...cut, event_type: "company_event", company_ids: ["CURATED"], entity_mapping_source: "reviewed", event_details: { ...cut.event_details, direction: "increase" } });
  assert.equal(curated.event_type, "company_event"); assert.equal(curated.event_details.direction, "increase"); assert.deepEqual(curated.company_ids, ["CURATED"]);
  const fabricated = structuredClone(cut); fabricated.event_details.evidence[0].quote = "Несуществующий факт";
  assert.throws(() => validateEventDetails(fabricated), /quote/);
});

test("negation, forecasts and mentioning a rate alone do not become announced changes", () => {
  const negated = articleToEvent(article({ text: "Банк России не повысил ключевую ставку. Эксперты обсуждали перспективы экономики." }))!;
  assert.equal(negated.event_type, "other");
  const forecast = articleToEvent(article({ text: "Банк России может повысить ключевую ставку до 20%, ожидают аналитики рынка." }))!;
  assert.equal(forecast.event_details.decision_status, "forecast"); assert.equal(forecast.event_details.direction, "unknown");
  assert.equal(articleToEvent(article({ text: "Эксперты обсудили ключевую ставку и стоимость финансирования на следующий год." }))!.event_type, "other");
});

test("explicit trade target, OKVED and effective date are extracted with source evidence", () => {
  const event = articleToEvent(article({ text: "Правительство ввело запрет на экспорт продукции. Мера применяется для предприятий ОКВЭД 24.10. Запрет вступает в силу с 1 ноября 2026 года." }))!;
  assert.equal(event.event_type, "trade_restriction");
  assert.deepEqual(event.event_details.target_roles, ["exporter"]);
  assert.deepEqual(event.event_details.target_okved_codes, ["24.10"]);
  assert.deepEqual(event.okved_divisions, ["24"]);
  assert.equal(event.event_details.effective_at, "2026-11-01T00:00:00.000Z");
  validateEventDetails(event);
});

test("same decision clusters sources while preserving first publication; distinct decisions remain separate", () => {
  const first = articleToEvent(article())!;
  const second = articleToEvent(article({ id: "b", url: "https://another.example/b", published: "2026-10-23T12:00:00Z", text: "23 октября 2026 года Банк России снизил ключевую ставку до 17% годовых. Подробнее в сообщении регулятора." }))!;
  const previous = articleToEvent(article({ id: "c", published: "2026-09-23T10:00:00Z", text: "23 сентября 2026 года Банк России снизил ключевую ставку до 17% годовых." }))!;
  const merged = clusterEvents([second, previous, first]);
  assert.equal(merged.length, 2); assert.equal(merged[0].sources.length, 2);
  assert.equal(merged[0].published_at, "2026-10-23T10:00:00.000Z");
  const boilerplate = "Подробности будут сообщены позднее в официальном сообщении компании.";
  const generic = [articleToEvent(article({ title: "Завод А возобновил работу", text: boilerplate })), articleToEvent(article({ id: "other", title: "Завод Б остановил производство", text: boilerplate }))];
  assert.equal(clusterEvents(generic.filter((e): e is NonNullable<typeof e> => e !== null)).length, 2);
  const headlineOnly = articleToEvent(article({ id: "d", title: "Банк России снизил ключевую ставку", text: "23 октября 2026 года Банк России снизил ключевую ставку до 17% годовых." }))!;
  assert.equal(headlineOnly.event_id, first.event_id, "a short title must not mask the decision level in the body");
});

test("tax and commodity subjects distinguish thematic inference from explicit legal scope", () => {
  const tax = articleToEvent(article({ title: "ФНС разъяснила основную ставку НДС", text: "Основная ставка НДС повышается до 22%. Для гостиниц сохраняются специальные условия налогообложения." }))!;
  assert.equal(tax.event_type, "tax_change");
  assert.ok(!tax.event_details.subject_okved_codes?.length, "a general VAT notice must not become hotel-only");
  const hotel = articleToEvent(article({ title: "НДС для гостиниц", text: "Для услуг размещения возможна ставка НДС 0% при соблюдении установленных условий." }))!;
  assert.deepEqual(hotel.event_details.subject_okved_codes, ["55.1"]);
  assert.deepEqual(hotel.event_details.target_okved_codes, []);
  assert.equal(hotel.event_details.taxonomy_origin, "rule_inference"); validateEventDetails(hotel);
  const grain = articleToEvent(article({ title: "ФАО сообщила о ценах на зерновые", text: "Индекс зерновых вырос на 5,1%. Цены на пшеницу увеличились на 6,3%." }))!;
  assert.equal(grain.event_type, "commodity_price_change");
  assert.deepEqual(grain.event_details.subject_okved_codes, ["01.11", "46.21"]);
  const fertilizer = articleToEvent(article({ title: "Совет ЕС утвердил пошлины на удобрения", text: "Совет ЕС утвердил дополнительные пошлины на отдельные удобрения российского происхождения." }))!;
  assert.equal(fertilizer.event_type, "trade_restriction");
  assert.deepEqual(fertilizer.event_details.subject_okved_codes, ["20.15", "46.75"]);
  assert.ok(!fertilizer.event_details.subject_okved_codes.includes("46"));
  const generation = articleToEvent(article({ text: "Опубликованы новые правила проверки генерирующего оборудования участников оптового рынка." }))!;
  assert.deepEqual(generation.event_details.subject_okved_codes, ["35.11"]);
  const museum = articleToEvent(article({ text: "В Москве открылась новая выставка музея. Она посвящена произведениям искусства." }))!;
  assert.deepEqual(museum.event_details.subject_okved_codes, ["82.30", "91.02"]);
  assert.deepEqual(museum.regions, [], "mentioning the same city does not assign company-specific relevance");
  assert.ok(!articleToEvent(article({ text: "Компания сообщила о ремонте котельного оборудования. Работы завершены в срок." }))!.event_details?.subject_okved_codes?.includes("55.1"));
});

test("canonical URLs deduplicate articles and preserve publication separately from revisions", () => {
  const store = newsStore();
  try {
    assert.equal(canonicalUrl("https://example.org/a?utm_source=feed&x=1#top"), "https://example.org/a?x=1");
    const first = saveNews(store.db, article({ url: "https://example.org/a?utm_source=feed" }));
    const second = saveNews(store.db, article({ url: "https://example.org/a#top" }));
    assert.equal(first.id, second.id); assert.equal(second.ingestion_status, "duplicate");
    const updated = saveNews(store.db, article({ published: "2026-10-24T11:00:00Z", modified: "2026-10-24T11:00:00Z", text: "Банк России сохранил ключевую ставку на уровне 17% годовых. Исправление сообщения." }));
    assert.equal(updated.id, first.id); assert.equal(updated.published, first.published);
    assert.equal(updated.available_at, "2026-10-24T11:00:00.000Z");
    const repeat = saveNews(store.db, { ...updated, modified: undefined });
    assert.equal(repeat.available_at, updated.available_at, "polling must not backdate a revision");
    assert.equal(store.db.get("SELECT count(*) AS n FROM news")!.n, 1);
    assert.equal(store.db.get("SELECT count(*) AS n FROM news_versions")!.n, 2);
    const historical = JSON.parse(store.db.get("SELECT payload FROM news_versions WHERE news_id=? AND available_at<=? ORDER BY available_at DESC LIMIT 1", first.id, "2026-10-23T15:00:00.000Z")!.payload);
    assert.match(historical.text, /снизил/);
  } finally { store.close(); }
});

test("undated articles are quarantined and Atom updated never replaces published", async () => {
  const store = newsStore();
  try {
    const missing = saveNews(store.db, article({ url: "https://example.org/missing", published: undefined }));
    assert.equal(missing.published, ""); assert.equal(missing.date_status, "missing"); assert.equal(articleToEvent(missing), null);
    const invalid = saveNews(store.db, article({ url: "https://example.org/invalid", published: "invalid" }));
    assert.equal(invalid.date_status, "invalid");
    const xml = '<feed><entry><title>Решение по ставке</title><summary>Банк России сохранил ключевую ставку на уровне 17% годовых.</summary><link href="https://example.org/atom"/><published>2026-09-01T10:00:00Z</published><updated>2026-10-23T10:00:00Z</updated></entry></feed>';
    const result = await ingestFeeds(store.settings, store.db, (async () => new Response(xml)) as typeof fetch);
    assert.equal(result.inserted, 1); assert.equal(result.quarantined, 0);
    const row = store.db.get("SELECT * FROM news WHERE url='https://example.org/atom'")!;
    assert.equal(row.published, "2026-09-01T10:00:00.000Z");
    const repeat = await ingestFeeds(store.settings, store.db, (async () => new Response(xml)) as typeof fetch);
    assert.equal(repeat.duplicates, 1); assert.equal(repeat.inserted, 0);
    const updatedOnly = xml.replace('<published>2026-09-01T10:00:00Z</published>', '').replace('https://example.org/atom', 'https://example.org/updated-only');
    assert.equal((await ingestFeeds(store.settings, store.db, (async () => new Response(updatedOnly)) as typeof fetch)).quarantined, 1);
  } finally { store.close(); }
});

test("denied decisions and excluded OKVED scopes cannot become positive applicability", () => {
  for (const text of ["Правительство не продлило запрет на экспорт зерна. Ограничение прекратило действие.", "Пошлины на экспорт удобрений не введены. Тема пока обсуждается экспертами.", "Правительство не будет продлевать запрет на вывоз зерна в другие страны."]) {
    const event = articleToEvent(article({ title: "Сообщение о торговле", text }))!;
    assert.notEqual(event.event_details?.decision_status, "announced");
    assert.deepEqual(event.event_details?.target_roles ?? [], []);
  }
  for (const text of ["Новая ставка налога не применяется для предприятий ОКВЭД 24.10.", "Мера применяется для предприятий, кроме организаций ОКВЭД 24.10."]) {
    const event = articleToEvent(article({ text }))!;
    assert.deepEqual(event.event_details?.target_okved_codes ?? [], []);
    assert.deepEqual(event.okved_divisions, []);
  }
  const unrelated = articleToEvent(article({ text: "Правительство ввело ограничения на экспорт зерна; гостиницы в обсуждении не участвовали." }))!;
  assert.deepEqual(unrelated.event_details.subject_okved_codes, ["01.11", "46.21"]);
});

test("a central bank cannot inherit another actor's action or a deposit-rate delta", () => {
  const attributed = articleToEvent(article({ text: "Банк России сообщил, что коммерческий банк повысил ключевую ставку на 3 процентных пункта до 17%." }))!;
  assert.notEqual(attributed.event_type, "rate_change");
  for (const text of ["Банк России снизил ключевую ставку до 17%, а банки повысили депозитные ставки на 2 процентных пункта.", "Банк России снизил ключевую ставку до 17% и повысил депозитные ставки на 2 процентных пункта."]) {
    const event = articleToEvent(article({ text }))!;
    assert.equal(event.event_details.direction, "decrease");
    assert.equal(event.event_details.magnitude, null);
    validateEventDetails(event);
  }
  const fake = articleToEvent(article({ text: "Сообщение «Банк России снизил ключевую ставку на 100 б.п.» оказалось ложным." }))!;
  assert.notEqual(fake.event_details?.decision_status, "announced");
});

test("a historical recap of multiple decisions is not flattened into a fabricated single decision", () => {
  const mixed = articleToEvent(article({ text: "В марте Банк России снизил ключевую ставку на 50 б.п. до 17%, а 23 октября 2026 года Банк России сохранил ключевую ставку на уровне 17%." }))!;
  assert.equal(mixed.event_type, "rate_change");
  assert.equal(mixed.event_details.direction, "unknown");
  assert.equal(mixed.event_details.magnitude, null);
  assert.equal(mixed.event_details.decision_status, "unknown");
  assert.equal(mixed.event_at, null);
  assert.equal(mixed.fact_status, "reported", "two different historical facts are not a factual dispute");
  validateEventDetails(mixed);
});

test("equivalent rate formatting deduplicates while real and synthetic sources stay separate", () => {
  const a = articleToEvent(article())!;
  const b = articleToEvent(article({ id: "b", text: "23 октября 2026 года Банк России снизил ключевую ставку на 100 б.п. до 17,00% годовых." }))!;
  const mock = articleToEvent(article({ id: "mock", is_demo: true }))!;
  assert.equal(a.event_id, b.event_id);
  assert.notEqual(a.event_id, mock.event_id);
  const clusters = clusterEvents([a, b, mock]);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every(event => event.sources.every((source: { is_mock: boolean }) => source.is_mock === event.is_mock)));
});

test("repeated polling preserves date-only precision and the original raw timestamp", () => {
  const h = newsStore();
  try {
    const first = saveNews(h.db, article({ published: "2026-10-23" }));
    const second = saveNews(h.db, article({ published: undefined }));
    assert.equal(second.id, first.id);
    assert.equal(second.published_precision, "day");
    assert.equal(second.published_raw, "2026-10-23");
    assert.ok(second.warnings.includes("date_only_assumes_utc_end_of_day"));
  } finally { h.close(); }
});

test("nonnumeric overflow and contradictory unchanged magnitudes fail safely", () => {
  const giant = articleToEvent(article({ text: "Банк России снизил ключевую ставку на " + "9".repeat(320) + " базисных пунктов до 17% годовых." }))!;
  assert.equal(giant.event_details.magnitude, null);
  validateEventDetails(giant);
  const invalid = articleToEvent(article())!;
  invalid.event_details.direction = "unchanged";
  assert.throws(() => validateEventDetails(invalid), /Unchanged/);
});

test("macro policy-rate releases are not narrowed by collateral fuel and tax paragraphs", () => {
  const event = articleToEvent(article({ text: "Банк России сохранил ключевую ставку на уровне 14,00% годовых. Рост цен на бензин замедлился. Издержки гостиниц выросли после изменения налогов." }))!;
  assert.equal(event.event_type, "rate_change");
  assert.equal(event.event_details.direction, "unchanged");
  assert.ok(!event.event_details.subject_okved_codes?.length);
  assert.ok(!event.event_details.evidence.some((row: { field: string }) => row.field === "subject_okved_codes"));
});

test("combined reports cannot attach another measure's legal scope or start date to a key-rate decision", () => {
  const combined = articleToEvent(article({ text: "Банк России снизил ключевую ставку до 17%. Налоговая льгота вступает в силу с 1 ноября 2026 года. Мера применяется для предприятий ОКВЭД 24.10." }))!;
  assert.equal(combined.event_type, "rate_change");
  assert.equal(combined.event_details.effective_at, null);
  assert.deepEqual(combined.event_details.target_okved_codes, []);
  assert.deepEqual(combined.okved_divisions, []);
  validateEventDetails(combined);
  const linked = articleToEvent(article({ text: "Банк России снизил ключевую ставку до 17%. Новая ключевая ставка вступает в силу с 1 ноября 2026 года." }))!;
  assert.equal(linked.event_details.effective_at, "2026-11-01T00:00:00.000Z");
  validateEventDetails(linked);
});

test("specific business subjects are inferred only as themes and ceremonial headlines abstain", () => {
  const generation = articleToEvent(article({ title: "План развития генерации", text: "Запланирован ввод новых генерирующих мощностей и новых электростанций в следующем году." }))!;
  assert.deepEqual(generation.event_details.subject_okved_codes, ["35.11"]);
  const grid = articleToEvent(article({ title: "Реконструкция электросетей", text: "Модернизированы электрические сети для повышения надежности передачи электроэнергии." }))!;
  assert.deepEqual(grid.event_details.subject_okved_codes, ["35.12", "35.13"]);
  const vessels = articleToEvent(article({ title: "Идентификация судов", text: "Разработаны новые требования к регистрации морских судов и внутреннего водного транспорта." }))!;
  assert.deepEqual(vessels.event_details.subject_okved_codes, ["50"]);
  const awards = articleToEvent(article({ title: "Министр вручил заслуженные награды работникам", text: "Отмечены работники дорожного хозяйства и автомобильного транспорта. Развиваются электрические сети." }))!;
  assert.equal(awards.event_type, "other");
  assert.ok(!awards.event_details?.subject_okved_codes?.length);
  const granular = articleToEvent(article({ title: "Зернистая поверхность", text: "Предприятие улучшило зернистую поверхность покрытия для промышленного оборудования." }))!;
  assert.ok(!granular.event_details?.subject_okved_codes?.length);
  for (const event of [generation, grid, vessels, awards, granular]) validateEventDetails(event);
});

test("plural commencement dates and compound power-station nouns retain explicit source facts", () => {
  for (const [verb, day] of [["вступают", "26"], ["вступят", "29"], ["вступили", "20"]]) {
    const event = articleToEvent(article({ text: `Правила организованных торгов ${verb} в силу с ${day} октября 2026 года.` }))!;
    assert.equal(event.event_details.effective_at, `2026-10-${day}T00:00:00.000Z`);
    assert.deepEqual(event.event_details.target_okved_codes, []);
    assert.ok(!event.event_details.subject_okved_codes?.length, "trading rules without a named commodity must not imply grain");
    assert.equal(event.published_at, "2026-10-23T10:00:00.000Z", "future effective dates do not postpone publication");
    validateEventDetails(event);
  }
  const station = articleToEvent(article({ text: "Подготовлены стандарты, в том числе в области тепло- и гидроэлектростанций." }))!;
  assert.deepEqual(station.event_details.subject_okved_codes, ["35.11"]);
  assert.deepEqual(station.event_details.target_okved_codes, []);
});
