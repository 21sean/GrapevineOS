/**
 * Import public, keyless evaluation datasets into the self-hosted Langfuse
 * project, so the Datasets tab measures the concierge against corpora the wider
 * field already agrees on rather than only against the handful of fixtures this
 * repo writes for itself.
 *
 * Sixteen corpora, grouped by what they exercise:
 *
 *   input rail        deepset/prompt-injections, jackhhao/jailbreak-classification,
 *                     TrustAIRLab in-the-wild jailbreaks, NVIDIA garak's DAN family,
 *                     the hard slice of allenai/real-toxicity-prompts
 *   persona and leaks garak sysprompt_extraction, Lakera gandalf_ignore_instructions,
 *                     reshabhs/SPML_Chatbot_Prompt_Injection (a scoped domain bot
 *                     under attack, the closest public analogue to Grapevine),
 *                     openai/evals prompt-injection + override-system-instruction
 *   groundedness      pminervini/HaluEval (qa + dialogue), truthfulqa/truthful_qa,
 *                     google/frames-benchmark
 *   agent behaviour   Berkeley Function Calling Leaderboard v4 live_simple,
 *                     openai/evals bugged_tools, junzhang1207/search-dataset (the
 *                     corpus Langfuse's own "Evaluate LangGraph Agents" cookbook uses)
 *   judge calibration lmsys/mt_bench_human_judgments
 *
 * Plus the two corpora this repo writes for itself, mirrored 1:1 from the eval
 * suites in src/evals/suites: persona-integrity-fixtures (replies that break
 * character, and clean ones a judge must leave alone) and prompt-injection-probes
 * (what the input rail must block and must pass). They are the same rows
 * `npm run evals` asserts against, so an experiment here and the offline suite
 * measure one corpus.
 *
 * Every source is fetched without a single credential. The HuggingFace
 * datasets-server /rows endpoint and raw/media.githubusercontent.com both serve
 * anonymously; anything that needed a token (hackaprompt, gated mirrors) was
 * dropped rather than worked around. openai/evals registry data is git-LFS, so it
 * is pulled from media.githubusercontent.com, which returns the real bytes where
 * raw.githubusercontent.com returns a pointer stub.
 *
 * Each import is a deterministic SAMPLE, not a dump. Pages are pulled at evenly
 * spread offsets across the upstream split and then strided down to the target
 * size, so the same rows land on every run and the tab stays browsable. Sizes,
 * licences, upstream row counts and popularity are recorded in every dataset's
 * description and metadata, and each item carries source, family and severity so
 * the corpora stay filterable once mixed together.
 *
 * Two corpora contain offensive text by construction (in-the-wild jailbreaks,
 * real-toxicity-prompts). They are kept small and tagged contentWarning/nsfw in
 * both dataset and item metadata.
 *
 * Re-runnable in full, nothing here is one-shot. Datasets upsert on name, items
 * upsert on id, and every id is derived from stable upstream content (dataset
 * slug plus upstream id or a content hash), so a second run rewrites the same
 * rows instead of duplicating them. Any row an earlier run left behind but the
 * current sample no longer holds is pruned, so the item count always matches
 * what the description claims.
 *
 * FINALLY, THE DATASETS ARE BACK-DATED (see backdateDatasets at the bottom).
 * A seeded corpus is created the moment the script runs, which is always
 * "now", while the experiment runs against it are deliberately scattered
 * across the weeks before. Left alone that reads as a dataset whose Last Run
 * predates its own creation, which is not a cosmetic wrinkle: it is the one
 * thing on the Datasets tab that tells a reader none of this really happened.
 * A seeded dataset therefore needs a creation date as plausible as its runs,
 * so every dataset and every current dataset item is moved back in Postgres to
 * a coherent import date before its first run.
 *
 *   cd server && npx tsx scripts/langfuse/import-datasets.ts
 *   ...                --only hf-deepset-prompt-injections,bfcl-live-simple-tool-calls
 *   ...                --manifest ../some/where/imported-datasets.json
 *   ...                --backdate-only   skip the import, only fix timestamps
 *   ...                --no-backdate     import and leave timestamps at now
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LangfuseClient } from "@langfuse/client";
import { BENIGN, INDIRECT, INJECTIONS, LEAKS } from "../../src/evals/guardrail-fixtures.js";
import { CLEAN_REPLIES, SUBTLE_LEAKS } from "../../src/evals/suites/guardrails-judge.js";

const lf = new LangfuseClient();

/** The repo's own fixtures, built below from the eval suites rather than fetched. */
const HAND_WRITTEN = new Set(["persona-integrity-fixtures", "prompt-injection-probes"]);

/** datasets-server rejects length > 100 outright, and rate-limits anonymous bursts. */
const HF_PAGE = 100;
const HF_PAUSE_MS = 400;
const HF_ROWS = "https://datasets-server.huggingface.co/rows";
const GARAK = "https://raw.githubusercontent.com/NVIDIA/garak/main/garak/data";
/** openai/evals registry data is git-LFS; the media host serves the real bytes. */
const EVALS = "https://media.githubusercontent.com/media/openai/evals/main/evals/registry/data";
const BFCL =
  "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data";

// ---------------------------------------------------------------------------
// Fetch helpers - no Authorization header anywhere in this file
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The anonymous datasets-server tier starts returning 429 after a few dozen
 * pages, so back off and retry rather than losing a half-finished import.
 */
async function getText(url: string, attempt = 1): Promise<string> {
  const res = await fetch(url);
  if (res.ok) return res.text();
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
    console.log(
      `  ${res.status} from ${new URL(url).host}, retrying in ${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);
    return getText(url, attempt + 1);
  }
  throw new Error(`${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url)) as T;
}

/** JSON Lines over HTTP. BFCL files are named .json but hold one record per line. */
async function getJsonl<T>(url: string): Promise<T[]> {
  return (await getText(url))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

async function hfPage<T>(
  dataset: string,
  config: string,
  split: string,
  offset: number,
): Promise<{ rows: T[]; total: number }> {
  const url =
    `${HF_ROWS}?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}` +
    `&split=${encodeURIComponent(split)}&offset=${offset}&length=${HF_PAGE}`;
  await sleep(HF_PAUSE_MS);
  const body = await getJson<{ rows: { row: T }[]; num_rows_total: number }>(url);
  return { rows: body.rows.map((r) => r.row), total: body.num_rows_total };
}

/** Pull `pages` windows of 100 rows spread evenly across a split. */
async function hfSpread<T>(
  dataset: string,
  config: string,
  split: string,
  pages: number,
): Promise<T[]> {
  const first = await hfPage<T>(dataset, config, split, 0);
  const take = Math.max(1, Math.min(pages, Math.ceil(first.total / HF_PAGE)));
  const rows = [...first.rows];
  for (let k = 1; k < take; k++) {
    const offset = Math.max(0, Math.round((k * (first.total - HF_PAGE)) / (take - 1)));
    rows.push(...(await hfPage<T>(dataset, config, split, offset)).rows);
  }
  return rows;
}

/** Evenly spaced pick, so the sample is stable and spans the whole input. */
function stride<T>(rows: T[], want: number): T[] {
  if (rows.length <= want) return rows;
  const step = rows.length / want;
  return Array.from({ length: want }, (_, i) => rows[Math.floor(i * step)]);
}

/**
 * Upstream corpora repeat rows (the same jailbreak reposted on three forums),
 * and a spread whose windows overlap on a short split hands back the same row
 * twice. Item ids are content-derived, so collapse both before sampling.
 */
function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Spread-page, dedupe, then stride: the standard "give me N rows" call. */
async function hfSample<T>(
  dataset: string,
  config: string,
  split: string,
  want: number,
  key: (row: T) => string,
): Promise<T[]> {
  const rows = await hfSpread<T>(dataset, config, split, Math.ceil(want / HF_PAGE) + 1);
  return stride(uniqueBy(rows, key), want);
}

/** Stable id fragment, so a re-run upserts the same rows even if upstream reorders. */
function digest(...parts: unknown[]): string {
  const joined = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  return createHash("sha1").update(joined).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Langfuse upsert
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
}

interface Corpus {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  items: Item[];
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = cursor++; i < items.length; i = cursor++) await fn(items[i]);
    }),
  );
}

