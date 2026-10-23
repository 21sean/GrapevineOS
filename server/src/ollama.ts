import { store } from "./store.js";

/** Compatibility helper for detecting unsupported thinking options. */
export function thinkFlagRejected(err: unknown): boolean {
  return /think/i.test(String((err as Error)?.message ?? err));
}

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
