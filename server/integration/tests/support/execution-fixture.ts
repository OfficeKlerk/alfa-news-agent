import {appendFileSync} from 'node:fs';
import {Store} from '../../../db.js';
import {loadSettings} from '../../../config.js';
import {createComplete} from '../../../llm.js';
import {DurableAgent} from '../../../model-execution.js';
import {envelope} from '../../contracts.js';
import type {Json} from '../../../types.js';
export const input={company_id:'A',news_id:'news-one'};
export function executionFixture(path:string,counter:string,phase='normal'){
 const settings={...loadSettings({LLM_MODE:'live',LLM_API_KEY:'unit-test-no-network',LLM_BASE_URL:'https://provider.invalid/v1'}),dbPath:path};
 const db=new Store(settings);
 const complete=createComplete(settings,db,async()=>{
  appendFileSync(counter,'accepted\n');
  if(phase==='sent')process.kill(process.pid,'SIGKILL');
  return Response.json({id:'provider-id-1',choices:[{finish_reason:'stop',message:{content:'{"text":"saved provider output"}'}}],usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}},{headers:{'x-request-id':'receipt-1'}});
 });
 const run=async(_input:Json,id:string)=>{
  const message=await complete([{role:'user',content:'fixed test payload'}],undefined,true);
  if(phase==='received')process.kill(process.pid,'SIGKILL');
  return envelope({answer:message.content},id,'live');
 };
 const agent=new DurableAgent(db,{analyze:run,answer:run},{model:settings.model});
 return {db,agent};
}
if(process.argv[2]==='--crash-child'){
 const f=executionFixture(process.argv[3],process.argv[4],process.argv[5]);
 await f.agent.analyze(input,'crash-job');f.db.close();
}
