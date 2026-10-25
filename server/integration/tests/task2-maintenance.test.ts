import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../db.js';
import {loadSettings} from '../../config.js';
import {createComplete} from '../../llm.js';
import {DurableAgent,closeOperation,quarantineRestoredJournal,reconcileAttempt} from '../../model-execution.js';
import {LiveStore} from '../live-store.js';
import {envelope} from '../contracts.js';
const input={company_id:'A'}, receipt={choices:[{message:{content:'saved'},finish_reason:'stop'}],usage:{prompt_tokens:9,completion_tokens:3}};
function setup(){const dir=mkdtempSync(join(tmpdir(),'alfa-maintenance-')),settings={...loadSettings({LLM_MODE:'live',LLM_API_KEY:'test-no-network'}),dbPath:join(dir,'agent.sqlite')},db=new Store(settings);return{dir,settings,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
test('cancelled preflight spends nothing and the same operation can run after cancellation is removed',async()=>{
 const f=setup();let calls=0;try{
 const complete=createComplete(f.settings,f.db,async()=>{calls++;return Response.json(receipt);});
 const run=async(_:any,id:string)=>envelope({answer:(await complete([])).content},id,'live');
 const agent=new DurableAgent(f.db,{analyze:run,answer:run},{model:f.settings.model});
 await assert.rejects(()=>agent.analyze(input,'cancelled',AbortSignal.abort()),{code:'MODEL_CANCELLED'});
 assert.equal(calls,0);assert.equal(f.db.get('SELECT count(*) n FROM model_attempts')!.n,0);
 await agent.analyze(input,'cancelled');assert.equal(calls,1);
 }finally{f.close();}
});
test('provider rejection is replayed as a terminal error; neither retry nor next-day budget re-sends it',async()=>{
 const f=setup();let calls=0;try{
 const complete=createComplete(f.settings,f.db,async()=>{calls++;return Response.json({error:{message:'quota'}},{status:429,headers:{'x-request-id':'provider-429'}});});
 const run=async(_:any,id:string)=>envelope({answer:(await complete([])).content},id,'live');
 const agent=new DurableAgent(f.db,{analyze:run,answer:run},{});
 await assert.rejects(()=>agent.analyze(input,'limited'),{code:'MODEL_LIMIT'});
 await assert.rejects(()=>agent.analyze(input,'limited'),{code:'MODEL_LIMIT'});
 assert.equal(calls,1);assert.equal((await agent.recover('limited','A','analysis')).state,'failed');
 assert.equal(f.db.get('SELECT provider_request_id FROM model_attempts')!.provider_request_id,'provider-429');
 assert.ok(Number(f.db.get('SELECT charged_prompt FROM llm_budget_reservations')!.charged_prompt)>0);
 assert.equal(f.db.get('SELECT state FROM llm_budget_reservations')!.state,'uncertain');
 // A confirmed rejection is a separate, named and audited decision, not a timer retry.
 f.db.run('UPDATE model_attempts SET deadline_at=0');
 reconcileAttempt(f.db,{requestId:'limited',company:'A',kind:'analysis',ordinal:1,actor:'operator',evidence:'Provider ticket #429: confirmed no processing',action:'confirm_not_processed'});
 assert.equal((await agent.recover('limited','A','analysis')).state,'recoverable');
 }finally{f.close();}
});
test('late successful validation cannot overwrite an operator closure or restore quarantine',async()=>{
 for(const action of ['close','restore','review']){
 const f=setup();let release!:()=>void,accepted!:()=>void;
 const blocked=new Promise<void>(r=>{release=r;}),waiting=new Promise<void>(r=>{accepted=r;});
 try{
 const complete=createComplete(f.settings,f.db,async()=>Response.json(receipt));
 const run=async(_:any,id:string)=>{await complete([]);accepted();await blocked;if(action==='review')await complete([{role:'user',content:'repair step'}]);return envelope({answer:'late'},id,'live');};
 const agent=new DurableAgent(f.db,{analyze:run,answer:run},{}),pending=agent.analyze(input,'late');
 await waiting;f.db.run('UPDATE model_attempts SET deadline_at=0');
 if(action==='close')closeOperation(f.db,{requestId:'late',company:'A',kind:'analysis',actor:'operator',evidence:'Outcome could not be recovered; deliberate closure'});
 else if(action==='restore')quarantineRestoredJournal(f.db,'operator','Backup rollback reviewed before resuming service');
 else reconcileAttempt(f.db,{requestId:'late',company:'A',kind:'analysis',ordinal:1,actor:'operator',evidence:'Original receipt reviewed while previous process was stalled',action:'supply_response',response:receipt});
 release();await assert.rejects(()=>pending,{code:'MODEL_OUTCOME_UNKNOWN'});
 assert.equal((await agent.recover('late','A','analysis')).state,action==='close'?'failed':action==='restore'?'unknown':'recoverable');
 assert.equal(f.db.get('SELECT result FROM model_operations')!.result,null);
 assert.equal(f.db.get('SELECT count(*) n FROM llm_calls')!.n,1,'a stale execution epoch cannot spend a second call');
 if(action==='close')assert.throws(()=>reconcileAttempt(f.db,{requestId:'late',company:'A',kind:'analysis',ordinal:1,actor:'operator',evidence:'Attempt to reopen an explicitly closed operation',action:'supply_response',response:receipt}),/closed without retry/);
 }finally{release();f.close();}
 }
});
test('restore hold survives restart, blocks every dispatch and retains an audited review path',()=>{
 const f=setup();let live=new LiveStore(f.db);try{
 const first=live.enqueueAnalysis({company_id:'A',news_id:'n',revision:'r',audience_role:'cfo',payload:{}});
 const claimed=live.claim('before-restore')!;live.freezeExecution(claimed,{body:{company_id:'A'}});
 assert.equal(live.setRestoreHold(true,'operator','Restored full application backup from a previous point'),1);
 assert.equal(live.complete(claimed,{response:envelope({company_id:'A'},'result','live')}),false);
 live=new LiveStore(f.db);assert.equal(live.recoveryHeld(),true);assert.equal(live.claim('after-restore'),null);
 live.enqueueAnalysis({company_id:'B',news_id:'n2',revision:'r2',audience_role:'cfo',payload:{}});
 assert.equal(live.claim('new-during-review'),null);
 assert.throws(()=>live.setRestoreHold(false,'operator',''),/evidence/);
 live.setRestoreHold(false,'operator','Provider billing and all post-backup operations reconciled');
 assert.equal(live.getJob(first.id)!.status,'unknown');assert.equal(live.claim('safe-new-job')!.company_id,'B');
 live.closeUnknown(first.id,'A','operator','Irrecoverable old operation closed without repeating payment');
 assert.equal(live.getJob(first.id)!.status,'failed');assert.equal(f.db.get('SELECT count(*) n FROM live_maintenance_audit')!.n,3);
 }finally{f.close();}
});
