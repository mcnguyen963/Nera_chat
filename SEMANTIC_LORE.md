# Experimental semantic lore search

This optional feature adds semantic candidates to the existing lorebook selection for narration, Director control lore and memory updates. It is off for existing stories. It does not alter or migrate stored cards, facts, memory checkpoints, or history; the existing source checks, disabled books, card limits and token budgets still apply. It does not add historical-message recall.

Similarity is not proof of relevance. The fixed 0.4 cosine gate rejects some weak matches, but even stronger matches can be wrong. Review what was sent in the context viewer. If a matching card has changed, is missing, or has become ineligible, it is excluded until the index is rebuilt. Existing name, alias, scene and priority rules remain active when the index is missing, stale, unreachable or times out.

## Use on the Mac hosting Ollama

1. Run Ollama on the same Mac as the browser and install `qwen3-embedding:0.6b`. Allow the deployed site's origin in Ollama's `OLLAMA_ORIGINS` setting. Restarting Ollama may be required after changing its environment. For a terminal-hosted server, an example is `OLLAMA_ORIGINS=https://mcnguyen963.github.io ollama serve`; stop any other Ollama server on that port first. Check the deployed site's actual origin if using another deployment.
2. Open the existing story. In **Settings → Memory**, find **Semantic lore search (experimental)**. Enable it. The default endpoint is `http://127.0.0.1:11434/v1/embeddings` and the default model is `qwen3-embedding:0.6b`.
3. Select **Build device search index**, wait for the completion message, then **Save story and memory settings**. The operation reads the current story and sends eligible lore text to your local Ollama server. It stores embeddings and text fingerprints in the browser's local IndexedDB, not in the story database. It does not write or reorganize lore.
4. Rebuild the index on this device after changing or updating lore. Until then, unchanged cards can still be searched, but changed and new cards are omitted from semantic search. Normal lore selection continues.

## Use an embedding service from another device

The same connection is used for semantic lore and historical message recall. It accepts an OpenAI-compatible `/v1/embeddings` endpoint, including HTTPS services and HTTP addresses on a local network such as `http://192.168.1.20:11434/v1/embeddings`. On an iPhone, `127.0.0.1` refers to the phone, not the Mac. Set the model to the exact ID installed on the server and save the story settings. If the service requires a Bearer API key, enter it and select **Save API key on this device**. The key is stored in the browser, scoped to the signed-in account and URL, and is not synced with the story or vectors. Save it separately on each device; clear the field and save to remove it. API keys are stored unencrypted in browser storage.

The service must support browser CORS requests from the deployed site's origin, including preflight requests and the Authorization header when a key is used. Ollama can allow the site with `OLLAMA_ORIGINS`; see its documentation. When accessing Ollama through the Mac's IP, it must also listen on an address reachable by the phone, and the firewall and network must allow the connection. Exposing Ollama to a network allows network clients to use it; restrict access appropriately.

An HTTPS site may be blocked by the browser from calling a local HTTP URL even when CORS is configured. Browser and local-network permissions vary. For a reliable deployed-site setup, use a trusted HTTPS endpoint or a private HTTPS proxy that restricts access and forwards embedding requests to the Mac. Do not send a key or private story text over HTTP on an untrusted network. The application sends story text to the configured service.

Each browser/device has its own index; clearing local account caches or deleting the story removes that device's index. Use the vector sync controls to upload and download indexes across devices. A different model or endpoint needs a new index.

## Validation

`node --experimental-vm-modules --test tests/lore-semantic.mjs` checks scoping, changed sources, cancellation, endpoint validation, credentials, fallback and request integration. `node --experimental-vm-modules tests/tools/lore-embedding-eval.mjs` is an optional synthetic comparison requiring a local Ollama server and the named model. Its small example set is not a measure of performance on a real story. No automatic test sends narrative data to an external provider.
