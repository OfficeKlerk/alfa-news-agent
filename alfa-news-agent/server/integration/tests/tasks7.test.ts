import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../config.js";
import type { Json } from "../../types.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { profileFactRules } from "../profile-facts.js";
import { cautiousLanguageRules } from "../cautious-language.js";
import { claimProfileRules } from "../claim-profile-grounding.js";
import { prepareContext } from "../context.js";
import { validateGrounding, validateQuestionGrounding } from "../grounding.js";
import { eventInterpretation } from "../event-interpretation.js";
import { repairInstruction } from "../repair-guidance.js";

// Verbatim REPORT7 observations with minimal synthetic inputs. Full private run stays in var.
const absent="В снимке профиля компании отсутствуют отметки о наличии продуктов кредитования, лизинга и факторинга.";
const exposure="Компания имеет в профиле отметку о продукте лизинга, что указывает на наличие договорной экспозиции к процентным ставкам.";
const mismatch="Отрасль компании не совпадает с тематикой новости; возможные косвенные каналы не проверены.";
const trade="В профиле компании отмечена внешнеторговая деятельность (ФТС), но направление торговли и валюты не установлены, что не позволяет подтвердить участие в затронутом маршруте.";
const question=(d:Json)=>({answer:d.summary+"\n"+d.why_relevant,claims:d.claims,claim_indexes:d.claims.map((_:Json,i:number)=>i),limitations:d.limitations,missing_data:d.missing_data});

test("REPORT7 collective product absence respects each null/false/true flag",()=>{
  const s=evaluationCases()[0];
  for(const value of [null,false,true]){
    for(const key of ["loan","leasing","factoring"])s.input.profile.bank_products[key]=value;
    const rules=profileFactRules(absent,s.input);
    if(value===false)assert.deepEqual(rules,[]);
    else assert.ok(rules.includes(value===null?"Unknown product flag must remain unknown":"Product mark contradicts the snapshot"));
  }
  Object.assign(s.input.profile.bank_products,{loan:null,leasing:false,factoring:false});
  assert.ok(profileFactRules(absent,s.input).includes("Unknown product flag must remain unknown"),"loan must not be lost in a collective list");
  for(const text of ["Значения флагов кредитования, лизинга и факторинга неизвестны.","В профиле отсутствуют подтверждённые данные о договорах.","Если в снимке отсутствуют отметки продуктов кредитования, лизинга и факторинга, потребуется проверка."])
    assert.deepEqual(profileFactRules(text,s.input),[],text);
});

test("REPORT7 null cannot become absence inside conditions and question claims",()=>{
  const s=evaluationCases()[0];Object.assign(s.input.profile.bank_products,{loan:null,leasing:null,factoring:null});
  const d=referenceDraft(s);d.claims[1].text=d.why_relevant="Значения продуктовых флагов неизвестны; требуется уточнить наличие договоров.";
  d.claims[1].profile_paths=["/bank_products/loan","/bank_products/leasing","/bank_products/factoring"];
  d.claims[1].conditions=[absent];d.grounding.recommendations[0].condition=absent;
  assert.throws(()=>validateGrounding(d,prepareContext(s.input),false,true),/Unknown product flag/);
  assert.throws(()=>validateQuestionGrounding(question(d),prepareContext(s.input),true),/Unknown product flag/);
  d.claims[1].conditions=["Если действующий договор существует и предусматривает изменение ставки"];
  d.grounding.recommendations[0].condition=d.claims[1].conditions[0];
  validateGrounding(d,prepareContext(s.input),false,true);
  validateQuestionGrounding(question(d),prepareContext(s.input),true);
});

test("REPORT7 product exposure paraphrase is rejected but potential and negated channels remain allowed",()=>{
  const s=evaluationCases()[0];s.input.profile.bank_products.leasing=true;
  assert.ok(profileFactRules(exposure,s.input).includes("Product flags do not establish debt or contract terms"));
  for(const text of ["Отметка лизинга не указывает на наличие договорной экспозиции.","Отметка лизинга указывает на потенциальный канал, если действующий договор существует и предусматривает изменение ставки.","Наличие действующего договора и его условия неизвестны."])
    assert.deepEqual(profileFactRules(text,s.input),[],text);
  const d=referenceDraft(s);d.why_relevant=exposure;
  assert.throws(()=>validateGrounding(d,prepareContext(s.input),false,true),/Product flags do not establish/);
  assert.throws(()=>validateQuestionGrounding(question(d),prepareContext(s.input),true),/Product flags do not establish/);
});

