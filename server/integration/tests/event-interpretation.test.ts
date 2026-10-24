import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, loadSettings } from "../../config.js";
import { Store } from "../../db.js";
import type { Json } from "../../types.js";
import { articleToEvent, extractEventDetails, validateEventDetails } from "../../news-events.js";
import { eventInterpretation } from "../event-interpretation.js";
import { adviceConstraints } from "../advice-policy.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { ANALYSIS_PROMPT, QUESTION_PROMPT } from "../analysis-prompts.js";
import { createGateway } from "../gateway.js";
import { ContractClient } from "../client.js";
import { MockAgent } from "../agent.js";
import { MockRetrieval } from "../retrieval.js";
import { envelope } from "../contracts.js";

const fixtures = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/event_interpretation_cases.json"), "utf8"));
function input(id: string, code = "49.41") {
  const v = evaluationCases()[0].input;
  v.as_of = fixtures.as_of;
  v.event = structuredClone(fixtures.cases.find((c: Json) => c.id === id).event);
  v.profile.industry.okved_code = code;
  v.profile.industry.okved_division = code.slice(0, 2);
  v.profile.industry.name = code.startsWith("49") ? "Перевозки" : code.startsWith("86") ? "Стоматология" : "Торговля электроэнергией";
  v.profile.bank_products.leasing = true;
  v.ranked_item.news_id = v.event.news_id; v.ranked_item.event_id = v.event.event_id;
  v.research.items = [];
  return v;
}

for (const row of fixtures.cases) test("shared Node/ML fixture preserves sourced event: " + row.id, () => {
  assert.deepEqual(articleToEvent(row.article), row.event);
  validateEventDetails(row.event);
  for (const entry of row.event.event_details.evidence) {
    for (const id of entry.source_ids) assert.ok(row.event.sources.find((s: Json) => s.id === id)?.excerpt.includes(entry.quote));
  }
});

test("a key-rate hold does not establish unchanged market or company financing terms", () => {
  const i = input("rate_hold");
  const before = structuredClone(i), hints = adviceConstraints(i);
  assert.equal(hints.review_mode, "monitoring_only");
  assert.ok(hints.event_interpretation.rate_hold);
  assert.equal(hints.event_interpretation.rate_hold.key_rate_unchanged, true);
  assert.equal(hints.event_interpretation.rate_hold.company_financing_terms_unchanged, null);
  assert.equal(hints.event_interpretation.rate_hold.market_financing_terms_unchanged, null);
  assert.ok(hints.event_interpretation.rate_hold.required_data.some((s: string) => /договор/.test(s)));
  assert.deepEqual(i, before);
  for (const quote of ["Банк России повысил ключевую ставку на 100 б.п.", "Банк России снизил ключевую ставку на 100 б.п.", "Банк России может сохранить ключевую ставку."]) {
    const copy = structuredClone(i); copy.event.event_details = undefined; copy.event.event_type = "other";
    copy.event.sources[0].excerpt = quote; copy.event = extractEventDetails(copy.event);
    assert.equal(eventInterpretation(copy).rate_hold, null);
  }
});

test("carrier and dentistry have distinct sector applicability without inventing contracts", () => {
  const carrier = eventInterpretation(input("transport_budget")), dentist = eventInterpretation(input("transport_budget", "86.23"));
  assert.equal(carrier.industry.relation, "match"); assert.equal(dentist.industry.relation, "mismatch");
  assert.equal(carrier.industry.contract_participation_inferred, false);
  assert.equal(carrier.industry.basis, "inferred_subject_codes");
  assert.deepEqual(input("transport_budget").event.event_details.target_okved_codes, []);
  const unknown = input("transport_budget"); unknown.profile.industry.okved_code = null; unknown.profile.industry.okved_division = null;
  assert.equal(eventInterpretation(unknown).industry.relation, "unknown");
});

test("standards development preserves its stage and never establishes mandatory application", () => {
  const v = eventInterpretation(input("standards_development", "35.14"));
  assert.equal(v.industry.relation, "match"); assert.equal(v.standards.stage, "development");
  assert.equal(v.standards.mandatory_for_company, null);
  assert.ok(v.standards.observations[0].quote.includes("приступил к разработке"));
});

