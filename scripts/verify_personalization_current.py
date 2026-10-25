"""Reproduce the current rank audit without weakening frozen graph provenance.
Only byte-equivalent event records may reuse the audited graph; changed events
require the real database. No labels are used to fit or select model weights.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from evaluate_personalization import graph_snapshot_binding, value_sha


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    folder = ROOT / 'var/acceptance/personalization'
    folder.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'data/personalization'
    frozen = json.loads((source / 'evaluation/graph_snapshots.json').read_text())
    binding = graph_snapshot_binding(source, source / 'evaluation/curated_extracted.json', source / 'evaluation/articles_extracted.json')
    if any(frozen.get(key) != value for key, value in binding.items()) or frozen['content_sha256'] != value_sha(frozen['variants']):
        raise ValueError('Frozen graph provenance is invalid; rebuild using the original database')
    proof = {'method': 'exact_event_records_and_unchanged_graph_dependencies', 'model_training': False, 'label_origin': 'ai', 'human_reviewed_pairs': 0, 'exports': {}}
    for mode, input_name in [('curated', 'events.json'), ('articles', 'articles.json')]:
        target = folder / (mode + '.json')
        subprocess.run(['node', '--import', 'tsx', 'scripts/extract_personalization_events.ts', '--mode', mode, '--input', str(source / input_name), '--out', str(target)], cwd=ROOT, check=True)
        previous = source / ('evaluation/' + mode + '_extracted.json')
        old, current = json.loads(previous.read_text()), json.loads(target.read_text())
        for field in ['records', 'input_sha256', 'source_availability_policy', 'mode', 'schema_version']:
            if old[field] != current[field]:
                raise ValueError('Event semantics changed; rebuild graphs from original data, not by relabelling hashes')
        proof['exports'][mode] = {'previous_sha256': sha(previous), 'current_sha256': sha(target), 'records_sha256': value_sha(current['records'])}
    # Only extraction-code metadata changed; attach the exact semantic-equivalence
    # proof and new export-byte hashes. The graph and its engine remain unchanged.
    updated = {**frozen, 'event_inputs_sha256': {m: sha(folder / (m + '.json')) for m in ['curated', 'articles']}}
    snapshot = folder / 'equivalent_graph_snapshot.json'
    snapshot.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n')
    (folder / 'equivalence_proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
    subprocess.run([sys.executable, 'scripts/evaluate_personalization.py', '--out', str(folder), '--graph-snapshots', str(snapshot), '--curated', str(folder / 'curated.json'), '--articles', str(folder / 'articles.json'), '--report', str(folder / 'report.md')], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
