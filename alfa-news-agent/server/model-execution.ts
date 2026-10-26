/** Durable operation and paid-call journal. No network retries for an uncertain send. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import type { Json } from './types.js';
import { ModelError } from './types.js';
import { ApiFault } from './integration/contracts.js';
import { canonicalJson } from './integration/context.js';
import type { AgentPort } from './integration/agent.js';
import type { Envelope } from './integration/contracts.js';

export type OperationKind = 'analysis' | 'question';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const context=new AsyncLocalStorage<{key:string;ordinal:number;configHash:string;epoch:number;signal?:AbortSignal}>();
const initialized=new WeakSet<object>();
export function initializeExecution(db:Store) {
 if(initialized.has(db.connection))return;
 db.connection.exec(`CREATE TABLE IF NOT EXISTS model_operations(
 operation_key TEXT PRIMARY KEY,request_id TEXT NOT NULL,company_id TEXT NOT NULL,kind TEXT NOT NULL,input_hash TEXT NOT NULL,config_hash TEXT NOT NULL,input TEXT NOT NULL,
 state TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 0);
 CREATE UNIQUE INDEX IF NOT EXISTS model_operations_identity ON model_operations(company_id,kind,request_id);
 CREATE TABLE IF NOT EXISTS model_attempts(operation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,
 call_id INTEGER,status INTEGER,body TEXT,provider_request_id TEXT,deadline_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(operation_key,ordinal));
 CREATE TABLE IF NOT EXISTS model_reconciliation(seq INTEGER PRIMARY KEY,operation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,actor TEXT NOT NULL,evidence TEXT NOT NULL,action TEXT NOT NULL,previous TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 if(!db.all('PRAGMA table_info(model_operations)').some(c=>c.name==='epoch'))db.connection.exec('ALTER TABLE model_operations ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0');
 if(!db.all('PRAGMA table_info(model_attempts)').some(c=>c.name==='deadline_at'))db.connection.exec('ALTER TABLE model_attempts ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0');
 initialized.add(db.connection);
}
export function unknownOutcome():ModelError{return new ModelError('Исход обращения к модели неизвестен. Повторная отправка заблокирована до сверки.','MODEL_OUTCOME_UNKNOWN',503);}
export function callIdentity(payload:unknown,baseUrl:string):CallIdentity|undefined {
 const current=context.getStore();
 return current ? {key:current.key,ordinal:++current.ordinal,payloadHash:hash([baseUrl,payload]),configHash:current.configHash,epoch:current.epoch} : undefined;
}
export function executionSignal(){return context.getStore()?.signal;}
export type CallIdentity={key:string;ordinal:number;payloadHash:string;configHash:string;epoch:number;callId?:number|bigint};
export function savedCall(db:Store,id:CallIdentity):{status:number;body:string;callId:number}|undefined {
 initializeExecution(db);
 const row=db.get('SELECT * FROM model_attempts WHERE operation_key=? AND ordinal=?',id.key,id.ordinal);
 if(!row)return;
 if(row.state==='not_processed')return;
 if(row.payload_hash!==id.payloadHash)throw new ModelError('Контекст сохранённой попытки изменился. Требуется сверка.','OPERATION_CONFLICT',409);
 if(row.state==='received')return {status:Number(row.status),body:String(row.body),callId:Number(row.call_id)};
 throw unknownOutcome();
}
/** Called inside the SAME transaction that reserves the paid budget. */
export function markSending(db:Store,id:CallIdentity,callId:number|bigint,timeout=120000) {
 const operation=db.get('SELECT state,config_hash,epoch FROM model_operations WHERE operation_key=?',id.key);
 if(!operation||['restore_review','failed','succeeded'].includes(operation.state)||operation.config_hash!==id.configHash||Number(operation.epoch)!==id.epoch)throw unknownOutcome();
 id.callId=callId;
 const old=db.get('SELECT state FROM model_attempts WHERE operation_key=? AND ordinal=?',id.key,id.ordinal);
 if(old && old.state!=='not_processed')throw unknownOutcome();
 db.run(`INSERT INTO model_attempts(operation_key,ordinal,payload_hash,state,call_id,status,body,provider_request_id,deadline_at,created_at,updated_at) VALUES(?,?,?,'sent',?,NULL,NULL,NULL,?,?,?)
 ON CONFLICT(operation_key,ordinal) DO UPDATE SET payload_hash=excluded.payload_hash,state='sent',call_id=excluded.call_id,status=NULL,body=NULL,provider_request_id=NULL,deadline_at=excluded.deadline_at,updated_at=excluded.updated_at`,id.key,id.ordinal,id.payloadHash,callId,Date.now()+timeout+30000,Date.now(),Date.now());
}
export function noteProviderReceipt(db:Store,id:CallIdentity,status:number,requestId:string|null) {
 db.run("UPDATE model_attempts SET status=?,provider_request_id=?,updated_at=? WHERE operation_key=? AND ordinal=? AND state='sent' AND call_id=?",status,requestId?.slice(0,255)??null,Date.now(),id.key,id.ordinal,id.callId??null);
}
export function saveReceived(db:Store,id:CallIdentity,status:number,body:string,providerRequestId:string|null) {
 const result=db.run("UPDATE model_attempts SET state='received',status=?,body=?,provider_request_id=?,updated_at=? WHERE operation_key=? AND ordinal=? AND state='sent' AND call_id=?",status,body,providerRequestId?.slice(0,255)??null,Date.now(),id.key,id.ordinal,id.callId??null);
 if(!result.changes)throw unknownOutcome();
}
function identity(company:string,kind:OperationKind,id:string){return hash([company,kind,id]);}
function fault(error:unknown){const e=error as {code?:string;status?:number;message?:string};return {code:e.code??'INTERNAL_ERROR',status:e.status??500,message:e.message??'Generation failed'};}
export class DurableAgent implements AgentPort {
 private active=new Set<string>();
 constructor(private db:Store,private delegate:AgentPort,private configuration:unknown){initializeExecution(db);}
 analyze(input:Json,id:string,signal?:AbortSignal){return this.run('analysis',input,id,signal);}
 answer(input:Json,id:string,signal?:AbortSignal){return this.run('question',input,id,signal);}
 async recover(id:string,company:string,kind:OperationKind) {
  const key=identity(company,kind,id),row=this.db.get('SELECT * FROM model_operations WHERE operation_key=?',key);
  if(!row)return {state:'not_found'} as const;
  if(row.state==='succeeded')return {state:'succeeded',response:JSON.parse(row.result)};
  if(row.state==='failed')return {state:'failed',error:JSON.parse(row.error)};
  if(row.state==='restore_review')return {state:'unknown'};
  if(this.active.has(key))return {state:'running'};
  if(this.db.get("SELECT 1 FROM model_attempts WHERE operation_key=? AND state='sent'",key))return {state:'unknown'};
  return {state:'recoverable'};
 }
 private async run(kind:OperationKind,input:Json,id:string,signal?:AbortSignal):Promise<Envelope> {
  const company=String(input.company_id),key=identity(company,kind,id),inputHash=hash(input),configHash=hash(this.configuration);
  const old=this.db.get('SELECT * FROM model_operations WHERE operation_key=?',key);
  if(old && old.input_hash!==inputHash)throw new ApiFault(409,'OPERATION_CONFLICT','Operation ID belongs to a different input');
  if(old?.state==='succeeded')return JSON.parse(old.result);
  if(old?.state==='failed'){const e=JSON.parse(old.error);throw new ApiFault(e.status,e.code,e.message);}
  if(old?.state==='restore_review')throw unknownOutcome();
  if(old && old.config_hash!==configHash) {
    const unsafe=this.db.get("SELECT 1 FROM model_attempts WHERE operation_key=? AND state<>'not_processed'",key);
    if(unsafe)throw new ApiFault(409,'OPERATION_CONFLICT','Generation settings changed; resolve the old operation first');
    this.db.run("UPDATE model_operations SET config_hash=? WHERE operation_key=? AND state='prepared'",configHash,key);
  }
  if(this.active.has(key) || this.db.get("SELECT 1 FROM model_attempts WHERE operation_key=? AND state='sent'",key))throw unknownOutcome();
  this.db.run(`INSERT OR IGNORE INTO model_operations(operation_key,request_id,company_id,kind,input_hash,config_hash,input,state,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared',NULL,NULL,?,?)`,key,id,company,kind,inputHash,configHash,JSON.stringify(input),Date.now(),Date.now());
  this.active.add(key);
  let epoch=-1;
  try {
   const stored=this.db.get('SELECT * FROM model_operations WHERE operation_key=?',key)!;
   if(stored.input_hash!==inputHash||stored.config_hash!==configHash)throw new ApiFault(409,'OPERATION_CONFLICT','Concurrent operation input changed');
   epoch=Number(stored.epoch);
   const response=await context.run({key,ordinal:0,configHash,epoch,signal},()=>kind==='analysis'?this.delegate.analyze(input,id,signal):this.delegate.answer(input,id,signal));
   this.db.run("UPDATE model_operations SET state='succeeded',result=?,error=NULL,updated_at=? WHERE operation_key=? AND state IN ('prepared','unknown') AND config_hash=? AND epoch=?",JSON.stringify(response),Date.now(),key,configHash,epoch);
   const published=this.db.get("SELECT result FROM model_operations WHERE operation_key=? AND state='succeeded'",key);
   if(!published)throw unknownOutcome();
   return JSON.parse(published.result);
  } catch(error) {
   const completed=this.db.get("SELECT result FROM model_operations WHERE operation_key=? AND state='succeeded'",key);
   if(completed)return JSON.parse(completed.result);
   const uncertain=!!this.db.get("SELECT 1 FROM model_attempts WHERE operation_key=? AND state='sent'",key);
   const preflight=(error as {budgetExhausted?:boolean;beforeSend?:boolean}).budgetExhausted || (error as {beforeSend?:boolean}).beforeSend;
   const received=!!this.db.get("SELECT 1 FROM model_attempts WHERE operation_key=? AND state='received'",key);
   this.db.run("UPDATE model_operations SET state=?,error=?,updated_at=? WHERE operation_key=? AND state IN ('prepared','unknown') AND config_hash=? AND epoch=?",uncertain?'unknown':received&&!preflight?'failed':'prepared',JSON.stringify(fault(error)),Date.now(),key,configHash,epoch);
   if(uncertain)throw unknownOutcome();
   throw error;
  } finally {this.active.delete(key);}
 }
}

