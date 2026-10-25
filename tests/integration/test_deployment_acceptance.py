import json
from scripts.accept_deployment import main


def test_acceptance_cannot_pass_or_contact_a_site_without_two_real_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv('ACCEPT_TOKEN_A', raising=False)
    monkeypatch.delenv('ACCEPT_TOKEN_B', raising=False)
    out = tmp_path / 'acceptance.json'
    monkeypatch.setattr('sys.argv', ['accept_deployment.py', '--base-url', 'https://not-supplied.invalid',
        '--company-a', 'A', '--company-b', 'B', '--news-id', 'not-supplied',
        '--news-url', 'https://not-supplied.invalid/article', '--out', str(out)])
    assert main() == 2
    report = json.loads(out.read_text())
    assert report['status'] == 'blocked'
    assert report['live_pipeline_signoff'] is False
    assert report['checks'] == []
