import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateMetrics, eligibleGroundTruth, percentile, retrievalMetrics, uniqueDocuments, validateEvaluationInputs, validateReference } from "../retrieval-evaluation.js";

const pages=[{id:"a:1",document_id:"a",filename:"a.pdf",page:1,text:"ставка",date:"2026-09-11"},
 {id:"b:1",document_id:"b",filename:"b.pdf",page:1,text:"золото",date:null}];
const q={id:"q",query:"ставка",expected:["a.pdf","b.pdf"]};

test("chunk-window recall counts documents once and MRR is truncated at k",()=>{
 assert.deepEqual(retrievalMetrics(["x.pdf","x.pdf","a.pdf"],["a.pdf","b.pdf"],2),{hit_at_k:0,recall_at_k:0,mrr_at_k:0});
 assert.deepEqual(retrievalMetrics(["a.pdf","a.pdf","a.pdf"],["a.pdf","b.pdf"],3),{hit_at_k:1,recall_at_k:0.5,mrr_at_k:1});
 assert.equal(retrievalMetrics(["x.pdf","a.pdf"],["a.pdf"],2).mrr_at_k,0.5);
});
test("distinct-document projection preserves ordering and exposes chunk crowding",()=>{
 const rows=["x","x","a","b"].map((f,i)=>({filename:f,document_id:f,page:i+1}));
 assert.deepEqual(uniqueDocuments(rows).map(r=>r.filename),["x","a","b"]);
 assert.equal(retrievalMetrics(rows.map(r=>r.filename),["a"],2).hit_at_k,0);
 assert.equal(retrievalMetrics(uniqueDocuments(rows).map(r=>r.filename),["a"],2).hit_at_k,1);
});
test("unknown dates and future days remain blocked in ground truth; day boundary matches serving",()=>{
 assert.deepEqual(eligibleGroundTruth(q,pages,"2026-09-11T12:00:00Z"),{expected:[],blocked:[{filename:"a.pdf",reason:"future_publication"},{filename:"b.pdf",reason:"unknown_or_invalid_publication_date"}]});
 assert.deepEqual(eligibleGroundTruth(q,pages,"2026-09-12T00:00:00Z").expected,["a.pdf"]);
 assert.throws(()=>eligibleGroundTruth(q,pages,"2026-09-12"),/timezone/);
});
test("unanswerable queries are not scored as perfect or silently included in available-target averages",()=>{
 assert.deepEqual(aggregateMetrics([{ranked:[],expected:[]}],3),{n:0,hit_at_k:null,recall_at_k:null,mrr_at_k:null});
 const result=aggregateMetrics([{ranked:["a.pdf"],expected:["a.pdf"]},{ranked:[],expected:[]}],3);
 assert.equal(result.n,1);assert.equal(result.hit_at_k,1);
 assert.equal(aggregateMetrics([{ranked:["a.pdf"],expected:["a.pdf"]},{ranked:[],expected:["b.pdf"]}],3).hit_at_k,0.5);
});
test("evaluation rejects unknown labels, repeated IDs and ambiguous pages",()=>{
 assert.equal(validateEvaluationInputs(pages,{queries:[q]}).length,1);
 assert.throws(()=>validateEvaluationInputs(pages,{queries:[q,q]}));
 assert.throws(()=>validateEvaluationInputs(pages,{queries:[{...q,expected:["missing.pdf"]}]}));
 assert.throws(()=>validateEvaluationInputs([...pages,pages[0]],{queries:[q]}));
});
test("reference cannot omit hard queries, repeat documents, or cite excluded pages",()=>{
 const ref={_retriever:"bm25_lexical_reference",k:5,queries:{q:[{filename:"a.pdf",document_id:"a",page:1,score:1}]}};
 validateReference(ref,[q],[pages[0]]);
 assert.throws(()=>validateReference({...ref,queries:{}},[q],[pages[0]]));
 assert.throws(()=>validateReference({...ref,queries:{q:[ref.queries.q[0],ref.queries.q[0]]}},[q],[pages[0]]));
 assert.throws(()=>validateReference(ref,[q],[pages[1]]));
});
test("latency quantiles validate samples and do not mutate the observations",()=>{
 const values=[3,1,2];assert.equal(percentile(values,0.5),2);assert.equal(percentile(values,0.95),3);
 assert.deepEqual(values,[3,1,2]);assert.equal(percentile([],0.5),null);assert.throws(()=>percentile([-1],0.5));
});
