import type {Settings} from '../config.js';
import {ANALYSIS_PROMPT,QUESTION_PROMPT,PROMPT_VERSION} from './analysis-prompts.js';
/** Keep both live adapters on the same fingerprint. Bump executionVersion for replay-affecting code changes. */
export function executionConfiguration(s:Settings) {
 return {executionVersion:1,promptVersion:PROMPT_VERSION,analysisPrompt:ANALYSIS_PROMPT,questionPrompt:QUESTION_PROMPT,
  model:s.model,base:s.baseUrl,format:s.responseFormat,reasoning:s.reasoningEffort,maxOutput:s.maxOutputTokens,
  maxGeneration:s.generationMaxTokens,maxPlanning:s.maxPlanningTokens,maxContext:s.maxContextBytes,
  maxResponse:s.maxResponseBytes,strictMaxClaimString:s.strictMaxClaimString,extra:s.extraBody,strictExtra:s.strictExtraBody};
}
