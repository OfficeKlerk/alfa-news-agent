import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { cautiousLanguageRules } from "../cautious-language.js";
import { claimProfileRules } from "../claim-profile-grounding.js";
import { generatePrepared } from "../prepared-agent.js";
import { generatedResponseSchema } from "../response-schema.js";
import { GENERATION_CLAIM_LIMIT, generationBudgetIssues } from "../generation-budget.js";
import { industryWording, repairPlan } from "../repair-guidance.js";

// TEAM_TASKS7 items left open after the guard work: budget, rebuild, dependent numbers, wording.
function ledger() {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/llm-test-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "local-test-secret", LLM_BASE_URL: "https://provider.invalid/v1",
    LLM_MODEL: "qwen/qwen3.6-35b-a3b", LLM_ALLOWED_MODELS_JSON: '["qwen/qwen3.6-35b-a3b"]' }),
    dbPath: resolve(folder, "calls.sqlite3"), maxCalls: 10, timeout: 1000 };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { settings, db, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const reply = (d: Json, finish = "stop") => Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(d) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const transportEvent = () => JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/event_interpretation_cases.json"), "utf8"))
  .cases.find((c: Json) => c.id === "transport_budget").event;
/** REPORT7 power-trader-strict: the fact quote copied into many claims. */
function overgrown(draft: Json, count: number, kind = "fact") {
  const fact = draft.claims[0];
  draft.claims = [fact, draft.claims[1], ...Array.from({ length: count - 2 }, () => ({ ...fact, kind }))];
  draft.grounding.summary = [0, ...draft.claims.map((_: Json, i: number) => i).slice(2)];
  return draft;
}

test("strict provider schema and local budget cap generated claims", () => {
  for (const name of ["GeneratedAnalysis", "GeneratedAnswer"] as const) {
    const schema = generatedResponseSchema(name).schema;
    assert.equal(schema.properties.claims.maxItems, GENERATION_CLAIM_LIMIT);
    const indexes = JSON.stringify(schema).match(/"maximum":\d+/g) ?? [];
    assert.ok(indexes.length && indexes.every(m => Number(m.split(":")[1]) <= GENERATION_CLAIM_LIMIT - 1), name);
  }
  const s = evaluationCases()[0];
  assert.deepEqual(generationBudgetIssues(referenceDraft(s)), []);
  const rules = generationBudgetIssues(overgrown(referenceDraft(s), 30)).map(i => i.rule);
  // The overgrown fixture copies one fact, so it is also a repeated claim (REPORT8).
  assert.deepEqual(rules, ["Too many claims for a compact answer", "Repeated claim text"]);
  assert.deepEqual(generationBudgetIssues({ claims: [{ kind: "fact" }, ...Array(4).fill({ kind: "bank" })] }).map(i => i.rule), ["Too many bank claims"]);
});

test("an overgrown draft gets one compact rebuild, not a copy of its list", async () => {
  const l = ledger(), s = evaluationCases()[0]; let calls = 0; const seen: Json[] = [];
  try {
    const result = await generatePrepared(l.settings, l.db, s.input, "budget", (async (_url, init) => {
      calls++; seen.push(JSON.parse(String(init?.body)));
      return reply(calls === 1 ? overgrown(referenceDraft(s), 12) : referenceDraft(s));
    }) as typeof fetch);
    assert.equal(calls, 2); assert.equal(result.data.claims.length, 2);
    const repair = JSON.parse(seen[1].messages.at(-1).content);
    assert.equal(repair.repair_plan.mode, "rebuild_compact");
    assert.ok(repair.issues.some((i: Json) => i.rule === "Too many claims for a compact answer"));
    assert.equal(seen[0].response_format.type, "json_object");
  } finally { l.close(); }
});

test("truncation is reported without advising only a larger token limit and is never repaired blindly", async () => {
  const l = ledger(), s = evaluationCases()[0]; let calls = 0;
  try {
    await assert.rejects(generatePrepared(l.settings, l.db, s.input, "length", (async () => { calls++; return reply({}, "length"); }) as typeof fetch),
      (e: unknown) => e instanceof ModelError && /обрезан/.test(e.message) && /не является исправлением/.test(e.message) && !/Увеличьте LLM_MAX_OUTPUT_TOKENS и запустите/.test(e.message));
    assert.equal(calls, 1);
  } finally { l.close(); }
});

test("numeric repair names every section that depends on the same claim", () => {
  const s = evaluationCases()[0], d = referenceDraft(s);
  const plan = repairPlan([{ stage: "grounding", path: "/why_relevant", rule: "Unsupported section number" }], d, false, { input: s.input });
  assert.deepEqual(plan.fix_together, ["/claims/1", "/why_relevant", "/recommendations/0", "/grounding/recommendations/0/condition"]);
  const q = repairPlan([{ stage: "grounding", path: "/claims/1", rule: "Unsupported numeric assertion" }],
    { answer: "x", claims: d.claims, claim_indexes: [0, 1] }, true);
  assert.deepEqual(q.fix_together, ["/claims/1", "/answer"]);
  assert.equal(repairPlan([{ stage: "grounding", path: "/claims/1/text", rule: "Unconfirmed linkage must not be stated as proven absence" }], d, false, { input: s.input })
    .industry_wording.relation, "unknown");
});

test("the server wording for each industry relation passes its own guard and fails the others", () => {
  const s = evaluationCases()[0];
  const phrases: Record<string, string> = {};
  for (const [relation, code] of [["unknown", null], ["mismatch", "86.23"], ["match", "49.42"]] as const) {
    if (code) { s.input.event = transportEvent(); s.input.profile.industry.okved_code = code; }
    const wording = industryWording(s.input);
    assert.equal(wording.relation, relation);
    assert.deepEqual(cautiousLanguageRules(wording.use, s.input), [], relation);
    phrases[relation] = wording.use;
  }
  // Now relation=match: the other two wordings are not interchangeable with it.
  assert.ok(cautiousLanguageRules(phrases.mismatch, s.input).includes("Industry relation assertion contradicts prepared event"));
});

test("noun forms of industry mismatch follow the prepared relation; open questions stay allowed", () => {
  const s = evaluationCases()[0]; s.input.event = transportEvent(); s.input.profile.industry.okved_code = "49.42";
  const rule = "Industry relation assertion contradicts prepared event";
  // REPORT7 call-05 limitation under relation=match.
  assert.ok(cautiousLanguageRules("Отраслевое несоответствие по конкретным проектам: тема новости не доказывает обязательность.", s.input).includes(rule));
  assert.deepEqual(cautiousLanguageRules("Отраслевое соответствие подтверждается кодами профиля и тематики.", s.input), []);
  assert.deepEqual(cautiousLanguageRules("Отраслевое несоответствие не установлено.", s.input), []);
  s.input.profile.industry.okved_code = "86.23";
  assert.deepEqual(cautiousLanguageRules("Отраслевое несоответствие не исключает косвенных связей.", s.input), []);
});

test("an industry match does not let AI text assign budget funding or contracts to the company", () => {
  const s = evaluationCases()[0]; s.input.event = transportEvent(); s.input.profile.industry.okved_code = "49.42";
  const rule = "Project participation or budget funding is not established";
  for (const text of ["Компания получает бюджетные средства по транспортной программе.", "Компания участвует в государственной программе развития транспорта."])
    assert.ok(cautiousLanguageRules(text, s.input).includes(rule), text);
  for (const text of ["Участие компании в программе и получение бюджетных средств не подтверждены.",
    "Если компания участвует в государственной программе, уточнить условия контрактов.",
    "Компания не получает подтверждённых бюджетных средств по данным снимка — это требует проверки."])
    assert.deepEqual(cautiousLanguageRules(text, s.input), [], text);
});

test("unknown payment currency and period need their own path and an actual unknown value", () => {
  const s = evaluationCases()[0]; Object.assign(s.input.profile.payment_summary, { currency: null, period: null });
  const claim = { kind: "ai", text: "Валюта платежей и период платежей неизвестны.", profile_paths: ["/payment_summary/incoming_amount"] };
  assert.ok(claimProfileRules(claim, s.input).includes("Profile claim assertion needs matching profile path"));
  claim.profile_paths.push("/payment_summary/currency", "/payment_summary/period");
  assert.deepEqual(claimProfileRules(claim, s.input), []);
  s.input.profile.payment_summary.currency = "RUB";
  assert.ok(claimProfileRules(claim, s.input).includes("Payment assertion contradicts the snapshot"));
  assert.deepEqual(claimProfileRules({ ...claim, text: "Если валюта платежей неизвестна, уточнить договоры." }, s.input), []);
});
