// OpenRouter provider discovery and device-local health. No credentials are stored here.
export const PROVIDER_COOLDOWN_MS = 30 * 60 * 1000;
const memory = new Map();

export function supportsProviders(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.origin === 'https://openrouter.ai' && /^\/api\/v1\/chat\/completions\/?$/.test(url.pathname);
  } catch { return false; }
}

export function providerOrder(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10 || value.some(tag => typeof tag !== 'string' || !tag.trim() || tag !== tag.trim()) || new Set(value).size !== value.length)
    throw new Error('Choose up to 10 different providers.');
  return [...value];
}

export function normalizeProviders(data) {
  if (!Array.isArray(data?.data?.endpoints)) throw new Error('Malformed provider listing: expected model endpoints.');
  const entries = new Map();
  for (const endpoint of data.data.endpoints) {
    const tag = endpoint?.tag;
    if (typeof tag !== 'string' || !tag.trim() || entries.has(tag)) continue;
    entries.set(tag, { tag, name: endpoint.provider_name || tag });
  }
  return [...entries.values()].sort((a,b) => a.name.localeCompare(b.name) || a.tag.localeCompare(b.tag));
}

export async function fetchProviders({endpoint, apiKey, modelId}, {signal} = {}) {
  if (!supportsProviders(endpoint)) throw new Error('Provider selection is supported only for OpenRouter endpoints.');
  // Routing shortcuts are request options, not distinct models in the catalog.
  const model = String(modelId ?? '').trim().replace(/:(floor|nitro)$/, '');
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error('Choose a model before fetching providers.');
  const controller = new AbortController();
  const cancel = () => controller.abort('cancelled');
  let rejectAbort;
  const aborted = new Promise((_,reject) => {
    rejectAbort = () => reject(new Error(controller.signal.reason === 'timeout' ? 'Fetching providers timed out after 30 seconds.' : 'Provider discovery cancelled.'));
    controller.signal.addEventListener('abort',rejectAbort,{once:true});
  });
  const timer = setTimeout(() => controller.abort('timeout'),30000);
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort',cancel,{once:true});
  try {
    if (controller.signal.aborted) { rejectAbort(); return await aborted; }
    const request = async () => {
      let response;
      try {
        response = await fetch('https://openrouter.ai/api/v1/models/'+model.split('/').map(encodeURIComponent).join('/')+'/endpoints',{
          method:'GET', headers: apiKey?.trim() ? {Authorization:'Bearer '+apiKey.trim()} : {}, signal:controller.signal,
        });
      } catch { throw new Error('Could not fetch providers. Check the connection and browser access.'); }
      if (!response.ok) throw new Error(`Provider listing unavailable (HTTP ${response.status}). Check your model and API key.`);
      let data;
      try { data = await response.json(); } catch { throw new Error('Malformed provider listing: expected JSON.'); }
      return normalizeProviders(data);
    };
    return await Promise.race([request(),aborted]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort',cancel);
    controller.signal.removeEventListener('abort',rejectAbort);
  }
}

function cooldownKey(settings,tag) {
  return 'nera.provider.cooldown.'+JSON.stringify([settings.providerCooldownAccount ?? '',new URL(settings.endpoint).origin,settings.modelId,tag]);
}
export function providerRetryAt(settings,tag,now=Date.now()) {
  if(!supportsProviders(settings.endpoint))return 0;
  const key = cooldownKey(settings,tag);
  let value = memory.get(key) ?? 0;
  try { value = Number(localStorage.getItem(key)) || 0; } catch {}
  return Number.isFinite(value) && value > now ? value : 0;
}
export function coolDownProvider(settings,tag,now=Date.now()) {
  const key=cooldownKey(settings,tag),until=now+PROVIDER_COOLDOWN_MS;
  memory.set(key,until);
  try { localStorage.setItem(key,String(until)); } catch {}
  return until;
}
export function resetProviderCooldown(settings,tag) {
  const key=cooldownKey(settings,tag);memory.delete(key);
  try { localStorage.removeItem(key); } catch {}
}
export function availabilityFailure(error) {
  if (error.classification === 'cancelled') return false;
  const status=Number(error.providerError?.code ?? error.status);
  if ([error.status,error.providerError?.code].some(code=>[400,401,402,403,422].includes(Number(code)))) return false;
  if (status === 404) return /no (?:allowed |available )?providers?|no endpoints?|provider.*unavailable/i.test(error.message);
  return [408,429].includes(status) || status >= 500 && status <= 599 || ['transport_loss','timeout'].includes(error.classification);
}
export function unavailableProviders(settings,order) {
  const times=order.map(tag=>providerRetryAt(settings,tag)).filter(Boolean);
  const retryAt=times.length ? Math.min(...times) : null;
  return Object.assign(new Error('No selected providers available.'+(retryAt ? ' Try again after '+new Date(retryAt).toLocaleTimeString()+'.' : '')),{classification:'providers_unavailable',retryAt});
}
