import {existsSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export async function findChrome({required=process.env.REQUIRE_BROWSER==='1'}={}) {
 const candidates=[process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
 for(const cache of [process.env.PLAYWRIGHT_BROWSERS_PATH,join(homedir(),'Library/Caches/ms-playwright'),join(homedir(),'.cache/ms-playwright')].filter(Boolean)) {
  for(const name of await readdir(cache).catch(()=>[]))if(/^chromium(?:_headless_shell)?-/.test(name))for(const binary of ['chrome-linux/chrome','chrome-linux64/chrome','chrome-headless-shell-linux64/chrome-headless-shell','chrome-mac/Chromium.app/Contents/MacOS/Chromium','chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-headless-shell-mac-arm64/chrome-headless-shell'])candidates.push(join(cache,name,binary));
 }
 const binary=candidates.find(path=>path&&existsSync(path));
 if(!binary&&required)throw Error('REQUIRE_BROWSER=1 but Chrome/Chromium was not found; set CHROME_BIN.');
 return binary;
}
