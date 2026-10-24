import { test } from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, ROOT } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { analysisDraft, validateGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { ANALYSIS_PROMPT } from "../analysis-prompts.js";
import { generatedResponseSchema } from "../response-schema.js";

const reply = (draft: Json) => Response.json({ choices: [{ finish_reason: "stop",
  message: { role: "assistant", content: JSON.stringify(draft) } }] });
const answer = (draft: Json) => ({ answer: draft.summary + " " + draft.why_relevant, claims: draft.claims,
  claim_indexes: [0, 1], limitations: draft.limitations, missing_data: draft.missing_data });

test("prompt example keeps recommendation text and grounding separate and passes unchanged validators", () => {
  const scenario = evaluationCases()[0], draft = referenceDraft(scenario);
  Object.assign(draft, JSON.parse(ANALYSIS_PROMPT.match(/```json\n([^]*?)\n```/)![1]));
  validateGrounding(draft, prepareContext(scenario.input));
  assert.deepEqual(Object.keys(draft.grounding).sort(), ["opportunities", "recommendations", "risks", "summary", "why_relevant"]);
  draft.recommendations = []; draft.grounding.recommendations = [];
  validateGrounding(draft, prepareContext(scenario.input));
});

test("provider schemas accept reference drafts and reject recommendation objects and extra grounding fields", () => {
  const ajv = new Ajv2020({ strict: false });
  const check = ajv.compile(generatedResponseSchema("GeneratedAnalysis").schema);
  const questionCheck = ajv.compile(generatedResponseSchema("GeneratedAnswer").schema);
  for (const scenario of evaluationCases()) {
    const draft = referenceDraft(scenario);
    assert.ok(check(draft), JSON.stringify(check.errors));
    assert.ok(questionCheck(answer(draft)), JSON.stringify(questionCheck.errors));
  }
  const scenario = evaluationCases()[0], context = prepareContext(scenario.input);
  for (const mutate of [
    (v: Json) => { v.recommendations[0] = { text: v.recommendations[0], ...v.grounding.recommendations[0] }; },
    (v: Json) => { v.grounding.recommendations[0] = "Уточнить условия"; },
    (v: Json) => { v.grounding.recommendations[0].text = v.recommendations[0]; },
    (v: Json) => { v.grounding.limitations = []; },
    (v: Json) => { v.grounding.missing_data = []; },
    (v: Json) => { delete v.grounding.risks; },
  ]) {
    const draft = referenceDraft(scenario); mutate(draft);
    assert.equal(check(draft), false); assert.throws(() => validateGrounding(draft, context));
  }
  // The provider subset omits uniqueItems; the original contract still rejects duplicates.
  const duplicates = referenceDraft(scenario); duplicates.grounding.summary = [0, 0];
  assert.throws(() => validateGrounding(duplicates, context));
  function strictObjects(node: Json) {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    assert.equal(node.$ref, undefined); assert.equal(node.uniqueItems, undefined);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(v => { if (v && typeof v === "object") strictObjects(v); });
      else if (value && typeof value === "object") strictObjects(value);
    }
  }
  strictObjects(generatedResponseSchema("GeneratedAnalysis").schema);
  strictObjects(generatedResponseSchema("GeneratedAnswer").schema);
});

test("response format configuration is explicit and rejects unsupported values", () => {
  assert.equal(loadSettings({}).responseFormat, "json_object");
  assert.equal(loadSettings({ LLM_RESPONSE_FORMAT: "json_schema" }).responseFormat, "json_schema");
  assert.throws(() => loadSettings({ LLM_RESPONSE_FORMAT: "auto" }), /LLM_RESPONSE_FORMAT/);
});

for (const format of ["json_object", "json_schema"] as const) {
  test(`role 2 ${format} repairs invalid recommendation shapes once using the same contract`, async () => {
    for (const mutate of [
      (v: Json) => { v.recommendations[0] = { text: v.recommendations[0] }; },
      (v: Json) => { v.grounding.limitations = []; },
    ]) {
      mkdirSync(resolve(ROOT, "var"), { recursive: true });
      const folder = mkdtempSync(resolve(ROOT, "var/response-test-"));
      const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "local-test-secret",
        LLM_BASE_URL: "https://provider.invalid/v1", LLM_RESPONSE_FORMAT: format }),
        dbPath: resolve(folder, "calls.sqlite3") };
      const db = new Store(settings), scenario = evaluationCases()[0], seen: Json[] = [];
      db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
      const expectedFormat = (name: "GeneratedAnalysis" | "GeneratedAnswer") => format === "json_schema"
        ? { type: format, json_schema: { ...generatedResponseSchema(name), strict: true } } : { type: format };
      try {
        const result = await generatePrepared(settings, db, scenario.input, "shape-repair", (async (_url, init) => {
          seen.push(JSON.parse(String(init?.body)));
          const draft = referenceDraft(scenario); if (seen.length === 1) mutate(draft);
          return reply(draft);
        }) as typeof fetch);
        assert.equal(seen.length, 2);
        for (const payload of seen) assert.deepEqual(payload.response_format, expectedFormat("GeneratedAnalysis"));
        validateGrounding(analysisDraft(result.data), prepareContext(scenario.input), true);
        await answerPrepared(settings, db, { company_id: result.data.company_id, analysis: result.data,
          question: "Что проверить?", history: [], prepared_input: scenario.input }, "question-schema", (async (_url, init) => {
          const payload = JSON.parse(String(init?.body));
          assert.deepEqual(payload.response_format, expectedFormat("GeneratedAnswer"));
          return reply(answer(referenceDraft(scenario)));
        }) as typeof fetch);
        let calls = 0;
        await assert.rejects(generatePrepared(settings, db, scenario.input, "unsupported-format", (async () => {
          calls++; return new Response("Unsupported response_format", { status: 400 });
        }) as typeof fetch), ModelError);
        assert.equal(calls, 1, "unsupported format must not trigger a paid fallback request");
        calls = 0;
        await assert.rejects(generatePrepared(settings, db, scenario.input, "invalid-twice", (async () => {
          calls++; const draft = referenceDraft(scenario); mutate(draft); return reply(draft);
        }) as typeof fetch), ModelError);
        assert.equal(calls, 2, "invalid shape must fail closed after one repair");
      } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
    }
  });
}
