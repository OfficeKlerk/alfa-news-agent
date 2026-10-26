"""Owner-only local registry operations; never communicates with GitHub."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from integration.learning import Learning, encoded


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', default=str(ROOT / 'var/learning/registry.sqlite3'))
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('status', 'run', 'models', 'resume'):
        sub.add_parser(name)
    rollback = sub.add_parser('rollback')
    rollback.add_argument('--version', default='baseline')
    export = sub.add_parser('export')
    export.add_argument('--version', required=True)
    export.add_argument('--output', required=True)
    example = sub.add_parser('example', help='Prepare unlabelled research events for manual source review')
    example.add_argument('--company-id', required=True)
    example.add_argument('--output', required=True)
    recovery = sub.add_parser('recover', help='Only after stopping ALL service/worker processes')
    recovery.add_argument('--workers-stopped', action='store_true', required=True)
    args = parser.parse_args()
    if args.command == 'example':
        from integration.contracts import validate
        events = json.loads((ROOT / 'data/training_v2/bundle/events.json').read_text())
        selected = []
        for event in events:
            if any(s.get('verification_method') != 'primary_page' for s in event['sources']):
                continue
            selected.append({**{k: event.get(k, []) for k in ('news_id', 'event_id', 'title', 'event_type',
                'published_at', 'fact_status', 'okved_divisions', 'countries', 'regions', 'company_ids')},
                'split_group_id': event.get('split_group_id', event['event_id']), 'event_at': None,
                'text': '\n'.join(s['excerpt'] for s in event['sources']),
                'entity_mapping_source': event.get('entity_mapping_source'), 'is_mock': False,
                'sources': [{'id': 'news:' + event['event_id'] + ':' + str(i), 'kind': 'news',
                    'title': event['title'], 'url': s['url'], 'excerpt': s['excerpt'],
                    'document_id': None, 'page': None, 'published_at': event['published_at'], 'is_mock': False}
                    for i,s in enumerate(event['sources'])]})
        body = validate('RankRequest', {'company_id': args.company_id, 'as_of': '2026-10-23T00:00:00Z',
                                       'limit': 100, 'events': selected})
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(body, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('Saved unlabelled request. AI extraction must be checked against primary sources before rating.')
        return
    learning = Learning(args.database)
    if args.command == 'status':
        result = learning.status()
    elif args.command == 'run':
        result = learning.run()
    elif args.command == 'rollback':
        result = learning.rollback(args.version)
    elif args.command == 'models':
        with learning.db() as db:
            result = [{'version': row['id'], 'created': row['created'], 'report': json.loads(row['report'])}
                      for row in db.execute('SELECT id,created,report FROM models ORDER BY created DESC')]
    elif args.command == 'export':
        output = Path(args.output).resolve()
        if output == learning.path.resolve():
            raise ValueError('Output cannot overwrite registry')
        with learning.db() as db:
            row = db.execute('SELECT artifact FROM models WHERE id=?', (args.version,)).fetchone()
            if not row:
                raise ValueError('Unknown model version')
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(row[0] + '\n', encoding='utf-8')
        result = {'saved': str(output)}
    else:
        with learning.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if args.command == 'resume':
                db.execute("UPDATE state SET value='0' WHERE key='paused'")
                result = {'status': 'resumed'}
            else:
                result = {'status': 'recovered', 'reason': 'Owner confirmed all workers stopped'}
                db.execute("UPDATE runs SET status='failed',report=? WHERE status='running'", (encoded(result),))
            db.execute('INSERT INTO audit(action,value,created) VALUES(?,?,?)',
                       (args.command, encoded(result), time.time()))
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
