/** TASKS7 acceptance rerun (REPORT8): archived REPORT7 inputs plus one reviewed bank case. --plan never uses the network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { loadSettings } from "../server/config.js";
import { Store } from "../server/db.js";
import { ModelError, type Json } from "../server/types.js";
import { prepareContext } from "../server/integration/context.js";
import { generatePrepared, answerPrepared } from "../server/integration/prepared-agent.js";
import { PROMPT_VERSION } from "../server/integration/analysis-prompts.js";

const args=process.argv.slice(2), value=(flag:string)=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
assert.ok(args.every(a=>!a.startsWith("--")||["--live","--plan","--dir","--out","--cases","--questions","--max-calls","--basis"].includes(a)),"Unknown option");
assert.ok(Boolean(value("--dir")),"Use --dir <original bundle folder> [--plan | --live --out <fresh directory>]");
assert.ok(!(args.includes("--live")&&args.includes("--plan")),"Choose plan or live");
const root=resolve(value("--dir")!);
const bytes=(name:string)=>{const file=resolve(root,name),rel=relative(root,file);assert.ok(rel&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../")&&!rel.startsWith("..\\"));return readFileSync(file);};
const read=(name:string):Json=>JSON.parse(bytes(name).toString("utf8"));
for(const [name,hash] of Object.entries(read("MANIFEST.json"))) assert.equal(createHash("sha256").update(bytes(name)).digest("hex"),hash,"Original manifest mismatch: "+name);
const index=read("calls-index.json") as unknown as Json[];
const CONTROL="rate-hold-unknown-products-control";
const originals=[...new Map(index.filter(c=>c.kind==="analysis"&&!c.repair&&c.case!==CONTROL).map(c=>[c.case,c])).values()];
assert.equal(originals.length,14,"Expected all 14 baseline analyses");
const analyses=originals.map(c=>{const sent=JSON.parse(read(c.request_file).messages[1].content);prepareContext(sent.input);return {id:c.case,format:c.response_format,input:sent.input,origin:c.request_file,synthetic_control:false};});
// Reuse REPORT7's exact synthetic null control; it is never an original organizer row.
const control=index.find(c=>c.case===CONTROL&&c.kind==="analysis"&&!c.repair)!;
const unknown={id:CONTROL,format:control.response_format,input:JSON.parse(read(control.request_file).messages[1].content).input,origin:control.request_file,synthetic_control:true};
assert.ok(Object.values(unknown.input.profile.bank_products).every(v=>v===null)&&unknown.input.is_mock===true,"Control must stay synthetic with null products");
prepareContext(unknown.input);analyses.push(unknown);
// Positive bank case: the real CBR hold news and real leasing-marked company, with only the two
// dated bank pages that discuss this rate decision cycle. Historical, not the bank's current view.
const bank=structuredClone(analyses.find(c=>c.id==="rate-hold-leasing")!);
bank.id="rate-hold-leasing-bank-positive";
const BANK_PAGES=["research:1shHG89LtMgHT1_uEebHmQSFZe_zbeq7-:p1:c0","research:1bPzix_332N2CyMY0tqCHuYtGsfJWnFGv:p1:c0"];
bank.input.research={...bank.input.research,items:bank.input.research.items.filter((r:Json)=>BANK_PAGES.includes(r.id)),
  limitations:[...bank.input.research.limitations,"Для проверки банковской цитаты оставлены две датированные страницы 11 и 14 сентября 2026 г. о том же цикле решений; это исторические материалы до as_of, а не текущая позиция банка."]};
assert.equal(bank.input.research.items.length,2,"Reviewed bank pages are missing");
for(const r of bank.input.research.items)assert.ok(r.published_at<bank.input.as_of,"Bank page must predate as_of");
prepareContext(bank.input);analyses.push(bank);
// REPORT7 planned three questions; two never ran, so their text comes from its run metadata.
const allQuestions=(read("run-metadata.json").questions as Json[]).map(q=>({id:q.id,format:q.format,question:q.question,origin:"REPORT7 run-metadata.json"}));
assert.equal(allQuestions.length,3);
// Bounded reruns (REPORT8): only the named cases, in REPORT7 order, under a hard call budget.
const list=(flag:string)=>value(flag)===undefined?undefined:value(flag)!.split(",").map(v=>v.trim()).filter(Boolean);
const caseFilter=list("--cases"),questionFilter=list("--questions");
for(const id of caseFilter??[])assert.ok(analyses.some(c=>c.id===id),"Unknown case: "+id);
for(const id of questionFilter??[])assert.ok(allQuestions.some(q=>q.id===id),"Unknown question: "+id);
if(caseFilter)analyses.splice(0,analyses.length,...analyses.filter(c=>caseFilter.includes(c.id)));
const questions=questionFilter?allQuestions.filter(q=>questionFilter.includes(q.id)):allQuestions;
const maxCalls=value("--max-calls")===undefined?40:Number(value("--max-calls"));
assert.ok(Number.isSafeInteger(maxCalls)&&maxCalls>=2&&maxCalls<=40,"--max-calls must be 2..40");
// Accepted analyses from an earlier run may serve as question bases; their inputs must match REPORT7's.
const basisRoot=value("--basis")?resolve(value("--basis")!):undefined;
function basisAnalysis(id:string){
  if(!basisRoot)return undefined;
  const results=JSON.parse(readFileSync(resolve(basisRoot,"results.json"),"utf8")) as Json[];
  if(!results.some(r=>r.case===id&&r.kind==="analysis"&&r.status==="accepted"))return undefined;
  const input=JSON.parse(readFileSync(resolve(basisRoot,id+"-input.json"),"utf8")),envelope=JSON.parse(readFileSync(resolve(basisRoot,id+"-response.json"),"utf8"));
  const original=analyses.find(c=>c.id===id)?.input??JSON.parse(read((index.find(c=>c.case===id&&c.kind==="analysis"&&!c.repair)!).request_file).messages[1].content).input;
  assert.equal(prepareContext(input).sha256,prepareContext(original).sha256,"Basis input differs from REPORT7: "+id);
  return {input,analysis:envelope.data,origin:relative(process.cwd(),basisRoot)+"/"+id+"-response.json"};
}
const plan={execution:"plan",analyses:analyses.map(c=>({case:c.id,format:c.format,origin:c.origin,synthetic_control:c.synthetic_control,as_of:c.input.as_of,context_bytes:prepareContext(c.input).serialized_bytes})),questions:questions.map(q=>({...q,basis:analyses.some(c=>c.id===q.id)?"this run if accepted, else --basis":basisAnalysis(q.id)?.origin??"none"})),max_external_calls:Math.min(maxCalls,(analyses.length+questions.length)*2),approved_call_cap:40,max_output_tokens:6000,reasoning_effort:"none",timeout_seconds:120,route:"direct native prepared-agent functions; not an HTTP gateway/UI test"};
if(!args.includes("--live")){console.log(JSON.stringify(plan,null,2));process.exit(0);}
const out=resolve(value("--out")??"var/llm-evaluation/tasks8-live");
assert.ok(!existsSync(out),"Choose a fresh output folder; never overwrite or silently repeat a live run");
function git(argv:string[]){try{return execFileSync("git",argv,{encoding:"utf8"}).trim();}catch{return "unavailable";}}
/** The working tree is uncommitted: hashes identify the exact code under test. */
function sourceHashes(){const files=execFileSync("git",["ls-files","-co","--exclude-standard","server","scripts","contracts"],{encoding:"utf8"}).split(/\r?\n/).filter(f=>/\.(ts|json)$/.test(f));
  return Object.fromEntries(files.map(f=>[f,createHash("sha256").update(readFileSync(f)).digest("hex")]));}
