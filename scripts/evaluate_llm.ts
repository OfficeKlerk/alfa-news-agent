import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadSettings } from '../server/config.js';
import { Store } from '../server/db.js';
import { generatePrepared } from '../server/integration/prepared-agent.js';
import { evaluationCases, referenceDraft, evaluateResult, REVIEW_CRITERIA } from '../server/integration/evaluation.js';
import { PROMPT_VERSION } from '../server/integration/analysis-prompts.js';
import { ModelError } from '../server/types.js';
const args = process.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
if (args.some(a => a.startsWith('--') && !['--live','--out','--review'].includes(a))) throw new Error('Usage: npm run llm:evaluate -- [--live] [--out file] [--review report.json]');
const reviewFile = value('--review');
if (reviewFile) {
  const report = JSON.parse(readFileSync(reviewFile, 'utf8'));
  const expected = evaluationCases().map(c => c.id);
  if(!['live','offline_reference'].includes(report.execution) || report.cases.length !== expected.length
    || new Set(report.cases.map((c: any) => c.case_id)).size !== expected.length
    || !expected.every(id => report.cases.some((c: any) => c.case_id === id))) throw new Error('Нужен полный отчёт по всем пяти сценариям');
  const { createHash } = await import('node:crypto');
  let accepted = 0;
  for (const result of report.cases) {
    const fingerprint = createHash('sha256').update(JSON.stringify({ input: result.input, analysis: result.analysis })).digest('hex');
    if (result.mechanical_checks !== 'passed' || fingerprint !== result.content_sha256) throw new Error('Повторите оценку: содержимое результата изменено или механическая проверка не пройдена');
    const { prepareContext } = await import('../server/integration/context.js');
    const { validateGrounding, analysisDraft } = await import('../server/integration/grounding.js');
    validateGrounding(analysisDraft(result.analysis), prepareContext(result.input), true);
    for (const criterion of REVIEW_CRITERIA) {
      const r = result.review?.[criterion];
      if (!r || !Number.isInteger(r.score) || r.score < 0 || r.score > 2 || typeof r.evidence !== 'string' || !r.evidence.trim()) throw new Error(`Заполните score (0–2) и evidence: ${result.case_id}/${criterion}`);
    }
    result.semantic_review = REVIEW_CRITERIA.every(c => result.review[c].score === 2) ? 'accepted_by_reviewer' : 'needs_revision';
    if(result.semantic_review === 'accepted_by_reviewer') accepted++;
  }
  if (!report.reviewer?.trim() || !report.comparison_review?.trim()) throw new Error('Заполните reviewer и comparison_review (различия ответов на одну новость для двух компаний)');
  report.review_summary = { accepted, total: report.cases.length,
    external_llm_quality: report.execution === 'live' ? 'human_review_recorded' : 'not_evaluated_reference_outputs_only' };
  report.external_llm_quality = report.review_summary.external_llm_quality;
  writeFileSync(reviewFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`Ревью сохранено: ${accepted}/${report.cases.length}. ${report.review_summary.external_llm_quality}`);
} else {
  const live = args.includes('--live'), settings = loadSettings();
  if(live && !settings.apiKey.trim()) throw new Error('Для --live укажите ключ локально в .env; не передавайте его в чат');
  const out = resolve(value('--out') ?? `var/llm-evaluation/${live ? 'live' : 'offline'}.json`);
  mkdirSync(dirname(out), {recursive:true});
  // Isolated call ledger keeps evaluation out of product history. Daily local counter still applies to this database only.
  const db = live ? new Store({...settings, dbPath:resolve('var/llm-evaluation/calls.sqlite3')}) : null;
  db?.connection.exec('CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY,day TEXT,model TEXT,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0)');
  const report = { execution:live ? 'live' : 'offline_reference', prompt_version:PROMPT_VERSION,
    model:live ? settings.model : null, created_at:new Date().toISOString(), reviewer:'', comparison_review:'',
    external_llm_quality: 'not_evaluated', cases:[] as any[] };
  const { createHash } = await import('node:crypto');
  let failed = false;
  try {
    for(const test of evaluationCases()) {
      try {
        const analysis = live ? (await generatePrepared(settings, db!, test.input, 'eval-' + test.id)).data : referenceDraft(test);
        const result = evaluateResult(test,analysis);
        report.cases.push({...result, content_sha256:createHash('sha256').update(JSON.stringify({input:result.input,analysis:result.analysis})).digest('hex')});
        console.log(test.id + ': mechanical checks passed; semantic review pending');
      } catch (error) {
        failed = true;
        report.cases.push({case_id:test.id,mechanical_checks:'failed',semantic_review:'not_run',error:error instanceof Error ? error.message : 'Evaluation failed',
          ...(error instanceof ModelError && error.diagnostics ? {diagnostics:error.diagnostics} : {})});
        console.log(test.id + ': failed');
        // Authentication/quota/transport failures should not burn calls on the remaining cases.
        if(live) break;
      } finally { writeFileSync(out, JSON.stringify(report,null,2) + '\n'); }
    }
  } finally { db?.close(); }
  console.log('Отчёт: ' + out + '. Семантическое качество требует ручного ревью.');
  if(failed) process.exitCode = 1;
}
