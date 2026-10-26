import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../db.js";
import { loadSettings } from "../../config.js";
import { Retrieval } from "../../retrieval.js";
import { bankQuery } from "../bank-query.js";
const cutoff="2026-10-25T18:00:00Z";
function setup() {
 const db=new Store({...loadSettings({LLM_MODE:"demo"}),dbPath:":memory:"});
 db.connection.exec('CREATE TABLE research(id TEXT PRIMARY KEY,payload TEXT)');
 const put=(id:string,text:string,date:string|null="2026-09-01")=>db.run('INSERT OR REPLACE INTO research VALUES(?,?)',id,JSON.stringify({id,document_id:id,title:id,filename:id+'.pdf',page:1,url:'https://example.org/'+id,text,date}));
 return {db,put,r:new Retrieval(db)};
}
test("persistent bank index reflects insertion, changed text/date and deletion without restart",()=>{
 const h=setup();try{
 h.put('old','Рост инфляции и цены');assert.equal(h.r.research('инфляция',5,cutoff)[0]?.document_id,'old');
 h.put('new','Ключевая ставка кредитование');assert.equal(h.r.research('кредит',5,cutoff)[0]?.document_id,'new');
 h.put('old','Валютные рынки');assert.deepEqual(h.r.research('инфляция',5,cutoff),[]);
 h.put('new','Ключевая ставка кредитование','2027-01-01');assert.deepEqual(h.r.research('кредит',5,cutoff),[]);
 h.db.run('DELETE FROM research WHERE id=?','old');assert.deepEqual(h.r.research('валют',5,cutoff),[]);
 }finally{h.db.close();}
});
test("shared index is reused and exact source excerpts remain unchanged",()=>{
 const h=setup();try{
 const text='Ключевая ставка: разные варианты инфляции. '.repeat(100);h.put('doc',text);
 const rows=h.r.research('инфляция',20,cutoff);assert.ok(rows.length);assert.ok(rows.every(s=>text.includes(s.text)));
 const rev=h.db.get('SELECT indexed_revision FROM bank_index_state')!.indexed_revision;
 const other=new Retrieval(h.db);assert.deepEqual(other.research('инфляция',20,cutoff),rows);
 assert.equal(h.db.get('SELECT indexed_revision FROM bank_index_state')!.indexed_revision,rev);
 assert.deepEqual(other.research('" OR 1=1 --',5,cutoff),[]);
 assert.throws(()=>other.research('ставка',5,'not-a-date'));
 }finally{h.db.close();}
});
test("RAG query uses actual event text and confirmed product channels without private metadata",()=>{
 const event={title:'Решение регулятора',text:'Изменение ключевой ставки',event_type:'rate_change'};
 const a=bankQuery(event,{company_id:'private-company-id',bank_products:{loan:true,deposit:false},provenance:{secret:'not-for-search'}});
 assert.match(a,/ключевой ставки/);assert.match(a,/кредит/);assert.doesNotMatch(a,/private-company|secret|депозиты/);
 const b=bankQuery(event,{bank_products:{loan:false,deposit:true}});assert.match(b,/депозиты/);assert.doesNotMatch(b,/кредит/);
 assert.ok(bankQuery({...event,title:'я'.repeat(5000),text:'я'.repeat(5000)},{bank_products:{}}).length<=500);
});
test("Python microsecond timestamps respect millisecond publication cutoffs",()=>{
 const h=setup();try{
 h.put('before','Ключевая ставка','2026-10-25T12:00:00.000Z');h.put('after','Ключевая ставка','2026-10-25T12:00:00.001Z');
 assert.deepEqual(h.r.research('ставка',20,'2026-10-25T12:00:00.000999+00:00').map(x=>x.document_id),['before']);
 assert.equal(h.r.research('ставка',20,'2026-10-25T12:00:00.001000+00:00').length,2);
 }finally{h.db.close();}
});

test("incremental index touches only changed documents and rolls back a broken update atomically",()=>{
 const h=setup();try{
 h.put('a','Ключевая ставка');h.put('b','Инфляция');h.r.research('ставка инфляция',20,cutoff);
 const row=h.db.get("SELECT rowid,payload FROM bank_chunks WHERE source_id='a'")!;
 h.put('b','Рост цен');h.r.research('ставка',20,cutoff);
 assert.deepEqual(h.db.get("SELECT rowid,payload FROM bank_chunks WHERE source_id='a'"),row);
 const before=h.db.all('SELECT rowid,* FROM bank_chunks ORDER BY id');
 h.db.run('UPDATE research SET payload=? WHERE id=?',JSON.stringify({id:'b',text:null}),'b');
 assert.throws(()=>h.r.research('ставка',20,cutoff),/Invalid research document/);
 assert.deepEqual(h.db.all('SELECT rowid,* FROM bank_chunks ORDER BY id'),before);
 assert.ok(h.db.get('SELECT count(*) AS n FROM bank_index_pending')!.n>0);
 h.put('b','Рост цен');assert.ok(h.r.research('рост',20,cutoff).some(x=>x.document_id==='b'));
 assert.equal(h.db.get('SELECT count(*) AS n FROM bank_index_pending')!.n,0);
 }finally{h.db.close();}
});
