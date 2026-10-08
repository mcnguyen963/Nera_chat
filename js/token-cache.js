// One bounded LRU for effective tokenizer counts. Byte fallbacks never enter it.
export function createTokenCounter({ count, ready, limit = 3000 }) {
  const cache = new Map();
  const counter = async text => {
    if (cache.has(text)) {
      const value = cache.get(text);
      cache.delete(text);
      cache.set(text, value);
      return value;
    }
    const value = await count(text);
    if (!ready()) return value;
    if (cache.size >= limit) cache.delete(cache.keys().next().value);
    cache.set(text, value);
    return value;
  };
  Object.defineProperty(counter, 'size', { get: () => cache.size });
  return counter;
}
