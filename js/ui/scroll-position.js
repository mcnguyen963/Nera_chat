// Keep automatic scrolling and the jump control on the same boundary.
export function isNearBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
}

export function captureListPosition(list) {
  const edge=list.getBoundingClientRect().top,children=[...list.children];
  const visible=child=>{const rect=child.getBoundingClientRect();return rect.top+rect.height>edge;};
  const node=children.find(child=>child.dataset.messageId && visible(child)) ?? children.find(visible);
  return {sticky:isNearBottom(list),node,id:node?.dataset.messageId,top:node?.getBoundingClientRect().top};
}

export function restoreListPosition(list,position,nodeForId,replacementId) {
  if(position.sticky){list.scrollTop=list.scrollHeight;return;}
  const node=position.id ? nodeForId(position.id) : position.node?.parentNode===list ? position.node : nodeForId(replacementId);
  const top=Number.isFinite(position.offset) ? list.getBoundingClientRect().top+position.offset : position.top;
  if(node && Number.isFinite(top)){
    const delta=node.getBoundingClientRect().top-top;if(delta)list.scrollTop+=delta;
  }
  const next=Math.max(0,Math.min(list.scrollTop,Math.max(0,list.scrollHeight-list.clientHeight)));
  if(list.scrollTop!==next)list.scrollTop=next;
}
