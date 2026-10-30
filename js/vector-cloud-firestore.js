import {db} from './db.js';
import {currentUid} from './auth.js';
import {doc,getDocFromServer,setDoc,runTransaction} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// Every operation is scoped to the account captured before the sync starts.
export function createVectorCloudAdapter(owner,sid,check=()=>{}) {
  const scope=()=>{if(currentUid()!==owner)throw new Error('Account changed during vector sync.');check();};
  const ref=id=>doc(db,'users',owner,'sessions',sid,'vectorIndexes',id);
  return {
    async writeChunk(id,payload){scope();await setDoc(ref('chunk-'+id),{version:1,payload});scope();},
    async readChunk(id){scope();const snap=await getDocFromServer(ref('chunk-'+id));scope();return snap.exists()?snap.data().payload:null;},
    async loadManifest(kind){scope();const snap=await getDocFromServer(ref('manifest-'+kind));scope();return snap.exists()?snap.data():null;},
    async commitManifest(kind,expected,manifest){
      scope();await runTransaction(db,async tx=>{scope();const target=ref('manifest-'+kind),current=await tx.get(target);scope();if((current.exists()?current.data().revision:0)!==expected)throw new Error('Vector index changed on another device. Download it before syncing again.');tx.set(target,manifest);});scope();
    },
  };
}
