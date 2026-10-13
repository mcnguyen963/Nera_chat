import { fetchModels } from '../llm-client.js';

export function filterModels(models, query) {
  const term = query.trim().toLowerCase();
  return models.filter(model => model.id.toLowerCase().includes(term) || model.name.toLowerCase().includes(term));
}

export function initModelPicker({ button, picker, search, list, status, model, endpoint, apiKey, onSelect }, discover = fetchModels) {
  let models = [], request = 0, controller = null;
  const message = (text, error = false) => {
    status.textContent = text;
    status.style.color = error ? 'var(--danger)' : '';
  };
  const reset = () => {
    request++;
    controller?.abort(); controller = null;
    models = []; list.replaceChildren(); search.value = '';
    picker.hidden = true; button.disabled = false; button.textContent = 'Fetch models';
    button.setAttribute('aria-expanded', 'false');
    message('');
  };
  const render = () => {
    const filtered = filterModels(models, search.value);
    list.replaceChildren(...filtered.map(entry => {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name ? `${entry.name} (${entry.id})` : entry.id;
      return option;
    }));
    list.selectedIndex = -1;
    message(filtered.length ? `${filtered.length} models. Choose one to fill Model ID.` : 'No matching models.');
  };
  const select = () => {
    if (!models.some(entry => entry.id === list.value)) return;
    model.value = list.value;
    onSelect();
    reset(); model.focus();
    message('Model ID updated. Save settings to keep this selection.');
  };
  button.addEventListener('click', async () => {
    if (controller) return;
    reset();
    const version = request, connection = { endpoint: endpoint.value, apiKey: apiKey.value };
    const current = () => version === request && endpoint.value === connection.endpoint && apiKey.value === connection.apiKey;
    controller = new AbortController(); button.disabled = true; button.textContent = 'Fetching…';
    message('Fetching models…');
    try {
      const result = await discover(connection, { signal: controller.signal });
      if (!current()) return;
      models = result;
      if (!models.length) { message('No models were listed. Enter Model ID manually.'); return; }
      picker.hidden = false; button.setAttribute('aria-expanded', 'true');
      render(); search.focus();
    } catch (error) {
      if (current()) message(error.message, true);
    } finally {
      if (current()) { controller = null; button.disabled = false; button.textContent = 'Fetch models'; }
    }
  });
  for (const field of [endpoint, apiKey]) {
    field.addEventListener('input', reset);
    field.addEventListener('change', reset);
  }
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && list.options.length) { event.preventDefault(); list.selectedIndex = 0; list.focus(); }
  });
  // Keep arrows available for browsing; Enter or a pointer selection commits.
  list.addEventListener('click', select);
  list.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); select(); } });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); button.focus(); }
  });
  return { reset };
}
