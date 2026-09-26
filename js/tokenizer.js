// cl100k_base token counting via gpt-tokenizer (pure JS, no WASM), loaded lazily from CDN.
// Counts are consistent approximations across models: rounded up + 2% safety margin
// so the estimate never under-counts (see spec §6.1).

const CDNS = [
  "https://esm.sh/gpt-tokenizer@2",
  "https://cdn.jsdelivr.net/npm/gpt-tokenizer@2/+esm",
];

let modPromise = null;

function loadTokenizer() {
  if (!modPromise) {
    modPromise = (async () => {
      let lastErr;
      for (const url of CDNS) {
        try {
          return await import(/* @vite-ignore */ url);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr ?? new Error("Failed to load tokenizer from all CDNs");
    })();
  }
  return modPromise;
}

export async function countTokens(text) {
  if (!text) return 0;
  try {
    const mod = await loadTokenizer();
    const n =
      typeof mod.countTokens === "function"
        ? mod.countTokens(text)
        : mod.encode(text).length;
    return Math.ceil(n * 1.02);
  } catch (e) {
    // Tokenizer unavailable: fall back to a rough character-based estimate (~4 chars/token).
    return Math.max(1, Math.ceil((text.length / 4) * 1.02));
  }
}
