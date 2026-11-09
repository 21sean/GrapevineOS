import { store } from "./store.js";
import type { LlmProviderId } from "./types.js";
import { isHostedProvider, isSupportedProvider } from "./types.js";
import { hostedModel } from "./llm/hosted.js";
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
  const provider = await activeProvider(opts.model);
  if (!isSupportedProvider(provider)) {
    throw new LlmGateError(
      "unsupported_provider",
      "Choose a supported provider in Admin → Providers",
    );
  }
  return generateTyped({
    task: opts.task,
    context: opts.context,
    provider: isHostedProvider(provider) ? provider : undefined,
    model: isHostedProvider(provider)
      ? hostedModel(provider)
      : llmModel(opts.model || (await store.settings()).model),
    baseUrl: isHostedProvider(provider) ? undefined : await llmBase(),
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
}
