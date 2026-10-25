import copy
import json

import pytest
from fastapi.testclient import TestClient
from integration.app import create_app
from integration.contracts import ROOT
from integration.learning import Learning, encoded, informative, partition
from news_analysis.features import FEATURE_NAMES, FEATURE_VERSION


def group_names(split, count, prefix='event'):
    return [f'{prefix}-{i}' for i in range(10000) if partition(f'{prefix}-{i}') == split][:count]


def row(company, event, positive, baseline_good=False):
    features = dict.fromkeys(FEATURE_NAMES, 0.0)
    features['industry_match'] = float(positive if baseline_good else not positive)
    features['industry_unknown'] = float(not positive if baseline_good else positive)
    return {'company_id': company, 'event_id': event, 'query_id': company+'@2026-10-23T00:00:00Z',
            'as_of': '2026-10-23T00:00:00Z', 'published_at': '2026-10-22T00:00:00Z',
            'feature_version': FEATURE_VERSION, 'features': features, 'is_mock': False,
            'split_group_id': event}


def seed(learning, baseline_good=False, prefix='event'):
    # Synthetic TEST mechanics only. These are never exported as real human feedback.
    for split in ('train', 'validation', 'gate'):
        positive, negative = group_names(split, 2, prefix)
        for index in range(6):
            company = 'test-company-'+str(index)
            rows = [row(company, positive, True, baseline_good), row(company, negative, False, baseline_good)]
            key = split+'-'+company+'-'+prefix
            learning.capture(key, company, rows, {'items': [{'event_id': r['event_id']} for r in rows]}, 'baseline')
            learning.feedback({'ranking_id': key, 'company_id': company,
                'ratings': [{'event_id': r['event_id'], 'policy_group_id': r['event_id'],
                             'label': 2 if n == 0 else 0, 'reason': 'Test fixture only', 'source_reviewed': True}
                            for n,r in enumerate(rows)]}, 'test-reviewer')


@pytest.fixture
def learning(tmp_path):
    return Learning(tmp_path/'registry.sqlite3', min_train=10, min_validation=10, min_gate=10,
                    min_queries=3, min_gate_groups=2, min_gain=.01)


def test_promotes_better_model_reloads_without_restart_and_can_rollback(learning):
    assert learning.model() is None
    seed(learning)
    report = learning.run()
    assert report['status'] == 'promoted', report
    assert len(report['validation_candidates']) == 8
    model = learning.model()
    assert model.metadata['label_origin'] == 'human'
    assert model.predict(row('c','e',True)['features']) > model.predict(row('c','e',False)['features'])
    assert set(model.metadata['fit_event_groups']).isdisjoint(report['gate']['event_groups'])
    # A second service process sees the registry swap; no restart/retraining required.
    reader = Learning(learning.path)
    assert reader.model().metadata['registry_version'] == report['run_id']
    assert learning.run()['status'] == 'waiting'  # gate is not reused
    learning.rollback('baseline')
    assert reader.model() is None
    assert learning.run()['status'] == 'paused'
    assert learning.status()['paused']
    learning.rollback(report['run_id'])
    assert reader.model().metadata['registry_version'] == report['run_id']


def test_rejects_non_improvement_and_consumes_gate(learning):
    seed(learning, baseline_good=True)
    result = learning.run()
    assert result['status'] == 'rejected'
    assert learning.model() is None
    assert learning.status()['consumed_gate_groups'] == 2
    assert learning.run()['status'] == 'waiting'
    with pytest.raises(ValueError, match='previously promoted'):
        learning.rollback(result['run_id'])


def test_waits_for_real_ratings_and_singletons_cannot_pass_gate(learning):
    assert learning.run()['status'] == 'waiting'
    assert informative([dict(row('x','e',True), label=2)]) == []
    assert learning.status()['active_version'] == 'baseline'


def test_rating_duplicate_conflict_group_drift_and_cross_company_are_rejected(learning):
    example = row('company','event',True)
    learning.capture('request', 'company', [example], {'items': [{'event_id': 'event'}]}, 'baseline')
    rating = {'event_id': 'event', 'policy_group_id': 'event', 'label': 2, 'reason': 'Reason', 'source_reviewed': True}
    body = {'ranking_id': 'request', 'company_id': 'company', 'ratings': [rating]}
    assert learning.feedback(body, 'reviewer')['accepted'] == 1
    assert learning.feedback(body, 'reviewer')['duplicates'] == 1
    for mutate in (lambda b: b.update(company_id='other'),
                   lambda b: b['ratings'][0].update(event_id='unknown'),
                   lambda b: b['ratings'][0].update(label=0),
                   lambda b: b['ratings'][0].update(policy_group_id='other'),
                   lambda b: b['ratings'][0].update(source_reviewed=False)):
        bad = copy.deepcopy(body); mutate(bad)
        with pytest.raises(ValueError):
            learning.feedback(bad, 'reviewer')
    assert sum(learning.status()['labels'].values()) == 1


def test_synthetic_events_and_reused_request_id_cannot_contaminate_dataset(learning):
    example = dict(row('company','event',True), is_mock=True)
    learning.capture('request', 'company', [example], {'items': [{'event_id': 'event'}]}, 'baseline')
    with pytest.raises(ValueError, match='Synthetic'):
        learning.feedback({'ranking_id': 'request', 'company_id': 'company', 'ratings': [
            {'event_id':'event','policy_group_id':'event','label':2,'reason':'Reason','source_reviewed':True}]}, 'reviewer')
    with pytest.raises(ValueError, match='already used'):
        learning.capture('request', 'other', [row('other','event',False)], {'items':[{'event_id':'event'}]}, 'baseline')


