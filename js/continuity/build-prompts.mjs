// Rebuild browser prompt exports after editing prompts/*.md.
// Run: node js/continuity/build-prompts.mjs [--check]
import { readFile, writeFile } from "node:fs/promises";

const entries = [
  ["NARRATOR_CONTRACT", "continuity-narrator.md"],
  ["TOOL_POLICY", "continuity-tools.md"],
  ["SAVER_POLICY", "continuity-saver.md"],
  ["BALANCED_PREPARE_POLICY", "continuity-balanced.md"],
  ["REVIEWER_CONTRACT", "continuity-reviewer.md"],
  ["DEFAULT_CONTINUITY_STYLE_PROMPT", "continuity-style.md"],
];
const contents = await Promise.all(entries.map(async ([name, file]) => {
  const content = (await readFile(new URL(`../../prompts/${file}`, import.meta.url), "utf8")).trim();
  return `export const ${name} = ${JSON.stringify(content)};`;
}));
const output = "// Generated from prompts/*.md by build-prompts.mjs. Edit the Markdown sources.\n" +
  "// Application contracts and mode policies are injected as independent messages.\n" +
  contents.join("\n\n") + "\n";
const target = new URL("./prompts.js", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== output) throw new Error("Prompt exports are stale. Run node js/continuity/build-prompts.mjs.");
} else {
  await writeFile(target, output);
}
