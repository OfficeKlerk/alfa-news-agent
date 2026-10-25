import { developmentAccess } from "../access.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Json } from "../../types.js";
import { loadSettings } from "../../config.js";
import { createGateway } from "../gateway.js";
import { ContractClient } from "../client.js";
import { LiveStore } from "../live-store.js";
import { evaluationCases, referenceDraft } from "../evaluation.js";
import { prepareContext } from "../context.js";
import { envelope, validate } from "../contracts.js";
import type { LiveService } from "../live-service.js";

// Isolated HTTP/persistence fixtures. No collector, external model, or runtime state is used.
test("live API persists cards, scopes favorites/questions, and GET/reload never calls generation", async () => {
  const db = new DatabaseSync(":memory:"), store = new LiveStore(db), sample = evaluationCases()[0], input = sample.input;
  const context = prepareContext(input), response = envelope({ ...referenceDraft(sample), id: "api-fixture-card", company_id: input.company_id,
    news_id: input.event.news_id, created_at: input.as_of, sources: context.sources, trace: [], mode: "live" }, "fixture", "live");
  store.enqueueAnalysis({ company_id: input.company_id, news_id: input.event.news_id, revision: "fixture-revision", audience_role: "cfo", payload: {} });
  const claimed=store.claim("test")!; store.complete(claimed,{response,context});
  let generations=0,searches=0;
  const ml=new ContractClient("https://fixture.invalid",500,(async(_url,init)=>Response.json(envelope(input.profile,(init!.headers as Json)["X-Request-ID"],"live"))) as typeof fetch);
  const retrieval={ search:async()=>{searches++;return envelope({items:[],next_offset:null},"fixture","live");},rag:async()=>envelope({items:[],limitations:[]},"fixture","live"),resolve:async()=>envelope({items:[],unknown_ids:[]},"fixture","live") };
  const app=createGateway({access:developmentAccess,ml,retrieval,agent:{analyze:async()=>{generations++;throw Error("unexpected generation");},answer:async()=>{generations++;throw Error("unexpected answer");}},
    settings:{...loadSettings({LLM_MODE:"live",LLM_API_KEY:"",NEWS_SEED_MODE:"none"}),analysisEnabled:false},analysisEnabled:false,liveStore:store,budget:async()=>({used:{calls:0,tokens:0}})});
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(resolve=>server.once("listening",resolve)); const address=server.address();assert.ok(address&&typeof address!=="string");
  const call=async(path:string,body?:Json)=>{const r=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:body?"POST":"GET",headers:{"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json() as Json};};
  try {
    for(let i=0;i<3;i++){const r=await call("/v1/live/feed?company_id=U_A");assert.equal(r.status,200);validate("LiveFeedDataResponse",r.value,true);assert.equal(r.value.data.items[0].id,"api-fixture-card");}
    assert.equal(generations,0);assert.equal(searches,0);
    assert.equal((await call("/v1/live/feed?company_id=U_OTHER")).value.data.items.length,0);
    assert.equal((await call("/v1/live/analyses/api-fixture-card?company_id=U_OTHER")).status,404);
    assert.equal((await call("/v1/live/feed?company_id=U_A&cursor=invalid")).status,422);
    assert.equal((await call("/v1/live/feed?company_id=U_A&limit=0")).status,422);
    const favorite=await call("/v1/live/analyses/api-fixture-card/favorite",{company_id:"U_A",favorite:true});assert.equal(favorite.status,200);
    assert.equal((await call("/v1/live/feed?company_id=U_A&favorites=1")).value.data.items.length,1);
    assert.equal((await call("/v1/live/analyses/api-fixture-card/favorite",{company_id:"U_OTHER",favorite:true})).status,404);
    const question={company_id:"U_A",question:"Какие условия договора проверить?",idempotency_key:"question-api-1"};
    const first=await call("/v1/live/analyses/api-fixture-card/questions",question),again=await call("/v1/live/analyses/api-fixture-card/questions",question);
    assert.equal(first.status,202);validate("LiveJobDataResponse",first.value,true);assert.equal(first.value.data.id,again.value.data.id);assert.equal(generations,0);
    assert.equal((await call("/v1/live/analyses/api-fixture-card/questions",{...question,question:"Другой вопрос"})).status,409);
    assert.equal((await call(`/v1/live/jobs/${first.value.data.id}?company_id=U_OTHER`)).status,404);
    assert.equal((await call("/v1/live/analyses/api-fixture-card/questions",{...question,company_id:"U_OTHER"})).status,404);
    const detail=await call("/v1/live/analyses/api-fixture-card?company_id=U_A");assert.equal(detail.status,200);validate("LiveDetailDataResponse",detail.value,true);assert.equal(detail.value.data.versions.length,1);
    assert.equal((await call("/v1/analyze",{})).status,503);
    assert.equal((await call("/v1/live/feed")).status,422);
    assert.equal(generations,0);assert.equal(searches,0);
  } finally {await (app.locals.live as LiveService).stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
});
