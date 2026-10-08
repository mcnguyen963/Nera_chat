import { prompts, renderPrompt } from './system-prompts.js';
export function replyContract(protagonist, plan) {
  return renderPrompt(prompts.replyContract,{ PROTAGONIST:protagonist || 'the player character',
    PLAN_STATUS:plan?.trim() ? prompts.planStatusActive : prompts.planStatusInactive });
}
