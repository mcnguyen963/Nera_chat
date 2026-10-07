export const state = {
  settings: null,   // cached per-account settings (users/{uid}/settings/current)
  settingsSaving: false,
  settingsLoadFailed: false,
  sessionId: null,  // active session id
  busy: false,      // a request/stream/summarization is in flight
};
