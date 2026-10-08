// The configured input limit is independent of output. When the model's
// total window is known, reserve output against that separate capacity.
export function requestInputLimit(settings) {
  const total = settings.modelContextTokens;
  const limit = Number.isFinite(total) && total > 0
    ? Math.min(settings.maxContextTokens, total - settings.maxResponseTokens)
    : settings.maxContextTokens;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("The model context window leaves no room for input. Lower Max response tokens or correct the model context size.");
  }
  return limit;
}

export const MESSAGE_FRAME_TOKENS=8;
export const REQUEST_FRAME_TOKENS=8;
