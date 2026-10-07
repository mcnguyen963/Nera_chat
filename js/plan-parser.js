import { readSceneOutput } from './scene-parser.js';
import { prompts, renderPrompt } from './system-prompts.js';
export const LEGACY_PLAN_LOSS_RULE = /\s*If, at the start of a turn, neither a <plan> block nor a <plan_thread> line appears[\s\S]*?until the user sets a new one\./g;
// <plan>...</plan> tag handling (spec §11).
// The tag is emitted by the model anywhere in its reply; the app extracts it,
// strips it from visible content. Model output never changes the fixed author plan.

export function extractPlan(text) {
  if (!text) return null;
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  return m ? m[1].trim() : null;
}

export function extractPlanThread(text) {
  if (!text) return null;
  const m = text.match(/<plan_thread>([\s\S]*?)<\/plan_thread>/i);
  return m ? m[1].trim() : null;
}

export function stripPlanThread(text) {
  if (!text) return "";
  return text
    .replace(/<plan_thread>[\s\S]*?<\/plan_thread>\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const hiddenPrefixes = new RegExp('<(?:' + [...new Set(['plan', 'plan_thread', 'scene'].flatMap(tag => Array.from({ length: tag.length }, (_, i) => tag.slice(0, i+1))))].join('|') + ')?$', 'i');

export function stripPlan(text, { final = false } = {}) {
  if (final) return readSceneOutput(text).clean;
  if (!text) return "";
  return stripPlanThread(
    text
      .replace(/<(plan|plan_thread|scene)>[\s\S]*?<\/\1>\s*/gi, "")
      .replace(/<(plan|plan_thread|scene)>[\s\S]*$/gi, "")
      .replace(hiddenPrefixes, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function planInjectionBlock(plan) {
  return plan?.trim() ? renderPrompt(prompts.plan,{PLAN:plan}) : prompts.noPlan;
}
