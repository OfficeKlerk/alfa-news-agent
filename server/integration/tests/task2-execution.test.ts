import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {executionFixture,input} from './support/execution-fixture.js';
import {reconcileAttempt,DurableAgent,initializeExecution} from '../../model-execution.js';
import {Store} from '../../db.js';
import {loadSettings,ROOT} from '../../config.js';
import {LegacyAgent} from '../agent.js';
import {evaluationCases,referenceDraft} from '../evaluation.js';
const receipt={id:'provider-id-1',choices:[{finish_reason:'stop',message:{content:'{"text":"saved provider output"}'}}],usage:{prompt_tokens:11,completion_tokens:7}};
function setup(){const dir=mkdtempSync(join(tmpdir(),'alfa-paid-'));return{dir,path:join(dir,'agent.sqlite3'),counter:join(dir,'accepted.txt'),close(){rmSync(dir,{recursive:true,force:true});}};}
function count(path:string){return existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).length:0;}
for(const phase of ['sent','received'])test('real process crash '+phase+' preserves paid-call state across restart',async()=>{
 const h=setup();try{
  const child=spawnSync(process.execPath,['--import','tsx',resolve(ROOT,'server/integration/tests/support/execution-fixture.ts'),'--crash-child',h.path,h.counter,phase],{cwd:ROOT,encoding:'utf8',timeout:15000});
  assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(count(h.counter),1);
  const f=executionFixture(h.path,h.counter);
  try{
   const state=await f.agent.recover('crash-job','A','analysis');
   if(phase==='sent'){
    assert.equal(state.state,'unknown');
    await assert.rejects(()=>f.agent.analyze(input,'crash-job'),{code:'MODEL_OUTCOME_UNKNOWN'});
    assert.equal(f.db.get('SELECT state FROM llm_budget_reservations')!.state,'reserved');
   } else {
    assert.equal(state.state,'recoverable');const answer=await f.agent.analyze(input,'crash-job');assert.match(answer.data.answer,/saved provider output/);
    assert.equal((await f.agent.recover('crash-job','A','analysis')).state,'succeeded');
    assert.equal(f.db.get('SELECT prompt_tokens FROM llm_calls')!.prompt_tokens,11);
   }
   assert.equal(count(h.counter),1,'no second provider POST');
  }finally{f.db.close();}
 }finally{h.close();}
});
test('completed operation replays identically; changed input or company cannot retrieve it',async()=>{
 const h=setup(),f=executionFixture(h.path,h.counter);try{
  const first=await f.agent.analyze(input,'one');assert.deepEqual(await f.agent.analyze(input,'one'),first);assert.equal(count(h.counter),1);
  await assert.rejects(()=>f.agent.analyze({...input,news_id:'other'},'one'),{code:'OPERATION_CONFLICT'});
  assert.equal((await f.agent.recover('one','B','analysis')).state,'not_found');
  assert.equal((await f.agent.recover('one','A','question')).state,'not_found');
 }finally{f.db.close();h.close();}
});
test('unknown outcome requires evidence, deadline and audited original response; recovery does not charge again',async()=>{
 const h=setup();try{
  spawnSync(process.execPath,['--import','tsx',resolve(ROOT,'server/integration/tests/support/execution-fixture.ts'),'--crash-child',h.path,h.counter,'sent'],{cwd:ROOT,timeout:15000});
  const f=executionFixture(h.path,h.counter);try{
   const decision={requestId:'crash-job',company:'A',kind:'analysis' as const,ordinal:1,actor:'operator',evidence:'Provider support case #1234',action:'supply_response' as const,response:receipt};
   assert.throws(()=>reconcileAttempt(f.db,{...decision,evidence:''}),/evidence/);
   assert.throws(()=>reconcileAttempt(f.db,decision),/deadline/);
   f.db.run('UPDATE model_attempts SET deadline_at=0');
   assert.throws(()=>reconcileAttempt(f.db,{...decision,company:'B'}),/missing/);
   reconcileAttempt(f.db,decision);
   assert.equal(f.db.get('SELECT count(*) n FROM model_reconciliation')!.n,1);
   const answer=await f.agent.analyze(input,'crash-job');assert.match(answer.data.answer,/saved provider output/);assert.equal(count(h.counter),1);
   assert.equal(f.db.get('SELECT charged_prompt FROM llm_budget_reservations')!.charged_prompt,11);
   assert.throws(()=>reconcileAttempt(f.db,decision),/already complete/);
  }finally{f.db.close();}
 }finally{h.close();}
});
test('confirmed unprocessed attempt permits exactly one new send and keeps the previous accounting audit',async()=>{
 const h=setup();try{
  spawnSync(process.execPath,['--import','tsx',resolve(ROOT,'server/integration/tests/support/execution-fixture.ts'),'--crash-child',h.path,h.counter,'sent'],{cwd:ROOT,timeout:15000});
  const f=executionFixture(h.path,h.counter);try{
   f.db.run('UPDATE model_attempts SET deadline_at=0');
   reconcileAttempt(f.db,{requestId:'crash-job',company:'A',kind:'analysis',ordinal:1,actor:'operator',evidence:'Provider confirms: request never processed',action:'confirm_not_processed'});
   await f.agent.analyze(input,'crash-job');await f.agent.analyze(input,'crash-job');assert.equal(count(h.counter),2);
   assert.equal(f.db.get("SELECT count(*) n FROM llm_budget_reservations WHERE state='confirmed_not_processed'")!.n,1);
   assert.equal(f.db.get('SELECT count(*) n FROM llm_calls')!.n,2);
  }finally{f.db.close();}
 }finally{h.close();}
});
test('concurrent agent instances sharing SQLite cannot submit the same paid attempt twice',async()=>{
 const h=setup(),f=executionFixture(h.path,h.counter),second=executionFixture(h.path,h.counter);try{
  const result=await Promise.allSettled([f.agent.analyze(input,'shared'),second.agent.analyze(input,'shared')]);
  assert.ok(result.some(r=>r.status==='fulfilled'));assert.equal(count(h.counter),1);
  const a=await f.agent.analyze(input,'shared'),b=await second.agent.analyze(input,'shared');assert.deepEqual(a,b);
 }finally{f.db.close();second.db.close();h.close();}
});
test('repair budget exhaustion preserves the first paid draft and resumes only the missing repair attempt',async()=>{
 const h=setup();try{
  const settings={...loadSettings({LLM_MODE:'live',LLM_API_KEY:'unit-test-no-network'}),dbPath:h.path,maxCalls:1,questionReserveCalls:0,questionReserveTokens:0};
  const db=new Store(settings),sample=evaluationCases()[0];let providerCalls=0;
  const request=async()=>{providerCalls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(providerCalls===1?{}:referenceDraft(sample))}}],usage:{prompt_tokens:10,completion_tokens:10}});};
  const first=new DurableAgent(db,new LegacyAgent(settings,request),{model:settings.model});
  await assert.rejects(()=>first.analyze(sample.input,'repair'),{code:'MODEL_LIMIT'});assert.equal(providerCalls,1);
  assert.equal((await first.recover('repair',sample.input.company_id,'analysis')).state,'recoverable');
  const next=new DurableAgent(db,new LegacyAgent({...settings,maxCalls:2},request),{model:settings.model});
  await next.analyze(sample.input,'repair');assert.equal(providerCalls,2,'first billed draft came from durable cache');
  assert.equal(db.get('SELECT count(*) n FROM llm_calls')!.n,2);db.close();
 }finally{h.close();}
});

