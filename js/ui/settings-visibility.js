// Presentation only: feature switches and stored values retain their meaning.
export function settingsVisibility({mode = 'classic', memory = {}, endpoint = '', autoSummary = false, streaming = false} = {}) {
  const director = mode === 'director';
  return {
    director, classic:!director,
    memoryPrompts:memory.lorebooks === true || memory.autoUpdate === true,
    lore:memory.lorebooks === true,
    autoUpdate:memory.autoUpdate === true,
    memoryBlock:memory.memoryBlock === true,
    historyRecall:memory.historyRecall === true,
    sceneFallback:memory.scene === true && memory.sceneFallback === true,
    // Existing semantic settings can stay enabled when reply lore is off.
    // Keep their switch and connection accessible so they can be changed.
    semanticControl:memory.lorebooks === true || memory.autoUpdate === true || memory.semanticLore === true,
    semanticLore:memory.semanticLore === true,
    embeddings:memory.semanticLore === true || memory.historyRecall === true && memory.semanticRecall === true,
    openRouter:/^https?:\/\/openrouter\.ai(?:[/:]|$)/i.test(endpoint.trim()),
    autoSummary, streaming,
    ...Object.fromEntries(['characters','locations','facts','events','plan'].map(book => ['book-'+book,memory.lorebooks === true && memory.books?.[book]?.on !== false])),
  };
}

export function applySettingsVisibility(root, visible) {
  for (const group of root.querySelectorAll('[data-settings-when]')) {
    group.hidden = !visible[group.dataset.settingsWhen] && group.dataset.settingsReview !== 'true';
  }
}
