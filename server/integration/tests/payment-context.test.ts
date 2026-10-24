import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, loadSettings } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";
import { validate } from "../contracts.js";
import { prepareContext } from "../context.js";
import { profileValue, validateGrounding } from "../grounding.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareQuestionContext, generatePrepared } from "../prepared-agent.js";
import { LegacyAgent } from "../agent.js";

const cases = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/payment_contract_cases.json"), "utf8"));
function scenario(name = "available") {
  const result = evaluationCases()[0]; result.input.profile = structuredClone(cases.profiles[name]);
  result.input.company_id = result.input.profile.company_id;
  return result;
}
test("Node accepts new payment aggregates, zero/missing source and old frozen profiles", () => {
  for (const profile of Object.values(cases.profiles) as Json[]) {
    validate("Profile", profile);
    const old = structuredClone(profile); delete old.payment_summary.counterparty_context;
    old.provenance.signal_method = "deterministic_rules_v1"; validate("Profile", old);
  }
  validate("ProfileResponse", JSON.parse(readFileSync(resolve(ROOT, "contracts/v1/examples/profile-response.json"), "utf8")));
});
test("Node rejects the same corrupt aggregate vectors as Python", () => {
  for (const mutation of cases.invalid_mutations) {
    const profile = structuredClone(cases.profiles[mutation.profile]);
    for (const patch of mutation.patches ?? [mutation]) {
      const parts = patch.path.slice(1).split("/"); let target = profile;
      for (const key of parts.slice(0, -1)) target = target[key];
      target[parts.at(-1)!] = patch.value;
    }
    assert.throws(() => validate("Profile", profile), mutation.name);
  }
  const rounded = structuredClone(cases.profiles.available);
  rounded.payment_summary.counterparty_context.out.coverage.industry.known_amount += 1e-12;
  validate("Profile", rounded);
});
test("prepared context and saved follow-up retain aggregates; removing the block changes snapshot identity", () => {
  const sample = scenario(), context = prepareContext(sample.input);
  const sourceProfile = JSON.parse(context.sources[0].excerpt);
  assert.deepEqual(sourceProfile.payment_summary.counterparty_context, sample.input.profile.payment_summary.counterparty_context);
  const old = structuredClone(sample.input); delete old.profile.payment_summary.counterparty_context;
  assert.notEqual(prepareContext(old).sha256, context.sha256);
  const question = { company_id: sample.input.company_id, question: "Какие связи проверить?", history: [], prepared_input: sample.input,
    analysis: { ...referenceDraft(sample), id: "payment-analysis", company_id: sample.input.company_id, news_id: sample.input.event.news_id,
      created_at: sample.input.as_of, sources: context.sources, mode: "live", trace: [{ step: "prepared_context", detail: "sha256=" + context.sha256 }] } };
  assert.deepEqual(prepareQuestionContext(question).input.profile.payment_summary, sample.input.profile.payment_summary);
  question.prepared_input = old;
  assert.throws(() => prepareQuestionContext(question), /changed saved evidence|changed reviewed context/);
});
test("grounding permits observed coverage leaves without treating them as losses or provenance metadata", () => {
  const sample = scenario(), context = prepareContext(sample.input), draft = referenceDraft(sample);
  const path = "/payment_summary/counterparty_context/out/coverage/industry/known_share";
  assert.equal(profileValue(sample.input.profile, path), 0.3);
  draft.claims[1].profile_paths = [path, "/payment_summary/counterparty_context/out/coverage/industry/unknown_share"];
  draft.claims[1].text = draft.why_relevant = "В наблюдаемом исходящем потоке доля известных отраслей: 0.3. Неизвестная часть требует уточнения.";
  validateGrounding(draft, context);
  for (const invalid of ["Потери компании составят 0.3.", "Потери компании составят 30%.", "Доля наблюдаемых платежей составляет 30%."]) {
    const changed = structuredClone(draft); changed.claims[1].text = changed.why_relevant = invalid;
    assert.throws(() => validateGrounding(changed, context));
  }
  for (const suffix of ["method", "scope", "evidence/fields", "out/industry_distribution/0"])
    assert.throws(() => profileValue(sample.input.profile, "/payment_summary/counterparty_context/" + suffix));
});
test("legacy projection and mocked live transport carry the full new context without a network call", async () => {
  const folder = mkdtempSync(join(tmpdir(), "payment-context-"));
  const settings = { ...loadSettings({ LLM_MODE: "demo" }), dbPath: join(folder, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE analyses(cache_key TEXT PRIMARY KEY,company_id TEXT,news_id TEXT,payload TEXT); CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT);"
    + "CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  try {
    const sample = scenario(), result = await new LegacyAgent(settings).analyze(sample.input, "payment-test");
    assert.deepEqual(JSON.parse(result.data.sources[0].excerpt).payment_summary, sample.input.profile.payment_summary);
    const live = { ...settings, mode: "live" as const, apiKey: "offline-placeholder", baseUrl: "https://unused.invalid/v1" };
    let called = false;
    await generatePrepared(live, db, sample.input, "payment-live-fixture", (async (_url, init) => {
      called = true; const payload = JSON.parse(String(init?.body));
      const supplied = JSON.parse(payload.messages[1].content);
      assert.deepEqual(supplied.input.profile.payment_summary, sample.input.profile.payment_summary);
      assert.match(payload.messages[0].content, /включая неизвестных контрагентов/);
      return Response.json({ choices: [{ message: { content: JSON.stringify(referenceDraft(sample)) }, finish_reason: "stop" }] });
    }) as typeof fetch);
    assert.equal(called, true);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});
