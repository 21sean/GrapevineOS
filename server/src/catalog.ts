/**
 * Model catalog, fully data-driven — no hardcoded model facts.
 *
 * Pipeline:
 *  1. models.dev/api.json (open-source, community-maintained) supplies every
 *     known model: names, release dates, context windows, modalities,
 *     reasoning flags, descriptions.
 *  2. Keep open-weights models whose earliest release date across all
 *     providers is on/after CATALOG_MIN_RELEASE (default 2026-01-01).
 *  3. Derive candidate Ollama pull tags from the names algorithmically and
 *     verify each against the Ollama registry manifests. Only locally
 *     pullable tags survive; the manifest's layers give the true download
 *     size. Cloud-only and API-only models fall out here on their own.
 *  4. Group by model family; logos come from models.dev too.
 */

const MIN_RELEASE = process.env.CATALOG_MIN_RELEASE ?? "2026-01-01";
const CATALOG_TTL = 6 * 60 * 60 * 1000; // registry verification is ~100 requests
const REGISTRY = "https://registry.ollama.ai/v2/library";

export interface CatalogModel {
  tag: string; // ollama pull tag, registry-verified
  label: string;
  sizeGB: number; // actual pull size from the registry manifest
  downloadSize: string;
  blurb: string;
  context?: number;
  releaseDate?: string;
  reasoning?: boolean;
  vision?: boolean;
}

export interface CatalogCompany {
  id: string; // models.dev logo id (model family)
  name: string;
  models: CatalogModel[];
}

// ---------- models.dev ----------

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

// ---------- name → candidate ollama tags ----------

/** Host/quant decorations that describe a deployment, not the model. */
const DECORATION =
  /^(free|fast|turbo|nitro|highspeed|high|speed|flex|short|tee|el|preview|instruct|it|chat|base|thinking|lightning|ultraspeed|throughput|heretic|uncensored|fp8|fp16|bf16|nvfp4|mlx|gguf|awq|exl2|\d{4}|iq\d.*|q\d.*|a\d+b|[48]bit)$/;

const SIZE = /^(\d+(?:\.\d+)?|e\d+)b$/; // 9b, 1.2b, e4b
const SIZE_COMBO = /^(\d+(?:\.\d+)?b)-a\d+b$/; // 35b-a3b → also try 35b

function stripHosting(rawName: string): string {
  let n = rawName.toLowerCase();
  n = n.slice(n.lastIndexOf("/") + 1); // "qwen/qwen3.5-9b" → "qwen3.5-9b"
  n = n.replace(/\(.*?\)/g, " "); // "(free)", "(mlx 4-bit)"
  const colon = n.indexOf(":");
  // "z.ai: glm 5" is a vendor prefix; "gemma4:31b" is a literal tag
  if (colon !== -1 && n[colon + 1] === " ") n = n.slice(colon + 1);
  return n.trim();
}

/**
 * Ollama's naming is inconsistent (gemma4, glm-4.7-flash, granite4.1), so
 * emit both joined and hyphenated forms and let the registry decide.
 */
function candidateTags(rawName: string, providerWords: Set<string>): string[] {
  const name = stripHosting(rawName);
  if (!name) return [];
  if (name.includes(":")) return [name.replace(/\s+/g, "")]; // literal tag

  const tokens = name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .filter((t) => !DECORATION.test(t));
  const variants: string[][] = [tokens];
  // "google gemma 4" — also try without the lab prefix, but keep the
  // original too ("mistral small" would lose its family otherwise)
  if (tokens.length > 1 && providerWords.has(tokens[0])) variants.push(tokens.slice(1));

  const out = new Set<string>();
  for (const toks of variants) {
    const sizes: string[] = [];
    const base: string[] = [];
    for (const t of toks) {
      const combo = t.match(SIZE_COMBO);
      if (combo) {
        sizes.push(t, combo[1]);
        continue;
      }
      if (SIZE.test(t)) {
        sizes.push(t);
        continue;
      }
      base.push(t);
    }
    if (!base.length) continue;
    for (const b of [base.join(""), base.join("-")]) {
      if (sizes.length) for (const s of sizes) out.add(`${b}:${s}`);
      else out.add(b);
    }
  }
  return [...out];
}

// ---------- candidate collection ----------

interface Meta {
  label: string;
  family: string;
  blurb: string;
  context?: number;
  /** every provider's claimed release date — reduced to a median later */
  dates: string[];
  releaseDate?: string;
  reasoning?: boolean;
  vision?: boolean;
}

