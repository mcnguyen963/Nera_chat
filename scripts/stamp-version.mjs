import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tokenize enough JavaScript to distinguish module declarations from comments
// and quoted application text. Nonliteral imports retain their runtime behavior.
function tokens(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) throw new Error('Unclosed comment'); i = end + 2; continue; }
    const start = i, c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < source.length && source[i] !== c) { if (source[i] === '\\') i++; i++; }
      if (i >= source.length) throw new Error('Unclosed string or template');
      i++;
      out.push({ type: c === '`' ? 'template' : 'string', start, end:i, value:source.slice(start + 1, i - 1), quote:c });
    } else if (c === '/' && (!out.length || /^(?:[=(:,!&|?;{\[]|return|throw|case|=>)$/.test(out.at(-1).value))) {
      // A regex literal is opaque, including its quoted and backtick characters.
      i++; let inClass = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      while (/[a-z]/i.test(source[i] ?? '') && i < source.length) i++;
      out.push({ type:'regex', start, end:i, value:source.slice(start,i) });
    } else if (/[A-Za-z_$]/.test(c)) {
      i++; while (i < source.length && /[\w$]/.test(source[i])) i++;
      out.push({ type:'word', start, end:i, value:source.slice(start,i) });
    } else { i++; out.push({ type:'punct', start, end:i, value:c }); }
  }
  return out;
}

function versioned(path, version) {
  const hashAt = path.indexOf('#'), hash = hashAt < 0 ? '' : path.slice(hashAt);
  const beforeHash = hashAt < 0 ? path : path.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?'), pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? '' : beforeHash.slice(queryAt + 1));
  query.set('v', version);
  return `${pathname}?${query}${hash}`;
}

export function stampJavaScript(source, version) {
  const parts = tokens(source), replacements = new Map();
  function stamp(token) {
    if (!token || !['string','template'].includes(token.type)) return;
    if (token.type === 'template' && token.value.includes('${')) {
      const firstExpression = token.value.indexOf('${'), query = token.value.indexOf('?');
      if (token.value.replace(/\$\{[A-Za-z_$][\w$]*\}/g, '').includes('${')) throw new Error('Computed template import cannot be versioned safely');
      if (query < 0 || firstExpression < query || !/^\.\.?\/[^?#]+\.js\?/.test(token.value)) throw new Error('Computed template import cannot be versioned safely');
      // Only query values may vary: the module filename must be fixed.
      const hashAt = token.value.indexOf('#'), beforeHash = hashAt < 0 ? token.value : token.value.slice(0,hashAt);
      const hash = hashAt < 0 ? '' : token.value.slice(hashAt);
      const clean = beforeHash.replace(/([?&])v=[^&]*&?/g, '$1').replace(/[?&]$/, '');
      replacements.set(token.start, { end:token.end, value:'`' + clean + (clean.includes('?') ? '&' : '?') + 'v=' + version + hash + '`' });
      return;
    }
    if (!/^\.\.?\//.test(token.value) || !/\.js(?:[?#]|$)/.test(token.value)) return;
    if (token.value.includes('\\')) throw new Error('Escaped relative module path cannot be versioned safely');
    replacements.set(token.start, { end:token.end, value:token.quote + versioned(token.value, version) + token.quote });
  }
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.type !== 'word' || !['import','export'].includes(token.value)) continue;
    if (parts[i - 1]?.value === '.') continue;
    const next = parts[i + 1];
    if (token.value === 'import' && next?.value === '(') { stamp(parts[i + 2]); continue; }
    if (token.value === 'import' && next?.type === 'string') { stamp(next); continue; }
    if (next?.value === '.') continue; // import.meta
    for (let k = i + 1; k < parts.length && parts[k].value !== ';'; k++) {
      if (parts[k].type === 'word' && parts[k].value === 'from' && ['string','template'].includes(parts[k + 1]?.type)) { stamp(parts[k + 1]); break; }
      if (parts[k].type === 'word' && ['import','export'].includes(parts[k].value)) break;
    }
  }
  return [...replacements.entries()].sort((a,b) => b[0]-a[0]).reduce((text,[start,r]) => text.slice(0,start)+r.value+text.slice(r.end), source);
}

export function stampHTML(source, version, builtAt) {
  let boot = 0, css = 0;
  let output = source.replace(/<(script|link)\b[^>]*>/gi, tag => tag.replace(/\b(src|href)=(['"])([^'"]+)\2/gi, (attribute, name, quote, path) => {
    const isBoot = /^js\/boot\.js(?:[?#]|$)/.test(path) && /^<script\b/i.test(tag);
    const isCSS = /\.css(?:[?#]|$)/.test(path) && /^<link\b/i.test(tag) && !/^(?:[a-z]+:|\/\/)/i.test(path);
    if (!isBoot && !isCSS) return attribute;
    if (isBoot) boot++; else css++;
    return `${name}=${quote}${versioned(path,version)}${quote}`;
  }));
  if (boot !== 1 || css < 1) throw new Error(`Expected one boot module and CSS links (found ${boot}, ${css})`);
  output = output.replace(/\s*<meta name="nera-(?:version|built-at)" content="[^"]*"\s*\/>/g, '');
  return output.replace(/\s*<\/head>/, `\n  <meta name="nera-version" content="${version}" />\n  <meta name="nera-built-at" content="${builtAt}" />\n</head>`);
}

export async function stampSite(root, sha, builtAt = new Date().toISOString()) {
  if (!/^[a-f0-9]{8,40}$/i.test(sha)) throw new Error('A valid full or abbreviated commit SHA is required');
  const version = sha.slice(0,8);
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes:true })) {
      const path = join(directory,item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.name.endsWith('.js')) await writeFile(path, stampJavaScript(await readFile(path,'utf8'),version));
    }
  }
  await visit(join(root,'js'));
  const html = join(root,'index.html');
  await writeFile(html,stampHTML(await readFile(html,'utf8'),version,builtAt));
  await writeFile(join(root,'version.json'),JSON.stringify({sha,builtAt})+'\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await stampSite(resolve(process.argv[2] ?? '_site'), process.argv[3] ?? process.env.GITHUB_SHA ?? '');
}