def test_failed_training_preserves_active_model_and_releases_run_lock(learning, monkeypatch):
    seed(learning)
    def fail(*args, **kwargs):
        raise RuntimeError('Interrupted optimizer')
    monkeypatch.setattr('integration.learning.fit', fail)
    with pytest.raises(RuntimeError):
        learning.run()
    assert learning.status()['active_version'] == 'baseline'
    assert learning.status()['last_run']['status'] == 'failed'
    with learning.db() as db:
        assert not db.execute("SELECT 1 FROM runs WHERE status='running'").fetchone()


def test_cross_process_training_lock(learning):
    with learning.db() as db:
        db.execute('INSERT INTO runs VALUES(?,?,?,?)', ('external','running','{}',1))
    assert Learning(learning.path).run()['status'] == 'busy'


def test_ai_rows_fail_closed(learning):
    example = dict(row('c','event',True), label=2, label_origin='ai', annotator='llm',
                   rubric_version='ai', annotation_reason='AI judgment', dataset_split=partition('event'))
    with learning.db() as db:
        db.execute('INSERT INTO labels(pair,event_group,split,row_json) VALUES(?,?,?,?)',
                   ('ai', 'event', example['dataset_split'], encoded(example)))
    with pytest.raises(ValueError, match='Only human'):
        learning.run()
    assert learning.model() is None


def test_learning_http_auth_snapshot_and_strict_contract(tmp_path, monkeypatch):
    from company_context import build_database
    fixtures = ROOT/'tests/fixtures/company_context'
    database = tmp_path/'context.sqlite3'
    build_database(fixtures/'companies.csv', database, links=fixtures/'links.csv', payments=fixtures/'payments.csv')
    monkeypatch.setenv('CONTEXT_DB', str(database))
    monkeypatch.setenv('CONTEXT_MODE', 'existing')
    monkeypatch.setenv('RANK_MODE', 'news-analysis')
    monkeypatch.setenv('NEWS_MODULE_PATH', str(ROOT))
    monkeypatch.delenv('RANK_MODEL_PATH', raising=False)
    monkeypatch.setenv('LEARNING_ENABLED', '1')
    monkeypatch.setenv('LEARNING_TOKEN', 'test-token-'+'x'*32)
    monkeypatch.setenv('LEARNING_DB', str(tmp_path/'registry.sqlite3'))
    headers = {'X-Learning-Token':'test-token-'+'x'*32}
    with TestClient(create_app()) as client:
        assert client.get('/learning').status_code == 200
        assert client.get('/v1/learning/status').status_code == 403
        assert client.get('/v1/learning/status', headers=headers).status_code == 200
        request = json.loads((ROOT/'contracts/v1/examples/rank-request.json').read_text(encoding="utf-8"))
        # Unmark only within this TEST fixture to exercise acceptance. Production data must be real.
        for event in request['events']:
            event['is_mock'] = False
            event['split_group_id'] = 'test-policy'
        response = client.post('/v1/rank', json=request).json()
        event = response['data']['items'][0]
        body = {'ranking_id': response['data']['feedback_id'], 'company_id':request['company_id'],
                'ratings': [{'event_id':event['event_id'],'policy_group_id':'test-policy','label':2,
                             'reason':'Test only', 'source_reviewed':True}]}
        assert client.post('/v1/learning/feedback', json=body).status_code == 403
        assert client.post('/v1/learning/feedback', headers=headers, json=body).json()['data']['accepted'] == 1
        body['ratings'][0]['label'] = True
        assert client.post('/v1/learning/feedback', headers=headers, json=body).status_code == 422


def test_learning_disabled_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv('LEARNING_ENABLED', raising=False)
    monkeypatch.setenv('CONTEXT_DB', str(tmp_path/'db.sqlite3'))
    monkeypatch.setenv('CONTEXT_MODE', 'fixture')
    monkeypatch.setenv('RANK_MODE', 'mock')
    with TestClient(create_app()) as client:
        assert client.get('/v1/learning/status').status_code == 404


def test_rollback_during_training_cannot_be_overwritten(learning, monkeypatch):
    from integration.learning import fit as original_fit
    seed(learning)
    changed = False
    def fit_and_rollback(*args, **kwargs):
        nonlocal changed
        if not changed:
            changed = True
            learning.rollback('baseline')
        return original_fit(*args, **kwargs)
    monkeypatch.setattr('integration.learning.fit', fit_and_rollback)
    assert learning.run()['status'] == 'superseded'
    assert learning.status()['active_version'] == 'baseline'
    assert learning.status()['paused'] is True


def test_expired_snapshot_is_rejected_even_without_new_rank_requests(learning):
    example = row('company','event',True)
    learning.capture('expired','company',[example],{'items':[{'event_id':'event'}]},'baseline')
    with learning.db() as db:
        db.execute('UPDATE exposures SET created=0')
    with pytest.raises(ValueError, match='expired'):
        learning.feedback({'ranking_id':'expired','company_id':'company','ratings':[
            {'event_id':'event','policy_group_id':'event','label':2,'reason':'Reason','source_reviewed':True}]}, 'reviewer')
    assert sum(learning.status()['labels'].values()) == 0
