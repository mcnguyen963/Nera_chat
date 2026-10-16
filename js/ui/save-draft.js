// Apply a save result without replacing edits made after submission.
export function rebaseSavedDraft(current, submitted, saved) {
  if(JSON.stringify(current)===JSON.stringify(submitted))return structuredClone(saved);
  const object=v=>v && typeof v==='object' && !Array.isArray(v);
  if(object(current) && object(submitted) && object(saved)) {
    return Object.fromEntries([...new Set([...Object.keys(current),...Object.keys(saved)])].flatMap(key=>{
      if(!Object.hasOwn(current,key) && Object.hasOwn(submitted,key))return [];
      return [[key,rebaseSavedDraft(current[key],submitted[key],saved[key])]];
    }));
  }
  if([current,submitted,saved].every(Array.isArray) && [...current,...submitted,...saved].every(v=>object(v) && v.id)) {
    const old=new Map(submitted.map(v=>[v.id,v])),next=new Map(saved.map(v=>[v.id,v]));
    return [...current.map(v=>old.has(v.id)?rebaseSavedDraft(v,old.get(v.id),next.get(v.id)):structuredClone(v)),...saved.filter(v=>!old.has(v.id) && !current.some(c=>c.id===v.id)).map(v=>structuredClone(v))].filter(Boolean);
  }
  return structuredClone(current);
}
