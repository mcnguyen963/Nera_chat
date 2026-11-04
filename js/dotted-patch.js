export function applyDottedPatch(data,fields,transform=value=>value) {
  const out={...data};
  for(const [key,value] of Object.entries(fields)) {
    const path=key.split('.');let target=out;
    for(const part of path.slice(0,-1)){target[part]={...target[part]};target=target[part];}
    target[path.at(-1)]=transform(value);
  }
  return out;
}