test('lost repair response reuses both paid attempts after reconciliation without a third POST',async()=>{
 const h=setup();let db:Store|undefined;try{
  const settings={...loadSettings({LLM_MODE:'live',LLM_API_KEY:'unit-test-no-network'}),dbPath:h.path};
  db=new Store(settings);const sample=evaluationCases()[0];let calls=0;
  const original={id:'original-repair-response',choices:[{finish_reason:'stop',message:{content:JSON.stringify(referenceDraft(sample))}}],usage:{prompt_tokens:19,completion_tokens:17}};
  const request=async()=>{calls++;if(calls===1)return Response.json({choices:[{finish_reason:'stop',message:{content:'{}'}}],usage:{prompt_tokens:10,completion_tokens:4}});throw new DOMException('Accepted repair but response was lost','TimeoutError');};
  let agent=new DurableAgent(db,new LegacyAgent(settings,request),{model:settings.model});
  await assert.rejects(()=>agent.analyze(sample.input,'lost-repair'),{code:'MODEL_OUTCOME_UNKNOWN'});assert.equal(calls,2);
  await assert.rejects(()=>agent.analyze(sample.input,'lost-repair'),{code:'MODEL_OUTCOME_UNKNOWN'});assert.equal(calls,2);
  db.close();db=new Store(settings);agent=new DurableAgent(db,new LegacyAgent(settings,request),{model:settings.model});
  assert.equal((await agent.recover('lost-repair',sample.input.company_id,'analysis')).state,'unknown');
  db.run('UPDATE model_attempts SET deadline_at=0');
  reconcileAttempt(db,{requestId:'lost-repair',company:sample.input.company_id,kind:'analysis',ordinal:2,actor:'test-operator',evidence:'Original second-step response obtained from controlled provider',action:'supply_response',response:original});
  const response=await agent.analyze(sample.input,'lost-repair');assert.equal(response.data.mode,'live');assert.equal(calls,2);
  assert.equal(db.get('SELECT count(*) n FROM llm_calls')!.n,2);
  assert.equal(db.get("SELECT count(*) n FROM llm_budget_reservations WHERE state='settled'")!.n,2);
 }finally{db?.close();h.close();}
});
