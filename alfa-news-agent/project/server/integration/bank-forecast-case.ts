import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { Json } from "../types.js";

/** TASKS8 item 5: the corpus page that forecasts the same 23 October 2026 decision, dated before as_of.
 * REPORT8's bank case kept only chunk c0 of this page, which ends before the forecast; the forecast is in c4200. */
export const FORECAST_PAGE = "1shHG89LtMgHT1_uEebHmQSFZe_zbeq7-:p1";
export const FORECAST_QUOTE = "Мы ожидаем сохранения паузы на заседании 23 октября";
export const FORECAST_LIMITATION = "Банковский материал — прогноз Центра макроэкономического анализа от 11 сентября 2026 г. о заседании 23 октября: исторический прогноз до as_of, а не текущая позиция банка и не оценка условий договоров компании.";

/** Rebuild the chunk exactly as Retrieval.research slices it (1400-char steps, 150 back, 1600 forward). */
export function forecastResearchItem(): Json {
  const rows: Json[] = JSON.parse(readFileSync(resolve(ROOT, "data/research.json"), "utf8"));
  const doc = rows.find(r => r.id === FORECAST_PAGE);
  if (!doc || doc.publication_date_status !== "verified" || doc.date !== "2026-09-11") throw new Error("Forecast page is missing or undated");
  const at = doc.text.indexOf(FORECAST_QUOTE);
  if (at < 0) throw new Error("Forecast passage is missing");
  const start = Math.floor(at / 1400) * 1400, excerpt = doc.text.slice(Math.max(0, start - 150), start + 1600);
  if (!excerpt.includes(FORECAST_QUOTE)) throw new Error("Forecast passage crosses a chunk boundary");
  return { id: "research:" + doc.id + ":c" + start, kind: "bank", title: doc.title, url: doc.url, excerpt,
    document_id: doc.document_id, page: doc.page, published_at: doc.date + "T23:59:59.999Z", is_mock: false };
}
/** Same input, with the forecast chunk as its only bank evidence. Never fabricates or edits bank text. */
export function withForecastResearch(input: Json): Json {
  const copy = structuredClone(input), item = forecastResearchItem();
  if (Date.parse(item.published_at) > Date.parse(copy.as_of)) throw new Error("Forecast page postdates as_of");
  copy.research = { items: [item], limitations: [...(copy.research?.limitations ?? []), FORECAST_LIMITATION] };
  return copy;
}
