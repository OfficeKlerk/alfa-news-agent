import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {LiveStore} from '../live-store.js';
import {LiveService,analysisRevision,profileRevision} from '../live-service.js';
import {evaluationCases,referenceDraft} from '../evaluation.js';
import {prepareContext} from '../context.js';
import {ApiFault,envelope} from '../contracts.js';
import {loadSettings} from '../../config.js';
import type {AnalysisEngine} from '../analysis-engine.js';
import type {ContractClient} from '../client.js';
import type {Json} from '../../types.js';
function scenario(){
 const db=new DatabaseSync(':memory:'),store=new LiveStore(db),s=evaluationCases()[0],context=prepareContext(s.input);
 const cid=s.input.company_id,news=s.input.event.news_id,revision=analysisRevision(s.input.event,profileRevision(s.input.profile));
 store.enqueueAnalysis({company_id:cid,news_id:news,revision,audience_role:'cfo',payload:{}});
 const response=envelope({...referenceDraft(s),id:'saved-card',company_id:cid,news_id:news,created_at:s.input.as_of,sources:context.sources,trace:[],mode:'live'},'publish','live');
 store.complete(store.claim('publisher')!,{response,context});
 // Keep discovery outside this recovery-focused test.
 store.subscribe({company_id:cid,audience_role:'cfo',limit:5,min_score:0.2});store.touchSubscription(cid,'cfo',Date.now()+86_400_000);
 let state='not_found',calls=0,recoveryReads=0;
 const draft=referenceDraft(s);
 const answer=envelope({analysis_id:'saved-card',company_id:cid,answer:draft.summary,claims:draft.claims,claim_indexes:[0,1],limitations:draft.limitations,missing_data:draft.missing_data,source_ids:context.sources.map(x=>x.id)},'q','live');
 const engine={recover:async()=>{recoveryReads++;return state==='failed'?{state,error:{code:'MODEL_OPERATION_CLOSED'}}:{state};},
  answer:async()=>{if(state==='not_found'){calls++;state='unknown';throw new ApiFault(503,'MODEL_OUTCOME_UNKNOWN','lost response');}return answer;},
 } as unknown as AnalysisEngine;
 const ml={call:async()=>envelope(s.input.profile,'id','live')} as unknown as ContractClient;
 const retrieval={search:async()=>envelope({items:[s.input.event]},'id','live'),rag:async()=>envelope({items:[],limitations:[]},'id','live'),resolve:async()=>envelope({items:[],unknown_ids:[]},'id','live')};
 const settings={...loadSettings({LLM_MODE:'live',NEWS_SEED_MODE:'none'}),analysisEnabled:true};
 const service=()=>new LiveService({store,engine,ml,retrieval,settings});
 return{db,store,cid,service,setState:(s:string)=>{state=s;},get calls(){return calls;},get reads(){return recoveryReads;}};
}
test('unknown queue job polls receipts only; not_found is never treated as proof of no payment',async()=>{
 const f=scenario();let service=f.service();try{
 const q=f.store.enqueueQuestion({company_id:f.cid,analysis_id:'saved-card',question:'What next?',idempotency_key:'key',owner:'alice'});
 await service.worker.tick();assert.equal(f.store.getJob(q.id)!.status,'unknown');assert.ok(f.store.getJob(q.id)!.payload.execution);
 assert.equal(f.calls,1);await service.stop();service=f.service();
 await service.scanDue();await service.worker.tick();assert.equal(f.calls,1);assert.equal(f.store.getJob(q.id)!.status,'unknown');
 f.setState('not_found');await service.scanDue();await service.worker.tick();assert.equal(f.calls,1);assert.equal(f.store.getJob(q.id)!.status,'unknown');
 f.setState('recoverable');await service.scanDue();assert.equal(f.store.getJob(q.id)!.status,'queued');
 await service.worker.tick();assert.equal(f.store.getJob(q.id)!.status,'succeeded');assert.equal(f.calls,1);
 assert.equal(f.store.getAnalysis('saved-card',f.cid,'alice')!.history.length,1);assert.equal(f.store.getAnalysis('saved-card',f.cid,'bob')!.history.length,0);
 }finally{await service.stop();f.db.close();}
});
test('operator-closed operation becomes an explicit failed job without another generation',async()=>{
 const f=scenario(),service=f.service();try{
 const q=f.store.enqueueQuestion({company_id:f.cid,analysis_id:'saved-card',question:'What next?',idempotency_key:'key',owner:'alice'});
 await service.worker.tick();f.setState('failed');await service.scanDue();await service.worker.tick();
 assert.equal(f.store.getJob(q.id)!.status,'failed');assert.equal(f.calls,1);assert.equal(f.store.getAnalysis('saved-card',f.cid,'alice')!.history.length,0);
 }finally{await service.stop();f.db.close();}
});

test('missing agent journal after a frozen dispatch needs one-time operator evidence, consumed before send',async()=>{
 const f=scenario(),service=f.service();try{
  const job=f.store.enqueueQuestion({company_id:f.cid,analysis_id:'saved-card',question:'What next?',idempotency_key:'missing-journal',owner:'alice'});
  const claimed=f.store.claim('crashed-worker')!;
  f.store.freezeExecution(claimed,{saved:f.store.getAnalysis('saved-card',f.cid,'alice'),question:'What next?'});
  f.store.uncertain(claimed,'worker crashed after snapshot');
  f.store.resumeUnknown(job.id);await service.worker.tick();
  assert.equal(f.calls,0);assert.equal(f.store.getJob(job.id)!.status,'unknown');
  f.store.reviewUnknownConfirmed(job.id,f.cid,'operator','Provider confirms every old attempt was never processed');
  await service.worker.tick();assert.equal(f.calls,1);assert.equal(f.store.getJob(job.id)!.status,'unknown');
  assert.equal(f.store.getJob(job.id)!.payload.dispatch_reviewed,undefined);
  f.setState('not_found');f.store.resumeUnknown(job.id);await service.worker.tick();
  assert.equal(f.calls,1,'operator approval cannot be reused after another ambiguous dispatch');
  assert.equal(f.store.getJob(job.id)!.status,'unknown');
 }finally{await service.stop();f.db.close();}
});
