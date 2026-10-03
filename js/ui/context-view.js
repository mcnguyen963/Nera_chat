// Request previews are device-local and never written to story storage.
let el;
let getPreview;
let nextContext = null;
let latestRequest = null;
let previewRun = 0;
let loading = false;
let opener = null;

export function initContextInspector(loadPreview) {
  getPreview = loadPreview;
  el = Object.fromEntries(["dialog", "mode", "body", "status", "close", "indicator"]
    .map((key) => [key, document.getElementById(`context-${key}`)]));
  el.indicator.addEventListener("click", async () => {
    opener = document.activeElement;
    el.mode.value = "next";
    el.dialog.showModal();
    await refreshPreview();
  });
  el.close.addEventListener("click", () => el.dialog.close());
  el.dialog.addEventListener("close", () => opener?.focus());
  el.dialog.addEventListener("click", (event) => {
    if (event.target !== el.dialog) return;
    const rect = el.dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) el.dialog.close();
  });
  el.mode.addEventListener("change", () => {
    if (el.mode.value === "next") void refreshPreview();
    else render();
  });
}

async function refreshPreview() {
  const run = ++previewRun;
  loading = true;
  el.status.textContent = "Loading context…";
  el.body.replaceChildren();
  try {
    const context = await getPreview();
    if (run !== previewRun) return;
    nextContext = context;
    loading = false;
    render();
  } catch (error) {
    if (run !== previewRun) return;
    loading = false;
    el.status.textContent = "Could not load context: " + error.message;
  }
}

export function updateContextPreview(context) {
  nextContext = context;
  if (el?.dialog.open && el.mode.value === "next" && !loading) render();
}

export function captureContextRequest(context, request) {
  latestRequest = structuredClone({ ...context, model: request.model,
    apiMessages: request.messages,
    entries: context.entries.map((entry, index) => ({ ...entry, ...request.messages[index] })),
  });
  if (el?.dialog.open && el.mode.value === "sent") render();
}

export function resetContextInspector() {
  ++previewRun;
  loading = false;
  nextContext = latestRequest = null;
  if (el?.dialog.open) el.dialog.close();
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function render() {
  const sent = el.mode.value === "sent";
  const context = sent ? latestRequest : nextContext;
  el.body.replaceChildren();
  if (!context) {
    el.status.textContent = sent ? "No request has been sent for this story since it was opened." : "No story selected.";
    return;
  }
  const { usedTokens, max } = context;
  el.status.textContent = `${usedTokens.toLocaleString()} input / ${max.toLocaleString()} tokens · estimated` +
    (context.model ? ` · ${context.model}` : "") +
    (sent ? " · latest story request sent" : " · next turn, without unsent composer text") +
    (context.isEstimate ? " · recent history estimate" : "");
  if (context.exceedsInputLimit) {
    el.body.append(node("p", "Required story context exceeds the input limit. Increase the limit or shorten the required messages before sending.", "context-warning"));
  }
  el.body.append(node("p", "Thinking and private planning notes are excluded. Token counts include estimated framing overhead.", "muted"));
  const table = node("table", undefined, "context-contributions");
  const head = node("tr");
  for (const title of ["Source", "Tokens", "Input share"]) head.append(node("th", title));
  table.append(head);
  for (const { source, tokens } of context.contributions) {
    const row = node("tr");
    row.append(node("td", source), node("td", tokens.toLocaleString()),
      node("td", `${usedTokens ? (tokens / usedTokens * 100).toFixed(1) : "0.0"}%`));
    table.append(row);
  }
  el.body.append(table);
  const omitted = Object.entries(context.omitted).filter(([, count]) => count > 0);
  if (omitted.length) el.body.append(node("p", "Omitted: " + omitted.map(([reason, count]) => `${count} ${reason.toLowerCase()}`).join(" · "), "muted"));
  el.body.append(node("h3", "Messages in request order"));
  const turns = context.entries.filter((entry) => entry.role !== "system");
  const turnGroup = node("details", undefined, "context-message context-turn-group");
  const turnTokens = turns.reduce((total, entry) => total + entry.tokens, 0);
  turnGroup.append(node("summary", `Conversation turns · ${turns.length.toLocaleString()} messages · ${turnTokens.toLocaleString()} tokens`));
  const turnList = node("div", undefined, "context-turn-list");
  turnGroup.append(turnList);
  let groupAdded = false;
  for (const [index, entry] of context.entries.entries()) {
    const details = node("details", undefined, "context-message");
    const label = `${index + 1}. ${entry.source} · ${entry.role}` +
      (entry.order != null ? ` · T${entry.order}` : "") + ` · ${entry.tokens.toLocaleString()} tokens`;
    details.append(node("summary", label));
    details.addEventListener("toggle", () => {
      if (!details.open || details.querySelector("pre")) return;
      details.append(node("pre", entry.content));
    });
    if (entry.role === "system") el.body.append(details);
    else {
      if (!groupAdded) { el.body.append(turnGroup); groupAdded = true; }
      turnList.append(details);
    }
  }
}
