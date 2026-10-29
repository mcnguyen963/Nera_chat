# Experimental semantic lore search

This optional feature adds semantic candidates to the existing lorebook selection for narration, Director control lore and memory updates. It is off for existing stories. It does not alter or migrate stored cards, facts, memory checkpoints, or history; the existing source checks, disabled books, card limits and token budgets still apply. It does not add historical-message recall.

Similarity is not proof of relevance. The fixed 0.4 cosine gate rejects some weak matches, but even stronger matches can be wrong. Review what was sent in the context viewer. If a matching card has changed, is missing, or has become ineligible, it is excluded until the index is rebuilt. Existing name, alias, scene and priority rules remain active when the index is missing, stale, unreachable or times out.

## Use on the Mac hosting Ollama

1. Run Ollama on the same Mac as the browser and install `qwen3-embedding:0.6b`. Allow the deployed site's origin in Ollama's `OLLAMA_ORIGINS` setting. Restarting Ollama may be required after changing its environment. For a terminal-hosted server, an example is `OLLAMA_ORIGINS=https://mcnguyen963.github.io ollama serve`; stop any other Ollama server on that port first. Check the deployed site's actual origin if using another deployment.
2. Open the existing story. In **Settings → Memory**, find **Semantic lore search (experimental)**. Enable it. The default endpoint is `http://127.0.0.1:11434/v1/embeddings` and the default model is `qwen3-embedding:0.6b`.
3. Select **Build device search index**, wait for the completion message, then **Save story and memory settings**. The operation reads the current story and sends eligible lore text to your local Ollama server. It stores embeddings and text fingerprints in the browser's local IndexedDB, not in the story database. It does not write or reorganize lore.
4. Rebuild the index on this device after changing or updating lore. Until then, unchanged cards can still be searched, but changed and new cards are omitted from semantic search. Normal lore selection continues.

The endpoint is restricted to local HTTP loopback addresses on the device running the browser and accepts no API credentials. On an iPhone, `127.0.0.1` refers to the phone, not the Mac. This version does not provide a remote or LAN connection from the iPhone to Mac-hosted Ollama. Each browser/device has its own index; clearing local account caches or deleting the story removes that device's index. A different model or endpoint needs a new index.

## Validation

`node --experimental-vm-modules --test tests/lore-semantic.mjs` checks scoping, changed sources, cancellation, local-only URLs, fallback and request integration. `node --experimental-vm-modules tests/tools/lore-embedding-eval.mjs` is an optional synthetic comparison requiring a local Ollama server and the named model. Its small example set is not a measure of performance on a real story. No automatic test sends narrative data to an external provider.
