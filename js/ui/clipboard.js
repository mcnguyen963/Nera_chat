export async function copyText(text) {
  try {if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}} catch {}
  const ta=document.createElement('textarea');ta.value=text;ta.readOnly=true;ta.contentEditable=true;ta.style.cssText='position:fixed;top:0;left:0;opacity:0;font-size:16px';document.body.appendChild(ta);
  try {ta.focus();ta.select();ta.setSelectionRange(0,ta.value.length);if(!document.execCommand('copy'))throw new Error('Could not copy. Select and copy the text manually.');}finally{ta.remove();}
}
