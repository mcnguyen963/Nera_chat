import { prompts, renderPrompt } from './system-prompts.js';
export function replyContract(protagonist, plan) {
  return renderPrompt(prompts.replyContract,{ PROTAGONIST:protagonist || 'the player character',
    PLAN_STATUS:plan?.trim() ? 'The fixed author plan IS ACTIVE. Its future and pending items remain pending until established events or the user resolve them. Include one short <plan_thread> naming the immediate pending target; never output or revise <plan>.' : 'No fixed author plan is active. Omit <plan_thread>.' });
}
