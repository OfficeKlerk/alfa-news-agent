/** Offline audit of original provider responses. Never calls a model or a network API. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import assert from "node:assert/strict";
import { prepareContext } from "../server/integration/context.js";
import { validateGrounding, validateQuestionGrounding } from "../server/integration/grounding.js";
import { ApiFault } from "../server/integration/contracts.js";
import { repairInstruction } from "../server/integration/repair-guidance.js";
import type { Json } from "../server/types.js";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--dir") || !option("--dir") || option("--dir").startsWith("--"))
  throw new Error("Usage: node --import tsx scripts/replay_saved_responses.ts --dir <original run folder> [--out <report.json>]");
const root = resolve(option("--dir"));
function bytes(name: string) {
  const file = resolve(root, name), rel = relative(root, file);
  assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"), "File escapes input directory");
  return readFileSync(file);
}
const read = (name: string): Json => JSON.parse(bytes(name).toString("utf8"));
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const manifest = read("MANIFEST.json");
for (const [file, expected] of Object.entries(manifest)) assert.equal(sha(bytes(file)), expected, "Manifest mismatch: " + file);
const index: Json[] = read("calls-index.json") as unknown as Json[];
const rows = index.map(call => {
  const request = read(call.request_file);
  const sent = JSON.parse(request.messages[1].content);
  const context = prepareContext(call.kind === "question" ? sent.prepared_input : sent.input);
  assert.deepEqual(context.sources, call.kind === "question" ? sent.analysis.sources : sent.sources, "Source drift in call " + call.call);
  const provider = read(call.provider_file), choice = provider.choices[0];
  assert.equal(choice.finish_reason, call.finish_reason);
  const content = choice.message.content;
  // Text exports use Windows newlines; embedded provider content retains LF.
  assert.ok(content.replace(/\r\n/g, "\n") === bytes(call.content_file).toString("utf8").replace(/\r\n/g, "\n"), "Content export mismatch in call " + call.call);
  const row: Json = { call: call.call, case: call.case, operation: call.kind, repair: call.repair,
    format: call.response_format, finish_reason: call.finish_reason, source_sha256: sha(bytes(call.provider_file)),
    completion_tokens: provider.usage?.completion_tokens, status: "truncated", issues: [] };
  if (call.finish_reason === "length") { assert.equal(call.draft_file, null); return row; }
  assert.equal(call.finish_reason, "stop", "Unsupported provider finish reason");
  const draft = JSON.parse(content);
  assert.deepEqual(draft, read(call.draft_file));
  row.claim_count = draft.claims?.length;
  try {
    if (call.kind === "question") validateQuestionGrounding(draft, context, true);
    else validateGrounding(draft, context, false, true);
    row.status = "accepted";
  } catch (error) {
    if (!(error instanceof ApiFault) || !error.diagnostics) throw error;
    row.status = "rejected";
    row.issues = error.diagnostics.issues.map(issue => ({ ...issue, repair_instruction: repairInstruction(issue, call.kind === "question", draft) }));
  }
  return row;
});
const last = [...new Map(rows.map(r => [r.case + ":" + r.operation, r])).values()];
const report = { execution: "saved_response_replay", external_calls: 0, manifest_files_checked: Object.keys(manifest).length,
  original_summary: read("summary.json"), totals: Object.fromEntries(["accepted", "rejected", "truncated"].map(s => [s, rows.filter(r => r.status === s).length])),
  final_attempts: last.map(r => ({case:r.case,operation:r.operation,status:r.status,call:r.call})), calls: rows,
  limitations: ["Original saved responses, not generation under the new prompt.", "Rejection is a guard result, not improved model success.", "No new paid calls, UI checks or proof of economic usefulness."] };
if (args.includes("--out")) { const out = resolve(option("--out")); mkdirSync(dirname(out), {recursive:true}); writeFileSync(out, JSON.stringify(report, null, 2) + "\n"); }
console.log(JSON.stringify({execution:report.execution,external_calls:0,manifest_files_checked:report.manifest_files_checked,totals:report.totals,final_attempts:report.final_attempts,calls:rows.map(r=>({call:r.call,status:r.status,issues:r.issues.map((i:Json)=>({path:i.path,rule:i.rule}))}))},null,2));
