import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, loadSettings } from "../../config.js";
import { Store } from "../../db.js";
import { ModelError, type Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { generatePrepared, answerPrepared } from "../prepared-agent.js";
import { repairInstruction, responseGuidance } from "../repair-guidance.js";
import { profileFactRules } from "../profile-facts.js";
import { claimProfileRules } from "../claim-profile-grounding.js";
import { cautiousLanguageRules } from "../cautious-language.js";
import { eventInterpretation } from "../event-interpretation.js";
import { safeDiagnostics } from "../diagnostics.js";
import { validate } from "../contracts.js";

// These REPORT6 phrase tests use reconstructed contexts. The saved-excerpt tests
// at the end use actual supplied drafts; full original replay is a separate CLI.
const observed = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/tasks6_report_regressions.json"), "utf8"));
const scenario = () => {
  const s = evaluationCases()[0];
  s.input.profile.bank_products.leasing = true;
  s.input.profile.foreign_trade.has_fts = false;
  return s;
};
const question = (d: Json) => ({answer:d.summary + "\n" + d.why_relevant,claims:d.claims,claim_indexes:d.claims.map((_: Json,i: number)=>i),limitations:d.limitations,missing_data:d.missing_data});
function ledger(format: string) {
  mkdirSync(resolve(ROOT, "var"), {recursive:true});
  const dir = mkdtempSync(resolve(ROOT, "var/tasks6-"));
  const settings = {...loadSettings({LLM_MODE:"live",LLM_API_KEY:"synthetic-test-secret",LLM_RESPONSE_FORMAT:format}),dbPath:resolve(dir,"calls.sqlite3")};
  const db = new Store(settings);
  db.connection.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
  return {settings,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
const reply = (d: Json) => Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(d)}}]});

for (const format of ["json_object", "json_schema"]) for (const leasing of [false,true]) {
  test(`${format}, leasing=${leasing}: quote empty arrays get an exact deletion repair and never a third call`, async () => {
    const l = ledger(format), s = scenario();
    s.input.profile.bank_products.loan = false;
    s.input.profile.bank_products.leasing = leasing;
    let calls = 0;
    try {
      const out = await generatePrepared(l.settings,l.db,s.input,"tasks6",(async (_url,init)=>{
        calls++;
        const payload=JSON.parse(String(init?.body)),d=referenceDraft(s);
        if(calls===1){d.claims[0].profile_paths=[];d.claims[0].conditions=[];}
        else {
          const repair=JSON.parse(payload.messages.at(-1).content);
          assert.ok(repair.repair_rules.some((r: Json)=>r.path==="/claims/0/profile_paths"&&/удали/.test(r.instruction)));
          assert.ok(repair.repair_rules.some((r: Json)=>r.path==="/claims/0/conditions"&&/удали/.test(r.instruction)));
          assert.deepEqual(Object.keys(d.claims[0]).sort(),["kind","text","quote","source_ids"].sort());
        }
        return reply(d);
      }) as typeof fetch);
      assert.equal(calls,2);assert.equal(out.data.mode,"live");
      calls=0;
      await assert.rejects(generatePrepared(l.settings,l.db,s.input,"repeated",(async()=>{
        calls++;const d=referenceDraft(s);d.claims[0].profile_paths=[];return reply(d);
      }) as typeof fetch),ModelError);
      assert.equal(calls,2);
    } finally {l.close();}
  });
}

test("repair distinguishes required AI paths from optional quote arrays and wrong source kinds",()=>{
  const issue={stage:"schema" as const,path:"/claims/1/profile_paths",rule:"Too few items"};
  const s=scenario(),d=referenceDraft(s);
  assert.match(repairInstruction(issue,false,d),/обязательны и непусты/);
  assert.match(repairInstruction({...issue,path:"/claims/0/profile_paths"},false,d),/удали/);
  const instruction=repairInstruction({stage:"grounding",path:"/claims/0/source_ids",rule:"Quote source has the wrong evidence kind"});
  assert.match(instruction,/news/);assert.match(instruction,/bank/);assert.match(instruction,/company/);
  assert.match(instruction,/ai/);
  const guidance=responseGuidance(prepareContext(s.input),"never-real-key");
  assert.deepEqual(guidance.claim_shapes.quote_omit_fields,["profile_paths","conditions"]);
  assert.deepEqual(guidance.output_budget.target_claims,[2,5]);
  for(const quote of guidance.quote_candidates)assert.ok(!("profile_paths" in quote.claim)&&!("conditions" in quote.claim));
});