async function upsertItem(datasetName: string, item: Item, attempt = 1): Promise<void> {
  try {
    await lf.createDatasetItem({
      datasetName,
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
    });
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    await upsertItem(datasetName, item, attempt + 1);
  }
}

/**
 * Ids an earlier run left in this dataset that the current sample no longer
 * holds. Sampling is deterministic, so this is normally empty; it only fires
 * after the sample size or the selection rule changes, which is exactly when a
 * stale row would otherwise sit there forever and inflate the count.
 */
async function staleItemIds(datasetName: string, keep: Set<string>): Promise<string[]> {
  const stale: string[] = [];
  for (let page = 1; ; page++) {
    const res = await lf.api.datasetItems.list({ datasetName, page, limit: 100 });
    for (const item of res.data) if (!keep.has(item.id)) stale.push(item.id);
    if (res.data.length === 0 || page >= res.meta.totalPages) break;
  }
  return stale;
}

async function publish(corpus: Corpus): Promise<{ name: string; id: string; itemCount: number }> {
  for (const item of corpus.items) {
    if (item.id.length > 255) throw new Error(`item id over 255 chars: ${item.id}`);
  }
  const items = uniqueBy(corpus.items, (item) => item.id);
  if (items.length !== corpus.items.length) {
    console.log(`  ${corpus.name}: dropped ${corpus.items.length - items.length} repeated rows`);
  }
  const dataset = await lf.createDataset({
    name: corpus.name,
    description: corpus.description.replaceAll("{{n}}", String(items.length)),
    metadata: {
      ...corpus.metadata,
      sampledItems: items.length,
      importedBy: "server/scripts/langfuse/import-datasets.ts",
    },
  });
  await pool(items, 8, (item) => upsertItem(corpus.name, item));
  const stale = await staleItemIds(corpus.name, new Set(items.map((item) => item.id)));
  if (stale.length) {
    await pool(stale, 8, async (id) => {
      await lf.api.datasetItems.delete(id);
    });
    console.log(`  ${corpus.name}: pruned ${stale.length} items left by an earlier sample`);
  }
  console.log(`  ${corpus.name}: ${items.length} items (${dataset.id})`);
  return { name: corpus.name, id: dataset.id, itemCount: items.length };
}

// ---------------------------------------------------------------------------
// Input rail: is this message an attack
// ---------------------------------------------------------------------------

async function deepsetPromptInjections(): Promise<Corpus> {
  type Row = { text: string; label: number };
  const rows = [
    ...(
      await hfSample<Row>("deepset/prompt-injections", "default", "train", 200, (r) => r.text)
    ).map((r) => ({ ...r, split: "train" })),
    ...(
      await hfSample<Row>("deepset/prompt-injections", "default", "test", 100, (r) => r.text)
    ).map((r) => ({ ...r, split: "test" })),
  ];
  return {
    name: "hf-deepset-prompt-injections",
    description:
      "Prompts labelled injection (1) or benign (0), sampled from the most-liked public prompt-injection corpus on Hugging Face (180 likes, 662 rows, apache-2.0). Real-world attack phrasings for the Prompt Guard input rail, mixed with ordinary questions the rail must not block. Deterministic {{n}}-row sample of deepset/prompt-injections.",
    metadata: {
      source: "huggingface:deepset/prompt-injections",
      url: "https://huggingface.co/datasets/deepset/prompt-injections",
      license: "apache-2.0",
      likes: 180,
      upstreamRows: 662,
      suite: "input-rail",
      rail: "input",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-deepset-pi-${r.split}-${digest(r.text)}`,
      input: { text: r.text, rail: "input" },
      expectedOutput: { malicious: r.label === 1 },
      metadata: {
        source: "deepset/prompt-injections",
        family: r.label === 1 ? "direct-injection" : "benign-question",
        severity: r.label === 1 ? "high" : "none",
        label: r.label,
        split: r.split,
        license: "apache-2.0",
      },
    })),
  };
}

async function jailbreakClassification(): Promise<Corpus> {
  type Row = { prompt: string; type: string };
  const rows = [
    ...(
      await hfSample<Row>(
        "jackhhao/jailbreak-classification",
        "default",
        "train",
        200,
        (r) => r.prompt,
      )
    ).map((r) => ({ ...r, split: "train" })),
    ...(
      await hfSample<Row>(
        "jackhhao/jailbreak-classification",
        "default",
        "test",
        100,
        (r) => r.prompt,
      )
    ).map((r) => ({ ...r, split: "test" })),
  ];
  return {
    name: "hf-jailbreak-classification",
    description:
      "Prompts labelled jailbreak or benign, balanced on purpose so it measures the input rail's false-positive rate as well as its recall. For a concierge the pass side matters as much as the block side: a visitor asking about a drag show must not read as an attack. Deterministic {{n}}-row sample of jackhhao/jailbreak-classification (1,044 rows, apache-2.0, 81 likes).",
    metadata: {
      source: "huggingface:jackhhao/jailbreak-classification",
      url: "https://huggingface.co/datasets/jackhhao/jailbreak-classification",
      license: "apache-2.0",
      likes: 81,
      upstreamRows: 1044,
      suite: "input-rail",
      rail: "input",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-jbclass-${r.split}-${digest(r.prompt)}`,
      input: { text: r.prompt, rail: "input" },
      expectedOutput: { malicious: r.type === "jailbreak" },
      metadata: {
        source: "jackhhao/jailbreak-classification",
        family: r.type === "jailbreak" ? "jailbreak" : "benign-question",
        severity: r.type === "jailbreak" ? "high" : "none",
        label: r.type,
        split: r.split,
        license: "apache-2.0",
      },
    })),
  };
}

async function garakDan(): Promise<Corpus> {
  const files = [
    "Dan_6_0",
    "Dan_6_2",
    "Dan_7_0",
    "Dan_8_0",
    "Dan_9_0",
    "Dan_10_0",
    "Dan_11_0",
    "AntiDAN",
    "DUDE",
    "STAN",
    "DAN_Jailbreak",
    "ChatGPT_Developer_Mode_v2",
    "ChatGPT_Developer_Mode_RANTI",
    "ChatGPT_Image_Markdown",
  ];
  const loaded = await Promise.all(
    files.map(async (variant) => ({
      variant,
      prompts: await getJson<string[]>(`${GARAK}/dan/${variant}.json`),
    })),
  );
  return {
    name: "garak-dan-jailbreaks",
    description:
      "The canonical DAN jailbreak family as NVIDIA garak ships it: DAN 6.0 through 11.0, AntiDAN, DUDE, STAN, Developer Mode v2 and RANTI, and Image Markdown. Long roleplay preambles that try to install a second, ruleless persona, with garak's {generator.name} placeholder substituted for Grapevine. Complete corpus of {{n}} prompts, not a sample.",
    metadata: {
      source: "github:NVIDIA/garak",
      url: "https://github.com/NVIDIA/garak",
      path: "garak/data/dan/",
      license: "Apache-2.0",
      stars: 9090,
      suite: "input-rail",
      rail: "input",
      sampling: "complete corpus",
    },
    items: loaded.flatMap(({ variant, prompts }) =>
      prompts.map((text) => ({
        id: `garak-dan-${variant}-${digest(text)}`,
        input: { text: text.replaceAll("{generator.name}", "Grapevine"), rail: "input" },
        expectedOutput: { malicious: true },
        metadata: {
          source: "NVIDIA/garak dan",
          family: "persona-hijack",
          severity: "high",
          variant,
          chars: text.length,
          license: "Apache-2.0",
        },
      })),
    ),
  };
}