test("industry statements require actual match/mismatch; unknown macro event cannot borrow mismatch wording",()=>{
  const s=evaluationCases()[0];
  assert.equal(eventInterpretation(s.input).industry.relation,"unknown");
  const rule="Industry relation assertion contradicts prepared event";
  assert.ok(cautiousLanguageRules(mismatch,s.input).includes(rule));
  assert.ok(cautiousLanguageRules("Отрасль компании совпадает с тематикой новости.",s.input).includes(rule));
  assert.deepEqual(cautiousLanguageRules("Отраслевое соответствие не установлено; связь не подтверждена.",s.input),[]);
  const fixture=JSON.parse(readFileSync(resolve(ROOT,"tests/fixtures/event_interpretation_cases.json"),"utf8"));
  s.input.event=fixture.cases.find((c:Json)=>c.id==="transport_budget").event;
  s.input.profile.industry.okved_code="86.23";
  assert.equal(eventInterpretation(s.input).industry.relation,"mismatch");
  assert.deepEqual(cautiousLanguageRules(mismatch,s.input),[]);
  assert.ok(cautiousLanguageRules("Прямая отраслевая связь отсутствует.",s.input).includes("Unconfirmed linkage must not be stated as proven absence"));
  s.input.profile.industry.okved_code="49.42";
  assert.equal(eventInterpretation(s.input).industry.relation,"match");
  assert.deepEqual(cautiousLanguageRules("Отрасль компании совпадает с тематикой новости.",s.input),[]);
  assert.ok(cautiousLanguageRules(mismatch,s.input).includes(rule));
});

test("REPORT7 unsupported mismatch is checked in limitations, conditions and answers",()=>{
  const s=evaluationCases()[0],d=referenceDraft(s),ctx=prepareContext(s.input);
  d.limitations.push(mismatch);
  assert.throws(()=>validateGrounding(d,ctx,false,true),/Industry relation assertion/);
  assert.throws(()=>validateQuestionGrounding(question(d),ctx,true),/Industry relation assertion/);
  d.limitations.pop();d.claims[1].conditions.push(mismatch);
  assert.throws(()=>validateGrounding(d,ctx,false,true),/Industry relation assertion/);
  assert.match(repairInstruction({stage:"grounding",path:"/limitations/0",rule:"Industry relation assertion contradicts prepared event"}),/unknown/);
});

test("REPORT7 unknown trade fields require their own paths and actual unknown values",()=>{
  const s=evaluationCases()[0];Object.assign(s.input.profile.foreign_trade,{has_fts:true,trade_direction:null,currencies:null,countries:["КИТАЙ"]});
  const c={text:trade,profile_paths:["/foreign_trade/has_fts","/foreign_trade/countries"]};
  assert.ok(claimProfileRules(c,s.input).includes("Profile claim assertion needs matching profile path"));
  c.profile_paths.push("/foreign_trade/trade_direction","/foreign_trade/currencies");
  assert.deepEqual(claimProfileRules(c,s.input),[]);
  s.input.profile.foreign_trade.currencies=["CNY"];
  assert.ok(claimProfileRules(c,s.input).includes("Trade flags do not establish direction or payment currency"));
  c.text="Если направление торговли и валюты неизвестны, уточнить условия контрактов.";
  assert.deepEqual(claimProfileRules(c,s.input),[]);
});

test("unknown trade grounding applies in analysis and every returned question claim",()=>{
  const s=evaluationCases()[0];Object.assign(s.input.profile.foreign_trade,{has_fts:true,trade_direction:null,currencies:null,countries:["КИТАЙ"]});
  const d=referenceDraft(s);d.claims[1].text=d.why_relevant=trade;
  d.claims[1].profile_paths=["/foreign_trade/has_fts","/foreign_trade/countries"];
  assert.throws(()=>validateGrounding(d,prepareContext(s.input),false,true),/matching profile path/);
  assert.throws(()=>validateQuestionGrounding(question(d),prepareContext(s.input),true),/matching profile path/);
  d.claims[1].profile_paths.push("/foreign_trade/trade_direction","/foreign_trade/currencies");
  validateGrounding(d,prepareContext(s.input),false,true);
  validateQuestionGrounding(question(d),prepareContext(s.input),true);
});
