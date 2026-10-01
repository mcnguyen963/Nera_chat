// cl100k_base token counting via gpt-tokenizer (pure JS, no WASM), loaded lazily from CDN.
// Counts are approximate across models; caller also reserves message framing.

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
    // Byte count is deliberately conservative for byte-based tokenizers.
    // A four-characters-per-token fallback can badly undercount non-ASCII text.
    return new TextEncoder().encode(text).length;
  }
}