/** Lower median — robust against providers with wrong outlier dates. */
function medianDate(dates: string[]): string | undefined {
  if (!dates.length) return undefined;
  const sorted = [...dates].sort();
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function cleanLabel(rawName: string): string {
  let n = rawName.replace(/\(.*?\)/g, " ");
  n = n.slice(n.lastIndexOf("/") + 1);
  const colon = n.indexOf(":");
  if (colon !== -1 && n[colon + 1] === " ") n = n.slice(colon + 1);
  return n.replace(/\s+/g, " ").trim();
}

/** Prefer human names ("Gemma 4 31B") over raw tags, then the shortest. */
function betterLabel(a: string, b: string): string {
  const aSpace = a.includes(" ");
  if (aSpace !== b.includes(" ")) return aSpace ? a : b;
  return b.length < a.length ? b : a;
}

function mergeMeta(a: Meta, b: Meta): Meta {
  return {
    label: betterLabel(a.label, b.label),
    family: a.family || b.family,
    blurb: a.blurb || b.blurb,
    context: a.context ?? b.context,
    dates: [...a.dates, ...b.dates],
    reasoning: a.reasoning || b.reasoning || undefined,
    vision: a.vision || b.vision || undefined,
  };
}

function collectCandidates(db: any): Map<string, Meta> {
  const providerWords = new Set<string>();
  for (const [id, provider] of Object.entries<any>(db)) {
    providerWords.add(id.toLowerCase());
    for (const w of String(provider?.name ?? "")
      .toLowerCase()
      .split(/\s+/)) {
      if (w) providerWords.add(w);
    }
  }

  const map = new Map<string, Meta>();
  for (const provider of Object.values<any>(db)) {
    for (const m of Object.values<any>(provider?.models ?? {})) {
      if (!m?.open_weights) continue;
      const name = String(m.name ?? "");
      if (!name) continue;
      // "(latest)" entries are provider aliases, not models — the ollama tag
      // they'd normalize to can point at an older generation
      if (/\(latest\)/i.test(name)) continue;
      // chat catalog: skip purpose-built embedding / reranker models
      if (/\b(embed(ding)?s?|rerank(er)?s?)\b/i.test(name)) continue;
      const meta: Meta = {
        label: cleanLabel(name),
        family: String(m.family ?? "").toLowerCase(),
        blurb: String(m.description ?? ""),
        context: m.limit?.context,
        dates: m.release_date ? [String(m.release_date)] : [],
        reasoning: Boolean(m.reasoning) || undefined,
        vision: m.modalities?.input?.includes("image") || undefined,
      };
      for (const tag of candidateTags(name, providerWords)) {
        const prev = map.get(tag);
        map.set(tag, prev ? mergeMeta(prev, meta) : meta);
      }
    }
  }

  // the release filter runs after merging: the median date across providers
  // rejects re-hosts of older models without letting one provider's bad
  // date veto (or sneak in) a model
  for (const [tag, meta] of map) {
    meta.releaseDate = medianDate(meta.dates);
    if (!meta.releaseDate || meta.releaseDate < MIN_RELEASE) map.delete(tag);
  }
  return map;
}

// ---------- ollama registry verification ----------

async function manifest(tag: string): Promise<{ gb: number; digest: string } | null> {
  const [name, ver = "latest"] = tag.split(":");
  try {
    const res = await fetch(
      `${REGISTRY}/${encodeURIComponent(name)}/manifests/${encodeURIComponent(ver)}`,
      {
        headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const m: any = await res.json();
    const bytes = (m.layers ?? []).reduce((sum: number, l: any) => sum + (l?.size ?? 0), 0);
    if (!(bytes > 0)) return null;
    return { gb: bytes / 2 ** 30, digest: String(m.config?.digest ?? "") };
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------- assembly ----------

const displayFamily = (f: string) =>
  f
    .split("-")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

/** "qwen3.5:9b" → "qwen" when models.dev didn't name the family. */
const familyFromTag = (tag: string) => tag.split(/[\d.:@-]/)[0] || "other";

let catalogCache: { at: number; data: CatalogCompany[] } | null = null;

export async function catalog(): Promise<CatalogCompany[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) {
    return catalogCache.data;
  }
  const db = await modelsDev();
  if (!db) return catalogCache?.data ?? [];

  const candidates = collectCandidates(db);
  const tags = [...candidates.keys()];
  const found = await mapLimit(tags, 12, manifest);

  // several aliases can resolve to the same blobs (qwen3.5 vs qwen3.5:9b) —
  // keep one per digest, preferring the explicit, shorter tag
  const byDigest = new Map<string, { tag: string; gb: number; meta: Meta }>();
  tags.forEach((tag, i) => {
    const hit = found[i];
    if (!hit) return;
    const key = `${tag.split(":")[0].replace(/-/g, "")}@${hit.digest}`;
    const prev = byDigest.get(key);
    const better =
      !prev ||
      (tag.includes(":") && !prev.tag.includes(":")) ||
      (tag.includes(":") === prev.tag.includes(":") && tag.length < prev.tag.length);
    if (better) {
      byDigest.set(key, { tag, gb: hit.gb, meta: candidates.get(tag)! });
    }
  });

  const byFamily = new Map<string, CatalogModel[]>();
  for (const { tag, gb, meta } of byDigest.values()) {
    const family = meta.family || familyFromTag(tag);
    const sizeGB = Math.round(gb * 10) / 10;
    const list = byFamily.get(family) ?? [];
    list.push({
      tag,
      label: meta.label,
      sizeGB,
      downloadSize: `${sizeGB} GB`,
      blurb: meta.blurb,
      context: meta.context,
      releaseDate: meta.releaseDate,
      reasoning: meta.reasoning,
      vision: meta.vision,
    });
    byFamily.set(family, list);
  }

  const newest = (models: CatalogModel[]) =>
    models.reduce((max, m) => (m.releaseDate && m.releaseDate > max ? m.releaseDate : max), "");
  const data = [...byFamily.entries()]
    .map(([family, models]) => ({
      id: family,
      name: displayFamily(family),
      models: models.sort((a, b) => a.sizeGB - b.sizeGB),
    }))
    .sort((a, b) => newest(b.models).localeCompare(newest(a.models)));

  if (data.length) catalogCache = { at: Date.now(), data };
  return data.length ? data : (catalogCache?.data ?? []);
}

// ---------- logos ----------

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
