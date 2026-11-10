import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertLocal, readEnv, root, runNode } from "./local-tools.mjs";

const local = readEnv(path.join(root, "server/.env"));
assertLocal(local.SUPABASE_URL);
assert.notEqual(local.NODE_ENV, "production", "Use a development database for smoke checks");
assert.notEqual(process.env.NODE_ENV, "production", "Use a development database for smoke checks");
const env = {
  ...process.env,
  ...local,
  HOST: "127.0.0.1",
  GUARDRAILS: "off",
  // These checks exercise startup and storage, not inference or model downloads.
  GRAPEVINE_LLM_PYTHON: path.join(root, "llm/.venv/not-installed-for-smoke"),
  OLLAMA_URL: "http://127.0.0.1:1",
  LOG_LEVEL: "warn",
};
const threadId = `setup-smoke-${randomUUID()}`;
const children = new Set();
let output = "";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function start(args, cwd, extra = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.on("error", (error) => {
    output += error.message;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output = (output + data).slice(-12000);
    });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
}

async function waitFor(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Server exited before readiness");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (response.ok) return response;
    } catch {
      /* Boot can take several seconds on a fresh install. */
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function persistence(phase) {
  runNode(["--import", "tsx", "server/scripts/smoke-persistence.ts", phase, threadId], { env });
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = ["--import", "tsx", "src/index.ts"];
  let api = start(args, path.join(root, "server"), { PORT: String(port) });
  const ready = await (await waitFor(`${base}/readyz`, api)).json();
  assert.equal(ready.database.ok, true);
  assert.equal(ready.checkpointer.ok, true);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const events = await (await fetch(`${base}/api/events`)).json();
  const demo = events.filter((event) => event.source === "grapevine-demo");
  assert.equal(demo.length, 7, "Run npm run setup to seed current demo events");
  assert.equal(new Set(demo.map((event) => event.id)).size, 7);
  assert.ok(
    demo.every((event) => event.title.startsWith("[Demo]") && Date.parse(event.start) > Date.now()),
  );
  persistence("write");
  await stop(api);
  api = start(args, path.join(root, "server"), { PORT: String(port) });
  await waitFor(`${base}/readyz`, api);
  persistence("read");
  const webPort = await freePort();
  const web = start(
    [
      path.join(root, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    path.join(root, "web"),
    { GRAPEVINE_API_URL: base },
  );
  const webBase = `http://127.0.0.1:${webPort}`;
  const html = await (await waitFor(webBase, web)).text();
  assert.match(html, /id="root"/);
  const proxied = await (await fetch(`${webBase}/api/events`)).json();
  assert.equal(proxied.filter((event) => event.source === "grapevine-demo").length, 7);
  console.log(
    "Local smoke passed: API readiness, seven upcoming demo events, restart persistence, web entry and API proxy.",
  );
} catch (error) {
  // Avoid dumping credentials if an upstream library includes configuration in a log.
  for (const value of [local.SUPABASE_SECRET_KEY, local.MAPBOX_SECRET_TOKEN]) {
    if (value) output = output.replaceAll(value, "[redacted]");
  }
  console.error(output);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await Promise.all([...children].map(stop));
  persistence("clean");
}
