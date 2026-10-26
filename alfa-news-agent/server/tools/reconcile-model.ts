/** Local administrator utility; no provider keys or network are used. */
import { readFileSync, existsSync } from 'node:fs';
import { loadSettings } from '../config.js';
import { Store } from '../db.js';
import { initializeExecution,reconcileAttempt,quarantineRestoredJournal,closeOperation,type OperationKind } from '../model-execution.js';
import { LiveStore } from '../integration/live-store.js';
const args=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1]||args.has(process.argv[i]))throw new Error('Use unique --name value arguments');args.set(process.argv[i],process.argv[i+1]);}
for(const name of ['--database','--company','--action'])if(!args.get(name))throw new Error(name+' required');
if(!existsSync(args.get("--database")!))throw new Error("Existing database file required");
const db=new Store({...loadSettings({LLM_MODE:'demo'}),dbPath:args.get('--database')!});
try {
 const company=args.get('--company')!,action=args.get('--action')!;
 if(['quarantine-restored-queue','release-restored-queue'].includes(action)) {
   if(company!=='ALL')throw new Error('--company ALL required for database-wide maintenance');
   new LiveStore(db).setRestoreHold(action==='quarantine-restored-queue',args.get('--actor')??'',args.get('--evidence')??'');
 } else if(action==='close-job-without-retry') {
   new LiveStore(db).closeUnknown(args.get('--id')??'',company,args.get('--actor')??'',args.get('--evidence')??'');
 } else if(['review-legacy-not-processed','review-job-not-processed'].includes(action)) {
   if(!args.get('--id')||!args.get('--actor')||!args.get('--evidence'))throw new Error('--id, --actor and --evidence required');
   const store=new LiveStore(db);
   if(action==='review-legacy-not-processed')store.reviewLegacy(args.get('--id')!,company,args.get('--actor')!,args.get('--evidence')!);
   else store.reviewUnknownConfirmed(args.get('--id')!,company,args.get('--actor')!,args.get('--evidence')!);
 } else {
   initializeExecution(db);
   if(action==='quarantine-restored'){if(company!=='ALL')throw new Error('--company ALL required for database-wide maintenance');quarantineRestoredJournal(db,args.get('--actor')??'',args.get('--evidence')??'');}
   else if(action==='close_without_retry'){const kind=args.get('--kind');if(!['analysis','question'].includes(kind??''))throw new Error('kind required');closeOperation(db,{company,kind:kind as OperationKind,requestId:args.get('--id')??'',actor:args.get('--actor')??'',evidence:args.get('--evidence')??''});}
   else if(action==='inspect') {
     const rows=db.all('SELECT request_id,kind,state,input_hash,config_hash,created_at,updated_at FROM model_operations WHERE company_id=? ORDER BY updated_at DESC LIMIT 100',company);
     process.stdout.write(JSON.stringify(rows.map(row=>({...row,attempts:db.all('SELECT ordinal,state,call_id,status,provider_request_id,deadline_at,created_at,updated_at FROM model_attempts WHERE operation_key=(SELECT operation_key FROM model_operations WHERE company_id=? AND kind=? AND request_id=?) ORDER BY ordinal',company,row.kind,row.request_id)})),null,2)+'\n');
   } else {
     const kind=args.get('--kind');if(!['analysis','question'].includes(kind??''))throw new Error('--kind analysis|question required');
     if(!['supply_response','confirm_not_processed'].includes(action))throw new Error('Unknown action');
     const raw=args.get('--response-file')?readFileSync(args.get('--response-file')!,'utf8'):undefined;
     reconcileAttempt(db,{company,requestId:args.get('--id')??'',kind:kind as OperationKind,ordinal:Number(args.get('--ordinal')),actor:args.get('--actor')??'',evidence:args.get('--evidence')??'',action:action as 'supply_response'|'confirm_not_processed',response:raw?JSON.parse(raw):undefined});
   }
 }
 if(action!=='inspect')process.stdout.write('Resolution recorded. The worker will poll the saved operation; no model request was sent by this utility.\n');
} finally {db.close();}
