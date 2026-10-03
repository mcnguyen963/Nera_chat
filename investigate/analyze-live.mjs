import { readFile, writeFile } from 'node:fs/promises';
import { appHarness } from '../tests/app-harness.mjs';

const dir = new URL('./live/',import.meta.url);
const registry = JSON.parse(await readFile(new URL('calls.json',dir),'utf8'));
const use = appHarness({ globals:{ console:{ log() {} } } });
const scene = await use('scene.js'), plan = await use('plan-parser.js');
for (const call of registry.filter(x => !x.connectionFailure)) {
  const name = `${call.attempt}-${call.action}`;
  let raw;
  try { raw = await readFile(new URL(name+'-response.txt',dir),'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const request = JSON.parse(await readFile(new URL(name+'-request.json',dir),'utf8'));
  const events = raw.split(/\r?\n/).filter(x => x.startsWith('data:'))
    .map(x => x.slice(5).trim()).filter(x => x !== '[DONE]').map(x => JSON.parse(x));
  call.responseIds = [...new Set(events.map(x => x.id).filter(Boolean))];
  call.returnedModels = [...new Set(events.map(x => x.model).filter(Boolean))];
  call.providers = [...new Set(events.map(x => x.provider).filter(Boolean))];
  call.finishReasons = [...new Set(events.flatMap(x => x.choices ?? []).map(x => x.finish_reason).filter(Boolean))];
  call.usage = events.findLast(x => x.usage)?.usage ?? null;
  const transport = appHarness({ globals:{ console:{ log() {} },fetch:async () => new Response(raw) } });
  try {
    const reply = await (await transport('llm-client.js')).chatCompletion({ settings:{ endpoint:'fixture',apiKey:'fixture',
      modelId:request.model,streaming:true,maxResponseTokens:request.max_tokens },messages:request.messages });
    const extracted = scene.extractScene(reply.content);
    const inspected = scene.inspectSceneOutput(reply.content);
    const visible = plan.stripPlan(reply.content);
    const userText = request.messages.at(-1).content.split('</memory>').at(-1).trim();
    const ooc = scene.isPureOoc(userText);
    const result = { ...reply,scene:extracted ? scene.parseScene(extracted) : null,
      appClassifiesOoc:ooc,appSavedScene:ooc ? null : inspected.scene,sceneContractWarning:inspected.warning,
      planThread:plan.extractPlanThread(reply.content),visibleWords:visible.trim().split(/\s+/).length,
      sceneTagCount:[...reply.content.matchAll(/<scene>/gi)].length,
      legacyHiddenReport:/<!--HIDDEN-->|\[Scene:/i.test(reply.content),
      requiresHumanReview:['player agency','source knowledge','attendance consistent with visible events','location/time evidence'] };
    await writeFile(new URL(name+'-parsed.json',dir),JSON.stringify(result,null,2)+'\n');
    call.status='complete'; delete call.error;
    call.scene=result.scene; call.visibleWords=result.visibleWords; call.sceneTagCount=result.sceneTagCount;
    call.hasPlanThread=!!result.planThread; call.legacyHiddenReport=result.legacyHiddenReport;
    call.appClassifiesOoc=ooc; call.appSavedScene=result.appSavedScene;
  } catch (error) { call.status='response-error'; call.error=error.message; }
}
await writeFile(new URL('calls.json',dir),JSON.stringify(registry,null,2)+'\n');
console.log(JSON.stringify(registry.filter(x => !x.connectionFailure).map(x => ({
  call:x.number,scenario:x.action,status:x.status,providers:x.providers,finishReasons:x.finishReasons,
  scene:x.scene,appSavedScene:x.appSavedScene,words:x.visibleWords,cost:x.usage?.cost })),null,2));
