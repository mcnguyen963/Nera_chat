import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampJavaScript, stampHTML, stampSite } from '../scripts/stamp-version.mjs';
import {appHarness} from './app-harness.mjs';

const version = '1234abcd';

for(const [current,next,banner]of [['1234abcd','1234abcd5678',false],['1234abcd','5678abcd',true],['local','5678abcd',false]])test(`version banner checks ${current} against ${next}`,async()=>{
 const elements=[],listeners={},node=tag=>({tag,children:[],append(...xs){this.children.push(...xs);},addEventListener(type,fn){this[type]=fn;}});let reads=0,reloads=0;
 const label=node('span'),doc={querySelector:selector=>selector.includes('nera-version')?{content:current}:{content:'2026-11-04'},getElementById:id=>id==='app-version'?label:elements.find(e=>e.id===id),createElement:node,body:{append:e=>elements.push(e)},addEventListener:(type,fn)=>listeners[type]=fn};
 const use=appHarness({globals:{document:doc,window:{addEventListener:(type,fn)=>listeners[type]=fn},location:{reload:()=>reloads++},fetch:async()=>{reads++;return {ok:true,json:async()=>({sha:next})};}}});
 (await use('version.js')).initVersion();await new Promise(r=>setImmediate(r));assert.equal(elements.length,banner?1:0);assert.equal(reads,current==='local'?0:1);
 if(banner){elements[0].children[0].click();assert.equal(reloads,1);await listeners.focus();await new Promise(r=>setImmediate(r));assert.equal(elements.length,1);}
});

test('release stamping accepts the real application tree and stamps every relative module reference',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nera-real-stamp-'));
 try{
  await cp(new URL('../js/',import.meta.url),join(root,'js'),{recursive:true});await cp(new URL('../index.html',import.meta.url),join(root,'index.html'));
  await stampSite(root,'1234abcd5678','2026-11-04T00:00:00.000Z');
  const walk=async path=>{for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await walk(file);else if(entry.name.endsWith('.js')){const text=await readFile(file,'utf8');assert.equal(stampJavaScript(text,version),text,file);}}};
  await walk(join(root,'js'));assert.match(await readFile(join(root,'js','boot.js'),'utf8'),/app\.js\?v=1234abcd/);
 }finally{await rm(root,{recursive:true,force:true});}
});
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
  assert.match(workflow,/node: '20'/);
  assert.match(workflow,/run: node scripts\/test-rerun\.mjs/);
  assert.match(workflow,/node: '24'/);assert.match(workflow,/REQUIRE_BROWSER: '1'/);
  assert.match(workflow,/find _site -name '\*\.d\.ts' -type f -delete/);
  assert.match(workflow,/build:\s+if: github.ref == 'refs\/heads\/main'\s+needs: \[static, test\]/);
  assert.match(workflow,/deploy:\s+if: github.ref == 'refs\/heads\/main'\s+needs: build/);
  assert.doesNotMatch(workflow,/if: github.ref == 'refs\/heads\/feature\//);
  assert.match(workflow,/node scripts\/stamp-version.mjs _site "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow,/branches: \[feature\/story-memory\]/);
});

test('release stamping versions worker URLs without changing unrelated URLs',()=>{
 const source="new Worker(new URL('./tokenizer-worker.js', import.meta.url), {type:'module'}); new URL('./image.png', import.meta.url);";
 assert.equal(stampJavaScript(source,version),source.replace('./tokenizer-worker.js','./tokenizer-worker.js?v='+version));
});
