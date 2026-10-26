"""Contracts for research-grounded AI labels, not a causal estimator.

Checks are offline provenance/consistency checks. They cannot establish whether a
paper is correct or an annotation agrees with independent experts.
"""

PROTOCOL = 'relevance-evidence-v2'
ROW_FIELDS = ('research', 'training_eligible', 'exclusion_reasons', 'prior_label', 'revision_reason')
OUTCOME_UNKNOWN = {'direction': 'unknown', 'magnitude': None, 'horizon_days': None,
                   'status': 'not_identified', 'causal_estimate_available': False}


def validate_registry(registry):
    if registry.get('protocol') != PROTOCOL:
        raise ValueError('Unsupported evidence protocol')
    sources = registry.get('sources', [])
    ids = set()
    for source in sources:
        sid = source.get('source_id')
        if not isinstance(sid, str) or not sid or sid in ids:
            raise ValueError('Duplicate/empty evidence source ID')
        ids.add(sid)
        for field in ('title', 'publisher', 'source_kind', 'review_depth', 'locator',
                      'supported_claim', 'limitations', 'verified_on'):
            if not isinstance(source.get(field), str) or not source[field].strip():
                raise ValueError('Missing source field: '+field)
        if not source.get('url', '').startswith(('https://', 'http://')):
            raise ValueError('Evidence source URL required')
        if source.get('access_status') not in {'primary_content_read', 'search_extract_only'}:
            raise ValueError('Invalid evidence access status')
        if source['source_kind'] == 'peer_reviewed_article' and not source.get('doi'):
            raise ValueError('Journal evidence requires a verified DOI')
    if not ids:
        raise ValueError('Empty evidence registry')
    action_ids=set()
    for action in registry.get('action_candidates', []):
        aid=action.get('action_id')
        if not isinstance(aid,str) or not aid or aid in action_ids:
            raise ValueError('Missing/duplicate action candidate')
        action_ids.add(aid)
        if (not action.get('source_ids') or set(action['source_ids'])-ids
                or action.get('effectiveness') is not None
                or action.get('evidence_role')!='mechanism_only_not_validated_action_effect'
                or action.get('must_include_no_action') is not True):
            raise ValueError('Action candidates require sources and must not invent effectiveness')
        for field in ('required_data','costs_and_risks'):
            if not isinstance(action.get(field),list) or not action[field]:
                raise ValueError('Action candidates require data and cost constraints')
    return {s['source_id']: s for s in sources}


def validate_research(annotations, events, registry, profiles=None):
    sources = validate_registry(registry)
    event_map = {e['event_id']: e for e in events}
    action_ids={a['action_id'] for a in registry.get('action_candidates',[])}
    for row in annotations:
        research = row.get('research', {})
        if research.get('protocol') != PROTOCOL:
            raise ValueError('Research metadata required on every annotation')
        if row.get('label_origin') != 'ai' or row.get('review_status') != 'research_grounded_ai_unreviewed':
            raise ValueError('Research revision must not impersonate an independent expert')
        if research.get('outcome') != OUTCOME_UNKNOWN:
            raise ValueError('No observed outcome or company causal effect is available in this dataset')
        if research.get('action_effectiveness') is not None:
            raise ValueError('Action effectiveness must remain unknown')
        if set(research.get('candidate_action_ids',[]))-action_ids:
            raise ValueError('Unknown action candidate reference')
        if research.get('priority_semantics') != 'attention_priority_not_loss_or_effect_probability':
            raise ValueError('Priority is not an impact estimate')
        claims = research.get('citations', [])
        if not claims or len({c['source_id'] for c in claims}) != len(claims):
            raise ValueError('Missing/duplicate research citations')
        for claim in claims:
            if claim.get('source_id') not in sources:
                raise ValueError('Unknown evidence source reference')
            if claim.get('role') not in {'event_fact', 'mechanism', 'measurement_limit', 'context_only'}:
                raise ValueError('Unknown citation role')
            # A statistical paper supplies a mechanism, never the fact of a new regulation.
            if claim['role'] == 'event_fact' and sources[claim['source_id']]['source_kind'] != 'event_primary_source':
                raise ValueError('Event fact requires the actual news source')
        fact_ids = [c['source_id'] for c in claims if c['role'] == 'event_fact']
        if fact_ids != ['N:'+row['event_id']]:
            raise ValueError('Event citation must identify this event')
        event = event_map[row['event_id']]
        source = sources[fact_ids[0]]
        if source['url'] not in {s['url'] for s in event['sources']}:
            raise ValueError('Event citation URL differs from frozen news evidence')
        if type(row.get('training_eligible')) is not bool:
            raise ValueError('Explicit training eligibility required')
        reasons = row.get('exclusion_reasons')
        if not isinstance(reasons, list) or any(not isinstance(r, str) or not r for r in reasons):
            raise ValueError('Explicit exclusion reasons required')
        expected = []
        if any(s['verification_method'] != 'primary_page' for s in event['sources']):
            expected.append('news_source_not_fully_read')
        if source['access_status'] != 'primary_content_read' and 'news_source_not_fully_read' not in expected:
            expected.append('news_source_not_fully_read')
        if row['confidence'] == 'low':
            expected.append('conditional_or_weak_exposure')
        if reasons != expected or row['training_eligible'] != (not expected):
            raise ValueError('Eligibility differs from source/exposure policy')
        if type(row.get('prior_label')) is not int or row['prior_label'] not in range(4):
            raise ValueError('Prior label required for revision audit')
        if not row.get('revision_reason'):
            raise ValueError('Revision reason is required even when priority is unchanged')
        if row['label'] == 3:
            raise ValueError('No verified urgent company-specific exposure supports label 3 in this revision')
        if research.get('applicability') not in {'observed_channel_missing_parameters', 'conditional', 'not_established'}:
            raise ValueError('Unknown applicability status')
        evidence = research.get('profile_facts')
        if not isinstance(evidence, dict) or not evidence:
            raise ValueError('Observed profile facts required')
        if profiles is not None:
            profile = profiles[row['company_id']]
            for path, value in evidence.items():
                actual = profile
                for part in path.split('.'):
                    actual = actual[part]
                if value != actual:
                    raise ValueError('Claimed exposure differs from company profile: '+path)


def assert_training_eligible(rows):
    """Fail closed for v2 quarantine; v1 and independent human fixtures still work."""
    for row in rows:
        if row.get('training_eligible') is False:
            raise ValueError('Quarantined row: use the reviewed eligible.jsonl export, not all.jsonl')
        if row.get('rubric_version') == PROTOCOL and row.get('training_eligible') is not True:
            raise ValueError('Research training rows require explicit eligibility')
