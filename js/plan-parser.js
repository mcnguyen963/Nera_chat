// <plan>...</plan> tag handling (spec §11).
// The tag is emitted by the model anywhere in its reply; the app extracts it,
// saves it as the session's long-term plan, and strips it from visible content.

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

export function stripPlan(text) {
  if (!text) return "";
  return stripPlanThread(
    text
      .replace(/<(plan|plan_thread)>[\s\S]*?<\/\1>\s*/gi, "")
      .replace(/<(plan|plan_thread)>[\s\S]*$/gi, "")
      .replace(/<(?:p|pl|pla|plan|plan_|plan_t|plan_th|plan_thr|plan_thre|plan_threa|plan_thread)?$/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function planInjectionBlock(plan) {
  return (
    "Current long-term plan (update it by including a new <plan>...</plan> block in your reply " +
    "if it changes; omit the tag to leave it unchanged):\n" +
    (plan && plan.trim() ? plan : "(no plan yet)")
  );
}
