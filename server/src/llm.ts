import { ollamaBase } from "./ollama.js";
import { store } from "./store.js";
import type { LlmProviderId } from "./types.js";
import { generateTyped, LlmGateError } from "./llm/gateway.js";
import type { Output, Task, ValidationContext } from "./llm/generated.js";

export async function activeProvider(model?: string): Promise<LlmProviderId> {
  return model ? "ollama" : (await store.settings()).extractProvider;
}

export async function generateJSON<T extends Task>(opts: {
  task: T;
  system: string;
  user: string;
  model?: string;
  context?: ValidationContext;
}): Promise<Output<T>> {
  if ((await activeProvider(opts.model)) !== "ollama") {
    throw new LlmGateError("unsupported_provider", "Structured inference requires local Ollama");
  }
  return generateTyped({
    task: opts.task,
    context: opts.context,
    model: opts.model || (await store.settings()).model,
    baseUrl: await ollamaBase(),
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
}
