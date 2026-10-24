import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { truncationCause } from "../../llm.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding } from "../grounding.js";
import { cautiousLanguageRules } from "../cautious-language.js";
import { claimProfileRules, claimProfileSuggestions } from "../claim-profile-grounding.js";
import { generatePrepared } from "../prepared-agent.js";
import { generationBudgetIssues } from "../generation-budget.js";
import { industryWording, repairPlan } from "../repair-guidance.js";
import { ANALYSIS_PROMPT, PROMPT_VERSION } from "../analysis-prompts.js";

// REPORT8 regressions: empty strict replies, claim loops, and the three validator rejections.
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
const transportEvent = () => JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/event_interpretation_cases.json"), "utf8"))
  .cases.find((c: Json) => c.id === "transport_budget").event;

test("an empty provider reply with finish_reason=stop is a provider error, never a draft or a repair", async () => {
  for (const content of [null, "", "  "]) {
    const l = ledger(), s = evaluationCases()[0]; let calls = 0;
    try {
      // REPORT8 calls 20-21: AkashML, native_finish_reason=error, 0 tokens.
      await assert.rejects(generatePrepared(l.settings, l.db, s.input, "empty", (async () => { calls++;
        return Response.json({ provider: "AkashML", choices: [{ finish_reason: "stop", message: { role: "assistant", content },
          provider_specific_fields: { native_finish_reason: "error" } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }); }) as typeof fetch),
      (e: unknown) => e instanceof ModelError && e.code === "MODEL_RESPONSE_INVALID" && /пустой ответ/.test(e.message)
        && /native_finish_reason=error/.test(e.message) && /AkashML/.test(e.message) && !e.diagnostics);
      assert.equal(calls, 1, String(content));
      // No draft row: the rejected-draft table is never even created.
      assert.equal(l.db.get("SELECT count(*) n FROM sqlite_master WHERE name='llm_rejected_drafts'")!.n, 0);
    } finally { l.close(); }
  }
});

test("a truncated loop names the repetition; ordinary growth keeps the generic cause", () => {
  const claim = (text: string) => JSON.stringify({ kind: "ai", text, quote: "", source_ids: [] });
  const loop = '{"claims":[' + [claim("Событие не задает отраслевой код."), ...Array(5).fill(claim("Событие не задает отраслевой код, связь не установлена."))].join(",");
  assert.match(truncationCause(loop), /зацикливание: в обрезанном тексте 6 claim-текстов, из них 4 повторов/);
  assert.match(truncationCause('{"claims":[' + claim("Первый вывод о компании.") + "," + claim("Второй вывод о компании.")), /Обычная причина/);
  assert.match(truncationCause(null), /Обычная причина/);
});

test("a complete draft with a repeated claim gets one compact rebuild", () => {
  const s = evaluationCases()[0], d = referenceDraft(s);
  assert.deepEqual(generationBudgetIssues(d), []);
  d.claims.push({ ...d.claims[1], conditions: ["Иное условие"] });
  const issues = generationBudgetIssues(d);
  assert.deepEqual(issues.map(i => i.rule), ["Repeated claim text"]);
  assert.equal(repairPlan(issues, d, false, { input: s.input }).mode, "rebuild_compact");
});

test("prompt v12+ asks for the industry wording once instead of in every claim", () => {
  // v13/v14 (TASKS8) rewrote copyable rules and added loop guidance; the v12 industry-wording guarantees below still hold.
  assert.equal(PROMPT_VERSION, "company-news-grounded-v14");
  assert.ok(!ANALYSIS_PROMPT.includes("одинаково в каждом ai-claim"));
  assert.ok(ANALYSIS_PROMPT.includes("не повторяй её в каждом claim"));
  // REPORT8 transport-carrier copied the unconditional mismatch rule into limitations under relation=match.
  assert.ok(!ANALYSIS_PROMPT.includes("Отраслевое несоответствие/target_role_mismatch без прямой связи требует"));
  assert.match(industryWording(evaluationCases()[0].input).rule, /не больше одного claim/);
});

test("transport-carrier: the copied mismatch rule stays rejected under relation=match", () => {
  const s = evaluationCases()[0]; s.input.event = transportEvent(); s.input.profile.industry.okved_code = "49.42";
  assert.ok(cautiousLanguageRules("Отраслевое несоответствие без прямой связи требует сначала подтвердить применимость.", s.input)
    .includes("Industry relation assertion contradicts prepared event"));
  assert.deepEqual(cautiousLanguageRules(industryWording(s.input).use, s.input), []);
});

test("trade-foreign: unknown direction and currency need their own paths, and the repair names them", () => {
  const s = evaluationCases()[0];
  // REPORT8 call-10/11 claim 1, rejected on both attempts.
  const claim = { kind: "ai", text: "В профиле компании отмечена внешнеторговая деятельность (ФТС), однако направление торговли и валюты не установлены.",
    quote: "", source_ids: ["company:U_A", "news:demo-rate"], profile_paths: ["/foreign_trade/has_fts", "/foreign_trade/countries"],
    conditions: ["Если компания осуществляет импорт оборудования"] };
  assert.deepEqual(claimProfileRules(claim, s.input), ["Profile claim assertion needs matching profile path"]);
  assert.deepEqual(claimProfileSuggestions(claim, s.input), ["/foreign_trade/trade_direction", "/foreign_trade/currencies"]);
  const draft = { ...referenceDraft(s), claims: [referenceDraft(s).claims[0], claim] };
  const plan = repairPlan([{ stage: "grounding", path: "/claims/1/profile_paths", rule: "Profile claim assertion needs matching profile path" }], draft, false, { input: s.input });
  assert.deepEqual(plan.add_profile_paths, { "/claims/1/profile_paths": ["/foreign_trade/trade_direction", "/foreign_trade/currencies"] });
  assert.match(plan.scope, /Не добавляй новые claims, profile_paths, коды ОКВЭД/);
  // The guard itself is unchanged: with the suggested fields the same text passes.
  assert.deepEqual(claimProfileRules({ ...claim, profile_paths: [...claim.profile_paths, ...plan.add_profile_paths["/claims/1/profile_paths"]] }, s.input), []);
  // A known value still contradicts "not established".
  s.input.profile.foreign_trade.trade_direction = "import";
  assert.ok(claimProfileRules({ ...claim, profile_paths: [...claim.profile_paths, "/foreign_trade/trade_direction", "/foreign_trade/currencies"] }, s.input)
    .includes("Trade flags do not establish direction or payment currency"));
});

test("transport-carrier: a distribution leaf without coverage gets the exact coverage paths as a hint", () => {
  const input = { profile: { payment_summary: { counterparty_context: { in: {
    industry_distribution: [{ okved_division: "49", share_of_direction: 0.4 }],
    coverage: { industry: { known_share: 0.6, unknown_share: 0.4 } } } } } } };
  const claim = { kind: "ai", text: "Отрасль компании совпадает с тематикой новости.", profile_paths: ["/payment_summary/counterparty_context/in/industry_distribution/0/share_of_direction"] };
  assert.deepEqual(claimProfileSuggestions(claim, input), ["/payment_summary/counterparty_context/in/coverage/industry/known_share",
    "/payment_summary/counterparty_context/in/coverage/industry/unknown_share"]);
  const plan = repairPlan([{ stage: "grounding", path: "/claims/0/profile_paths", rule: "Payment statistic needs matching coverage paths" }], { claims: [claim] }, false, { input });
  assert.equal(plan.add_profile_paths["/claims/0/profile_paths"].length, 2);
  // Never a hint for a fact claim or for a path that does not exist.
  assert.equal(repairPlan([{ stage: "grounding", path: "/claims/0/profile_paths", rule: "Payment statistic needs matching coverage paths" }],
    { claims: [{ ...claim, kind: "fact" }] }, false, { input }).add_profile_paths, undefined);
  assert.deepEqual(claimProfileSuggestions({ ...claim, profile_paths: ["/payment_summary/counterparty_context/out/industry_distribution/0/share_of_direction"] }, input), []);
});

test("transport-dentist: an inferred OKVED range in why_relevant stays an unsupported section number", () => {
  const s = evaluationCases()[0], context = prepareContext(s.input), d = referenceDraft(s);
  validateGrounding(d, context, false, true);
  d.why_relevant += " Сектор компании не входит в транспортный сектор (ОКВЭД 49–52).";
  assert.throws(() => validateGrounding(d, context, false, true),
    (e: Json) => e.diagnostics?.issues.some((i: Json) => i.path === "/why_relevant" && i.rule === "Unsupported section number"));
});
