import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampJavaScript, stampHTML, stampSite } from '../scripts/stamp-version.mjs';

const version = '1234abcd';
test('release stamping versions static, dynamic, side-effect and re-export relative modules', () => {
  const input = `import x from './x.js';\nimport "../init.js";\nexport {x} from './x.js';\nexport * from "./all.js";\nconst app = import('./app.js');\nconst fixed = import(\`./fixed.js\`);\nimport data from 'https://host/x.js';\n// import ignored from './comment.js'\nconst text = "import x from './quoted.js'";\nconst rx = /import x from 'a.js'/;`;
  const output = stampJavaScript(input,version);
  for (const path of ['./x.js','../init.js','./all.js','./app.js','./fixed.js']) assert.ok(output.includes(path+'?v='+version));
  assert.ok(output.includes("from 'https://host/x.js'"));
  assert.ok(output.includes("from './comment.js'"));
  assert.ok(output.includes("from './quoted.js'"));
  assert.equal(stampJavaScript(output,version),output);
});

test('release stamping preserves existing queries and handles fixed-path template retry imports', () => {
  assert.equal(stampJavaScript("import('./app.js?mode=1#anchor')",version),"import('./app.js?mode=1&v=1234abcd#anchor')");
  assert.equal(stampJavaScript('import(`./vendor/tokenizer.js?retry=${attempt}`)',version),'import(`./vendor/tokenizer.js?retry=${attempt}&v=1234abcd`)');
  assert.equal(stampJavaScript('import(`./vendor/tokenizer.js?retry=${attempt}&v=old`)',version),'import(`./vendor/tokenizer.js?retry=${attempt}&v=1234abcd`)');
  assert.throws(() => stampJavaScript('import(`./${name}.js`)',version),/cannot be versioned safely/);
  assert.throws(() => stampJavaScript('import(`./app.js?retry=${compute()}`)',version),/cannot be versioned safely/);
});

test('release stamping gives boot, CSS and running UI the same version', () => {
  const input = '<head><link rel="stylesheet" href="css/main.css"><script type="module" src="js/boot.js"></script></head>';
  const output = stampHTML(input,version,'2026-10-08T00:00:00.000Z');
  assert.ok(output.includes('href="css/main.css?v=1234abcd"'));
  assert.ok(output.includes('src="js/boot.js?v=1234abcd"'));
  assert.ok(output.includes('name="nera-version" content="1234abcd"'));
  assert.equal(stampHTML(output,version,'2026-10-08T00:00:00.000Z'),output);
  assert.throws(() => stampHTML('<head></head>',version,''),/Expected one boot module/);
});

test('site assembly versions nested vendor modules and writes a release manifest', async () => {
  const root = await mkdtemp(join(tmpdir(),'nera-version-'));
  try {
    await mkdir(join(root,'js','vendor'),{recursive:true});
    await writeFile(join(root,'index.html'),'<head><link href="css/style.css"><script src="js/boot.js"></script></head>');
    await writeFile(join(root,'js','boot.js'),"import('./app.js')");
    await writeFile(join(root,'js','vendor','index.js'),"export * from './encoding.js'");
    await stampSite(root,'1234abcd5678','2026-10-08T00:00:00.000Z');
    assert.equal(await readFile(join(root,'js','vendor','index.js'),'utf8'),"export * from './encoding.js?v=1234abcd'");
    assert.deepEqual(JSON.parse(await readFile(join(root,'version.json'),'utf8')),{sha:'1234abcd5678',builtAt:'2026-10-08T00:00:00.000Z'});
    await assert.rejects(stampSite(root,''),/valid.*SHA/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('CI tests each branch and deploys only main after the test gate', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  assert.match(workflow,/node-version: '20'/);
  assert.match(workflow,/node --experimental-vm-modules --test tests\/\*\.mjs/);
  assert.match(workflow,/build:\s+if: github.ref == 'refs\/heads\/main'\s+needs: test/);
  assert.match(workflow,/deploy:\s+if: github.ref == 'refs\/heads\/main'\s+needs: build/);
  assert.match(workflow,/node scripts\/stamp-version.mjs _site "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow,/branches: \[feature\/story-memory\]/);
});
