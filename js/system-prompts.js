// Prompt text lives only in Markdown. Resolve relative to this module for Pages subpaths.
const files = {
  "legacyNarratorHashes": "legacy-narrator-default-hashes.md",
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
  "emptyPlan": "empty-plan.md",
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
