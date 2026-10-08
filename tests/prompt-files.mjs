import { readFile } from 'node:fs/promises';

export function promptImportMeta(meta, module) {
  meta.url = new URL('../js/'+module.identifier, import.meta.url).href;
}

export async function promptFetch(url) {
  try {
    const text = await readFile(url, 'utf8');
    return { ok:true, status:200, text:async () => text };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { ok:false, status:404 };
  }
}
