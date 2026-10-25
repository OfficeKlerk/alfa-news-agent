"""Verify provenance/abstention contracts; do not fit models to the real corpus."""

from pathlib import Path
import unittest

from news_analysis.dataset import read_json, read_jsonl, verify_bundle
from news_analysis.evidence import validate_research, validate_registry, assert_training_eligible
from news_analysis.ranking import fit, train_ranker
from test_news_analysis import training_rows

ROOT=Path(__file__).resolve().parents[1]/'data'


class ResearchEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.path=ROOT/'training_v2/bundle'
        self.events=read_json(self.path/'events.json')
        self.registry=read_json(self.path/'research_registry.json')
        self.annotations=read_jsonl(self.path/'analysis_targets.jsonl')
        self.profiles={p['company_id']:p for p in read_jsonl(self.path/'profiles.jsonl')}

    def check(self):
        validate_research(self.annotations,self.events,self.registry,self.profiles)

    def test_current_and_previous_bundles_verify(self):
        self.assertEqual(verify_bundle(self.path)['rows'],480)
        self.assertEqual(verify_bundle(ROOT/'training_v1/bundle')['rows'],480)

    def test_filter_preserves_frozen_splits_and_revision_history(self):
        old={r['pair_id']:r for r in read_jsonl(ROOT/'training_v1/bundle/all.jsonl')}
        rows=read_jsonl(self.path/'all.jsonl')
        allowed=read_jsonl(self.path/'eligible.jsonl')
        quarantined=read_jsonl(self.path/'quarantine.jsonl')
        self.assertEqual(len(allowed),323)
        self.assertEqual(len(quarantined),157)
        self.assertEqual(sum(r['label']!=r['prior_label'] for r in rows),34)
        self.assertEqual({r['pair_id'] for r in rows},set(old))
        for row in rows:
            self.assertEqual(row['dataset_split'],old[row['pair_id']]['dataset_split'])
            self.assertEqual(row['prior_label'],old[row['pair_id']]['label'])
        self.assertEqual(allowed,[r for r in rows if r['training_eligible']])
        self.assertEqual(quarantined,[r for r in rows if not r['training_eligible']])
        self.assertEqual({a['label_origin'] for a in self.annotations},{'ai'})

    def test_unregistered_source_and_wrong_event_reference_rejected(self):
        self.annotations[0]['research']['citations'][0]['source_id']='nonexistent'
        with self.assertRaisesRegex(ValueError,'Unknown evidence'):self.check()
        self.annotations[0]['research']['citations'][0]['source_id']='S01'
        with self.assertRaisesRegex(ValueError,'Event fact'):self.check()

    def test_invented_company_exposure_rejected(self):
        self.annotations[0]['research']['profile_facts']['foreign_trade']={'has_fts':True,'trade_direction':'export'}
        with self.assertRaisesRegex(ValueError,'differs from company profile'):self.check()

    def test_unknown_effect_cannot_be_replaced_with_number_or_zero(self):
        for value in (0,10000):
            self.annotations[0]['research']['outcome']['magnitude']=value
            with self.assertRaisesRegex(ValueError,'No observed outcome'):self.check()

    def test_candidates_cannot_invent_effectiveness_or_references(self):
        self.registry['action_candidates'][0]['effectiveness']=.7
        with self.assertRaisesRegex(ValueError,'must not invent'):validate_registry(self.registry)
        self.registry['action_candidates'][0]['effectiveness']=None
        self.annotations[0]['research']['candidate_action_ids']=['made_up']
        with self.assertRaisesRegex(ValueError,'Unknown action'):self.check()

    def test_eligibility_cannot_override_source_quarantine(self):
        row=next(a for a in self.annotations if 'news_source_not_fully_read' in a['exclusion_reasons'])
        row['training_eligible']=True;row['exclusion_reasons']=[]
        with self.assertRaisesRegex(ValueError,'Eligibility differs'):self.check()

    def test_ai_revision_cannot_claim_independent_expert_origin(self):
        self.annotations[0]['label_origin']='human'
        with self.assertRaisesRegex(ValueError,'impersonate'):self.check()

    def test_quarantine_guard_covers_both_training_entry_points(self):
        # Synthetic unit rows only; fitting must fail before any optimization.
        rows=training_rows();rows[0]['training_eligible']=False
        for function in (fit,train_ranker):
            with self.assertRaisesRegex(ValueError,'Quarantined'):function(rows,iterations=1)
        rows[0].pop('training_eligible');rows[0]['rubric_version']='relevance-evidence-v2'
        with self.assertRaisesRegex(ValueError,'explicit eligibility'):assert_training_eligible(rows)

    def test_hold_is_not_annotated_as_rate_cut(self):
        e=next(e for e in self.events if e['event_id']=='cbr_rate_20260911')
        self.assertEqual(e['research_context']['announced_rate_change_pp'],0)
        self.assertEqual(e['sources'][0]['verification_method'],'primary_page')
        self.assertTrue(all(a['label']==1 for a in self.annotations if a['event_id']==e['event_id']))
        self.assertTrue(all(a['research']['outcome']['direction']=='unknown' for a in self.annotations))


if __name__=='__main__':unittest.main()
