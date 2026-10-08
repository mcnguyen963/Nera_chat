// cl100k_base token counting via gpt-tokenizer (pure JS, no WASM), vendored at exact version 2.9.0 and loaded lazily.
// Counts are approximate across models; caller also reserves message framing.

const VENDOR = './vendor/gpt-tokenizer-2.9.0.js';
// Literal imports allow the release assembler to stamp every module URL.
const importVendor = (_url, attempt) => attempt
  ? import(`./vendor/gpt-tokenizer-2.9.0.js?nera_retry=${attempt}`)
  : import('./vendor/gpt-tokenizer-2.9.0.js');

export function createTokenizer({ importer = importVendor, now = () => Date.now() } = {}) {
  let modPromise = null, retryAfter = 0, attempts = 0, ready = false;
  function loadTokenizer() {
    if (now() < retryAfter) return Promise.reject(new Error("Tokenizer retry is cooling down."));
    if (!modPromise) {
      const attempt = attempts++;
      modPromise = (async () => {
        // Browsers can cache a failed module import by its URL.
        const mod = await importer(attempt ? `${VENDOR}?nera_retry=${attempt}` : VENDOR, attempt);
        if (typeof mod.countTokens !== "function" && typeof mod.encode !== "function") {
          throw new Error("Tokenizer module has no encoder.");
        }
        ready = true;
        return mod;
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
