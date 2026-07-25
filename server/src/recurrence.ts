/**
 * Recurrence handling lives in shared/recurrence.ts — one implementation for
 * the server and the web client (which re-exports it the same way), so the
 * two runtimes can never disagree about when an event repeats.
 */
export {
  normalizeRRule,
  parseRRule,
  nextOccurrence,
  recurrenceSummary,
  type ParsedRRule,
} from "../../shared/recurrence.js";
