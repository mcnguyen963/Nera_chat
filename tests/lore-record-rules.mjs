// Run under the Firestore emulator with --project demo-nera-records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const host=process.env.FIRESTORE_EMULATOR_HOST,project='demo-nera-records';
const base=host?`http://${host}/v1/projects/${project}/databases/(default)/documents`:'';
const rules=await readFile(new URL('../firestore.rules',import.meta.url),'utf8');
const ownerUid=rules.match(/request\.auth\.uid == '([^']+)'/)?.[1] ?? rules.match(/request\.auth\.uid in \['([^']+)'/)?.[1] ?? 'OWNER_UID_HERE';
const userPath='users/'+ownerUid,path=userPath+'/sessions/s';
const value=v=>v===null?{nullValue:null}:Array.isArray(v)?{arrayValue:{values:v.map(value)}}:typeof v==='object'?{mapValue:{fields:fields(v)}}:typeof v==='boolean'?{booleanValue:v}:typeof v==='number'?{integerValue:String(v)}:{stringValue:v};
const fields=obj=>Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,value(v)]));
function token(uid){const now=Math.floor(Date.now()/1000),encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');return encode({alg:'none',typ:'JWT'})+'.'+encode({sub:uid,user_id:uid,iss:'https://securetoken.google.com/'+project,aud:project,iat:now,exp:now+3600,auth_time:now,firebase:{sign_in_provider:'custom',identities:{}}})+'.';}
async function request(relative,{method='GET',data,admin=false,writes,uid=ownerUid}={}){return fetch(base+relative,{method,headers:{...(uid==null&&!admin?{}:{Authorization:'Bearer '+(admin?'owner':token(uid))}),'Content-Type':'application/json'},...(data||writes?{body:JSON.stringify(writes?{writes}:{fields:fields(data)})}:{})});}
async function seed(session={loreRevision:0}){assert.equal((await request('/'+path,{method:'PATCH',data:session,admin:true})).status,200);}
async function expect(relative,options,status){const r=await request(relative,options);assert.equal(r.status,status,await r.text());}
const canonical={schemaVersion:3,subject:{id:'mira',name:'Mira',book:'characters'},sources:[],records:[]};
test('Firestore record migration rules', {skip:!host},async t=>{
 await t.test('own settings and history remain allowed; other accounts remain denied',async()=>{await seed();await expect('/'+userPath+'/settings/current',{method:'PATCH',data:{name:'settings'}},200);await expect('/'+path+'/messages/a',{method:'PATCH',data:{content:'story'}},200);await expect('/users/other/sessions/s',{},403);});
 await t.test('F11 strangers cannot read or write their own tree or owner data',async()=>{
   const uid='unapproved-user';
   for(const relative of ['/users/'+uid,'/users/'+uid+'/sessions/story','/users/'+uid+'/sessions/story/messageChunks/chunk','/users/'+uid+'/sessions/story/lore/card','/'+userPath,'/'+path,'/'+path+'/lore/card']) {
     await expect(relative,{uid},403);
     await expect(relative,{uid,method:'PATCH',data:{title:'Denied'}},403);
   }
   await expect('/'+path,{uid:null},403);
 });
 await t.test('legacy lore writes work before migration',async()=>{await seed();await expect('/'+path+'/lore/mira',{method:'PATCH',data:{name:'Mira'}},200);});
 await t.test('migration barrier rejects legacy writes and deletes',async()=>{await seed({loreRevision:0,loreMigration:{active:true,id:'g',expiresAt:Date.now()+60000,rollback:false}});await expect('/'+path+'/lore/mira',{method:'PATCH',data:{name:'Changed'}},403);await expect('/'+path+'/lore/mira',{method:'DELETE'},403);await expect('/'+path+'/loreV3/g/entries/mira',{method:'PATCH',data:canonical},200);});
 await t.test('migrated stories reject old-client writes and malformed canonical documents',async()=>{await seed({loreSchemaVersion:3,loreGeneration:'g',loreMigration:{active:false}});await expect('/'+path+'/lore/mira',{method:'PATCH',data:{name:'Old client'}},403);await expect('/'+path+'/loreV3/g/entries/mira',{method:'PATCH',data:{sections:{}}},403);await expect('/'+path+'/loreV3/g/entries/mira',{method:'PATCH',data:canonical},200);await expect('/'+path,{method:'PATCH',data:{title:'Old full-session replacement'}},403);});
 await t.test('rollback writes require generation and a fresh write version; deletes await activation',async()=>{await seed({loreSchemaVersion:3,loreGeneration:'g',loreMigration:{active:true,id:'rollback',rollback:true,expiresAt:Date.now()+60000}});await expect('/'+path+'/lore/mira',{method:'PATCH',data:{name:'Old client'}},403);await expect('/'+path+'/lore/mira',{method:'PATCH',data:{name:'Mira',loreRollbackGeneration:'rollback',loreWriteVersion:1}},200);await expect('/'+path+'/lore/mira',{method:'PATCH',data:{name:'Stale',loreRollbackGeneration:'rollback',loreWriteVersion:1}},403);await expect('/'+path+'/lore/mira',{method:'DELETE'},403);});
 await t.test('atomic rollback activation can remove obsolete legacy subjects',async()=>{const name=`projects/${project}/databases/(default)/documents/`;const writes=[{update:{name:name+path,fields:fields({loreSchemaVersion:2,loreGeneration:null,loreMigration:{active:false}})}},{delete:name+path+'/lore/mira'}];await expect(':commit',{method:'POST',writes},200);});
 await t.test('old clients cannot delete a migrated parent without sweeping generations',async()=>{await seed({loreSchemaVersion:3,loreGeneration:'g'});await expect('/'+path,{method:'DELETE'},403);await seed({loreSchemaVersion:3,loreGeneration:'g',deleting:true,loreGenerationsDeleted:true});await expect('/'+path,{method:'DELETE'},200);});
});
