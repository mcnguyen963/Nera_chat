import { readFile,writeFile,mkdir,open,unlink } from 'node:fs/promises';
import { appHarness } from '../tests/app-harness.mjs';
const root = new URL('../',import.meta.url),dir = new URL('./eval/',import.meta.url);
const read = path => readFile(new URL(path,root),'utf8');
const action = process.argv[2] ?? 'prepare';
await mkdir(dir,{ recursive:true });
const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async () => [] },
  'tokenizer.js':{ countTokens:async s => Math.ceil(new TextEncoder().encode(s).length/4) } } });
const scene = await use('scene.js'),plan = await use('plan-parser.js'),review = await use('turn-review.js');
const { buildContextForRequest } = await use('context-builder.js');
const captured = JSON.parse(await read('investigate/LLM_request.txt'));
const records = (await read('investigate/chat-history.jsonl')).trim().split(/\r?\n/).map(JSON.parse);
const { session,lore } = records[0].nera;
const names = ['Nera Veyrath','Isolde Veyless','Elise Fen','Liora Fen','Bastian Krail'];
const seed = scene.sceneLine({ date:'18 September 731',time:'unknown',place:'West Reception Room',present:names });
const opening = { ...records[1].nera.message,content:records[1].mes };
const previous = { id:'eval-opening',role:'assistant',order:2,content:'Bastian Krail waits beside the unsigned punishment order. Isolde Veyless stands beside you. Elise Fen and Liora Fen remain in the West Reception Room. Magerrett Veyrath listens outside the closed door; Taigar Veyrath remains farther down the corridor. The decision remains yours.',
  scene:seed,planThread:'Opening hearing: await Nera’s decision.',ooc:false,acceptance:'accepted' };
const directive = { id:'eval-ad',role:'user',order:3,content:'<ad>Continue the hearing. Have Bastian Krail leave the room; do not move Nera or the other people. Do not write any player speech, thoughts or decisions.</ad>' };
const departed = { id:'eval-departure',role:'assistant',order:4,content:'Bastian Krail leaves the West Reception Room and closes the door behind him. Isolde Veyless, Elise Fen and Liora Fen remain with you beside the unsigned order. No punishment decision has been made.',
  scene:scene.sceneLine({ date:'18 September 731',time:'unknown',place:'West Reception Room',present:names.slice(0,4) }),
  planThread:'Opening hearing: await Nera’s decision.',ooc:false,acceptance:'accepted' };
const histories = { opening:[opening],progression:[opening,previous,directive],
  ooc:[opening,previous,directive,departed,{ id:'eval-ooc',role:'user',order:5,content:'<ooc>Who is physically present in the West Reception Room now? Answer briefly without advancing events.</ooc>' }] };
