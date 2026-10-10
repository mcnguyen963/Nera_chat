// Add --compare for the slower frozen baseline. Run outside CI: node --experimental-vm-modules tests/tools/benchmark-mobile-context.mjs
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {appHarness} from '../app-harness.mjs';
import * as tokenizer from '../../js/tokenizer.js';
const frozen=await readFile(new URL('../fixtures/mobile-context/memory-context.js',import.meta.url),'utf8');
for(const n of [500,2000])for(const blockWindow of [false,true])for(const variant of (process.argv.includes('--compare')?['optimized','frozen']:['optimized'])){
  const use=appHarness(variant==='frozen'?{sources:{'memory-context.js':frozen}}:{});
  const {buildMemoryContext}=await use('memory-context.js'),{createTokenCounter}=await use('token-cache.js');
  const count=createTokenCounter({count:tokenizer.countTokens,ready:tokenizer.tokenizerReady});
  const messages=Array.from({length:n},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:`Story message ${i}. `+'The traveler studies the map and heads toward the inn. '.repeat(5)}));
  const session={memory:{memoryBlock:true,blockWindow,batchTurns:5}},settings={narratorSystemPrompt:'Narrate.',maxContextTokens:blockWindow?12000:1000000,maxResponseTokens:100,keepRecentMessagesAfterSummary:10};
  const build=()=>buildMemoryContext(session,settings,{messages},{count,adRule:'',normalizeAd:s=>s});
  await build();await build();const times=[];
  for(let i=0;i<5;i++){const start=performance.now();await build();times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);
  console.log(JSON.stringify({messages:n,blockWindow,variant,medianMs:+times[2].toFixed(2),minMs:+times[0].toFixed(2),maxMs:+times.at(-1).toFixed(2),tokenizer:tokenizer.tokenizerStatus()}));
}
