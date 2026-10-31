// Composer text is device-local and independent of submitted message recovery.
const PREFIX = 'nera.composer-draft.v1:';
export function createComposerDraftStore({storage = () => globalThis.localStorage, schedule = setTimeout, cancel = clearTimeout, onFailure = () => {}} = {}) {
  const memory = new Map(), pending = new Map();
  const key = (owner, story) => PREFIX + encodeURIComponent(owner) + ':' + encodeURIComponent(story);
  const fail = () => onFailure();
  function flushKey(id) {
    const job = pending.get(id);
    if (!job) return true;
    cancel(job.timer); pending.delete(id);
    try {
      const target = storage();
      if (!target) throw new Error('Draft storage unavailable');
      if (job.text) target.setItem(id, job.text); else target.removeItem(id);
      return true;
    } catch { fail(); return false; }
  }
  return {
    read(owner, story) {
      if (!owner || !story) return '';
      const id = key(owner, story);
      if (memory.has(id)) return memory.get(id);
      try { const text = storage()?.getItem(id) ?? ''; memory.set(id, text); return text; }
      catch { fail(); return ''; }
    },
    set(owner, story, text) {
      if (!owner || !story) return;
      const id = key(owner, story); text = String(text);
      memory.set(id, text);
      const previous = pending.get(id); if (previous) cancel(previous.timer);
      const job = {text, timer:null};
      job.timer = schedule(() => { if (pending.get(id) === job) flushKey(id); }, 200);
      pending.set(id, job);
    },
    flush(owner, story) {
      if (owner && story) return flushKey(key(owner, story));
      let ok = true; for (const id of [...pending.keys()]) ok = flushKey(id) && ok;
      return ok;
    },
    clearStory(owner, story) {
      if (!owner || !story) return;
      const id = key(owner, story), job = pending.get(id);
      if (job) cancel(job.timer); pending.delete(id); memory.delete(id);
      try { storage()?.removeItem(id); } catch { fail(); }
    },
    clearAccount(owner) {
      if (!owner) return;
      const prefix = PREFIX + encodeURIComponent(owner) + ':';
      for (const id of [...pending.keys()]) if (id.startsWith(prefix)) { cancel(pending.get(id).timer); pending.delete(id); }
      for (const id of [...memory.keys()]) if (id.startsWith(prefix)) memory.delete(id);
      try {
        const target = storage(); if (!target) return;
        const keys = [];
        for (let i = 0; i < target.length; i++) { const id = target.key(i); if (id?.startsWith(prefix)) keys.push(id); }
        for (const id of keys) target.removeItem(id);
      } catch { fail(); }
    },
  };
}
export const composerDrafts = createComposerDraftStore({onFailure:() => {
  if (typeof CustomEvent !== 'undefined') globalThis.document?.dispatchEvent?.(new CustomEvent('composer-draft-storage-error'));
}});
