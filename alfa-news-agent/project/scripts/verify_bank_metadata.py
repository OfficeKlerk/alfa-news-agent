"""Validate the reviewed publication-date manifest and unchanged OCR, without network.

Optional --pdf-dir checks the exact original files used for visual verification.
The hashes prove file identity, not the correctness of human/visual interpretation.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
from datetime import date

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(root, pdf_dir=None):
    pages = json.loads((root / 'data/research.json').read_text(encoding='utf-8'))
    manifest = json.loads((root / 'data/demo/rag/corpus_manifest.json').read_text(encoding='utf-8'))
    documents = manifest['documents']
    if len(pages) != 64 or len(documents) != 9 or len({p['id'] for p in pages}) != 64:
        raise ValueError('Expected 9 documents and 64 unique OCR pages')
    if {p['document_id'] for p in pages} != {d['document_id'] for d in documents}:
        raise ValueError('Manifest/corpus document IDs differ')
    for document in documents:
        rows = sorted((p for p in pages if p['document_id'] == document['document_id']), key=lambda p: p['page'])
        if [p['page'] for p in rows] != list(range(1, document['pages'] + 1)):
            raise ValueError('Missing/repeated page: ' + document['filename'])
        serialized = json.dumps([[p['id'], p['text']] for p in rows], ensure_ascii=False, separators=(',', ':')).encode()
        if digest(serialized) != document['ocr_text_sha256']:
            raise ValueError('OCR text changed: ' + document['filename'])
        if not re.fullmatch(r'[a-f0-9]{64}', document['pdf_sha256']):
            raise ValueError('Missing PDF identity')
        if document['date_status'] == 'verified':
            date.fromisoformat(document['date'])
            evidence = document['verification']
            if evidence['method'] != 'visual_review_of_rendered_pdf' or evidence['page'] < 1 or not evidence['printed_label']:
                raise ValueError('Missing printed-date evidence')
        elif document['date_status'] != 'unknown' or document['date'] is not None:
            raise ValueError('Unverified date must remain unknown')
        for row in rows:
            if (row['date'], row['publication_date_status'], row['publication_metadata_id']) != (document['date'], document['date_status'], document['document_id']):
                raise ValueError('Page publication metadata mismatch')
        if pdf_dir is not None:
            pdf = pdf_dir / document['filename']
            if digest(pdf.read_bytes()) != document['pdf_sha256']:
                raise ValueError('Original PDF identity mismatch: ' + document['filename'])
    return {'documents': len(documents), 'pages': len(pages),
            'verified_publication_days': sum(d['date_status'] == 'verified' for d in documents),
            'dated_pages': sum(bool(p['date']) for p in pages),
            'unknown_publication_days': [d['filename'] for d in documents if d['date'] is None],
            'original_pdf_hashes_checked': pdf_dir is not None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf-dir', type=Path)
    options = parser.parse_args()
    print(json.dumps(verify(ROOT, options.pdf_dir), ensure_ascii=False, indent=2))