const jobs = [];
for (const [scenario,messages] of Object.entries(histories)) for (const variant of ['off','system','user']) {
  const built = await buildContextForRequest({ ...session,memory:{ ...session.memory,scene:true,startingScene:seed,replyContract:variant } },{
    narratorSystemPrompt:(await use('system-prompts.js')).prompts.narrator,maxContextTokens:120000,
    maxResponseTokens:captured.max_tokens,keepRecentMessagesAfterSummary:10 },{ messages,loreEntries:lore,requireLatestUser:true });
  for (const routing of ['floor','pinned']) jobs.push({ id:`${scenario}-${variant}-${routing}`,scenario,variant,routing,
    expected:{ date:'18 September 731',time:null,place:'West Reception Room',present:scenario === 'opening' ? names : names.slice(0,4) },
    report:built.report,request:{ ...captured,messages:built.apiMessages,provider:{ max_price:{ prompt:1,completion:2,request:0.001 },
      ...(routing === 'pinned' ? { order:['open-inference/fp4'],only:['open-inference/fp4'],allow_fallbacks:false } : {}) } } });
}
await writeFile(new URL('fixtures.json',dir),JSON.stringify({ note:'Independent controlled synthetic fixtures. Original user/plan content unchanged. Explicit starting scene is shared by all variants. Token fitting uses UTF-8 bytes/4. No saved story is edited.',histories,jobs },null,2)+'\n');
if (action === 'prepare') { console.log('Prepared 18 screening cells; no provider calls.');process.exit(0); }
if (!['screen','repeat','tier','fallback'].includes(action)) throw new Error('Choose prepare, screen, repeat, tier or fallback.');
const lockPath = new URL('run.lock',dir),lock = await open(lockPath,'wx');
try {
  const key = (process.env.NERA_INVESTIGATION_API_KEY || await read('private/key.txt')).trim();
  const oldCalls = JSON.parse(await read('investigate/live/calls.json'));
  const ledger = new URL('calls.json',dir);
  let calls;try { calls = JSON.parse(await readFile(ledger,'utf8')); } catch(error) { if (error.code !== 'ENOENT') throw error;calls = []; }
  const cost = c => c.connectionFailure ? 0 : c.usage?.cost ?? c.reserve ?? 0.1;
  const spent = () => [...oldCalls,...calls].reduce((s,c) => s+cost(c),0);
  let saveChain = Promise.resolve();
  const save = () => { const snapshot = JSON.stringify(calls,null,2)+'\n';saveChain = saveChain.then(() => writeFile(ledger,snapshot));return saveChain; };
  let selected = jobs;
  if (action === 'repeat') {
    const winners = JSON.parse(await readFile(new URL('repeat-selection.json',dir),'utf8'));
    selected = jobs.filter(j => winners.includes(j.variant));
    if (!selected.length) throw new Error('Select at least one manually reviewed promising variant.');
  }
  if (action === 'tier') {
    selected = jobs.filter(j => j.variant === 'user' && j.routing === 'floor').map(j => ({ ...j,id:j.id+'-flashx',
      request:{ ...j.request,model:'z-ai/glm-5.3-flashx:floor' } }));
  }
  if (action === 'fallback') {
    const recovery = await use('scene-recovery.js');
    const context = { narration:departed.content,userText:directive.content,prior:scene.latestScene([opening,previous]),
      names,plan:session.longTermPlan };
    selected = [{ id:'structured-fallback',scenario:'fallback',variant:'schema',routing:'floor',context,
      request:{ model:captured.model,max_tokens:1500,stream:false,messages:recovery.recoveryMessages(context),
        response_format:recovery.SCENE_RECOVERY_FORMAT,provider:{ require_parameters:true,max_price:{ prompt:1,completion:2,request:0.001 } } } }];
  }
  function assess(job,content) {
    const visible = plan.stripPlan(content),parsed = scene.extractScene(content);
    const snapshot = parsed ? scene.parseScene(parsed) : null;
    const words = visible.trim() ? visible.trim().split(/\s+/).length : 0;
    const warnings = review.lintPlayerAgency(visible,'Nera Veyrath');
    const ooc = job.scenario === 'ooc';
    const criteria = ooc ? { noScene:!parsed,noPlan:!plan.extractPlanThread(content),brief:words>0 && words<=200 } : {
      finalSingleTag:!!scene.inspectSceneOutput(content).scene,noAgencyLint:warnings.length===0,
      supportedTime:snapshot?.time===null,supportedDate:snapshot?.when===job.expected.date,
      correctPlace:!!snapshot?.place?.toLowerCase().includes('west reception room'),
      correctAttendance:!!snapshot && JSON.stringify([...snapshot.present].sort()) === JSON.stringify([...job.expected.present].sort()),
      wordLimit:words>0 && words<800,planBreadcrumb:!!plan.extractPlanThread(content) && [...content.matchAll(/<plan_thread>/g)].length===1 };
    return { content,visibleWords:words,scene:snapshot,warnings,criteria,
      automaticPass:Object.values(criteria).every(Boolean),humanReview:'pending: player agency, attendance, knowledge, OOC progression and plan target' };
  }
  const queue = selected.flatMap(job => Array.from({ length:action==='repeat' ? 5 : 1 },(_,i) => ({ job,run:i+1 })))
    .filter(({job,run}) => !calls.some(c => c.id === job.id && c.run === run && !c.connectionFailure));
  let cursor = 0;
  async function worker() {
    while(cursor < queue.length) {
      const {job,run} = queue[cursor++];
      const bytes = new TextEncoder().encode(JSON.stringify(job.request)).length;
      const reserve = (bytes+1024)/1e6+job.request.max_tokens*2/1e6+0.001;
      if (spent()+reserve>0.5) { console.log('Budget guard stopped new calls.');return; }
      const row = { id:job.id,run,scenario:job.scenario,variant:job.variant,routing:job.routing,
        model:job.request.model,attempt:calls.length+1,status:'started',reserve,startedAt:new Date().toISOString() };
      calls.push(row);await save();
      const prefix = `${row.attempt}-${job.id}-${run}`;
      await writeFile(new URL(prefix+'-request.json',dir),JSON.stringify(job.request,null,2)+'\n');
      console.log(`Started ${job.id} #${run}; cumulative accounted $${spent().toFixed(4)}.`);
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions',{ method:'POST',headers:{ 'Content-Type':'application/json',Authorization:'Bearer '+key },
          body:JSON.stringify(job.request),signal:AbortSignal.timeout(180000) });
        const raw = await res.text();await writeFile(new URL(prefix+'-response.txt',dir),raw.split(key).join('[redacted]'));
        row.http = res.status;
        const events = job.request.stream ? raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(l => l!=='[DONE]').map(JSON.parse) : [JSON.parse(raw)];
        row.usage = events.findLast(e => e.usage)?.usage ?? null;
        row.providers = [...new Set(events.map(e=>e.provider).filter(Boolean))];
        row.responseIds = [...new Set(events.map(e=>e.id).filter(Boolean))];
        row.finishReasons = [...new Set(events.flatMap(e=>e.choices??[]).map(c=>c.finish_reason).filter(Boolean))];
        if (!res.ok || events.some(e=>e.error)) throw new Error('Provider rejected request: '+JSON.stringify(events.find(e=>e.error)?.error ?? res.status));
        const transport = appHarness({ globals:{ console:{ log(){} },fetch:async () => new Response(raw) } });
        const reply = await (await transport('llm-client.js')).chatCompletion({ settings:{ modelId:job.request.model,endpoint:'fixture',apiKey:'fixture',streaming:job.request.stream,maxResponseTokens:job.request.max_tokens },messages:job.request.messages });
        const result = job.scenario === 'fallback' ? { ...reply,recovered:(await use('scene-recovery.js')).parseRecovery(reply.content,job.context) } : { ...reply,...assess(job,reply.content) };
        await writeFile(new URL(prefix+'-parsed.json',dir),JSON.stringify(result,null,2)+'\n');
        row.status = 'complete';row.criteria = result.criteria;row.automaticPass = result.automaticPass;
      } catch(error) { row.status='failed';row.error=error.message.split(key).join('[redacted]');row.connectionFailure=['ENOTFOUND','ECONNREFUSED'].includes(error.cause?.code); }
      row.finishedAt=new Date().toISOString();await save();
      console.log(JSON.stringify({ id:row.id,run,status:row.status,providers:row.providers,pass:row.automaticPass,criteria:row.criteria,cost:row.usage?.cost,total:spent(),error:row.error }));
    }
  }
  // One process owns the budget ledger; two independent requests at most.
  await Promise.all([worker(),worker()]);
} finally { await lock.close();await unlink(lockPath); }
