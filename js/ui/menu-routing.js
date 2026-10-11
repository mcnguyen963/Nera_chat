const events = new Set(['lorebooks', 'context-details', 'sync-chat', 'summarize-full', 'reset-summary']);
export function routeTopMenu(action, {settings, dispatch}) {
  if (action === 'settings') { settings(); return true; }
  if (events.has(action)) { dispatch(action); return true; }
  // Memory and Summarize retain their existing button listeners and states.
  return false;
}
