"""Run repeatable LOCAL task-3 acceptance. Never enables paid LLM or deploys anything.

Install the locked dependencies first, then run with the project's Python 3.12 venv:
    python scripts/accept_task3.py
Exit 0 means local automation passed; it never means production/expert acceptance passed.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PREFIXES = ('LLM_', 'MAX_DAILY_LLM_', 'MAX_COMPANY_', 'OIDC_', 'AUTH_', 'INTERNAL_', 'NEWS_', 'LIVE_', 'LEARNING_')
CONFIG_NAMES = {'RANK_MODE', 'RANK_MODEL_PATH', 'AGENT_MODE', 'RETRIEVAL_MODE', 'CONTEXT_MODE', 'CONTEXT_DB',
                'DB_PATH', 'DATA_DIR', 'PORT', 'HOST', 'ML_URL', 'RETRIEVAL_URL', 'AGENT_URL', 'PUBLIC_BASE_URL',
                'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'FORCE_COLOR', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'ANALYSIS_ENABLED', 'INTEGRATION_LOG'}


def clean_environment() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in CONFIG_NAMES and not k.startswith(CONFIG_PREFIXES)}
    # Empty API key also takes precedence over a private .env loaded by project utilities.
    env.update(LLM_API_KEY='', LLM_MODE='demo', AUTH_MODE='development', ANALYSIS_ENABLED='0',
               NEWS_ENABLED='0', NEWS_FEEDS_JSON='[]', LIVE_PIPELINE_ENABLED='0', PYTHONUNBUFFERED='1', NO_COLOR='1', NO_PROXY='localhost,127.0.0.1,::1')
    return env


def integrity() -> dict:
    path = ROOT / 'config/source-manifest.json'
    if not path.is_file():
        return {'status': 'BLOCKED', 'reason': 'config/source-manifest.json missing; use the complete source ZIP'}
    try:
        files = json.loads(path.read_text(encoding='utf-8'))
        mismatches = []
        for name, metadata in files.items():
            file = (ROOT / name).resolve()
            if not file.is_relative_to(ROOT):
                raise ValueError('Invalid manifest path')
            if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != metadata['sha256']:
                mismatches.append(name)
        return {'status': 'FAIL' if mismatches else 'PASS', 'checked_files': len(files), 'mismatches': mismatches}
    except (OSError, ValueError, TypeError, KeyError) as error:
        return {'status': 'FAIL', 'reason': str(error)}


def run(name: str, command: list[str], env: dict[str, str], folder: Path, timeout: int = 600) -> dict:
    started = time.monotonic()
    print(f'RUN {name}', flush=True)
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, start_new_session=True)
    timed_out = False
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
    log = folder / (name + '.txt')
    log.write_text(output, encoding='utf-8')
    result = {'name': name, 'command': command, 'status': 'PASS' if process.returncode == 0 and not timed_out else 'FAIL',
              'exit_code': process.returncode, 'timeout': timed_out, 'seconds': round(time.monotonic()-started, 3), 'log': log.name}
    if name == 'node-tests':
        for label in ('tests', 'pass', 'fail', 'skipped'):
            match = re.search(r'(?m)^(?:ℹ|#)\s+'+label+r'\s+(\d+)\s*$', output)
            if match:
                result[label] = int(match.group(1))
        if result.get('skipped', 0):
            result['status'] = 'FAIL'
            result['reason'] = 'Skipped Node tests require explicit review; not a full pass'
    if name == 'python-tests':
        match = re.search(r'(\d+) passed', output)
        if match:
            result['passed'] = int(match.group(1))
        if re.search(r'\d+ skipped', output):
            result['status'] = 'FAIL'
            result['reason'] = 'Skipped Python tests require explicit review'
    print(f"{result['status']} {name} ({result['seconds']} s)", flush=True)
    if result['status'] != 'PASS':
        print(output[-3000:], flush=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, help='Fresh report directory inside project var/acceptance')
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    folder = (args.out or ROOT / 'var/acceptance/task3' / stamp).resolve()
    allowed = (ROOT / 'var/acceptance').resolve()
    if not folder.is_relative_to(allowed) or folder == allowed or folder.exists():
        parser.error('--out must be a NEW directory below var/acceptance')
    folder.mkdir(parents=True)
    env = clean_environment()
    report = {'started_at': stamp, 'scope': 'LOCAL_AUTOMATION_ONLY', 'paid_external_calls': 0,
              'production_gate': 'NOT_RUN', 'expert_semantic_gate': 'NOT_RUN', 'checks': [],
              'source_integrity': integrity(), 'python': sys.version.split()[0]}
    blocked = []
    if sys.platform not in ('linux', 'darwin'):
        blocked.append('Use Linux/macOS or WSL2; the live supervisor uses fcntl')
    if sys.version_info[:2] != (3, 12):
        blocked.append('Use Python 3.12 with the locked project venv')
    for binary in ('node', 'npm', 'openssl'):
        if shutil.which(binary) is None:
            blocked.append(f'{binary} not found')
    if not blocked:
        version = subprocess.run(['node', '--version'], text=True, capture_output=True, env=env, check=False).stdout.strip()
        report['node'] = version
        parts = version.lstrip('v').split('.')
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit() or int(parts[0]) != 24 or int(parts[1]) < 13:
            blocked.append('Use Node >=24.13 and <25')
        if not (ROOT / 'node_modules/typescript').is_dir():
            blocked.append('Install npm dependencies using npm ci')
    if blocked:
        report.update(status='BLOCKED', blockers=blocked)
    else:
        definitions = [
            ('contracts', ['python', 'scripts/build_contracts.py', '--check'], {}),
            ('typecheck', ['npm', 'run', 'typecheck'], {}),
            ('build', ['npm', 'run', 'build'], {}),
            ('node-tests', ['npm', 'test'], {}),
            ('python-tests', ['python', '-m', 'pytest', 'tests', '-q'], {}),
            ('bundled-news', ['python', 'scripts/prepare_news_source.py'], {}),
            ('offline-evaluation', ['npm', 'run', 'llm:evaluate', '--', '--out', str(folder / 'offline-reference.json')], {}),
            ('bank-retrieval', ['npm', 'run', 'rag:evaluate', '--', '--out', str(folder / 'rag'), '--python', sys.executable], {}),
            ('personalization', ['python', 'scripts/verify_personalization_current.py'], {}),
            ('smoke-default', ['python', 'scripts/dev.py', '--smoke'], {'ANALYSIS_ENABLED':'1'}),
            ('smoke-python-ranker', ['python', 'scripts/dev.py', '--smoke'], {'RANK_MODE': 'news-analysis', 'AGENT_MODE': 'legacy', 'ANALYSIS_ENABLED':'1'}),
            ('smoke-native', ['python', 'scripts/dev.py', '--smoke', '--native-providers'], {'RANK_MODE': 'news-analysis', 'ANALYSIS_ENABLED':'1'}),
        ]
        for name, command, overrides in definitions:
            command = [sys.executable if word == 'python' and i == 0 else word for i, word in enumerate(command)]
            report['checks'].append(run(name, command, {**env, **overrides}, folder))
        report['status'] = 'LOCAL_AUTOMATION_PASS' if report['source_integrity']['status'] == 'PASS' and all(c['status'] == 'PASS' for c in report['checks']) else 'FAIL'
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    report['not_run'] = ['external HTTPS/IdP and production permissions', 'real internet feed to real Qwen',
                         'provider-side billing reconciliation', 'infrastructure backup/restore and load',
                         'human expert assessment and independent labels']
    (folder / 'REPORT.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    lines = ['# Task 3 — локальная автоматическая приёмка', '', f"Результат: **{report['status']}**.", '',
             'Реальный Qwen, внешний IdP, production-стенд и человеческая оценка не проверялись. Это не production PASS.', '',
             f"Целостность исходников: {report['source_integrity']['status']}.", '',
             '| Проверка | Статус | Секунды | Лог |', '|---|---|---:|---|']
    lines += [f"| {c['name']} | {c['status']} | {c['seconds']} | [{c['log']}]({c['log']}) |" for c in report['checks']]
    if blocked:
        lines += ['', 'Блокеры: ' + '; '.join(blocked)]
    if report['source_integrity'].get('mismatches'):
        lines += ['', 'Исходники отличаются: '+', '.join(report['source_integrity']['mismatches'])]
    lines += ['', 'Полный протокол и команды: REPORT.json. Следующий этап — независимые сценарии и стенд из TASK3_CONTEXT.md.']
    (folder / 'REPORT.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(f"{report['status']}: {folder / 'REPORT.md'}", flush=True)
    return 0 if report['status'] == 'LOCAL_AUTOMATION_PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
