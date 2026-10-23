// Load the actual browser ESM tokenizer on Node 20 as well as newer Node.
// No package.json/module-detection changes are needed in the app repository.
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context=vm.createContext({TextEncoder,TextDecoder,console});
const vendor=new vm.SourceTextModule(await readFile(new URL('../../js/vendor/gpt-tokenizer-2.9.0.js',import.meta.url),'utf8'),{context,identifier:'gpt-tokenizer'});
await vendor.link(()=>{throw new Error('Unexpected dependency in vendored tokenizer.');});
const mod=new vm.SourceTextModule(await readFile(new URL('../../js/tokenizer.js',import.meta.url),'utf8'),{context,identifier:'tokenizer',importModuleDynamically:async specifier=>{
  if(!specifier.startsWith('./vendor/gpt-tokenizer-2.9.0.js'))throw new Error('Unexpected tokenizer import.');
  if(vendor.status!=='evaluated')await vendor.evaluate();return vendor;
}});
await mod.link(()=>{throw new Error('Unexpected static tokenizer import.');});await mod.evaluate();
// Evaluation explicitly uses the encoder, regardless of the interactive UI mode.
const tokenizer=mod.namespace.createTokenizer();
export const countTokens=tokenizer.countTokens;
export const tokenizerStatus=tokenizer.tokenizerStatus;
