// cl100k_base token counting via gpt-tokenizer (pure JS, no WASM), loaded lazily from CDN.
// Counts are approximate across models; caller also reserves message framing.

const CDNS = [
  "https://esm.sh/gpt-tokenizer@2",
  "https://cdn.jsdelivr.net/npm/gpt-tokenizer@2/+esm",
];

export function createTokenizer({ importer = (url) => import(url), now = () => Date.now() } = {}) {
  let modPromise = null, retryAfter = 0, attempts = 0, ready = false;
  function loadTokenizer() {
    if (now() < retryAfter) return Promise.reject(new Error("Tokenizer retry is cooling down."));
    if (!modPromise) {
      const attempt = attempts++;
      modPromise = (async () => {
        let lastErr;
        for (const url of CDNS) {
          try {
            // Browsers can cache a failed module import by its URL.
            const mod = await importer(attempt ? `${url}?nera_retry=${attempt}` : url);
            if (typeof mod.countTokens !== "function" && typeof mod.encode !== "function") {
              throw new Error("Tokenizer module has no encoder.");
            }
            ready = true;
            return mod;
          } catch (error) { lastErr = error; }
        }
        throw lastErr ?? new Error("Failed to load tokenizer from all CDNs");
      })().catch((error) => {
        modPromise = null;
        retryAfter = now() + 30000;
        throw error;
      });
    }
    return modPromise;
  }
  return {
    tokenizerReady: () => ready,
    tokenizerStatus:()=>ready ? 'ok' : retryAfter ? 'fallback' : 'loading',
    async countTokens(text) {
      if (!text) return 0;
      try {
        const mod = await loadTokenizer();
        const n = typeof mod.countTokens === "function" ? mod.countTokens(text) : mod.encode(text).length;
        return Math.ceil(n * 1.02);
      } catch {
        if (ready) { ready=false; modPromise=null; retryAfter=now()+30000; }
        // Conservative across languages; never cache this as a tokenizer result.
        return new TextEncoder().encode(text).length;
      }
    },
  };
}

const tokenizer = createTokenizer();
export const countTokens = tokenizer.countTokens;
export const tokenizerReady = tokenizer.tokenizerReady;

export const tokenizerStatus=tokenizer.tokenizerStatus;
