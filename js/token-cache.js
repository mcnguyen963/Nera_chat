// One bounded LRU for effective tokenizer counts. Transient fallback counts never enter it.
export function createTokenCounter({ count, ready, version = () => null, limit = 3000 }) {
  const cache = new Map();
  let epoch=version();
  const counter = async text => {
    const next=version();if(next!==epoch){cache.clear();epoch=next;}
    if (cache.has(text)) {
      const value = cache.get(text);
      cache.delete(text);
      cache.set(text, value);
      return value;
    }
    const value = await count(text);
    if (!ready() || next!==version()) return value;
    if (cache.size >= limit) cache.delete(cache.keys().next().value);
    cache.set(text, value);
    return value;
  };
  Object.defineProperty(counter, 'size', { get: () => cache.size });
  return counter;
}
