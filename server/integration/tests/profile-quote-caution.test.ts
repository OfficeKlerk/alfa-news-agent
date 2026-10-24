import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { ApiFault, validate } from "../contracts.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { profilePathIndex, profileValue } from "../profile-paths.js";
import { cautiousLanguageRule, rankingEvidence } from "../cautious-language.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { responseGuidance } from "../repair-guidance.js";

const payments = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/payment_contract_cases.json"), "utf8"));
const regressions = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/llm_profile_quote_regressions.json"), "utf8")).cases;
const reply = (v: Json) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }] });
function sample(name = "available") {
  const s = evaluationCases()[0]; s.input.profile = structuredClone(payments.profiles[name]);
  s.input.company_id = s.input.profile.company_id; return s;
}
function ledger(format: string) {
  mkdirSync(resolve(ROOT, "var"), { recursive: true });
  const folder = mkdtempSync(resolve(ROOT, "var/profile-caution-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "test-only-key", LLM_BASE_URL: "https://provider.invalid/v1",
    LLM_RESPONSE_FORMAT: format, LLM_REASONING_EFFORT: "none" }), dbPath: resolve(folder, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return { db, settings, close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
test("profile index advertises only validated business values, indexed statistics and their matching coverage", () => {
  for (const profile of Object.values(payments.profiles) as Json[]) {
    const index = profilePathIndex(profile);
    assert.ok(index.entries.length <= 64); assert.ok(!JSON.stringify(index).includes("provenance"));
    for (const entry of index.entries) {
      const value = profileValue(profile, entry.path);
      assert.equal(entry.type, value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
      assert.ok(!/\/(?:source|evidence|limitation|method|scope)(?:\/|$)/.test(entry.path));
      assert.ok(value === null || typeof value !== "object" || Array.isArray(value) && value.every(v => v === null || typeof v !== "object"));
      for (const coverage of entry.coverage_paths) assert.ok(index.entries.some(v => v.path === coverage));
    }
  }
  const p = sample().input.profile, index = profilePathIndex(p);
  for (const direction of ["in", "out"]) {
    const path = `/payment_summary/counterparty_context/${direction}/industry_distribution/0/share_of_direction`;
    const entry = index.entries.find(v => v.path === path); assert.ok(entry);
    assert.deepEqual(entry.coverage_paths, ["known_share", "unknown_share"].map(k => `/payment_summary/counterparty_context/${direction}/coverage/industry/${k}`));
  }
  assert.ok(index.entries.some(e => e.type === "boolean" && profileValue(p, e.path) === false));
  assert.ok(index.entries.some(e => e.type === "number" && profileValue(p, e.path) === 0));
  assert.ok(index.entries.some(e => e.type === "null" && e.unknown));
  assert.deepEqual(profilePathIndex(p, 0).entries, []);
  for (const size of [1, 7, 20, 64]) {
    const limited = profilePathIndex(p, size); assert.ok(limited.entries.length <= size);
    for (const e of limited.entries) assert.ok(e.coverage_paths.every(path => limited.entries.some(v => v.path === path)));
  }
});
test("arbitrary paths, whole objects, service fields, array properties and missing coverage still reject", () => {
  const s = sample(), context = prepareContext(s.input);
  for (const suffix of ["in/industry_distribution", "out/industry_distribution/0", "in/industry_distribution/999/share_of_direction",
    "in/industry_distribution/length", "method", "scope", "evidence/fields", "source", "limitation"])
    assert.throws(() => profileValue(s.input.profile, "/payment_summary/counterparty_context/" + suffix));
  for (const path of ["/provenance/company_raw_fields", "/data_quality", "/industry/does_not_exist", "/industry/__proto__"])
    assert.throws(() => profileValue(s.input.profile, path));
  const entry = profilePathIndex(s.input.profile).entries.find(v => /out\/industry_distribution\/0\/share_of_direction$/.test(v.path))!;
  const draft = referenceDraft(s); draft.claims[1].profile_paths = [entry.path, ...entry.coverage_paths];
  validateGrounding(draft, context);
  draft.claims[1].profile_paths = [entry.path];
  assert.throws(() => validateGrounding(draft, context), /matching coverage/);
  draft.claims[1].profile_paths = [entry.path, ...entry.coverage_paths.map(p => p.replace("/out/", "/in/"))];
  assert.throws(() => validateGrounding(draft, context), /matching coverage/);
});

for (const format of ["json_object", "json_schema"]) {
  test(`${format}: power-trader repairs to an existing statistic plus coverage within two calls`, async () => {
    const l = ledger(format), s = sample(); let calls = 0;
    try {
      const result = await generatePrepared(l.settings, l.db, s.input, "power-trader", (async (_url, init) => {
        calls++; const payload = JSON.parse(String(init?.body)), data = JSON.parse(payload.messages[1].content);
        const draft = referenceDraft(s);
        if (calls === 1) draft.claims[1].profile_paths = regressions[0].profile_paths;
        else {
          const repair = JSON.parse(payload.messages.at(-1).content);
          assert.ok(repair.repair_rules.some((r: Json) => /конкретный|статистический лист/.test(r.instruction)));
          assert.deepEqual(repair.response_guidance.profile_path_index, data.response_guidance.profile_path_index);
          const entry = repair.response_guidance.profile_path_index.entries.find((e: Json) => /out\/industry_distribution\/0\/share_of_direction$/.test(e.path));
          assert.ok(entry); draft.claims[1].profile_paths = [entry.path, ...entry.coverage_paths];
          draft.claims[1].text = draft.why_relevant = "Связь события с наблюдаемым потоком требует проверки состава неизвестных контрагентов и покрытия отраслевых данных.";
        }
        return reply(draft);
      }) as typeof fetch);
      assert.equal(calls, 2); assert.ok(result.data.claims[1].profile_paths.some((p: string) => p.endsWith("unknown_share")));
      let questionCalls = 0;
      await answerPrepared(l.settings, l.db, { analysis: result.data, company_id: s.input.company_id, question: "Какие связи проверить?",
        history: [], prepared_input: s.input }, "indexed-question", (async (_url, init) => {
        questionCalls++; const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        assert.ok(data.response_guidance.profile_path_index.entries.length);
        return reply({ answer: result.data.summary + "\n" + result.data.why_relevant, claims: result.data.claims, claim_indexes: [0, 1],
          limitations: result.data.limitations, missing_data: result.data.missing_data });
      }) as typeof fetch);
      assert.equal(questionCalls, 1);
    } finally { l.close(); }
  });
  test(`${format}: metal-borrower copies one selected quote into text and quote; fabricated quote never passes`, async () => {
    const l = ledger(format), s = sample(); let calls = 0;
    try {
      await generatePrepared(l.settings, l.db, s.input, "metal-borrower", (async (_url, init) => {
        calls++; const payload = JSON.parse(String(init?.body)), draft = referenceDraft(s);
        if (calls === 1) draft.claims[0].text = regressions[1].text;
        else {
          const repair = JSON.parse(payload.messages.at(-1).content);
          assert.ok(repair.issues.some((i: Json) => i.path === "/claims/0/text"));
          const chosen = repair.response_guidance.quote_candidates.find((c: Json) => c.kind === "fact").claim;
          assert.equal(chosen.text, chosen.quote); draft.claims[0] = chosen; draft.summary = chosen.quote;
        }
        return reply(draft);
      }) as typeof fetch);
      assert.equal(calls, 2);
      for (const wrong of ["paraphrase", "fabricated"]) {
        calls = 0;
        await assert.rejects(generatePrepared(l.settings, l.db, s.input, "bad-quote-twice", (async () => {
          calls++; const bad = referenceDraft(s);
          if (wrong === "paraphrase") bad.claims[0].text = regressions[1].text;
          else bad.claims[0].text = bad.claims[0].quote = "Цитата, которой нет в разрешённом источнике.";
          return reply(bad);
        }) as typeof fetch), (error: unknown) => {
          assert.ok(error instanceof ModelError); assert.equal(error.diagnostics!.attempts, 2);
          assert.ok(error.diagnostics!.issues.some(i => i.path === (wrong === "paraphrase" ? "/claims/0/text" : "/claims/0/quote")));
          return true;
        });
        assert.equal(calls, 2);
      }
    } finally { l.close(); }
  });
  test(`${format}: power-software repairs categorical absence and freshness-only claims without inventing effects`, async () => {
    const l = ledger(format), s = evaluationCases()[2];
    s.input.ranked_item.feature_contributions = [
      { feature: "freshness", value: 1, coefficient: 0.4, contribution: 0.4, scale: "raw_score", profile_paths: [], source_ids: [] },
      { feature: "industry_subject_mismatch", value: 1, coefficient: -0.7, contribution: -0.7, scale: "raw_score", profile_paths: ["/industry/name"], source_ids: [] }];
    try {
      for (const text of [regressions[2].text, "Ранжирование основано исключительно на свежести."]) {
        let calls = 0;
        const result = await generatePrepared(l.settings, l.db, s.input, "power-software", (async (_url, init) => {
          calls++; const payload = JSON.parse(String(init?.body)), draft = referenceDraft(s);
          if (calls === 1) draft.claims[1].text = draft.why_relevant = text;
          else {
            const repair = JSON.parse(payload.messages.at(-1).content);
            assert.equal(repair.response_guidance.ranking_evidence.freshness_only_confirmed, false);
            assert.equal(repair.response_guidance.ranking_evidence.nonzero_count, 2);
            assert.ok(repair.issues.some((i: Json) => /proven absence|contributions/.test(i.rule)));
          }
          return reply(draft);
        }) as typeof fetch);
        assert.equal(calls, 2); assert.deepEqual(result.data.risks, []); assert.deepEqual(result.data.opportunities, []);
        assert.match(result.data.why_relevant, /не подтверждена предоставленными данными/);
      }
    } finally { l.close(); }
  });
}

test("all nonzero ranking contributions count, including negative, tiny and cancelling rows", () => {
  const input = sample().input;
  const row = (feature: string, contribution: number) => ({ feature, value: 0, coefficient: 0, contribution });
  for (const rows of [undefined, [], [row("freshness", 0)], [row("freshness", 1), row("graph_in_share", -0.1)],
    [row("freshness", 1), row("industry_match", 1e-20)], [row("freshness", 1), row("other", 1), row("other", -1)],
    [...Array(65).fill(row("freshness", 1)), row("industry_match", -0.1)]]) {
    input.ranked_item.feature_contributions = rows;
    assert.equal(rankingEvidence(input).freshness_only_confirmed, false);
    assert.equal(cautiousLanguageRule("Ранжирование основано исключительно на свежести.", input), "Freshness-only ranking explanation is not supported by contributions");
  }
  input.ranked_item.feature_contributions = [row("freshness", 1), row("industry_match", 0)];
  assert.equal(rankingEvidence(input).freshness_only_confirmed, true);
  assert.equal(cautiousLanguageRule("По переданным вкладам ранжирование основано исключительно на свежести.", input), undefined);
  assert.equal(cautiousLanguageRule("Нельзя утверждать, что ранжирование основано только на свежести.", input), undefined);
  assert.equal(cautiousLanguageRule("Из неполного графа не следует, что прямая связь отсутствует.", input), undefined);
});
test("negative control is cautious, has no invented effects and applies to AI sections and questions", () => {
  const s = evaluationCases()[2], context = prepareContext(s.input), draft = referenceDraft(s);
  assert.deepEqual(draft.risks, []); assert.deepEqual(draft.opportunities, []); validateGrounding(draft, context);
  for (const key of ["why_relevant", "limitations", "missing_data"]) {
    const bad = structuredClone(draft); bad[key] = typeof bad[key] === "string" ? regressions[2].text : [regressions[2].text];
    assert.throws(() => validateGrounding(bad, context), /proven absence/);
  }
  const ai = structuredClone(draft); ai.claims[1].text = regressions[2].text;
  assert.throws(() => validateGrounding(ai, context), /proven absence/);
  const q = { answer: draft.summary + "\n" + regressions[2].text, claims: draft.claims, claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data };
  assert.throws(() => validateQuestionGrounding(q, context, true), /proven absence/);
  const l = { ...draft, why_relevant: "Связь не подтверждена предоставленными данными." }; validateGrounding(l, context);
  for (const text of ["Компания не связана с этим событием.", "Новость не влияет на компанию."])
    assert.throws(() => validateGrounding({ ...draft, why_relevant: text }, context), /proven absence/);
  const combined = { ...draft, why_relevant: regressions[2].text + " Ранжирование основано исключительно на свежести." };
  try { validateGrounding(combined, context, false, true); assert.fail("Expected both policy violations"); }
  catch (error) {
    assert.ok(error instanceof ApiFault);
    assert.ok(error.diagnostics!.issues.some(i => /proven absence/.test(i.rule)));
    assert.ok(error.diagnostics!.issues.some(i => /contributions/.test(i.rule)));
  }
});
test("literal bank examples are copied too; age is disclosed without rejecting an otherwise as_of-eligible source", () => {
  const s = sample(), context = prepareContext(s.input), guide = responseGuidance(context, "");
  const bank = guide.quote_candidates.find(c => c.kind === "bank"); assert.ok(bank);
  assert.equal(bank.claim.text, bank.claim.quote); assert.ok(context.sources.find(c => c.id === bank.source_id)!.excerpt.includes(bank.claim.quote));
  assert.ok(bank.published_at); assert.match(bank.note, /исторический|текущая позиция/);
  const draft = referenceDraft(s); draft.claims.push(bank.claim); draft.summary += "\n" + bank.claim.quote; draft.grounding.summary.push(2);
  validateGrounding(draft, context);
  const bad = structuredClone(draft); bad.claims[2].text = "Пересказ банковского фрагмента";
  assert.throws(() => validateGrounding(bad, context), /must equal/);
  bad.claims[2].text = bad.claims[2].quote = "Банк подтвердил вымышленное утверждение.";
  assert.throws(() => validateGrounding(bad, context), /Quote not found/);
  validate("AgentRequest", s.input);
});