test("verbatim report phrases cannot assert obligations or absence of foreign trade in AI prose",()=>{
  const s=scenario(),context=prepareContext(s.input);
  for(const phrase of observed.rejected_phrases){
    assert.ok(profileFactRules(phrase,s.input).length>0,phrase);
    for(const field of ["why_relevant","limitations","claims","risks","opportunities","recommendations"]){
      const d=referenceDraft(s);
      if(field==="claims")d.claims[1].text=phrase;
      else if(field==="limitations")d.limitations.push(phrase);
      else if(field==="why_relevant")d.why_relevant=phrase;
      else {
        d[field]=[phrase];
        d.grounding[field]=field==="recommendations"
          ? [{claim_indexes:[1],condition:d.claims[1].conditions[0],required_data:d.missing_data}] : [[1]];
      }
      assert.throws(()=>validateGrounding(d,context,false,true),/Product flags|Trade flags/);
    }
    const d=referenceDraft(s),q=question(d);q.answer+="\n"+phrase;
    assert.throws(()=>validateQuestionGrounding(q,context,true),/Product flags|Trade flags/);
  }
  for(const phrase of observed.allowed_phrases)assert.deepEqual(profileFactRules(phrase,s.input),[],phrase);
});

test("a claim cannot hide product/trade facts behind industry paths or a correct short question answer",()=>{
  const s=scenario(),context=prepareContext(s.input);
  for(const [text,paths] of [
    ["В снимке отмечен продукт лизинга.",["/bank_products/leasing"]],
    ["has_fts=false, нет отметки ФТС в снимке.",["/foreign_trade/has_fts"]],
  ] as [string,string[]][]){
    const d=referenceDraft(s);
    d.claims[1].text=text;d.claims[1].profile_paths=["/industry/name"];
    assert.throws(()=>validateGrounding(d,context,false,true),/Profile claim assertion/);
    const q=question(d);q.answer=d.summary; // no extra profile facts in short answer
    assert.throws(()=>validateQuestionGrounding(q,context,true),/Profile claim assertion/);
    d.claims[1].profile_paths=paths;d.why_relevant=text;
    validateGrounding(d,context);
    validateQuestionGrounding(question(d),context,true);
  }
});

test("each claim needs its own payment direction and coverage; another claim cannot supply them",()=>{
  const s=scenario();Object.assign(s.input.profile.payment_summary,{incoming_count:2,outgoing_count:3});
  const d=referenceDraft(s);
  d.claims[1].text="Наблюдаются входящие платежи.";
  d.claims[1].profile_paths=["/payment_summary/outgoing_count"];
  assert.ok(claimProfileRules(d.claims[1],s.input).includes("Profile claim assertion needs matching profile path"));
  d.claims[1].profile_paths=["/payment_summary/incoming_count"];
  assert.deepEqual(claimProfileRules(d.claims[1],s.input),[]);
  s.input.profile.payment_summary.incoming_count=0;
  assert.ok(claimProfileRules(d.claims[1],s.input).includes("Payment assertion contradicts the snapshot"));
});

test("known mismatch accepts precise code comparison while broad absence stays rejected",()=>{
  const s=scenario();
  const fixtures=JSON.parse(readFileSync(resolve(ROOT,"tests/fixtures/event_interpretation_cases.json"),"utf8"));
  s.input.event=structuredClone(fixtures.cases.find((c: Json)=>c.id==="transport_budget").event);
  s.input.as_of=fixtures.as_of;
  s.input.ranked_item.news_id=s.input.event.news_id;s.input.ranked_item.event_id=s.input.event.event_id;
  Object.assign(s.input.profile.industry,{okved_code:"86.23",okved_division:"86",name:"Стоматология"});
  assert.equal(eventInterpretation(s.input).industry.relation,"mismatch");
  const d=referenceDraft(s);d.claims[1].profile_paths=["/industry/okved_code"];
  d.claims[1].text=d.why_relevant="Отрасль компании не совпадает с тематикой новости; возможные косвенные каналы не проверены.";
  validateGrounding(d,prepareContext(s.input));
  validateQuestionGrounding(question(d),prepareContext(s.input),true);
  d.claims[1].text="Прямая отраслевая связь отсутствует.";
  assert.throws(()=>validateGrounding(d,prepareContext(s.input)),/proven absence/);
});

test("new profile-path rule survives public diagnostics and no source types are relaxed",()=>{
  const diagnostic=safeDiagnostics({issues:[{stage:"grounding",path:"/claims/1/profile_paths",rule:"Profile claim assertion needs matching profile path"}]});
  assert.equal(diagnostic.issues.length,1);validate("ResponseDiagnostics",diagnostic);
  const s=scenario(),d=referenceDraft(s);d.claims[0].source_ids=["company:"+s.input.company_id];
  assert.throws(()=>validateGrounding(d,prepareContext(s.input)),/wrong evidence kind/);
});

test("distribution facts require their own direction statistic and matching coverage",()=>{
  const profiles=JSON.parse(readFileSync(resolve(ROOT,"tests/fixtures/payment_contract_cases.json"),"utf8")).profiles;
  const s=scenario();s.input.profile=profiles.available;
  const path="/payment_summary/counterparty_context/in/industry_distribution/0/share_of_direction";
  const coverage=["known_share","unknown_share"].map(k=>"/payment_summary/counterparty_context/in/coverage/industry/"+k);
  const c={kind:"ai",text:"Наблюдаемая доля входящих платежей описывает отраслевой контекст.",profile_paths:[path,...coverage]};
  assert.deepEqual(claimProfileRules(c,s.input),[]);
  c.profile_paths=[path];assert.ok(claimProfileRules(c,s.input).length);
  c.profile_paths=[path,...coverage].map(p=>p.replace("/in/","/out/"));assert.ok(claimProfileRules(c,s.input).length);
});

