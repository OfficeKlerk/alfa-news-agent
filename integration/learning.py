"""Local, human-supervised batch learning. SQLite is the atomic model registry.

No clicks, LLM judgments, or model predictions are converted to human labels.
The permanently reserved gate stream is consumed once per policy group.
"""
import hashlib
import json
import math
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from news_analysis.features import baseline_score, feature_names
from news_analysis.contracts import finite
from news_analysis.evidence import assert_training_eligible
from news_analysis.ranking import LogisticRanker, evaluate, fit, sigmoid, validate_rows, vector


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def partition(group):
    # Stable across processes, restarts, companies and queries. Never use hash().
    bucket = int(hashlib.sha256(('learning-v1:' + group).encode()).hexdigest()[:8], 16) % 100
    return 'train' if bucket < 70 else 'validation' if bucket < 85 else 'gate'


def informative(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[row['query_id']].append(row)
    # Singleton requests cannot demonstrate ranking quality.
    return [r for group in groups.values() if len(group) >= 2
            and {r['label'] >= 2 for r in group} == {False, True} for r in group]


def pairwise_fit(rows, l2, iterations=200):
    """RankNet-style pairwise logistic loss on within-query label preferences."""
    version = validate_rows(rows)
    assert_training_eligible(rows)
    finite(l2, 'l2', 0)
    if isinstance(iterations, bool) or not isinstance(iterations, int) or not 1 <= iterations <= 10000:
        raise ValueError('iterations must be 1..10000')
    groups = defaultdict(list)
    for row in rows:
        groups[row['query_id']].append(row)
    def differences(group):
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if a['label'] == b['label']:
                    continue
                high, low = (a, b) if a['label'] > b['label'] else (b, a)
                yield [x - y for x, y in zip(vector(high['features'], version), vector(low['features'], version))]
    queue = deque((query, differences(sorted(groups[query], key=lambda r: r['event_id']))) for query in sorted(groups)
                  if len({row['label'] for row in groups[query]}) > 1)
    if len(queue) > 5000:
        raise ValueError('Pair budget cannot cover every informative query; split the training batch explicitly')
    pairs, pair_queries = [], set()
    # A large first query must not spend the entire budget before other
    # companies contribute any preference. Keep deterministic bounded memory.
    while queue and len(pairs) < 5000:
        query, iterator = queue.popleft()
        try:
            pairs.append(next(iterator))
        except StopIteration:
            continue
        pair_queries.add(query)
        queue.append((query, iterator))
    if not pairs:
        raise ValueError('Pairwise training requires different labels within queries')
    weights = [0.0] * len(feature_names(version))
    # ||x_high-x_low||² <= d, loss gradient Lipschitz <= d/4 + l2.
    step = 1 / (len(weights) / 4 + l2)
    for _ in range(iterations):
        gradient = [l2 * w for w in weights]
        for difference in pairs:
            error = sigmoid(sum(w*x for w, x in zip(weights, difference))) - 1
            for i, value in enumerate(difference):
                gradient[i] += error * value / len(pairs)
        weights = [w - step * g for w, g in zip(weights, gradient)]
    return LogisticRanker(weights, 0.0, {'algorithm': 'pairwise_logistic', 'l2': l2,
                                       'iterations': iterations, 'pairs': len(pairs), 'queries': len(pair_queries),
                                       'pair_sampling': 'round_robin_queries_limit_5000'}, feature_version=version)


class Learning:
    def __init__(self, database, *, min_train=60, min_validation=20, min_gate=20,
                 min_queries=10, min_gate_groups=10, min_gain=0.01, max_rows=2000):
        self.path = Path(database)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.min_train, self.min_validation, self.min_gate = min_train, min_validation, min_gate
        self.min_queries, self.min_gain, self.max_rows = min_queries, min_gain, max_rows
        self.min_gate_groups = min_gate_groups
        self._cache = (None, None)
        with self.db() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT OR IGNORE INTO state VALUES('active', 'baseline');
            INSERT OR IGNORE INTO state VALUES('paused', '0');
            CREATE TABLE IF NOT EXISTS exposures(
                id TEXT PRIMARY KEY, company TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS labels(
                id INTEGER PRIMARY KEY AUTOINCREMENT, pair TEXT UNIQUE NOT NULL,
                event_group TEXT NOT NULL, split TEXT NOT NULL, row_json TEXT NOT NULL, query_id TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS labels_split_query ON labels(split,query_id);
            CREATE INDEX IF NOT EXISTS labels_group ON labels(event_group);
            CREATE INDEX IF NOT EXISTS exposures_created ON exposures(created);
            CREATE TABLE IF NOT EXISTS event_groups(event TEXT PRIMARY KEY, policy_group TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS consumed_groups(name TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS models(
                id TEXT PRIMARY KEY, artifact TEXT NOT NULL, report TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(
                id TEXT PRIMARY KEY, status TEXT NOT NULL, report TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, action TEXT, value TEXT, created REAL);
            ''')

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def model(self):
        with self.db() as db:
            version = db.execute("SELECT value FROM state WHERE key='active'").fetchone()[0]
            if version == 'baseline':
                return None
            cached_version, cached_model = self._cache
            if version != cached_version:
                raw = db.execute('SELECT artifact FROM models WHERE id=?', (version,)).fetchone()
                model = LogisticRanker.from_dict(json.loads(raw[0]))
                # Return a local immutable reference even if another reader refreshes cache.
                self._cache = (version, model)
                return model
            return cached_model

    def capture(self, exposure_id, company, rows, ranked, model_version):
        shown = {item['event_id'] for item in ranked['items']}
        rows = [r for r in rows if r['event_id'] in shown]
        versions = {row.get('feature_version') for row in rows}
        if len(versions) > 1:
            raise ValueError('One ranking snapshot cannot mix feature versions')
        for row in rows:
            vector(row['features'], row.get('feature_version'))
            feature_names(row.get('feature_version'))
            row['label_origin'] = 'human'
            row['query_id'] = company + '@' + row['as_of']
        payload = encoded({'rows': rows, 'model_version': model_version})
        with self.db() as db:
            old = db.execute('SELECT payload FROM exposures WHERE id=?', (exposure_id,)).fetchone()
            if old and old[0] != payload:
                raise ValueError('Ranking ID already used for a different snapshot')
            db.execute('INSERT OR IGNORE INTO exposures VALUES(?,?,?,?)',
                       (exposure_id, company, payload, time.time()))
            db.execute('DELETE FROM exposures WHERE id IN (SELECT id FROM exposures ORDER BY created DESC LIMIT -1 OFFSET 3000)')
            # Pending exposures expire; accepted labels and model audit remain durable.
            db.execute('DELETE FROM exposures WHERE created < ?', (time.time() - 30*86400,))

    def feedback(self, body, reviewer):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            snapshot = db.execute('SELECT * FROM exposures WHERE id=? AND company=?',
                                  (body['ranking_id'], body['company_id'])).fetchone()
            if snapshot is None or snapshot['created'] < time.time() - 30*86400:
                raise ValueError('Ranking not found for company, or expired after 30 days')
            rows = {r['event_id']: r for r in json.loads(snapshot['payload'])['rows']}
            if len({x['event_id'] for x in body['ratings']}) != len(body['ratings']):
                raise ValueError('Duplicate event in feedback')
            accepted = 0
            for rating in body['ratings']:
                if rating['event_id'] not in rows:
                    raise ValueError('Only displayed, non-future events can be rated')
                row = dict(rows[rating['event_id']])
                if row.pop('is_mock', False):
                    raise ValueError('Synthetic events cannot enter the human learning dataset')
                group = rating['policy_group_id']
                if group != row['split_group_id'] or rating.get('source_reviewed') is not True:
                    raise ValueError('Confirm the captured policy group and review news source before rating')
                old = db.execute('SELECT policy_group FROM event_groups WHERE event=?', (row['event_id'],)).fetchone()
                if old and old[0] != group:
                    raise ValueError('An event cannot change policy group after its first rating')
                db.execute('INSERT OR IGNORE INTO event_groups VALUES(?,?)', (row['event_id'], group))
                row.update(label=rating['label'], annotation_reason=rating['reason'], annotator=reviewer,
                           rubric_version='human-feedback-v1', source_reviewed=True, split_group_id=group,
                           dataset_split=partition(group), label_origin='human')
                validate_rows([row])
                pair = encoded([row['company_id'], row['event_id'], row['as_of']])
                previous = db.execute('SELECT row_json FROM labels WHERE pair=?', (pair,)).fetchone()
                if previous and json.loads(previous[0]) != row:
                    raise ValueError('Rating is immutable; conflicting duplicate requires offline adjudication')
                accepted += db.execute('INSERT OR IGNORE INTO labels(pair,event_group,split,row_json,query_id) VALUES(?,?,?,?,?)',
                                       (pair, group, partition(group), encoded(row), row['query_id'])).rowcount
            return {'accepted': accepted, 'duplicates': len(body['ratings']) - accepted}

    def status(self):
        with self.db() as db:
            counts = {key: 0 for key in ('train', 'validation', 'gate')}
            for row in db.execute('SELECT split,count(*) AS n FROM labels GROUP BY split'):
                counts[row['split']] = row['n']
            versions = defaultdict(int)
            for row in db.execute('SELECT row_json FROM labels'):
                versions[json.loads(row[0]).get('feature_version', 'unknown')] += 1
            active = db.execute("SELECT value FROM state WHERE key='active'").fetchone()[0]
            last = db.execute('SELECT report FROM runs ORDER BY created DESC LIMIT 1').fetchone()
            return {'active_version': active, 'paused': db.execute("SELECT value FROM state WHERE key='paused'").fetchone()[0] == '1', 'labels': counts,
                    'consumed_gate_groups': db.execute('SELECT count(*) FROM consumed_groups').fetchone()[0],
                    'last_run': json.loads(last[0]) if last else None, 'feature_versions': dict(versions),
                    'thresholds': {'train_rows': self.min_train, 'validation_rows': self.min_validation,
                                   'fresh_gate_rows': self.min_gate, 'gate_queries': self.min_queries, 'gate_groups': self.min_gate_groups,
                                   'ndcg_gain': self.min_gain}}

    def rollback(self, version):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if version != 'baseline':
                registered = db.execute('SELECT report FROM models WHERE id=?', (version,)).fetchone()
                if not registered or json.loads(registered[0])['status'] != 'promoted':
                    raise ValueError('Rollback requires baseline or a previously promoted version')
            db.execute("UPDATE state SET value=? WHERE key='active'", (version,))
            db.execute("UPDATE state SET value='1' WHERE key='paused'")
            db.execute('INSERT INTO audit(action,value,created) VALUES(?,?,?)', ('rollback', version, time.time()))
        return {'active_version': version}

    def run(self):
        """At most one process trains. Fresh gate groups are consumed even on rejection."""
        run_id = str(uuid4())
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT value FROM state WHERE key='paused'").fetchone()[0] == '1':
                return {'status': 'paused', 'reason': 'Resume explicitly after rollback'}
            busy = db.execute("SELECT 1 FROM runs WHERE status='running'").fetchone()
            if busy:
                return {'status': 'busy', 'reason': 'Another worker owns training; inspect/recover after a crash'}
            active = db.execute("SELECT value FROM state WHERE key='active'").fetchone()[0]
            rows = []
            for split in ('train', 'validation'):
                # Rolling replay keeps whole queries: never truncate a ranking list.
                queries = db.execute('SELECT query_id,count(*) AS n,max(id) AS latest FROM labels '
                                     'WHERE split=? GROUP BY query_id ORDER BY latest DESC', (split,)).fetchall()
                chosen, size = [], 0
                for query in queries:
                    if size + query['n'] <= self.max_rows:
                        chosen.append(query['query_id'])
                        size += query['n']
                if chosen:
                    placeholders = ','.join('?' for _ in chosen)
                    batch = db.execute('SELECT row_json FROM labels WHERE split=? AND query_id IN ('
                                       + placeholders + ') ORDER BY id', (split, *chosen)).fetchall()
                    rows.extend(json.loads(r[0]) for r in batch)
            fresh = db.execute('SELECT row_json FROM labels WHERE split=\'gate\' AND NOT EXISTS '
                               '(SELECT 1 FROM consumed_groups WHERE name=labels.event_group) ORDER BY id LIMIT ?',
                               (self.max_rows + 1,)).fetchall()
            rows.extend(json.loads(r[0]) for r in fresh)
            consumed = {r[0] for r in db.execute('SELECT name FROM consumed_groups')}
            db.execute('INSERT INTO runs VALUES(?,?,?,?)',
                       (run_id, 'running', encoded({'status': 'running', 'run_id': run_id}), time.time()))
        try:
            return self._train(run_id, rows, consumed, active)
        except Exception as error:
            with self.db() as db:
                report = {'status': 'failed', 'run_id': run_id, 'reason': str(error)}
                db.execute('UPDATE runs SET status=?,report=? WHERE id=?', ('failed', encoded(report), run_id))
            raise

    def _finish(self, run_id, report):
        report['run_id'] = run_id
        with self.db() as db:
            db.execute('UPDATE runs SET status=?,report=? WHERE id=?', (report['status'], encoded(report), run_id))
        return report

    def _train(self, run_id, rows, consumed, active):
        versions = defaultdict(int)
        for row in rows:
            versions[row.get('feature_version', 'unknown')] += 1
        if len(versions) > 1:
            return self._finish(run_id, {'status': 'waiting', 'feature_versions': dict(versions),
                                        'reason': 'Mixed feature versions; use a separate learning registry or explicitly rebuild reviewed snapshots. No labels were converted or discarded.'})
        if rows:
            version = validate_rows(rows)
            if any(r['label_origin'] != 'human' or r['dataset_split'] != partition(r['split_group_id']) for r in rows):
                raise ValueError('Only human rows in stable policy partitions may enter learning')
            if active != 'baseline':
                with self.db() as db:
                    old = LogisticRanker.from_dict(json.loads(db.execute(
                        'SELECT artifact FROM models WHERE id=?', (active,)).fetchone()[0]))
                if old.feature_version != version:
                    return self._finish(run_id, {'status': 'waiting', 'feature_versions': dict(versions),
                                                'reason': 'Active model uses another feature version; explicitly migrate the registry before comparing models. Gate remains unused.'})
        train = [r for r in rows if r['dataset_split'] == 'train'][-self.max_rows:]
        validation = informative([r for r in rows if r['dataset_split'] == 'validation'][-self.max_rows:])
        fresh = [r for r in rows if r['dataset_split'] == 'gate' and r['split_group_id'] not in consumed]
        gate = informative(fresh)
        # Oversized batches require offline review; never silently chop a held-out query.
        if len(fresh) > self.max_rows:
            return self._finish(run_id, {'status': 'waiting', 'reason': 'Gate exceeds max_rows; review offline'})
        if (len(train) < self.min_train or len(validation) < self.min_validation or len(gate) < self.min_gate
                or len({r['query_id'] for r in gate}) < self.min_queries
                or len({r['split_group_id'] for r in gate}) < self.min_gate_groups
                or {r['label'] >= 2 for r in train} != {False, True}):
            return self._finish(run_id, {'status': 'waiting', 'reason': 'Need more human ratings with contrasting relevance',
                                        'usable_rows': {'train': len(train), 'validation': len(validation), 'fresh_gate': len(gate)}})
        groups = [{r['split_group_id'] for r in part} for part in (train, validation, gate)]
        if any(groups[i] & groups[j] for i,j in ((0,1),(0,2),(1,2))):
            raise ValueError('Policy leakage between learning partitions')
        candidates = []
        for algorithm, trainer in (('pointwise_logistic', fit), ('pairwise_logistic', pairwise_fit)):
            for l2 in (.001, .01, .1, 1.0):
                if algorithm == 'pairwise_logistic' and not informative(train):
                    continue
                model = trainer(train, l2=l2, iterations=200)
                model.metadata['algorithm'] = algorithm
                metrics = evaluate(validation, model.predict)
                candidates.append((metrics['ndcg_at_k'], l2, algorithm, metrics))
        best = max(candidates, key=lambda x: (x[0], x[1], x[2]))
        trainer = fit if best[2] == 'pointwise_logistic' else pairwise_fit
        candidate = trainer(train + validation, l2=best[1], iterations=200)
        candidate.metadata.update(label_origin='human', algorithm=best[2], registry_version=run_id,
                                  dataset_sha256=hashlib.sha256(encoded(train + validation).encode()).hexdigest(),
                                  fit_event_groups=sorted(groups[0] | groups[1]), fit_rows=len(train)+len(validation))
        # Candidate is frozen before the one-shot gate is read. Consume even if it loses.
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            changed = (db.execute("SELECT value FROM state WHERE key='active'").fetchone()[0] != active
                       or db.execute("SELECT value FROM state WHERE key='paused'").fetchone()[0] == '1')
            db.executemany('INSERT OR IGNORE INTO consumed_groups VALUES(?)', [(g,) for g in sorted(groups[2])])
            old = None if active == 'baseline' else LogisticRanker.from_dict(json.loads(
                db.execute('SELECT artifact FROM models WHERE id=?', (active,)).fetchone()[0]))
        if changed:
            return self._finish(run_id, {'status': 'superseded', 'reason': 'Active model changed while training'})
        learned = evaluate(gate, candidate.predict)
        baseline = evaluate(gate, baseline_score)
        champion = evaluate(gate, old.predict if old else baseline_score)
        # Positive per-query margin against BOTH references; conservative paired standard error.
        margins = []
        for query in sorted({r['query_id'] for r in gate}):
            query_rows = [r for r in gate if r['query_id'] == query]
            score = evaluate(query_rows, candidate.predict)['ndcg_at_k']
            reference = max(evaluate(query_rows, baseline_score)['ndcg_at_k'],
                            evaluate(query_rows, old.predict if old else baseline_score)['ndcg_at_k'])
            margins.append(score - reference)
        mean = sum(margins) / len(margins)
        se = (sum((v-mean)**2 for v in margins)/(len(margins)-1)/len(margins))**.5 if len(margins)>1 else math.inf
        lower = mean - 1.96 * se
        promoted = (lower >= self.min_gain and learned['precision_at_k'] >= max(
            baseline['precision_at_k'], champion['precision_at_k']))
        report = {'status': 'promoted' if promoted else 'rejected', 'previous_version': active,
                  'selected': {'algorithm': best[2], 'l2': best[1]},
                  'validation_candidates': [{'algorithm': a, 'l2': p, 'metrics': m} for _,p,a,m in candidates],
                  'gate': {'candidate': learned, 'baseline': baseline, 'champion': champion,
                           'paired_mean_gain': mean, 'approximate_lower_gain': lower,
                           'event_groups': sorted(groups[2])},
                  'limitations': ['Human ratings are not audited expert judgments.',
                                  'Query margins may correlate across events; this is an operational gate, not proof of significance.',
                                  'Validate the chosen release separately on an untouched audit set.']}
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute("SELECT value FROM state WHERE key='active'").fetchone()[0]
            if current != active or db.execute("SELECT value FROM state WHERE key='paused'").fetchone()[0] == '1':
                report['status'] = 'superseded'
            db.execute('INSERT INTO models VALUES(?,?,?,?)', (run_id, encoded(candidate.to_dict()), encoded(report), time.time()))
            if report['status'] == 'promoted':
                db.execute("UPDATE state SET value=? WHERE key='active'", (run_id,))
                db.execute('INSERT INTO audit(action,value,created) VALUES(?,?,?)', ('promote', run_id, time.time()))
        return self._finish(run_id, report)
