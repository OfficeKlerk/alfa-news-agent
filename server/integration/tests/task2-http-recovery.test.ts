/** Actual private HTTP adapter + HTTPS provider protocol; test data only, zero external calls. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../../db.js';
import {loadSettings,ROOT} from '../../config.js';
import {reconcileAttempt} from '../../model-execution.js';
import {ContractClient} from '../client.js';
import {HttpAgent} from '../agent.js';
import {LiveStore} from '../live-store.js';
import {LiveService,analysisRevision,profileRevision} from '../live-service.js';
import {createAnalysisEngine} from '../analysis-engine.js';
import {envelope} from '../contracts.js';
import type {Json} from '../../types.js';
import type {RetrievalPort} from '../retrieval.js';
import {evaluationCases,referenceDraft} from '../evaluation.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('HTTP timeout after provider acceptance is blocked, reconciled and replayed across adapter restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alfa-http-paid-'));let child:ChildProcess|undefined;let logs='';let model:https.Server|undefined;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'});
  const sample=evaluationCases()[0];sample.input.is_mock=false;sample.input.event.is_mock=false;
  for(const s of [...sample.input.event.sources,...sample.input.research.items])s.is_mock=false;
  const providerBody={id:'original-provider-response',choices:[{finish_reason:'stop',message:{content:JSON.stringify(referenceDraft(sample))}}],usage:{prompt_tokens:50,completion_tokens:80,total_tokens:130}};
  let providerMode:'stall'|'reject429'|'reject500'='stall';
  let accepted=0,notify:()=>void=()=>{};const seen=new Promise<void>(r=>{notify=r;});
  model=https.createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},async(req,res)=>{
   assert.equal(req.url,'/v1/chat/completions');let body='';for await(const b of req)body+=b;
   assert.equal(JSON.parse(body).model,'qwen/qwen3.6-35b-a3b');accepted++;
   if(providerMode!=='stall'){res.writeHead(providerMode==='reject429'?429:500,{'Content-Type':'application/json','X-Request-ID':'rejection-receipt'});res.end(JSON.stringify({error:{message:'quota'}}));return;}
   res.writeHead(200,{'Content-Type':'application/json','X-Request-ID':'original-provider-receipt'});res.flushHeaders();notify();
   // Simulate an accepted request whose body never arrives; client abort must not cause another POST.
  }).listen(0,'127.0.0.1');await once(model,'listening');
  const reserve=net.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
  const base=`http://127.0.0.1:${port}`,secret='private-test-credential-'.repeat(3),path=join(dir,'agent.sqlite3');
  const env:NodeJS.ProcessEnv={...process.env,NODE_EXTRA_CA_CERTS:join(dir,'cert.pem'),AUTH_MODE:'oidc',INTERNAL_API_TOKEN:secret,HOST:'127.0.0.1',PORT:String(port),SERVICE_KIND:'agent',LLM_MODE:'live',ANALYSIS_ENABLED:'1',LLM_API_KEY:'local-test-provider-key',LLM_BASE_URL:`https://127.0.0.1:${(model.address() as net.AddressInfo).port}/v1`,LLM_MODEL:'qwen/qwen3.6-35b-a3b',LLM_TIMEOUT_SECONDS:'10',LLM_EXTRA_BODY_JSON:'{}',LLM_RESPONSE_FORMAT:'json_object',DB_PATH:path,DATA_DIR:join(ROOT,'data'),NEWS_SEED_MODE:'none',NEWS_ENABLED:'0',LIVE_PIPELINE_ENABLED:'0'};
  const start=async()=>{
   child=spawn(process.execPath,['--import','tsx','server/integration/provider-server.ts'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
   child.stdout?.on('data',b=>{logs+=b.toString();});child.stderr?.on('data',b=>{logs+=b.toString();});
   for(let i=0;i<150;i++){
    if(child.exitCode!==null)throw new Error('Adapter exited: '+logs.slice(-2000));
    try{if((await fetch(base+'/v1/health')).ok)return;}catch{}
    await wait(50);
   }throw new Error('Adapter startup timeout: '+logs.slice(-2000));
  };
  const stop=async()=>{if(!child||child.exitCode!==null)return;const closed=once(child,'exit');child.kill('SIGTERM');await Promise.race([closed,wait(4000)]);if(child.exitCode===null){child.kill('SIGKILL');await closed;}};
  await start();
  const client=new ContractClient(base,15000,fetch,{'X-Internal-Token':secret}),agent=new HttpAgent(client),controller=new AbortController();
  const attempt=agent.analyze(sample.input,'http-job-one',controller.signal);const settled=attempt.catch(e=>e);
  await Promise.race([seen,wait(6000).then(()=>{throw Error('Provider never received request: '+logs.slice(-2000));})]);
  controller.abort();const failed=await settled;assert.equal(failed.code,'DEPENDENCY_TIMEOUT');assert.equal(accepted,1);
  let state=await agent.recover('http-job-one',sample.input.company_id,'analysis');
  for(let i=0;i<50&&state.state==='running';i++){await wait(20);state=await agent.recover('http-job-one',sample.input.company_id,'analysis');}
  assert.equal(state.state,'unknown');
  await assert.rejects(()=>agent.analyze(sample.input,'http-job-one'),{code:'MODEL_OUTCOME_UNKNOWN'});assert.equal(accepted,1);
  const unknownHttp=await fetch(base+'/v1/agent/analyze',{method:'POST',headers:{'Content-Type':'application/json','X-Internal-Token':secret,'X-Request-ID':'http-job-one'},body:JSON.stringify(sample.input)});
  assert.equal(unknownHttp.status,503);assert.equal((await unknownHttp.json()).error.retryable,false);assert.equal(accepted,1);
  assert.equal((await fetch(base+'/v1/agent/operations/http-job-one?company_id='+sample.input.company_id+'&kind=analysis')).status,401);
  const db=new Store({...loadSettings({LLM_MODE:'demo'}),dbPath:path});
  try{
   assert.equal(db.get('SELECT provider_request_id FROM model_attempts')!.provider_request_id,'original-provider-receipt');
   db.run('UPDATE model_attempts SET deadline_at=0'); // Controlled clock boundary for the local provider fixture.
   reconcileAttempt(db,{requestId:'http-job-one',company:sample.input.company_id,kind:'analysis',ordinal:1,actor:'integration-test-admin',evidence:'Original response obtained from controlled HTTPS provider',action:'supply_response',response:providerBody});
  }finally{db.close();}
  const response=await agent.analyze(sample.input,'http-job-one');assert.equal(response.data.mode,'live');assert.equal(accepted,1);
  await stop();await start();assert.deepEqual(await agent.analyze(sample.input,'http-job-one'),response);assert.equal(accepted,1);
  assert.equal((await agent.recover('http-job-one','OTHER','analysis')).state,'not_found');
  // Complete queue → immutable prepared input → real HTTP agent → saved provider response → publication.
  // Controlled article fixture with an eligible official event; never fetched as real news.
  sample.input.event.title='Банк России снизил ключевую ставку';
  sample.input.event.text='Банк России снизил ключевую ставку. Решение принято советом директоров. Новые условия финансирования вступают в силу после публикации решения регулятора.';
  Object.assign(sample.input.event.sources[0],{title:sample.input.event.title,excerpt:'Банк России снизил ключевую ставку.',url:'https://cbr.ru/press/pr/?id=controlled-test-fixture'});
  sample.input.ranked_item.score_kind='manual_feature_baseline';
  const pipelineBody={...providerBody,choices:[{finish_reason:'stop',message:{content:JSON.stringify(referenceDraft(sample))}}]};
  const gatewayDb=new Store({...loadSettings({LLM_MODE:'demo'}),dbPath:join(dir,'gateway.sqlite3')});
  let service:LiveService|undefined;
  try{
   const liveStore=new LiveStore(gatewayDb),cid=sample.input.company_id;
   liveStore.subscribe({company_id:cid,audience_role:'cfo',limit:5,min_score:0});liveStore.touchSubscription(cid,'cfo',Date.now()+86_400_000);
   const ml={call:async(path:string,_schema:string,id:string,body?:Json)=>envelope(path==='/v1/rank'?{company_id:cid,as_of:body!.as_of,items:[sample.input.ranked_item]}:sample.input.profile,id,'live')} as unknown as ContractClient;
   const retrieval={search:async(_body:Json,id:string)=>envelope({items:[sample.input.event]},id,'live'),
    rag:async(_body:Json,id:string)=>envelope(sample.input.research,id,'live'),
    resolve:async(_body:Json,id:string)=>envelope({items:[],unknown_ids:[]},id,'live')} as RetrievalPort;
   const engine=createAnalysisEngine({ml,retrieval,agent,secured:true});
   const settings={...loadSettings({LLM_MODE:'live',NEWS_SEED_MODE:'none'}),analysisEnabled:true,liveLookbackDays:365};
   const makeService=()=>new LiveService({store:liveStore,engine,ml,retrieval,settings});service=makeService();
   const job=liveStore.enqueueAnalysis({company_id:cid,news_id:sample.input.event.news_id,audience_role:'cfo',
    revision:analysisRevision(sample.input.event,profileRevision(sample.input.profile)),payload:{event:sample.input.event,company_id:cid,audience_role:'cfo',reanalysis:true}});
   const pending=service.worker.tick();
   for(let i=0;i<100&&accepted<2;i++)await wait(20);
   assert.equal(accepted,2,'exactly one provider request for the queued operation: '+liveStore.getJob(job.id)?.error);
   await service.stop();await pending;
   assert.equal(liveStore.getJob(job.id)!.status,'unknown');
   for(let i=0;i<50&&(await agent.recover(job.id,cid,'analysis')).state==='running';i++)await wait(20);
   assert.equal((await agent.recover(job.id,cid,'analysis')).state,'unknown');
   await service.stop();service=makeService();await service.scanDue();assert.equal(accepted,2);
   const journal=new Store({...loadSettings({LLM_MODE:'demo'}),dbPath:path});
   try{
    journal.run('UPDATE model_attempts SET deadline_at=0');
    reconcileAttempt(journal,{requestId:job.id,company:cid,kind:'analysis',ordinal:1,actor:'e2e-operator',evidence:'Original response recovered from controlled HTTPS endpoint',action:'supply_response',response:pipelineBody});
   }finally{journal.close();}
   await service.scanDue();assert.equal(liveStore.getJob(job.id)!.status,'queued');
   await service.worker.tick();assert.equal(liveStore.getJob(job.id)!.status,'succeeded',liveStore.getJob(job.id)!.error??'');
   assert.equal(liveStore.feed(cid,{owner:'employee'}).items.length,1);
   assert.equal(accepted,2,'publication after recovery never re-sends the paid operation');
   // The same HTTP boundary must distinguish a LOCAL pre-send cap from a provider rejection.
   await service.stop();await stop();env.MAX_DAILY_LLM_CALLS='1';await start();service=makeService();
   const quotaJob=liveStore.enqueueQuestion({company_id:cid,analysis_id:liveStore.feed(cid,{owner:'alice'}).items[0].id,question:'Какие условия договоров уточнить?',idempotency_key:'local-quota',owner:'alice'});
   await service.worker.tick();
   assert.equal(liveStore.getJob(quotaJob.id)!.status,'deferred','local HTTP budget errors must defer, never fail the question');
   assert.equal((await agent.recover(quotaJob.id,cid,'question')).state,'recoverable');assert.equal(accepted,2);
   const quotaDb=new Store({...loadSettings({LLM_MODE:'demo'}),dbPath:path});let quotaInput:Json;
   try{quotaInput=JSON.parse(quotaDb.get('SELECT input FROM model_operations WHERE request_id=?',quotaJob.id)!.input);}finally{quotaDb.close();}
   const localLimitResponse=await fetch(base+'/v1/agent/questions',{method:'POST',headers:{'Content-Type':'application/json','X-Internal-Token':secret,'X-Request-ID':quotaJob.id},body:JSON.stringify(quotaInput)});
   assert.equal(localLimitResponse.status,429);assert.equal((await localLimitResponse.json()).error.retryable,true);assert.equal(accepted,2);
   await service.stop();await stop();env.MAX_DAILY_LLM_CALLS='100';providerMode='reject429';await start();service=makeService();
   const rejected=liveStore.enqueueQuestion({company_id:cid,analysis_id:quotaJob.analysis_id!,question:'Какие условия договоров уточнить?',idempotency_key:'provider-quota',owner:'bob'});
   await service.worker.tick();assert.equal(liveStore.getJob(rejected.id)!.status,'failed');assert.equal(accepted,3);
   assert.equal((await agent.recover(rejected.id,cid,'question')).state,'failed');
   const rejectionDb=new Store({...loadSettings({LLM_MODE:'demo'}),dbPath:path});
   let rejectionInput:Json;
   try{rejectionInput=JSON.parse(rejectionDb.get('SELECT input FROM model_operations WHERE request_id=?',rejected.id)!.input);}finally{rejectionDb.close();}
   const rejectionResponse=await fetch(base+'/v1/agent/questions',{method:'POST',headers:{'Content-Type':'application/json','X-Internal-Token':secret,'X-Request-ID':rejected.id},body:JSON.stringify(rejectionInput)});
   assert.equal(rejectionResponse.status,429);assert.equal((await rejectionResponse.json()).error.retryable,false);assert.equal(accepted,3);
   await service.stop();await stop();env.LLM_API_KEY='';await start();service=makeService();
   const noKey=liveStore.enqueueQuestion({company_id:cid,analysis_id:quotaJob.analysis_id!,question:'Какие условия договоров уточнить?',idempotency_key:'missing-key',owner:'charlie'});
   await service.worker.tick();assert.equal(liveStore.getJob(noKey.id)!.status,'deferred');
   assert.equal((await agent.recover(noKey.id,cid,'question')).state,'recoverable');assert.equal(accepted,3);
   await service.stop();await stop();env.LLM_API_KEY='local-test-provider-key';providerMode='reject500';await start();service=makeService();
   const unavailable=liveStore.enqueueQuestion({company_id:cid,analysis_id:quotaJob.analysis_id!,question:'Какие условия договоров уточнить?',idempotency_key:'provider-500',owner:'dana'});
   await service.worker.tick();assert.equal(liveStore.getJob(unavailable.id)!.status,'failed','a fully recorded provider 5xx is terminal in the queue');
   assert.equal((await agent.recover(unavailable.id,cid,'question')).state,'failed');assert.equal(accepted,4);
   await service.worker.tick();await service.scanDue();assert.equal(accepted,4);


  }finally{await service?.stop();gatewayDb.close();}

  await stop();
 }finally{
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  model?.closeAllConnections();if(model)await new Promise<void>(r=>model!.close(()=>r()));rmSync(dir,{recursive:true,force:true});
 }
});
