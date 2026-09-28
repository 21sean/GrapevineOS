/**
 * One JSON-salvage parser for every LLM output path (Ollama chat and the CLI
 * providers). Models wrap JSON in think-tags, code fences, and prose, and
 * the same malformed output must parse the same way no matter which engine
 * produced it.
 */
export function parseLooseJSON(text: string): any {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to the outermost {...} span
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(cleaned.slice(first, last + 1));
  }
  throw new Error(`model returned unparseable JSON: ${cleaned.slice(0, 200)}`);
}
