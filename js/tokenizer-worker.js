import {createTokenizer} from './tokenizer.js';
const tokenizer=createTokenizer();
self.onmessage=async ({data:{id,text}})=>{
  const count=await tokenizer.countTokens(text);
  self.postMessage({id,count,ready:tokenizer.tokenizerReady()});
};
