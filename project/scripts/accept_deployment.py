"""Independent black-box acceptance of the implemented v1 flow; never falls back to fixtures.
Tokens are read from environment (not CLI/history/report). Full acceptance needs --generate,
a real newly collected article and, separately, the live-pipeline procedure in the handoff.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-url', required=True)
    p.add_argument('--company-a', required=True)
    p.add_argument('--company-b', required=True)
    p.add_argument('--news-id', required=True, help='Real article collected by the deployed pipeline')
    p.add_argument('--news-url', required=True)
    p.add_argument('--token-a-env', default='ACCEPT_TOKEN_A')
    p.add_argument('--token-b-env', default='ACCEPT_TOKEN_B')
    p.add_argument('--generate', action='store_true', help='Spend real provider calls: one analysis and one follow-up')
    p.add_argument('--previous-report', type=Path, help='After a real restart, verify the previous saved analysis still exists')
    p.add_argument('--out', type=Path, default=Path('var/acceptance/deployment.json'))
    args = p.parse_args()
    checks = []
    report = {'status': 'blocked', 'checked_at': datetime.now(timezone.utc).isoformat(), 'checks': checks,
              'live_pipeline_signoff': False, 'scope': 'real_v1_HTTP_flow', 'provider_calls_authorized': args.generate}
    def check(name, condition):
        checks.append({'name': name, 'passed': bool(condition)})
        if not condition:
            raise ValueError('Check failed: ' + name)
    try:
        token_a, token_b = os.getenv(args.token_a_env), os.getenv(args.token_b_env)
        if not token_a or not token_b:
            raise RuntimeError('Two real company-scoped access tokens are required; no test credentials are substituted')
        if args.company_a == args.company_b:
            raise ValueError('Use two different companies and identities')
        address = urlparse(args.base_url)
        if address.scheme != 'https' or not address.hostname or address.username or address.password or address.query or address.fragment or address.path not in {'', '/'}:
            raise ValueError('Acceptance requires the actual external HTTPS gateway')
        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        http = build_opener(NoRedirect())
        def call(path, token=None, data=None, expected=200):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            req = Request(args.base_url.rstrip('/') + path, headers=headers,
                          data=json.dumps(data).encode() if data is not None else None)
            try:
                response = http.open(req, timeout=300)
            except HTTPError as e:
                response = e
            with response:
                check(path + ' HTTP ' + str(expected), response.status == expected)
                value = json.load(response)
                if expected == 200:
                    check(path + ' real envelope', value.get('meta', {}).get('mode') == 'live')
                return value
        a, b = map(lambda s: quote(s, safe=''), [args.company_a, args.company_b])
        call('/v1/companies/' + a, expected=401)
        for token, own, other in [(token_a, a, b), (token_b, b, a)]:
            listed = call('/v1/companies?limit=100', token)['data']['items']
            check('company list excludes other tenant', other not in [quote(x, safe='') for x in listed])
            profile = call('/v1/companies/' + own, token)
            check('profile binding', quote(profile['data']['company_id'], safe='') == own)
            call('/v1/companies/' + other, token, expected=403)
            call('/api/bootstrap', token, expected=403)
            call('/v1/news', token, {}, expected=403)
        as_of = datetime.now(timezone.utc).isoformat()
        body = {'company_id': args.company_a, 'news_id': args.news_id, 'as_of': as_of, 'audience_role': 'cfo'}
        call('/v1/analyze', token_b, body, expected=403)
        events = call('/v1/tools/search_news', token_a, {'query': '', 'as_of': as_of, 'limit': 1, 'news_id': args.news_id})['data']['items']
        check('real article collected with original URL', len(events) == 1 and not events[0]['is_mock'] and any(s['url'] == args.news_url for s in events[0]['sources']))
        call('/v1/rank', token_b, {'company_id': args.company_a, 'events': events, 'as_of': as_of, 'limit': 1}, expected=403)
        rank = call('/v1/rank', token_a, {'company_id': args.company_a, 'events': events, 'as_of': as_of, 'limit': 1})['data']
        check('personal rank binding', rank['company_id'] == args.company_a and len(rank['items']) == 1 and rank['items'][0]['score_kind'] != 'mock')
        context_body = {**body, 'event': events[0]}; del context_body['news_id']
        preview = call('/v1/analysis-context', token_a, context_body)['data']
        check('reviewed company context', preview['input']['profile']['company_id'] == args.company_a)
        if args.previous_report:
            previous = json.loads(args.previous_report.read_text())
            check('restart checkpoint exists', bool(previous.get('analysis_id')) and previous.get('company_id') == args.company_a)
            call('/v1/analyses/' + quote(previous['analysis_id'], safe='') + '?company_id=' + a, token_a)
        if args.generate:
            analysis = call('/v1/analyze-event', token_a, {**context_body, 'expected_context_sha256': preview['sha256']})['data']
            check('real model and sources', analysis['mode'] == 'live' and all(not s['is_mock'] for s in analysis['sources']))
            check('answer company and news', analysis['company_id'] == args.company_a and analysis['news_id'] == args.news_id)
            ids = {s['id'] for s in analysis['sources']}
            check('claims have registered sources', all(set(c['source_ids']) <= ids for c in analysis['claims']))
            aid = quote(analysis['id'], safe=''); report.update(analysis_id=analysis['id'], company_id=args.company_a, news_id=args.news_id)
            call('/v1/analyses/' + aid + '?company_id=' + a, token_a)
            call('/v1/analyses/' + aid + '?company_id=' + a, token_b, expected=403)
            call('/v1/analyses/' + aid + '?company_id=' + b, token_b, expected=404)
            call('/v1/analyses/' + aid + '/questions', token_b, {'company_id': args.company_a, 'question': 'Какие данные нужно уточнить?'}, expected=403)
            answer = call('/v1/analyses/' + aid + '/questions', token_a, {'company_id': args.company_a, 'question': 'Какие данные нужно уточнить?'})['data']
            check('follow-up retains company and evidence', answer['company_id'] == args.company_a and set(answer['source_ids']) <= ids)
        report['status'] = 'v1_flow_passed' if args.generate else 'read_and_preview_passed'
        report['remaining'] = 'Live-feed delivery, failure recovery, load and restart acceptance require the colleague implementation; follow LIVE_PIPELINE_ACCEPTANCE.md'
    except RuntimeError as e:
        report['reason'] = str(e)
    except Exception as e:
        report['status'] = 'failed'; report['reason'] = type(e).__name__ + ': ' + str(e)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'passed_checks': sum(c['passed'] for c in checks), 'out': str(args.out)}, ensure_ascii=False))
    return 0 if report['status'] in {'v1_flow_passed', 'read_and_preview_passed'} else 2


if __name__ == '__main__':
    sys.exit(main())
