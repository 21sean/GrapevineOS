import { store } from "./store.js";
import type { LlmProviderId } from "./types.js";
import { generateTyped, LlmGateError } from "./llm/gateway.js";
import { llmBase, llmModel } from "./llm/runtime.js";
import type { Output, Task, ValidationContext } from "./llm/generated.js";

async function activeProvider(model?: string): Promise<LlmProviderId> {
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
    throw new LlmGateError("unsupported_provider", "Structured inference requires a local runtime");
  }
  return generateTyped({
    task: opts.task,
    context: opts.context,
    model: llmModel(opts.model || (await store.settings()).model),
    baseUrl: await llmBase(),
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
}
