/**
 * Curated catalog of Ollama-pullable open-weights models, grouped by the
 * company that trains them, enriched with metadata from models.dev.
 */

interface CatalogModel {
  tag: string; // ollama pull tag
  label: string;
  params: string;
  downloadSize: string;
  blurb: string;
  context?: number;
  releaseDate?: string;
  reasoning?: boolean;
  vision?: boolean;
}

interface CatalogCompany {
  id: string; // models.dev logo id
  name: string;
  models: CatalogModel[];
}

const CURATED: CatalogCompany[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { tag: "gpt-oss:20b", label: "GPT-OSS 20B", params: "20B", downloadSize: "14 GB", blurb: "OpenAI's open-weights reasoning model, MoE", reasoning: true },
      { tag: "gpt-oss:120b", label: "GPT-OSS 120B", params: "120B", downloadSize: "65 GB", blurb: "Larger sibling — needs ~80 GB RAM/VRAM", reasoning: true },
    ],
  },
  {
    id: "meta",
    name: "Meta",
    models: [
      { tag: "llama3.3:70b", label: "Llama 3.3 70B", params: "70B", downloadSize: "43 GB", blurb: "Flagship open Llama, strong general model" },
      { tag: "llama3.1:8b", label: "Llama 3.1 8B", params: "8B", downloadSize: "4.9 GB", blurb: "Workhorse small model, great tool use" },
      { tag: "llama3.2:3b", label: "Llama 3.2 3B", params: "3B", downloadSize: "2.0 GB", blurb: "Tiny and fast, fine for extraction" },
    ],
  },
  {
    id: "google",
    name: "Google",
    models: [
      { tag: "gemma3:27b", label: "Gemma 3 27B", params: "27B", downloadSize: "17 GB", blurb: "Best open Gemma, multimodal", vision: true },
      { tag: "gemma3:12b", label: "Gemma 3 12B", params: "12B", downloadSize: "8.1 GB", blurb: "Sweet spot for 16 GB machines", vision: true },
      { tag: "gemma3:4b", label: "Gemma 3 4B", params: "4B", downloadSize: "3.3 GB", blurb: "Small multimodal", vision: true },
    ],
  },
  {
    id: "alibaba",
    name: "Alibaba (Qwen)",
    models: [
      { tag: "qwen3:32b", label: "Qwen 3 32B", params: "32B", downloadSize: "20 GB", blurb: "Dense flagship, hybrid thinking", reasoning: true },
      { tag: "qwen3:14b", label: "Qwen 3 14B", params: "14B", downloadSize: "9.3 GB", blurb: "Strong mid-size reasoner", reasoning: true },
      { tag: "qwen3:8b", label: "Qwen 3 8B", params: "8B", downloadSize: "5.2 GB", blurb: "Fast, good JSON discipline", reasoning: true },
      { tag: "qwen2.5vl:7b", label: "Qwen 2.5 VL 7B", params: "7B", downloadSize: "6.0 GB", blurb: "Vision-language — reads flyers/screenshots", vision: true },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    models: [
      { tag: "deepseek-r1:32b", label: "DeepSeek R1 32B", params: "32B", downloadSize: "20 GB", blurb: "Distilled reasoner (Qwen base)", reasoning: true },
      { tag: "deepseek-r1:14b", label: "DeepSeek R1 14B", params: "14B", downloadSize: "9.0 GB", blurb: "Distilled reasoner, mid-size", reasoning: true },
      { tag: "deepseek-r1:8b", label: "DeepSeek R1 8B", params: "8B", downloadSize: "5.2 GB", blurb: "Distilled reasoner, small", reasoning: true },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    models: [
      { tag: "mistral-small3.2", label: "Mistral Small 3.2", params: "24B", downloadSize: "15 GB", blurb: "Excellent instruction following", vision: true },
      { tag: "magistral", label: "Magistral", params: "24B", downloadSize: "14 GB", blurb: "Mistral's open reasoning model", reasoning: true },
      { tag: "mistral-nemo", label: "Mistral Nemo", params: "12B", downloadSize: "7.1 GB", blurb: "128k context, multilingual" },
    ],
  },
  {
    id: "microsoft",
    name: "Microsoft",
    models: [
      { tag: "phi4", label: "Phi-4", params: "14B", downloadSize: "9.1 GB", blurb: "Punches above its weight on reasoning" },
      { tag: "phi4-mini", label: "Phi-4 Mini", params: "3.8B", downloadSize: "2.5 GB", blurb: "Tiny with function calling" },
    ],
  },
  {
    id: "ibm",
    name: "IBM",
    models: [
      { tag: "granite3.3:8b", label: "Granite 3.3 8B", params: "8B", downloadSize: "4.9 GB", blurb: "Enterprise-tuned, 128k context" },
    ],
  },
];

let modelsDevCache: { at: number; data: any } | null = null;

async function modelsDev(): Promise<any | null> {
  if (modelsDevCache && Date.now() - modelsDevCache.at < 60 * 60 * 1000) {
    return modelsDevCache.data;
  }
  try {
    const res = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return modelsDevCache?.data ?? null;
    const data = await res.json();
    modelsDevCache = { at: Date.now(), data };
    return data;
  } catch {
    return modelsDevCache?.data ?? null;
  }
}

/** Find an open-weights models.dev entry whose name fuzzily matches. */
function enrich(db: any, model: CatalogModel): CatalogModel {
  if (!db) return model;
  const needle = model.label.toLowerCase().replace(/[^a-z0-9.]/g, "");
  for (const provider of Object.values<any>(db)) {
    for (const m of Object.values<any>(provider.models ?? {})) {
      if (!m.open_weights) continue;
      const hay = String(m.name ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");
      if (hay === needle || hay.includes(needle) || needle.includes(hay)) {
        return {
          ...model,
          context: m.limit?.context ?? model.context,
          releaseDate: m.release_date ?? model.releaseDate,
          reasoning: model.reasoning ?? Boolean(m.reasoning),
        };
      }
    }
  }
  return model;
}

export async function catalog(): Promise<CatalogCompany[]> {
  const db = await modelsDev();
  return CURATED.map((c) => ({
    ...c,
    models: c.models.map((m) => enrich(db, m)),
  }));
}

const logoCache = new Map<string, string>();
const FALLBACK_LOGO = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 7v10M7 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

export async function logo(id: string): Promise<string> {
  const safe = id.replace(/[^a-z0-9-]/g, "");
  if (logoCache.has(safe)) return logoCache.get(safe)!;
  try {
    const res = await fetch(`https://models.dev/logos/${safe}.svg`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const svg = await res.text();
      logoCache.set(safe, svg);
      return svg;
    }
  } catch {
    /* fall through to fallback */
  }
  return FALLBACK_LOGO;
}
