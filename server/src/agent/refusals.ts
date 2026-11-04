/**
 * The two canned replies the guardrails return in place of a blocked answer.
 * Both stay in character on purpose: a refusal that breaks the persona to
 * explain itself has already leaked what the rail was protecting.
 *
 * Import-free, so scripts that only need the words (the Langfuse traffic
 * simulator, the red-team bridge) can take them without loading the
 * classifier behind guardrails.ts.
 */

/** The input rail's reply: the message never reached the model. */
export function inputRefusalMessage(city: string): string {
  return `I'll pass on that one — it reads like an attempt to rewire me rather than a question about ${city}. Ask me about tonight, the weekend, or a vibe and I'm all yours.`;
}

/** The persona rail's reply: the answer was scrubbed mid-stream. */
export function personaRefusalMessage(city: string): string {
  return `I'm Grapevine, ${city}'s events concierge — how I'm built stays behind the bar. What are you in the mood for: live music, food, something free tonight?`;
}

/** The gate rejected every attempt: stay in character and fail closed, with no model text. */
export function gateFallbackMessage(city: string): string {
  return `I couldn't put a reliable answer together for that one. Ask me about what's on in ${city}: tonight, the weekend, or a vibe.`;
}

/**
 * What a person reads when a turn dies instead of answering. One place, so the
 * chat bridge and the red-team bridge cannot drift: the attack has to be scored
 * on the text the browser would really have shown. Error text stays in the log,
 * because the words of an exception name the machinery behind the concierge.
 */
export function turnFailureText(err: unknown): string {
  return /timeout|abort/i.test(String(err))
    ? "That took too long. Try a smaller question."
    : "Something went wrong on my end. Try that again in a moment.";
}
