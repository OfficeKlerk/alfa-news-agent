import type { Json } from "../types.js";
import type { prepareContext } from "./context.js";

const SERVICE_KEYS = new Set(["provenance", "source"]);
/** Business view for the provider: audit metadata stays in the full context used by validators. */
export function generationProfile(profile: Json): Json {
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([key, child]) => !SERVICE_KEYS.has(key) || !child || typeof child !== "object").map(([key, child]) => [key, strip(child)])) : value;
  return strip(profile) as Json;
}
/** Provider view: canonical input occurs once and without audit metadata; validators keep the full context. */
export function generationContext(context: ReturnType<typeof prepareContext>, question?: Json): Json {
  const root = question ? "/prepared_input" : "/input";
  const locations = new Map<string, string>([
    ["company:" + context.input.company_id, root + "/profile"],
    ...context.input.event.sources.map((source: Json, i: number) => [source.id, root + "/event/sources/" + i + "/excerpt"] as [string, string]),
    ...context.input.research.items.map((source: Json, i: number) => [source.id, root + "/research/items/" + i + "/excerpt"] as [string, string]),
  ]);
  const sources = context.sources.map(({ excerpt: _excerpt, ...metadata }) => {
    const content_ref = locations.get(metadata.id);
    if (!content_ref) throw new Error("Missing evidence location");
    return { ...metadata, content_ref };
  });
  const evidence_layout = {
    version: "deduplicated-v2", sources,
    omitted_profile_metadata: [...SERVICE_KEYS],
    rule: "content_ref — JSON Pointer внутри этого запроса. Бизнес-поля профиля и дословные excerpt находятся по указанным путям и переданы один раз; служебные объекты provenance/source опущены, сервер проверяет ответ по полному контексту. company указывает на объект профиля, который не является fact/bank-цитатой. Метаданные и ID источников сохранены. Отсутствие повторной копии не означает отсутствие данных.",
  };
  const view = { ...context.input, profile: generationProfile(context.input.profile) };
  if (!question) return { input: view, sha256: context.sha256, evidence_layout };
  // prepareQuestionContext already verified saved evidence and identity. Do not mutate it.
  const { sources: _sources, ...analysis } = question.analysis;
  return { ...question, prepared_input: view, analysis, evidence_layout,
    as_of: context.input.as_of, audience_role: context.input.audience_role };
}
