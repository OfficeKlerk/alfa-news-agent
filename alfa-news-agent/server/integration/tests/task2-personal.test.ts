import {test} from 'node:test';
import type {Express} from 'express';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LiveStore} from '../live-store.js';
import {envelope,ApiFault} from '../contracts.js';
import {evaluationCases,referenceDraft} from '../evaluation.js';
import {prepareContext} from '../context.js';
import {createGateway} from '../gateway.js';
import {enforceTenant} from '../access.js';
import {ContractClient} from '../client.js';
import {loadSettings} from '../../config.js';
import {once} from 'node:events';
import type {Json} from '../../types.js';
function card(store:LiveStore,news='n1'){
 const s=evaluationCases()[0];s.input.event.news_id=s.input.ranked_item.news_id=news;
 const context=prepareContext(s.input),id='card-'+news;
 const response=envelope({...referenceDraft(s),id,company_id:s.input.company_id,news_id:news,created_at:s.input.as_of,sources:context.sources,trace:[],mode:'live'},'fixture','live');
 store.enqueueAnalysis({company_id:s.input.company_id,news_id:news,revision:'v1',audience_role:'cfo',payload:{}});
 store.complete(store.claim('publisher')!,{response,context});return{cid:s.input.company_id,id};
}
function finish(store:LiveStore,jobId:string,owner:string,answer:string){
 const job=store.claim('q-'+owner)!;assert.equal(job.id,jobId);
 const draft=referenceDraft(evaluationCases()[0]);
 store.complete(job,{response:envelope({analysis_id:job.analysis_id,company_id:job.company_id,answer,claims:draft.claims,claim_indexes:[0,1],limitations:[],missing_data:[],source_ids:[...new Set(draft.claims.flatMap((c:Json)=>c.source_ids))]},jobId,'live')});
}
test('two employees have separate favorites, Q&A, idempotency keys, job access and cursors across restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'alfa-personal-')),path=join(dir,'gateway.sqlite3');let db=new DatabaseSync(path);
 try{
 let store=new LiveStore(db);const a=card(store),b=card(store,'n2');
 store.favorite(a.cid,a.id,true,'alice');assert.equal(store.getAnalysis(a.id,a.cid,'alice')!.favorite,true);assert.equal(store.getAnalysis(a.id,a.cid,'bob')!.favorite,false);
 assert.equal(store.feed(a.cid,{owner:'alice',favorites:true}).items.length,1);assert.equal(store.feed(a.cid,{owner:'bob',favorites:true}).items.length,0);
 const cursor=store.feed(a.cid,{owner:'alice',limit:1}).next_cursor!;assert.ok(cursor);assert.throws(()=>store.feed(a.cid,{owner:'bob',cursor}),/cursor/);
 const qa=store.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Private Alice',idempotency_key:'same',owner:'alice'});
 const qb=store.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Private Bob',idempotency_key:'same',owner:'bob'});assert.notEqual(qa.id,qb.id);
 assert.equal(store.getJob(qa.id,a.cid,'bob'),null);assert.ok(!store.jobs(a.cid,50,'bob').some(j=>j.id===qa.id));
 finish(store,qa.id,'alice','Alice-only answer');finish(store,qb.id,'bob','Bob-only answer');
 db.close();db=new DatabaseSync(path);store=new LiveStore(db);
 assert.deepEqual(store.getAnalysis(a.id,a.cid,'alice')!.history.map(h=>h.answer),['Alice-only answer']);
 assert.deepEqual(store.getAnalysis(a.id,a.cid,'bob')!.history.map(h=>h.answer),['Bob-only answer']);
 assert.equal(store.getAnalysis(a.id,a.cid)!.history.length,0,'no implicit access to every employee history');
 assert.equal(store.getAnalysis(a.id,a.cid,'alice')!.favorite,true);
 assert.equal(store.getAnalysis(b.id,a.cid,'alice')!.favorite,false);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy shared data is retained without assigning it to a user; unverified old sends are quarantined',()=>{
 const db=new DatabaseSync(':memory:');try{
 const old=new LiveStore(db),a=card(old);
 old.favorite(a.cid,a.id,true);
 const q=old.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Legacy shared question',idempotency_key:'legacy'});finish(old,q.id,'legacy','Legacy shared answer');
 const pending=old.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Old running request',idempotency_key:'pending'});old.claim('old-process');
 // Reproduce the original schema: owner/recovery columns did not exist.
 db.exec('DROP INDEX live_question_owner; DROP INDEX live_job_owner; DROP INDEX live_job_recovery; ALTER TABLE live_questions DROP COLUMN owner; ALTER TABLE live_jobs DROP COLUMN owner; ALTER TABLE live_jobs DROP COLUMN last_recovery_check; DELETE FROM live_schema_migrations; DROP TABLE live_user_favorites;');
 const migrated=new LiveStore(db);
 assert.equal(migrated.getAnalysis(a.id,a.cid)!.history.length,1);assert.equal(migrated.getAnalysis(a.id,a.cid)!.favorite,true);
 assert.equal(migrated.getAnalysis(a.id,a.cid,'alice')!.history.length,0);assert.equal(migrated.getAnalysis(a.id,a.cid,'alice')!.favorite,false);
 assert.equal(migrated.getJob(pending.id)!.status,'unknown');assert.equal(migrated.claim('new-process'),null);
 assert.throws(()=>migrated.reviewLegacy(pending.id,a.cid,'admin',''),/evidence/);
 migrated.reviewLegacy(pending.id,a.cid,'admin','Provider ticket confirms original request was not processed');
 assert.equal(migrated.getJob(pending.id)!.status,'queued');assert.equal(db.prepare('SELECT count(*) n FROM live_legacy_review').get()!.n,1);
 new LiveStore(db);assert.equal(db.prepare('SELECT count(*) n FROM live_schema_migrations').get()!.n,1);
 }finally{db.close();}
});
test('unknown question cannot be bypassed with a new client key and remains scoped to its employee',()=>{
 const db=new DatabaseSync(':memory:');try{
 const store=new LiveStore(db),a=card(store);
 const q=store.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Question',idempotency_key:'first',owner:'alice'});
 const running=store.claim('one')!;store.freezeExecution(running,{test:'snapshot'});store.uncertain(running,'provider outcome unknown');
 assert.equal(store.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Question',idempotency_key:'another',owner:'alice'}).id,q.id);
 assert.throws(()=>store.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Next question',idempotency_key:'new',owner:'alice'}),/unresolved/);
 store.enqueueQuestion({company_id:a.cid,analysis_id:a.id,question:'Independent',idempotency_key:'new',owner:'bob'});
 assert.equal(store.claim('two')!.owner,'bob');assert.ok(!JSON.stringify(store.status(a.cid,'bob')).includes('provider outcome unknown'));
 }finally{db.close();}
});
test('expired lease on a frozen dispatch becomes unknown, never directly requeued',()=>{
 let now=1000;const db=new DatabaseSync(':memory:');try{
 const store=new LiveStore(db,{now:()=>now});store.enqueueAnalysis({company_id:'A',news_id:'n',revision:'r',audience_role:'cfo',payload:{}});
 const job=store.claim('one',50)!;store.freezeExecution(job,{input:'immutable'});now+=51;
 assert.equal(store.claim('two'),null);assert.equal(store.getJob(job.id)!.status,'unknown');assert.equal(store.complete(job,{response:envelope({},'r','live')}),false);
 }finally{db.close();}
});
test('HTTP personal API ignores client identity claims and rejects changed-session viewers',async()=>{
 const db=new DatabaseSync(':memory:'),store=new LiveStore(db),a=card(store);
 const users:Record<string,{subject:string;companies:string[];roles:string[]}>={alice:{subject:'alice',companies:[a.cid],roles:[]},bob:{subject:'bob',companies:[a.cid],roles:[]},other:{subject:'other',companies:['OTHER'],roles:[]}};
 const access={secured:true,install(app:Express){app.use((req,res,next)=>{const p=users[req.get('X-Test-User')??''];if(!p)throw new ApiFault(401,'UNAUTHORIZED','Login required');res.locals.principal=p;enforceTenant(req,p);next();});}};
 const ml=new ContractClient('https://unused.invalid');
 const app=createGateway({access,ml,liveStore:store,settings:{...loadSettings({LLM_MODE:'live',NEWS_SEED_MODE:'none'}),analysisEnabled:false},analysisEnabled:false,
 retrieval:{search:async()=>envelope({items:[]},'test','live'),rag:async()=>envelope({items:[],limitations:[]},'test','live'),resolve:async()=>envelope({items:[],unknown_ids:[]},'test','live')},
 agent:{analyze:async()=>{throw Error('no model');},answer:async()=>{throw Error('no model');}}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const call=async(user:string,path:string,body?:Json,extra:Record<string,string>={})=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Test-User':user,...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json() as Json};};
 try{
  assert.equal((await call('alice',`/v1/live/analyses/${a.id}/favorite`,{company_id:a.cid,favorite:true})).status,200);
  const alice=await call('alice',`/v1/live/analyses/${a.id}?company_id=${a.cid}`),bob=await call('bob',`/v1/live/analyses/${a.id}?company_id=${a.cid}`);
  assert.equal(alice.body.data.card.favorite,true);assert.equal(bob.body.data.card.favorite,false);
  const qa=await call('alice',`/v1/live/analyses/${a.id}/questions`,{company_id:a.cid,question:'Private question',idempotency_key:'http-key'});assert.equal(qa.status,202);
  assert.equal((await call('bob',`/v1/live/jobs/${qa.body.data.id}?company_id=${a.cid}`)).status,404);
  assert.equal((await call('other',`/v1/live/feed?company_id=${a.cid}`)).status,403);
  assert.equal((await call('alice',`/v1/live/analyses/${a.id}/questions`,{company_id:a.cid,question:'Forged user',idempotency_key:'x',owner:'bob'})).status,422);
  const viewer=(await call('alice','/v1/runtime')).body.data.viewer_key;
  assert.equal((await call('bob',`/v1/live/feed?company_id=${a.cid}`,undefined,{'X-Viewer-Key':viewer})).body.error.code,'SESSION_CHANGED');
  assert.ok(!(await call('bob',`/v1/live/jobs?company_id=${a.cid}`)).body.data.items.some((j:Json)=>j.id===qa.body.data.id));
 }finally{await app.locals.live.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}
});
