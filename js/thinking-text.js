// Only assistant/model output is cleaned. Author directions remain user input.
export function stripThinking(text = "") {
  text = String(text ?? "");
  let depth = 0;
  let cursor = 0;
  let output = "";
  for (const match of text.matchAll(/<(\/?)(?:think|thinking)\b[^>]*>/gi)) {
    if (depth === 0) output += text.slice(cursor, match.index);
    depth = match[1] ? Math.max(0, depth - 1) : depth + 1;
    cursor = match.index + match[0].length;
  }
  if (depth === 0) output += text.slice(cursor);
  return output
    .replace(/<(?:think|thinking)\b[^>]*$/i, "")
    .replace(/<(?:t|th|thi|thin|think|thinki|thinkin|thinking)?$/i, "")
    .trim();
}

