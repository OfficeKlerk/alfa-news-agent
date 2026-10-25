import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createGateway} from '../gateway.js';
import {enforceTenant} from '../access.js';
import {ApiFault,envelope} from '../contracts.js';
import {LiveStore} from '../live-store.js';
import {ContractClient} from '../client.js';
import {loadSettings} from '../../config.js';

test('merged live HTTP policy denies cross-company routes and status excludes foreign errors/subscriptions',async()=>{
 const db=new DatabaseSync(':memory:'),store=new LiveStore(db);
 store.subscribe({company_id:'A',audience_role:'cfo',limit:5,min_score:0.2});store.subscribe({company_id:'B',audience_role:'cfo',limit:5,min_score:0.2});
 store.enqueueAnalysis({company_id:'B',news_id:'private-B-news',revision:'one',audience_role:'cfo',payload:{}});
 db.prepare("UPDATE live_jobs SET error='private-B-error' WHERE company_id='B'").run();
 const ml=new ContractClient('https://unused.invalid');
 const app=createGateway({access:{secured:false,install(app){app.use((req,res,next)=>{if(req.get('X-Test-Identity')!=='alice')throw new ApiFault(401,'UNAUTHORIZED','Login required');const p={subject:'alice',companies:['A'],roles:[]};res.locals.principal=p;enforceTenant(req,p);next();});}},ml,
 retrieval:{search:async()=>envelope({items:[]},'x','live'),rag:async()=>envelope({items:[],limitations:[]},'x','live'),resolve:async()=>envelope({items:[],unknown_ids:[]},'x','live')},
 agent:{analyze:async()=>{throw Error('No generation allowed');},answer:async()=>{throw Error('No generation allowed');}},
 settings:{...loadSettings({LLM_MODE:'live',NEWS_SEED_MODE:'none'}),analysisEnabled:false},liveStore:store,analysisEnabled:false});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const headers={'X-Test-Identity':'alice','Content-Type':'application/json'};
 try{
  assert.equal((await fetch(base+'/v1/live/feed?company_id=A')).status,401);
  for(const route of ['/v1/live/feed','/v1/live/status','/v1/live/jobs','/v1/live/jobs/id','/v1/live/analyses/id','/v1/budget']){
   assert.equal((await fetch(base+route+'?company_id=B',{headers})).status,403,route);
   assert.equal((await fetch(base+route,{headers})).status,403,'scope required '+route);
  }
  for(const route of ['/v1/live/subscriptions','/v1/live/scan','/v1/live/analyses/id/favorite','/v1/live/analyses/id/questions'])assert.equal((await fetch(base+route,{headers,method:'POST',body:JSON.stringify({company_id:'B'})})).status,403,route);
  const r=await fetch(base+'/v1/live/status?company_id=A',{headers});assert.equal(r.status,200);const body=await r.json();
  assert.deepEqual(body.data.queue.subscriptions.map((s:{company_id:string})=>s.company_id),['A']);
  assert.deepEqual(body.data.queue.recent_errors,[]);assert.equal(body.data.queue.jobs.queued,0);assert.ok(!JSON.stringify(body).includes('private-B'));
  assert.equal((await fetch(base+'/v1/feeds/status',{headers})).status,403);
 } finally {await app.locals.live.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();}
});
