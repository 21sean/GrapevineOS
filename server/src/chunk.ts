/**
 * Document chunking for extraction.
 *
 * Its own module so it can be tested without dragging in the store, the
 * geocoder, or a model client: this is pure string arithmetic, and the
 * correctness that matters (no event lost at a seam, no characters silently
 * abandoned) is exactly what a unit test can pin down.
 */
import { CHUNK_OVERLAP_CHARS, MAX_CHUNKS } from "./budget.js";

/**
 * Split a document into model-sized pieces that overlap.
 *
 * Prefers to cut on a blank line, then any newline, searching backwards from
 * the budget within the last 20% of the window. Newsletters separate events
 * with blank lines, so cutting there keeps an event whole far more often than
 * cutting at an arbitrary character. The overlap covers what that still
 * misses: an event split across the seam appears complete in the next piece,
 * and the duplicate collapses on the event id.
 *
 * Returns the pieces plus how many characters were abandoned to MAX_CHUNKS,
 * because a cap nobody is told about looks exactly like complete coverage.
 */
export function chunkDocument(
  text: string,
  budget: number,
  overlap = CHUNK_OVERLAP_CHARS,
  maxChunks = MAX_CHUNKS,
): { chunks: string[]; dropped: number } {
  if (text.length <= budget) return { chunks: [text], dropped: 0 };

  const chunks: string[] = [];
  const stride = Math.max(1, budget - overlap);
  let start = 0;

  while (start < text.length && chunks.length < maxChunks) {
    const hardEnd = Math.min(start + budget, text.length);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const window = text.slice(start + Math.floor(budget * 0.8), hardEnd);
      const para = window.lastIndexOf("\n\n");
      const line = window.lastIndexOf("\n");
      const rel = para >= 0 ? para : line;
      if (rel >= 0) end = start + Math.floor(budget * 0.8) + rel;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) return { chunks, dropped: 0 };
    start = Math.max(start + stride, end - overlap);
  }

  return { chunks, dropped: Math.max(0, text.length - start) };
}