/** Offline administrator reconciliation, after obtaining evidence from the provider.
 * Never guesses an outcome, never sends an HTTP request, and keeps an immutable audit row. */
export function reconcileAttempt(db:Store,input:{requestId:string;company:string;kind:OperationKind;ordinal:number;actor:string;evidence:string;action:'supply_response'|'confirm_not_processed';response?:Json}) {
 initializeExecution(db);
 if(!input.actor?.trim()||input.actor.length>255||input.evidence?.trim().length<12||input.evidence.length>2000)throw new Error('Named administrator and provider evidence are required');
 if(!Number.isSafeInteger(input.ordinal)||input.ordinal<1)throw new Error('Invalid attempt ordinal');
 const key=identity(input.company,input.kind,input.requestId);
 db.connection.exec('BEGIN IMMEDIATE');
 try {
  const operation=db.get('SELECT * FROM model_operations WHERE operation_key=?',key);
  if(!operation||operation.state==='succeeded')throw new Error('Operation missing or already complete');
  if(operation.state==='failed' && operation.error && JSON.parse(operation.error).code==='MODEL_OPERATION_CLOSED')throw new Error('Operation was closed without retry');
  if(operation.state==='restore_review')throw new Error('Restored journal requires full provider review; close without retry if no complete evidence is available');
  const row=db.get('SELECT * FROM model_attempts WHERE operation_key=? AND ordinal=?',key,input.ordinal);
  if(!row||!['sent','received'].includes(row.state))throw new Error('No unresolved/rejected attempt');
  const deadline=db.get('SELECT MAX(deadline_at) n FROM model_attempts WHERE operation_key=?',key)!.n;
  if(Number(deadline)>Date.now())throw new Error('Attempt can still be in flight; wait for its deadline');
  if(input.action==='confirm_not_processed') {
    if(row.state==='received'&&Number(row.status)>=200&&Number(row.status)<300)throw new Error('A received successful response cannot be declared unprocessed');
    db.run("UPDATE model_attempts SET state='not_processed',updated_at=? WHERE operation_key=? AND ordinal=?",Date.now(),key,input.ordinal);
    // Only explicit evidence of no processing permits releasing the conservative token reservation.
    db.run("UPDATE llm_budget_reservations SET charged_prompt=0,charged_completion=0,state='confirmed_not_processed',updated_at=? WHERE call_id=?",new Date().toISOString(),row.call_id);
    db.run('UPDATE llm_calls SET prompt_tokens=0,completion_tokens=0 WHERE id=?',row.call_id);
  } else {
    const result=input.response;
    if(!result||!Array.isArray(result.choices)||!result.choices.length||typeof result.choices[0]?.message?.content!=='string')throw new Error('An original provider response with choices is required');
    if(Buffer.byteLength(JSON.stringify(result))>1_000_000)throw new Error('Provider response exceeds journal bound');
    db.run("UPDATE model_attempts SET state='received',status=200,body=?,updated_at=? WHERE operation_key=? AND ordinal=?",JSON.stringify(result),Date.now(),key,input.ordinal);
  }
  db.run('INSERT INTO model_reconciliation(operation_key,ordinal,actor,evidence,action,previous,created_at) VALUES(?,?,?,?,?,?,?)',key,input.ordinal,input.actor,input.evidence,input.action,JSON.stringify(row),Date.now());
  db.run("UPDATE model_operations SET state='prepared',error=NULL,epoch=epoch+1,updated_at=? WHERE operation_key=?",Date.now(),key);
  db.connection.exec('COMMIT');
 } catch(error){db.connection.exec('ROLLBACK');throw error;}
}

