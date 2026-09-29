#!/usr/bin/env node
/**
 * Checks a clone for what `npm run dev` needs and prints exactly what is
 * missing: the Node version, the install, the two env files and their
 * required values, the Supabase project and whether the schema reached it,
 * Ollama and its models, and the two ports. Optional pieces (a CLI provider,
 * Langfuse, SearXNG, Docker) are reported but never fail the run.
 *
 *   npm run doctor
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const ok = (text) => results.push({ level: "ok", text });
const warn = (text, fix) => results.push({ level: "warn", text, fix });
const fail = (text, fix) => results.push({ level: "fail", text, fix });

/** KEY=VALUE lines, comments and blank lines skipped, simple quotes stripped. */
function readEnv(file) {
  if (!existsSync(file)) return null;
  const out = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** The example files ship values like sb_secret_your_key; those do not count. */
const PLACEHOLDER = /your[-_]|placeholder/i;
const isSet = (value) => Boolean(value) && !PLACEHOLDER.test(value);

function required(env, file, key, hint) {
  if (isSet(env[key])) ok(`${file}: ${key} is set`);
  else fail(`${file}: ${key} is not set`, hint);
}

const get = (url, init = {}, ms = 4000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function onPath(cmd) {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(path.join(dir, cmd + ext))) return true;
  }
  return false;
}

