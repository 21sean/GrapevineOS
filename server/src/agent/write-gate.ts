/**
 * Only the person can ask for a write.
 *
 * The model reads text from strangers: web pages, search snippets, and event
 * listings that arrive from newsletters. Telling it to treat that text as data
 * helps and is not a guarantee, so the decision does not rest with the model. A
 * tool call that changes stored data is checked against what the person typed
 * this turn, which is the one input an attacker writing a web page cannot touch.
 * A call that fails the check is not dropped: it turns into the proposal card the
 * person would have confirmed anyway, and the model is told nothing was written.
 *
 * Pure and deterministic, so the rule can be read and tested without a model.
 *
 *  - set_rarity always becomes a card. Rarity is shared catalog data, and nothing
 *    a visitor types should change it for everybody without a second look.
 *  - save_calendar saves only the events the person named in their message, or
 *    named by the agent in its previous reply when the person is answering it
 *    ("yes, book those"). Everything else on the call becomes a card.
 *  - discover_events commits only when the person asked to add events. Otherwise
 *    it runs as a dry run, which writes nothing.
 */
import type { CityEvent } from "../types.js";

export interface WriteIntent {
  /** What the person typed this turn. Never anything a tool returned. */
  userText: string;
  /** The agent's previous reply, for "yes, save those". Empty on a first turn. */
  priorAnswer: string;
}

const SAVE_REQUEST = /\b(?:save|add|book|put|keep|schedule)\b/i;
const AFFIRMATION =
  /^\s*(?:yes|yep|yeah|sure|ok|okay|please|do it|go ahead|sounds good|that works|perfect)\b/i;
const REFERS_BACK = /\b(?:it|them|those|that|these|this one|both|all)\b/i;
const ADD_TO_CATALOG = /\b(?:add|import|include|put)\b/i;
const EVENTS_NOUN = /\b(?:events?|them|those|these|it|that|ones?)\b/i;

/** Words too common to identify an event on their own. */
const FILLER = new Set([
  "the",
  "and",
  "with",
  "from",
  "for",
  "night",
  "show",
  "live",
  "concert",
  "event",
  "market",
  "sunday",
  "saturday",
  "friday",
  "guest",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words of a title that could identify the event in a sentence. */
function identifyingWords(title: string): string[] {
  return words(title).filter((w) => w.length >= 4 && !FILLER.has(w));
}

/** The text names this event: by id, by link, or by a word only its title has. */
export function namesEvent(text: string, event: Pick<CityEvent, "id" | "title">): boolean {
  if (text.toLowerCase().includes(event.id.toLowerCase())) return true;
  const spoken = new Set(words(text));
  return identifyingWords(event.title).some((w) => spoken.has(w));
}

/** Which of these events the person has asked to save, and which they have not. */
export function splitCalendarSave(
  ids: string[],
  events: Pick<CityEvent, "id" | "title">[],
  intent: WriteIntent,
): { save: string[]; propose: string[] } {
  const byId = new Map(events.map((e) => [e.id, e]));
  const asked = SAVE_REQUEST.test(intent.userText);
  const answering =
    AFFIRMATION.test(intent.userText) || (asked && REFERS_BACK.test(intent.userText));
  const save: string[] = [];
  const propose: string[] = [];
  for (const id of ids) {
    const event = byId.get(id);
    const authorized =
      !!event &&
      ((asked && namesEvent(intent.userText, event)) ||
        (answering && namesEvent(intent.priorAnswer, event)));
    (authorized ? save : propose).push(id);
  }
  return { save, propose };
}

/** Whether this message is the person asking for events to be added to the catalog. */
export function askedToAddEvents(intent: WriteIntent): boolean {
  return (
    ADD_TO_CATALOG.test(intent.userText) &&
    EVENTS_NOUN.test(intent.userText) &&
    // "Add it to my calendar" is about one person's calendar, not the shared catalog.
    !/\bcalendar\b/i.test(intent.userText)
  );
}
