// Prompt text lives only in Markdown. Resolve relative to this module for Pages subpaths.
const files = {
  "rewrite": "rewrite.md",
  "memoryExtractionFrame": "memory-extraction-frame.md",
  "loreLabels": "lore-labels.md",
  "omittedTurnsPartialUncovered": "omitted-turns-partial-uncovered.md",
  "planStatusInactive": "plan-status-inactive.md",
  "planStatusActive": "plan-status-active.md",
  "sceneReminderPlan": "scene-reminder-plan.md",
  "sceneReminder": "scene-reminder.md",
  "noPlan": "no-plan.md",
  "planThread": "plan-thread.md",
  "omittedTurnsPartial": "omitted-turns-partial.md",
  "omittedTurnsSummary": "omitted-turns-summary.md",
  "omittedTurns": "omitted-turns.md",
  "legacySummary": "legacy-summary.md",
  "legacyFixedPlan": "legacy-fixed-plan.md",
  "legacyPlanPresence": "legacy-plan-presence.md",
  "legacyNoPlan": "legacy-no-plan.md",
  "legacyPlan": "legacy-plan.md",
  "legacyAuthorDirection": "legacy-author-direction.md",
  "legacyPromptHashes": "legacy-prompt-default-hashes.md",
  "narrator": "narrator.md",
  "summarizer": "summarizer.md",
  "authorDirection": "author-direction.md",
  "continuity": "continuity.md",
  "scene": "scene.md",
  "replyContract": "reply-contract.md",
  "sceneRecovery": "scene-recovery.md",
  "memoryExtraction": "memory-extraction.md",
  "memoryReorganize": "memory-reorganize.md",
  "lorebookMarkdown": "lorebook-conversion-markdown.md",
  "lorebookJson": "lorebook-conversion-json.md",
  "memoryExtractionOutput": "memory-extraction-output.md",
  "plan": "fixed-author-plan.md",
  "summaryOutput": "summary-output.md",
  "historicalSummary": "historical-summary.md",
  "openingExchange": "opening-exchange.md",
  "memoryHeader": "memory-header.md",
  "factsHeader": "world-facts-header.md",
  "eventsHeader": "story-memory-header.md",
  "knownNamesHeader": "known-names-header.md",
  "reorganizeSection": "memory-reorganize-section.md",
  "reorganizeCanon": "memory-reorganize-canon.md"
};

export async function loadPrompt(filename) {
  const url = new URL('../system prompts/'+filename, import.meta.url);
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Failed to load system prompt '+filename+': HTTP '+response.status);
  const text = (await response.text()).replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!text.trim()) throw new Error('System prompt is empty: '+filename);
  return text;
}

export const prompts = Object.freeze(Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, filename]) => [key, await loadPrompt(filename)]))
));

export function renderPrompt(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

// Small label templates keep all text sent to models in editable Markdown.
export const loreLabels = Object.freeze(Object.fromEntries(prompts.loreLabels.split('\n').map(line => {
  const match = line.match(/^([a-zA-Z]+): (.*)$/);
  if (!match) throw new Error('Invalid lore label template: '+line);
  return [match[1],match[2]];
})));
export function renderLoreLabel(key, values = {}) {
  if (!Object.hasOwn(loreLabels,key)) throw new Error('Missing lore label template: '+key);
  return renderPrompt(loreLabels[key],values);
}
