import datetime,json,pathlib,sqlite3,time,urllib.request
root=pathlib.Path.cwd();base='http://127.0.0.1:8765'
def request(path,body=None):
 data=None if body is None else json.dumps(body,ensure_ascii=False).encode()
 req=urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=90) as response:
  result=json.load(response);assert response.status==200
 assert result['meta']['mode']=='live'
 return result['data']
def connect(name):return sqlite3.connect('file:'+str(root/'var/integration/live-news'/f'{name}.sqlite3')+'?mode=ro',uri=True)
assert request('/v1/health')['status']=='ok'
assert request('/v1/runtime')['generation_enabled'] is False
before=json.loads((root/'var/live-check/restart-ids-full.json').read_text());retained={}
for name,table,field in [('retrieval','news','id'),('retrieval','news_versions',"news_id||':'||version_id"),('gateway','live_jobs','id')]:
 c=connect(name);now={x[0] for x in c.execute('SELECT '+field+' FROM '+table)};c.close()
 lost=set(before[table])-now;assert not lost,(table,lost);retained[table]={'before':len(before[table]),'after':len(now),'lost':0}
companies=[]
for cid in ['U_34911','U_99262','U_4909']:
 started=time.monotonic();request('/v1/live/scan',{'company_id':cid,'audience_role':'cfo'})
 # Second pass also checks idempotency and slots released by filtering older candidates.
 request('/v1/live/scan',{'company_id':cid,'audience_role':'cfo'})
 status=request('/v1/live/status?company_id='+cid);assert status['error'] is None,status['error']
 profile=request('/v1/companies/'+cid);feed=request('/v1/live/feed?company_id='+cid)
 assert feed['items']==[], 'Without a key no generated card may be published'
 jobs=request('/v1/live/jobs?company_id='+cid)['items'];selection=status['selection']
 c=connect('gateway');details=[]
 for row in c.execute("SELECT id,status,payload,attempts,error,revision FROM live_jobs WHERE company_id=? ORDER BY created_at",(cid,)):
  jid,jobstatus,payload,attempts,error,rev=row;payload=json.loads(payload)
  if jobstatus not in ['queued','running','deferred']:continue
  event=payload['event'];details.append({'job_id':jid,'status':jobstatus,'title':event['title'],'published_at':event['published_at'],'score':payload.get('selection',{}).get('score'),'reason':payload.get('selection',{}).get('reason'),'sources':[{'title':s['title'],'url':s['url']} for s in event['sources']],'content':event.get('content'),'revision':rev,'attempts':attempts,'error':error})
 c.close()
 assert len(details)<=5, (cid,len(details))
 assert any('ключев' in x['title'].lower() and any('cbr.ru' in s['url'] for s in x['sources']) for x in details),(cid,'Missing official rate event')
 for x in details:
  assert x['content']['scope']!='feed_excerpt'
  assert x['attempts']==0
  assert not any(phrase in x['title'] for phrase in ['Бычьи', 'Самое интересное', 'Фидан: Турция ждет', 'Ты клоун'])
 companies.append({'company_id':cid,'industry':profile['industry'],'bank_products':profile['bank_products'],'foreign_trade':profile['foreign_trade'],'scan_seconds':round(time.monotonic()-started,3),'selection':selection,'pending':details,'validated_cards':0})
collector=request('/v1/feeds/status');assert len(collector['feeds'])==13;assert all(s['last_success'] for s in collector['feeds'])
budget=request('/v1/budget');assert budget['used']['calls']==0;assert budget['used']['tokens']==0
c=connect('retrieval');stats={}
for table in ['news','news_versions','news_article_documents','news_article_backlog']:stats[table]=c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
stats['demo_news']=c.execute('SELECT COUNT(*) FROM news WHERE is_demo=1').fetchone()[0];assert stats['demo_news']==0
stats['content_scopes']={scope:count for scope,count in c.execute("SELECT json_extract(payload,'$.content_scope'),count(*) FROM news_metadata GROUP BY 1")};c.close()
state=request('/v1/live/status');result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'app_url':base+'/live/','week_start':'2026-10-19T00:00:00+03:00','lookback_days':7,'candidate_limit':500,'restart':retained,'stored':stats,'collector':collector,'budget':budget,'queue':state['queue'],'companies':companies,'external_llm_calls':0,'validated_live_model_outputs':0,'external_llm_checked':False,'notes':['Company profiles are anonymized records from the supplied hackathon database, not publicly identified legal entities.','Scores are ranking signals, not probabilities of loss.','Generation uses controlled fixtures in tests; no real Qwen answer is claimed.']}
(root/'var/live-check/full-live-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'stored':stats,'restart':retained,'companies':[{'id':c['company_id'],'eligible':c['selection']['eligible'],'pending':[(x['title'],x['score'],x['reason']) for x in c['pending']]} for c in companies]},ensure_ascii=False,indent=2))
