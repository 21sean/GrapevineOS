/**
 * One JSON-task entry point for the pipeline (extraction, buzz ratings).
 *
 * Routes to whichever engine Admin → Providers picked: the local Ollama model
 * (default, fully private) or a subscription-authed CLI — Claude Code
 * (`claude -p`), Codex, Gemini, or Copilot. The CLIs trade "nothing leaves
 * your machine" for running the pipeline without a local GPU, still with no
 * API keys.
 */
import { chatJSON } from "./ollama.js";
import {
  cliJSON,
  detectProviders,
  providerInfo,
  type CliProviderId,
} from "./providers.js";
import { store } from "./store.js";

export async function generateJSON(opts: {
  system: string;
  user: string;
  /** Explicit Ollama model tag — forces the local path regardless of settings. */
  model?: string;
}): Promise<any> {
  const provider = opts.model ? "ollama" : (await store.settings()).extractProvider;
  if (provider === "ollama") return chatJSON(opts);
  await assertCliReady(provider);
  return cliJSON(provider, { system: opts.system, user: opts.user });
}

/** Fail with a fixable message instead of a cryptic spawn error. */
async function assertCliReady(id: CliProviderId): Promise<void> {
  const info = providerInfo(id);
  const status = (await detectProviders()).find((p) => p.id === id);
  if (!status?.installed) {
    throw new Error(
      `${info.name} isn't installed on the server machine (${info.installHint}). ` +
        `Install it or switch extraction back to Ollama in Admin → Providers.`,
    );
  }
  if (!status.authed) {
    throw new Error(
      `${info.name} isn't signed in. Run: ${info.loginHint} — ${info.loginNote}. ` +
        `Or switch extraction back to Ollama in Admin → Providers.`,
    );
  }
}
