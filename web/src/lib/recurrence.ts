/**
 * Recurrence handling lives in shared/recurrence.ts — one implementation for
 * the web client and the server (which re-exports it the same way), so the
 * two runtimes can never disagree about when an event repeats.
 */
export {
  normalizeRRule,
  parseRRule,
  nextOccurrence,
  recurrenceSummary,
  type ParsedRRule,
} from "../../../shared/recurrence"
