// One stroke language for static controls and dynamically created toolbars.
const paths = {
  stories: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 3v18m4-13h4m-4 4h4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  down: '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  continue: '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  rewrite: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  restore: '<path d="M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="M20 12H4m7-7-7 7 7 7"/>',
  save: '<path d="m5 12 4 4L19 6"/>',
  add: '<path d="M12 4v16M4 12h16"/>',
};
export function icon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.more}</svg>`;
}
export function setIcon(button, name, label) {
  if (button.dataset.renderedIcon === name && button.dataset.iconLabel === label) return;
  button.dataset.icon = name; button.dataset.renderedIcon = name; button.dataset.iconLabel = label;
  button.classList.add('icon-control');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = label;
  button.innerHTML = icon(name);
  const accessible = document.createElement('span');
  accessible.className = 'sr-only'; accessible.textContent = label; button.append(accessible);
}
export function initIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(button => setIcon(button, button.dataset.icon, button.getAttribute('aria-label') || button.textContent.trim()));
}
export function rewritePresentation({ rewriting, empty }) {
  return rewriting ? { icon:'stop', label:'Stop rewriting' } : empty ? { icon:'continue', label:'Continue' } : { icon:'rewrite', label:'Rewrite' };
}

export function contextRingPresentation({used, max}) {
  const ratio = Number.isFinite(used) && Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(1, used / max)) : 0;
  const gray = [148, 155, 167], red = [244, 92, 92];
  const color = gray.map((channel, index) => Math.round(channel + (red[index] - channel) * ratio));
  return {dash: `${ratio * 100} 100`, color: `rgb(${color.join(', ')})`};
}

// The selected mode remains available through the picker's accessible label.
export function thinkingIcon() {
  return '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17a9 9 0 1 1 16 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1.5"/><path d="M7 17h10"/></svg>';
}
