import { LLM_RETRIES, LLM_RETRY_DELAY_MS, LLM_TIMEOUT_MS } from "./budget.js";
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
 *
 * Every request carries a deadline. Without one, a model that wedges (or a
 * connection that dies without an RST) blocks the caller forever — and since
 * the inbox processes rows serially, one such call stops the whole pipeline
 * with no error and no timestamp to show for it. A timeout turns that into an
 * ordinary failed row that retries. Budgets live in budget.ts.
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

  const post = (body: unknown) =>
    fetch(`${base}/api/chat`, {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

  const attempt = async (): Promise<any> => {
    let res = await post({ ...payload, think: false });
    if (!res.ok) {
      const errText = await res.text();
      if (/think/i.test(errText)) res = await post(payload);
      if (!res.ok) throw new Error(`ollama chat failed: ${errText.slice(0, 300)}`);
    }
    const body = (await res.json()) as any;
    // Same salvage parser the CLI providers use — identical model output must
    // parse identically no matter which engine produced it.
    return parseLooseJSON(body.message?.content ?? "");
  };

  let lastErr: unknown;
  for (let i = 0; i <= LLM_RETRIES; i++) {
    try {
      return await attempt();
    } catch (err) {
      // A timeout or a dropped connection is worth one more try (a cold model
      // paging into VRAM looks exactly like this). A prompt the model refuses
      // to answer will fail identically every time, so the cap is low.
      lastErr = err;
      if (i < LLM_RETRIES) await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}
