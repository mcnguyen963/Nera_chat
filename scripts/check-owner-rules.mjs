import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function assertConfiguredOwner(rules) {
  if (rules.includes('OWNER_UID_HERE')) throw new Error('Set the approved owner UID in firestore.rules before deploying. See RELEASE.md.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assertConfiguredOwner(await readFile(new URL('../firestore.rules',import.meta.url),'utf8'));
  } catch (error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
