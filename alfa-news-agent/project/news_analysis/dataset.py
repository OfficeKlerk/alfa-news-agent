"""Offline, reproducible assembly and auditing of curated relevance datasets.

No label inference, model fitting or network calls happen here. Labels come from
explicit, versioned annotations. IDs and rich evidence are never model features.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sqlite3

from company_context import ContextStore
from .contracts import text, timestamp, validate_event
from .features import FEATURE_NAMES, FEATURE_VERSION, extract_features
from .graph import PaymentGraph
from .ranking import temporal_split, validate_rows
from .evidence import ROW_FIELDS, validate_research

FORMAT = 'alfa-relevance-data-v1'
PARTS = ('train', 'validation', 'test', 'unseen_company_test', 'reserved_company_history')


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'),
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError('Nonfinite JSON: '+x)))


def read_jsonl(path):
    return [json.loads(line, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('Nonfinite JSON: '+x)))
            for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def write_jsonl(path, rows):
    Path(path).write_text(''.join(dumps(row)+'\n' for row in rows), encoding='utf-8')


def key(row):
    return row['company_id']+'::'+row['event_id']


def validate_curation(events, companies, annotations):
    event_ids, company_ids = set(), set()
    for event in events:
        validate_event(event)
        if event['event_id'] in event_ids:
            raise ValueError('Duplicate event_id; cluster duplicate reporting before annotation')
        event_ids.add(event['event_id'])
        if timestamp(event['published_at']).date().isoformat() != event['publication_date']:
            raise ValueError('Publication date and conservative timestamp differ')
        text(event.get('split_group_id'), 'split_group_id')
        for source in event['sources']:
            for field in ('publisher', 'accessed_on', 'verification_method', 'excerpt_kind'):
                text(source.get(field), 'source.'+field)
    for company in companies:
        uid = text(company.get('company_id'), 'company_id')
        if uid in company_ids:
            raise ValueError('Duplicate selected company')
        company_ids.add(uid)
    expected = {(c, e) for c in company_ids for e in event_ids}
    actual = set()
    for row in annotations:
        pair = row.get('company_id'), row.get('event_id')
        if pair not in expected or pair in actual:
            raise ValueError('Unknown or duplicate annotation pair: '+str(pair))
        actual.add(pair)
        if type(row.get('label')) is not int or row['label'] not in range(4):
            raise ValueError('Annotation label must be an integer 0..3')
        if row.get('label_origin') not in {'ai', 'human'}:
            raise ValueError('Curated labels must identify ai or human origin')
        for field in ('explanation', 'annotator', 'rubric_version', 'review_status', 'impact_channel', 'next_step'):
            text(row.get(field), field)
        if row.get('confidence') not in {'low', 'medium', 'high'}:
            raise ValueError('Unknown annotation confidence')
        if not isinstance(row.get('missing_data'), list):
            raise ValueError('missing_data must be a list')
    if actual != expected:
        raise ValueError('Incomplete annotation matrix: missing '+str(len(expected-actual))+' pairs')
    if not actual:
        raise ValueError('Empty dataset')


def partition(rows, holdout_companies):
    validate_rows(rows)
    holdout = set(holdout_companies)
    if holdout - {r['company_id'] for r in rows}:
        raise ValueError('Unknown holdout company')
    pool = [r for r in rows if r['company_id'] not in holdout]
    train, validation, test = temporal_split(pool)
    test_events = {r['event_id'] for r in test}
    unseen = [r for r in rows if r['company_id'] in holdout and r['event_id'] in test_events]
    reserved = [r for r in rows if r['company_id'] in holdout and r['event_id'] not in test_events]
    return dict(zip(PARTS, (train, validation, test, unseen, reserved)))


def audit_rows(rows, parts):
    validate_rows(rows)
    assigned = [r for part in parts.values() for r in part]
    if len(assigned) != len(rows) or Counter(key(r) for r in assigned) != Counter(key(r) for r in rows):
        raise ValueError('Splits must partition all rows exactly once')
    for left, right in [('train','validation'), ('train','test'), ('validation','test')]:
        a={r.get('split_group_id',r['event_id']) for r in parts[left]}
        b={r.get('split_group_id',r['event_id']) for r in parts[right]}
        if a & b:
            raise ValueError('Event/policy leakage across splits')
    seen={r['company_id'] for name in ('train','validation','test') for r in parts[name]}
    hidden={r['company_id'] for name in ('unseen_company_test','reserved_company_history') for r in parts[name]}
    if seen & hidden:
        raise ValueError('Company holdout leakage')
    for name in ('train','validation'):
        if {r['label']>=2 for r in parts[name]} != {False,True}:
            raise ValueError(name+' requires both binary target classes')
    identical=defaultdict(list)
    for row in rows:
        identical[tuple(row['features'][f] for f in FEATURE_NAMES)].append(row)
    conflicts=[{'pair_ids':sorted(key(r) for r in group), 'labels':sorted({r['label'] for r in group})}
               for group in identical.values() if len({r['label'] for r in group})>1]
    constant=[f for f in FEATURE_NAMES if len({r['features'][f] for r in rows})==1]
    result={
        'rows':len(rows), 'companies':len({r['company_id'] for r in rows}),
        'events':len({r['event_id'] for r in rows}),
        'split_groups':len({r['split_group_id'] for r in rows}),
        'label_counts':dict(sorted(Counter(r['label'] for r in rows).items())),
        'origin_counts':dict(Counter(r['label_origin'] for r in rows)),
        'confidence_counts':dict(Counter(r['annotation_confidence'] for r in rows)),
        'constant_features':constant, 'identical_feature_conflicts':conflicts,
        'splits':{}, 'human_gold_available':False, 'financial_outcomes_available':False,
        'historical_backtest_valid':False,
        'warnings':[
            'AI annotations and AI evaluation are provisional; no independent quality measurement.',
            'Small curated news set and purposively selected companies; not a representative sample.',
            'Company and payment observation dates are unknown; historical point-in-time alignment is impossible.',
            'Each item is scored at its publication timestamp to hold freshness constant. Queries are constructed relevance baskets, not historical feeds.',
            'Repeated rate and food-price releases are correlated; pair count is not independent sample count.',
            'Broad OKVED and country OR-matching can overstate graph relevance; a payment does not establish a supply chain.',
            'AI subject annotations, numeric scenarios and suggested actions are not observed causal outcomes.',
            'Company holdout excludes labels; graph may contain held-out companies (not graph-isolated generalization).',
            'Constant features cannot be learned here; features_v1 omits fine product scope and actor eligibility.',
        ]}
    for name, part in parts.items():
        result['splits'][name]={'rows':len(part), 'events':len({r['event_id'] for r in part}),
            'companies':len({r['company_id'] for r in part}), 'labels':dict(sorted(Counter(r['label'] for r in part).items()))}
    return result


def build_bundle(database, curation_dir, output_dir, holdout_companies=()):
    curation, output = Path(curation_dir), Path(output_dir)
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError('Output directory must be empty; use a new version directory')
    events=read_json(curation/'events.json')
    companies=read_json(curation/'companies.json')
    annotations=read_jsonl(curation/'annotations.jsonl')
    snapshot=read_json(curation/'context_snapshot.json')
    validate_curation(events,companies,annotations)
    registry_path=curation/'research_registry.json'
    registry=read_json(registry_path) if registry_path.exists() else None
    if any('research' in a for a in annotations) and registry is None:
        raise ValueError('Research annotations require their source registry')
    if registry is not None:
        validate_research(annotations,events,registry)
    event_map={e['event_id']:e for e in events}
    profiles, graphs, rows=[],[],[]
    profile_map, graph_map={},{}
    with ContextStore(database) as store:
        metadata={'sources':store.metadata['sources'], 'revenue_unit':store.metadata['revenue_unit'],
                  'observation_date':None, 'payment_period':None}
        if ({name:s['sha256'] for name,s in metadata['sources'].items()} != snapshot['source_sha256']
                or metadata['revenue_unit'] != snapshot['revenue_unit']):
            raise ValueError('Company snapshot differs from annotation snapshot; re-annotate a new dataset version')
        for company in companies:
            uid=company['company_id']
            profile=store.get_company_profile(uid)
            # Build wall-clock is not an observation date or part of content identity.
            profile['provenance'].pop('snapshot_built_at',None)
            profile['provenance']['snapshot_identity']='sha256_of_original_source_files'
            profiles.append(profile); profile_map[uid]=profile
            graph=PaymentGraph(store,uid)
            for event in events:
                exposure=graph.exposure(event)
                graphs.append(exposure); graph_map[(uid,event['event_id'])]=exposure
        for annotation in annotations:
            uid,eid=annotation['company_id'],annotation['event_id']
            event,profile,graph=event_map[eid],profile_map[uid],graph_map[(uid,eid)]
            features=extract_features(profile,event,event['published_at'],graph)
            reason='ОКВЭД '+profile['industry']['okved_code']+'; '+profile['industry']['name']+'. '+annotation['explanation']
            rows.append({'pair_id':key(annotation), 'company_id':uid,'event_id':eid,
                'query_id':uid+'@constructed_relevance_basket_v1', 'split_group_id':event['split_group_id'],
                'published_at':event['published_at'],'as_of':event['published_at'],
                'feature_version':FEATURE_VERSION,'features':features['values'],
                'label':annotation['label'],'label_origin':annotation['label_origin'],
                'annotator':annotation['annotator'],'rubric_version':annotation['rubric_version'],
                'annotation_reason':reason, 'annotation_confidence':annotation['confidence'],
                'review_status':annotation['review_status'], 'profile_snapshot_date':None,
                'context_refs':{'profile_id':uid,'event_id':eid,'graph_pair_id':key(annotation)},
                'profile_sha256':digest(profile),'event_sha256':digest(event),'graph_sha256':digest(graph)})
            if registry is not None:
                rows[-1].update({field:annotation[field] for field in ROW_FIELDS})
    if registry is not None:
        validate_research(annotations,events,registry,profile_map)
    rows.sort(key=lambda r:(r['published_at'],r['event_id'],r['company_id']))
    parts=partition(rows,holdout_companies)
    audit=audit_rows(rows,parts)
    audit['publishers']=dict(Counter(e['sources'][0]['publisher'] for e in events))
    audit['sectors']=dict(Counter(p['industry']['okved_division'] for p in profiles))
    audit['source_verification']=dict(Counter(e['sources'][0]['verification_method'] for e in events))
    if registry is not None:
        audit['research']={'protocol':registry['protocol'],
            'sources_by_kind':dict(Counter(s['source_kind'] for s in registry['sources'])),
            'priority_changed':sum(a['label']!=a['prior_label'] for a in annotations),
            'eligible_rows':sum(a['training_eligible'] for a in annotations),
            'quarantined_rows':sum(not a['training_eligible'] for a in annotations),
            'exclusion_reasons':dict(Counter(reason for a in annotations for reason in a['exclusion_reasons'])),
            'independent_expert_reviews':0,'causal_company_estimates':0}
        audit['research']['eligible_splits']={name:{
            'rows':sum(r['training_eligible'] for r in part),
            'events':len({r['event_id'] for r in part if r['training_eligible']}),
            'labels':dict(Counter(r['label'] for r in part if r['training_eligible']))}
            for name,part in parts.items()}
    where={key(r):name for name,part in parts.items() for r in part}
    for row in rows:
        row['dataset_split']=where[key(row)]
    split_manifest={'method':'chronological_whole_policy_clusters_60_20_20',
        'group_timestamp':'latest publication in policy cluster', 'holdout_companies':sorted(holdout_companies),
        'parts':{name:[key(r) for r in part] for name,part in parts.items()},
        'test_is_human_gold':False, 'refit_policy':'train CLI refits on train+validation after tuning; test stays excluded'}
    conflict_ids={pid for group in audit['identical_feature_conflicts'] for pid in group['pair_ids']}
    queue=[]
    blind=[]
    for row in rows:
        flags=[]
        if where[key(row)] in {'test','unseen_company_test'}:flags.append('held_out_evaluation')
        if key(row) in conflict_ids:flags.append('same_features_different_judgments')
        if row['annotation_confidence']=='low':flags.append('low_confidence')
        if event_map[row['event_id']]['sources'][0]['verification_method']!='primary_page':flags.append('verify_source_page')
        if row['label']==3:flags.append('high_priority_label')
        if registry is not None and not row['training_eligible']:flags.append('quarantined')
        item={'pair_id':key(row),'company_id':row['company_id'],'event_id':row['event_id'],
              'split':where[key(row)],'profile_sha256':row['profile_sha256'],'event_sha256':row['event_sha256'],
              'human_label':None,'reviewer_id':None,'reviewed_at':None,'reason':None,
              'review_mode':'blinded','label_origin':None}
        blind.append(item)
        queue.append(dict(item, review_flags=flags,proposed_ai_label=row['label'],
                          proposed_reason=row['annotation_reason'],review_mode='assisted'))
    queue.sort(key=lambda r:(r['split'] not in {'test','unseen_company_test'},-len(r['review_flags']),r['pair_id']))
    output.mkdir(parents=True,exist_ok=True)
    write_json(output/'events.json',events)
    write_json(output/'source_registry.json',[
        {'event_id':e['event_id'],'publication_date':e['publication_date'],
         'url':s['url'],'publisher':s['publisher'],'accessed_on':s['accessed_on'],
         'verification_method':s['verification_method'],'paraphrase_sha256':digest(s['excerpt']),
         'raw_article_redistributed':False,'reuse_license':'not_asserted; source terms apply'}
        for e in events for s in e['sources']])
    write_jsonl(output/'profiles.jsonl',profiles)
    write_jsonl(output/'graph_evidence.jsonl',graphs)
    write_jsonl(output/'all.jsonl',rows)
    write_jsonl(output/'analysis_targets.jsonl',annotations)
    if registry is not None:
        write_json(output/'research_registry.json',registry)
        write_jsonl(output/'eligible.jsonl',[r for r in rows if r['training_eligible']])
        write_jsonl(output/'quarantine.jsonl',[r for r in rows if not r['training_eligible']])
        write_jsonl(output/'revision_log.jsonl',[
            {'pair_id':key(a),'prior_label':a['prior_label'],'label':a['label'],
             'priority_changed':a['label']!=a['prior_label'],'revision_reason':a['revision_reason'],
             'training_eligible':a['training_eligible'],'exclusion_reasons':a['exclusion_reasons']}
            for a in annotations])
    for name,part in parts.items():write_jsonl(output/(name+'.jsonl'),part)
    write_jsonl(output/'review_queue.jsonl',queue)
    write_jsonl(output/'blind_review.jsonl',blind)
    write_json(output/'split_manifest.json',split_manifest)
    write_json(output/'audit.json',audit)
    manifest={'format':FORMAT,'annotation_origins':sorted({a['label_origin'] for a in annotations}),'model_trained':False,
              'source_snapshot':metadata, 'annotation_protocol':'relevance-v1',
              'curation_sha256':{name:hashlib.sha256((curation/name).read_bytes()).hexdigest()
                                  for name in ('events.json','companies.json','annotations.jsonl','context_snapshot.json')},
              'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(output.iterdir()) if p.is_file()}}
    if registry is not None:
        manifest['annotation_protocol']=registry['protocol']
        manifest['curation_sha256']['research_registry.json']=hashlib.sha256(registry_path.read_bytes()).hexdigest()
    write_json(output/'manifest.json',manifest)
    return audit


def verify_bundle(directory):
    directory=Path(directory)
    manifest=read_json(directory/'manifest.json')
    if manifest.get('format')!=FORMAT:raise ValueError('Unsupported dataset format')
    for name,expected in manifest['files'].items():
        if Path(name).name!=name:raise ValueError('Manifest paths must be basenames')
        if hashlib.sha256((directory/name).read_bytes()).hexdigest()!=expected:
            raise ValueError('Checksum mismatch: '+name)
    rows=read_jsonl(directory/'all.jsonl')
    parts={name:read_jsonl(directory/(name+'.jsonl')) for name in PARTS}
    audit=audit_rows(rows,parts)
    canonical={key(r):r for r in rows}
    for part in parts.values():
        for row in part:
            if row!=canonical[key(row)]:raise ValueError('Split row differs from canonical row')
    split_manifest=read_json(directory/'split_manifest.json')
    expected_parts=partition(rows,split_manifest['holdout_companies'])
    if parts!=expected_parts:raise ValueError('Split does not match frozen temporal policy')
    if split_manifest['parts']!={name:[key(r) for r in part] for name,part in parts.items()}:
        raise ValueError('Split manifest differs from split files')
    if any(r.get('dataset_split')!=name for name,part in parts.items() for r in part):
        raise ValueError('Frozen split field differs from split file')
    profiles={p['company_id']:p for p in read_jsonl(directory/'profiles.jsonl')}
    events={e['event_id']:e for e in read_json(directory/'events.json')}
    graphs={key(g):g for g in read_jsonl(directory/'graph_evidence.jsonl')}
    annotations=read_jsonl(directory/'analysis_targets.jsonl')
    validate_curation(list(events.values()),[{'company_id':uid} for uid in profiles],annotations)
    labels={key(a):a for a in annotations}
    research=any('research' in a for a in annotations)
    if research:
        registry=read_json(directory/'research_registry.json')
        validate_research(annotations,list(events.values()),registry,profiles)
        if manifest.get('annotation_protocol')!=registry['protocol']:
            raise ValueError('Evidence protocol differs from manifest')
        for filename,eligible in [('eligible.jsonl',True),('quarantine.jsonl',False)]:
            if read_jsonl(directory/filename)!=[r for r in rows if r.get('training_eligible') is eligible]:
                raise ValueError('Eligibility export differs from canonical rows')
    for row in rows:
        p,e,g=profiles[row['company_id']],events[row['event_id']],graphs[key(row)]
        if (digest(p),digest(e),digest(g))!=(row['profile_sha256'],row['event_sha256'],row['graph_sha256']):
            raise ValueError('Evidence hash mismatch')
        if extract_features(p,e,row['as_of'],g)['values']!=row['features']:
            raise ValueError('Features differ from frozen evidence')
        if row['label']!=labels[key(row)]['label'] or row['label_origin']!=labels[key(row)]['label_origin']:
            raise ValueError('Training label differs from annotation')
        if research and any(row.get(field)!=labels[key(row)][field] for field in ROW_FIELDS):
            raise ValueError('Training research metadata differs from annotation')
    return {'status':'passed','rows':audit['rows'],'events':audit['events'],'companies':audit['companies']}


def import_reviews(bundle, reviews_path, output):
    """Export only explicitly human-reviewed rows; never relabel untouched AI rows."""
    verify_bundle(bundle)
    canonical={key(r):r for r in read_jsonl(Path(bundle)/'all.jsonl')}
    reviews=read_jsonl(reviews_path)
    result=[]; seen=set()
    for review in reviews:
        pid=review.get('pair_id')
        if pid not in canonical or pid in seen:raise ValueError('Unknown/duplicate review pair')
        seen.add(pid)
        if review.get('human_label') is None:continue
        if type(review['human_label']) is not int or review['human_label'] not in range(4):
            raise ValueError('Human label must be an integer 0..3')
        for field in ('reviewer_id','reason'):text(review.get(field),field)
        timestamp(review.get('reviewed_at'))
        if review.get('label_origin')!='human':raise ValueError('Explicit human origin is required')
        if review.get('review_mode') not in {'blinded','assisted'}:raise ValueError('Invalid review mode')
        original=canonical[pid]
        for field in ('profile_sha256','event_sha256'):
            if review.get(field)!=original[field]:raise ValueError('Review refers to changed evidence')
        result.append(dict(original,label=review['human_label'],label_origin='human',
                           annotator=review['reviewer_id'],annotation_reason=review['reason'],
                           review_status='human_reviewed',review_mode=review['review_mode'],
                           reviewed_at=review['reviewed_at'],prior_ai_label=original['label']))
    if not result:raise ValueError('No completed human reviews')
    destination=Path(output)
    if destination.exists() or Path(bundle).resolve() in destination.resolve().parents:
        raise ValueError('Write human reviews to a new file outside the frozen bundle')
    destination.parent.mkdir(parents=True,exist_ok=True)
    write_jsonl(destination,result)
    return {'human_rows':len(result),'pending_rows':len(reviews)-len(result)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    build=commands.add_parser('build')
    build.add_argument('--database',required=True)
    build.add_argument('--curation',required=True)
    build.add_argument('--output-dir',required=True)
    build.add_argument('--holdout-companies',nargs='*',default=[])
    verify=commands.add_parser('verify');verify.add_argument('--bundle',required=True)
    review=commands.add_parser('import-reviews')
    review.add_argument('--bundle',required=True)
    review.add_argument('--reviews',required=True)
    review.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        if args.command=='build':
            result=build_bundle(args.database,args.curation,args.output_dir,args.holdout_companies)
        elif args.command=='verify':result=verify_bundle(args.bundle)
        else:result=import_reviews(args.bundle,args.reviews,args.output)
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error) as error:
        parser.exit(2,'Error: '+str(error)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
