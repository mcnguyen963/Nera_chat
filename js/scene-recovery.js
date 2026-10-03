import { prompts } from './system-prompts.js';
import { chatCompletion } from './llm-client.js';
import { countTokens } from './tokenizer.js';
import { sceneLine, validateSceneValues } from './scene.js';
export const SCENE_RECOVERY_FORMAT = { type:'json_schema',json_schema:{ name:'scene_recovery',strict:true,
  schema:{ type:'object',additionalProperties:false,properties:{ date:{ type:'string' },time:{ type:'string' },
    place:{ type:'string' },present:{ type:'array',items:{ type:'string' } },planThread:{ type:['string','null'] } },
    required:['date','time','place','present','planThread'] } } };

export function recoveryMessages({ narration,userText,prior,names,plan }) {
  return [{ role:'system',content:prompts.sceneRecovery },{ role:'user',content:JSON.stringify({
    priorScene:prior?.scene ?? null,currentUserInput:userText,narration,canonicalNames:names,
    fixedPlanActive:!!plan?.trim(),pendingPlan:plan?.trim() || null }) }];
}
export function parseRecovery(text, context) {
  const obj = JSON.parse(text);
  const keys = ['date','time','place','present','planThread'];
  if (!obj || Array.isArray(obj) || Object.keys(obj).length !== keys.length || Object.keys(obj).some(k => !keys.includes(k))
    || !['date','time','place'].every(k => typeof obj[k] === 'string') || !Array.isArray(obj.present)
    || obj.present.some(n => typeof n !== 'string' || !n.trim()) || obj.present.length > 50
    || !(obj.planThread === null || typeof obj.planThread === 'string' && obj.planThread.length <= 500)) throw new Error('Invalid scene recovery JSON.');
  if (context.names?.length && obj.present.some(n => !context.names.includes(n))) throw new Error('Scene recovery used an unknown character name.');
  const checked = validateSceneValues(sceneLine(obj),{ narration:context.narration,userText:context.userText,prior:context.prior?.scene });
  return { ...checked,sceneMeta:{ ...checked.sceneMeta,kind:'inferred' },
    planThread:context.plan?.trim() ? obj.planThread : null };
}
export async function recoverScene(settings, context, { signal } = {}) {
  const messages = recoveryMessages(context), maxResponseTokens = 1500;
  const tokens = 24+(await Promise.all(messages.map(m => countTokens(m.content)))).reduce((n,t) => n+t,0);
  if (tokens+maxResponseTokens > settings.maxContextTokens) throw new Error('Scene recovery input exceeds the context budget.');
  const isOpenRouter = /^https:\/\/openrouter\.ai\//.test(settings.endpoint);
  const result = await chatCompletion({ settings:{ ...settings,modelId:context.model || settings.modelId,streaming:false,
    advancedParametersEnabled:false,maxResponseTokens,reasoning:{ ...settings.reasoning,enabled:false } },messages,signal,
    responseFormat:SCENE_RECOVERY_FORMAT,provider:isOpenRouter ? { require_parameters:true,max_price:{ prompt:1,completion:2,request:0.001 } } : undefined });
  return parseRecovery(result.content,context);
}
