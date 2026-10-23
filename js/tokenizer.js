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

// One worker serves all callers. A failed/stalled worker settles every request;
// estimates remain uncached and a later request retries after the cooldown.
export function createWorkerTokenizer({
  spawn = () => new Worker(new URL('./tokenizer-worker.js', import.meta.url), {type:'module'}),
  now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let worker=null, serial=0, ready=false, retryAfter=0;
  const pending=new Map();
  const estimate=text=>{let n=0;for(const ch of text)n+=ch.codePointAt(0)<128?0.3:1;return Math.ceil(n*1.02);};
  function fail(source) {
    if (source!==worker) return;
    worker?.terminate(); worker=null; ready=false; retryAfter=now()+30000;
    for (const job of pending.values()) { cancel(job.timer); job.resolve(estimate(job.text)); }
    pending.clear();
  }
  function connect() {
    if (worker) return worker;
    const source=spawn(); worker=source;
    source.onmessage=({data})=>{
      if (source!==worker) return;
      const job=pending.get(data?.id);
      if (!job) return;
      if (!Number.isFinite(data.count) || data.count<0) { fail(source); return; }
      pending.delete(data.id); cancel(job.timer); ready=data.ready===true;
      retryAfter=ready ? 0 : now()+30000;
      job.resolve(data.count);
    };
    source.onerror=()=>fail(source);
    source.onmessageerror=()=>fail(source);
    return source;
  }
  return {
    tokenizerReady:()=>ready,
    tokenizerStatus:()=>ready?'ok':retryAfter?'fallback':'loading',
    async countTokens(text) {
      if (!text) return 0;
      if (now()<retryAfter) return estimate(text);
      try {
        const source=connect(), id=++serial;
        return await new Promise(resolve=>{
          pending.set(id,{text,resolve,timer:schedule(()=>fail(source),30000)});
          try { source.postMessage({id,text}); } catch { fail(source); }
        });
      } catch { fail(worker); return estimate(text); }
    },
  };
}
// Node and worker contexts retain the injectable encoder used by offline tools.
// Browser failures never run the encoder synchronously on the UI thread.
const tokenizer = typeof document === 'undefined' ? createTokenizer() : createWorkerTokenizer();
export const countTokens = tokenizer.countTokens;
export const tokenizerReady = tokenizer.tokenizerReady;

export const tokenizerStatus=tokenizer.tokenizerStatus;
