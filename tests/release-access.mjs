import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertConfiguredOwner} from '../scripts/check-owner-rules.mjs';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
test('F11 the public app has sign-in and reset without registration entry points',async()=>{
  const [html,app,auth]=await Promise.all(['index.html','js/app.js','js/auth.js'].map(read));
  assert.doesNotMatch(html,/register-form|auth-register|Create an account|data-auth-view="register"/);
  assert.doesNotMatch(app,/\bregister\b/);
  assert.doesNotMatch(auth,/createUserWithEmailAndPassword|export\s+async\s+function\s+register\b/);
  assert.match(html,/id="login-form"/);assert.match(html,/id="reset-form"/);
});
test('F11 all existing Firestore grants require both an approved owner and the matching user tree',async()=>{
  const rules=await read('firestore.rules');
  assert.match(rules,/function isOwner\(\)\s*\{\s*return request\.auth != null && request\.auth\.uid (?:== '[^']+'|in \['[^']+'(?:,\s*'[^']+')*\]);\s*\}/);
  assert.match(rules,/function owner\(uid\)\s*\{\s*return isOwner\(\) && request\.auth\.uid == uid;\s*\}/);
  for(const grant of rules.matchAll(/allow\s+[^:]+:\s*if\s+([^;]+);/g))assert.match(grant[1],/^owner\(uid\)/);
  assert.match(rules,/function locked\(s\)/);assert.match(rules,/loreGenerationsDeleted/);assert.match(rules,/request\.resource\.data\.schemaVersion == 3/);
});
test('F11 deployment guard rejects the placeholder and permits configured single or multiple owners',async()=>{
  const rules=await read('firestore.rules');
  assert.throws(()=>assertConfiguredOwner("request.auth.uid == 'OWNER_UID_HERE'"),/owner UID.*before deploying/);
  assert.doesNotThrow(()=>assertConfiguredOwner(rules.replaceAll('OWNER_UID_HERE','demo-owner')));
  assert.doesNotThrow(()=>assertConfiguredOwner("request.auth.uid in ['demo-owner','demo-second']"));
});
test('F12 rules deploy from the repository root and deployment refuses an unconfigured owner',async()=>{
  const config=JSON.parse(await read('firebase.json'));
  assert.equal(config.firestore.rules,'firestore.rules');
  assert.ok(config.firestore.predeploy.includes('node scripts/check-owner-rules.mjs'));
  const workflow=await read('.github/workflows/deploy.yml');
  assert.match(workflow,/cp index\.html _site\//);
  assert.doesNotMatch(workflow,/cp\s+(?:-\S+\s+)?(?:firebase\.json|RELEASE\.md|firestore\.rules)/);
});