// --- Node and the install ---------------------------------------------------
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const supportedNode =
  (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
  (major === 24 && minor >= 15) ||
  major >= 26;
if (supportedNode) ok(`Node ${process.versions.node}`);
else
  fail(
    `Node ${process.versions.node} is unsupported`,
    "install the Node version in .nvmrc (nvm use)",
  );

if (existsSync(path.join(root, "node_modules", "@langchain", "langgraph"))) {
  ok("dependencies installed");
} else {
  fail("dependencies not installed", "npm install (one install covers server, web and the worker)");
}

// --- The two env files ------------------------------------------------------
const serverEnv = readEnv(path.join(root, "server", ".env"));
if (!serverEnv) {
  fail(
    "server/.env is missing",
    "copy server/.env.example to server/.env and fill in the three values at the top",
  );
} else {
  required(
    serverEnv,
    "server/.env",
    "SUPABASE_URL",
    "the project URL from Supabase > Settings > API",
  );
  required(serverEnv, "server/.env", "SUPABASE_SECRET_KEY", "the secret key from the same page");
  required(
    serverEnv,
    "server/.env",
    "MAPBOX_SECRET_TOKEN",
    "a secret (sk.) token from account.mapbox.com",
  );
}

const webEnv = readEnv(path.join(root, "web", ".env.local"));
if (!webEnv) {
  fail(
    "web/.env.local is missing",
    "copy web/.env.example to web/.env.local and fill in the three values",
  );
} else {
  required(
    webEnv,
    "web/.env.local",
    "VITE_MAPBOX_TOKEN",
    "a public (pk.) token from account.mapbox.com",
  );
  required(webEnv, "web/.env.local", "VITE_SUPABASE_URL", "the same project URL as the server");
  required(
    webEnv,
    "web/.env.local",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "the publishable key from Supabase > Settings > API",
  );
}

// --- Supabase: reachable, key accepted, schema applied ----------------------
if (serverEnv && isSet(serverEnv.SUPABASE_URL) && isSet(serverEnv.SUPABASE_SECRET_KEY)) {
  const base = serverEnv.SUPABASE_URL.replace(/\/$/, "");
  const key = serverEnv.SUPABASE_SECRET_KEY;
  try {
    const res = await get(`${base}/rest/v1/app_settings?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (res.ok) ok("Supabase answers and the schema is applied");
    else if (res.status === 401 || res.status === 403) {
      fail(
        "Supabase rejected SUPABASE_SECRET_KEY",
        "paste the secret key, not the publishable one",
      );
    } else if (res.status === 404 || res.status === 400) {
      fail(
        "Supabase answers but the schema is not applied",
        "supabase link --project-ref <ref>, then supabase db push",
      );
    } else warn(`Supabase answered ${res.status}`, "check the project is not paused");
  } catch {
    fail(`Supabase not reachable at ${base}`, "check SUPABASE_URL and the network");
  }
}

// --- Ollama, or a CLI provider ---------------------------------------------
const ollamaUrl = (serverEnv?.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const clis = ["claude", "codex", "gemini", "copilot"].filter(onPath);
try {
  const res = await get(`${ollamaUrl}/api/tags`);
  const body = await res.json();
  const models = (body.models ?? []).map((m) => m.name);
  if (models.length) {
    const shown = models.slice(0, 4).join(", ") + (models.length > 4 ? ", ..." : "");
    ok(`Ollama at ${ollamaUrl} with ${models.length} model(s): ${shown}`);
  } else {
    warn(
      `Ollama at ${ollamaUrl} has no models`,
      "ollama pull qwen3:8b, then pick it in Admin > Models",
    );
  }
} catch {
  if (clis.length) {
    warn(
      `Ollama not reachable at ${ollamaUrl}; ${clis.join(", ")} on PATH`,
      "install Ollama for local models, or pick the CLI under Admin > Providers",
    );
  } else {
    fail(
      `Ollama not reachable at ${ollamaUrl}`,
      "install Ollama (ollama.com), then: ollama pull qwen3:8b",
    );
  }
}
if (clis.length) ok(`CLI providers on PATH: ${clis.join(", ")} (Admin > Providers can use them)`);

// --- Ports ------------------------------------------------------------------
const apiPort = Number(serverEnv?.PORT || 8787);
for (const [port, what] of [
  [apiPort, "the API"],
  [5174, "the web app"],
]) {
  if (await portFree(port)) ok(`port ${port} is free for ${what}`);
  else
    warn(
      `port ${port} is in use (${what})`,
      "already running npm run dev? otherwise stop what holds it",
    );
}

// --- Optional pieces --------------------------------------------------------
if (serverEnv && isSet(serverEnv.LANGFUSE_PUBLIC_KEY)) {
  const base = (serverEnv.LANGFUSE_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  try {
    const res = await get(`${base}/api/public/health`);
    if (res.ok) ok(`Langfuse at ${base}`);
    else
      warn(
        `Langfuse at ${base} answered ${res.status}`,
        "docker compose --profile observability up -d",
      );
  } catch {
    warn(
      `Langfuse keys are set but ${base} is down`,
      "docker compose --profile observability up -d",
    );
  }
}
if (serverEnv && isSet(serverEnv.SEARXNG_URL)) {
  const base = serverEnv.SEARXNG_URL.replace(/\/$/, "");
  try {
    const res = await get(`${base}/search?q=grapevine&format=json`);
    if (res.ok) ok(`SearXNG at ${base}`);
    else if (res.status === 403) {
      warn(`SearXNG at ${base} refuses JSON`, "add json to search.formats in its settings.yml");
    } else
      warn(`SearXNG at ${base} answered ${res.status}`, "docker compose --profile search up -d");
  } catch {
    warn(
      `SEARXNG_URL is set but ${base} is down`,
      "docker compose --profile search up -d (search falls back to DuckDuckGo)",
    );
  }
}
if (onPath("docker"))
  ok("docker on PATH (the optional stack: docker compose --profile observability up -d)");
else warn("docker not on PATH", "only needed for the optional Langfuse and SearXNG profiles");

// --- Report -----------------------------------------------------------------
const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
for (const r of results) {
  console.log(`${mark[r.level]} ${r.text}`);
  if (r.fix && r.level !== "ok") console.log(`        fix: ${r.fix}`);
}
const fails = results.filter((r) => r.level === "fail").length;
const warns = results.filter((r) => r.level === "warn").length;
console.log();
if (fails) {
  console.log(`${fails} thing(s) to fix before npm run dev.`);
  process.exit(1);
}
console.log(
  warns
    ? `Ready, with ${warns} optional thing(s) noted. npm run dev starts the API and the web app.`
    : "Ready. npm run dev starts the API and the web app.",
);
