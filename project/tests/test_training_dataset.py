"""Data integrity tests; model fitting here uses only synthetic unit fixtures."""

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from company_context import build_database
from news_analysis.dataset import (build_bundle, verify_bundle, validate_curation, import_reviews,
                                   read_json, read_jsonl, write_json, write_jsonl)
from news_analysis.ranking import temporal_split, train_ranker, validate_rows
from test_news_analysis import training_rows, event, FIXTURES


class RankingContractTests(unittest.TestCase):
    def test_ai_provenance_is_required_and_report_is_provisional(self):
        rows=training_rows()
        for row in rows:row.update(label_origin='ai',annotator='test_fixture',rubric_version='test',annotation_reason='test label')
        _,report=train_ranker(rows,penalties=[.01],iterations=3)
        self.assertEqual(report['evaluation_status'],'provisional_ai_agreement')
        del rows[0]['annotator']
        with self.assertRaises(ValueError):validate_rows(rows)

    def test_policy_cluster_stays_together_across_different_event_ids(self):
        rows=training_rows()
        for row in rows:
            if row['event_id'] in {'E_00','E_19'}:row['split_group_id']='same_policy'
        parts=temporal_split(rows)
        locations={i for i,part in enumerate(parts) for r in part if r['event_id'] in {'E_00','E_19'}}
        self.assertEqual(len(locations),1)
        rows[0]['split_group_id']='inconsistent'
        with self.assertRaises(ValueError):temporal_split(rows)

    def frozen_rows(self):
        rows=training_rows()
        for name,part in zip(('train','validation','test'),temporal_split(rows)):
            for row in part:row['dataset_split']=name
        return rows

    def test_partial_reviews_preserve_original_split_and_test_is_not_fitted(self):
        rows=self.frozen_rows()[8:]
        for row in rows:row['label_origin']='human'
        first,report=train_ranker(rows,penalties=[.01],iterations=5)
        self.assertEqual(report['split']['method'],'frozen_dataset_split')
        original_test={r['event_id'] for r in rows if r['dataset_split']=='test'}
        self.assertEqual(set(report['split']['test_events']),original_test)
        for row in rows:
            if row['dataset_split']=='test':row['label']=3-row['label']
        second,_=train_ranker(rows,penalties=[.01],iterations=5)
        self.assertEqual(first.coefficients,second.coefficients)

    def test_incomplete_or_leaking_frozen_splits_rejected(self):
        rows=self.frozen_rows()
        with self.assertRaises(ValueError):train_ranker([r for r in rows if r['dataset_split']!='test'],iterations=2)
        rows[-1]['dataset_split']='train'
        with self.assertRaises(ValueError):train_ranker(rows,iterations=2)
        rows=self.frozen_rows(); del rows[0]['dataset_split']
        with self.assertRaises(ValueError):train_ranker(rows,iterations=2)


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.curation=self.root/'curation';self.curation.mkdir()
        self.db=self.root/'context.sqlite'
        metadata=build_database(FIXTURES/'companies.csv',self.db,FIXTURES/'links.csv',FIXTURES/'payments.csv','rub')
        self.events=[event(news_id=f'N{i}',event_id=f'E{i:02}',split_group_id=f'E{i:02}',
                           published_at=f'2026-01-{i+1:02}T23:59:59Z',publication_date=f'2026-01-{i+1:02}',
                           sources=[{'url':'https://example.org/unit-test','excerpt':'Synthetic test fixture',
                                     'publisher':'Test','accessed_on':'2026-10-22',
                                     'verification_method':'fixture','excerpt_kind':'fixture'}]) for i in range(20)]
        self.companies=[{'company_id':u} for u in ('U_A','U_B','U_C')]
        self.annotations=[{'company_id':c['company_id'],'event_id':e['event_id'],'label':2 if i%2 else 0,
                           'label_origin':'ai','annotator':'test_fixture','rubric_version':'test',
                           'review_status':'unreviewed','explanation':'Synthetic fixture annotation',
                           'impact_channel':'fixture','next_step':'Test only','confidence':'low','missing_data':[]}
                          for i,e in enumerate(self.events) for c in self.companies]
        write_json(self.curation/'events.json',self.events)
        write_json(self.curation/'companies.json',self.companies)
        write_jsonl(self.curation/'annotations.jsonl',self.annotations)
        write_json(self.curation/'context_snapshot.json',{'source_sha256':{k:v['sha256'] for k,v in metadata['sources'].items()},'revenue_unit':'rub'})
        self.bundle=self.root/'bundle'
        build_bundle(self.db,self.curation,self.bundle,['U_C'])

    def refresh_hash(self,name):
        manifest=read_json(self.bundle/'manifest.json')
        manifest['files'][name]=hashlib.sha256((self.bundle/name).read_bytes()).hexdigest()
        write_json(self.bundle/'manifest.json',manifest)

    def test_complete_bundle_verifies_and_rebuild_is_byte_identical(self):
        self.assertEqual(verify_bundle(self.bundle)['rows'],60)
        other=self.root/'rebuilt'
        build_bundle(self.db,self.curation,other,['U_C'])
        for path in self.bundle.iterdir():self.assertEqual(path.read_bytes(),(other/path.name).read_bytes(),path.name)

    def test_missing_duplicate_unknown_and_invalid_labels_rejected(self):
        variants=[self.annotations[:-1],self.annotations+[self.annotations[0]]]
        bad=copy.deepcopy(self.annotations);bad[0]['company_id']='unknown';variants.append(bad)
        bad=copy.deepcopy(self.annotations);bad[0]['label']=True;variants.append(bad)
        for annotations in variants:
            with self.assertRaises(ValueError):validate_curation(self.events,self.companies,annotations)

    def test_source_snapshot_change_rejected(self):
        snapshot=read_json(self.curation/'context_snapshot.json');snapshot['source_sha256']['companies']='changed'
        write_json(self.curation/'context_snapshot.json',snapshot)
        with self.assertRaises(ValueError):build_bundle(self.db,self.curation,self.root/'other',['U_C'])

    def test_nonempty_destination_is_never_overwritten(self):
        with self.assertRaises(ValueError):build_bundle(self.db,self.curation,self.bundle,['U_C'])

    def test_file_corruption_is_detected(self):
        with (self.bundle/'train.jsonl').open('a') as stream:stream.write(' ')
        with self.assertRaisesRegex(ValueError,'Checksum'):verify_bundle(self.bundle)

    def test_features_recomputed_even_after_checksums_are_updated(self):
        all_rows=read_jsonl(self.bundle/'all.jsonl');target=all_rows[0]
        target['features']['rate_financing']=1-target['features']['rate_financing']
        write_jsonl(self.bundle/'all.jsonl',all_rows);self.refresh_hash('all.jsonl')
        name=target['dataset_split']+'.jsonl';part=read_jsonl(self.bundle/name)
        for row in part:
            if row['pair_id']==target['pair_id']:row['features']=target['features']
        write_jsonl(self.bundle/name,part);self.refresh_hash(name)
        with self.assertRaisesRegex(ValueError,'Features differ'):verify_bundle(self.bundle)

    def test_human_review_import_requires_provenance_and_preserves_holdout(self):
        reviews=read_jsonl(self.bundle/'blind_review.jsonl')
        review=next(r for r in reviews if r['split']=='test')
        review.update(human_label=3,label_origin='human',reviewer_id='unit-test-reviewer',
                      reviewed_at='2026-10-22T20:00:00Z',reason='Unit test')
        path=self.root/'reviews.jsonl';write_jsonl(path,reviews)
        output=self.root/'human.jsonl';result=import_reviews(self.bundle,path,output)
        self.assertEqual(result['human_rows'],1)
        exported=read_jsonl(output)[0]
        self.assertEqual(exported['dataset_split'],'test')
        self.assertEqual(exported['label_origin'],'human')
        self.assertTrue(all(r['label_origin']=='ai' for r in read_jsonl(self.bundle/'all.jsonl')))

    def test_incomplete_stale_or_unattributed_review_rejected(self):
        reviews=read_jsonl(self.bundle/'blind_review.jsonl')[:1];path=self.root/'reviews.jsonl'
        write_jsonl(path,reviews)
        with self.assertRaises(ValueError):import_reviews(self.bundle,path,self.root/'human.jsonl')
        reviews[0].update(human_label=2,reviewer_id='test',reason='test',reviewed_at='2026-10-22T20:00:00Z')
        write_jsonl(path,reviews)
        with self.assertRaises(ValueError):import_reviews(self.bundle,path,self.root/'human.jsonl')
        reviews[0].update(label_origin='human',profile_sha256='changed');write_jsonl(path,reviews)
        with self.assertRaises(ValueError):import_reviews(self.bundle,path,self.root/'human.jsonl')

    def test_blind_review_does_not_expose_ai_judgment(self):
        for row in read_jsonl(self.bundle/'blind_review.jsonl'):
            self.assertNotIn('proposed_ai_label',row)
            self.assertNotIn('proposed_reason',row)
            self.assertIsNone(row['human_label'])


if __name__=='__main__':unittest.main()
