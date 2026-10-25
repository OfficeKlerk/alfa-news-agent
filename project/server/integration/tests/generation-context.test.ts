import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationCases } from "../evaluation.js";
import { canonicalJson, prepareContext } from "../context.js";
import { generationContext, generationProfile } from "../generation-context.js";
import { profilePathIndex, profileValue } from "../profile-paths.js";
import type { Json } from "../../types.js";

function resolvePointer(value: Json, pointer: string): any {
  return pointer.slice(1).split("/").reduce((v, k) => v[k.replace(/~1/g, "/").replace(/~0/g, "~")], value);
}
for (const scenario of evaluationCases()) {
  test("deduplicated evidence remains exact: " + scenario.id, () => {
    const context = prepareContext(scenario.input), original = canonicalJson(context);
    const view = generationContext(context);
    const { profile, ...rest } = view.input, { profile: full, ...expected } = context.input;
    assert.deepEqual(rest, expected);
    assert.deepEqual(profile, generationProfile(full));
    assert.equal(profile.provenance, undefined);
    assert.ok(!/"source":\{/.test(JSON.stringify(profile)));
    // Every business path the validator accepts resolves to the same value in the provider view.
    for (const entry of profilePathIndex(full).entries) assert.deepEqual(profileValue(profile, entry.path), profileValue(full, entry.path), entry.path);
    assert.equal(view.sha256, context.sha256);
    for (const source of context.sources) {
      const entry = view.evidence_layout.sources.find((s: Json) => s.id === source.id);
      const content = resolvePointer(view, entry.content_ref);
      const { content_ref: _, ...metadata } = entry;
      if (source.kind === "company") { assert.deepEqual(content, generationProfile(context.input.profile)); assert.deepEqual({ ...metadata, excerpt: source.excerpt }, source); }
      else assert.deepEqual({ ...metadata, excerpt: content }, source);
    }
    const question = { prepared_input: scenario.input, company_id: scenario.input.company_id,
      analysis: { id: "saved-analysis", sources: context.sources, summary: "Saved answer" },
      question: "Что известно о платежах?", history: [{ role: "user", content: "Уточнение" }] };
    const savedQuestion = canonicalJson(question);
    const followup = generationContext(context, question);
    assert.deepEqual({ ...followup.prepared_input, profile: full }, context.input);
    assert.equal(followup.analysis.sources, undefined);
    assert.deepEqual(followup.history, question.history);
    assert.equal(followup.question, question.question);
    for (const entry of followup.evidence_layout.sources) {
      const source = context.sources.find(s => s.id === entry.id)!;
      const content = resolvePointer(followup, entry.content_ref);
      if (source.kind === "company") assert.deepEqual(content, generationProfile(context.input.profile));
      else assert.equal(content, source.excerpt);
    }
    assert.equal(canonicalJson(context), original);
    assert.equal(canonicalJson(question), savedQuestion);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(JSON.stringify(context)));
  });
}