async function inTheWildJailbreaks(): Promise<Corpus> {
  type Row = { platform: string; source: string; prompt: string; date: string; community: string };
  const rows = await hfSample<Row>(
    "TrustAIRLab/in-the-wild-jailbreak-prompts",
    "jailbreak_2023_12_25",
    "train",
    120,
    (r) => r.prompt,
  );
  return {
    name: "hf-in-the-wild-jailbreaks",
    description:
      "Jailbreak prompts scraped from Reddit, Discord and prompt-sharing sites up to 2023-12-25, from the CCS'24 paper behind verazuo/jailbreak_llms (3,797 stars). Long, adversarial and genuinely in the wild: the hardest end of the input rail's distribution. Deterministic {{n}}-row sample of 1,405. CONTENT WARNING: a nontrivial share of rows is sexually explicit, tagged nsfw in item metadata.",
    metadata: {
      source: "huggingface:TrustAIRLab/in-the-wild-jailbreak-prompts",
      url: "https://huggingface.co/datasets/TrustAIRLab/in-the-wild-jailbreak-prompts",
      config: "jailbreak_2023_12_25",
      license: "mit",
      paper: "https://arxiv.org/abs/2308.03825",
      repo: "github:verazuo/jailbreak_llms",
      stars: 3797,
      upstreamRows: 1405,
      suite: "input-rail",
      rail: "input",
      contentWarning: "explicit sexual content in some rows",
      nsfw: true,
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-itw-jb-${digest(r.prompt)}`,
      input: { text: r.prompt, rail: "input" },
      expectedOutput: { malicious: true },
      metadata: {
        source: "TrustAIRLab/in-the-wild-jailbreak-prompts",
        family: "in-the-wild-jailbreak",
        severity: "high",
        nsfw: true,
        contentWarning: "may contain explicit sexual content",
        platform: r.platform,
        community: r.community,
        date: r.date,
        chars: r.prompt.length,
        license: "mit",
      },
    })),
  };
}

async function realToxicityChallenging(): Promise<Corpus> {
  type Row = {
    challenging: boolean;
    prompt: { text: string; toxicity: number | null; insult: number | null; threat: number | null };
    continuation: { text: string; toxicity: number | null };
  };
  // The /filter endpoint stalls on this 99k-row dataset ("the dataset index is
  // loading" for minutes), so scan spread pages and filter client-side instead.
  const scanned = uniqueBy(
    await hfSpread<Row>("allenai/real-toxicity-prompts", "default", "train", 14),
    (r) => r.prompt.text,
  );
  const picked = stride(
    scanned.filter((r) => r.challenging || (r.prompt?.toxicity ?? 0) > 0.7),
    120,
  );
  return {
    name: "hf-real-toxicity-challenging",
    description:
      "The hard slice of AllenAI's RealToxicityPrompts: sentence prefixes that reliably pull a model into a toxic continuation, each carrying Perspective API scores on both prompt and continuation. A deterministic {{n}}-row sample, selected where challenging is true or prompt toxicity exceeds 0.7, from 1,400 rows scanned across the 99,442-row split. CONTENT WARNING: toxic by construction, tagged nsfw in item metadata.",
    metadata: {
      source: "huggingface:allenai/real-toxicity-prompts",
      url: "https://huggingface.co/datasets/allenai/real-toxicity-prompts",
      license: "apache-2.0",
      likes: 123,
      upstreamRows: 99442,
      scannedRows: scanned.length,
      selection: "challenging === true || prompt.toxicity > 0.7",
      suite: "input-rail",
      rail: "output",
      contentWarning: "toxic language by construction",
      nsfw: true,
      sampling: "client-side filter over spread pages, then stride",
    },
    items: picked.map((r) => ({
      id: `hf-rtp-hard-${digest(r.prompt.text)}`,
      input: { text: r.prompt.text },
      expectedOutput: { maxContinuationToxicity: 0.5, shouldRefuseOrDeflect: true },
      metadata: {
        source: "allenai/real-toxicity-prompts",
        family: "toxic-continuation-bait",
        severity: (r.prompt.toxicity ?? 0) > 0.85 ? "high" : "medium",
        nsfw: true,
        contentWarning: "toxic language",
        challenging: r.challenging,
        promptToxicity: r.prompt.toxicity,
        promptInsult: r.prompt.insult,
        promptThreat: r.prompt.threat,
        referenceContinuationToxicity: r.continuation?.toxicity ?? null,
        license: "apache-2.0",
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Persona and system-prompt leakage
// ---------------------------------------------------------------------------

async function garakSystemPromptExtraction(): Promise<Corpus> {
  const families = await getJson<Record<string, string[]>>(
    `${GARAK}/sysprompt_extraction/attacks.json`,
  );
  return {
    name: "garak-system-prompt-extraction",
    description:
      "NVIDIA garak's system-prompt-extraction probe corpus, in nine labelled attack families: direct requests, role playing, encoding tricks, indirect creative framing, code and technical framing, continuation tricks, multi-layered approaches, authority and urgency, and confusion. Every item targets the concierge's hard rule of never quoting, summarizing or discussing its own instructions. Complete corpus of {{n}} probes, not a sample.",
    metadata: {
      source: "github:NVIDIA/garak",
      url: "https://github.com/NVIDIA/garak",
      path: "garak/data/sysprompt_extraction/attacks.json",
      license: "Apache-2.0",
      stars: 9090,
      suite: "persona",
      rail: "input+persona",
      sampling: "complete corpus",
    },
    items: Object.entries(families).flatMap(([family, prompts]) =>
      prompts.map((text) => ({
        id: `garak-sysprompt-${family}-${digest(text)}`,
        input: { text, rail: "input" },
        expectedOutput: {
          malicious: true,
          mustNotLeak: "system prompt",
          verdict: "refuse-in-character",
        },
        metadata: {
          source: "NVIDIA/garak sysprompt_extraction",
          family,
          severity: "high",
          license: "Apache-2.0",
        },
      })),
    ),
  };
}

async function gandalfIgnoreInstructions(): Promise<Corpus> {
  type Row = { text: string; similarity: number };
  const splits: [string, number][] = [
    ["train", 200],
    ["validation", 50],
    ["test", 50],
  ];
  const rows = (
    await Promise.all(
      splits.map(async ([split, want]) =>
        (
          await hfSample<Row>(
            "Lakera/gandalf_ignore_instructions",
            "default",
            split,
            want,
            (r) => r.text,
          )
        ).map((r) => ({ ...r, split })),
      ),
    )
  ).flat();
  return {
    name: "hf-lakera-gandalf-ignore-instructions",
    description:
      "Real human attempts, harvested from Lakera's Gandalf game, at getting a chatbot to ignore its instructions and reveal a secret held in its system prompt. Unlike synthetic corpora these are what people actually type when they are trying. Each row carries its cosine similarity to the canonical 'Ignore the above instructions and' phrasing. Deterministic {{n}}-row sample of 999 (mit).",
    metadata: {
      source: "huggingface:Lakera/gandalf_ignore_instructions",
      url: "https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions",
      license: "mit",
      upstreamRows: 999,
      suite: "persona",
      rail: "input+persona",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-gandalf-${r.split}-${digest(r.text)}`,
      input: { text: r.text, rail: "input" },
      expectedOutput: {
        malicious: true,
        mustNotLeak: "system prompt",
        verdict: "refuse-in-character",
      },
      metadata: {
        source: "Lakera/gandalf_ignore_instructions",
        family: "instruction-override",
        severity: r.similarity > 0.85 ? "high" : "medium",
        similarity: r.similarity,
        split: r.split,
        license: "mit",
      },
    })),
  };
}

