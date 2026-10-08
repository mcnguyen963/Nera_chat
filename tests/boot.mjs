import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

test('Startup failures show their cause and Reload; successful imports leave the page alone', async () => {
  const api = await appHarness({ globals:{ console:{ error() {} } } })('boot-core.js');
  const boxes = [], doc = { body:{ prepend:box => boxes.push(box) }, createElement:() => ({ append(...children) { this.children=children; }, setAttribute() {}, addEventListener(_, fn) { this.click=fn; } }) };
  assert.equal(await api.startApp({ load:async () => {},doc }),true);
  assert.equal(boxes.length,0);
  let reloads = 0;
  assert.equal(await api.startApp({ load:async () => { throw new Error('scene.md: HTTP 404'); },doc,reload:() => reloads++ }),false);
  assert.equal(boxes[0].children[1].textContent,'scene.md: HTTP 404');
  boxes[0].children[3].click(); assert.equal(reloads,1);
});

test('Viewport ignores pinch zoom and keeps the keyboard offset at normal scale', async () => {
  const { viewportVars } = await appHarness()('viewport.js');
  assert.equal(viewportVars({ scale:1.5,height:300,offsetTop:40 }),null);
  assert.deepEqual({...viewportVars({ scale:1,height:450,offsetTop:30 })},{height:'450px',offsetTop:'30px'});
  assert.equal(viewportVars({ scale:1,height:0 }),null);
});
