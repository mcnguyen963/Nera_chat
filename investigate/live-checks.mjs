import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { appHarness } from '../tests/app-harness.mjs';

const dir = new URL('./live/', import.meta.url);
const action = process.argv[2];
const actions = new Set(['baseline','candidate','progression','ooc','reminder','reminder-repeat','reminder-progression','reminder-ooc']);
if (!actions.has(action)) throw new Error('Choose one of the prepared investigation scenarios.');
const endpoint = process.env.NERA_INVESTIGATION_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const key = (process.env.NERA_INVESTIGATION_API_KEY || await readFile(new URL('../private/key.txt',import.meta.url),'utf8')).trim();
if (!key) throw new Error('No investigation key is available.');
await mkdir(dir, { recursive:true });
// Serialize runs so concurrent processes cannot overwrite the call ledger.
const lockPath = new URL('run.lock',dir);
const lock = await open(lockPath,'wx');
try {
const registryFile = new URL('calls.json',dir);
let registry;
try { registry = JSON.parse(await readFile(registryFile,'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; registry = []; }
const usedCalls = () => registry.filter(x => !x.connectionFailure).length;
const totalBudget = 0.5; // User raised the cumulative ceiling after the first six calls.
const spent = () => registry.reduce((sum,x) => sum+(x.connectionFailure ? 0 : x.usage?.cost ?? x.maxCostReserve ?? 0.1),0);
let body = action === 'baseline'
  ? await readFile(new URL('./LLM_request.txt',import.meta.url),'utf8')
  : await readFile(new URL('./'+(action === 'reminder' || action === 'reminder-repeat' ? 'next-experiment' : action)+'-request.json',import.meta.url),'utf8');
const request = JSON.parse(body);
// A price filter leaves :floor routing intact and bounds the reserve for each
// newly authorized call. It does not change messages or thinking parameters.
if (action.startsWith('reminder')) {
  request.provider = { ...request.provider,max_price:{ prompt:1,completion:2,request:0.001 } };
  body = JSON.stringify(request,null,2)+'\n';
}
const inputBytes = request.messages.reduce((n,m) => n+new TextEncoder().encode(m.content).length,1024);
const maxCostReserve = inputBytes/1000000+request.max_tokens*2/1000000+0.001;
// Two unchanged repetitions for baseline/candidate; one progression and one OOC.
const repetitions = ['baseline','candidate'].includes(action) ? 2 : 1;
const completed = registry.filter(x => x.action === action && x.status === 'complete').length;
if (completed >= repetitions) throw new Error('This scenario has already completed its planned calls.');
if (registry.some(x => x.action === action && !x.connectionFailure && x.status !== 'complete')) {
  throw new Error('Review the failed provider response before attempting another call.');
}
const hash = createHash('sha256').update(body).digest('hex');
const redact = value => String(value).split(key).join('[redacted]');
for (let repetition=completed+1; repetition<=repetitions; repetition++) {
  if (spent()+maxCostReserve > totalBudget) throw new Error('The remaining $0.50 budget cannot cover a conservative request reserve.');
  const call = { number:usedCalls()+1, attempt:registry.length+1, action, repetition, endpoint,
    requestHash:hash,totalBudget,spentBefore:spent(),maxCostReserve,startedAt:new Date().toISOString(), status:'started' };
  registry.push(call);
  await writeFile(registryFile,JSON.stringify(registry,null,2)+'\n');
  const name = `${call.attempt}-${action}`;
  await writeFile(new URL(name+'-request.json',dir),redact(body));
  console.log(`Call ${call.number}: ${action}, repetition ${repetition}; spent $${call.spentBefore.toFixed(6)} / $${totalBudget.toFixed(2)}.`);
  const start = Date.now();
  try {
    const res = await fetch(endpoint,{ method:'POST',headers:{ 'Content-Type':'application/json',Authorization:'Bearer '+key },
      body,signal:AbortSignal.timeout(600000) });
    call.statusCode = res.status;
    call.responseHeaders = Object.fromEntries([...res.headers].filter(([k]) => /^(?:content-type|x-request-id|cf-ray)$/.test(k)));
    let raw = '';
    if (res.body) {
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let lastUpdate = Date.now();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value,{ stream:true });
        if (Date.now()-lastUpdate > 25000) { console.log(`Call ${call.number}: receiving response (${Math.round((Date.now()-start)/1000)}s).`); lastUpdate = Date.now(); }
      }
      raw += decoder.decode();
    }
    await writeFile(new URL(name+'-response.txt',dir),redact(raw));
    call.durationMs = Date.now()-start;
    if (!res.ok) { call.status='http-error'; call.error=redact(raw); }
    else {
      const events = request.stream ? raw.split(/\r?\n/).filter(x => x.startsWith('data:'))
        .map(x => x.slice(5).trim()).filter(x => x !== '[DONE]').map(x => JSON.parse(x)) : [JSON.parse(raw)];
      call.responseIds = [...new Set(events.map(x => x.id).filter(Boolean))];
      call.returnedModels = [...new Set(events.map(x => x.model).filter(Boolean))];
      call.providers = [...new Set(events.map(x => x.provider).filter(Boolean))];
      call.finishReasons = [...new Set(events.flatMap(x => x.choices ?? []).map(x => x.finish_reason).filter(Boolean))];
      call.usage = events.findLast(x => x.usage)?.usage ?? null;
      const use = appHarness({ globals:{ console:{ log() {} },fetch:async () => new Response(raw,{ status:res.status }) } });
      const { chatCompletion } = await use('llm-client.js');
      const { extractScene, parseScene } = await use('scene.js');
      const { extractPlanThread, stripPlan } = await use('plan-parser.js');
      const settings = { endpoint,apiKey:key,modelId:request.model,maxResponseTokens:request.max_tokens,
        streaming:request.stream === true,advancedParametersEnabled:false,
        reasoning:{ enabled:!!request.reasoning,mode:'effort',effort:request.reasoning?.effort } };
      const reply = await chatCompletion({ settings,messages:request.messages });
      const scene = extractScene(reply.content);
      const visible = stripPlan(reply.content);
      const result = { content:reply.content, thinking:reply.thinking, scene:scene ? parseScene(scene) : null,
        planThread:extractPlanThread(reply.content), visibleWords:visible.trim().split(/\s+/).length,
        sceneTagCount:[...reply.content.matchAll(/<scene>/gi)].length,
        legacyHiddenReport:/<!--HIDDEN-->|\[Scene:/i.test(reply.content),
        requiresHumanReview:['player agency','source knowledge','attendance consistent with visible events','location/time evidence'] };
      await writeFile(new URL(name+'-parsed.json',dir),redact(JSON.stringify(result,null,2))+'\n');
      call.status='complete'; call.scene=result.scene; call.visibleWords=result.visibleWords;
      call.sceneTagCount=result.sceneTagCount; call.hasPlanThread=!!result.planThread; call.legacyHiddenReport=result.legacyHiddenReport;
    }
  } catch (error) {
    call.status=call.statusCode ? 'response-error' : 'network-error'; call.error=redact(error.message); call.durationMs=Date.now()-start;
    call.causeCode=error.cause?.code;
    call.connectionFailure=['ENOTFOUND','ECONNREFUSED','ENETUNREACH','EACCES','EPERM'].includes(call.causeCode);
  }
  call.finishedAt = new Date().toISOString();
  await writeFile(registryFile,redact(JSON.stringify(registry,null,2))+'\n');
  console.log(JSON.stringify({ call:call.number,status:call.status,http:call.statusCode,seconds:Math.round(call.durationMs/1000),
    scene:call.scene,words:call.visibleWords,error:call.error?.slice(0,300) }));
  if (call.status !== 'complete') break;
}
} finally {
  await lock.close();
  await unlink(lockPath);
}