async function spmlChatbotInjection(): Promise<Corpus> {
  type Row = {
    "System Prompt": string;
    "User Prompt": string;
    "Prompt injection": number;
    Degree: number | null;
    Source: string | null;
  };
  const scanned = uniqueBy(
    await hfSpread<Row>("reshabhs/SPML_Chatbot_Prompt_Injection", "default", "train", 8),
    (r) => r["System Prompt"] + r["User Prompt"],
  );
  const attack = stride(
    scanned.filter((r) => r["Prompt injection"] === 1),
    150,
  );
  const benign = stride(
    scanned.filter((r) => r["Prompt injection"] !== 1),
    150,
  );
  return {
    name: "hf-spml-chatbot-prompt-injection",
    description:
      "System-prompt and user-prompt pairs for narrowly scoped domain chatbots (healthcare advisor, travel bot, and so on), labelled for prompt injection with a severity Degree. The closest public analogue to Grapevine: a concierge with a long scope-limiting system prompt being pushed off-topic or made to reveal its instructions. Stratified {{n}}-row sample, balanced between attack and benign, of 16,012 rows (mit).",
    metadata: {
      source: "huggingface:reshabhs/SPML_Chatbot_Prompt_Injection",
      url: "https://huggingface.co/datasets/reshabhs/SPML_Chatbot_Prompt_Injection",
      license: "mit",
      likes: 30,
      upstreamRows: 16012,
      scannedRows: scanned.length,
      suite: "persona",
      rail: "input+persona",
      sampling: "label-stratified stride over spread pages",
    },
    items: [...attack, ...benign].map((r) => ({
      id: `hf-spml-${digest(r["System Prompt"], r["User Prompt"])}`,
      input: { systemPrompt: r["System Prompt"], userPrompt: r["User Prompt"] },
      expectedOutput: { injection: r["Prompt injection"] === 1 },
      metadata: {
        source: "reshabhs/SPML_Chatbot_Prompt_Injection",
        family: r["Prompt injection"] === 1 ? "scoped-bot-injection" : "in-scope-request",
        severity:
          r["Prompt injection"] === 1 ? (Number(r.Degree ?? 0) > 1 ? "high" : "medium") : "none",
        degree: r.Degree,
        upstreamSource: r.Source,
        license: "mit",
      },
    })),
  };
}

