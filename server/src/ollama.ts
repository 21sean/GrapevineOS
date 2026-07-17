import { parseLooseJSON } from "./llm-json.js";
import { store } from "./store.js";

export async function ollamaBase(): Promise<string> {
  return (
    (await store.settings()).ollamaUrl ||
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
  const base = await ollamaBase();
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags → ${res.status}`);
  const body = (await res.json()) as { models: any[] };
  const models = body.models ?? [];
  const withCaps = await Promise.all(
    models.map(async (m) => {
      let capabilities: string[] = m.capabilities ?? [];
      if (!capabilities.length) {
        try {
          const show = await fetch(`${base}/api/show`, {
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

const toolSupport = new Map<string, boolean>();

/** Whether the model advertises the "tools" capability (cached per model). */
export async function modelSupportsTools(model: string): Promise<boolean> {
  const cached = toolSupport.get(model);
  if (cached !== undefined) return cached;
  const base = await ollamaBase();
  let ok = false;
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      const caps = ((await res.json()) as any).capabilities ?? [];
      ok = caps.includes("tools");
    }
  } catch {
    /* treat probe failure as no tools; the chat itself will surface errors */
  }
  toolSupport.set(model, ok);
  return ok;
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
  const model = opts.model || (await store.settings()).model;
  if (!model) throw new Error("No Ollama model selected (set one in Admin → Models)");
  const base = await ollamaBase();

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

  let res = await fetch(`${base}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ ...payload, think: false }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (/think/i.test(errText)) {
      res = await fetch(`${base}/api/chat`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) throw new Error(`ollama chat failed: ${errText.slice(0, 300)}`);
  }

  const body = (await res.json()) as any;
  // Same salvage parser the CLI providers use — identical model output must
  // parse identically no matter which engine produced it.
  return parseLooseJSON(body.message?.content ?? "");
}
