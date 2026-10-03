import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { promptFetch, promptImportMeta } from './prompt-files.mjs';

// Load the real browser modules without Firebase, a browser, or a CDN tokenizer.
export function appHarness({ stubs = {}, sources = {}, globals = {} } = {}) {
  const cache = new Map();
  const context = vm.createContext({ URL, fetch:promptFetch, console, structuredClone,
    TextEncoder, TextDecoder, Date, Map, Set, AbortController, setTimeout, clearTimeout, ...globals });
  async function load(path) {
    if (cache.has(path)) return cache.get(path);
    const pending = create(path); cache.set(path, pending); return pending;
  }
  async function create(path) {
    const stub = stubs[path];
    const module = stub
      ? new vm.SyntheticModule(Object.keys(stub), function () {
        for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
      }, { context, identifier:path })
      : new vm.SourceTextModule(sources[path] ?? await readFile(new URL('../js/'+path, import.meta.url), 'utf8'),
        { context, identifier:path, initializeImportMeta:promptImportMeta });
    await module.link((specifier, parent) => load(specifier.startsWith('https:') ? specifier
      : new URL(specifier, 'https://local/'+parent.identifier).pathname.slice(1)));
    return module;
  }
  return async path => {
    const module = await load(path);
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
  };
}