test("null product marks stay unknown, while correctly qualified snapshot facts remain allowed",()=>{
  const s=scenario();s.input.profile.bank_products.leasing=null;
  const d=referenceDraft(s);d.claims[1].profile_paths=["/bank_products/leasing"];
  d.claims[1].text=d.why_relevant="Отметка лизинга неизвестна; сведения о договоре нужно уточнить.";
  d.missing_data=["Отметка лизинга и условия договоров"];d.limitations=["Наличие продукта и договоров неизвестно."];
  d.recommendations=[];d.grounding.recommendations=[];
  validateGrounding(d,prepareContext(s.input));
  d.claims[1].text="В снимке отмечен продукт лизинга.";
  assert.throws(()=>validateGrounding(d,prepareContext(s.input),false,true),/Unknown product/);
});

test("dated bank quote stays exact and historical, future/undated sources are still blocked",()=>{
  const s=scenario();
  const pages=JSON.parse(readFileSync(resolve(ROOT,"data/research.json"),"utf8"));
  const page=pages.find((p: Json)=>p.filename.includes("Policy_Rate"));
  const quote=page.text.split("\n").find((v: string)=>v.startsWith("Ставка без изменения"));assert.ok(quote);
  const bank={id:"research:"+page.id+":c0",kind:"bank",title:page.title,url:page.url,excerpt:page.text.slice(0,1600),
    document_id:page.document_id,page:page.page,published_at:page.date+"T23:59:59.999Z",is_mock:false};
  assert.ok(bank.excerpt.includes(quote));s.input.research.items=[bank];
  const d=referenceDraft(s);d.claims.push({kind:"bank",text:quote,quote,source_ids:[bank.id]});
  d.summary+="\n"+quote;d.grounding.summary.push(2);
  d.limitations.push("Цитата банка историческая; текущие договорные условия она не подтверждает.");
  validateGrounding(d,prepareContext(s.input));
  for(const date of [null,"2027-01-01T00:00:00Z"]){
    const bad=structuredClone(s.input);bad.research.items[0].published_at=date;
    assert.throws(()=>prepareContext(bad),/Undated or future bank/);
  }
});

const saved = JSON.parse(readFileSync(resolve(ROOT,"tests/fixtures/tasks6_saved_excerpts.json"),"utf8"));
const original = (call: number): Json => saved.cases.find((c: Json)=>c.call===call);

test("original carrier analysis and question cannot hide product/trade assertions in claims",()=>{
  for(const call of [5,15]) {
    const c=original(call),input={profile:c.profile};
    assert.ok(claimProfileRules(c.claims[1],input).includes("Profile claim assertion needs matching profile path"));
    assert.ok(profileFactRules(c.claims[1].text,input).includes("Trade flags do not establish direction or payment currency"));
    const fixed=structuredClone(c.claims[1]);
    fixed.text="В профиле отсутствуют отметки лизинга и кредита; нет отметки ФТС.";
    fixed.profile_paths=["/bank_products/leasing","/bank_products/loan","/foreign_trade/has_fts"];
    assert.deepEqual(claimProfileRules(fixed,input),[]);
    assert.deepEqual(profileFactRules(fixed.text,input),[]);
  }
});

test("original leasing inference is rejected while the original qualified follow-up remains allowed",()=>{
  const c=original(14);
  assert.ok(profileFactRules(c.why_relevant,{profile:c.profile}).includes("Product flags do not establish debt or contract terms"));
  const q=original(19);
  assert.deepEqual(profileFactRules(q.answer,{profile:q.profile}),[]);
  assert.deepEqual(claimProfileRules(q.claims[2],{profile:q.profile}),[]);
});

test("original rate-hold quotes expose the optional-array mistake and receive deletion guidance",()=>{
  for(const call of [10,12,13]) {
    const quote=original(call).claims[0];
    assert.equal(quote.kind,"fact");assert.deepEqual(quote.profile_paths,[]);
    assert.throws(()=>validate("Claim",quote,true),/Too few items/);
    assert.match(repairInstruction({stage:"schema",path:"/claims/0/profile_paths",rule:"Too few items"},false,{claims:[quote]}),/удали/);
    const fixed=structuredClone(quote);delete fixed.profile_paths;
    // A copy explicitly edited for the experiment; not a newly generated answer.
    validate("Claim",fixed,true);
  }
});

test("original dentist prose rejects broad absence and accepts the instructed narrow comparison",()=>{
  const c=original(7),s=scenario();s.input.profile=c.profile;
  const text=c.why_relevant;
  // Profile subset suffices for this lexical check; this is not full context replay.
  assert.ok(cautiousLanguageRules(text,s.input).includes("Unconfirmed linkage must not be stated as proven absence"));
  assert.deepEqual(cautiousLanguageRules(text.replace("Прямая отраслевая связь отсутствует","Отрасль компании не совпадает с тематикой новости; возможные косвенные каналы не проверены"),s.input),[]);
});
