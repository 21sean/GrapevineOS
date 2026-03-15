import { store } from "./store.js";

export function ollamaBase(): string {
  return (
    store.settings().ollamaUrl ||
    process.env.OLLAMA_URL ||
    "http://localhost:11434"
  ).replace(/\/$/, "");
}

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  family: string;
  parameterSize: string;
  capabilities: string[];
}

export async function listInstalled(): Promise<InstalledModel[]> {
  const res = await fetch(`${ollamaBase()}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags → ${res.status}`);
  const body = (await res.json()) as { models: any[] };
  const models = body.models ?? [];
  const withCaps = await Promise.all(
    models.map(async (m) => {
      let capabilities: string[] = m.capabilities ?? [];
      if (!capabilities.length) {
        try {
          const show = await fetch(`${ollamaBase()}/api/show`, {
            method: "POST",
            body: JSON.stringify({ model: m.name }),
          });
          if (show.ok) capabilities = ((await show.json()) as any).capabilities ?? [];
        } catch {
          /* capability probe is best-effort */
        }
      }
      return {
        name: m.name as string,
        sizeBytes: m.size as number,
        family: m.details?.family ?? "",
        parameterSize: m.details?.parameter_size ?? "",
        capabilities,
      };
    }),
  );
  return withCaps;
}

/**
 * Chat with the active model and get parsed JSON back.
 * Uses Ollama's `format: "json"`; retries without `think` if the
 * model doesn't accept the thinking flag.
 */
export async function chatJSON(opts: {
  system: string;
  user: string;
  model?: string;
}): Promise<any> {
  const model = opts.model || store.settings().model;
  if (!model) throw new Error("No Ollama model selected (set one in Admin → Models)");

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    format: "json",
    options: { temperature: 0.1, num_ctx: 16384 },
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };

  let res = await fetch(`${ollamaBase()}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ ...payload, think: false }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (/think/i.test(errText)) {
      res = await fetch(`${ollamaBase()}/api/chat`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) throw new Error(`ollama chat failed: ${errText.slice(0, 300)}`);
  }

  const body = (await res.json()) as any;
  let content: string = body.message?.content ?? "";
  content = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`model returned unparseable JSON: ${content.slice(0, 200)}`);
  }
}
