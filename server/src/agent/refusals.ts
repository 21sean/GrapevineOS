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

/**
 * What a person reads when a turn dies instead of answering. One place, so the
 * chat bridge and the red-team bridge cannot drift: the attack has to be scored
 * on the text the browser would really have shown.
 */
export function turnFailureText(err: unknown): string {
  return /timeout|abort/i.test(String(err))
    ? "That took too long. Try a smaller question or a faster model."
    : String(err).slice(0, 300);
}
