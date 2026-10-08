import { stripPlan } from "./plan-parser.js";
import { stripThinking } from "./thinking-text.js";
export { stripThinking };
export function storyText(text) {
  return stripPlan(stripThinking(text));
}
