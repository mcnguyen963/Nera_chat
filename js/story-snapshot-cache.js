// Keep recent snapshots for background work without retaining every visited story.
// Active jobs stay pinned; persisted stories can be recovered on selection.
export function createStorySnapshotCache(pinned,limit=3) {
  const values=new Map();
  function prune(){for(const key of values.keys()){if(values.size<=limit)break;if(!pinned(key))values.delete(key);}}
  return {
    get size(){return values.size;},
    keys:()=>values.keys(),
    get:key=>values.get(key),
    set(key,value){values.delete(key);values.set(key,value);prune();},
    delete:key=>values.delete(key),
    clear:()=>values.clear(),
    prune,
  };
}
