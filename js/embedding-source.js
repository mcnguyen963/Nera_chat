// Summaries add checkpoints, but leave original story messages available.
// Compare the captured sources themselves; later appends do not edit them.
const fields=['id','order','role','content','acceptance'],flags=['ooc','truncated','directorIncomplete','needsReview'];
export function embeddingSourcesUnchanged(captured,current) {
  const live=new Map((current??[]).filter(m=>m.role!=='summary').map(m=>[m.id,m]));
  return (captured??[]).filter(m=>m.role!=='summary').every(source=>{
    const now=live.get(source.id);
    return !!now && (now.revision??0)===(source.revision??0) && fields.every(field=>now[field]===source[field]) && flags.every(flag=>!!now[flag]===!!source[flag]) && JSON.stringify(now.scene??null)===JSON.stringify(source.scene??null) && JSON.stringify(now.sceneMeta??null)===JSON.stringify(source.sceneMeta??null);
  });
}
