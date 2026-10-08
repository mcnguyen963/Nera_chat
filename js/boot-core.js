// Keep this module dependency-free so a failed app import remains recoverable.
export async function startApp({ load, doc, reload }) {
  try { await load(); return true; }
  catch (error) {
    console.error(error);
    const box = doc.createElement('div');
    box.id = 'boot-error'; box.className = 'boot-error'; box.setAttribute('role', 'alert');
    const title = doc.createElement('h1'); title.textContent = 'Nera Chat could not start';
    const detail = doc.createElement('p'); detail.textContent = error?.message || String(error);
    const hint = doc.createElement('p'); hint.textContent = 'Check your connection, then reload. Your saved stories are not affected.';
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = 'Reload';
    button.addEventListener('click', reload);
    box.append(title, detail, hint, button); doc.body.prepend(box);
    return false;
  }
}