/** Mandatory maintenance step before starting an agent from a rolled-back backup. */
export function quarantineRestoredJournal(db:Store,actor:string,evidence:string) {
 initializeExecution(db);
 if(!actor?.trim()||evidence?.trim().length<12)throw new Error('Administrator and restore evidence required');
 db.connection.exec('BEGIN IMMEDIATE');
 try {
  const rows=db.all("SELECT operation_key,state FROM model_operations WHERE state<>'succeeded' AND state<>'failed'");
  for(const row of rows){
   db.run("INSERT INTO model_reconciliation(operation_key,ordinal,actor,evidence,action,previous,created_at) VALUES(?,0,?,?,'restore_quarantine',?,?)",row.operation_key,actor,evidence,JSON.stringify(row),Date.now());
   db.run("UPDATE model_operations SET state='restore_review',epoch=epoch+1,updated_at=? WHERE operation_key=?",Date.now(),row.operation_key);
  }
  db.connection.exec('COMMIT');return rows.length;
 }catch(error){db.connection.exec('ROLLBACK');throw error;}
}
/** Explicitly abandon an unrecoverable paid operation. Keeps ALL its accounting reservations. */
export function closeOperation(db:Store,input:{requestId:string;company:string;kind:OperationKind;actor:string;evidence:string}) {
 initializeExecution(db);
 if(!input.actor?.trim()||input.evidence?.trim().length<12)throw new Error('Administrator and evidence required');
 const key=identity(input.company,input.kind,input.requestId);
 db.connection.exec('BEGIN IMMEDIATE');
 try {
  const row=db.get('SELECT state FROM model_operations WHERE operation_key=?',key);
  if(!row||row.state==='succeeded'||row.state==='failed')throw new Error('No unresolved operation');
  const deadline=db.get('SELECT MAX(deadline_at) n FROM model_attempts WHERE operation_key=?',key)!.n;
  if(Number(deadline)>Date.now())throw new Error('Operation can still be in flight');
  db.run("INSERT INTO model_reconciliation(operation_key,ordinal,actor,evidence,action,previous,created_at) VALUES(?,0,?,?,'close_without_retry',?,?)",key,input.actor,input.evidence,JSON.stringify(row),Date.now());
  db.run("UPDATE model_operations SET state='failed',error=?,epoch=epoch+1,updated_at=? WHERE operation_key=?",JSON.stringify({code:'MODEL_OPERATION_CLOSED',status:409,message:'Операция закрыта оператором без повторного платного вызова.'}),Date.now(),key);
  db.connection.exec('COMMIT');
 }catch(error){db.connection.exec('ROLLBACK');throw error;}
}
