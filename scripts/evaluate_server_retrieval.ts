/** Offline in-process measurement of the real SQLite + Retrieval + LegacyRetrieval classes. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { loadSettings, ROOT } from "../server/config.js";
import { Store } from "../server/db.js";
import { Retrieval } from "../server/retrieval.js";
import { normalizePublicationDate } from "../server/news-events.js";
import { LegacyRetrieval } from "../server/integration/retrieval.js";
import { validate } from "../server/integration/contracts.js";
import { aggregateMetrics, eligibleGroundTruth, percentile, uniqueDocuments, validateEvaluationInputs, validateReference, type RankedEvidence } from "../server/integration/retrieval-evaluation.js";
import { freshnessSummary, diversitySummary, fresherRelevantAvailable, meanOf } from "../server/integration/retrieval-freshness.js";
import type { Json } from "../server/types.js";

const options=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!["--as-of","--out","--repeats","--python"].includes(key)||!value||options.has(key))throw new Error("Usage: --as-of ISO --out var/DIR --repeats 3 --python python");options.set(key,value);}
const asOf=options.get("--as-of")??"2026-10-24T18:00:00Z", repeats=Number(options.get("--repeats")??3);
if(!Number.isInteger(repeats)||repeats<1||repeats>20)throw new Error("repeats must be 1..20");
const out=resolve(ROOT,options.get("--out")??"var/retrieval-evaluation");
const location=relative(resolve(ROOT,"var"),out);
if(!location||location.startsWith("..")||resolve(ROOT,"var",location)!==out)throw new Error("Output must be a subdirectory of ignored var/");
mkdirSync(out,{recursive:true});
const read=(name:string)=>readFileSync(resolve(ROOT,name));
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const pages:Json[]=JSON.parse(read("data/research.json").toString("utf8"));
const queries=validateEvaluationInputs(pages,JSON.parse(read("data/demo/rag/queries.json").toString("utf8")));
eligibleGroundTruth(queries[0],pages,asOf); // Validate even before warming the engine.
const eligiblePages=pages.filter(p=>{const date=normalizePublicationDate(p.published_at??p.published??p.date).value;return date!==null&&Date.parse(date)<=Date.parse(asOf);});
const settings={...loadSettings({LLM_MODE:"demo",LLM_API_KEY:""}),dbPath:":memory:"};
const db=new Store(settings);
db.connection.exec("CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT)");
for(const page of pages)db.run("INSERT INTO research VALUES(?,?)",page.id,JSON.stringify(page));
const retrieval=new Retrieval(db), adapter=new LegacyRetrieval(db,retrieval,settings), depth=20;
const pageMap=new Map(pages.map(p=>[JSON.stringify([p.document_id,p.page]),p]));
const results:Json={};
try {
 for(const mode of ["unfiltered_diagnostic","server_as_of"]){
  const perQuery:Json[]=[],allSamples:number[]=[];
  for(const q of queries){
   const search=async()=>mode==="server_as_of"?(await adapter.rag({query:q.query,limit:depth,as_of:asOf},"retrieval-eval")).data.items
     :retrieval.research(q.query,depth).map(p=>({id:"research:"+p.id,document_id:p.document_id,page:p.page,excerpt:p.text,published_at:normalizePublicationDate(p.published_at??p.published??p.date).value}));
   await search();const samples:number[]=[];let items:Json[]=[];
   for(let r=0;r<repeats;r++){const start=performance.now();items=await search();samples.push(performance.now()-start);}
   allSamples.push(...samples);
   const ranked:RankedEvidence[]=items.map(s=>{const page=pageMap.get(JSON.stringify([s.document_id,s.page]));
    if(!page||!page.text.includes(s.excerpt))throw new Error("Returned excerpt is not in the source OCR page");
    if(mode==="server_as_of"&&(!s.published_at||Date.parse(s.published_at)>Date.parse(asOf)))throw new Error("Unsafe runtime source date");
    return {filename:page.filename,document_id:s.document_id,page:s.page,source_id:s.id,published_at:s.published_at,excerpt_sha256:hash(s.excerpt)};
   });
   if(mode==="server_as_of"){
    const short=await adapter.rag({query:q.query,limit:5,as_of:asOf},"retrieval-eval-window");
    validate("RagDataResponse",short,true);
    if(JSON.stringify(short.data.items)!==JSON.stringify(items.slice(0,5)))throw new Error("Top-20 projection does not match the actual top-5 request");
    const resolved=await adapter.resolve({source_ids:items.map(s=>s.id),as_of:asOf},"retrieval-eval-resolve");
    validate("ResolveDataResponse",resolved,true);
    if(resolved.data.unknown_ids.length||JSON.stringify(resolved.data.items)!==JSON.stringify(items))throw new Error("Source resolution changed evidence");
   }
   const ground=eligibleGroundTruth(q,pages,asOf), targets=mode==="server_as_of"?ground.expected:q.expected;
   const distinct=uniqueDocuments(ranked);
   const relevantRank=ranked.findIndex(r=>targets.includes(r.filename));
   // Recency/diversity of the returned top-5 window, and whether a fresher relevant
   // review existed but was not surfaced (TEAM_TASKS2 #5). Dates come from the corpus.
   const top5=ranked.slice(0,5);
   const eligibleRelevantDates=pages.filter(p=>ground.expected.includes(p.filename)).map(p=>normalizePublicationDate(p.published_at??p.published??p.date).value);
   perQuery.push({id:q.id,query:q.query,topic:q.topic??null,expected:q.expected,eligible_expected:ground.expected,blocked_expected:ground.blocked,
    evaluation_targets:targets,status:targets.length?"answerable":"unanswerable_under_as_of",ranked_sources:ranked,ranked_distinct_documents:distinct,
    first_relevant_source_rank:relevantRank<0?null:relevantRank+1,
    distinct_documents_in_first5_sources:new Set(top5.map(r=>r.filename)).size,
    duplicate_crowding_miss_at5:targets.length>0&&!top5.some(r=>targets.includes(r.filename))&&distinct.slice(0,5).some(r=>targets.includes(r.filename)),
    freshness_top5:freshnessSummary(top5,asOf),diversity_top5:diversitySummary(top5),
    fresher_relevant_available:mode==="server_as_of"?fresherRelevantAvailable(top5,targets,eligibleRelevantDates,asOf):null,
    timing_ms:{samples,median:percentile(samples,0.5)}});
  }
  const summarize=(key:string,eligibleOnly:boolean)=>Object.fromEntries([1,3,5].map(k=>[k,aggregateMetrics(perQuery.map(q=>({ranked:q[key].map((r:RankedEvidence)=>r.filename),expected:eligibleOnly?q.evaluation_targets:q.expected})),k)]));
  const fdRows=perQuery.filter(q=>q.evaluation_targets.length).map(q=>({median_age_days:q.freshness_top5.median_age_days,
   top_document_share:q.diversity_top5.top_document_share,distinct_documents:q.diversity_top5.distinct_documents,stale_share:q.freshness_top5.stale_share}));
  results[mode]={query_count:perQuery.length,answerable_query_count:perQuery.filter(q=>q.evaluation_targets.length).length,
   actual_source_window:{strict_original_labels:summarize("ranked_sources",false),available_targets_only:summarize("ranked_sources",true)},
   document_projection_from_top20_sources:{strict_original_labels:summarize("ranked_distinct_documents",false),available_targets_only:summarize("ranked_distinct_documents",true)},
   freshness_and_diversity_top5:{queries:fdRows.length,stale_threshold_days:90,
    mean_median_age_days:meanOf(fdRows,"median_age_days"),mean_top_document_share:meanOf(fdRows,"top_document_share"),
    mean_distinct_documents:meanOf(fdRows,"distinct_documents"),mean_stale_share:meanOf(fdRows,"stale_share"),
    single_document_crowded_queries:perQuery.filter(q=>q.evaluation_targets.length&&typeof q.diversity_top5.top_document_share==="number"&&q.diversity_top5.top_document_share>=0.6).length,
    fresher_relevant_available_queries:perQuery.filter(q=>q.fresher_relevant_available===true).length},
   source_resolution_checked:mode==="server_as_of",quote_match_checked:true,
   timing_ms:{sample_count:allSamples.length,median:percentile(allSamples,0.5),p95:percentile(allSamples,0.95)},queries:perQuery};
 }
}finally{db.close();}

const eligibleCorpusPath=resolve(out,"eligible-corpus.json"),referencePath=resolve(out,"bm25-reference.json");
writeFileSync(eligibleCorpusPath,JSON.stringify(eligiblePages,null,2)+"\n");
const referenceStart=performance.now();
const python=spawnSync(options.get("--python")??"python",["-X","utf8",resolve(ROOT,"scripts/rag_reference_retriever.py"),"--corpus",eligibleCorpusPath,"--queries",resolve(ROOT,"data/demo/rag/queries.json"),"--out",referencePath,"--k","5"],{encoding:"utf8",windowsHide:true,timeout:60000,maxBuffer:4_000_000});
const referenceElapsed=performance.now()-referenceStart;
if(python.error||python.status!==0)throw new Error("BM25 evaluation failed; pass --python with a working Python 3.12 executable. "+(python.error?.message??python.stderr).slice(0,800));
const reference:Json=JSON.parse(readFileSync(referencePath,"utf8"));validateReference(reference,queries,eligiblePages);
const referenceRows=queries.map(q=>({ranked:reference.queries[q.id].map((r:RankedEvidence)=>r.filename),expected:eligibleGroundTruth(q,pages,asOf).expected}));
const referenceMetrics=Object.fromEntries([1,3,5].map(k=>[k,aggregateMetrics(referenceRows,k)]));
let commit:string|null=null;try{commit=execFileSync("git",["rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim();}catch{}
const evaluation={schema_version:"server_retrieval_evaluation_v1",generated_at:new Date().toISOString(),as_of:asOf,base_commit:commit,
 provenance:{corpus_sha256:hash(read("data/research.json")),queries_sha256:hash(read("data/demo/rag/queries.json")),
  retrieval_code_sha256:hash(read("server/retrieval.ts")),adapter_code_sha256:hash(read("server/integration/retrieval.ts")),
  bm25_code_sha256:hash(read("scripts/rag_reference_retriever.py")),evaluator_code_sha256:hash(read("scripts/evaluate_server_retrieval.ts")),metrics_code_sha256:hash(read("server/integration/retrieval-evaluation.ts")),freshness_code_sha256:hash(read("server/integration/retrieval-freshness.ts")),eligible_corpus_sha256:hash(readFileSync(eligibleCorpusPath)),reference_sha256:hash(readFileSync(referencePath))},
 protocol:{query_count:queries.length,corpus_pages:pages.length,corpus_documents:new Set(pages.map(p=>p.document_id)).size,
 eligible_pages:eligiblePages.length,eligible_documents:new Set(eligiblePages.map(p=>p.document_id)).size,source_pool_depth:depth,repeats,warmup_per_query:1,node:process.version,platform:process.platform,
 timing_scope:"SQLite in-memory + in-process retrieval; no HTTP, source audit, Python process or LLM in search timings",page_relevance_labels_available:false,
 llm_calls:0,network_calls:0,ranking_changed:false},runs:results,
 bm25_on_same_eligible_corpus:{method:"Existing Python reference, whole OCR pages, best page per document; not serving code",metrics:referenceMetrics,process_elapsed_ms:referenceElapsed,queries:reference.queries},
 limitations:["28 existing development queries with document-level labels; no independent human holdout or page/quote relevance labels.",
 "Runtime returns chunks; reference returns distinct documents. Do not compare source-window hit@k directly with reference document hit@k.",
 "Document projection uses only the actual top-20 source pool; it is not an exhaustive document ranker.",
 "Available-target metrics omit queries with no dated relevant document; strict metrics retain all original targets. Both are reported.",
 "Reference uses full pages and different tokenization. A difference is not proof that replacing just the scoring formula will improve serving.",
 "Exact quote/source resolution is a mechanical check, not proof of relevance or financial correctness.","Timings are single-process warmed observations, not production latency or a load test.",
 "Freshness/diversity describe the returned top-5 window relative to as_of; the 90-day stale threshold is a reporting choice, not a serving filter, and recency is not relevance.","top_document_share near 1 means results are crowded into one document; it does not by itself prove a worse answer."]};
writeFileSync(resolve(out,"evaluation.json"),JSON.stringify(evaluation,null,2)+"\n");
console.log(JSON.stringify({out,queries:queries.length,eligible_queries:results.server_as_of.answerable_query_count,
 runtime_chunks:results.server_as_of.actual_source_window.available_targets_only,
 runtime_document_projection:results.server_as_of.document_projection_from_top20_sources.available_targets_only,
 freshness_and_diversity_top5:results.server_as_of.freshness_and_diversity_top5,
 bm25_documents:referenceMetrics,source_audit:"passed",llm_calls:0},null,2));