const settings={...loadSettings(),mode:"live" as const,maxOutputTokens:6000,reasoningEffort:"none",timeout:120000,maxCalls:plan.max_external_calls,dbPath:resolve(out,"calls.sqlite3")};
assert.ok(settings.apiKey.trim(),"LLM_API_KEY is not configured locally");
mkdirSync(out,{recursive:true});
const redact=(text:string)=>text.split(settings.apiKey).join("[REDACTED]");
const save=(name:string,data:unknown)=>writeFileSync(resolve(out,name),redact(typeof data==="string"?data:JSON.stringify(data,null,2))+"\n");
const db=new Store(settings);
db.connection.exec("CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)");
const results:Json[]=[],calls:Json[]=[];let current:Json={},halt=false;
const metadata={...plan,execution:"live",prompt_version:PROMPT_VERSION,model:settings.model,base_url:settings.baseUrl,started_at:new Date().toISOString(),head:git(["rev-parse","HEAD"]),git_status:git(["status","--short"]),source_files:sourceHashes(),comparison:"Same REPORT7 prepared inputs and limits (6000 output tokens, 2 attempts). Null control is synthetic; the bank case narrows research to two dated pages. Gateway/UI are checked separately without paid calls."};
save("run-metadata.json",metadata);
const capturedFetch:typeof fetch=async(url,init)=>{
  assert.ok(calls.length<plan.max_external_calls,"Run call cap reached");
  const n=calls.length+1,stem="call-"+String(n).padStart(2,"0");
  const row:Json={call:n,...current,started_at:new Date().toISOString(),request_file:stem+"-request.json"};calls.push(row);
  const payload=JSON.parse(String(init?.body));row.repair=payload.messages.length>2;save(row.request_file,payload);
  try{
    const response=await fetch(url,init);row.http_status=response.status;
    if(response.ok){
      const text=await response.clone().text();assert.ok(Buffer.byteLength(text)<=1_000_000,"Provider response exceeds audit limit");
      const provider=JSON.parse(text);save(stem+"-provider-response.json",provider);row.provider_file=stem+"-provider-response.json";
      row.finish_reason=provider.choices?.[0]?.finish_reason;row.usage=provider.usage;
      const content=provider.choices?.[0]?.message?.content;
      if(typeof content==="string"){save(stem+"-content.txt",content);try{save(stem+"-draft.json",JSON.parse(content));row.draft_file=stem+"-draft.json";}catch{row.draft_file=null;}}
    }
    return response;
  }catch(error){row.transport_error=error instanceof Error?error.name:"unknown";throw error;}
  finally{row.finished_at=new Date().toISOString();save("calls-index.json",calls);}
};
const accepted=new Map<string,{input:Json,analysis:Json,origin?:string}>();
// Never start a case that could not finish its repair inside the budget.
const budgetLeft=()=>plan.max_external_calls-calls.length;
function failure(error:unknown){
  const e=error instanceof Error?error:new Error("Unknown failure");
  const row:Json={status:"failed",error:redact(e.message),...(error instanceof ModelError?{code:error.code,diagnostics:error.diagnostics}: {})};
  if(error instanceof ModelError&&["MODEL_AUTH_ERROR","MODEL_LIMIT","MODEL_TIMEOUT","MODEL_UNAVAILABLE"].includes(error.code))halt=true;
  return row;
}
try{
  for(const test of analyses){
    current={case:test.id,kind:"analysis",response_format:test.format};
    if(halt){results.push({...current,status:"not_run_transport_stop"});continue;}
    if(budgetLeft()<2){results.push({...current,status:"not_run_call_budget"});continue;}
    save(test.id+"-input.json",test.input);const start=Date.now();
    try{const envelope=await generatePrepared({...settings,responseFormat:test.format},db,test.input,"tasks7-"+test.id,capturedFetch);save(test.id+"-response.json",envelope);accepted.set(test.id,{input:test.input,analysis:envelope.data,origin:"this run"});results.push({...current,status:"accepted",synthetic_control:test.synthetic_control,elapsed_seconds:(Date.now()-start)/1000,bank_claims:envelope.data.claims.filter((c:Json)=>c.kind==="bank").length,claims:envelope.data.claims.length,semantic_review:"pending"});}
    catch(error){results.push({...current,...failure(error),elapsed_seconds:(Date.now()-start)/1000});}
    save("results.json",results);console.log(test.id+": "+results.at(-1)!.status+"; calls="+calls.length);
  }
  for(const test of questions){
    current={case:test.id,kind:"question",response_format:test.format};const basis=accepted.get(test.id)??basisAnalysis(test.id);
    if(halt||!basis||budgetLeft()<2){results.push({...current,status:halt?"not_run_transport_stop":!basis?"blocked_new_analysis_failed":"not_run_call_budget"});save("results.json",results);continue;}
    current.basis=basis.origin;
    const input={company_id:basis.input.company_id,analysis:basis.analysis,prepared_input:basis.input,history:[],question:test.question,as_of:basis.input.as_of,audience_role:basis.input.audience_role};save(test.id+"-question-input.json",input);
    try{const envelope=await answerPrepared({...settings,responseFormat:test.format},db,input,"tasks7-q-"+test.id,capturedFetch);save(test.id+"-question-response.json",envelope);results.push({...current,status:"accepted",semantic_review:"pending"});}
    catch(error){results.push({...current,...failure(error)});}
    save("results.json",results);console.log(test.id+" question: "+results.at(-1)!.status+"; calls="+calls.length);
  }
}finally{
  db.close();
  save("results.json",results);
  save("summary.json",{...metadata,finished_at:new Date().toISOString(),external_calls:calls.length,repair_calls:calls.filter(c=>c.repair).length,length_responses:calls.filter(c=>c.finish_reason==="length").length,usage:{prompt_tokens:calls.reduce((n,c)=>n+(c.usage?.prompt_tokens??0),0),completion_tokens:calls.reduce((n,c)=>n+(c.usage?.completion_tokens??0),0),reported_cost:calls.reduce((n,c)=>n+(typeof c.usage?.cost==="number"?c.usage.cost:0),0),cost_unit:"unconfirmed"},results,semantic_review:"pending; technical acceptance is not proof of usefulness",ui:"not_checked"});
}
console.log("Saved locally: "+out);
