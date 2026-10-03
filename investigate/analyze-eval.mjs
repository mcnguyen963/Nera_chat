import { readFile,writeFile } from 'node:fs/promises';
import { appHarness } from '../tests/app-harness.mjs';
const dir = new URL('./eval/',import.meta.url);
const calls = JSON.parse(await readFile(new URL('calls.json',dir),'utf8'));
const old = JSON.parse(await readFile(new URL('live/calls.json',import.meta.url),'utf8'));
const {jobs,histories} = JSON.parse(await readFile(new URL('fixtures.json',dir),'utf8'));
const records = (await readFile(new URL('./chat-history.jsonl',import.meta.url),'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const {session,lore} = records[0].nera;
const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async()=>[] },'tokenizer.js':{ countTokens:async s=>Math.ceil(new TextEncoder().encode(s).length/4) } } });
const scene = await use('scene.js'),review = await use('turn-review.js'),plan = await use('plan-parser.js');
const {buildContextForRequest} = await use('context-builder.js');
const details = [],groups = new Map();
for(const c of calls) {
  const key = `${c.model} / ${c.variant} / ${c.routing} / ${c.scenario}`;
  const g = groups.get(key) ?? {model:c.model,variant:c.variant,routing:c.routing,scenario:c.scenario,calls:0,complete:0,automaticPass:0,appLintClean:0,cost:0};
  groups.set(key,g);g.calls++;g.cost+=c.usage?.cost ?? 0;
  if(c.status!=='complete') continue;
  g.complete++;g.automaticPass+=c.automaticPass ? 1 : 0;
  const p = JSON.parse(await readFile(new URL(`${c.attempt}-${c.id}-${c.run}-parsed.json`,dir),'utf8'));
  if(c.scenario==='fallback') { details.push({id:c.id,run:c.run,recovered:p.recovered});continue; }
  const job = jobs.find(j=>j.scenario===c.scenario && j.variant===c.variant && j.routing===c.routing);
  const history = histories[c.scenario],current = scene.latestScene(history,Infinity,job.report.scene?.raw);
  const narration = plan.stripPlan(p.content),userText = history.at(-1).content;
  const warnings = c.scenario==='ooc' ? [] : [...review.lintPlayerAgency(narration,'Nera Veyrath'),...review.lintUnestablishedTime(narration,{prior:current.scene,userText})];
  g.appLintClean+=warnings.length===0 ? 1 : 0;
  const inspected = scene.inspectSceneOutput(p.content);
  const checked = inspected.scene ? scene.validateSceneValues(inspected.scene,{ narration,userText,prior:current.scene }) : null;
  const accepted = c.scenario==='ooc' ? {scene:null,sceneMeta:null} : warnings.length || !checked ? scene.carryScene(current) : checked;
  const assistant = { id:'eval-actual-'+c.attempt,role:'assistant',order:history.at(-1).order+1,content:narration,
    ...accepted,planThread:plan.extractPlanThread(p.content),ooc:c.scenario==='ooc',acceptance:warnings.length ? 'pending' : 'accepted',reviewWarnings:warnings };
  const next = await buildContextForRequest({...session,memory:{...session.memory,startingScene:job.report.scene?.raw,replyContract:'user'}},{
    narratorSystemPrompt:(await use('system-prompts.js')).prompts.narrator,maxContextTokens:120000,maxResponseTokens:15000,keepRecentMessagesAfterSummary:10 },{
    messages:[...history,assistant,{ id:'eval-next',role:'user',order:assistant.order+1,content:'Continue.' }],loreEntries:lore,requireLatestUser:true });
  details.push({id:c.id,run:c.run,automaticPass:c.automaticPass,criteria:c.criteria,currentAppWarnings:warnings,
    acceptedScene:accepted,normalizationWarnings:checked?.warnings ?? [],nextScene:next.report.scene,
    nextLoaded:next.report.loaded.filter(e=>['characters','locations'].includes(e.book)).map(e=>({ name:e.name,reason:e.reason })),
    nextWarnings:next.report.warnings,humanReview:'Automatic checks are not semantic proof; see resilience-report.md and saved-context-review.md.'});
}
const result = {providerCalls:calls.length,completed:calls.filter(c=>c.status==='complete').length,
  evalCost:calls.reduce((s,c)=>s+(c.usage?.cost??0),0),totalCost:[...old,...calls].reduce((s,c)=>s+(c.usage?.cost??0),0),
  unresolved:calls.filter(c=>!c.connectionFailure && !c.usage).map(c=>({id:c.id,reserve:c.reserve,status:c.status})),
  providers:[...new Set(calls.flatMap(c=>c.providers??[]))],groups:[...groups.values()],details};
await writeFile(new URL('results.json',dir),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,details:undefined},null,2));
