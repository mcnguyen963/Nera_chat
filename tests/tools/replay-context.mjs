import { promptFetch, promptImportMeta } from '../prompt-files.mjs';
import vm from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';
const JS = new URL('../../js/', import.meta.url);
async function setup(stubs = {}) {
  const cache = new Map(), context = vm.createContext({ URL,fetch:promptFetch,console,structuredClone,TextEncoder,Date,Map,Set,AbortController,setTimeout,clearTimeout });
  const load = path => { if (!cache.has(path)) cache.set(path, create(path)); return cache.get(path); };
  async function create(path) {
    const source = stubs[path];
    const module = source ? new vm.SyntheticModule(Object.keys(source),function () { for (const [k,v] of Object.entries(source)) this.setExport(k,v); },{ context,identifier:path })
      : new vm.SourceTextModule(await readFile(new URL(path,JS),'utf8'),{ context,identifier:path,initializeImportMeta:promptImportMeta });
    await module.link((spec,parent) => load(spec.startsWith('https:') ? spec : new URL(spec,'https://local/'+parent.identifier).pathname.slice(1)));
    return module;
  }
  return async path => { const m = await load(path); if (m.status !== 'evaluated') await m.evaluate(); return m.namespace; };
}
const [file, upArg = 'Infinity', out = 'req.json', blockRole] = process.argv.slice(2);
const lines = (await readFile(file,'utf8')).split('\n').filter(Boolean);
const head = JSON.parse(lines[0]).nera;
const ts = v => v && typeof v === 'object' && 'seconds' in v ? v.seconds*1000 : v;
const messages = lines.slice(1).map(l => JSON.parse(l).nera.message).map(m => ({ ...m,order:Number(m.order),createdAt:ts(m.createdAt) }));
const lore = head.lore.map(e => ({ ...e,sections:Object.fromEntries(Object.entries(e.sections ?? {}).map(([k,s]) => [k,{ ...s,lines:(s.lines ?? []).map(l => ({ ...l,at:ts(l.at) })) }])) }));
const count = async t => Math.ceil(t.length/3.6);
const use = await setup({ 'messages.js':{ getMessages:async () => messages },'tokenizer.js':{ countTokens:count } });
const { prompts } = await use('system-prompts.js'), builder = await use('context-builder.js');
const settings = { narratorSystemPrompt:prompts.narrator,maxContextTokens:120000,maxResponseTokens:8192,keepRecentMessagesAfterSummary:10 };
if(blockRole && !['user','system'].includes(blockRole)) throw new Error('Optional block role must be user or system.');
const session={ id:'s',...head.session };
if(blockRole) session.memory={...session.memory,blockRole};
const r = await builder.buildContextForRequest(session,settings,{ messages,loreEntries:lore,requireLatestUser:true,upToOrder:Number(upArg) });
await writeFile(out,JSON.stringify(r.apiMessages,null,1));
console.log('messages',r.apiMessages.length,'tokens',r.usedTokens,'memoryTokens',r.report.blocks.find(b=>b.key==='memory')?.tokens);
r.apiMessages.forEach((m,i) => console.log(String(i).padStart(2),m.role.padEnd(9),'T-refs',(m.content.match(/\bT\d{1,5}\b/g) ?? []).length,'|',JSON.stringify(m.content.slice(0,90))));