test("stages distinguish discussion, draft, adoption, future and reported entry into force", () => {
  const examples = [
    ["Обсуждается новый стандарт.", "discussion"],
    ["Представлен проект стандарта.", "draft"],
    ["Утвержден новый стандарт.", "adopted"],
    ["Стандарт вступит в силу со следующего года.", "entry_into_force_announced"],
    ["Стандарт вступил в силу.", "in_force_reported"],
    ["Стандарт не принят.", "unknown"],
    ["Стандарт может быть принят.", "unknown"],
    ["Утверждена программа разработки новых ГОСТов.", "unknown"],
    ["Приступил к разработке ГОСТов. Новый стандарт утвержден.", "mixed"],
  ];
  for (const [quote, stage] of examples) {
    const v = input("standards_development"); v.event.event_details = undefined; v.event.sources[0].excerpt = quote;
    assert.equal(eventInterpretation(v).standards.stage, stage, quote);
  }
});

test("analysis and follow-up receive the same hold/stage safeguards without editing repair", async () => {
  const parent = resolve(ROOT, "var"); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(resolve(parent, "event-interpretation-"));
  const settings = { ...loadSettings({ LLM_MODE: "live", LLM_API_KEY: "synthetic-test-key", LLM_BASE_URL: "https://model.invalid/v1" }), dbPath: resolve(dir, "calls.sqlite3") };
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  try {
    for (const id of ["rate_hold", "standards_development"]) {
      const v = input(id), draft = referenceDraft({ id: "synthetic-interpretation", input: v, expectations: [] });
      let generated: Json | undefined, questioned: Json | undefined;
      const reply = (value: Json) => Response.json({ choices: [{message:{role:"assistant",content:JSON.stringify(value)},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1} });
      const analysis = await generatePrepared(settings, db, v, "analysis", (async (_url, init) => {
        generated = JSON.parse(String(init?.body)); return reply(draft);
      }) as typeof fetch);
      const answer = {answer:draft.summary + " " + draft.why_relevant,claims:draft.claims,claim_indexes:[0,1],limitations:draft.limitations,missing_data:draft.missing_data};
      await answerPrepared(settings, db, {company_id:v.company_id,analysis:analysis.data,question:"Условия остались прежними?",history:[],prepared_input:v}, "question", (async (_url, init) => {
        questioned = JSON.parse(String(init?.body)); return reply(answer);
      }) as typeof fetch);
      assert.equal(generated!.messages[0].content, ANALYSIS_PROMPT);
      assert.equal(questioned!.messages[0].content, QUESTION_PROMPT);
      const a = JSON.parse(generated!.messages[1].content).advice_constraints.event_interpretation;
      const b = JSON.parse(questioned!.messages[1].content).advice_constraints.event_interpretation;
      assert.deepEqual(a, b);
      if (id === "rate_hold") assert.equal(b.rate_hold.company_financing_terms_unchanged, null);
      else assert.equal(b.standards.stage, "development");
    }
  } finally { db.close(); assert.ok(dir.startsWith(parent)); rmSync(dir, { recursive: true, force: true }); }
});

test("manual news is enriched before both direct ranking and analysis-context ML requests", async () => {
  const seen: Json[] = [], company = input("transport_budget").profile;
  const ml = new ContractClient("http://ml.invalid", 500, (async (url, init) => {
    const requestId = (init!.headers as Json)["X-Request-ID"];
    if (new URL(String(url)).pathname !== "/v1/rank") return Response.json(envelope(company, requestId, "mock"));
    const request = JSON.parse(String(init!.body)); seen.push(request.events[0]);
    return Response.json(envelope({company_id:request.company_id,as_of:request.as_of,items:request.events.map((e: Json) => ({
      news_id:e.news_id,event_id:e.event_id,score:0.5,score_kind:"mock",reasons:[{code:"synthetic",text:"Тест подготовки события",profile_paths:["/industry/okved_code"]}],warnings:[]
    })),excluded_future_news_ids:[],truncated:false}, requestId, "mock"));
  }) as typeof fetch);
  const server = createGateway({ml,agent:new MockAgent(),retrieval:new MockRetrieval()}).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    for (const row of fixtures.cases) {
      const raw = structuredClone(row.event); delete raw.event_details; raw.event_type = "other";
      for (const path of ["/v1/rank", "/v1/analysis-context"]) {
        const data = path.endsWith("rank") ? {company_id:company.company_id,events:[raw],as_of:fixtures.as_of,limit:1}
          : {company_id:company.company_id,event:raw,as_of:fixtures.as_of,audience_role:"cfo"};
        const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
        assert.deepEqual(seen.at(-1), row.event);
      }
      assert.equal(raw.event_type, "other"); assert.equal(raw.event_details, undefined);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
