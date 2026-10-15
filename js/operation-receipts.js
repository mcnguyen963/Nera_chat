import {doc,getDocFromServer} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {db} from './db.js';
import {currentUid} from './auth.js';
export const receiptRef=(sid,id,uid=currentUid())=>doc(db,'users',uid,'sessions',sid,'operationReceipts',id);
export async function findReceipt(sid,id,uid=currentUid()) {if(!id)return null;const snap=await getDocFromServer(receiptRef(sid,id,uid));return snap.exists()?decode(snap.data().result):null;}
export async function readReceipt(tx,sid,id,uid=currentUid()) {if(!id)return null;const snap=await tx.get(receiptRef(sid,id,uid));return snap.exists()?decode(snap.data().result):null;}
const decode=value=>typeof value==='string'?JSON.parse(value):value;
export function writeReceipt(tx,sid,id,result,uid=currentUid()) {if(id)tx.set(receiptRef(sid,id,uid),{result:JSON.parse(JSON.stringify(result.message?{message:result.message,session:result.session,historyRevision:result.historyRevision}:result)),createdAt:Date.now()});return result;}