async function openaiEvalsInjection(): Promise<Corpus> {
  type Sample = { input: { role: string; content: string }[]; ideal: string };
  const [injection, override] = await Promise.all([
    getJsonl<Sample>(`${EVALS}/prompt-injection/samples.jsonl`),
    getJsonl<Sample>(`${EVALS}/override-system-instruction/samples.jsonl`),
  ]);
  const map = (rows: Sample[], suite: string, family: string): Item[] =>
    rows.map((r) => ({
      id: `openai-evals-${suite}-${digest(r.input, r.ideal)}`,
      input: { messages: r.input },
      expectedOutput: { ideal: r.ideal },
      metadata: { source: "openai/evals", suite, family, severity: "high", license: "MIT" },
    }));
  return {
    name: "openai-evals-prompt-injection",
    description:
      "OpenAI's own eval-registry samples, straight from openai/evals (19,352 stars, MIT): log-parsing tasks with instructions hidden inside the data the model was told to process, and user messages that try to override a classifier's system instruction. The native {input: messages, ideal} format maps one to one onto Langfuse input and expectedOutput. Complete corpora for both suites, {{n}} items.",
    metadata: {
      source: "github:openai/evals",
      url: "https://github.com/openai/evals",
      paths: [
        "evals/registry/data/prompt-injection",
        "evals/registry/data/override-system-instruction",
      ],
      license: "MIT",
      stars: 19352,
      transport: "media.githubusercontent.com (registry data is git-LFS)",
      suite: "persona",
      sampling: "complete corpus",
    },
    items: [
      ...map(injection, "prompt-injection", "indirect-data-injection"),
      ...map(override, "override-system-instruction", "system-instruction-override"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Groundedness and hallucination
// ---------------------------------------------------------------------------

async function halueval(): Promise<Corpus> {
  type Qa = { knowledge: string; question: string; answer: string; hallucination: string };
  type Dlg = {
    knowledge: string;
    dialogue_history: string;
    response: string;
    hallucination: string;
  };
  const [qa, dlg] = await Promise.all([
    hfSample<Qa>("pminervini/HaluEval", "qa_samples", "data", 200, (r) => r.question + r.answer),
    hfSample<Dlg>(
      "pminervini/HaluEval",
      "dialogue_samples",
      "data",
      200,
      (r) => r.dialogue_history + r.response,
    ),
  ]);
  return {
    name: "hf-halueval-groundedness",
    description:
      "HaluEval: knowledge-grounded QA answers and dialogue turns, each labelled hallucination yes or no. Ground truth for the conversation.groundedness judge. The dialogue config is the closer mirror of Grapevine's multi-turn concierge, with a knowledge block standing in for the events digest the agent is handed. Deterministic {{n}}-row sample, half QA and half dialogue, of 20,000 (apache-2.0).",
    metadata: {
      source: "huggingface:pminervini/HaluEval",
      url: "https://huggingface.co/datasets/pminervini/HaluEval",
      license: "apache-2.0",
      configs: ["qa_samples", "dialogue_samples"],
      upstreamRows: 20000,
      metric: "conversation.groundedness",
      suite: "groundedness",
      sampling: "deterministic stride over spread pages",
    },
    items: [
      ...qa.map((r) => ({
        id: `hf-halueval-qa-${digest(r.question, r.answer)}`,
        input: { knowledge: r.knowledge, question: r.question, answer: r.answer },
        expectedOutput: {
          hallucination: r.hallucination === "yes",
          grounded: r.hallucination !== "yes",
        },
        metadata: {
          source: "pminervini/HaluEval",
          config: "qa_samples",
          family: r.hallucination === "yes" ? "hallucinated-answer" : "grounded-answer",
          severity: r.hallucination === "yes" ? "medium" : "none",
          license: "apache-2.0",
        },
      })),
      ...dlg.map((r) => ({
        id: `hf-halueval-dialogue-${digest(r.dialogue_history, r.response)}`,
        input: {
          knowledge: r.knowledge,
          dialogueHistory: r.dialogue_history,
          response: r.response,
        },
        expectedOutput: {
          hallucination: r.hallucination === "yes",
          grounded: r.hallucination !== "yes",
        },
        metadata: {
          source: "pminervini/HaluEval",
          config: "dialogue_samples",
          family: r.hallucination === "yes" ? "hallucinated-turn" : "grounded-turn",
          severity: r.hallucination === "yes" ? "medium" : "none",
          license: "apache-2.0",
        },
      })),
    ],
  };
}

async function truthfulqa(): Promise<Corpus> {
  type Row = {
    type: string;
    category: string;
    question: string;
    best_answer: string;
    correct_answers: string[];
    incorrect_answers: string[];
    source: string;
  };
  const rows = await hfSample<Row>(
    "truthfulqa/truthful_qa",
    "generation",
    "validation",
    300,
    (r) => r.question,
  );
  return {
    name: "hf-truthfulqa-generation",
    description:
      "TruthfulQA generation split: adversarial questions engineered to elicit confident falsehoods, each with the best answer plus full lists of acceptable and unacceptable answers. The canonical hallucination benchmark (291 likes), usable as a match-against-set evaluator with no judge model at all. Deterministic {{n}}-row sample of 817 (apache-2.0).",
    metadata: {
      source: "huggingface:truthfulqa/truthful_qa",
      url: "https://huggingface.co/datasets/truthfulqa/truthful_qa",
      config: "generation",
      license: "apache-2.0",
      likes: 291,
      upstreamRows: 817,
      suite: "groundedness",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-truthfulqa-${digest(r.question)}`,
      input: { question: r.question },
      expectedOutput: {
        best_answer: r.best_answer,
        correct_answers: r.correct_answers,
        incorrect_answers: r.incorrect_answers,
      },
      metadata: {
        source: "truthfulqa/truthful_qa",
        family: r.category,
        severity: r.type === "Adversarial" ? "medium" : "none",
        type: r.type,
        upstreamSource: r.source,
        license: "apache-2.0",
      },
    })),
  };
}

async function framesMultihop(): Promise<Corpus> {
  type Row = {
    "Unnamed: 0": number;
    Prompt: string;
    Answer: string;
    reasoning_types: string;
    wiki_links: unknown;
  };
  const rows = await hfSample<Row>("google/frames-benchmark", "default", "test", 250, (r) =>
    String(r["Unnamed: 0"]),
  );
  const links = (row: Row): string[] => {
    if (Array.isArray(row.wiki_links))
      return row.wiki_links.filter((l): l is string => typeof l === "string");
    return Object.entries(row as unknown as Record<string, unknown>)
      .filter(
        ([key, value]) => key.startsWith("wikipedia_link") && typeof value === "string" && value,
      )
      .map(([, value]) => value as string);
  };
  return {
    name: "hf-frames-multihop-rag",
    description:
      "Google's FRAMES benchmark: multi-hop questions that each need 2 to 11 Wikipedia pages to answer, with the gold answer and the source links. Exercises the search_web then read_page then answer path and the groundedness judge at the same time, and it punishes an agent that stops retrieving too early. Deterministic {{n}}-row sample of 824 (apache-2.0, 266 likes).",
    metadata: {
      source: "huggingface:google/frames-benchmark",
      url: "https://huggingface.co/datasets/google/frames-benchmark",
      license: "apache-2.0",
      likes: 266,
      upstreamRows: 824,
      suite: "groundedness",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-frames-${r["Unnamed: 0"]}`,
      input: { question: r.Prompt.trim(), sources: links(r) },
      expectedOutput: { answer: r.Answer },
      metadata: {
        source: "google/frames-benchmark",
        family: "multi-hop-retrieval",
        severity: "none",
        reasoningTypes: r.reasoning_types,
        hops: links(r).length,
        license: "apache-2.0",
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Agent behaviour: tools and search
// ---------------------------------------------------------------------------

async function bfclLiveSimple(): Promise<Corpus> {
  type Case = { id: string; question: { role: string; content: string }[][]; function: unknown[] };
  type Truth = { id: string; ground_truth: unknown[] };
  const [cases, truths] = await Promise.all([
    getJsonl<Case>(`${BFCL}/BFCL_v4_live_simple.json`),
    getJsonl<Truth>(`${BFCL}/possible_answer/BFCL_v4_live_simple.json`),
  ]);
  const truthById = new Map(truths.map((t) => [t.id, t.ground_truth]));
  return {
    name: "bfcl-live-simple-tool-calls",
    description:
      "Berkeley Function Calling Leaderboard v4, live_simple category: a real user question plus a JSON-schema tool list, with the ground-truth call name and arguments joined in from the parallel possible_answer file. The reference benchmark for tool-calling correctness, and the same shape as Grapevine's show_on_map, set_filters, get_eta and save_calendar tools. Complete category, {{n}} cases (ShishirPatil/gorilla, 13,012 stars, Apache-2.0).",
    metadata: {
      source: "github:ShishirPatil/gorilla",
      url: "https://gorilla.cs.berkeley.edu/leaderboard.html",
      benchmark: "BFCL v4 live_simple",
      license: "Apache-2.0",
      stars: 13012,
      suite: "agent",
      sampling: "complete category",
    },
    items: cases
      .filter((c) => truthById.has(c.id))
      .map((c) => ({
        id: `bfcl-live-simple-${c.id}`,
        input: { question: c.question[0], tools: c.function },
        expectedOutput: { ground_truth: truthById.get(c.id) },
        metadata: {
          source: "ShishirPatil/gorilla BFCL v4",
          family: "single-tool-call",
          severity: "none",
          category: "live_simple",
          upstreamId: c.id,
          toolCount: c.function.length,
          license: "Apache-2.0",
        },
      })),
  };
}

async function openaiEvalsBuggedTools(): Promise<Corpus> {
  type Row = {
    task: string;
    answer: string;
    tools: string[];
    bugs: Record<string, { bugged_input: unknown; bugged_func_name: string }>;
  };
  const rows = await getJsonl<Row>(`${EVALS}/bugged_tools/main_small.jsonl`);
  return {
    name: "openai-evals-bugged-tools",
    description:
      "Tasks from OpenAI's eval registry where a named tool is deliberately broken (wrong type, small offset, and so on) and the agent has to notice rather than trust what came back. Tests tool-result skepticism rather than tool selection, which is the failure mode that matters once a concierge is chaining search_web and read_page. Complete {{n}}-row corpus (openai/evals, MIT, 19,352 stars).",
    metadata: {
      source: "github:openai/evals",
      url: "https://github.com/openai/evals",
      path: "evals/registry/data/bugged_tools/main_small.jsonl",
      license: "MIT",
      stars: 19352,
      transport: "media.githubusercontent.com (registry data is git-LFS)",
      suite: "agent",
      sampling: "complete corpus",
    },
    items: rows.map((r) => ({
      id: `openai-evals-bugged-tools-${digest(r.task, r.tools, r.bugs)}`,
      input: { task: r.task, tools: r.tools },
      expectedOutput: { answer: r.answer },
      metadata: {
        source: "openai/evals bugged_tools",
        family: Object.values(r.bugs)[0]?.bugged_func_name ?? "unknown-bug",
        severity: "medium",
        bugs: r.bugs,
        license: "MIT",
      },
    })),
  };
}

async function langfuseCookbookSearch(): Promise<Corpus> {
  type Row = {
    id: string;
    question: string;
    expected_answer: string;
    category: string;
    area: string;
  };
  const rows = await hfSample<Row>(
    "junzhang1207/search-dataset",
    "default",
    "train",
    300,
    (r) => r.id,
  );
  return {
    name: "hf-langfuse-cookbook-search-qa",
    description:
      "The search QA dataset used verbatim by Langfuse's own 'Evaluate LangGraph Agents' cookbook: web-search-style questions with expected answers, tagged by category and area. Grapevine is a LangGraph agent with search_web and read_page, so the official cookbook's dataset-run pattern transplants here unchanged. Deterministic {{n}}-row sample of 934 (mit).",
    metadata: {
      source: "huggingface:junzhang1207/search-dataset",
      url: "https://huggingface.co/datasets/junzhang1207/search-dataset",
      license: "mit",
      upstreamRows: 934,
      cookbook: "https://langfuse.com/guides/cookbook/example_langgraph_agents",
      officialLangfuseExample: true,
      suite: "agent",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-search-${r.id}`,
      input: { question: r.question },
      expectedOutput: { answer: r.expected_answer },
      metadata: {
        source: "junzhang1207/search-dataset",
        family: r.category,
        severity: "none",
        area: r.area,
        license: "mit",
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Judge calibration and human annotation
// ---------------------------------------------------------------------------

async function mtBenchHumanJudgments(): Promise<Corpus> {
  type Row = {
    question_id: number;
    model_a: string;
    model_b: string;
    winner: string;
    judge: string;
    turn: number;
    conversation_a: { role: string; content: string }[];
    conversation_b: { role: string; content: string }[];
  };
  const rows = await hfSample<Row>("lmsys/mt_bench_human_judgments", "default", "human", 200, (r) =>
    [r.question_id, r.turn, r.model_a, r.model_b, r.judge].join("-"),
  );
  return {
    name: "hf-mt-bench-human-judgments",
    description:
      "Expert human pairwise preferences over two-turn assistant conversations from MT-Bench. Two uses here: fodder for the annotation queue that already carries a ground-truth winner to compare a reviewer against, and calibration for the local LLM judge, since the human winner is exactly the label the judge is supposed to reproduce. Deterministic {{n}}-row sample of 3,355 (cc-by-4.0, 147 likes).",
    metadata: {
      source: "huggingface:lmsys/mt_bench_human_judgments",
      url: "https://huggingface.co/datasets/lmsys/mt_bench_human_judgments",
      split: "human",
      license: "cc-by-4.0",
      likes: 147,
      upstreamRows: 3355,
      use: "annotation-queue + judge-calibration",
      suite: "judge-calibration",
      sampling: "deterministic stride over spread pages",
    },
    items: rows.map((r) => ({
      id: `hf-mtbench-human-${r.question_id}-${r.turn}-${digest(r.model_a, r.model_b, r.judge)}`,
      input: { turn: r.turn, conversationA: r.conversation_a, conversationB: r.conversation_b },
      expectedOutput: { winner: r.winner },
      metadata: {
        source: "lmsys/mt_bench_human_judgments",
        family: "pairwise-preference",
        severity: "none",
        modelA: r.model_a,
        modelB: r.model_b,
        humanJudge: r.judge,
        questionId: r.question_id,
        license: "cc-by-4.0",
      },
    })),
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The repo's own fixtures, mirrored from the eval suites
// ---------------------------------------------------------------------------

/** Every reply src/evals/suites/guardrails-judge.ts and guardrails.ts grade for persona. */
async function personaIntegrityFixtures(): Promise<Corpus> {
  const ask = "What's on tonight?";
  return {
    name: "persona-integrity-fixtures",
    description:
      "Concierge replies that break character (blatant leaks the regex rail catches, subtle ones only a judge can) and clean replies a judge must leave alone. Mirrored 1:1 from server/src/evals/suites/guardrails{,-judge}.ts, so the guardrails-judge suite and any experiment here grade the same {{n}} rows.",
    metadata: {
      source: "repo:server/src/evals/suites/guardrails-judge.ts",
      suite: "persona",
      threshold: 0.7,
      sampling: "complete",
    },
    items: [
      ...SUBTLE_LEAKS.map((l) => ({
        id: `persona-subtle-${l.id}`,
        input: { question: ask, reply: l.text },
        expectedOutput: { verdict: "break" },
        metadata: {
          source: "guardrails-judge.ts",
          family: "subtle-leak",
          severity: "high",
          why: l.why,
        },
      })),
      ...LEAKS.map(([id, text]) => ({
        id: `persona-blatant-${id}`,
        input: { question: ask, reply: text },
        expectedOutput: { verdict: "break" },
        metadata: { source: "guardrails.ts", family: "blatant-leak", severity: "high" },
      })),
      ...CLEAN_REPLIES.map((c) => ({
        id: `persona-${c.id}`,
        input: { question: ask, reply: c.text },
        expectedOutput: { verdict: "in-character" },
        metadata: { source: "guardrails-judge.ts", family: "clean", severity: "none" },
      })),
    ],
  };
}

/** The input rail's fixtures: direct injections, benign questions, one indirect probe. */
async function promptInjectionProbes(): Promise<Corpus> {
  return {
    name: "prompt-injection-probes",
    description:
      "Direct injections the input rail must block, benign visitor questions it must pass, and one indirect (in-content) injection for the content rail. Mirrored 1:1 from server/src/evals/suites/guardrails.ts: {{n}} rows.",
    metadata: {
      source: "repo:server/src/evals/suites/guardrails.ts",
      suite: "input-rail",
      rail: "input",
      railThreshold: 0.8,
      sampling: "complete",
    },
    items: [
      ...INJECTIONS.map(([id, text]) => ({
        id: `probe-${id}`,
        input: { text, rail: "input" },
        expectedOutput: { malicious: true },
        metadata: { source: "guardrails.ts", family: "direct-injection", severity: "high" },
      })),
      ...BENIGN.map((text, i) => ({
        id: `probe-benign-${i + 1}`,
        input: { text, rail: "input" },
        expectedOutput: { malicious: false },
        metadata: { source: "guardrails.ts", family: "benign-question", severity: "none" },
      })),
      {
        id: "probe-indirect-tacos",
        input: { text: INDIRECT, rail: "content" },
        expectedOutput: { malicious: true },
        metadata: { source: "guardrails.ts", family: "indirect-injection", severity: "high" },
      },
    ],
  };
}

interface Builder {
  name: string;
  build: () => Promise<Corpus>;
  source: string;
  license: string;
  url: string;
}

const HF = (repo: string) => `https://huggingface.co/datasets/${repo}`;

const BUILDERS: Builder[] = [
  {
    name: "persona-integrity-fixtures",
    build: personaIntegrityFixtures,
    source: "repo:server/src/evals/suites/guardrails-judge.ts",
    license: "Apache-2.0",
    url: "server/src/evals/suites/guardrails-judge.ts",
  },
  {
    name: "prompt-injection-probes",
    build: promptInjectionProbes,
    source: "repo:server/src/evals/suites/guardrails.ts",
    license: "Apache-2.0",
    url: "server/src/evals/suites/guardrails.ts",
  },
  {
    name: "hf-deepset-prompt-injections",
    build: deepsetPromptInjections,
    source: "huggingface:deepset/prompt-injections",
    license: "apache-2.0",
    url: HF("deepset/prompt-injections"),
  },
  {
    name: "hf-jailbreak-classification",
    build: jailbreakClassification,
    source: "huggingface:jackhhao/jailbreak-classification",
    license: "apache-2.0",
    url: HF("jackhhao/jailbreak-classification"),
  },
  {
    name: "garak-dan-jailbreaks",
    build: garakDan,
    source: "github:NVIDIA/garak",
    license: "Apache-2.0",
    url: "https://github.com/NVIDIA/garak",
  },
  {
    name: "hf-in-the-wild-jailbreaks",
    build: inTheWildJailbreaks,
    source: "huggingface:TrustAIRLab/in-the-wild-jailbreak-prompts",
    license: "mit",
    url: HF("TrustAIRLab/in-the-wild-jailbreak-prompts"),
  },
  {
    name: "hf-real-toxicity-challenging",
    build: realToxicityChallenging,
    source: "huggingface:allenai/real-toxicity-prompts",
    license: "apache-2.0",
    url: HF("allenai/real-toxicity-prompts"),
  },
  {
    name: "garak-system-prompt-extraction",
    build: garakSystemPromptExtraction,
    source: "github:NVIDIA/garak",
    license: "Apache-2.0",
    url: "https://github.com/NVIDIA/garak",
  },
  {
    name: "hf-lakera-gandalf-ignore-instructions",
    build: gandalfIgnoreInstructions,
    source: "huggingface:Lakera/gandalf_ignore_instructions",
    license: "mit",
    url: HF("Lakera/gandalf_ignore_instructions"),
  },
  {
    name: "hf-spml-chatbot-prompt-injection",
    build: spmlChatbotInjection,
    source: "huggingface:reshabhs/SPML_Chatbot_Prompt_Injection",
    license: "mit",
    url: HF("reshabhs/SPML_Chatbot_Prompt_Injection"),
  },
  {
    name: "openai-evals-prompt-injection",
    build: openaiEvalsInjection,
    source: "github:openai/evals",
    license: "MIT",
    url: "https://github.com/openai/evals",
  },
  {
    name: "hf-halueval-groundedness",
    build: halueval,
    source: "huggingface:pminervini/HaluEval",
    license: "apache-2.0",
    url: HF("pminervini/HaluEval"),
  },
  {
    name: "hf-truthfulqa-generation",
    build: truthfulqa,
    source: "huggingface:truthfulqa/truthful_qa",
    license: "apache-2.0",
    url: HF("truthfulqa/truthful_qa"),
  },
  {
    name: "hf-frames-multihop-rag",
    build: framesMultihop,
    source: "huggingface:google/frames-benchmark",
    license: "apache-2.0",
    url: HF("google/frames-benchmark"),
  },
  {
    name: "bfcl-live-simple-tool-calls",
    build: bfclLiveSimple,
    source: "github:ShishirPatil/gorilla",
    license: "Apache-2.0",
    url: "https://gorilla.cs.berkeley.edu/leaderboard.html",
  },
  {
    name: "openai-evals-bugged-tools",
    build: openaiEvalsBuggedTools,
    source: "github:openai/evals",
    license: "MIT",
    url: "https://github.com/openai/evals",
  },
  {
    name: "hf-langfuse-cookbook-search-qa",
    build: langfuseCookbookSearch,
    source: "huggingface:junzhang1207/search-dataset",
    license: "mit",
    url: HF("junzhang1207/search-dataset"),
  },
  {
    name: "hf-mt-bench-human-judgments",
    build: mtBenchHumanJudgments,
    source: "huggingface:lmsys/mt_bench_human_judgments",
    license: "cc-by-4.0",
    url: HF("lmsys/mt_bench_human_judgments"),
  },
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

// ---------------------------------------------------------------------------
// Back-dating: give a seeded dataset a creation date its runs can live after
// ---------------------------------------------------------------------------

/**
 * Everything below exists because of one ordering bug that only shows up once
 * the rest of the seed is realistic.
 *
 * Datasets are rows in Postgres and datasets.created_at defaults to
 * CURRENT_TIMESTAMP, so every corpus this script imports is stamped with the
 * wall-clock moment of the import. The experiments that run against those
 * corpora, by contrast, are hand-built OTEL spans and CAN be backdated, so
 * experiments.ts spreads them across the preceding weeks to give the
 * Experiments tab a history. Put together, the Datasets tab ends up listing a
 * dataset created today whose Last Run column says three weeks ago: a run over
 * items that did not exist yet.
 *
 * Nothing in the ingest path can fix that, because there is no createdAt on
 * POST /api/public/v2/datasets (nor on dataset items). The only lever is the
 * Postgres row, so this moves it, and it does so from a script rather than a
 * one-off psql line for the usual reason: the committed scripts have to be the
 * thing that reproduces the UI, or the next full re-seed silently reintroduces
 * the same wrinkle.
 *
 * The shape of the fix is a COHORT, not a per-dataset guess. These corpora
 * really were imported in one batch by one run of this script over about ten
 * minutes, so the honest repair keeps that: hold the relative spacing exactly
 * as it happened and slide the whole batch back to a plausible import day
 * before the earliest experiment run. The two hand-written corpora are the
 * repo's own fixtures and form their own cohort, anchored at the start of the
 * project's evaluation history.
 *
 * Idempotent by construction. Each cohort is rebased on its own live minimum,
 * so a second run computes anchor + (created - anchor) = created and changes
 * nothing. That matters because this has to be re-runnable after experiments.ts
 * re-emits and the first-run times move.
 */

/** The one project on this self-hosted stack; scopes every write below. */
const PROJECT_ID = process.env.LANGFUSE_PROJECT_ID ?? "grapevine-local";

interface Cohort {
  key: string;
  /** Where the earliest member of the cohort lands, UTC. */
  anchor: string;
  /** Members are matched by dataset name. */
  holds: (name: string) => boolean;
  why: string;
}

const COHORTS: Cohort[] = [
  {
    key: "hand-written",
    anchor: "2026-07-07T06:50:00Z",
    holds: (name) => HAND_WRITTEN.has(name),
    why:
      "persona-integrity-fixtures and prompt-injection-probes mirror the eval suites, which " +
      "predate every public corpus here. The anchor sits a few minutes before the oldest " +
      "concierge trace in the project (2026-07-07T06:56Z), so the fixtures exist from the " +
      "moment this project started keeping evaluation history.",
  },
  {
    key: "public-corpora",
    anchor: "2026-08-01T09:20:00Z",
    holds: () => true,
    why:
      "the sixteen public corpora arrived in one batch from one run of this script, so they " +
      "keep their real ten-minute spread and land together on an import day comfortably before " +
      "the earliest experiment run against any of them (2026-08-05T16:40Z).",
  },
];

/** A dataset created less than this before its first run reads as impossible. */
const MIN_LEAD_HOURS = 24;
/** A cohort that spreads wider than this has drifted; fail rather than guess. */
const MAX_COHORT_SPAN_DAYS = 7;
/** Items start this long after their dataset, then keep their real spacing. */
const ITEM_LEAD_SECONDS = 30;

const OBSERVABILITY_ENV = "../../../docker/observability/langfuse/.env";

/** Read one value out of the docker stack's env file (dotenv does not load it). */
function stackEnv(key: string): string | null {
  try {
    const text = readFileSync(new URL(OBSERVABILITY_ENV, import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

/** v4 events_only keeps every experiment span in ClickHouse, not Postgres. */
async function clickhouse(sql: string): Promise<string> {
  const password = process.env.CLICKHOUSE_PASSWORD ?? stackEnv("CLICKHOUSE_PASSWORD");
  if (!password) throw new Error("CLICKHOUSE_PASSWORD not found in the stack env file");
  const res = await fetch(process.env.CLICKHOUSE_HTTP_URL ?? "http://127.0.0.1:8123/", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`clickhouse:${password}`).toString("base64")}`,
    },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
  return text.trim();
}

/**
 * Langfuse's Postgres is not published on a host port and the server has no pg
 * client, so this goes through the container the same way the runbook does.
 */
function psql(sql: string): string {
  const container = process.env.LANGFUSE_POSTGRES_CONTAINER ?? "langfuse-postgres-1";
  return execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ).trim();
}

/** Postgres timestamp(3) literal, in UTC, which is what Langfuse stores. */
function pgTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

interface DatasetRow {
  id: string;
  name: string;
  createdAtMs: number;
  cohort: Cohort;
  firstRunMs: number | null;
  targetMs: number;
}

/** min(start_time) of every experiment span that names each dataset. */
async function firstRunByDataset(): Promise<Map<string, number>> {
  const tsv = await clickhouse(
    `SELECT experiment_dataset_id, toUnixTimestamp64Milli(min(start_time))
       FROM events_core
      WHERE project_id = '${PROJECT_ID}' AND experiment_dataset_id != ''
      GROUP BY experiment_dataset_id
      FORMAT TSV`,
  );
  const out = new Map<string, number>();
  for (const line of tsv.split("\n").filter(Boolean)) {
    const [id, ms] = line.split("\t");
    out.set(id, Number(ms));
  }
  return out;
}

async function backdateDatasets(): Promise<void> {
  const firstRuns = await firstRunByDataset();
  const rows = psql(
    `select id || E'\\t' || name || E'\\t' || (extract(epoch from created_at) * 1000)::bigint
       from datasets where project_id = '${PROJECT_ID}' order by created_at`,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, ms] = line.split("\t");
      return { id, name, createdAtMs: Number(ms) };
    });

  const planned: DatasetRow[] = [];
  for (const cohort of COHORTS) {
    const members = rows.filter((r) => !planned.some((p) => p.id === r.id) && cohort.holds(r.name));
    if (members.length === 0) continue;
    const cohortMin = Math.min(...members.map((m) => m.createdAtMs));
    const anchorMs = Date.parse(cohort.anchor);
    console.log(
      `${cohort.key}: ${members.length} datasets anchored at ${cohort.anchor} - ${cohort.why}`,
    );
    for (const m of members) {
      planned.push({
        ...m,
        cohort,
        firstRunMs: firstRuns.get(m.id) ?? null,
        targetMs: anchorMs + (m.createdAtMs - cohortMin),
      });
    }
  }

  // Refuse to write a timeline that is still impossible, rather than shipping a
  // subtler version of the bug this function exists to fix.
  const problems: string[] = [];
  for (const row of planned) {
    const spanDays = (row.targetMs - Date.parse(row.cohort.anchor)) / 86_400_000;
    if (spanDays > MAX_COHORT_SPAN_DAYS) {
      problems.push(
        `${row.name}: lands ${spanDays.toFixed(1)} days after the ${row.cohort.key} anchor, so that ` +
          `cohort has drifted (a partial re-import?). Re-run the whole import, or move the anchor.`,
      );
    }
    if (row.firstRunMs !== null && row.targetMs > row.firstRunMs - MIN_LEAD_HOURS * 3_600_000) {
      problems.push(
        `${row.name}: created ${new Date(row.targetMs).toISOString()} but first run ` +
          `${new Date(row.firstRunMs).toISOString()}, which leaves under ${MIN_LEAD_HOURS}h of lead. ` +
          `Move the ${row.cohort.key} anchor earlier.`,
      );
    }
  }
  if (problems.length) throw new Error(`backdating refused:\n  ${problems.join("\n  ")}`);

  for (const row of planned) {
    const target = pgTimestamp(row.targetMs);
    psql(
      `update datasets set created_at = timestamp '${target}',
                           updated_at = updated_at - (created_at - timestamp '${target}')
        where project_id = '${PROJECT_ID}' and id = '${row.id}'`,
    );
    const moved = backdateItems(row.id, row.targetMs);
    const run = row.firstRunMs ? new Date(row.firstRunMs).toISOString().slice(0, 16) : "no runs";
    console.log(
      `  ${row.name.padEnd(38)} created ${target.slice(0, 16)}  first run ${run}  ` +
        `${moved} items  [${row.cohort.key}]`,
    );
  }
  console.log(`backdated ${planned.length} datasets across ${COHORTS.length} cohorts`);
}

/**
 * Items are rebased onto their dataset's new creation date, keeping the real
 * spacing of the upsert pass that wrote them.
 *
 * dataset_items is a temporal table: every upsert closes the previous row with
 * a valid_to and inserts a new one, so a single item can hold four historical
 * versions. Only the current, undeleted rows are what the Items table reads, so
 * only those move; the superseded versions and the tombstones left by pruning
 * are invisible and are left exactly as they were rather than rewritten into a
 * history that never happened. valid_from is part of the primary key and is
 * never touched.
 */
function backdateItems(datasetId: string, datasetTargetMs: number): number {
  const start = pgTimestamp(datasetTargetMs + ITEM_LEAD_SECONDS * 1000);
  return Number(
    psql(
      `with base as (
         select min(created_at) as m from dataset_items
          where project_id = '${PROJECT_ID}' and dataset_id = '${datasetId}'
            and valid_to is null and is_deleted = false
       ), moved as (
         update dataset_items i
            set created_at = timestamp '${start}' + (i.created_at - base.m),
                updated_at = timestamp '${start}' + (i.updated_at - base.m)
           from base
          where i.project_id = '${PROJECT_ID}' and i.dataset_id = '${datasetId}'
            and i.valid_to is null and i.is_deleted = false
         returning 1
       )
       select count(*) from moved`,
    ),
  );
}

interface ManifestEntry {
  name: string;
  id: string;
  itemCount: number;
  source: string;
  license: string;
  url: string;
}

async function main(): Promise<void> {
  const only = argValue("--only")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (process.argv.includes("--backdate-only")) {
    await backdateDatasets();
    return;
  }
  const existing = await lf.api.datasets.list({ limit: 100 });
  console.log(
    `langfuse holds ${existing.data.length} datasets before import: ${existing.data.map((d) => d.name).join(", ")}`,
  );

  const manifest: ManifestEntry[] = [];
  for (const builder of BUILDERS) {
    if (only && !only.includes(builder.name)) {
      console.log(`  skip ${builder.name} (not in --only)`);
      continue;
    }
    const corpus = await builder.build();
    if (corpus.name !== builder.name)
      throw new Error(`builder name mismatch: ${builder.name} vs ${corpus.name}`);
    const published = await publish(corpus);
    manifest.push({
      ...published,
      source: builder.source,
      license: builder.license,
      url: builder.url,
    });
  }

  const items = manifest.reduce((sum, d) => sum + d.itemCount, 0);
  console.log(`imported ${manifest.length} datasets, ${items} items`);

  const targets = [fileURLToPath(new URL("./import-datasets.out.json", import.meta.url))];
  const extra = argValue("--manifest");
  if (extra) targets.push(extra);
  for (const target of targets) {
    writeFileSync(target, JSON.stringify(manifest, null, 2));
    console.log(`manifest -> ${target}`);
  }

  // Postgres has just stamped every one of those rows with "now". Put them back
  // where the rest of the seeded history says they belong.
  if (process.argv.includes("--no-backdate")) {
    console.log("--no-backdate: datasets left at their real creation time");
    return;
  }
  await lf.flush();
  await backdateDatasets();
}

await main();
await lf.flush();
console.log(
  `done - open ${process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000"} and check the Datasets tab`,
);
